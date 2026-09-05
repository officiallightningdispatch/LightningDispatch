/**
 * SERVER-ONLY stale-active-jobs reconciliation sweep (2026-09-05).
 *
 * Root cause (lead recon — /home/team/shared/stale-active-jobs-recon.md):
 * `GET /api/calls` returns only Towbook's ~35 most-recent calls. When a call
 * ages out of that rolling window while our dispatch_jobs row is still
 * non-terminal (offered/accepted/en_route/arrived), the row freezes at its
 * last-synced non-terminal status forever: `upsertPulledJobs` only updates rows
 * that are PRESENT in the returned list — there is no reconciliation path for a
 * non-terminal LD job whose Towbook call has fallen out of `/api/calls`.
 *
 * This sweep pulls the authoritative Towbook CallWorkflow report for a trailing
 * window and, for every LD dispatch_jobs row that is still non-terminal but whose
 * towbook_job_id appears in the report as terminal (Completed / Cancelled), closes
 * it out to the matching terminal LD status — through the SAME status_events +
 * audit_log write path the normal sync uses (never a bare UPDATE).
 *
 * OWNER RULES honored here (do not weaken):
 *  - The completion instant is Towbook's authoritative `completionTime` — never
 *    the sweep's own clock. A report row that reads "Completed" but carries no
 *    parseable completionTime is surfaced as a diagnostic and left non-terminal;
 *    it is never fabricated.
 *  - Reassigned-away rows are surfaced as a diagnostic and left alone (reassignment
 *    is not a terminal state; there is no LD "reassigned" status, and closing them
 *    would misrepresent the call).
 *  - Idempotent: closing sets the row terminal, so a re-run's non-terminal query
 *    never re-selects it (and the write is guarded on the row still being
 *    non-terminal at write time).
 *
 * This module is imported ONLY by server-side code (background-sync.ts dynamic
 * import, tests, and scripts). It may statically import the server-only exports of
 * ./server and ./towbook-reports-core, but NOTHING client-reachable may import it.
 */
import { sqlWithTimeout } from "~/db";
import { resolveOrgActor, SYNC_TICK_TIMEOUT_MS } from "./server";
import { parseRawTimestamp } from "./busy-bonus-core";
import {
  callWorkflowWindowForPeriod,
  fetchCallWorkflow,
  type CallWorkflowRow,
  type ReportWindow,
} from "./towbook-reports-core";

/** Trailing lookback for the CallWorkflow report (14 days is generous for the
 *  rolling /api/calls window while keeping the report pull bounded). */
export const STALE_SWEEP_LOOKBACK_MS = 14 * 86_400_000;
/** Minimum cadence between background sweep runs per org. */
export const STALE_SWEEP_MIN_INTERVAL_MS = 60 * 60_000;

const s = (v: unknown) => String(v ?? "").toLowerCase();

function rawObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Towbook's authoritative completion instant, taken verbatim from the report
 *  (completionTime preferred, `completed` fallback — both are Towbook-sourced).
 *  Returns the verbatim string plus a normalized ISO for timestamptz writes, or
 *  null when the report carries no parseable completion instant. */
function reportCompletion(r: CallWorkflowRow): { verbatim: string; iso: string } | null {
  for (const v of [r.completionTime, r.completed]) {
    if (typeof v === "string" && v.trim()) {
      const ms = parseRawTimestamp(v);
      if (ms != null) return { verbatim: v.trim(), iso: new Date(ms).toISOString() };
    }
  }
  return null;
}

export type StaleActiveJobsResult = {
  scanned: number;
  closedCompleted: number;
  closedCancelled: number;
  skippedReassigned: number;
  missingCompletionTime: number;
  skippedStillActive: number;
  diagnostics: string[];
  closedJobIds: string[];
  dryRun: boolean;
};

export type StaleSweepActor = { id: string; role: string };

export type ReconcileStaleOptions = {
  actor?: StaleSweepActor;
  /** Skip writes and only report what WOULD be closed (safe prod verification). */
  dryRun?: boolean;
};

const emptyResult = (dryRun: boolean): StaleActiveJobsResult => ({
  scanned: 0,
  closedCompleted: 0,
  closedCancelled: 0,
  skippedReassigned: 0,
  missingCompletionTime: 0,
  skippedStillActive: 0,
  diagnostics: [],
  closedJobIds: [],
  dryRun,
});

