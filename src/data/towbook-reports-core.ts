/** Server-only Towbook CallWorkflow client and payday reconciliation. */
import { randomUUID } from "node:crypto";
import { sql } from "~/db";

export type TowbookReportErrorCode = "credentials_unavailable" | "authentication_failed" | "report_failed" | "invalid_response";
export class TowbookReportError extends Error { constructor(public code: TowbookReportErrorCode, message: string) { super(message); this.name = "TowbookReportError"; } }
export type CallWorkflowRow = Record<string, unknown> & {
  id?: number; callNumber?: number; dispatchEntryId?: number; status?: string;
  driver?: string; driverName?: string; driverId?: number; ownerUserName?: string; ownerUserId?: number;
  completed?: string | null; completionTime?: string | null; invoiceTotal?: number; invoiceNumber?: string;
};
export type ReportWindow = { start: string; end: string; companyId?: number[] };
let tokenCache: { token: string; expiresAt: number } | null = null;
export function resetTowbookReportTokenCacheForTests() { tokenCache = null; }
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
  const username = process.env.TOWBOOK_USERNAME, password = process.env.TOWBOOK_PASSWORD;
  if (!username || !password) throw new TowbookReportError("credentials_unavailable", "Towbook report credentials are unavailable.");
  let r: Response;
  try { r = await fetch(`${endpoint}/authentication`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ username, password }) }); }
  catch { throw new TowbookReportError("authentication_failed", "Towbook authentication could not be reached."); }
  if (!r.ok) throw new TowbookReportError("authentication_failed", `Towbook authentication failed (${r.status}).`);
  const b = await r.json().catch(() => null) as Record<string, unknown> | null;
  const token = typeof b?.token === "string" ? b.token : "";
  if (!/^[A-Za-z0-9]{64}$/.test(token)) throw new TowbookReportError("authentication_failed", "Towbook authentication returned no valid token.");
  const exp = b?.expiresAt ? Date.parse(String(b.expiresAt)) : Date.now() + 50 * 60_000;
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
export type ReconciliationRow = { key: string; driver: string; classification: Classification; payableCents: number; reason?: string };
export type ReconciliationResult = { reportCount: number; payableCount: number; excludedCount: number; unclassifiableCount: number; payableCents: number; rows: ReconciliationRow[]; byDriver: Array<{ driver: string; reportCount: number; payableCount: number; excludedCount: number; unclassifiableCount: number; payableCents: number }>; diagnostics: string[] };
export type DriverActivityAggregate = { name: string; callCount: number; totalInvoice?: number };
export function reconcileDriverActivityCore(aggregates: DriverActivityAggregate[]): ReconciliationResult {
  const rows: ReconciliationRow[] = aggregates.flatMap(a => Array.from({ length: a.callCount }, (_, i) => ({ key: `${a.name}-${i + 1}`, driver: a.name, classification: "unclassifiable" as const, payableCents: 0, reason: "Driver Activity aggregate has no itemized call evidence" })));
  const byDriver = aggregates.map(a => ({ driver: a.name, reportCount: a.callCount, payableCount: 0, excludedCount: 0, unclassifiableCount: a.callCount, payableCents: 0 }));
  return { reportCount: rows.length, payableCount: 0, excludedCount: 0, unclassifiableCount: rows.length, payableCents: 0, rows, byDriver, diagnostics: rows.map(r => `${r.key}: ${r.reason}`) };
}
const s = (v: unknown) => String(v ?? "").toLowerCase();
export function reconcileCallWorkflow(rows: CallWorkflowRow[], jobs: Array<Record<string, unknown>> = []): ReconciliationResult {
  const byKey = new Map(jobs.map(j => [String(j.towbook_job_id ?? j.id ?? ""), j]));
  const out: ReconciliationRow[] = [], diagnostics: string[] = [];
  for (const r of rows) {
    const key = String(r.id ?? r.callNumber ?? r.dispatchEntryId ?? ""); const job = byKey.get(key);
    const status = s(r.status); const finalCancelled = status.includes("cancel") || status === "255";
    const reassigned = status.includes("reassign") || s(job?.reassigned).trim() === "true";
    const invoiceItems = job?.raw_json && typeof job.raw_json === "object" ? (job.raw_json as Record<string, unknown>).invoiceItems : undefined;
    const goa = Array.isArray(invoiceItems) && invoiceItems.some(x => s(typeof x === "object" && x ? (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).description : x).includes("goa"));
    let classification: Classification = "unclassifiable", cents = 0, reason = "";
    if (finalCancelled) { classification = "cancelled"; reason = "final cancelled; $0"; }
    else if (reassigned) { classification = "reassigned"; reason = "reassigned away; $0"; }
    else if (!r.completed && !r.completionTime) reason = "missing authoritative completion timestamp";
    else if (goa) { classification = "goa"; cents = 1000; }
    else if (r.completed || r.completionTime) { classification = "completed"; reason = job ? "matched dispatch job" : "unmatched report call; rate requires review"; if (!job) diagnostics.push(`${key}: report call not found in dispatch_jobs`); }
    if (classification === "unclassifiable") diagnostics.push(`${key}: ${reason}`);
    out.push({ key, driver: String(r.driverName ?? r.driver ?? r.ownerUserName ?? "Unknown"), classification, payableCents: cents, ...(reason ? { reason } : {}) });
  }
  const dm = new Map<string, { reportCount: number; payableCount: number; excludedCount: number; unclassifiableCount: number; payableCents: number }>();
  for (const x of out) { const d = dm.get(x.driver) ?? { reportCount: 0, payableCount: 0, excludedCount: 0, unclassifiableCount: 0, payableCents: 0 }; d.reportCount++; if (x.classification === "completed" || x.classification === "goa") { d.payableCount++; d.payableCents += x.payableCents; } else if (x.classification === "unclassifiable") d.unclassifiableCount++; else d.excludedCount++; dm.set(x.driver, d); }
  return { reportCount: out.length, payableCount: out.filter(x => x.classification === "completed" || x.classification === "goa").length, excludedCount: out.filter(x => x.classification === "cancelled" || x.classification === "reassigned").length, unclassifiableCount: out.filter(x => x.classification === "unclassifiable").length, payableCents: out.reduce((n,x) => n+x.payableCents,0), rows: out, byDriver: [...dm].map(([driver,v]) => ({ driver, ...v })), diagnostics };
}
export async function saveTowbookSnapshot(orgId: string, window: ReportWindow, raw: unknown, source: "server" | "manual-paste" = "server") {
  const q = sql(); const id = randomUUID(); await q`INSERT INTO towbook_report_snapshots(id,org_id,report_type,period_start,period_end,data,source) VALUES(${id},${orgId},'CallWorkflow',${window.start.slice(0,10)},${window.end.slice(0,10)},${raw},${source})`; return id;
}
export async function getReconciliationCore(orgId: string, window: ReportWindow, rows?: CallWorkflowRow[]) {
  const report = rows ? { rows, raw: rows } : await fetchCallWorkflow(window);
  const q = sql(); const jobs = await q`SELECT towbook_job_id,id,raw_json,reassigned FROM dispatch_jobs WHERE org_id=${orgId} AND (towbook_job_id IS NOT NULL OR id IS NOT NULL)`;
  await saveTowbookSnapshot(orgId, window, report.raw);
  return reconcileCallWorkflow(report.rows, jobs as Array<Record<string, unknown>>);
}
