import { canonicalizeBatteryGroup, canonicalizeMake, canonicalizeModel, canonicalizeNullableVehicleField } from "./battery-compatibility-canonical";
import { validateCompatibilityRows, type CompatibilityPayload } from "./compat-validation";
import { decodeVin } from "./battery-sales-core";

import { isAssignedDriver, resolveJob } from "./driver-photos-core";
const db = () => import("~/db").then((m) => m.sql());
const roles = new Set(["owner", "admin", "dispatcher", "contractor"]);
export type CompatibilityLookupResult =
  | { ok: true; outcome: "matched"; match: { compatibilityId: string; make: string; model: string; year: number; batteryGroupSize: string; displayBatteryGroup: string } }
  | { ok: true; outcome: "review"; reason: "not_found" | "ambiguous" | "conflict" | "incomplete_vehicle" | "unsupported_group" | "decode_failed"; message: string; vehicle: { make: string | null; model: string | null; year: number | null } }
  | { ok: false; reason: "unauthorized" | "invalid_input" };
const review = (reason: Exclude<Extract<CompatibilityLookupResult, { outcome: "review" }>['reason'], 'decode_failed'>, make: string | null, model: string | null, year: number | null): CompatibilityLookupResult => ({ ok: true, outcome: 'review', reason, message: 'Battery fitment requires dispatcher or owner review.', vehicle: { make, model, year } });

/** Decode VIN identity, then use exactly the manual canonical lookup path. The VIN
 * itself is deliberately never forwarded to the lookup, DTO, log, or error. */
