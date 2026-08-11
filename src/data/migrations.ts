import { sql } from "~/db";

/** Append-only, idempotent database migrations. Each step is recorded once. */
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
    await q`CREATE INDEX IF NOT EXISTS ai_dispatcher_runs_org_ran_idx ON ai_dispatcher_runs(org_id, ran_at DESC)`;
  }],
];
export async function ensureSchema() {
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  for (const [version, apply] of migrations) {
    const done = await q`SELECT 1 FROM schema_migrations WHERE version=${version}`;
    if (!done.length) { await apply(q); await q`INSERT INTO schema_migrations(version) VALUES(${version})`; }
  }
}
