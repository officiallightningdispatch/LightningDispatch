/**
 * Job detail expansion (owner spec 2026-08-11, backlog #2) — CLIENT-SAFE FACADE.
 *
 * This module is the ONLY piece of the job-detail feature imported by client
 * code (ops queue cards, owner dashboard/history, driver portal). It defines
 * the createServerFn server functions; their handlers dynamic-import the
 * SERVER-ONLY core (./job-detail-core.ts) so the client bundle never pulls in
 * b2-client / node:crypto / db / auth-server code. No other exports — the core
 * owns all logic (see the client-graph rule that has broken the build before).
 */
import { createServerFn } from "@tanstack/react-start";
import type { JobDetailResult, JobPhotoResult } from "./job-detail-core";
export type { JobDetail, JobDetailPhoto, JobDetailResult } from "./job-detail-core";

const passthrough = (x: unknown) => x;

/** Resolve the acting user context (LD session + Towbook driver id) for a
 *  job-detail read. Null when signed out or not a portal member. */
async function resolveDetailUser(): Promise<{ orgId: string; id: string; role: string; contractorId?: string; towbookDriverId: string } | null> {
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const { sql } = await import("~/db");
  const rows = await sql()`SELECT towbook_driver_id FROM users WHERE id=${u.id}`;
  return {
    orgId: u.orgId,
    id: u.id,
    role: u.role,
    ...(u.contractorId ? { contractorId: u.contractorId } : {}),
    towbookDriverId: rows.length && rows[0].towbook_driver_id != null ? String(rows[0].towbook_driver_id) : "",
  };
}

/** Full detail for one job (role-checked; owner/ops any org job, contractor
 *  only their own). Lazy: called when a card is expanded, so list payloads
 *  stay small. */
export const getJobDetail = createServerFn({ method: "GET" }).validator(passthrough).handler(async ({ data }): Promise<JobDetailResult> => {
  const core = await import("./job-detail-core");
  if (!process.env.DATABASE_URL) return { ok: false, code: "database_unavailable", message: "Requires database mode." };
  const user = await resolveDetailUser();
  if (!user) return { ok: false, code: "unauthorized", message: "Sign in first." };
  return core.getJobDetailCore(user, data);
});

/** One job photo's bytes as a data URL (role-checked; keyed by jobId+phase+side
 *  so the server resolves the storage key — never a client-supplied B2 key). */
export const getJobPhoto = createServerFn({ method: "GET" }).validator(passthrough).handler(async ({ data }): Promise<JobPhotoResult> => {
  const core = await import("./job-detail-core");
  if (!process.env.DATABASE_URL) return { ok: false, code: "database_unavailable", message: "Requires database mode." };
  const user = await resolveDetailUser();
  if (!user) return { ok: false, code: "unauthorized", message: "Sign in first." };
  return core.getJobPhotoCore(user, data);
});