export async function lookupBatteryCompatibilityFromVinCore(
  user: { orgId: string; role: string; id?: string; towbookDriverId?: string } | null,
  input: unknown,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CompatibilityLookupResult> {
  if (!user || !roles.has(user.role)) return { ok: false, reason: 'unauthorized' };
  if (!input || typeof input !== 'object' || typeof (input as Record<string, unknown>).vin !== 'string') return { ok: false, reason: 'invalid_input' };
  const decoded = await decodeVin((input as Record<string, unknown>).vin as string, fetchImpl);
  if (!decoded.ok) return { ok: true, outcome: 'review', reason: 'decode_failed', message: 'We could not safely decode this vehicle. Dispatcher review is required.', vehicle: { make: null, model: null, year: null } };
  const result = await lookupBatteryCompatibilityCore(user, { ...decoded, jobId: (input as Record<string, unknown>).jobId ?? null });
  if (result.ok && result.outcome === 'review' && result.reason === 'incomplete_vehicle') return { ...result, reason: 'incomplete_vehicle' };
  return result;
}
export async function lookupBatteryCompatibilityCore(user: { orgId: string; role: string; id?: string; towbookDriverId?: string } | null, input: unknown): Promise<CompatibilityLookupResult> {
  if (!user || !roles.has(user.role)) return { ok: false, reason: "unauthorized" };
  if (!input || typeof input !== "object") return { ok: false, reason: "invalid_input" };
  const x = input as Record<string, unknown>;
  // Contractor fitment lookups are only meaningful inside an assigned job.
  // Reuse the same assignment rails as photos/job detail: contractor link,
  // authoritative Towbook driver id, then raw Towbook assets fallback.
  if (user.role === "contractor") {
    if (!user.id || typeof x.jobId !== "string" || !x.jobId.trim()) return { ok: false, reason: "unauthorized" };
    const job = await resolveJob(user.orgId, x.jobId);
    if (!job || !(await isAssignedDriver(user.orgId, user.id, user.towbookDriverId ?? "", job))) return { ok: false, reason: "unauthorized" };
  }
  const m = canonicalizeMake(x.make); const mo = canonicalizeModel(x.model); const y = Number(x.year);
  if (!m.ok || !mo.ok || !Number.isInteger(y) || y < 1886 || y > 9999) return { ok: false, reason: "invalid_input" };
  const g = x.batteryGroupSize == null || x.batteryGroupSize === "" ? null : canonicalizeBatteryGroup(x.batteryGroupSize);
  if (g && !g.ok) return review("unsupported_group", m.value, mo.value, y);
  const trim = canonicalizeNullableVehicleField(x.trim); const engine = canonicalizeNullableVehicleField(x.engine); const q = await db();
  const rows = await q`SELECT c.id,c.make,c.model,c.trim,c.engine,c.battery_group_size FROM battery_compatibility c JOIN battery_products p ON p.org_id=c.org_id AND p.group_size=c.battery_group_size AND p.active=true WHERE c.org_id=${user.orgId} AND c.status='approved' AND c.make=${m.value} AND c.model=${mo.value} AND c.year_from<=${y} AND c.year_to>=${y}`;
  const eligible = rows.filter((r: any) => (r.trim === null && r.engine === null) || (trim !== null && r.trim === trim) || (engine !== null && r.engine === engine));
  if (!eligible.length) return review(trim === null && engine === null && rows.length ? "incomplete_vehicle" : "not_found", m.value, mo.value, y);
  if (eligible.length > 1) return review(new Set(eligible.map((r: any) => r.battery_group_size)).size > 1 ? "conflict" : "ambiguous", m.value, mo.value, y);
  const r = eligible[0]; const group = String(r.battery_group_size);
  return { ok: true, outcome: "matched", match: { compatibilityId: String(r.id), make: String(r.make), model: String(r.model), year: y, batteryGroupSize: group, displayBatteryGroup: group } };
}
export async function previewBatteryCompatibilityImportCore(payload: unknown) {
  const rows = Array.isArray(payload) ? payload : (payload && typeof payload === "object" && Array.isArray((payload as any).rows) ? (payload as any).rows : null);
  if (!rows) return { ok: false as const, reason: "invalid_input" as const, rejectedRows: [], reviewRows: [], issues: [] };
  const result = validateCompatibilityRows(rows); const rejectedRows = [...result.rejectedRows]; const reviewRows = [...result.reviewRows];
  for (const issue of result.issues) { const row = rows[issue.row]; if (row && !rejectedRows.includes(row)) rejectedRows.push(row as CompatibilityPayload); }
  return { ok: true as const, rejectedRows, reviewRows, issues: result.issues, normalized: result.normalized };
}
const owner = (u: { role: string }) => u.role === "owner" || u.role === "admin";
export async function applyBatteryCompatibilityImportCore(user: { orgId: string; id: string; role: string }, payload: unknown) {
  if (!owner(user)) return { ok: false as const, reason: "unauthorized" as const };
  const preview = await previewBatteryCompatibilityImportCore(payload); if (!preview.ok || preview.issues.length) return { ok: false as const, reason: "invalid_input" as const, issues: preview.ok ? preview.issues : [] };
  const q = await db(); const statements = preview.normalized.map((r) => q`INSERT INTO battery_compatibility(id,org_id,make,model,year_from,year_to,trim,engine,battery_group_size,source_reference_internal,status) SELECT gen_random_uuid()::text,${user.orgId},${r.make},${r.model},${r.year_from},${r.year_to},${r.trim},${r.engine},${r.battery_group_size},${r.source_reference_internal},${r.status} WHERE EXISTS (SELECT 1 FROM battery_products WHERE org_id=${user.orgId} AND group_size=${r.battery_group_size}) ON CONFLICT (org_id,lower(make),lower(model),year_from,year_to,battery_group_size,lower(COALESCE(trim,'')),lower(COALESCE(engine,''))) DO UPDATE SET source_reference_internal=EXCLUDED.source_reference_internal,status=EXCLUDED.status,updated_at=NOW()`);
  if (statements.length) await q.transaction(statements);
  await q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) VALUES(gen_random_uuid()::text,${user.orgId},${user.id},${user.role},'battery_compatibility_import','battery_compatibility',${user.orgId},${JSON.stringify({rows: preview.normalized.length})})`;
  return { ok: true as const, applied: preview.normalized.length };
}
export async function listBatteryCompatibilityReviewRowsCore(user: { orgId: string; role: string }) {
  if (!owner(user)) return { ok: false as const, reason: "unauthorized" as const, rows: [] };
  const q = await db(); const rows = await q`SELECT id,make,model,year_from,year_to,trim,engine,battery_group_size,status,source_reference_internal FROM battery_compatibility WHERE org_id=${user.orgId} AND status='review' ORDER BY created_at DESC`;
  return { ok: true as const, rows: rows.map((r: any) => ({ id: String(r.id), make: String(r.make), model: String(r.model), yearFrom: Number(r.year_from), yearTo: Number(r.year_to), trim: r.trim == null ? null : String(r.trim), engine: r.engine == null ? null : String(r.engine), batteryGroupSize: String(r.battery_group_size), status: String(r.status), sourceReferenceInternal: r.source_reference_internal == null ? null : String(r.source_reference_internal) })) };
}
export async function decideBatteryCompatibilityReviewCore(user: { orgId: string; id: string; role: string }, input: unknown) {
  if (!owner(user)) return { ok: false as const, reason: "unauthorized" as const };
  if (!input || typeof input !== "object") return { ok: false as const, reason: "invalid_input" as const }; const x = input as any;
  if (!["approve", "reject"].includes(x.decision) || typeof x.compatibilityId !== "string") return { ok: false as const, reason: "invalid_input" as const };
  const q = await db(); const rows = await q`SELECT id,make,model,year_from,year_to,trim,engine,battery_group_size,source_reference_internal,status FROM battery_compatibility WHERE id=${x.compatibilityId} AND org_id=${user.orgId} LIMIT 1`; if (!rows.length) return { ok: false as const, reason: "not_found" as const };
  if (x.decision === "reject" && !(typeof x.reason === "string" && x.reason.trim())) return { ok: false as const, reason: "reason_required" as const };
  if (x.decision === "approve") { const r = rows[0] as any; if (!r.source_reference_internal) return { ok: false as const, reason: "provenance_required" as const }; const product = await q`SELECT id FROM battery_products WHERE org_id=${user.orgId} AND group_size=${r.battery_group_size} LIMIT 1`; if (!product.length) return { ok: false as const, reason: "product_required" as const }; const conflict = await q`SELECT id FROM battery_compatibility WHERE org_id=${user.orgId} AND status='approved' AND id<>${x.compatibilityId} AND make=${r.make} AND model=${r.model} AND year_from<=${r.year_to} AND year_to>=${r.year_from} AND battery_group_size<>${r.battery_group_size} LIMIT 1`; if (conflict.length) return { ok: false as const, reason: "conflict" as const }; }
  const status = x.decision === "approve" ? "approved" : "rejected"; await q.transaction([q`UPDATE battery_compatibility SET status=${status},updated_at=NOW() WHERE id=${x.compatibilityId} AND org_id=${user.orgId}`, q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) VALUES(gen_random_uuid()::text,${user.orgId},${user.id},${user.role},${"battery_compatibility_" + x.decision},'battery_compatibility',${x.compatibilityId},${JSON.stringify({ reason: x.reason ?? null })})`]); return { ok: true as const, status };
}
