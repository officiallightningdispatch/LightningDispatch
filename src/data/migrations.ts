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
];
export async function ensureSchema() {
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  for (const [version, apply] of migrations) {
    const done = await q`SELECT 1 FROM schema_migrations WHERE version=${version}`;
    if (!done.length) { await apply(q); await q`INSERT INTO schema_migrations(version) VALUES(${version})`; }
  }
}
