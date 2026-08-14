/**
 * Portal → Towbook status push (owner-directed 2026-08-11; fixes "the job
 * status does not change on Towbook when I change it on the portal").
 *
 * The 30s pull (server.ts syncForOrg) already replicates Towbook → portal and
 * MUST stay intact. This module closes the OTHER direction: every owner /
 * admin / dispatcher job status change that lands in dispatch_jobs is pushed
 * to Towbook via PUT /api/calls/{callId} {id, status:{id:N}} — the exact write
 * shape the driver transitions (driver-auth.ts applyDriverTransition) and
 * completion (driver-photos-core.ts completeJobCore) already use — mapped with
 * the SAME numeric status ids the pull side uses (server.ts
 * TOWBOOK_STATUS_ID_TO_LIFECYCLE, mirrored below as
 * LIFECYCLE_TO_TOWBOOK_STATUS_ID: 0 new, 1 offered, 2 accepted, 3 en_route,
 * 4 arrived, 5 completed). 252/255 are Towbook-side states (completed-awaiting-
 * acknowledgement / cancelled) and are NEVER pushed from the portal — we push
 * 5 for completed, exactly like completeJobCore does.
 *
 * Pipeline (never throws — every failure is a clean skip or an escalation +
 * audit row, so the ops "Needs attention" banner surfaces it):
 *   1. Re-read the job from dispatch_jobs. RACE GUARD: if a newer status
 *      landed since the local transition (e.g. the 30s pull imported a driver's
 *      phone update), the push targets THAT status — it can never push a stale
 *      transition.
 *   2. Idempotency: GET the call first; if Towbook already reports the target
 *      status the push is a no-op — never a double PUT.
 *   3. LAST-WRITE-WINS GUARD (documented choice): the PUT only fires when
 *      Towbook's CURRENT status is not NEWER than the transition. A newer
 *      Towbook status (e.g. imported by the 30s pull from a driver's phone)
 *      wins — the push is SKIPPED so it can never clobber it. Concretely:
 *      whichever side's status is newest ON Towbook wins, because the loser
 *      refuses to overwrite it. If Towbook is BEHIND the portal (older status,
 *      pull lagged), the push still fires — a non-adjacent jump Towbook
 *      rejects simply escalates with evidence, it never silently drops.
 *      Terminal ids (252 completed-ack, 255 cancelled) are always "newer" —
 *      a portal push never fights a completed/cancelled call.
 *   4. PUT with one retry on transient failure, then a read-back verify; any
 *      failure records an escalation (decision escalated_status_push_failed)
 *      with the full attempt evidence and an audit row.
 *   5. Verified success writes towbook_status + audit_log; the next pull
 *      re-confirms and reconciles any drift.
 *
 * Server-only module: never statically imported by a client-reachable module —
 * server.ts handlers reach it via dynamic import inside handler bodies (the
 * client bundle strips those), matching the auth-server pattern.
 */
import { z } from "zod";

export type StatusPushActor = { id: string; role: "owner" | "admin" | "dispatcher" | "contractor" };

export type StatusPushResult =
  | { ok: true; changed: boolean; skipped: boolean; reason: string | null; statusId: number | null }
  | { ok: false; code: "towbook_failed" | "verify_failed" | "session_expired" | "not_found" | "error"; message: string; escalated: boolean };

/** Portal lifecycle → Towbook numeric status id (mirror of the pull side's
 *  TOWBOOK_STATUS_ID_TO_LIFECYCLE — same mapping, reversed; never invented). */
export const LIFECYCLE_TO_TOWBOOK_STATUS_ID: Readonly<Record<string, number>> = {
  // CORRECTED 2026-08-12 (owner-reported sync bug, recon-verified): Towbook
  // statuses are 0 Received, 1 Dispatched, 2 En Route, 3 On Scene, 4 Towing,
  // 5 Complete, 7 Arrived. LD accepted ↔ 1 (Dispatched = a driver is on it),
  // en_route ↔ 2, arrived ↔ 3 (On Scene), completed ↔ 5. LD 'offered' is the
  // assign/offer state — expressed as Dispatched (1) exactly like before.
  new: 0,
  offered: 1,
  accepted: 1,
  en_route: 2,
  arrived: 3,
  completed: 5,
};

