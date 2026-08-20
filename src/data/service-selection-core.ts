/** Persistent contractor service capabilities — server-only core. */
import { z } from "zod";
import { sql } from "~/db";
import { normalizeServiceSelectionType, SERVICE_SELECTION_SERVICE_TYPES, SERVICE_SELECTION_LABELS } from "./service-time-core";

const configured = () => Boolean(process.env.DATABASE_URL);
let schemaInit: Promise<void> | undefined;
async function ensure() {
  if (!configured()) return;
  schemaInit ??= (async () => { const { ensureAuthSchema } = await import("./auth-server"); await ensureAuthSchema(); const { ensureSchema } = await import("./migrations"); await ensureSchema(); })();
  await schemaInit;
}
const db = () => sql();
export type ServiceSelectionActor = { orgId: string; id: string; role: string; contractorId?: string; driverIdentity?: { userRowId: string; deactivated: boolean } | null };
export type ServiceSelectionRow = { contractorId: string; contractorName: string; selectedServices: string[]; updatedAt: string | null; updatedBy: "owner" | "contractor" | "seed" | null };
export type ServiceSelectionResult<T> = { ok: true; data: T } | { ok: false; code: "unauthorized" | "invalid_input" | "not_found" | "database_error"; message: string };
const ok = <T>(data: T): ServiceSelectionResult<T> => ({ ok: true, data });
type ServiceSelectionErrorCode = "unauthorized" | "invalid_input" | "not_found" | "database_error";
const err = (code: ServiceSelectionErrorCode, message: string): ServiceSelectionResult<never> => ({ ok: false, code, message });
const owner = (a: ServiceSelectionActor) => a.role === "owner" || a.role === "admin";
const normalize = (values: unknown): string[] => [...new Set((Array.isArray(values) ? values : []).map((x) => normalizeServiceSelectionType(typeof x === "string" ? x : null)).filter((x): x is string => Boolean(x)))].sort();
const mapRow = (r: Record<string, unknown>): ServiceSelectionRow => ({ contractorId: String(r.contractor_id), contractorName: String(r.contractor_name ?? ""), selectedServices: Array.isArray(r.selected_services) ? r.selected_services.map(String) : [], updatedAt: r.updated_at == null ? null : new Date(String(r.updated_at)).toISOString(), updatedBy: r.updated_by === "owner" || r.updated_by === "contractor" || r.updated_by === "seed" ? r.updated_by : null });

export function canonicalServiceSelectionTypes(): string[] { return [...SERVICE_SELECTION_SERVICE_TYPES]; }
export function normalizeSelectedServices(values: unknown): string[] { return normalize(values); }

async function readOne(orgId: string, contractorId: string): Promise<ServiceSelectionRow | null> {
  const rows = await db()`SELECT u.id AS contractor_id,u.name AS contractor_name,COALESCE(array_agg(s.service_type ORDER BY s.service_type) FILTER (WHERE s.service_type IS NOT NULL),'{}') AS selected_services,MAX(s.updated_at) AS updated_at,(array_agg(s.updated_by ORDER BY s.updated_at DESC) FILTER (WHERE s.updated_by IS NOT NULL))[1] AS updated_by FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${orgId} AND m.role='contractor' LEFT JOIN contractor_services s ON s.org_id=${orgId} AND s.contractor_id=u.id WHERE u.id=${contractorId} GROUP BY u.id,u.name LIMIT 1`;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}
