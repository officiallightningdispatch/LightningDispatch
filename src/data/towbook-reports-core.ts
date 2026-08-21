/** Server-only Towbook CallWorkflow client and payday reconciliation. */
import { randomUUID } from "node:crypto";
import { sql } from "~/db";
import { readOwnerCreds, type OwnerCreds } from "./towbook-recovery";

export type TowbookReportErrorCode = "credentials_unavailable" | "authentication_failed" | "report_failed" | "invalid_response";
export class TowbookReportError extends Error { constructor(public code: TowbookReportErrorCode, message: string) { super(message); this.name = "TowbookReportError"; } }
export type CallWorkflowRow = Record<string, unknown> & {
  id?: number; callNumber?: number; dispatchEntryId?: number; status?: string;
  driver?: string; driverName?: string; driverId?: number; ownerUserName?: string; ownerUserId?: number;
  completed?: string | null; completionTime?: string | null; invoiceTotal?: number; invoiceNumber?: string;
};
export type ReportWindow = { start: string; end: string; companyId?: number[] };
let tokenCache: { token: string; expiresAt: number } | null = null;
let credentialsReader: () => Promise<OwnerCreds | null> = readOwnerCreds;
export function resetTowbookReportTokenCacheForTests() { tokenCache = null; }
/** Test-only dependency injection; production always uses the stable secret-file reader. */
export function setTowbookReportCredentialsReaderForTests(reader?: () => Promise<OwnerCreds | null>) { credentialsReader = reader ?? readOwnerCreds; }
const endpoint = "https://app.towbook.com/api";
const responseRows = (body: unknown): CallWorkflowRow[] => {
  if (Array.isArray(body)) return body as CallWorkflowRow[];
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.reportData)) return o.reportData as CallWorkflowRow[];
    if (o.data && typeof o.data === "object") return responseRows(o.data);
  }
  throw new TowbookReportError("invalid_response", "Towbook returned no CallWorkflow rows.");
};
async function bearer(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.token;
  const envUsername = process.env.TOWBOOK_USERNAME, envPassword = process.env.TOWBOOK_PASSWORD;
  const stored = (!envUsername || !envPassword) ? await credentialsReader() : null;
  const username = envUsername || stored?.username;
  const password = envPassword || stored?.password;
  if (!username || !password) throw new TowbookReportError("credentials_unavailable", "Towbook report credentials are unavailable.");
  let r: Response;
  try { r = await fetch(`${endpoint}/authentication`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ username, password }) }); }
  catch { throw new TowbookReportError("authentication_failed", "Towbook authentication could not be reached."); }
  if (!r.ok) throw new TowbookReportError("authentication_failed", `Towbook authentication failed (${r.status}).`);
  // Towbook's SPA contract is a plain-text 64-character token body. The JSON
  // report client must not interpret the successful auth response as an object.
  const token = (await r.text().catch(() => "")).trim();
  if (!/^[A-Za-z0-9]{64}$/.test(token)) throw new TowbookReportError("authentication_failed", "Towbook authentication returned no valid token.");
  const expHeader = r.headers.get("x-towbook-token-expires-utc");
  const exp = expHeader ? Date.parse(expHeader) : Date.now() + 50 * 60_000;
  tokenCache = { token, expiresAt: Number.isFinite(exp) ? exp : Date.now() + 50 * 60_000 };
  return token;
}
export async function fetchCallWorkflow(window: ReportWindow): Promise<{ rows: CallWorkflowRow[]; raw: unknown }> {
  const token = await bearer();
  const body = { dateStart: window.start, dateEnd: window.end, companyId: window.companyId ?? [23257], impounds: "0", reportType: "CallWorkflow", version: "2.0" };
  let r: Response;
  try { r = await fetch(`${endpoint}/reports`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", "X-API-Use-UTC": "1", "X-Company": "all" }, body: JSON.stringify(body) }); }
  catch { throw new TowbookReportError("report_failed", "Towbook CallWorkflow request could not be reached."); }
  if (!r.ok) throw new TowbookReportError("report_failed", `Towbook CallWorkflow failed (${r.status}).`);
  const raw = await r.json().catch(() => null); return { rows: responseRows(raw), raw };
}
export type Classification = "completed" | "goa" | "cancelled" | "reassigned" | "unclassifiable";
export type ReconciliationRow = {
  key: string;
  driver: string;
  classification: Classification;
  payableCents: number;
  /** The matched LD dispatch job, when the report row can be itemized. */
  jobId?: string;
  towbookDriverId?: string;
  reason?: string;
};
export type ReconciliationCounts = {
  reportCount: number;
  matchedCount: number;
  matchedPayableCount: number;
  reassignedCount: number;
  unmatchedCount: number;
  unitemizedCount: number;
  /** Compatibility aliases retained for existing reconciliation consumers. */
  payableCount: number;
  excludedCount: number;
  unclassifiableCount: number;
  payableCents: number;
};
export type ReconciliationResult = ReconciliationCounts & {
  rows: ReconciliationRow[];
  byDriver: Array<ReconciliationCounts & { driver: string }>;
  diagnostics: string[];
};
export type DriverActivityAggregate = { name: string; callCount: number; totalInvoice?: number };
const emptyCounts = (): ReconciliationCounts => ({
  reportCount: 0,
  matchedCount: 0,
  matchedPayableCount: 0,
  reassignedCount: 0,
  unmatchedCount: 0,
  unitemizedCount: 0,
  payableCount: 0,
  excludedCount: 0,
  unclassifiableCount: 0,
  payableCents: 0,
});

export function reconcileDriverActivityCore(aggregates: DriverActivityAggregate[]): ReconciliationResult {
  const rows: ReconciliationRow[] = aggregates.flatMap(a => Array.from({ length: a.callCount }, (_, i) => ({ key: `${a.name}-${i + 1}`, driver: a.name, classification: "unclassifiable" as const, payableCents: 0, reason: "Driver Activity aggregate has no itemized call evidence" })));
  const byDriver = aggregates.map(a => ({ ...emptyCounts(), driver: a.name, reportCount: a.callCount, unmatchedCount: a.callCount, unitemizedCount: a.callCount, unclassifiableCount: a.callCount }));
  return { ...emptyCounts(), reportCount: rows.length, unmatchedCount: rows.length, unitemizedCount: rows.length, unclassifiableCount: rows.length, rows, byDriver, diagnostics: rows.map(r => `${r.key}: ${r.reason}`) };
}
const s = (v: unknown) => String(v ?? "").toLowerCase();
export function reconcileCallWorkflow(rows: CallWorkflowRow[], jobs: Array<Record<string, unknown>> = []): ReconciliationResult {
  // CallWorkflow's dispatchEntryId is the Towbook global call id, which is
  // stored in dispatch_jobs.towbook_job_id. Keep id as a compatibility key,
  // then use the legacy callNumber marker only as a final fallback.
  const byKey = new Map<string, Record<string, unknown>>();
  const byCallNumber = new Map<string, Record<string, unknown>>();
  for (const j of jobs) {
    if (j.towbook_job_id != null) byKey.set(String(j.towbook_job_id), j);
    if (j.id != null) byKey.set(String(j.id), j);
    const raw = j.raw_json && typeof j.raw_json === "object" ? j.raw_json as Record<string, unknown> : undefined;
    if (raw?.callNumber != null) byCallNumber.set(String(raw.callNumber), j);
  }
  const out: ReconciliationRow[] = [], diagnostics: string[] = [];
  for (const r of rows) {
    const dispatchEntryKey = r.dispatchEntryId == null ? "" : String(r.dispatchEntryId);
    const idKey = r.id == null ? "" : String(r.id);
    const callNumberKey = r.callNumber == null ? "" : String(r.callNumber);
    const key = dispatchEntryKey || idKey || callNumberKey;
    const job = byKey.get(dispatchEntryKey) ?? byKey.get(idKey) ?? byCallNumber.get(callNumberKey);
    const status = s(r.status); const finalCancelled = status.includes("cancel") || status === "255";
    const raw = job?.raw_json && typeof job.raw_json === "object" ? job.raw_json as Record<string, unknown> : undefined;
    const reassigned = status.includes("reassign") || job?.manually_reassigned_at != null || s(raw?.reassigned).trim() === "true";
    const invoiceItems = raw?.invoiceItems;
    // An unmatched CallWorkflow row can still carry authoritative invoice
    // detail. Prefer the dispatch row when present, but do not lose a GOA
    // classification merely because this call predates LD's first capture.
    const reportInvoiceItems = r.invoiceItems;
    const hasGoaItem = (items: unknown) => Array.isArray(items) && items.some(x => s(typeof x === "object" && x ? (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).description : x).includes("goa"));
    const goa = hasGoaItem(invoiceItems) || hasGoaItem(reportInvoiceItems);
    const driver = String(r.driverName ?? r.driver ?? r.ownerUserName ?? "Unknown");
    const hasCompletion = Boolean(r.completed || r.completionTime);
    let classification: Classification = "unclassifiable", cents = 0, reason = "";
    if (finalCancelled) { classification = "cancelled"; reason = "final cancelled; $0"; }
    else if (reassigned) { classification = "reassigned"; reason = "reassigned away; $0"; }
    else if (!hasCompletion) reason = "missing authoritative completion timestamp";
    else if (!job) {
      // Report membership and completion are authoritative even when the
      // local dispatch ledger has no itemized row (for example, pre-LD work).
      // Keep the unmatched diagnostic, but do not make a real completed call
      // non-payable solely because it cannot be joined to dispatch_jobs.
      classification = goa ? "goa" : "completed";
      cents = goa ? 1000 : 0;
      reason = "unmatched report call; no dispatch job to itemize";
      diagnostics.push(`${key}: ${reason}`);
    }
    else if (goa) { classification = "goa"; cents = 1000; }
    else { classification = "completed"; reason = "matched dispatch job"; }
    if (classification === "unclassifiable" && !diagnostics.some(d => d.startsWith(`${key}:`))) diagnostics.push(`${key}: ${reason}`);
    out.push({
      key,
      driver,
      classification,
      payableCents: cents,
      ...(job?.id != null ? { jobId: String(job.id) } : {}),
      ...(job?.assigned_driver_towbook_id != null ? { towbookDriverId: String(job.assigned_driver_towbook_id) } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  const dm = new Map<string, ReconciliationCounts>();
  for (const x of out) {
    const d = dm.get(x.driver) ?? emptyCounts();
    d.reportCount++;
    if (x.jobId) d.matchedCount++;
    if (x.classification === "completed" || x.classification === "goa") {
      if (x.jobId) d.matchedPayableCount++;
      d.payableCount++;
      d.payableCents += x.payableCents;
    }
    else if (x.classification === "reassigned") { d.reassignedCount++; d.excludedCount++; }
    else if (x.classification === "cancelled") d.excludedCount++;
    else { d.unmatchedCount++; d.unitemizedCount++; d.unclassifiableCount++; }
    dm.set(x.driver, d);
  }
  const matchedCount = out.filter(x => Boolean(x.jobId)).length;
  const matchedPayableCount = out.filter(x => Boolean(x.jobId) && (x.classification === "completed" || x.classification === "goa")).length;
  const reassignedCount = out.filter(x => x.classification === "reassigned").length;
  const unmatchedCount = out.filter(x => x.classification === "unclassifiable").length;
  const excludedCount = out.filter(x => x.classification === "cancelled" || x.classification === "reassigned").length;
  return {
    reportCount: out.length,
    matchedCount,
    matchedPayableCount,
    reassignedCount,
    unmatchedCount,
    unitemizedCount: unmatchedCount,
    payableCount: out.filter(x => x.classification === "completed" || x.classification === "goa").length,
    excludedCount,
    unclassifiableCount: unmatchedCount,
    payableCents: out.reduce((n, x) => n + x.payableCents, 0),
    rows: out,
    byDriver: [...dm].map(([driver, values]) => ({ driver, ...values })),
    diagnostics,
  };
}
export async function saveTowbookSnapshot(orgId: string, window: ReportWindow, raw: unknown, source: "server" | "manual-paste" = "server") {
  const q = sql(); const id = randomUUID(); await q`INSERT INTO towbook_report_snapshots(id,org_id,report_type,period_start,period_end,data,source) VALUES(${id},${orgId},'CallWorkflow',${window.start.slice(0,10)},${window.end.slice(0,10)},${raw},${source})`; return id;
}

/** The CallWorkflow endpoint accepts ET wall-clock dates for a closed payday.
 * The report row set is authoritative; these values are only the request
 * envelope and must never be re-applied as a local SQL membership filter. */
export function callWorkflowWindowForPeriod(startsAt: Date, endsAt: Date): ReportWindow {
  const formatEt = (d: Date) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  return { start: `${formatEt(startsAt)}T00:00:00`, end: `${formatEt(new Date(endsAt.getTime() - 1))}T23:59:59` };
}

/** Load the most recent exact-period server snapshot. It is a fallback when a
 * report rerun cannot be reached; computePaydayCore normally reruns and saves
 * the report first so every payday has a fresh authoritative snapshot. */
export async function loadTowbookSnapshot(orgId: string, window: ReportWindow): Promise<{ rows: CallWorkflowRow[]; raw: unknown } | null> {
  const q = sql();
  const snapshots = await q`SELECT data FROM towbook_report_snapshots
    WHERE org_id=${orgId} AND report_type='CallWorkflow'
      AND period_start=${window.start.slice(0, 10)} AND period_end=${window.end.slice(0, 10)}
    ORDER BY created_at DESC LIMIT 1`;
  if (!snapshots.length) return null;
  const raw = (snapshots[0] as Record<string, unknown>).data;
  try { return { rows: responseRows(raw), raw }; } catch { return null; }
}

export async function getReconciliationCore(orgId: string, window: ReportWindow, rows?: CallWorkflowRow[]) {
  const report = rows ? { rows, raw: rows } : await fetchCallWorkflow(window);
  const q = sql(); const jobs = await q`SELECT towbook_job_id,id,raw_json,manually_reassigned_at FROM dispatch_jobs WHERE org_id=${orgId} AND (towbook_job_id IS NOT NULL OR id IS NOT NULL)`;
  await saveTowbookSnapshot(orgId, window, report.raw);
  return reconcileCallWorkflow(report.rows, jobs as Array<Record<string, unknown>>);
}