/** Predecessor each push would normally fire from (the portal transitions are
 *  all adjacent — accept needs offered, en_route needs accepted, …). Used by
 *  the last-write-wins guard: if Towbook is exactly at the predecessor the PUT
 *  fires; if it is NEWER the push is skipped; if it is older (pull lagged) the
 *  push still fires and any Towbook rejection escalates with evidence. */
const STATUS_PREDECESSOR: Readonly<Record<number, number | null>> = {
  0: 1, // decline: offered → new
  1: 0, // assign/accept: new/offered → dispatched
  2: 1, // en route: dispatched → en route
  3: 2, // arrive: en_route → on scene
  5: 4, // complete: (≤ towing) → completed — never clobbers 252/255 (252>5, 255>5)
};

const configured = () => Boolean(process.env.DATABASE_URL);
let schemaInit: Promise<void> | undefined;
function ensure() {
  if (!configured()) return Promise.resolve();
  schemaInit ??= (async () => {
    const { ensureAuthSchema } = await import("./auth-server");
    await ensureAuthSchema();
    const { ensureSchema } = await import("./migrations");
    await ensureSchema();
  })();
  return schemaInit;
}
const db = () => import("~/db").then((m) => m.sql());

/* ------------------------------ Towbook HTTP ------------------------------ */
/* Tiny local copies of the driver-portal helpers (driver-auth.ts) — this is a
 * server-only module, but copying keeps it dependency-light and test-friendly. */

type TbRes = { ok: boolean; status: number | null; body: unknown };

