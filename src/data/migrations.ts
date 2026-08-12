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
  [24, async (q) => {
    // Owner↔contractor view toggle (owner-directed 2026-08-12): staff accounts
    // (owner/admin) may link ONE active org contractor as their driver identity
    // so they can switch to the driver app from the SAME sign-in (view-only —
    // management powers stay role-gated server-side). Shape (a) — the staff row
    // itself carries towbook_driver_id — is recognized at read time and needs
    // no link column. Shape (b) stores the explicit link here. One driver per
    // owner (single-valued column); one owner per driver (partial unique index).
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
];
export async function ensureSchema() {
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  for (const [version, apply] of migrations) {
    const done = await q`SELECT 1 FROM schema_migrations WHERE version=${version}`;
    if (!done.length) { await apply(q); await q`INSERT INTO schema_migrations(version) VALUES(${version})`; }
  }
}
