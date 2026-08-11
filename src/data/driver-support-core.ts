/**
 * Driver Help & Support + post-job feedback — SERVER-ONLY core. Imported ONLY
 * via dynamic import from the client-safe facade (driver-support.ts). Never
 * import this module statically from a client-reachable file.
 *
 * Both handlers are contractor-only, write driver_issues / job_feedback plus
 * an audit_log row (action 'driver_issue' | 'driver_feedback'), and return
 * seroval-safe results (no undefined-valued props — omit, don't set undefined).
 */
import { z } from "zod";

const configured = () => Boolean(process.env.DATABASE_URL);
const db = () => import("~/db").then((m) => m.sql());

export type DriverIssueResult = { ok: boolean; message?: string };
export type DriverFeedbackResult = { ok: boolean; message?: string };

const KIND_LABELS: Record<string, string> = {
  job_issue: "Job issue",
  payment: "Payment",
  account: "Account",
  decline: "Decline",
};

async function contractorContext() {
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || u.role !== "contractor") return null;
  const q = await db();
  const rows = await q`SELECT name, towbook_driver_id FROM users WHERE id=${u.id}`;
  if (!rows.length) return null;
  return {
    orgId: u.orgId,
    userId: u.id,
    name: String(rows[0].name ?? ""),
    towbookDriverId: rows[0].towbook_driver_id != null ? String(rows[0].towbook_driver_id) : null,
  };
}

/** INSERT helper shared by both handlers — the audit_log insert follows the
 *  Neon-safe pattern (never a raw JS param inside jsonb_build_object). */
async function insertWithAudit(
  opts: { orgId: string; userId: string; actorRole: string; action: string; entityType: string; entityId: string; detail: Record<string, unknown> },
  target:
    | { table: "driver_issues"; cols: { org_id: string; driver_id: string; driver_name: string; job_id: string | null; kind: string; message: string } }
    | { table: "job_feedback"; cols: { org_id: string; job_id: string; driver_id: string; rating: number; comment: string | null } },
): Promise<void> {
  const q = await db();
  if (target.table === "driver_issues") {
    const c = target.cols;
    await q`INSERT INTO driver_issues(id, org_id, driver_id, driver_name, job_id, kind, message)
      VALUES(gen_random_uuid()::text, ${c.org_id}, ${c.driver_id}, ${c.driver_name}, ${c.job_id}, ${c.kind}, ${c.message})`;
  } else {
    const c = target.cols;
    await q`INSERT INTO job_feedback(id, org_id, job_id, driver_id, rating, comment)
      VALUES(gen_random_uuid()::text, ${c.org_id}, ${c.job_id}, ${c.driver_id}, ${c.rating}, ${c.comment})`;
  }
  await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail)
    SELECT gen_random_uuid()::text, ${opts.orgId}, ${opts.userId}, ${opts.actorRole}, ${opts.action}, ${opts.entityType}, ${opts.entityId}, ${JSON.stringify(opts.detail)}::jsonb`;
}

export async function submitDriverIssueHandler(data: unknown): Promise<DriverIssueResult> {
  const v = z.object({
    kind: z.enum(["job_issue", "payment", "account", "decline"]),
    message: z.string().trim().min(1).max(300),
    jobId: z.string().max(64).optional().nullable(),
  }).safeParse(data);
  if (!v.success) return { ok: false, message: "Please add a short description (up to 300 characters)." };
  if (!configured()) return { ok: false, message: "Support requests require database mode." };
  const ctx = await contractorContext();
  if (!ctx) return { ok: false, message: "Sign in as a driver first." };
  try {
    const jobId = v.data.jobId && v.data.jobId.trim() ? v.data.jobId.trim() : null;
    await insertWithAudit(
      { orgId: ctx.orgId, userId: ctx.userId, actorRole: "contractor", action: "driver_issue", entityType: "job", entityId: jobId ?? ctx.userId, detail: { kind: v.data.kind, jobId, message: v.data.message, driverTowbookId: ctx.towbookDriverId } },
      { table: "driver_issues", cols: { org_id: ctx.orgId, driver_id: ctx.userId, driver_name: ctx.name, job_id: jobId, kind: v.data.kind, message: v.data.message } },
    );
    return { ok: true };
  } catch {
    return { ok: false, message: "Unable to send your report. Try again." };
  }
}

export async function submitDriverFeedbackHandler(data: unknown): Promise<DriverFeedbackResult> {
  const v = z.object({
    jobId: z.string().min(1).max(64),
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(300).optional().nullable(),
  }).safeParse(data);
  if (!v.success) return { ok: false, message: "Pick a rating (1–5 stars) to submit." };
  if (!configured()) return { ok: false, message: "Feedback requires database mode." };
  const ctx = await contractorContext();
  if (!ctx) return { ok: false, message: "Sign in as a driver first." };
  try {
    const comment = v.data.comment && v.data.comment.trim() ? v.data.comment.trim() : null;
    await insertWithAudit(
      { orgId: ctx.orgId, userId: ctx.userId, actorRole: "contractor", action: "driver_feedback", entityType: "job", entityId: v.data.jobId, detail: { jobId: v.data.jobId, rating: v.data.rating, comment } },
      { table: "job_feedback", cols: { org_id: ctx.orgId, job_id: v.data.jobId, driver_id: ctx.userId, rating: v.data.rating, comment } },
    );
    return { ok: true };
  } catch {
    return { ok: false, message: "Unable to save your feedback. Try again." };
  }
}

/** Keep KIND_LABELS referenced (owner-side surfacing will use it later). */
export const driverSupportMeta = { KIND_LABELS };