/**
 * Core reconciliation: given CallWorkflow report rows for an org, close any
 * non-terminal dispatch_jobs row whose towbook_job_id appears in the report as
 * terminal. Writes go through status_events + audit_log exactly like a normal
 * sync status change.
 */
export async function reconcileStaleActiveJobsCore(
  orgId: string,
  reportRows: CallWorkflowRow[],
  opts: ReconcileStaleOptions = {},
): Promise<StaleActiveJobsResult> {
  const q = sqlWithTimeout(SYNC_TICK_TIMEOUT_MS);
  const actor: StaleSweepActor | null = opts.actor ?? (await resolveOrgActor(orgId));
  if (!actor) throw new Error("No organization member found to attribute the reconciliation to.");
  const actorUser = actor;
  const dryRun = opts.dryRun === true;

  const result = emptyResult(dryRun);

  const staleRows = await q`
    SELECT id, towbook_job_id, status, assigned_driver_towbook_id, assigned_driver_name, manually_reassigned_at, raw_json
    FROM dispatch_jobs
    WHERE org_id=${orgId} AND status IN ('offered','accepted','en_route','arrived') AND towbook_job_id IS NOT NULL`;
  result.scanned = staleRows.length;

  // Report join map mirrors reconcileCallWorkflow's keys: dispatchEntryId is the
  // Towbook global call id (== dispatch_jobs.towbook_job_id), id and callNumber
  // are fallbacks.
  const byKey = new Map<string, CallWorkflowRow>();
  for (const r of reportRows) {
    for (const k of [r.dispatchEntryId, r.id, r.callNumber]) {
      if (k != null && String(k) !== "" && !byKey.has(String(k))) byKey.set(String(k), r);
    }
  }

  for (const row of staleRows as Record<string, unknown>[]) {
    const jobId = String(row.id);
    const tbId = String(row.towbook_job_id ?? "");
    const raw = rawObject(row.raw_json);
    const callNumber = raw?.callNumber != null ? String(raw.callNumber) : "";
    const report = byKey.get(tbId) ?? byKey.get(callNumber) ?? byKey.get(jobId);
    if (!report) continue; // not present in this report window — nothing to reconcile

    const statusText = s(report.status);
    const finalCancelled = statusText.includes("cancel") || statusText === "255";
    const reassigned =
      statusText.includes("reassign") ||
      row.manually_reassigned_at != null ||
      s(raw?.reassigned).trim() === "true";

    if (finalCancelled) {
      const patch = { statusId: "255", status: report.status ?? "Cancelled" };
      const detail = {
        towbookJobId: tbId,
        from: String(row.status),
        to: "cancelled",
        towbookStatus: "255",
        reportStatus: report.status ?? null,
        source: "callworkflow",
      };
      if (dryRun) {
        result.closedCancelled++;
        result.closedJobIds.push(jobId);
        continue;
      }
      await closeJob(q, orgId, actorUser, jobId, tbId, "cancelled", null, "255", patch, detail);
      result.closedCancelled++;
      result.closedJobIds.push(jobId);
      continue;
    }

    if (reassigned) {
      result.skippedReassigned++;
      result.diagnostics.push(`${tbId}: reassigned in CallWorkflow — left non-terminal for review (no LD reassigned terminal state).`);
      continue;
    }

    // A report row that is still non-terminal (accepted/en_route/arrived/…) is
    // owned by the normal sync — nothing to reconcile. Skip silently.
    const completedIntent = /complet/i.test(statusText) || statusText === "5" || statusText === "252";
    if (!completedIntent) {
      result.skippedStillActive++;
      continue;
    }

    // Report shows a completed intent: completionTime is REQUIRED and authoritative.
    const completion = reportCompletion(report);
    if (completion == null) {
      result.missingCompletionTime++;
      result.diagnostics.push(`${tbId}: CallWorkflow reports completed but completionTime is missing/unparseable — left non-terminal (not fabricated).`);
      continue;
    }

    const patch = { completionTime: completion.verbatim, statusId: "5", status: report.status ?? "Completed" };
    const driverId = report.driverId != null ? String(report.driverId) : null;
    const driverName = report.driverName != null ? String(report.driverName) : null;
    const detail = {
      towbookJobId: tbId,
      from: String(row.status),
      to: "completed",
      towbookStatus: "5",
      reportStatus: report.status ?? null,
      completionTime: completion.verbatim,
      driverId,
      driverName,
      source: "callworkflow",
    };
    if (dryRun) {
      result.closedCompleted++;
      result.closedJobIds.push(jobId);
      continue;
    }
    await closeJob(q, orgId, actorUser, jobId, tbId, "completed", completion.iso, "5", patch, detail, driverId, driverName);
    result.closedCompleted++;
    result.closedJobIds.push(jobId);
  }

  return result;
}

