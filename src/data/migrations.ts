import { sql } from "~/db";
import { normalizeServiceSelectionType } from "./service-time-core";

/** Append-only, idempotent database migrations. Each step is recorded once. */
export type RegionalCtInput = { id:string; name:string; zone_type?:string; zip_codes?:unknown; active?:boolean; };
export type RegionalCtCounty = { id:string; name:string; zip_codes?:unknown; lat?:number; lng?:number; };
export function computeRegionalCtPlan(existing: RegionalCtInput[], counties: RegionalCtCounty[]) {
  const zips = (v:unknown) => Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : [];
  const byName = new Map(existing.map(r => [r.name, r]));
  const countyByName = new Map(counties.map(c => [c.name, c]));
  const seedRows: Array<[string,string,string]> = [
    ['Greater Stamford/Fairfield County', 'Southwest CT', 'Fairfield'],
    ['Greater Bridgeport', 'Bridgeport–Milford', 'Fairfield'],
    ['Greater New Haven', 'New Haven–Branford', 'New Haven'],
    ['Greater Hartford', 'CT Capital Region', 'Hartford'],
  ];
  const names = ['Greater Stamford/Fairfield County','Greater Bridgeport','Greater New Haven','Greater Hartford','Greater Danbury/Waterbury','Greater Middlesex/Shoreline','Greater New London','Greater Tolland/NE CT','Greater Windham/Eastern CT'];
  const sortOrders = [3232,3233,3234,3235,3236,3237,3238,3239,3240];
  const countyMap: Record<string,string> = {'Greater Hartford':'Hartford','Greater Danbury/Waterbury':'Litchfield','Greater Middlesex/Shoreline':'Middlesex','Greater New London':'New London','Greater Tolland/NE CT':'Tolland','Greater Windham/Eastern CT':'Windham'};
  const countyZips = new Set<string>();
  for (const c of counties) for (const z of zips(c.zip_codes)) countyZips.add(z);
  const marketZips = new Set<string>();
  for (const r of existing) for (const z of zips(r.zip_codes)) marketZips.add(z);
  const universe = new Set([...countyZips, ...marketZips]);
  const assigned = new Map<string,string>();
  const seedByRegion = new Map<string, string[]>();
  for (const [region, oldName] of seedRows) {
    const row = byName.get(oldName);
    if (!row) throw new Error(`missing seed row: ${oldName}`);
    const zs = zips(row.zip_codes);
    seedByRegion.set(region, zs);
    for (const z of zs) {
      if (assigned.has(z)) throw new Error(`seed ZIP overlaps: ${z}`);
      assigned.set(z, region);
    }
  }
  // County ZIPs not claimed by a seed form the five county-based remainder regions.
  for (const c of counties) for (const z of zips(c.zip_codes)) if (!assigned.has(z)) {
    const region = c.name === 'Fairfield' || c.name === 'New Haven' || c.name === 'Litchfield'
      ? 'Greater Danbury/Waterbury' : names.find(n => countyMap[n] === c.name);
    if (!region) throw new Error(`unmapped county: ${c.name}`);
    assigned.set(z, region);
  }
  const fallback: Record<string,string> = {
    'Greater Stamford/Fairfield County':'Fairfield', 'Greater Bridgeport':'Fairfield',
    'Greater New Haven':'New Haven', 'Greater Hartford':'Hartford',
  };
  const oldNames: Record<string,string> = Object.fromEntries(seedRows.map(([n, old]) => [n, old]));
  const regions = names.map((name, i) => {
    const zs = [...assigned].filter(([,n]) => n === name).map(([z]) => z).sort();
    if (!zs.length) throw new Error(`region has zero ZIPs: ${name}`);
    const counts = new Map<string,number>();
    for (const z of zs) for (const c of counties) if (zips(c.zip_codes).includes(z)) counts.set(c.name, (counts.get(c.name) || 0) + 1);
    const parentName = [...counts.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || fallback[name];
    const parent = countyByName.get(parentName!);
    if (!parent) throw new Error(`missing parent for ${name}`);
    const oldRow = oldNames[name] ? byName.get(oldNames[name]) : undefined;
    return {name, zips: zs, parentId: String(parent.id), parentName, sortOrder: sortOrders[i], id: oldRow ? String(oldRow.id) : `regional-ct-${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`};
  });
  const seen = new Map<string,number>();
  for (const r of regions) for (const z of r.zips) seen.set(z, (seen.get(z) || 0) + 1);
  const duplicates = [...seen].filter(([,n]) => n > 1).map(([z]) => z);
  const gaps = [...universe].filter(z => !seen.has(z));
  if (duplicates.length || gaps.length) throw new Error(`CT regional partition failed closed: ${gaps.length} gaps, ${duplicates.length} duplicates`);
  return {regions, duplicates, gaps};
}

/** Seed positive contractor services from completed real dispatch history. */
export async function seedContractorServicesFromHistory(q: ReturnType<typeof sql>) {
  await q`INSERT INTO contractor_services(id,org_id,contractor_id,service_type,updated_by)
    SELECT gen_random_uuid()::text, dj.org_id, u.id,
      CASE
        WHEN LOWER(COALESCE(dj.service_type,'')) LIKE '%heavy%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%flatbed%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%wheel%lift%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%tow%' THEN 'heavy_tow'
        WHEN LOWER(COALESCE(dj.service_type,'')) LIKE '%battery%' AND LOWER(COALESCE(dj.service_type,'')) LIKE '%advanced%' THEN 'battery_advanced'
        WHEN LOWER(COALESCE(dj.service_type,'')) LIKE '%battery%' THEN 'battery_standard'
        WHEN LOWER(COALESCE(dj.service_type,'')) LIKE '%jump%' THEN 'jump_start'
        WHEN LOWER(COALESCE(dj.service_type,'')) LIKE '%tire%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%tyre%' THEN 'tire_change'
        WHEN LOWER(COALESCE(dj.service_type,'')) LIKE '%fuel%' THEN 'fuel_delivery'
        WHEN LOWER(COALESCE(dj.service_type,'')) LIKE '%lock%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%unlock%' THEN 'lockout'
        ELSE NULL
      END, 'seed'
    FROM dispatch_jobs dj JOIN users u ON u.towbook_driver_id=dj.assigned_driver_towbook_id AND u.deactivated_at IS NULL
    JOIN organization_memberships m ON m.org_id=dj.org_id AND m.user_id=u.id AND m.role='contractor'
    WHERE dj.assigned_driver_towbook_id IS NOT NULL AND (dj.status='completed' OR dj.towbook_status='252')
      AND (LOWER(COALESCE(dj.service_type,'')) LIKE '%tow%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%heavy%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%flatbed%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%wheel%lift%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%battery%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%jump%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%tire%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%tyre%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%fuel%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%lock%' OR LOWER(COALESCE(dj.service_type,'')) LIKE '%unlock%')
    ON CONFLICT (org_id, contractor_id, service_type) DO NOTHING`;
  await q`DELETE FROM contractor_services WHERE service_type IS NULL`;
}
export function serviceSelectionMatchesJob(serviceType: string | null | undefined, selectedServices: readonly string[]): boolean {
  const wanted = normalizeServiceSelectionType(serviceType);
  return Boolean(wanted && selectedServices.includes(wanted));
}
const migrations: Array<[number, (q: ReturnType<typeof sql>) => Promise<unknown>]> = [
  [1, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS dispatch_contractors (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, area TEXT NOT NULL, vehicle_types JSONB NOT NULL DEFAULT '[]', rating DOUBLE PRECISION NOT NULL, completed_job_count INTEGER NOT NULL DEFAULT 0, response_time_history_minutes JSONB NOT NULL DEFAULT '[]')`;
    await q`CREATE TABLE IF NOT EXISTS dispatch_jobs (id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT NOT NULL, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, area TEXT NOT NULL, service_type TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, assigned_at TIMESTAMPTZ, arrived_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, assigned_contractor_id TEXT REFERENCES dispatch_contractors(id) ON DELETE SET NULL, note TEXT NOT NULL DEFAULT '')`;
  }],
  [2, async (q) => {
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE`;
    await q`ALTER TABLE dispatch_contractors ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE`;
    await q`CREATE INDEX IF NOT EXISTS dispatch_jobs_org_idx ON dispatch_jobs(org_id)`;
    await q`CREATE INDEX IF NOT EXISTS dispatch_contractors_org_idx ON dispatch_contractors(org_id)`;
  }],
  [3, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS status_events (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, job_id TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), actor_role TEXT NOT NULL, note TEXT, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await q`CREATE INDEX IF NOT EXISTS status_events_org_job_idx ON status_events(org_id,job_id,occurred_at)`;
    await q`CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, actor_user_id TEXT NOT NULL REFERENCES users(id), actor_role TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}'::jsonb, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), request_id TEXT)`;
    await q`CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log(org_id,occurred_at)`;
  }],
  [4, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS towbook_sessions (org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE, encrypted_session TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'connected', last_sync_at TIMESTAMPTZ, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  }],
  [5, async (q) => {
    // Towbook job-puller columns: raw Towbook identity + normalized customer/vehicle/
    // route fields, the raw Towbook status string, and the full raw record (JSONB)
    // for diagnostics/reconciliation. Idempotent — extends only what's missing.
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS towbook_job_id TEXT`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS customer_phone TEXT`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS vehicle_desc TEXT`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pickup TEXT`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS dropoff TEXT`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS towbook_status TEXT`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS raw_json JSONB`;
    // One Towbook job per org — the puller dedupes on this; manual jobs (no
    // towbook_job_id) are unaffected. Partial index: only rows with a Towbook id.
    await q`CREATE UNIQUE INDEX IF NOT EXISTS dispatch_jobs_org_towbook_job_idx ON dispatch_jobs(org_id, towbook_job_id) WHERE towbook_job_id IS NOT NULL`;
  }],
  [6, async (q) => {
    // Plain-username login (AI dispatcher): users get an optional login_handle
    // alongside their canonical unique email. Partial unique index — handles are
    // unique only where set; email stays the NOT NULL unique key.
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_handle TEXT`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS users_login_handle_idx ON users(login_handle) WHERE login_handle IS NOT NULL`;
  }],
  [7, async (q) => {
    // Sync self-documentation: every Towbook sync run persists its full result
    // (ranAt + code + counts + diagnostics) so a run that finds nothing is
    // explainable from the DB after the fact — no UI drawer needed. Diagnostics
    // contain only URLs/statuses/hints, never cookies or credentials.
    await q`ALTER TABLE towbook_sessions ADD COLUMN IF NOT EXISTS last_result JSONB`;
  }],
  [8, async (q) => {
    // AI dispatcher (owner-directed 2026-08-10): per-org dispatch-engine settings
    // and the decision ledger. org_settings rows are lazily created with defaults
    // (getOrgSettings); zone = 30-mile radius around the 06606 (Bridgeport, CT)
    // centroid 41.208862,-73.207253 (Nominatim-verified). max_eta_minutes is the
    // motor-club SLA default (45); a per-offer maxEta overrides when lower.
    await q`CREATE TABLE IF NOT EXISTS org_settings (
      org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      ai_dispatcher_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      zone_lat DOUBLE PRECISION NOT NULL DEFAULT 41.208862,
      zone_lng DOUBLE PRECISION NOT NULL DEFAULT -73.207253,
      zone_radius_miles DOUBLE PRECISION NOT NULL DEFAULT 30,
      max_eta_minutes INTEGER NOT NULL DEFAULT 45,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    // Every engine decision/action, append-only. raw_response ALWAYS captures
    // the accept POST response (and the offer JSON for shape escalations) so
    // every action is explainable from the DB after the fact.
    await q`CREATE TABLE IF NOT EXISTS ai_dispatcher_decisions (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      call_request_id TEXT NOT NULL,
      call_id TEXT,
      decision TEXT NOT NULL,
      escalated BOOLEAN NOT NULL DEFAULT FALSE,
      driver_id TEXT,
      driver_name TEXT,
      eta_minutes INTEGER,
      zone_distance_miles DOUBLE PRECISION,
      reason TEXT NOT NULL,
      raw_response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS ai_dispatcher_decisions_org_created_idx ON ai_dispatcher_decisions(org_id, created_at)`;
    // Re-poll can never double-process an offer: one decision row per
    // (org, callRequestId). The engine also SELECTs before acting; this index
    // is the hard backstop.
    await q`CREATE UNIQUE INDEX IF NOT EXISTS ai_dispatcher_decisions_org_callreq_uidx ON ai_dispatcher_decisions(org_id, call_request_id) WHERE call_request_id IS NOT NULL`;
  }],
  [9, async (q) => {
    // AI dispatcher ETA accuracy (owner-directed 2026-08-10, after offer
    // 326520203 was auto-accepted with a 3-min straight-line ETA the owner had
    // to manually extend by 35 min): the quoted ETA is road-aware drive time
    // (OSRM from the driver's precise GPS to the pickup) + a prep buffer, never
    // below a floor, never above the ceiling (max_eta_minutes, still lowered by
    // a per-offer maxEta). Idempotent column adds; existing orgs get the defaults.
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS eta_buffer_minutes INTEGER NOT NULL DEFAULT 5`;
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS eta_floor_minutes INTEGER NOT NULL DEFAULT 5`;
  }],
  [10, async (q) => {
    // Driver portal v1 (owner-directed 2026-08-11): per-driver Towbook sessions.
    // The org_id PRIMARY KEY becomes partial unique indexes — one 'owner' row
    // per org (untouched, same semantics as before) plus one 'driver' row per
    // (org, towbook_driver_id). Existing rows keep session_kind='owner' via the
    // column DEFAULT, so the owner session is preserved byte-for-byte. The FK to
    // organizations (ON DELETE CASCADE) stays on the column; only the PK
    // constraint is dropped. LD users gain towbook_driver_id so driver users are
    // found by their Towbook identity (login upsert + queue scoping).
    await q`ALTER TABLE towbook_sessions ADD COLUMN IF NOT EXISTS session_kind TEXT NOT NULL DEFAULT 'owner'`;
    await q`ALTER TABLE towbook_sessions ADD COLUMN IF NOT EXISTS towbook_driver_id TEXT`;
    await q`ALTER TABLE towbook_sessions DROP CONSTRAINT IF EXISTS towbook_sessions_pkey`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS towbook_sessions_owner_org_uidx ON towbook_sessions(org_id) WHERE session_kind='owner'`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS towbook_sessions_driver_org_uidx ON towbook_sessions(org_id, towbook_driver_id) WHERE session_kind='driver' AND towbook_driver_id IS NOT NULL`;
    await q`CREATE INDEX IF NOT EXISTS towbook_sessions_org_kind_idx ON towbook_sessions(org_id, session_kind)`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS towbook_driver_id TEXT`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS users_towbook_driver_id_idx ON users(towbook_driver_id) WHERE towbook_driver_id IS NOT NULL`;
  }],
  [11, async (q) => {
    // GPS tracking + geofence auto-arrive (owner-directed 2026-08-11, milestone
    // #3). driver_locations is the append-light ping ledger (pruned to 24h on
    // write); dispatch_jobs gains the pickup waypoint coords the geofence needs
    // (backfilled from raw_json waypoints[0] — the Towbook sync imports lat/lng
    // as 0,0); org_settings gains the geofence radius + the photos gate flag;
    // pre_arrival_photos is the MILESTONE #4 contract table the gate reads (4
    // photos + vehicle-match confirmed) — created now so the gate is real and
    // #4 only flips photos_required on without touching geofence logic.
    await q`CREATE TABLE IF NOT EXISTS driver_locations (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      driver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      towbook_driver_id TEXT,
      job_id TEXT,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      accuracy DOUBLE PRECISION,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS driver_locations_org_captured_idx ON driver_locations(org_id, captured_at)`;
    await q`CREATE INDEX IF NOT EXISTS driver_locations_org_driver_idx ON driver_locations(org_id, driver_id)`;
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS geofence_radius_meters DOUBLE PRECISION NOT NULL DEFAULT 150`;
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS photos_required BOOLEAN NOT NULL DEFAULT FALSE`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION`;
    // Backfill pickup coords for existing rows from the stored raw Towbook call
    // (waypoints[0] carries latitude/longitude — recon-verified 2026-08-11).
    await q`UPDATE dispatch_jobs SET pickup_lat=(raw_json#>>'{waypoints,0,latitude}')::double precision, pickup_lng=(raw_json#>>'{waypoints,0,longitude}')::double precision
      WHERE pickup_lat IS NULL AND raw_json IS NOT NULL AND raw_json#>>'{waypoints,0,latitude}' IS NOT NULL`;
    // Milestone #4 contract table: 4 pre-arrival photos (one per vehicle side)
    // + a vehicle-match confirmation. Populated by the photo workflow (#4); the
    // geofence gate only READS it (and only when photos_required=true).
    await q`CREATE TABLE IF NOT EXISTS pre_arrival_photos (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      photo_url TEXT NOT NULL,
      vehicle_match_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS pre_arrival_photos_org_job_idx ON pre_arrival_photos(org_id, job_id)`;
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS towbook_user_id TEXT`;
  }],
  [12, async (q) => {
    // Photo workflow (owner-directed 2026-08-11, milestone #4): job_photos is
    // the canonical photo ledger — 4+4+4 (pre_arrival / service / final, one per
    // vehicle side), each photo stored in Backblaze B2 with its object key in
    // storage_key. match_confirmed is the driver's vehicle-match confirmation
    // (pre_arrival only). One photo per (org, job, phase, side): a retake
    // UPSERTs the same slot (and overwrites the same B2 object).
    await q`CREATE TABLE IF NOT EXISTS job_photos (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      side TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
      match_confirmed BOOLEAN NOT NULL DEFAULT FALSE
    )`;
    await q`CREATE INDEX IF NOT EXISTS job_photos_org_job_phase_idx ON job_photos(org_id, job_id, phase)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS job_photos_org_job_phase_side_uidx ON job_photos(org_id, job_id, phase, side)`;
    // The v11 pre_arrival_photos table was the #4 contract placeholder; job_photos
    // supersedes it (same gate semantics, storage_key instead of photo_url). It
    // was never populated (no writer existed) — safe to drop; the gate now reads
    // job_photos only.
    await q`DROP TABLE IF EXISTS pre_arrival_photos`;
    // Owner spec gates auto-arrive on photos: flip the org_settings default ON
    // and apply to existing orgs (the toggle itself stays owner-adjustable).
    await q`ALTER TABLE org_settings ALTER COLUMN photos_required SET DEFAULT TRUE`;
    await q`UPDATE org_settings SET photos_required=TRUE WHERE photos_required IS DISTINCT FROM TRUE`;
  }],
  [13, async (q) => {
    // Customer completion capture (owner-directed 2026-08-11, milestone
    // "completion flow"): BEFORE a job completes, the customer provides a
    // signature (PNG stored in B2, key under the ld-photos/<org>/<job>/ prefix
    // scheme) and a short survey (rating 1-5 + optional comment). The tip is
    // OPTIONAL and nullable: a Square-hosted payment link is created server-side
    // (owner's Square production credentials, hard-gated like B2 was) with the
    // tip amount + the specific driver's Towbook id attributed to the link so
    // tips are paid out to the right contractor. status ∈ 'none' | 'link_created'
    // | 'paid' — 'link_created' means the customer was handed a Square page;
    // 'paid' is set later when the payment is confirmed. One row per (org, job):
    // a retake UPSERTs the same row (the tip survives a signature retake).
    await q`CREATE TABLE IF NOT EXISTS job_completions (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      signature_storage_key TEXT,
      survey JSONB,
      tip JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, job_id)
    )`;
    await q`CREATE INDEX IF NOT EXISTS job_completions_org_updated_idx ON job_completions(org_id, updated_at)`;
  }],
  [14, async (q) => {
    // Contractor edit/remove (owner-directed 2026-08-11, backlog "Contractor
    // edit/remove with Towbook propagation"): soft-deactivate contractor users
    // instead of hard-deleting them — users are referenced by jobs, sessions,
    // GPS pings, photos and audit rows, so history must survive. A removed
    // contractor: cannot sign in (auth-server currentUser + driverLogin filter
    // on deactivated_at), their LD + stored Towbook sessions are deleted, and
    // they are excluded from dispatch (no session, and Towbook-side disable).
    // deactivated_at stays NULL for active users.
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`;
  }],
  [15, async (q) => {
    // Tip attribution ledger (owner-directed 2026-08-11, "completion flow"):
    // every customer tip attempt is recorded with the SPECIFIC driver so tips
    // reconcile to the right contractor at payout. The customer's card is
    // tokenized client-side (Square Web Payments SDK) and charged server-side
    // via POST /v2/payments with an idempotency key per attempt
    // (tip-<job>-<driver>-<attempt>) — a retry with the same attempt can never
    // double-charge. One row per attempt: status ∈ 'paid' | 'failed' |
    // 'declined' (declined rows are recorded for the paper trail and deleted on
    // a later charge so a job settles with at most one paid tip). driver_id is
    // the LD user id; driver_towbook_id the Towbook identity for payout.
    await q`CREATE TABLE IF NOT EXISTS completion_tips (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      driver_towbook_id TEXT,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      square_payment_id TEXT,
      status TEXT NOT NULL,
      error TEXT,
      attempt INTEGER,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS completion_tips_org_job_idx ON completion_tips(org_id, job_id)`;
    await q`CREATE INDEX IF NOT EXISTS completion_tips_org_driver_idx ON completion_tips(org_id, driver_id)`;
    // One row per idempotency key: a retry that replays the same attempt (same
    // key) UPSERTs the same row — a network blip after Square actually charged
    // can never double-record the tip.
    await q`CREATE UNIQUE INDEX IF NOT EXISTS completion_tips_idempotency_uidx ON completion_tips(idempotency_key) WHERE idempotency_key IS NOT NULL`;
  }],
  [16, async (q) => {
    // Follow-up to 15: INSERT ... ON CONFLICT (idempotency_key) cannot infer a
    // PARTIAL unique index (WHERE idempotency_key IS NOT NULL) unless the
    // conflict target repeats the predicate — so swap it for a plain unique
    // index on idempotency_key. Postgres still allows multiple NULL rows in a
    // unique index (declined rows carry no key), so semantics are unchanged;
    // the charge upsert (ON CONFLICT (idempotency_key)) now works directly.
    await q`DROP INDEX IF EXISTS completion_tips_idempotency_uidx`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS completion_tips_idempotency_uidx ON completion_tips(idempotency_key)`;
  }],
  [17, async (q) => {
    // Auto-dispatch tick observability (owner-approved backlog #1, 2026-08-11
    // incident follow-up): every runAutoDispatch tick persists ONE row so
    // "did the dispatcher run, what did it see, why did it skip" is answerable
    // after the fact — skipped/empty states previously left no trace. This is
    // tick-level and complements ai_dispatcher_decisions (per-offer rows).
    // offer_ids records EVERY offer the tick SAW (id + status) — including
    // ones skipped silently (status!==0, already-processed) — so "the engine
    // saw it and chose not to touch it" is visible, not just processed offers.
    // Volume note: at the 3s cadence this is ~28,800 rows/day/org — acceptable
    // (small rows), but a later cleanup job should prune >14 days; retention
    // automation is deliberately NOT built here.
    await q`CREATE TABLE IF NOT EXISTS ai_dispatcher_runs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      gated BOOLEAN NOT NULL DEFAULT FALSE,
      offers_seen INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      skipped TEXT,
      offer_ids JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
      }],
  [18, async (q) => {
    // Job driver attribution (owner-reported bug batch 2026-08-11, BUG 4): the
    // dashboard + history showed recently completed Towbook jobs as
    // UNASSIGNED because the driver the AI dispatcher / Towbook selected was
    // never persisted on dispatch_jobs (only the legacy dispatch_contractors
    // FK existed, which real synced jobs never set). Capture the assigned
    // driver (Towbook driver id + display name) from the raw call
    // (assets[].driver.id / .name — recon-verified shape, call-single.json)
    // at sync time; the columns are plain TEXT so a sync re-pull can correct
    // them. The backfill fills already-imported rows from their stored
    // raw_json (the same source the sync captures from), so completed jobs
    // that predate this migration show their real driver too.
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS assigned_driver_towbook_id TEXT`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS assigned_driver_name TEXT`;
    await q`UPDATE dispatch_jobs SET
        assigned_driver_towbook_id = raw_json#>>'{assets,0,driver,id}',
        assigned_driver_name = raw_json#>>'{assets,0,driver,name}'
      WHERE assigned_driver_towbook_id IS NULL AND raw_json IS NOT NULL
        AND raw_json#>>'{assets,0,driver,id}' IS NOT NULL`;
  }],
  [19, async (q) => {
    // Payment engine (owner spec 2026-08-11, backlog #1 first slice): the
    // payment ledger. An agent scans the owner's Gmail (lightroad29@gmail.com)
    // for motor-club card-charge notifications (Allied Dispatch, Honk, Allstate)
    // and STAGES them here — staging is the safety rail, the owner reviews
    // staged rows and triggers chargeStagedCore per row (bulk auto-charge +
    // payday come in later slices). kind ∈ club_charge | tip | payout |
    // adjustment; tips keep living in completion_tips (driver attribution) and
    // MIRROR here as kind='tip' via mirrorTipCore (idempotency key
    // tip-mirror-<tipId>). status staged → charged | failed (voided reserved).
    // card_source_id holds a Square card NONCE or card-on-file id (ccof:…) —
    // NEVER the PAN: Square's Payments API (POST /v2/payments) only accepts a
    // nonce/token/card-on-file id in source_id; raw card fields are not
    // supported (verified against the Square docs 2026-08-11). The unique
    // (org, source_email_message_id) index makes a re-scan never double-stage.
    await q`CREATE TABLE IF NOT EXISTS payment_transactions (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      job_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('club_charge','tip','payout','adjustment')),
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      square_payment_id TEXT,
      status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','charged','failed','voided')),
      club_name TEXT,
      card_last4 TEXT,
      card_brand TEXT,
      card_source_id TEXT,
      po_ref TEXT,
      source_email_message_id TEXT,
      source_email_received_at TIMESTAMPTZ,
      idempotency_key TEXT UNIQUE,
      attempt INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS payment_transactions_org_created_idx ON payment_transactions(org_id, created_at)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_org_msgid_uidx ON payment_transactions(org_id, source_email_message_id) WHERE source_email_message_id IS NOT NULL`;
  }],
  [20, async (q) => {
    // Driver portal R2 (2026-08-11, Uber-style redesign spec): Help & Support +
    // post-job feedback tables. driver_issues records driver-raised problems
    // (kind: job_issue | payment | account) AND the "Can't take it" decline
    // intent from the Offers screen (kind: decline — the AI dispatcher's
    // reassign path for still-offered calls is a later milestone, so a decline
    // only notifies dispatch; it never auto-reassigns). job_feedback is the
    // DRIVER's post-job rating (1-5 stars + note) — SEPARATE from the customer
    // survey stored in job_completions.survey. Both rows are owner-readable
    // day one; owner-side surfacing is a later milestone.
    await q`CREATE TABLE IF NOT EXISTS driver_issues (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      driver_id TEXT NOT NULL,
      driver_name TEXT,
      job_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('job_issue','payment','account','decline')),
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS driver_issues_org_created_idx ON driver_issues(org_id, created_at)`;
    await q`CREATE TABLE IF NOT EXISTS job_feedback (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS job_feedback_org_job_idx ON job_feedback(org_id, job_id)`;
  }],
  [21, async (q) => {
    // Contractor administration (owner-directed 2026-08-11, plan rev 17): the
    // owner defines which legal documents every contractor must keep on file
    // (W-9, license, insurance cert, medical examiner card, towing license…).
    // Org-level REQUIRED TYPES — soft-hide via active (never hard-delete:
    // contractor_documents rows reference these ids and files exist in B2).
    // sort_order drives the editor's up/down reorder + the per-contractor
    // Documents list. Unique (org, LOWER(name)) makes a case-insensitive
    // duplicate an explicit DB-level backstop on top of the zod pre-check.
    await q`CREATE TABLE IF NOT EXISTS contractor_doc_types (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      requires_expiry BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS contractor_doc_types_org_name_uidx
      ON contractor_doc_types(org_id, LOWER(name))`;
  }],
  [22, async (q) => {
    // Per-contractor document files — ONE current file per (contractor, type);
    // a re-upload UPSERTs the same row (and overwrites the same B2 object,
    // photos precedent: no versioning in v1; re-upload history = audit rows).
    // status is the OWNER-reviewed state; the READ-TIME derived status adds
    // EXPIRED whenever expires_on < today regardless of the stored status
    // (date wins — the reader promotes; contractor-admin-core derives it).
    await q`CREATE TABLE IF NOT EXISTS contractor_documents (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      contractor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_type_id TEXT NOT NULL REFERENCES contractor_doc_types(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      file_name TEXT,
      mime TEXT,
      size_bytes INTEGER,
      status TEXT NOT NULL DEFAULT 'uploaded'
        CHECK (status IN ('uploaded','verified','expired','rejected')),
      expires_on DATE,
      review_note TEXT,
      uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS contractor_documents_org_ctr_type_uidx
      ON contractor_documents(org_id, contractor_id, doc_type_id)`;
  }],
  [23, async (q) => {
    // Org-scoped contractor operational profile — payrate + LD-only contact
    // fields. payrate_cents = per completed job (NULL = unset, drives future
    // payday math: payrate × completed jobs + tips). phone/vehicle_desc are
    // Lightning-Dispatch-only (no Towbook push in v1 — Towbook's driver editor
    // phone/vehicle surface is unverified territory).
    await q`CREATE TABLE IF NOT EXISTS contractor_profiles (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payrate_cents INTEGER,
      phone TEXT,
      vehicle_desc TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, user_id)
    )`;
  }],
  [30, async (q) => {
    // Owner↔contractor view toggle (owner-directed 2026-08-12): staff accounts
    // (owner/admin) may link ONE active org contractor as their driver identity
    // so they can switch to the driver app from the SAME sign-in (view-only —
    // management powers stay role-gated server-side). Shape (a) — the staff row
    // itself carries towbook_driver_id — is recognized at read time and needs
    // no link column. Shape (b) stores the explicit link here. One driver per
    // owner (single-valued column); one owner per driver (partial unique index).
    // NOTE: numbered 30 (not the spec's stale 24/25) — 24-29 are consumed by
    // later features; the payday plan must take 31-32 (lead directive 2026-08-12).
    await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_driver_user_id TEXT REFERENCES users(id)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS users_linked_driver_uidx
      ON users(linked_driver_user_id) WHERE linked_driver_user_id IS NOT NULL`;
  }],
  [25, async (q) => {
    // Contractor-admin part 3 (owner-directed 2026-08-12): the DRIVER'S LICENSE
    // WITH FACIAL VERIFICATION pair — the license photo AND a live selfie, both
    // required, owner approves the pair with ONE verify tap (no facial-matching
    // service — approval is the owner's review, per owner direction).
    // requires_facial_verification marks a type as pair-bearing; the selfie
    // lives in contractor_doc_selfies (one row per contractor+type — re-upload
    // UPSERTs the same row + same B2 object, photos precedent). Compliance
    // counting + the GO/Offline gate only count the pair when BOTH are present
    // (and the license is owner-verified).
    await q`ALTER TABLE contractor_doc_types ADD COLUMN IF NOT EXISTS requires_facial_verification BOOLEAN NOT NULL DEFAULT FALSE`;
    await q`CREATE TABLE IF NOT EXISTS contractor_doc_selfies (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      contractor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_type_id TEXT NOT NULL REFERENCES contractor_doc_types(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      file_name TEXT,
      mime TEXT,
      size_bytes INTEGER,
      uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS contractor_doc_selfies_org_ctr_type_uidx
      ON contractor_doc_selfies(org_id, contractor_id, doc_type_id)`;
  }],
  [26, async (q) => {
    // Metrics tab + Lightning Dispatch Academy (owner-directed 2026-08-12,
    // metrics-academy-spec.md). THREE new tables:
    //   - academy_lessons: shipped product content (the 10 lesson cards) —
    //     seeded here because it is product copy, NOT business demo data (the
    //     "real data only" rule covers fake business rows; lesson text is
    //     shipped content the product ships with, like the app's copy).
    //   - academy_progress: per (org, user, lesson) manual completion — the
    //     owner decided 2026-08-12 that lesson completion is a manual "Mark
    //     complete" button only, never auto-complete.
    //   - driver_availability_log: the daily GO/Offline ledger (owner decision
    //     Q2) — written as an upsert on the GO/Offline toggle in
    //     driverSetAvailability so hours-online is a REAL tracked metric.
    //     online_minutes accumulates closed online stretches; ping_count counts
    //     online-session starts that day; session_started_at is internal
    //     bookkeeping for the currently-open stretch (null when offline).
    await q`CREATE TABLE IF NOT EXISTS academy_lessons (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      content TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 4,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE
    )`;
    await q`CREATE TABLE IF NOT EXISTS academy_progress (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES academy_lessons(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (org_id, user_id, lesson_id)
    )`;
    await q`CREATE TABLE IF NOT EXISTS driver_availability_log (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      online_minutes INTEGER NOT NULL DEFAULT 0,
      ping_count INTEGER NOT NULL DEFAULT 0,
      session_started_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, user_id, day)
    )`;
    await q`CREATE INDEX IF NOT EXISTS driver_availability_log_org_day_idx ON driver_availability_log(org_id, day)`;
    // Seed the 10 lesson cards (metrics-academy-spec §4 — one lesson per
    // metric_key). INSERT ... ON CONFLICT (slug) DO NOTHING: shipped content,
    // idempotent across every org/deploy.
    await q`INSERT INTO academy_lessons(id, slug, title, summary, metric_key, content, duration_minutes, sort_order, active) VALUES
      ('lesson-pre-trip-readiness', 'pre-trip-readiness', 'Pre-trip readiness', 'Accept offers fast and be rolling before the member notices the wait.', 'accept_time', 'WHY IT MATTERS: Offers are time-sensitive — the member is waiting before you even tap. A quick accept sets the whole job up to run on time.\n\nCHECKLIST:\n- Keep your phone unlocked and ringer on while you are on duty\n- When an offer lands, read the pickup + service in one glance and accept\n- If you cannot take it, decline immediately so dispatch can re-route\n- Before your shift, confirm your vehicle is fueled and stocked\n- Park where you can move out fast — no deep parking lots for the first offer', 4, 1, TRUE),
      ('lesson-eta-honesty', 'eta-honesty', 'ETA honesty', 'Quote the time you can actually hit — the member and dispatch plan around it.', 'eta_accuracy', 'WHY IT MATTERS: An ETA you beat is great; an ETA you blow costs the member time and the company its reputation with the club.\n\nCHECKLIST:\n- Add traffic time, not just distance\n- Account for the extra minutes of prep at the vehicle (hookup, safety)\n- If the route changes, update the ETA instead of hoping\n- Arrive early when you can — early beats late every time\n- Remember the club SLA: quote inside it, then beat it', 4, 2, TRUE),
      ('lesson-twelve-photo-routine', 'twelve-photo-routine', 'The 12-photo routine', 'Four photos at each stage — arrival, service, and finish — every single job.', 'photos_compliance', 'WHY IT MATTERS: Photos are the proof trail for the job. 12/12 means the member, the club, and the owner can see exactly what happened.\n\nCHECKLIST:\n- On arrival: one photo of each vehicle side (4) and confirm the vehicle matches\n- During service: capture the work as it happens (4)\n- At the finish: final vehicle condition, all four sides (4)\n- If a photo fails, retake it before moving on\n- Review the counts on screen before tapping complete', 4, 3, TRUE),
      ('lesson-first-impressions', 'first-impressions', 'First impressions at the scene', 'The member rates the whole job in the first minute — make it count.', 'customer_rating', 'WHY IT MATTERS: Your average rating is the first thing the owner sees. Small courtesies move it more than the service itself.\n\nCHECKLIST:\n- Call or text before you arrive if the member is waiting\n- Step out with a greeting and your name\n- Walk the vehicle once and explain what you will do\n- Keep the scene tidy — cones, gloves, and a clean truck\n- Ask if they need anything else before you finish (a lift home, the lock popped, air in the tires)', 4, 4, TRUE),
      ('lesson-turning-service-into-tips', 'turning-service-into-tips', 'Turning service into tips', 'Tips follow from small touches — the payment link is the easy part.', 'tips', 'WHY IT MATTERS: Tips are part of your pay. Members tip when the experience felt personal and complete.\n\nCHECKLIST:\n- Introduce yourself by name at the scene\n- Point out what you did while the work is fresh\n- Mention the tip link naturally — \"a tip is optional but appreciated\"\n- Leave the vehicle and the area better than you found it\n- Finish with a clean handoff and a genuine goodbye', 4, 5, TRUE),
      ('lesson-acceptance-discipline', 'acceptance-discipline', 'Acceptance discipline', 'Take the offers that fit your day — dispatch counts on a predictable pool.', 'accept_rate', 'WHY IT MATTERS: Every declined offer costs the company re-dispatch time. A high accept rate keeps you first in line for the good jobs.\n\nCHECKLIST:\n- Accept when the pickup fits your area and your day\n- Decline only for a real reason (range, hours, equipment)\n- If you decline, note the reason so dispatch can adjust\n- Check your availability before a big offer wave\n- Tell dispatch when your day ends — do not just stop answering', 4, 6, TRUE),
      ('lesson-stay-visible', 'stay-visible', 'Stay visible: GPS & check-in', 'Location updates keep dispatch honest about where you are and how long you will take.', 'gps_coverage', 'WHY IT MATTERS: The dispatcher routes offers by where you are. A driver with no ping reads as a driver that does not exist.\n\nCHECKLIST:\n- Keep location on for the app while on duty\n- Let the app ping while en route — that is how the ETA stays real\n- If the app asks for location permission, allow it\n- At a long scene, nudge your position so the map stays live\n- Check in when you go online and check out when you are done', 4, 7, TRUE),
      ('lesson-go-offline-planning', 'go-offline-planning', 'GO/Offline planning', 'Plan your hours — being online is what makes the offers come.', 'availability', 'WHY IT MATTERS: Coverage is a real metric now. The members, clubs, and the owner all rely on drivers being online when they say they are.\n\nCHECKLIST:\n- Set a start time and go online at that time\n- Keep the app open and online through your planned window\n- Use Offline for lunch and breaks, then GO again after\n- Log off when you are truly done — a silent online driver is worse than an offline one\n- Watch your weekly coverage in Metrics and aim for 60%+ of the week', 4, 8, TRUE),
      ('lesson-finish-strong', 'finish-strong', 'Finish strong: the full close-out', 'Complete every job you accept — the close-out is part of the service.', 'completion_rate', 'WHY IT MATTERS: A job you accept is a job you finish. Completion rate is the backbone trust metric between you, the owner, and the club.\n\nCHECKLIST:\n- Confirm the member is safe and the vehicle is drivable before you leave\n- Complete the signature, survey, and tip steps on site\n- If anything is off, call dispatch before you drive away\n- Never leave a job uncompleted to chase the next offer\n- Review the finished job on your screen before moving on', 4, 9, TRUE),
      ('lesson-paperwork-done-right', 'paperwork-done-right', 'Paperwork done right', 'Your documents on file keep you cleared to work — and to go online.', 'documents', 'WHY IT MATTERS: Required documents gate your GO button. Missing or expired paperwork means you cannot take jobs at all.\n\nCHECKLIST:\n- Open Profile → Documents and check what is required\n- Upload each document as a clear, readable photo or PDF\n- For the driver''s license, add the live selfie too\n- Watch expiry dates — renew before they lapse\n- Re-upload promptly if the owner asks for a correction', 4, 10, TRUE)
    ON CONFLICT (slug) DO NOTHING`;
  }],
  [28, async (q) => {
    // Driver-portal feature batch (owner-directed 2026-08-12): payout method
    // capture + profile photo. TWO additions:
    //   1. payout_methods — ONE row per (org, contractor): the driver's
    //      chosen payout rail (cash_app/venmo/zelle/bank) + handle. Owner-
    //      confirmed verification happens OUTSIDE the app (no provider API can
    //      prove a cashtag — the owner sends from their own app and marks it),
    //      so the driver UI only captures/stores; status starts
    //      connected_unverified and the owner verifies/rejects later (payday
    //      milestone). "No method" = no row (derived at read). Handles are PII:
    //      drivers always see masked forms; the full handle is owner-only.
    //   2. contractor_profiles.profile_photo_key — B2 object key of the
    //      driver's profile photo (avatar). Re-upload overwrites the same key.
    await q`CREATE TABLE IF NOT EXISTS payout_methods (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      contractor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rail TEXT NOT NULL CHECK (rail IN ('cash_app','venmo','zelle','bank')),
      handle TEXT,
      bank_institution_name TEXT,
      bank_last4 TEXT,
      status TEXT NOT NULL DEFAULT 'connected_unverified'
        CHECK (status IN ('connected_unverified','verified','rejected')),
      reject_note TEXT,
      is_default BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS payout_methods_org_contractor_uidx
      ON payout_methods(org_id, contractor_id)`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS profile_photo_key TEXT`;
  }],
  [27, async (q) => {
    // Contractor Management v2 "Uber-style" (owner-directed 2026-08-12,
    // contractor-management-spec.md). TWO additions:
    //   1. contractor_profiles gains STRUCTURED vehicle fields (type/make/model/
    //      year/plate/plate_state/color) + a one-line address. Explicit columns,
    //      not JSONB: vehicle_type is the future AI-dispatcher capability-routing
    //      target (Flatbed/Wheel-lift/Integrated/Landoll/…). The legacy
    //      vehicle_desc free-text stays (net-new LD-only; Towbook has no vehicle
    //      data) — saves overwrite it with a generated display string so existing
    //      consumers stay non-null.
    //   2. contractor_schedules: ONE row per (org, contractor) holding the
    //      weekly availability TEMPLATE — [{ day:1..7, start:"08:00",
    //      end:"17:00" }] (day 1 = Mon). Owner decision B (2026-08-12):
    //      contractors DECLARE their own availability (source='contractor');
    //      GO/Offline stays the on-demand override on top. The owner sees the
    //      declared schedule read-only and can OVERRIDE it (owner_override=TRUE,
    //      source='owner') — while overridden, driver edits stop applying.
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS address TEXT`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS vehicle_type TEXT`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS vehicle_make TEXT`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS vehicle_model TEXT`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS vehicle_year INTEGER`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS vehicle_plate TEXT`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS vehicle_plate_state TEXT`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS vehicle_color TEXT`;
    await q`CREATE TABLE IF NOT EXISTS contractor_schedules (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      schedule JSONB NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'contractor' CHECK (source IN ('owner','contractor')),
      owner_override BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by_user_id TEXT NOT NULL REFERENCES users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, user_id)
    )`;
  }],
  [29, async (q) => {
    // job_feedback (2026-08-12, owner bug: "contractor feedback won't submit"):
    // the table was originally added to version 20 AFTER v20 had already been
    // applied to the database, so it never ran (driver_issues in the same
    // migration exists; job_feedback does not). Append-only fix — never edit an
    // applied migration. CREATE TABLE IF NOT EXISTS makes this safe to re-run.
    await q`CREATE TABLE IF NOT EXISTS job_feedback (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS job_feedback_org_job_idx ON job_feedback(org_id, job_id)`;
  }],
  [31, async (q) => {
    // Damage-claims agent (owner-directed 2026-08-12, build order #6, PHASE 1):
    // claim records scanned from the owner's Gmail (motor clubs/companies —
    // e.g. the Sixt damage-notice email 2026-08-10), researched, turned into a
    // prepared form, signed by the assigned driver, approved by the owner, then
    // sent to the company. ONE table — the audit_log rows (entity_type
    // 'damage_claim') carry the full transition history, so no second table.
    // Lifecycle: new → researched → form_ready → pending_approval → approved →
    // sent, plus terminal resolved (research found it already resolved) and
    // closed (owner rejected/closed it). job_id links to dispatch_jobs when the
    // email references a job/PO we can match; driver_user_id is the driver who
    // must review + sign. signature_storage_key = B2 key of the signed form
    // image (canvas → B2, same pattern as the completion signature).
    await q`CREATE TABLE IF NOT EXISTS damage_claims (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      claim_number TEXT,
      company TEXT NOT NULL DEFAULT '',
      job_id TEXT,
      driver_user_id TEXT,
      email_message_id TEXT,
      email_from TEXT NOT NULL DEFAULT '',
      email_subject TEXT NOT NULL DEFAULT '',
      email_received_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','researched','form_ready','pending_approval','approved','sent','resolved','closed')),
      research JSONB NOT NULL DEFAULT '{}'::jsonb,
      form JSONB NOT NULL DEFAULT '{}'::jsonb,
      signature_storage_key TEXT,
      signed_by_user_id TEXT,
      signed_at TIMESTAMPTZ,
      approved_by_user_id TEXT,
      approved_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      send_to TEXT,
      send_method TEXT,
      resolved_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    // One claim per (org, email) — the Gmail scan upserts on this key, so a
    // re-scan never duplicates.
    await q`CREATE UNIQUE INDEX IF NOT EXISTS damage_claims_org_message_idx ON damage_claims(org_id, email_message_id) WHERE email_message_id IS NOT NULL`;
    await q`CREATE INDEX IF NOT EXISTS damage_claims_org_status_idx ON damage_claims(org_id, status)`;
    await q`CREATE INDEX IF NOT EXISTS damage_claims_driver_idx ON damage_claims(driver_user_id, status)`;
  }],
  [32, async (q) => {
    // Weekly pay periods (owner-directed 2026-08-11, payout-methods-spec §2):
    // Monday 00:00 → Sunday 23:59:59.999 America/New_York (7-day period),
    // payout due the Wednesday morning AFTER the period closes. One row per
    // org per week (UNIQUE(org_id, starts_at, ends_at)); ensureCurrentPeriod
    // INSERT ON CONFLICT DO NOTHING creates it lazily. status lifecycle:
    // open → computed → paid. ends_at is stored as the absolute instant of
    // Sunday 23:59:59.999 ET (the next Monday 00:00 ET minus 1ms) so window
    // math is a clean [starts_at, ends_at) comparison in UTC.
    await q`CREATE TABLE IF NOT EXISTS pay_periods (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      payout_due_on DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','computed','paid')),
      computed_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (org_id, starts_at, ends_at)
    )`;
    await q`CREATE INDEX IF NOT EXISTS pay_periods_org_created_idx ON pay_periods(org_id, created_at)`;
  }],
  [33, async (q) => {
    // Payout records — the weekly PAYDAY MANIFEST ledger (payout-methods-spec
    // §2, build order #8). One row per (org, period, contractor) with
    // earnings in that period; recompute replaces non-paid rows (upsert by the
    // unique index), paid rows are IMMUTABLE and never touched. rail/handles
    // are SNAPSHOTTED at compute time (changing a method later never rewrites
    // history); handle_full is PII (owner-only surface), handle_masked is the
    // audit/ledger form. rail is NULL when the contractor has NO method row at
    // all (method_status 'none' = blocked); an unverified/rejected method still
    // snapshots rail+handle so the owner can verify it inline. gross_cents =
    // payrate × completed jobs in the window; tips_cents from completion_tips
    // paid rows, ALWAYS a separate line. status: computed (due) | paid |
    // blocked (no verified payout method — amount still recorded, nothing
    // silently dropped).
    await q`CREATE TABLE IF NOT EXISTS payout_records (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      period_id TEXT NOT NULL REFERENCES pay_periods(id) ON DELETE CASCADE,
      contractor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      method_id TEXT,
      rail TEXT,
      handle_full TEXT,
      handle_masked TEXT NOT NULL DEFAULT '',
      job_count INTEGER NOT NULL DEFAULT 0,
      payrate_cents INTEGER,
      gross_cents INTEGER NOT NULL DEFAULT 0,
      tips_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      method_status TEXT NOT NULL DEFAULT 'none' CHECK (method_status IN ('verified','connected_unverified','rejected','none')),
      status TEXT NOT NULL DEFAULT 'computed' CHECK (status IN ('computed','paid','blocked')),
      paid_at TIMESTAMPTZ,
      paid_by_user_id TEXT REFERENCES users(id),
      pay_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS payout_records_org_period_contractor_uidx
      ON payout_records(org_id, period_id, contractor_id)`;
    await q`CREATE INDEX IF NOT EXISTS payout_records_org_period_status_idx ON payout_records(org_id, period_id, status)`;
    await q`CREATE INDEX IF NOT EXISTS payout_records_org_contractor_idx ON payout_records(org_id, contractor_id)`;
  }],
  [34, async (q) => {
    // Card-on-file store (owner spec 2026-08-11, backlog #1 payment tab): ONE
    // stored card per motor club, tokenized CLIENT-SIDE by Square's Web Payments
    // SDK and created on the OWNER's Square account via the Cards API
    // (POST /v2/cards — source_id accepts a card nonce; the response card id is
    // `ccof:…`). square_card_id is the Square card id (UNIQUE — it is the
    // payment source); the PAN is NEVER stored (brand + last4 only). The unique
    // (org_id, lower(club_name)) index enforces one card per club per org —
    // createClubCardCore UPSERTS on it (a re-added card replaces the previous
    // row and best-effort deletes the replaced Square card).
    // Note: payment_transactions deliberately keeps the club_name JOIN (no
    // card_id FK) — chargeStagedCore resolves the club's ccof at charge time by
    // club_name, so a staged row stays chargeable even if the card was replaced
    // since the email arrived (the row's own card_source_id remains an override).
    await q`CREATE TABLE IF NOT EXISTS motor_club_cards (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      club_name TEXT NOT NULL,
      square_card_id TEXT NOT NULL UNIQUE,
      brand TEXT,
      last4 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS motor_club_cards_org_club_uidx ON motor_club_cards(org_id, lower(club_name))`;
  }],
  [35, async (q) => {
    // Assigned-offer web push (owner top priority 2026-08-12): one row per
    // browser push subscription (the browser's push-service endpoint + the
    // RFC 8291 p256dh/auth keys). endpoint is UNIQUE — a re-subscribe
    // (PushSubscriptionChange → new endpoint) REPLACES the old row via upsert,
    // and the same endpoint re-saved refreshes last_seen_at. Scoped to
    // (org, user); ONLY the contractor who owns the row may read/write it
    // (enforced in push-core). A 404/410 from the push service deletes the row.
    await q`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ
    )`;
    await q`CREATE INDEX IF NOT EXISTS push_subscriptions_org_user_idx ON push_subscriptions(org_id, user_id)`;
  }],
  [36, async (q) => {
    // TWO coupled owner-directed features (2026-08-12, Plaid DROPPED):
    //   1. IMMEDIATE TIP CASH-OUT — the driver taps once after a job
    //      completes ("Get your tips") or on Earnings ("Cash out tips now"),
    //      and the request lands on the owner Money tab. The request AMOUNT is
    //      the driver's available tips at request time (paid completion_tips
    //      NOT already covered by a previous cash-out); covered_tip_ids
    //      snapshots EXACTLY which tip rows the request covers so the weekly
    //      payday manifest can exclude paid cash-outs forever ("a cashed-out
    //      tip must never appear in a later manifest again"). Status lifecycle
    //      requested → paid (owner marks paid after sending from their own
    //      app). ONE open request per contractor at a time — the partial
    //      unique index is the double-submit backstop (a second submit for the
    //      same tips hits 23505). rail + handle_masked are SNAPSHOTTED at
    //      request time (masked only — full handles are PII and live in
    //      payout_methods, owner-only).
    //   2. MANUAL BANK PAYOUT RAIL — routing + account number entered by the
    //      contractor are stored ENCRYPTED (AES-256-GCM under a dedicated
    //      bank.key — see src/data/bank-key.ts; the full number is NEVER
    //      plaintext, never in raw_json, never in audit text). Verification is
    //      a micro-deposit: the OWNER sends a small test deposit from their
    //      own bank app and records the amount (bank_deposit_cents — never
    //      shown to the contractor); the contractor confirms the amount in the
    //      driver app → status='verified'. The owner may also mark verified
    //      directly (verifyPayoutMethodCore). An UNVERIFIED bank rail cannot
    //      be used for a tip cash-out request.
    await q`CREATE TABLE IF NOT EXISTS tip_cashouts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      contractor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      rail TEXT NOT NULL CHECK (rail IN ('cash_app','venmo','zelle','bank')),
      handle_masked TEXT NOT NULL DEFAULT '',
      method_id TEXT,
      covered_tip_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      paid_by_user_id TEXT REFERENCES users(id),
      note TEXT
    )`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS tip_cashouts_org_contractor_open_uidx
      ON tip_cashouts(org_id, contractor_id) WHERE status='requested'`;
    await q`CREATE INDEX IF NOT EXISTS tip_cashouts_org_status_idx ON tip_cashouts(org_id, status, created_at)`;
    await q`CREATE INDEX IF NOT EXISTS tip_cashouts_org_contractor_idx ON tip_cashouts(org_id, contractor_id, created_at)`;
    await q`ALTER TABLE payout_methods ADD COLUMN IF NOT EXISTS bank_routing_encrypted TEXT`;
    await q`ALTER TABLE payout_methods ADD COLUMN IF NOT EXISTS bank_account_encrypted TEXT`;
    await q`ALTER TABLE payout_methods ADD COLUMN IF NOT EXISTS bank_deposit_cents INTEGER`;
    await q`ALTER TABLE payout_methods ADD COLUMN IF NOT EXISTS bank_deposit_sent_at TIMESTAMPTZ`;
  }],
  [37, async (q) => {
    // PER-PO CARD MODEL (owner correction 2026-08-12): motor clubs provide ONE
    // CARD PER PO (per job), not one card per club/account. The per-club
    // card-on-file model (motor_club_cards, migration 34) is DEPRECATED — the
    // code stops reading/writing it (the table is kept so an already-applied
    // schema never shrinks; nothing references it anymore).
    //
    // Each staged payment_transactions row now carries ITS OWN card metadata
    // parsed from that PO's email: brand/last4 (columns already present since
    // migration 19) + expiry + billing zip (added here). NO PAN is ever stored —
    // these are display/verification hints only, so the owner knows which card
    // (visible in the PO email) to enter into Square's secure Web Payments
    // form at charge time.
    // charge_path records HOW a row was paid: 'square' (charged through the
    // owner's Square account via POST /v2/payments with a Web Payments nonce)
    // or 'outside' (the owner charged it in their own Square dashboard and
    // marked it paid). NULL = never charged. square_payment_id stays NULL for
    // 'outside' rows; the audit trail carries the rest.
    await q`ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS card_expiry TEXT`;
    await q`ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS card_billing_zip TEXT`;
    await q`ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS charge_path TEXT CHECK (charge_path IS NULL OR charge_path IN ('square','outside'))`;
  }],
  [38, async (q) => {
    // OFFICIAL FILLABLE FORMS (owner-directed 2026-08-12): the W-9 and I-9
    // required docs switch from photo uploads to fillable OFFICIAL forms
    // (USCIS Form I-9 + IRS Form W-9) whose completed PDF is stored to private
    // B2 for record keeping. The compliance gate is UNCHANGED — the form
    // submission still upserts the (contractor, doc_type) contractor_documents
    // row with status 'uploaded' → owner verify/reject as before.
    //
    // form_kind marks a required doc type as FORM-BEARING ('i9' | 'w9'): the
    // driver fills the form instead of uploading a file (uploadMyDocumentCore
    // refuses form types). At most ONE I-9 and ONE W-9 per org (partial unique
    // index). The one-time backfill below tags the mandated set rows that the
    // pre-form seed created (name 'W-9' / 'I-9', case-insensitive) so existing
    // orgs pick up the fillable flow without re-seeding.
    //
    // contractor_form_submissions: ONE current submission per (org, contractor,
    // form doc type). payload = the form fields EXCLUDING the tax id (SSN/EIN
    // never plaintext — tax_id_encrypted is AES-256-GCM under the dedicated
    // bank.key, same envelope as bank rails; decrypted ONLY for the owner
    // review surface and only server-side). pdf_storage_key = the completed
    // official-form PDF in private B2 (the owner's record). section2 is the
    // OWNER-entered I-9 Section 2 review record (documents examined +
    // certifying representative); approval flips contractor_documents to
    // 'verified' and REGENERATES the I-9 PDF with Section 2 stamped in.
    //
    // contractor_form_docs: the I-9 identity documents (List A, or B+C) the
    // driver attaches to their Section 1 — file rows so the owner review UI
    // can pull each image. Numbers/titles are driver-entered metadata; files
    // live in private B2.
    await q`ALTER TABLE contractor_doc_types ADD COLUMN IF NOT EXISTS form_kind TEXT CHECK (form_kind IS NULL OR form_kind IN ('i9','w9'))`;
    // The partial unique index must be (org_id, form_kind): each org carries TWO
    // form rows (W-9 AND I-9), so org_id alone would reject the second backfill.
    // Drop-then-create keeps this idempotent for DBs that already hold the wrong
    // (org_id)-only index from the partially-applied first version of this migration.
    await q`DROP INDEX IF EXISTS contractor_doc_types_org_form_uidx`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS contractor_doc_types_org_form_uidx
      ON contractor_doc_types(org_id, form_kind) WHERE form_kind IS NOT NULL`;
    await q`UPDATE contractor_doc_types SET form_kind='w9' WHERE form_kind IS NULL AND LOWER(name)='w-9'`;
    await q`UPDATE contractor_doc_types SET form_kind='i9' WHERE form_kind IS NULL AND LOWER(name)='i-9'`;
    await q`CREATE TABLE IF NOT EXISTS contractor_form_submissions (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      contractor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_type_id TEXT NOT NULL REFERENCES contractor_doc_types(id) ON DELETE CASCADE,
      form_kind TEXT NOT NULL CHECK (form_kind IN ('i9','w9')),
      pdf_storage_key TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      tax_id_encrypted TEXT,
      section2 JSONB,
      section2_approved_by TEXT REFERENCES users(id),
      section2_approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS contractor_form_submissions_org_ctr_type_uidx
      ON contractor_form_submissions(org_id, contractor_id, doc_type_id)`;
    await q`CREATE INDEX IF NOT EXISTS contractor_form_submissions_org_ctr_idx
      ON contractor_form_submissions(org_id, contractor_id)`;
    await q`CREATE TABLE IF NOT EXISTS contractor_form_docs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      contractor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      submission_id TEXT NOT NULL REFERENCES contractor_form_submissions(id) ON DELETE CASCADE,
      list TEXT NOT NULL CHECK (list IN ('A','B','C')),
      storage_key TEXT NOT NULL,
      file_name TEXT,
      mime TEXT,
      size_bytes INTEGER,
      title TEXT,
      issuing_authority TEXT,
      number TEXT,
      expiration DATE,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS contractor_form_docs_submission_idx ON contractor_form_docs(submission_id)`;
  }],
  [39, async (q) => {
    // CORRECTIVE PASS for DBs that already carry migration 38's partial state
    // (form_kind column added, the WRONG (org_id)-only partial unique index
    // created, W-9 backfilled while the I-9 row stayed NULL). Idempotent:
    // drop-then-create the (org_id, form_kind) partial unique index and re-run
    // both backfill UPDATEs (WHERE form_kind IS NULL — no-op once tagged).
    await q`DROP INDEX IF EXISTS contractor_doc_types_org_form_uidx`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS contractor_doc_types_org_form_uidx
      ON contractor_doc_types(org_id, form_kind) WHERE form_kind IS NOT NULL`;
    await q`UPDATE contractor_doc_types SET form_kind='w9' WHERE form_kind IS NULL AND LOWER(name)='w-9'`;
    await q`UPDATE contractor_doc_types SET form_kind='i9' WHERE form_kind IS NULL AND LOWER(name)='i-9'`;
  }],
  [40, async (q) => {
    // Busy-time bonus (owner-locked mechanics 2026-08-13): 3+ ASSIGNED calls
    // per contractor within one clock hour = busy hour; +$1 per job COMPLETED
    // in that busy hour. Derived at computePaydayCore time from dispatch_jobs
    // (assigned_at / raw_json.dispatchTime → assignment, completed_at /
    // raw_json.completionTime → completion — see busy-bonus-core.ts), then
    // SNAPSHOTTED onto the payout_record so the manifest row, its paid state,
    // and the payment_transactions payout mirror all carry the bonus (the
    // bonus is part of the amount the owner sends). busy_bonus_hours keeps the
    // per-hour breakdown for the manifest line items. Paid rows are immutable;
    // a recompute rewrites non-paid rows with the same derived values
    // (recompute-stable — same dispatch_jobs input → same bonus).
    await q`ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS busy_bonus_cents INTEGER NOT NULL DEFAULT 0`;
    await q`ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS busy_bonus_jobs INTEGER NOT NULL DEFAULT 0`;
    await q`ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS busy_bonus_hours JSONB`;
  }],
  [41, async (q) => {
    // "Notifications & Location" REQUIRED compliance item (owner-directed
    // 2026-08-13): a contractor_doc_types flag marking the type as a
    // SELF-COMPLETED permissions item — the driver must (a) grant notification
    // permission AND save a push subscription AND (b) share a live geolocation
    // fix; the server verifies both and flips the doc to 'verified' (no owner
    // review needed — the proof is the push_subscriptions row + the stored
    // driver_locations ping). Counted by the SAME compliance gate as W-9/I-9/
    // license/insurance (getComplianceGateCore reads every active required
    // type), so going online stays blocked until it's done.
    await q`ALTER TABLE contractor_doc_types ADD COLUMN IF NOT EXISTS requires_notifications_location BOOLEAN NOT NULL DEFAULT FALSE`;
  }],
  [42, async (q) => {
    // BATTERY SALES + TIRE-PLUG PHASE 1 (owner-spec'd 2026-08-13, formula
    // owner-corrected; build 2026-08-13). Jumpstart jobs: the contractor
    // REQUIRED battery test → if faulty, the AI Battery Sales Agent runs a
    // guided sale (VIN → NHTSA decode → Autozone price → install type → live
    // quote → customer approval → CUSTOMER-PRESENT Square card charge on the
    // OWNER's Square account) → warehouse pickup + an auto-created "Battery
    // installation" job in the contractor's queue. Pricing (NON-NEGOTIABLE):
    // customerTotal = batteryPrice + installFee + salesTax + adminFee where
    // salesTax = batteryPrice × taxRate AND adminFee = batteryPrice × 8.75% —
    // tax + admin fee apply to the BATTERY PRICE ONLY; the install fee is
    // neither taxed nor admin-fee'd. All rates configurable in owner settings.
    // NO PAN storage anywhere (Square nonce-only; last4 max). No automated
    // money movement — the charge is customer-present only.
    await q`CREATE TABLE IF NOT EXISTS battery_sales (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,
      contractor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vin TEXT NOT NULL,
      vehicle_make TEXT NOT NULL,
      vehicle_model TEXT NOT NULL,
      vehicle_year TEXT NOT NULL,
      vehicle_manual BOOLEAN NOT NULL DEFAULT FALSE,
      battery_price_cents INTEGER NOT NULL,
      install_type TEXT NOT NULL CHECK (install_type IN ('standard','advanced')),
      install_fee_cents INTEGER NOT NULL,
      sales_tax_cents INTEGER NOT NULL,
      admin_fee_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'quote' CHECK (status IN ('quote','approved','paid','voided')),
      square_charge_id TEXT,
      declined_reason TEXT,
      install_job_id TEXT REFERENCES dispatch_jobs(id) ON DELETE SET NULL,
      charge_attempt INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    )`;
    await q`CREATE INDEX IF NOT EXISTS battery_sales_org_created_idx ON battery_sales(org_id, created_at)`;
    // One OPEN sale per jumpstart job — a job can never have two live quotes
    // (a completed/voided sale frees the slot for a re-run).
    await q`CREATE UNIQUE INDEX IF NOT EXISTS battery_sales_org_job_open_uidx
      ON battery_sales(org_id, job_id) WHERE status IN ('quote','approved')`;
    // REQUIRED battery test gate: recorded on the job itself so completion can
    // be gated even when no sale was ever started (battery OK path).
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS battery_test_result TEXT CHECK (battery_test_result IN ('ok','faulty'))`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS battery_tested_at TIMESTAMPTZ`;
    // Rates config (owner Settings, defaults per owner-corrected formula):
    // tax 6.35% (CT), admin fee 8.75%, install $45/$65, warehouse address.
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS battery_tax_rate_bps INTEGER NOT NULL DEFAULT 635`;
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS battery_admin_fee_bps INTEGER NOT NULL DEFAULT 875`;
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS battery_install_standard_cents INTEGER NOT NULL DEFAULT 4500`;
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS battery_install_advanced_cents INTEGER NOT NULL DEFAULT 6500`;
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS warehouse_address TEXT NOT NULL DEFAULT ''`;
  }],
  [43, async (q) => {
    // Battery sales schema correction (2026-08-13, found during verification):
    // migration 42 declared the quote-price columns NOT NULL, but the agent
    // fills them STEPWISE (price → install → quote), so a fresh sale row is
    // created with NULLs in those columns. Append-only follow-up (42 already
    // applied to prod): relax them. The agent step functions validate each
    // input before it is written, so nullable columns are safe — a sale is
    // never charged until total_cents is set (chargeBatterySaleCore requires
    // status='approved' and total_cents != null).
    await q`ALTER TABLE battery_sales ALTER COLUMN battery_price_cents DROP NOT NULL`;
    await q`ALTER TABLE battery_sales ALTER COLUMN install_type DROP NOT NULL`;
    await q`ALTER TABLE battery_sales ALTER COLUMN install_fee_cents DROP NOT NULL`;
    await q`ALTER TABLE battery_sales ALTER COLUMN sales_tax_cents DROP NOT NULL`;
    await q`ALTER TABLE battery_sales ALTER COLUMN admin_fee_cents DROP NOT NULL`;
    await q`ALTER TABLE battery_sales ALTER COLUMN total_cents DROP NOT NULL`;
    // Vehicle confirmation step: the VIN decode stores the vehicle, but the
    // agent must show it to the driver and get a CONFIRM before the price step
    // (brief: "agent shows the confirmed vehicle → prompts the Autozone price").
    // Manual entry (vehicle_manual) sets it TRUE directly — the entry IS the
    // confirmation.
    await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS vehicle_confirmed BOOLEAN NOT NULL DEFAULT FALSE`;
  }],
  [44, async (q) => {
    // OWNER-EDITABLE ASSIGNED DRIVER (owner-directed 2026-08-13): the owner/ops
    // portal can change which contractor is assigned to a call. The reassign
    // writes the new driver to Towbook (PUT /api/calls/{id} — the PROVEN assign
    // path) and to dispatch_jobs, and stamps a manual-reassign marker so the AI
    // dispatcher treats the HUMAN's latest assignment as authoritative — it must
    // never re-dispatch to the road-best driver when the owner already chose
    // (reassign-driver.test.mjs + the ai-dispatcher guard prove it). The sync's
    // upsert uses COALESCE for the driver columns, so a manual assignment is
    // preserved until Towbook itself reflects the new driver; the marker column
    // is never written by the sync. `manually_reassigned_by` = the acting LD
    // user id (audit attribution, mirrored in the audit_log row).
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS manually_reassigned_at TIMESTAMPTZ`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS manually_reassigned_by TEXT`;
    await q`CREATE INDEX IF NOT EXISTS dispatch_jobs_org_reassigned_idx ON dispatch_jobs(org_id, manually_reassigned_at) WHERE manually_reassigned_at IS NOT NULL`;
  }],
  [45, async (q) => {
    // JOB COMPLETION-TIME GOALS + LIVE COUNTER (owner-directed 2026-08-13,
    // completion-goals-spec.md). TWO additions:
    //   1. service_time_goals — per-org, per-service goal seconds (owner-
    //      configurable; defaults below are the owner-spec'd 5/15/5/5 min +
    //      battery install 1h/2h). variant '' means "no variant" (the non-
    //      battery services); battery_install rows use variant 'standard' /
    //      'advanced' (Phase 1's battery_sales.install_type). Rows are lazily
    //      created with defaults (org_settings pattern) and edited from the
    //      owner Settings "Service time goals" card.
    //   2. dispatch_jobs.duration_seconds — service duration captured ONCE at
    //      completion: completed_at − arrived_at (fallback assigned_at),
    //      immutable like payday rows. NULL for jobs completed before this
    //      migration — the metrics query computes the same value on the fly
    //      (COALESCE) so history needs no backfill.
    // Plus the 11th Academy lesson "On-Time Service Standards" (metric_key
    // service_time) that the Academy coach auto-recommends to drivers whose
    // trailing service average is OVER the goal, and that owners can assign
    // manually from the contractor metrics detail.
    await q`CREATE TABLE IF NOT EXISTS service_time_goals (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      service_type TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT '',
      goal_seconds INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, service_type, variant)
    )`;
    await q`CREATE INDEX IF NOT EXISTS service_time_goals_org_idx ON service_time_goals(org_id)`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS duration_seconds INTEGER`;
    await q`INSERT INTO academy_lessons(id, slug, title, summary, metric_key, content, duration_minutes, sort_order, active) VALUES
      ('lesson-on-time-service-standards', 'on-time-service-standards', 'On-Time Service Standards',
       'Finish each service inside its goal time — jump starts, fuel and lockouts in 5 minutes, tire changes in 15, battery installs in 1–2 hours.',
       'service_time',
       'WHY IT MATTERS: The owner tracks how long each service takes from arrival to completion — a 5-minute jump start goal, 15 minutes for a tire change, 5 minutes for fuel and lockouts, 1 hour for a standard battery install and 2 for an advanced one. Members and motor clubs notice the wait.\\n\\nCHECKLIST:\\n- Stage your truck the night before: cables, fuel cans, and tools where you can grab them in seconds\\n- Arrive prepared — know the service before you knock, so the member is not waiting while you hunt for equipment\\n- Call ahead on the way so the member has the car unlocked and clear\\n- Jump starts: clamp, crank, disconnect in order — no re-staging mid-job\\n- Tire changes: lay out the spare, jack, and lug wrench before lifting\\n- Battery installs: confirm the size and terminal layout before you start, keep the new battery within reach, and torque the terminals once\\n- If a service will run long, tell the member and update dispatch — never let the clock surprise you', 4, 11, TRUE)
      ON CONFLICT (slug) DO NOTHING`;
  }],
  [46, async (q) => {
    // PUSH-SUBSCRIPTION OWNERSHIP REPAIR (2026-08-14, root cause proven
    // read-only). Migration 35 declared `endpoint TEXT NOT NULL UNIQUE` — a
    // GLOBAL unique constraint — and savePushSubscriptionCore upserted with
    // `ON CONFLICT (endpoint) DO UPDATE SET org_id=EXCLUDED.org_id,
    // user_id=EXCLUDED.user_id`, so when a DIFFERENT user re-saved the same
    // endpoint (shared phone / sign-in switch) the row silently RE-PARENTED to
    // the last saver. Live proof: 24hourbattery's Apple endpoint was later
    // saved by another driver — 24hourbattery was left with ZERO rows, and the
    // self-test delivered to the endpoint under the wrong account. Fix:
    // uniqueness becomes ACCOUNT-SCOPED — (org_id, user_id, endpoint). The
    // same endpoint may now exist ONCE PER (org, user): a save by another user
    // INSERTS their own row (cannot steal), while a re-save by the SAME user
    // still upserts in place (idempotent refresh of p256dh/auth/last_seen_at —
    // same-user idempotency preserved). Drop the endpoint-global constraint
    // (auto-named push_subscriptions_endpoint_key by the inline UNIQUE in
    // migration 35 — verified in prod) and create the account-scoped unique
    // index. Safe on existing data: endpoint was globally unique, so
    // (org_id, user_id, endpoint) cannot collide. The org_user index from 35
    // stays (list/send lookups). NOTE: the row already re-parented in prod is
    // NOT rewritten here (no data modification in this pass) — the true owner
    // gets their own row back on the device's next save, and the stale owner's
    // row remains until 404/410 or the owner's own delete.
    await q`ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_endpoint_key`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_org_user_endpoint_uidx
      ON push_subscriptions(org_id, user_id, endpoint)`;
  }],
  [47, async (q) => {
    // Existing status column + audit_log are sufficient for owner void.
    await q`ALTER TABLE contractor_documents DROP CONSTRAINT IF EXISTS contractor_documents_status_check`;
    await q`ALTER TABLE contractor_documents ADD CONSTRAINT contractor_documents_status_check CHECK (status IN ('uploaded','verified','expired','rejected','voided'))`;
  }],
  [48, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS outbound_write_ledger (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      response_summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS outbound_write_ledger_request_key_uidx ON outbound_write_ledger(request_key)`;
    await q`CREATE INDEX IF NOT EXISTS outbound_write_ledger_org_job_idx ON outbound_write_ledger(org_id, job_id)`;
  }],
  [49, async (q) => {
    await q`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE`;
  }],
  [50, async (q) => {
    // Global Towbook identity: one account maps to one LD user row. Empty and
    // legacy-unset identities remain allowed for manually-created users.
    await q`CREATE UNIQUE INDEX IF NOT EXISTS users_towbook_user_id_uidx
      ON users(towbook_user_id)
      WHERE towbook_user_id IS NOT NULL AND towbook_user_id <> ''`;
  }],
  [51, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS dispatch_zones (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      radius_miles DOUBLE PRECISION NOT NULL DEFAULT 20,
      tz TEXT NOT NULL DEFAULT 'America/New_York',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS dispatch_zones_org_active_idx ON dispatch_zones(org_id, active)`;
    await q`ALTER TABLE driver_availability_log ADD COLUMN IF NOT EXISTS zone_id TEXT REFERENCES dispatch_zones(id) ON DELETE SET NULL`;
    await q`ALTER TABLE driver_availability_log ADD COLUMN IF NOT EXISTS zone_changed_at TIMESTAMPTZ`;
    await q`ALTER TABLE driver_availability_log ADD COLUMN IF NOT EXISTS zone_change_count INTEGER NOT NULL DEFAULT 0`;
  }],
  [52, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS driver_region_preferences (org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, driver_id TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}'::jsonb, enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(org_id, driver_id))`;
    await q`CREATE INDEX IF NOT EXISTS driver_region_preferences_org_idx ON driver_region_preferences(org_id, enabled)`;
  }],
  [53, async (q) => {
    await q`INSERT INTO driver_region_preferences (org_id, driver_id, config, enabled)
      VALUES ('89e15ce587651cc47c3bc45b1c612a220955', '717660', ${JSON.stringify({
        core_centers: [{ name: 'Bridgeport', lat: 41.1792, lng: -73.1894, radius_miles: 4 }, { name: 'Milford', lat: 41.2307, lng: -73.064, radius_miles: 4 }],
        nearby_centers: [
          { name: 'Stratford', lat: 41.2043, lng: -73.1332, radius_miles: 3 }, { name: 'Fairfield', lat: 41.1412, lng: -73.2637, radius_miles: 3 },
          { name: 'Orange', lat: 41.2787, lng: -73.0257, radius_miles: 3 }, { name: 'Shelton', lat: 41.3165, lng: -73.0932, radius_miles: 3 },
          { name: 'Trumbull', lat: 41.2429, lng: -73.2007, radius_miles: 3 }, { name: 'West Haven', lat: 41.2707, lng: -72.947, radius_miles: 3 }
        ], priority_weight: 1, nearby_weight: 0.5, max_backlog_before_waive: 2, enabled: true
      })}::jsonb, TRUE)
      ON CONFLICT (org_id, driver_id) DO NOTHING`;
  }],

  [54, async (q) => {
    // P0 Slice 3: persisted availability heartbeat. A live GO is eligible only
    // while heartbeat_at is fresh; closing a tab therefore cannot leave a
    // driver available forever, while device handoff has a 90-second grace.
    await q`ALTER TABLE driver_availability_log ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`;
    await q`CREATE INDEX IF NOT EXISTS driver_availability_heartbeat_idx ON driver_availability_log(org_id, heartbeat_at) WHERE session_started_at IS NOT NULL`;
  }],
  [55, async (q) => {
    // National zone metadata. Append-only and idempotent: existing P0 zones are
    // backfilled to CT for continuity; future markets are owner-managed data.
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS state CHAR(2)`;
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS market TEXT`;
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS zone_type TEXT`;
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS zip_codes TEXT[]`;
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS parent_zone_id TEXT REFERENCES dispatch_zones(id) ON DELETE SET NULL`;
    await q`UPDATE dispatch_zones SET state='CT', market='', zone_type='market', zip_codes='{}'::text[], parent_zone_id=NULL WHERE state IS NULL OR market IS NULL OR zone_type IS NULL OR zip_codes IS NULL`;
    await q`ALTER TABLE dispatch_zones ALTER COLUMN state SET NOT NULL`;
    await q`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_zones_zone_type_check') THEN ALTER TABLE dispatch_zones ADD CONSTRAINT dispatch_zones_zone_type_check CHECK (zone_type IN ('market','submarket','rural','corridor','coverage','county')); END IF; END $$`;
    await q`CREATE INDEX IF NOT EXISTS dispatch_zones_org_state_active_idx ON dispatch_zones(org_id,state,active)`;
    await q`CREATE INDEX IF NOT EXISTS dispatch_zones_zip_codes_gin_idx ON dispatch_zones USING GIN(zip_codes)`;
    await q`CREATE INDEX IF NOT EXISTS dispatch_zones_parent_idx ON dispatch_zones(parent_zone_id)`;
    await q`CREATE INDEX IF NOT EXISTS dispatch_zones_geo_idx ON dispatch_zones(org_id,state,active,lat,lng)`;
  }],

  [56, async (q) => {
    await q`ALTER TABLE dispatch_zones DROP CONSTRAINT IF EXISTS dispatch_zones_zone_type_check`;
    await q`ALTER TABLE dispatch_zones ADD CONSTRAINT dispatch_zones_zone_type_check CHECK (zone_type IN ('market','submarket','rural','corridor','coverage','county'))`;
  }],
  [57, async (q) => {
    // Fresh-bootstrap self-seed added 2026-08-15 after the R2 gate rehearsal
    // failed with `missing seed row: Southwest CT`. Production never re-runs
    // this recorded migration, so this only affects fresh databases; NOT EXISTS
    // guards make it a no-op on a production-like state. Historical CT market
    // ZIP splits are not reconstructible, so fresh bootstrap uses deterministic
    // national-node subsets and county-derived ZIP universes that form a valid
    // gap-free, overlap-free partition; production rows remain byte-for-byte
    // untouched when already present.
    const org = '89e15ce587651cc47c3bc45b1c612a220955';
    const readRepoJson = async (rel: string): Promise<unknown> => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      for (const base of [process.cwd(), join(process.cwd(), "dist/server")]) {
        try { return JSON.parse(readFileSync(join(base, rel), "utf8")); } catch { /* try next base */ }
      }
      throw new Error(`migration 57: cannot read ${rel} from ${process.cwd()}`);
    };
    const { createHash } = await import("node:crypto");
    const stableZoneId = (key: string) => { const h=createHash("sha256").update(`dispatch-zone:${key}`).digest("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${((parseInt(h.slice(16,18),16)&0x3f)|0x80).toString(16).padStart(2,"0")}${h.slice(18,20)}-${h.slice(20,32)}`; };
    const zipCounty = await readRepoJson("src/data/zip-county.json") as Record<string, {county:string;state:string}>;
    const usZips = await readRepoJson("src/data/us-zips.json") as Record<string, unknown>;
    const national = await readRepoJson("src/data/national-zones.json") as Array<any>;
    const countiesWanted = ['Fairfield','New Haven','Hartford','Litchfield','Middlesex','New London','Tolland','Windham'];
    const countyZips = Object.fromEntries(countiesWanted.map(name => [name, Object.entries(zipCounty).filter(([zip,v]) => v.state==='CT' && v.county===name && Object.prototype.hasOwnProperty.call(usZips,zip)).map(([zip])=>zip).sort()]));
    for (const name of countiesWanted) {
      const zips = countyZips[name]; if (!zips.length) throw new Error(`CT county ${name} has no ZIPs`);
      const node = national.find(n => n.key === `CT|county|${name}`);
      const id = stableZoneId(`${org}|CT|county|${name}`);
      await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,updated_at)
        SELECT ${id},${org},${name},'CT',${name},'county',${zips},NULL,${Number(node?.lat)||41.5},${Number(node?.lng)||-72.7},${Number(node?.radius_miles)||30},${node?.tz||'America/New_York'},TRUE,${3200+countiesWanted.indexOf(name)},NOW()
        WHERE NOT EXISTS (SELECT 1 FROM dispatch_zones WHERE org_id=${org} AND state='CT' AND zone_type='county' AND name=${name})`;
    }
    const marketsWanted = ['Southwest CT','Bridgeport–Milford','New Haven–Branford','CT Capital Region'];
    for (const name of marketsWanted) {
      const node = national.find(n => n.name === name && n.state === 'CT' && n.zone_type === 'market');
      const zips = [...new Set((node?.zip_codes || []).filter((zip:string) => countyZips[zipCounty[zip]?.county]?.includes(zip)))].sort();
      if (!zips.length) throw new Error(`CT market ${name} has no seed ZIPs`);
      const id = stableZoneId(`${org}|CT|market|${name}`);
      await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,updated_at)
        SELECT ${id},${org},${name},'CT',${name},'market',${zips},NULL,${Number(node?.lat)||41.5},${Number(node?.lng)||-72.7},${Number(node?.radius_miles)||20},${node?.tz||'America/New_York'},TRUE,${3000+marketsWanted.indexOf(name)},NOW()
        WHERE NOT EXISTS (SELECT 1 FROM dispatch_zones WHERE org_id=${org} AND state='CT' AND zone_type='market' AND name=${name})`;
    }
    const existing = await q`SELECT id,name,zone_type,zip_codes,active FROM dispatch_zones WHERE org_id=${org} AND state='CT' AND zone_type IN ('market','corridor') ORDER BY sort_order,id`;
    const counties = await q`SELECT id,name,zip_codes,lat,lng FROM dispatch_zones WHERE org_id=${org} AND state='CT' AND zone_type='county' AND active=TRUE`;
    const plan = computeRegionalCtPlan(existing as RegionalCtInput[], counties as RegionalCtCounty[]);
    if (plan.gaps.length || plan.duplicates.length) throw new Error(`CT regional partition failed closed: ${plan.gaps.length} gaps, ${plan.duplicates.length} duplicates`);
    const byId = new Map(existing.map((r:any) => [String(r.id), r]));
    await q`UPDATE dispatch_zones SET active=FALSE WHERE org_id=${org} AND state='CT' AND zone_type IN ('market','corridor')`;
    for (const region of plan.regions) {
      const old = byId.get(region.id);
      if (old) {
        await q`UPDATE dispatch_zones SET name=${region.name}, market=${region.name}, zone_type='market', zip_codes=${region.zips}, parent_zone_id=${region.parentId}, active=TRUE, sort_order=${region.sortOrder}, updated_at=NOW() WHERE id=${region.id} AND org_id=${org}`;
      } else {
        const c = counties.find((x:any) => String(x.id) === region.parentId)!;
        await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,updated_at) VALUES(${region.id},${org},${region.name},'CT',${region.name},'market',${region.zips},${region.parentId},${Number(c.lat)},${Number(c.lng)},30,'America/New_York',TRUE,${region.sortOrder},NOW())`;
      }
    }
  }],
  [58, async (q) => {
    // Driver license is two independent required captures. Preserve the existing
    // single license row by renaming it to the front slot; the back slot starts
    // missing and therefore blocks compliance until uploaded and reviewed.
    await q`UPDATE contractor_doc_types SET name=${"Driver's License — Front"} WHERE LOWER(name)=${"driver's license"}`;
    await q`INSERT INTO contractor_doc_types(id, org_id, name, requires_expiry, requires_facial_verification, form_kind, requires_notifications_location, sort_order, active)
      SELECT gen_random_uuid()::text, org_id, ${"Driver's License — Back"}, requires_expiry, FALSE, NULL, FALSE, sort_order + 1, active
      FROM contractor_doc_types t WHERE LOWER(t.name)=${"driver's license — front"}
      AND NOT EXISTS (SELECT 1 FROM contractor_doc_types x WHERE x.org_id=t.org_id AND LOWER(x.name)=${"driver's license — back"})`;
  }],
  [59, async (q) => {
    // Owner-directed TX market partition. County membership is deliberately
    // explicit and the ZIP universe is the repository's us-zips.json; this
    // keeps the migration deterministic and prevents cross-market overlap.
    const org = '89e15ce587651cc47c3bc45b1c612a220955';
    const { createHash } = await import("node:crypto");
    const stableZoneId = (key: string) => { const h=createHash('sha256').update(`dispatch-zone:${key}`).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${((parseInt(h.slice(16,18),16)&0x3f)|0x80).toString(16).padStart(2,'0')}${h.slice(18,20)}-${h.slice(20,32)}`; };
    // One-time migration data: read from disk at apply time so the multi-MB
    // national ZIP/county datasets never enter the bundle (build memory + server
    // footprint). The migration runs once and is recorded in schema_migrations.
    const readRepoJson = async (rel: string): Promise<unknown> => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      for (const base of [process.cwd(), join(process.cwd(), "dist/server")]) {
        try { return JSON.parse(readFileSync(join(base, rel), "utf8")); } catch { /* try next base */ }
      }
      throw new Error(`migration 59: cannot read ${rel} from ${process.cwd()}`);
    };
    const zipCounty = await readRepoJson("src/data/zip-county.json") as Record<string, {county:string;state:string}>;
    const usZips = await readRepoJson("src/data/us-zips.json") as Record<string, unknown>;
    const countySets: Record<string, string[]> = {
      Houston: ['Harris','Fort Bend','Montgomery','Brazoria','Galveston','Waller','Liberty','Chambers'],
      'San Antonio': ['Bexar','Comal','Guadalupe','Medina','Kendall','Bandera','Wilson','Atascosa'],
      'El Paso': ['El Paso'],
      'Corpus Christi': ['Nueces','San Patricio','Aransas','Kleberg'],
    };
    // Fresh-bootstrap self-seed: production had these national TX prerequisites,
    // but a zero-state database does not. Keep stable IDs and NOT EXISTS guards
    // so this is byte-for-byte a no-op on the production-like rows.
    const national = await readRepoJson("src/data/national-zones.json") as Array<any>;
    const txState = national.find(n => n.key === 'TX|coverage|STATE');
    await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,updated_at)
      SELECT 'national-zone-tx-state',${org},${txState?.name||'TX'},'TX',${txState?.market||'TX'},'coverage',${[]},NULL,${Number(txState?.lat)||30.2747},${Number(txState?.lng)||-97.7403},${Number(txState?.radius_miles)||180},${txState?.tz||'America/Chicago'},TRUE,1000,NOW()
      WHERE NOT EXISTS (SELECT 1 FROM dispatch_zones WHERE id='national-zone-tx-state' AND org_id=${org})`;
    const txMarkets = [
      ['Houston',29.7604,-95.3698,45], ['San Antonio',29.4241,-98.4936,35],
      ['El Paso',31.7619,-106.485,35], ['Corpus Christi',27.8006,-97.3964,30],
    ] as const;
    for (const [name, lat, lng, radius] of txMarkets) {
      const node = national.find(n => n.key === `TX|market|${name}`);
      const id = stableZoneId(`${org}|TX|market|${name}`);
      await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,updated_at)
        SELECT ${id},${org},${name},'TX',${name},'market',${[]},NULL,${Number(node?.lat)||lat},${Number(node?.lng)||lng},${Number(node?.radius_miles)||radius},${node?.tz||'America/Chicago'},TRUE,${3000+txMarkets.findIndex(x => x[0] === name)},NOW()
        WHERE NOT EXISTS (SELECT 1 FROM dispatch_zones WHERE org_id=${org} AND state='TX' AND zone_type='market' AND name=${name})`;
    }
    const zipSets = Object.fromEntries(Object.entries(countySets).map(([market, counties]) => {
      const zips = Object.entries(zipCounty as Record<string, {county:string;state:string}>)
        .filter(([zip, value]) => value.state === 'TX' && counties.includes(value.county) && Object.prototype.hasOwnProperty.call(usZips, zip))
        .map(([zip]) => zip).sort();
      if (!zips.length) throw new Error(`TX ${market} partition produced no ZIPs`);
      return [market, zips];
    })) as Record<string, string[]>;
    const markets = await q`SELECT id,name,zip_codes,parent_zone_id FROM dispatch_zones WHERE org_id=${org} AND state='TX' AND zone_type='market' AND name IN ('Houston','San Antonio','El Paso','Corpus Christi')`;
    if (markets.length !== 4) throw new Error(`TX partition expected 4 markets, found ${markets.length}`);
    const before = await q`SELECT name,zip_codes FROM dispatch_zones WHERE org_id=${org} AND state='TX' AND zone_type IN ('market','corridor')`;
    const seen = new Map<string,string>();
    for (const row of before) for (const zip of (Array.isArray(row.zip_codes) ? row.zip_codes : []).map(String)) {
      const previous = seen.get(zip); if (previous) throw new Error(`TX ZIP already overlaps ${previous}/${row.name}: ${zip}`); seen.set(zip, String(row.name));
    }
    // Non-overlap by construction: any ZIP already owned by a live existing
    // market (Austin/DFW) stays with that market. Detected 2026-08-15: Comal
    // County ZIPs 78623/78638/78670 are owned by TX Capital Region (Austin) —
    // excluded from San Antonio's set so Austin stays byte-identical and no TX
    // ZIP appears in two markets. Overlaps among the four new markets cannot
    // occur (county sets are disjoint) and the four current arrays are empty.
    for (const [market, zips] of Object.entries(zipSets)) {
      const kept = zips.filter((zip) => {
        const previous = seen.get(zip);
        return !(previous && !['Houston','San Antonio','El Paso','Corpus Christi'].includes(previous));
      });
      if (!kept.length) throw new Error(`TX ${market} partition produced no ZIPs after overlap exclusion`);
      zipSets[market] = kept;
    }
    // Nueces is the county parent for Corpus Christi. Existing national seed
    // uses this stable ID; create only if absent, never rewrite another parent.
    let nueces = await q`SELECT id FROM dispatch_zones WHERE org_id=${org} AND state='TX' AND zone_type='county' AND name='Nueces' LIMIT 1`;
    if (!nueces.length) {
      await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,updated_at) VALUES('national-zone-tx-county-nueces',${org},'Nueces','TX','Nueces','county',${[]},'national-zone-tx-state',27.7371,-97.4128,30,'America/Chicago',TRUE,3200,NOW()) ON CONFLICT(id) DO NOTHING`;
      nueces = await q`SELECT id FROM dispatch_zones WHERE id='national-zone-tx-county-nueces' AND org_id=${org}`;
    }
    if (!nueces.length) throw new Error('Unable to ensure Nueces county parent');
    for (const [market, zips] of Object.entries(zipSets)) {
      const parent = market === 'Corpus Christi' ? String(nueces[0].id) : undefined;
      if (parent) await q`UPDATE dispatch_zones SET zip_codes=${zips}, parent_zone_id=${parent}, updated_at=NOW() WHERE org_id=${org} AND state='TX' AND zone_type='market' AND name=${market}`;
      else await q`UPDATE dispatch_zones SET zip_codes=${zips}, updated_at=NOW() WHERE org_id=${org} AND state='TX' AND zone_type='market' AND name=${market}`;
    }
  }],
  [60, async (q) => {
    // Minimal AI qualification gate. Default ON; owner can roll back per org without deploy.
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS qualification_gate_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
    await q`UPDATE org_settings SET qualification_gate_enabled=TRUE WHERE qualification_gate_enabled IS NULL`;
  }],
  [61, async (q) => {
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS nudge_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS reassign_not_headed_minutes INTEGER NOT NULL DEFAULT 5`;
    await q`CREATE TABLE IF NOT EXISTS dispatch_nudge_events (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, job_id TEXT NOT NULL, driver_towbook_id TEXT, kind TEXT NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(org_id, job_id, kind))`;
    await q`CREATE INDEX IF NOT EXISTS dispatch_nudge_events_org_job ON dispatch_nudge_events(org_id, job_id)`;
  }],
  [62, async (q) => {
    // Optional GPS signal; existing clients omit it and retain conservative NULL.
    await q`ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS speed_mph DOUBLE PRECISION`;
  }],


  [63, async (q) => {
    // The nudge lifecycle writes multiple decision rows per job: the
    // auto-accept (reason 'reassigned_not_headed') on reassignment, then a
    // DISTINCT escalation (reason 'reassigned_not_headed_again') when the
    // replacement never heads out. The old (org_id, call_request_id) unique
    // index silently swallowed that escalation via ON CONFLICT DO NOTHING, so
    // the owner "replacement not headed" alert never landed in the ledger.
    // Scope uniqueness by reason: the re-poll backstop (same offer + same
    // reason reprocessed) is preserved, while distinct lifecycle stages can
    // each record. The engine also SELECTs before acting either way.
    await q`DROP INDEX IF EXISTS ai_dispatcher_decisions_org_callreq_uidx`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS ai_dispatcher_decisions_org_callreq_reason_uidx ON ai_dispatcher_decisions(org_id, call_request_id, reason) WHERE call_request_id IS NOT NULL`;
  }],
  [64, async (q) => {
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS polygon_geojson JSONB`;
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS capacity INTEGER`;
  }],
  [65, async (q) => {
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS market_id TEXT`;
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS demand_level INTEGER`;
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'available'`;
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS is_reserved BOOLEAN NOT NULL DEFAULT false`;
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS unlock_jobs_required INTEGER NOT NULL DEFAULT 30`;
    await q`ALTER TABLE dispatch_zones ADD COLUMN IF NOT EXISTS color TEXT`;
  }],
  // 66 (2026-08-15): vehicle-type vocabulary — normalize legacy/case variants to
  // the owner-specified capability set (car | tow truck | other). The dispatch
  // tow gate is fail-closed on exact 'tow truck', so stale values must not
  // masquerade as capabilities; 'Other' also broke the editor select which now
  // validates against the same three values the save path accepts.
  [68, async (q) => {
    await q`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS tire_plug_rate_cents INTEGER NOT NULL DEFAULT 4500`;
    await q`CREATE TABLE IF NOT EXISTS tire_plug_transactions (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, job_id TEXT NOT NULL, contractor_user_id TEXT NOT NULL REFERENCES users(id), amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0), status TEXT NOT NULL CHECK (status IN ('offered','approved','charged','paid','voided','declined')), square_charge_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ, declined_reason TEXT)`;
    await q`CREATE INDEX IF NOT EXISTS tire_plug_transactions_org_created_idx ON tire_plug_transactions(org_id,created_at)`;
    await q`CREATE OR REPLACE FUNCTION reject_paid_tire_plug_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status IN ('charged','paid') AND (NEW.status,NEW.amount_cents,NEW.square_charge_id,NEW.paid_at) IS DISTINCT FROM (OLD.status,OLD.amount_cents,OLD.square_charge_id,OLD.paid_at) THEN RAISE EXCEPTION 'paid tire plug transactions are immutable'; END IF; RETURN NEW; END; $$`;
    await q`DROP TRIGGER IF EXISTS tire_plug_paid_immutable ON tire_plug_transactions`;
    await q`CREATE TRIGGER tire_plug_paid_immutable BEFORE UPDATE ON tire_plug_transactions FOR EACH ROW EXECUTE FUNCTION reject_paid_tire_plug_mutation()`;
  }],
  [67, async (q) => {
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS photos_flagged_missing BOOLEAN NOT NULL DEFAULT FALSE`;
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS photos_flagged_missing_at TIMESTAMPTZ`;
    await q`ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS upload_attempts INTEGER NOT NULL DEFAULT 1`;
    await q`ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS last_upload_error TEXT`;
  }],
  [66, async (q) => {
    await q`UPDATE contractor_profiles SET vehicle_type = 'tow truck' WHERE vehicle_type IN ('Flatbed','Wheel-lift','Integrated','Landoll')`;
    await q`UPDATE contractor_profiles SET vehicle_type = 'other' WHERE vehicle_type = 'Other'`;
  }],

  [70, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS owner_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      route TEXT,
      payload JSONB,
      call_request_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    )`;
    await q`CREATE INDEX IF NOT EXISTS owner_notifications_org_created_idx ON owner_notifications(org_id, created_at DESC)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS owner_notifications_org_call_escalation_uidx ON owner_notifications(org_id, call_request_id) WHERE call_request_id IS NOT NULL AND kind='escalation'`;
  }],

  [69, async (q) => {
    await q`ALTER TABLE tip_cashouts ADD COLUMN IF NOT EXISTS covered_tire_plug_ids JSONB NOT NULL DEFAULT '[]'::jsonb`;
    await q`ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS tire_plug_cents INTEGER NOT NULL DEFAULT 0`;
  }],
  // 71: idempotent source-based owner notification archive entries.
  [71, async (q) => {
    await q`CREATE UNIQUE INDEX IF NOT EXISTS owner_notifications_org_kind_source_uidx ON owner_notifications(org_id, kind, (payload->>'sourceId')) WHERE (payload->>'sourceId') IS NOT NULL`;
  }],
  // 80: per-call CallWorkflow report snapshots for payday reconciliation. Numbered 80
  // (NOT 72): prod schema_migrations already consumed 72-79 from the pre-fork lineage.
  [80, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS towbook_report_snapshots (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      report_type TEXT NOT NULL, period_start DATE NOT NULL, period_end DATE NOT NULL,
      data JSONB NOT NULL, source TEXT NOT NULL DEFAULT 'server' CHECK (source IN ('server','manual-paste')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS towbook_report_snapshots_period_idx ON towbook_report_snapshots(org_id,report_type,period_start,period_end,created_at DESC)`;
  }],

  [73, async (q) => {
    // Owner CSV price book seed; free replacement defaults to three years per owner input mapping.
    await q`INSERT INTO battery_products (id, org_id, group_size, alternate_group_sizes, display_name, retail_cents, installation_cents, warranty_years, free_replacement_years, core_charge_cents, availability, active, source_reference_internal, source_brand, source_line, source_part_number, internal_cost_cents, internal_margin_cents) VALUES
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '24', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 23399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '24-DLG', 23499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '24F', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 20899, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '24F-DLG', 20999, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '27', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 22399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '27-DLG', 22499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '34', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 20899, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '34-DLG', 20999, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '35', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 21399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '35-DLG', 21499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '47', '["H5"]'::jsonb, 'LIGHTNING GOLD BATTERY', 21399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', 'H5-DLG', 21499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '48', '["H6"]'::jsonb, 'LIGHTNING GOLD BATTERY', 20899, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', 'H6-DLG', 20999, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '49', '["H8"]'::jsonb, 'LIGHTNING GOLD BATTERY', 23899, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', 'H8-DLG', 23999, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '51R', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 21399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '51R-DLG', 21499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '59', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 22399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '59-DLG', 22499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '65', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 21399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '65-DLG', 21499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '75', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 21399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '75-DLG', 21499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '78', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 20899, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '78-DLG', 20999, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '86', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 23399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '86FT-DLG', 23499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '90', '["T5"]'::jsonb, 'LIGHTNING GOLD BATTERY', 23899, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', 'T5-DLG', 23999, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '94R', '["H7"]'::jsonb, 'LIGHTNING GOLD BATTERY', 21399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', 'H7-DLG', 21499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '95R', '["H9"]'::jsonb, 'LIGHTNING GOLD BATTERY', 23899, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', 'H9-DLG', 23999, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '96R', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 22899, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '96R-DLG', 22999, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '101', '["Type S"]'::jsonb, 'LIGHTNING GOLD BATTERY', 22399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '101-DLG', 22499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '102R', '["V4"]'::jsonb, 'LIGHTNING GOLD BATTERY', 23399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', 'V4-DLG', 23499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '121R', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 22399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '121R-DLG', 22499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '124R', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 21399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '124R-DLG', 21499, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '140R', '["H4"]'::jsonb, 'LIGHTNING GOLD BATTERY', 22899, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', 'H4-DLG', 22999, NULL),
(gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', '151R', '[]'::jsonb, 'LIGHTNING GOLD BATTERY', 22399, 0, 3, 3, 0, 'in_stock', true, 'owner-csv', 'Duralast', 'Gold', '151R-DLG', 22499, NULL)
      ON CONFLICT (org_id, group_size) DO UPDATE SET alternate_group_sizes=EXCLUDED.alternate_group_sizes, display_name=EXCLUDED.display_name, retail_cents=EXCLUDED.retail_cents, warranty_years=EXCLUDED.warranty_years, free_replacement_years=EXCLUDED.free_replacement_years, core_charge_cents=EXCLUDED.core_charge_cents, source_reference_internal=EXCLUDED.source_reference_internal, source_brand=EXCLUDED.source_brand, source_line=EXCLUDED.source_line, source_part_number=EXCLUDED.source_part_number, internal_cost_cents=EXCLUDED.internal_cost_cents, updated_at=NOW()`;
  }],
  [74, async (q) => {
    await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS compatibility_id TEXT`;
    await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS battery_group_size TEXT`;
  }],
  [75, async (q) => {
    await q`ALTER TABLE battery_install_types ADD COLUMN IF NOT EXISTS label TEXT`;
    await q`ALTER TABLE battery_install_types ADD COLUMN IF NOT EXISTS description TEXT`;
    const seeds = [
      ['STANDARD', 'Standard', 'Top-terminal battery installation.', 4500, 4500, 1, 60, 'Vehicle accessible; standard battery location.'],
      ['ADVANCED', 'Advanced', 'Buried or heavy-duty battery installation.', 6500, 6500, 2, 120, 'Additional access or heavy-duty configuration required.'],
      ['EUROPEAN', 'European', 'European vehicle battery installation.', 5500, 5500, 2, 90, 'European vehicle fitment; confirm battery location and electronics.'],
      ['BATTERY_LOCATION_REMOTE', 'Remote battery location', 'Battery installed in a remote location.', 5500, 5500, 2, 90, 'Battery location away from the standard engine bay.'],
      ['PROGRAMMING_REQUIRED', 'Programming required', 'Battery installation with vehicle programming.', 5500, 5500, 3, 120, 'Vehicle battery registration or programming required.'],
      ['DUAL_BATTERY', 'Dual battery', 'Dual-battery vehicle installation.', 5500, 5500, 3, 120, 'Two-battery system; verify both batteries and access.'],
    ] as const;
    for (const [code, label, description, price, payout, difficulty, minutes, requirement] of seeds) {
      await q`INSERT INTO battery_install_types (id, org_id, code, customer_price_cents, driver_payout_cents, difficulty, estimated_minutes, requirements, label, description, active)
        SELECT gen_random_uuid()::text, '89e15ce587651cc47c3bc45b1c612a220955', ${code}, ${price}, ${payout}, ${String(difficulty)}, ${minutes}, ${JSON.stringify([requirement])}::jsonb, ${label}, ${description}, true
        WHERE NOT EXISTS (SELECT 1 FROM battery_install_types WHERE org_id = '89e15ce587651cc47c3bc45b1c612a220955' AND code = ${code})`;
    }
  }],
  [76, async (q) => {
    // The legacy Phase-1 constraint only allowed standard/advanced and conflicts
    // with the authoritative battery_install_types catalog (including new types).
    await q`ALTER TABLE battery_sales DROP CONSTRAINT IF EXISTS battery_sales_install_type_check`;
    await q`UPDATE battery_sales SET install_type = lower(install_type) WHERE install_type IS NOT NULL`;
  }],
  [77, async (q) => {
    // B4 price-book lookup support; product/provenance columns are B1-owned.
    await q`CREATE INDEX IF NOT EXISTS battery_products_aliases_gin_idx ON battery_products USING GIN (alternate_group_sizes)`;
    await q`UPDATE battery_products SET display_name='LIGHTNING GOLD BATTERY', core_charge_cents=0 WHERE display_name IS NULL OR display_name <> 'LIGHTNING GOLD BATTERY' OR core_charge_cents IS NULL`;
  }],
   [82, async (q) => {
    // Certified battery B1-B4 schema; prod max was 81; append above it.
    // Battery B1 core catalog and inventory model. This migration is additive:
        // Phase 1 battery_sales remains intact and is extended in migration 71.
        await q`CREATE TABLE IF NOT EXISTS battery_products (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          group_size TEXT NOT NULL,
          alternate_group_sizes JSONB NOT NULL DEFAULT '[]'::jsonb,
          display_name TEXT NOT NULL DEFAULT 'LIGHTNING GOLD BATTERY',
          retail_cents INTEGER NOT NULL CHECK (retail_cents >= 0),
          installation_cents INTEGER NOT NULL CHECK (installation_cents >= 0),
          warranty_years INTEGER NOT NULL CHECK (warranty_years >= 0),
          free_replacement_years INTEGER NOT NULL CHECK (free_replacement_years >= 0),
          core_charge_cents INTEGER NOT NULL CHECK (core_charge_cents >= 0),
          availability TEXT NOT NULL CHECK (availability IN ('in_stock','limited','unavailable','special_order')),
          active BOOLEAN NOT NULL DEFAULT TRUE,
          image_key TEXT,
          compatibility_review_required BOOLEAN NOT NULL DEFAULT FALSE,
          source_reference_internal TEXT,
          internal_cost_cents INTEGER,
          internal_margin_cents INTEGER,
          source_brand TEXT,
          source_line TEXT,
          source_part_number TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (org_id, group_size)
        )`;
        await q`CREATE TABLE IF NOT EXISTS battery_compatibility (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          make TEXT NOT NULL,
          model TEXT NOT NULL,
          year_from INTEGER NOT NULL,
          year_to INTEGER NOT NULL,
          trim TEXT,
          engine TEXT,
          battery_group_size TEXT NOT NULL,
          source_reference_internal TEXT,
          status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('approved','review','rejected')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (year_from >= 1886 AND year_to >= year_from),
          FOREIGN KEY (org_id, battery_group_size) REFERENCES battery_products(org_id, group_size) ON DELETE RESTRICT
        )`;
        await q`CREATE UNIQUE INDEX IF NOT EXISTS battery_compatibility_fitment_uidx
          ON battery_compatibility(org_id, lower(make), lower(model), year_from, year_to, battery_group_size, lower(COALESCE(trim, '')), lower(COALESCE(engine, ''))) `;
        await q`CREATE TABLE IF NOT EXISTS battery_install_types (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          code TEXT NOT NULL CHECK (code IN ('STANDARD','ADVANCED','EUROPEAN','BATTERY_LOCATION_REMOTE','PROGRAMMING_REQUIRED','DUAL_BATTERY')),
          customer_price_cents INTEGER NOT NULL CHECK (customer_price_cents >= 0),
          driver_payout_cents INTEGER NOT NULL CHECK (driver_payout_cents >= 0),
          difficulty TEXT NOT NULL,
          estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes > 0),
          requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (org_id, code)
        )`;
        await q`CREATE TABLE IF NOT EXISTS battery_inventory (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          product_id TEXT NOT NULL REFERENCES battery_products(id) ON DELETE CASCADE,
          on_hand_units INTEGER NOT NULL CHECK (on_hand_units >= 0),
          reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
          held_units INTEGER NOT NULL DEFAULT 0 CHECK (held_units >= 0),
          reorder_threshold INTEGER NOT NULL DEFAULT 0 CHECK (reorder_threshold >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (org_id, product_id)
        )`;
    // Sale snapshots make catalog edits unable to mutate historical charges.
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS product_id TEXT`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS compatibility_id TEXT`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS install_type_id TEXT`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS group_size TEXT`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS alternate_group_size TEXT`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS retail_snapshot_cents INTEGER`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS installation_snapshot_cents INTEGER`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS warranty_years_snapshot INTEGER`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS free_replacement_years_snapshot INTEGER`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS core_charge_snapshot_cents INTEGER`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS driver_payout_snapshot_cents INTEGER`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS inventory_state TEXT`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS inventory_reserved_at TIMESTAMPTZ`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS inventory_held_at TIMESTAMPTZ`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`;
        await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS customer_facing_brand TEXT CHECK (customer_facing_brand = 'LIGHTNING GOLD BATTERY')`;
        await q`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battery_sales_product_fk') THEN ALTER TABLE battery_sales ADD CONSTRAINT battery_sales_product_fk FOREIGN KEY (product_id) REFERENCES battery_products(id) ON DELETE SET NULL; END IF; END $$`;
        await q`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battery_sales_compatibility_fk') THEN ALTER TABLE battery_sales ADD CONSTRAINT battery_sales_compatibility_fk FOREIGN KEY (compatibility_id) REFERENCES battery_compatibility(id) ON DELETE SET NULL; END IF; END $$`;
        await q`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battery_sales_install_type_fk') THEN ALTER TABLE battery_sales ADD CONSTRAINT battery_sales_install_type_fk FOREIGN KEY (install_type_id) REFERENCES battery_install_types(id) ON DELETE SET NULL; END IF; END $$`;
        await q`CREATE TABLE IF NOT EXISTS battery_inventory_ledger (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          product_id TEXT NOT NULL REFERENCES battery_products(id) ON DELETE RESTRICT,
          sale_id TEXT REFERENCES battery_sales(id) ON DELETE SET NULL,
          job_id TEXT REFERENCES dispatch_jobs(id) ON DELETE SET NULL,
          event_type TEXT NOT NULL CHECK (event_type IN ('reserve','payment_hold','complete_decrement','cancel_release','manual_adjust','release')),
          delta_units INTEGER NOT NULL,
          quantity_after INTEGER NOT NULL CHECK (quantity_after >= 0),
          idempotency_key TEXT NOT NULL,
          actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (org_id, idempotency_key)
        )`;
        await q`CREATE TABLE IF NOT EXISTS battery_install_photos (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          sale_id TEXT NOT NULL REFERENCES battery_sales(id) ON DELETE CASCADE,
          install_job_id TEXT NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,
          photo_type TEXT NOT NULL CHECK (photo_type IN ('before','old','new','installed')),
          storage_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'uploaded',
          uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (org_id, sale_id, photo_type)
        )`;
        await q`CREATE TABLE IF NOT EXISTS battery_warranties (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          sale_id TEXT NOT NULL REFERENCES battery_sales(id) ON DELETE CASCADE,
          product_id TEXT NOT NULL REFERENCES battery_products(id) ON DELETE RESTRICT,
          install_job_id TEXT NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,
          vin TEXT,
          group_size TEXT NOT NULL,
          warranty_years INTEGER NOT NULL CHECK (warranty_years >= 0),
          starts_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','voided')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          voided_at TIMESTAMPTZ,
          voided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          CHECK (expires_at > starts_at),
          UNIQUE (org_id, sale_id)
        )`;
    // Query indexes are deliberately org-prefixed for tenant isolation and
        // predictable plans. No compatibility rows or production orgs are seeded.
        await q`CREATE INDEX IF NOT EXISTS battery_products_org_active_idx ON battery_products(org_id, active)`;
        await q`CREATE INDEX IF NOT EXISTS battery_compatibility_org_make_model_idx ON battery_compatibility(org_id, make, model)`;
        await q`CREATE INDEX IF NOT EXISTS battery_install_types_org_active_idx ON battery_install_types(org_id, active)`;
        await q`CREATE INDEX IF NOT EXISTS battery_inventory_org_product_idx ON battery_inventory(org_id, product_id)`;
        await q`CREATE INDEX IF NOT EXISTS battery_sales_org_product_idx ON battery_sales(org_id, product_id)`;
        await q`CREATE INDEX IF NOT EXISTS battery_sales_org_compatibility_idx ON battery_sales(org_id, compatibility_id)`;
        await q`CREATE INDEX IF NOT EXISTS battery_sales_org_install_type_idx ON battery_sales(org_id, install_type_id)`;
        await q`CREATE INDEX IF NOT EXISTS battery_inventory_ledger_org_product_created_idx ON battery_inventory_ledger(org_id, product_id, created_at)`;
        await q`CREATE INDEX IF NOT EXISTS battery_inventory_ledger_org_sale_idx ON battery_inventory_ledger(org_id, sale_id)`;
        await q`CREATE INDEX IF NOT EXISTS battery_inventory_ledger_org_job_idx ON battery_inventory_ledger(org_id, job_id)`;
        await q`CREATE INDEX IF NOT EXISTS battery_install_photos_org_install_job_idx ON battery_install_photos(org_id, install_job_id)`;
        await q`CREATE INDEX IF NOT EXISTS battery_install_photos_org_sale_idx ON battery_install_photos(org_id, sale_id)`;
        await q`CREATE INDEX IF NOT EXISTS battery_warranties_org_status_expiry_idx ON battery_warranties(org_id, status, expires_at)`;
        await q`CREATE INDEX IF NOT EXISTS battery_warranties_org_install_job_idx ON battery_warranties(org_id, install_job_id)`;
        await q`CREATE INDEX IF NOT EXISTS battery_warranties_org_product_idx ON battery_warranties(org_id, product_id)`;
  }],
  [83, async (q) => {
    await q`ALTER TABLE battery_products ADD COLUMN IF NOT EXISTS reorder_required BOOLEAN NOT NULL DEFAULT FALSE`;
    await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS battery_photo_override_at TIMESTAMPTZ`;
    await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS battery_photo_override_by TEXT REFERENCES users(id) ON DELETE SET NULL`;
    await q`ALTER TABLE battery_sales ADD COLUMN IF NOT EXISTS battery_photo_override_reason TEXT`;
    await q`CREATE TABLE IF NOT EXISTS battery_install_photo_overrides (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, sale_id TEXT NOT NULL REFERENCES battery_sales(id) ON DELETE CASCADE, install_job_id TEXT NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE, actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(org_id, sale_id))`;
    await q`CREATE INDEX IF NOT EXISTS battery_install_photo_overrides_org_idx ON battery_install_photo_overrides(org_id, created_at)`;
  }],
  // 84: immutable earned-on-completion battery-install payout ledger. A sale
  // can be completed/replayed only once; payday aggregates these snapshots and
  // keeps paid manifests immutable. Voided sales are excluded at read time.
  [84, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS battery_payouts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sale_id TEXT NOT NULL REFERENCES battery_sales(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,
      contractor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(org_id, sale_id)
    )`;
    await q`CREATE INDEX IF NOT EXISTS battery_payouts_org_earned_idx ON battery_payouts(org_id, earned_at)`;
    await q`CREATE INDEX IF NOT EXISTS battery_payouts_org_contractor_idx ON battery_payouts(org_id, contractor_user_id, earned_at)`;
    await q`ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS battery_payout_cents INTEGER NOT NULL DEFAULT 0`;
  }],

  // 85: preserve GOA count separately so owner and contractor statements can
  // show the exact $10 adjustment without reverse-engineering gross_cents.
  [85, async (q) => {
    await q`ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS goa_job_count INTEGER NOT NULL DEFAULT 0`;
  }],

  // 86: positive contractor service capabilities. Empty means fail-closed for dispatch.
  [86, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS contractor_services (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      contractor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, service_type TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT 'seed' CHECK (updated_by IN ('seed','contractor','owner')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(org_id, contractor_id, service_type)
    )`;
    await q`CREATE INDEX IF NOT EXISTS contractor_services_org_contractor_idx ON contractor_services(org_id, contractor_id)`;
    await q`CREATE INDEX IF NOT EXISTS contractor_services_org_service_idx ON contractor_services(org_id, service_type)`;
    await seedContractorServicesFromHistory(q);
  }],
  // 89: durable five-minute retry attempt audit for accepted no-driver holds.
  // The decision ledger is updated only when a hold resolves; this append-only
  // table preserves every sweep timestamp and outcome, including safe skips.
    [89, async (q) => {
    await q`CREATE TABLE IF NOT EXISTS ai_dispatcher_retry_attempts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      decision_id TEXT NOT NULL REFERENCES ai_dispatcher_decisions(id) ON DELETE CASCADE,
      call_request_id TEXT NOT NULL,
      call_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('assigned','already_resolved','no_qualifying_driver','call_unavailable','invalid_hold','verification_failed','expired')),
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS ai_dispatcher_retry_attempts_org_time_idx ON ai_dispatcher_retry_attempts(org_id, attempted_at DESC)`;
    await q`CREATE INDEX IF NOT EXISTS ai_dispatcher_retry_attempts_decision_time_idx ON ai_dispatcher_retry_attempts(decision_id, attempted_at DESC)`;
  }],
  // 90 (2026-08-21): explicit owner-confirmed dispatch fallback for staff /
  // supervisor drivers who work from Towbook and may not have an app GPS fix.
  // State and coordinates are owner-maintained, scoped to this contractor
  // profile, and only used while enabled; real app GPS remains authoritative
  // whenever a fresh fix exists.
  [90, async (q) => {
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS owner_confirmed_dispatch_enabled BOOLEAN NOT NULL DEFAULT FALSE`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS owner_confirmed_dispatch_state TEXT`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS owner_confirmed_dispatch_lat DOUBLE PRECISION`;
    await q`ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS owner_confirmed_dispatch_lng DOUBLE PRECISION`;
    await q`CREATE INDEX IF NOT EXISTS contractor_profiles_owner_dispatch_idx ON contractor_profiles(org_id, owner_confirmed_dispatch_enabled) WHERE owner_confirmed_dispatch_enabled=TRUE`;
  }],
  // 91 (2026-08-23): SUB B — persist the AI dispatcher's final quoted ETA
  // (minutes, already capped by finalEtaMinutes) onto dispatch_jobs so the
  // DRIVER-facing ETA can prefer the traffic-aware LD quote over Towbook's raw
  // arrivalETA (SUB B defect 1). Nullable: legacy rows fall back to Towbook.
  [91, async (q) => {
    await q`ALTER TABLE dispatch_jobs ADD COLUMN IF NOT EXISTS quoted_eta_minutes INTEGER`;
  }],
];
export async function ensureSchema() {
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  // Apply numerically, not by source position: historical entries 25–30 were
  // introduced out of order, and upgrade databases may have any pending subset.
  for (const [version, apply] of [...migrations].sort(([a], [b]) => a - b)) {
    const done = await q`SELECT 1 FROM schema_migrations WHERE version=${version}`;
    if (!done.length) { await apply(q); await q`INSERT INTO schema_migrations(version) VALUES(${version})`; }
  }
}
