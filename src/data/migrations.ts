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
];
export async function ensureSchema() {
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  for (const [version, apply] of migrations) {
    const done = await q`SELECT 1 FROM schema_migrations WHERE version=${version}`;
    if (!done.length) { await apply(q); await q`INSERT INTO schema_migrations(version) VALUES(${version})`; }
  }
}