type Q = ReturnType<typeof sqlWithTimeout>;

/** Write one terminal transition through status_events + audit_log (the same
 *  ledger path the normal sync uses) as a SINGLE atomic statement. Guarded on
 *  the row still being non-terminal at write time, so concurrent/repeated runs
 *  are a no-op: when no row transitions, `changed` (and therefore both ledger
 *  inserts) produces zero rows. */
async function closeJob(
  q: Q,
  orgId: string,
  actor: StaleSweepActor,
  jobId: string,
  towbookJobId: string,
  target: "completed" | "cancelled",
  completedIso: string | null,
  towbookStatus: string,
  patch: Record<string, unknown>,
  detail: Record<string, unknown>,
  driverId?: string | null,
  driverName?: string | null,
): Promise<void> {
  const note = `stale-active reconciliation from CallWorkflow: ${detail.from ?? "?"} → ${target}`;
  await q`
    WITH current AS (
      SELECT id, status FROM dispatch_jobs
      WHERE id=${jobId} AND org_id=${orgId}
        AND status IN ('offered','accepted','en_route','arrived')
    ),
    changed AS (
      UPDATE dispatch_jobs j
      SET status=${target},
          completed_at = CASE WHEN ${target} = 'completed' THEN ${completedIso}::timestamptz ELSE j.completed_at END,
          towbook_status = ${towbookStatus},
          raw_json = COALESCE(j.raw_json, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
          assigned_driver_towbook_id = COALESCE(${driverId ?? null}, j.assigned_driver_towbook_id),
          assigned_driver_name = COALESCE(${driverName ?? null}, j.assigned_driver_name)
      FROM current c
      WHERE j.id = c.id
      RETURNING j.id, j.org_id, c.status AS old_status, j.status AS new_status
    ),
    evt AS (
      INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
        SELECT gen_random_uuid()::text, org_id, id, old_status, new_status, ${actor.id}, ${actor.role}, ${note}
        FROM changed
        RETURNING job_id
    )
    INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${orgId}, ${actor.id}, ${actor.role}, 'towbook_stale_reconcile', 'job', evt.job_id,
        ${JSON.stringify({ ...detail, towbookJobId })}::jsonb, 'stale-active-jobs-sweep'
      FROM evt`;
}

export type StaleSweepOutcome = {
  ok: boolean;
  message: string;
  result?: StaleActiveJobsResult;
};

/** Full sweep: fetch the CallWorkflow report for a trailing window and reconcile.
 *  Accepts pre-fetched rows (hermetic tests/manual runs) and a dryRun flag. */
export async function runStaleActiveJobsSweep(
  orgId: string,
  opts: { rows?: CallWorkflowRow[]; actor?: StaleSweepActor; window?: ReportWindow; dryRun?: boolean } = {},
): Promise<StaleSweepOutcome> {
  try {
    if (!process.env.DATABASE_URL) return { ok: false, message: "Database mode is not active." };
    const actor = opts.actor ?? (await resolveOrgActor(orgId));
    if (!actor) return { ok: false, message: "No organization member found to attribute the reconciliation to." };
    const window = opts.window ?? callWorkflowWindowForPeriod(new Date(Date.now() - STALE_SWEEP_LOOKBACK_MS), new Date());
    const report = opts.rows ? { rows: opts.rows } : await fetchCallWorkflow(window);
    const result = await reconcileStaleActiveJobsCore(orgId, report.rows, { actor, dryRun: opts.dryRun });
    return { ok: true, message: "Stale-active-jobs sweep complete.", result };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Stale-active-jobs sweep failed." };
  }
}