async function tbFetch(fetchImpl: typeof fetch, url: string, cookie: string, init?: { method?: string; body?: string }): Promise<TbRes> {
  try {
    const res = await fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        accept: "application/json,text/plain,*/*",
        "accept-language": "en-US,en;q=0.9",
        cookie,
        ...(init?.method === "POST" || init?.method === "PUT" ? { "content-type": "application/json" } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
      ...(init?.body ? { body: init.body } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text) { try { body = JSON.parse(text); } catch { /* keep raw text */ } }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
  } catch (err) {
    return { ok: false, status: null, body: String(err).slice(0, 200) };
  }
}

/** True when a response means the session cookie is dead (401/403, or a 200
 *  that is actually the login page HTML — the MVC login form fingerprint). */
const isExpired = (r: TbRes): boolean =>
  r.status === 401 || r.status === 403 ||
  (r.status === 200 && typeof r.body === "string" && /<form/i.test(r.body) && /RequestVerificationToken/i.test(r.body));

/** Numeric status id from a Towbook status field (object {id} / {next} /
 *  plain number / numeric string / single-element array) — mirrors the pull
 *  side's extractTowbookStatusId. */
function extractStatusId(status: unknown): number | null {
  if (status == null) return null;
  if (typeof status === "number") return Number.isFinite(status) ? status : null;
  if (typeof status === "string" && status.trim() !== "") { const n = Number(status); return Number.isFinite(n) ? n : null; }
  if (Array.isArray(status)) return status.length === 1 ? extractStatusId(status[0]) : null;
  if (typeof status === "object") {
    const o = status as Record<string, unknown>;
    const nId = typeof o.id === "number" ? o.id : typeof o.id === "string" && o.id.trim() !== "" ? Number(o.id) : NaN;
    if (Number.isFinite(nId)) return nId;
    const next = o.next && typeof o.next === "object" && !Array.isArray(o.next) ? (o.next as Record<string, unknown>) : null;
    if (next && next.statusId != null) return extractStatusId(next.statusId);
  }
  return null;
}

/* --------------------------------- audit --------------------------------- */

async function recordAudit(orgId: string, actor: StatusPushActor, action: string, jobId: string, detail: Record<string, unknown>): Promise<void> {
  try {
    const q = await db();
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${orgId}, ${actor.id}, ${actor.role}, ${action}, 'job', ${jobId}, ${JSON.stringify(detail)}::jsonb, 'status-push'`;
  } catch { /* audit is best-effort — never mask the outcome */ }
}

/** Escalation into the decision ledger — the ops "Needs attention" banner
 *  (ops/active.tsx + owner queue) reads ai_dispatcher_decisions with
 *  escalated=TRUE. Fixed dedupe key per (job, target status) so the same
 *  failure never spams. */
async function recordEscalation(orgId: string, jobId: string, towbookJobId: string | null, toStatus: number, reason: string, evidence: Record<string, unknown>): Promise<void> {
  try {
    const q = await db();
    await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response)
      VALUES(gen_random_uuid()::text, ${orgId}, ${`status-push-${jobId}-${toStatus}`}, ${towbookJobId}, 'escalated_status_push_failed', TRUE, NULL, NULL, NULL, NULL, ${reason}, ${JSON.stringify(evidence)}::jsonb)
      ON CONFLICT DO NOTHING`;
  } catch { /* never mask the outcome */ }
}

/* ------------------------------- owner session ------------------------------ */

async function loadOwnerSession(orgId: string): Promise<{ cookie: string; baseUrl: string } | null> {
  try {
    const q = await db();
    const sess = await q`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${orgId} AND session_kind='owner'`;
    if (!sess.length || String(sess[0].status) !== "connected" || !String(sess[0].encrypted_session || "").length) return null;
    const { decryptSession } = await import("./towbook-key");
    const plain = await decryptSession(String(sess[0].encrypted_session));
    const parsed = JSON.parse(plain) as { cookies?: string; baseUrl?: string };
    return { cookie: parsed.cookies || "", baseUrl: parsed.baseUrl || "https://app.towbook.com" };
  } catch {
    return null;
  }
}

/* --------------------------------- pipeline --------------------------------- */

export type StatusPushInput = {
  /** dispatch_jobs.id (NOT the Towbook call id — the job is looked up fresh). */
  jobId: string;
  orgId: string;
  actor: StatusPushActor;
  opts?: { fetchImpl?: typeof fetch };
};

/**
 * Push the CURRENT dispatch_jobs status of a job to Towbook. Called by the
 * owner/dispatcher server fns (assignJob / advanceJob / declineJob) right
 * after their local transition commits. Never throws; every failure path is a
 * clean skip or an escalation + audit.
 */
export async function pushJobStatusToTowbook(input: StatusPushInput): Promise<StatusPushResult> {
  const v = z.object({ jobId: z.string().min(1).max(128), orgId: z.string().min(1).max(128) }).safeParse({ jobId: input.jobId, orgId: input.orgId });
  if (!v.success) return { ok: false, code: "error", message: "Invalid push input.", escalated: false };
  const { orgId, jobId } = v.data;
  const actor = input.actor;
  const fetchImpl = input.opts?.fetchImpl ?? fetch;
  try {
    await ensure();
    const q = await db();

    // (1) Fresh re-read — the race guard. The push always targets the CURRENT
    //     dispatch_jobs status; a newer imported status wins by construction.
    const rows = await q`SELECT status, towbook_job_id, towbook_status FROM dispatch_jobs WHERE id=${jobId} AND org_id=${orgId}`;
    if (!rows.length) return { ok: false, code: "not_found", message: "Job not found.", escalated: false };
    const status = String(rows[0].status ?? "");
    const towbookJobId = rows[0].towbook_job_id != null && String(rows[0].towbook_job_id) !== "" ? String(rows[0].towbook_job_id) : null;
    const toStatus = LIFECYCLE_TO_TOWBOOK_STATUS_ID[status];

    // Unpushable: platform-only job (no Towbook counterpart) or a status
    // Towbook cannot take (cancelled is import-only; 252/255 are Towbook-side).
    if (towbookJobId == null || toStatus == null) {
      await recordAudit(orgId, actor, "status_push_skipped", jobId, {
        towbookJobId, status, reason: towbookJobId == null ? "no Towbook job id" : `status ${status} is not pushable to Towbook`,
      });
      return { ok: true, changed: false, skipped: true, reason: towbookJobId == null ? "no-towbook-job-id" : "status-not-pushable", statusId: null };
    }

    // (2) Owner session — the same stored session the pull uses.
    const session = await loadOwnerSession(orgId);
    if (!session) {
      await recordAudit(orgId, actor, "status_push_skipped", jobId, { towbookJobId, status, reason: "no connected owner Towbook session" });
      return { ok: true, changed: false, skipped: true, reason: "towbook-not-connected", statusId: null };
    }
    const numericId = Number(towbookJobId);
    const idForBody = Number.isInteger(numericId) && numericId > 0 ? numericId : towbookJobId;
    const attempts: string[] = [];
    const endpoint = `/api/calls/${towbookJobId}`;
    // One durable key per logical lifecycle transition. A rollback followed by
    // retry deliberately reuses the same ledger row; a later transition gets a
    // different key. The request hash protects the key from accidental reuse.
    const requestKey = `status:${orgId}:${jobId}:${status}:${toStatus}`;
    const requestHash = `${endpoint}|${JSON.stringify({ id: idForBody, status: { id: toStatus } })}`;
    const ledger = async (state: "pending" | "success" | "failed", summary: string) => {
      try {
        await q`INSERT INTO outbound_write_ledger(id,org_id,job_id,request_key,endpoint,request_hash,status,response_summary,completed_at)
          VALUES(gen_random_uuid()::text,${orgId},${jobId},${requestKey},${endpoint},${requestHash},${state},${summary.slice(0,1000)},${state === "pending" ? null : new Date()})
          ON CONFLICT (request_key) DO UPDATE SET status=EXCLUDED.status,response_summary=EXCLUDED.response_summary,completed_at=EXCLUDED.completed_at`;
      } catch (err) {
        // Idempotency is a safety invariant, not best-effort telemetry. Without
        // a durable ledger row we cannot claim this write is safely tracked.
        throw new Error(`Outbound write ledger unavailable: ${err instanceof Error ? err.message : "database error"}`);
      }
    };

    // (3) GET-first idempotency + last-write-wins predecessor guard.
    const getRes = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls/${towbookJobId}`, session.cookie);
    attempts.push(`GET /api/calls/${towbookJobId} → ${getRes.status ?? "network error"} (${getRes.ok ? "ok" : "failed"})`);
    if (isExpired(getRes)) {
      const reason = "The Towbook session expired while pushing the status — reconnect Towbook in Settings.";
      await recordEscalation(orgId, jobId, towbookJobId, toStatus, reason, { status, attempts });
      await recordAudit(orgId, actor, "status_push_failed", jobId, { towbookJobId, status, toStatus, reason, attempts });
      return { ok: false, code: "session_expired", message: reason, escalated: true };
    }
    const currentId = getRes.ok && getRes.body && typeof getRes.body === "object" ? extractStatusId((getRes.body as Record<string, unknown>).status) : null;
    if (currentId === toStatus) {
      // Already there — reconcile the durable intent before returning. This is
      // the ambiguous-timeout path: the prior PUT may have landed even though
      // its read-back failed. Marking the same request key success makes the
      // retry converge without issuing a second PUT.
      await ledger("success", `reconciled status ${toStatus}`);
      await q`UPDATE dispatch_jobs SET towbook_status=${String(toStatus)} WHERE id=${jobId} AND org_id=${orgId} AND status=${status}`;
      await recordAudit(orgId, actor, "status_push_noop", jobId, { towbookJobId, status, toStatus, reason: "Towbook already reports this status; ledger reconciled" });
      return { ok: true, changed: false, skipped: true, reason: "already-at-status", statusId: toStatus };
    }
    const required = STATUS_PREDECESSOR[toStatus] ?? null;
    if (currentId == null) {
      // Cannot verify the current Towbook status → do not guess or clobber.
      await recordAudit(orgId, actor, "status_push_skipped", jobId, { towbookJobId, status, toStatus, currentId: null, reason: "could not read current Towbook status" });
      return { ok: true, changed: false, skipped: true, reason: "current-status-unreadable", statusId: null };
    }
    if (required != null && currentId > required) {
      // LAST-WRITE-WINS: a NEWER Towbook status (incl. terminal 252/255) won —
      // the portal push defers so it can never clobber it. (required is the
      // transition's normal predecessor, so anything beyond it is a genuinely
      // newer state — a decline (N=0) loses to an accepted job, an arrive (N=4)
      // loses to a completed one, etc.)
      await recordAudit(orgId, actor, "status_push_skipped", jobId, { towbookJobId, status, toStatus, currentId, reason: `Towbook is at ${currentId}, newer than the pushed ${toStatus} — the newer status wins` });
      return { ok: true, changed: false, skipped: true, reason: "newer-status-wins", statusId: currentId };
    }
    // currentId < toStatus → the portal is ahead (the normal adjacent
    // transition when currentId === required, or a lagged pull otherwise). The
    // PUT fires; a non-adjacent jump Towbook rejects escalates with evidence.

    // Durable intent is recorded before the first outbound write. A retry can
    // therefore be reconciled even if the request times out ambiguously.
    await ledger("pending", "write started");
    // (4) PUT with one retry on transient failure, then read-back verify.
    let put = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls/${towbookJobId}`, session.cookie, {
      method: "PUT",
      body: JSON.stringify({ id: idForBody, status: { id: toStatus } }),
    });
    attempts.push(`PUT /api/calls/${towbookJobId} → ${put.status ?? "network error"} (${put.ok ? "ok" : "failed"})`);
    if (!put.ok && !isExpired(put)) {
      const retry = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls/${towbookJobId}`, session.cookie, {
        method: "PUT",
        body: JSON.stringify({ id: idForBody, status: { id: toStatus } }),
      });
      attempts.push(`PUT retry /api/calls/${towbookJobId} → ${retry.status ?? "network error"} (${retry.ok ? "ok" : "failed"})`);
      put = retry;
    }
    if (!put.ok || isExpired(put)) {
      const reason = isExpired(put)
        ? "The Towbook session expired while pushing the status — reconnect Towbook in Settings."
        : `Towbook rejected the status update (HTTP ${put.status ?? "error"}).`;
      await ledger("failed", reason);
      await recordEscalation(orgId, jobId, towbookJobId, toStatus, reason, { status, toStatus, attempts, rawPut: isExpired(put) ? "session expired" : String(put.body ?? "").slice(0, 200) });
      await recordAudit(orgId, actor, "status_push_failed", jobId, { towbookJobId, status, toStatus, reason, attempts });
      return { ok: false, code: isExpired(put) ? "session_expired" : "towbook_failed", message: reason, escalated: true };
    }

    // (5) Verify the write landed (read-back, like completeJobCore).
    const verifyRes = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls/${towbookJobId}`, session.cookie);
    attempts.push(`GET verify → ${verifyRes.status ?? "network error"}`);
    const call = verifyRes.ok && verifyRes.body && typeof verifyRes.body === "object" ? (verifyRes.body as Record<string, unknown>) : null;
    const verifiedId = call ? extractStatusId(call.status) : null;
    if (verifiedId !== toStatus) {
      const reason = `Towbook did not confirm status ${toStatus} after the update (now ${verifiedId ?? "unknown"}).`;
      await ledger("failed", reason);
      await recordEscalation(orgId, jobId, towbookJobId, toStatus, reason, { status, toStatus, attempts, verifiedId: verifiedId ?? null });
      await recordAudit(orgId, actor, "status_push_failed", jobId, { towbookJobId, status, toStatus, reason, attempts, verifiedId: verifiedId ?? null });
      return { ok: false, code: "verify_failed", message: reason, escalated: true };
    }

    // Success: record towbook_status (guarded — a newer import that changed the
    // lifecycle status keeps its own towbook_status) + audit.
    await q`UPDATE dispatch_jobs SET towbook_status=${String(toStatus)} WHERE id=${jobId} AND org_id=${orgId} AND status=${status}`;
    await ledger("success", `verified status ${toStatus}`);
    await recordAudit(orgId, actor, "status_push_verified", jobId, { towbookJobId, status, toStatus, attempts });
    return { ok: true, changed: true, skipped: false, reason: null, statusId: toStatus };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unable to push job status to Towbook.";
    await recordEscalation(orgId, jobId, null, -1, reason, { jobId });
    await recordAudit(orgId, actor, "status_push_failed", jobId, { reason });
    return { ok: false, code: "error", message: reason, escalated: true };
  }
}