export async function getMyServicesCore(actor: ServiceSelectionActor): Promise<ServiceSelectionResult<{ services: ServiceSelectionRow; options: { key: string; label: string }[] }>> {
  if (!actor || (actor.role !== "contractor" && !actor.driverIdentity?.userRowId)) return err("unauthorized", "Contractor access required.");
  try { await ensure(); const id = actor.role === "contractor" ? actor.id : actor.driverIdentity!.userRowId; const row = await readOne(actor.orgId, id); return row ? ok({ services: row, options: SERVICE_SELECTION_SERVICE_TYPES.map((key) => ({ key, label: SERVICE_SELECTION_LABELS[key] ?? key })) }) : err("not_found", "Contractor account not found."); } catch (e) { return err("database_error", e instanceof Error ? e.message : "Unable to load services."); }
}
export async function setMyServicesCore(actor: ServiceSelectionActor, data: unknown): Promise<ServiceSelectionResult<ServiceSelectionRow>> {
  if (!actor || (actor.role !== "contractor" && !actor.driverIdentity?.userRowId)) return err("unauthorized", "Contractor access required.");
  const parsed = z.object({ services: z.array(z.string()).max(30) }).safeParse(data); if (!parsed.success) return err("invalid_input", "Choose valid services.");
  try { await ensure(); const id = actor.role === "contractor" ? actor.id : actor.driverIdentity!.userRowId; const values = normalize(parsed.data.services); const q = db(); const statements = [q`DELETE FROM contractor_services WHERE org_id=${actor.orgId} AND contractor_id=${id}`, ...values.map((service) => q`INSERT INTO contractor_services(id,org_id,contractor_id,service_type,updated_by) VALUES(gen_random_uuid()::text,${actor.orgId},${id},${service},'contractor')`), q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) VALUES(gen_random_uuid()::text,${actor.orgId},${actor.id},${actor.role},'contractor_services_updated','contractor',${id},${JSON.stringify({ services: values })}::jsonb)`]; await q.transaction(statements); const row = await readOne(actor.orgId, id); return row ? ok(row) : err("not_found", "Contractor account not found."); } catch (e) { return err("database_error", e instanceof Error ? e.message : "Unable to save services."); }
}
export async function listContractorServicesCore(actor: ServiceSelectionActor): Promise<ServiceSelectionResult<ServiceSelectionRow[]>> {
  if (!owner(actor)) return err("unauthorized", "Owner access required.");
  try { await ensure(); const rows = await db()`SELECT u.id AS contractor_id,u.name AS contractor_name,COALESCE(array_agg(s.service_type ORDER BY s.service_type) FILTER (WHERE s.service_type IS NOT NULL),'{}') AS selected_services,MAX(s.updated_at) AS updated_at,(array_agg(s.updated_by ORDER BY s.updated_at DESC) FILTER (WHERE s.updated_by IS NOT NULL))[1] AS updated_by FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${actor.orgId} AND m.role='contractor' LEFT JOIN contractor_services s ON s.org_id=${actor.orgId} AND s.contractor_id=u.id WHERE u.deactivated_at IS NULL GROUP BY u.id,u.name ORDER BY LOWER(u.name)`; return ok(rows.map((r) => mapRow(r as Record<string, unknown>))); } catch (e) { return err("database_error", e instanceof Error ? e.message : "Unable to load contractor services."); }
}
export async function setContractorServicesCore(actor: ServiceSelectionActor, data: unknown): Promise<ServiceSelectionResult<ServiceSelectionRow>> {
  if (!owner(actor)) return err("unauthorized", "Owner access required."); const parsed = z.object({ contractorId: z.string().min(1), services: z.array(z.string()).max(30) }).safeParse(data); if (!parsed.success) return err("invalid_input", "Choose valid services.");
  try { await ensure(); const values = normalize(parsed.data.services); const q = db(); const exists = await q`SELECT 1 FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${actor.orgId} AND m.role='contractor' WHERE u.id=${parsed.data.contractorId} AND u.deactivated_at IS NULL`; if (!exists.length) return err("not_found", "Contractor not found."); const statements = [q`DELETE FROM contractor_services WHERE org_id=${actor.orgId} AND contractor_id=${parsed.data.contractorId}`, ...values.map((service) => q`INSERT INTO contractor_services(id,org_id,contractor_id,service_type,updated_by) VALUES(gen_random_uuid()::text,${actor.orgId},${parsed.data.contractorId},${service},'owner')`), q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) VALUES(gen_random_uuid()::text,${actor.orgId},${actor.id},${actor.role},'owner_contractor_services_updated','contractor',${parsed.data.contractorId},${JSON.stringify({ services: values })}::jsonb)`]; await q.transaction(statements); const row = await readOne(actor.orgId, parsed.data.contractorId); return row ? ok(row) : err("not_found", "Contractor not found."); } catch (e) { return err("database_error", e instanceof Error ? e.message : "Unable to save services."); }
}
export async function bulkSetContractorServicesCore(actor: ServiceSelectionActor, data: unknown): Promise<ServiceSelectionResult<{ updated: number }>> {
  if (!owner(actor)) return err("unauthorized", "Owner access required."); const parsed = z.object({ contractorIds: z.array(z.string()).min(1).max(500), services: z.array(z.string()).max(30) }).safeParse(data); if (!parsed.success) return err("invalid_input", "Select at least one contractor and valid services.");
  try { await ensure(); const ids = [...new Set(parsed.data.contractorIds)]; const values = normalize(parsed.data.services); const q = db(); const valid = await q`SELECT u.id FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${actor.orgId} AND m.role='contractor' WHERE u.id = ANY(${ids}) AND u.deactivated_at IS NULL`; if (valid.length !== ids.length) return err("not_found", "One or more contractors are unavailable."); const statements = [q`DELETE FROM contractor_services WHERE org_id=${actor.orgId} AND contractor_id = ANY(${ids})`, ...ids.flatMap((id) => values.map((service) => q`INSERT INTO contractor_services(id,org_id,contractor_id,service_type,updated_by) VALUES(gen_random_uuid()::text,${actor.orgId},${id},${service},'owner')`)), q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) VALUES(gen_random_uuid()::text,${actor.orgId},${actor.id},${actor.role},'owner_bulk_contractor_services_updated', 'contractor',${actor.orgId},${JSON.stringify({ contractorIds: ids, services: values })}::jsonb)`]; await q.transaction(statements); return ok({ updated: ids.length }); } catch (e) { return err("database_error", e instanceof Error ? e.message : "Unable to save services."); }
}

async function actor(): Promise<ServiceSelectionActor | null> { if (!configured()) return null; const { currentUser } = await import("./auth-server"); const u = await currentUser(); return u ? { orgId: u.orgId, id: u.id, role: u.role, contractorId: u.contractorId, driverIdentity: u.driverIdentity } : null; }
export async function getMyServicesHandler() { const a = await actor(); return a ? getMyServicesCore(a) : err("unauthorized", "Sign in required."); }
export async function setMyServicesHandler(data: unknown) { const a = await actor(); return a ? setMyServicesCore(a, data) : err("unauthorized", "Sign in required."); }
export async function listContractorServicesHandler() { const a = await actor(); return a ? listContractorServicesCore(a) : err("unauthorized", "Sign in required."); }
export async function setContractorServicesHandler(data: unknown) { const a = await actor(); return a ? setContractorServicesCore(a, data) : err("unauthorized", "Sign in required."); }
export async function bulkSetContractorServicesHandler(data: unknown) { const a = await actor(); return a ? bulkSetContractorServicesCore(a, data) : err("unauthorized", "Sign in required."); }
