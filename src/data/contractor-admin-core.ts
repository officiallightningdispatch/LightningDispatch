/**
 * Contractor administration (owner-directed 2026-08-11, plan rev 17, part 1/3) —
 * SERVER-ONLY core.
 *
 * Three layered capabilities on the owner Contractors surface:
 *   1. Org-level REQUIRED DOCUMENT TYPES (W-9, license, insurance cert, …) the
 *      owner defines — add/rename/reorder/toggle/soft-delete (active=FALSE;
 *      never a hard delete — contractor_documents rows reference these ids and
 *      files exist in B2).
 *   2. PER-CONTRACTOR DOCUMENTS — ONE current file per (contractor, type);
 *      status is derived at READ time (single source of truth):
 *        MISSING   — no contractor_documents row for that (contractor, type)
 *        UPLOADED  — row exists, stored status 'uploaded' (awaiting review)
 *        VERIFIED  — stored status 'verified' (owner-approved)
 *        EXPIRED   — stored 'expired' OR expires_on < today (DATE WINS: the
 *                    reader promotes regardless of the stored status)
 *        REJECTED  — stored 'rejected' (owner asked for a re-upload;
 *                    review_note is shown to the contractor)
 *   3. PAYRATE — contractor_profiles.payrate_cents per completed job (NULL =
 *      unset), drives future payday math (payrate × completed jobs + tips).
 *
 * Access: owner/admin for everything except the contractor-own reads/upload
 * (getMyDocuments / uploadMyDocument are session-scoped to the acting
 * contractor; getDocumentFile rejects cross-contractor reads with 403).
 * Every mutation writes an audit_log row (best-effort, never masks the
 * outcome): contractor_payrate_set, contractor_doc_uploaded,
 * contractor_doc_verified / _rejected / _expired, contractor_doc_type_added /
 * _renamed / _removed / _toggled / _reordered, contractor_doc_expiry_set.
 *
 * Storage: files live in Backblaze B2 under the ld-docs/<org>/<driverId>/
 * <docTypeId>.<ext> prefix (a PDF-allowing allowlist — decodeDocumentDataUrl
 * accepts image/jpeg|png|webp|application/pdf; photos stay image-only in
 * driver-photos-core). The driver upload UI is part 3; the core + B2 path are
 * implemented and hermetic-tested here (mock fetchImpl + stableDir fixtures).
 *
 * Testability (same split as contractor-management-core / driver-photos-core):
 * every handler is a thin auth wrapper over a `*Core` function that takes an
 * explicit actor — hermetic tests call the cores directly with mock B2
 * fetches and real Neon QA orgs (zero rows left after).
 *
 * Imported ONLY by the client-safe facade (src/data/contractor-admin.ts, whose
 * createServerFn handlers dynamic-import this module) and by hermetic tests.
 * Static server imports are fine here — this module never enters the client
 * bundle graph (node:crypto lives in b2-client.ts).
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { loadB2Config, authorizeAccount, putObject, getObject } from "./b2-client";

/* --------------------------------- helpers --------------------------------- */

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

/** The actor context every core takes (mirrors the AuthUser subset we need). */
export type ContractorAdminActor = { orgId: string; id: string; role: string };
const OWNER_ROLES = ["owner", "admin"];
const canManage = (a: ContractorAdminActor) => OWNER_ROLES.includes(a.role);

/** Every row that crosses to the client is seroval-safe: null, never undefined. */
export type ContractorAdminErrorCode = "unauthorized" | "invalid_input" | "duplicate" | "not_found" | "b2_not_configured" | "b2_failed" | "database_error";
export type ContractorAdminResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ContractorAdminErrorCode; message: string };

const err = (code: ContractorAdminErrorCode, message: string) => ({ ok: false as const, code, message });
const ok = <T>(data: T): ContractorAdminResult<T> => ({ ok: true, data });

/* ----------------------------------- types ----------------------------------- */

export type DocTypeRow = {
  id: string;
  name: string;
  requiresExpiry: boolean;
  sortOrder: number;
  active: boolean;
  createdAt: string;
};

export type DocStatus = "missing" | "uploaded" | "verified" | "expired" | "rejected";
export const DOC_STATUSES = ["missing", "uploaded", "verified", "expired", "rejected"] as const;

/** One required type + the contractor's CURRENT file row (or null = MISSING),
 *  with the READ-TIME derived status. Seroval-safe. */
export type ContractorDocumentRow = {
  docTypeId: string;
  docTypeName: string;
  requiresExpiry: boolean;
  status: DocStatus;
  docId: string | null;
  fileName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  expiresOn: string | null; // YYYY-MM-DD
  reviewNote: string | null;
  uploadedAt: string | null;
  uploadedByUserId: string | null;
};

export type DocFilePayload = { base64: string; mime: string; fileName: string | null; sizeBytes: number };

/** Per-contractor compliance counts for the roster / strip. onFile = active
 *  required types with a file whose derived status is UPLOADED or VERIFIED
 *  (a file that is present AND not expired/rejected). Seroval-safe. */
export type ContractorComplianceRow = {
  contractorId: string;
  name: string;
  requiredDocCount: number;
  onFileDocCount: number;
};

/* --------------------------- derived status (read time) --------------------------- */

const todayStr = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

/** DATE columns come back as JS Dates (UTC midnight) or strings depending on
 *  the driver — always render YYYY-MM-DD so deriveDocStatus's lexicographic
 *  comparison and the client both see a canonical date. */
function formatYmd(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[0];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** The single source of truth for document status. DATE WINS: expires_on <
 *  today promotes ANY stored status to EXPIRED (a verified-but-lapsed license
 *  is expired, full stop); otherwise the stored status maps directly. */
export function deriveDocStatus(storedStatus: string | null | undefined, expiresOn: string | null | undefined): DocStatus {
  if (expiresOn && expiresOn < todayStr()) return "expired";
  switch (storedStatus) {
    case "verified": return "verified";
    case "expired": return "expired";
    case "rejected": return "rejected";
    default: return "uploaded";
  }
}

/* ------------------------------ doc types (core) ------------------------------ */

const NAME_SCHEMA = z.object({
  name: z.string().trim().min(1, "Enter a document type name.").max(40, "Keep the name under 40 characters."),
});
const TYPE_ID_SCHEMA = z.object({ id: z.string().trim().min(1).max(128) });

async function loadDocType(actor: ContractorAdminActor, id: string): Promise<Record<string, unknown> | null> {
  const q = await db();
  const rows = await q`SELECT id, org_id, name, requires_expiry, sort_order, active, created_at FROM contractor_doc_types WHERE id=${id} AND org_id=${actor.orgId} LIMIT 1`;
  return rows.length ? (rows[0] as Record<string, unknown>) : null;
}

/** All required doc types for the org (active first, then sort_order, then
 *  creation; hidden types sink to a muted "Paused" group in the UI). */
export async function listRequiredDocTypesCore(actor: ContractorAdminActor): Promise<ContractorAdminResult<DocTypeRow[]>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, name, requires_expiry, sort_order, active, created_at
      FROM contractor_doc_types WHERE org_id=${actor.orgId}
      ORDER BY active DESC, sort_order ASC, created_at ASC`;
    const out: DocTypeRow[] = (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      requiresExpiry: r.requires_expiry === true,
      sortOrder: r.sort_order != null ? Number(r.sort_order) : 0,
      active: r.active === true,
      createdAt: new Date(String(r.created_at)).toISOString(),
    }));
    return ok(out);
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load document types.");
  }
}

async function nextSortOrder(actor: ContractorAdminActor): Promise<number> {
  const q = await db();
  const rows = await q`SELECT COALESCE(MAX(sort_order), -1)::int + 1 AS n FROM contractor_doc_types WHERE org_id=${actor.orgId}`;
  return Number(rows[0]?.n ?? 0);
}

/** Add one required type. Case-insensitive duplicate → clear error, never a
 *  crash (DB unique index is the hard backstop). Audited. */
export async function addDocTypeCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<DocTypeRow>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = NAME_SCHEMA.extend({ requiresExpiry: z.boolean().optional() }).safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Enter a document type name.");
  const name = v.data.name;
  const requiresExpiry = v.data.requiresExpiry === true;
  try {
    await ensure();
    const q = await db();
    const dup = await q`SELECT name FROM contractor_doc_types WHERE org_id=${actor.orgId} AND LOWER(name)=${name.toLowerCase()} LIMIT 1`;
    if (dup.length) return err("duplicate", `"${String(dup[0].name)}" is already a required type.`);
    const id = `dt-${cryptoRandomId()}`;
    const sortOrder = await nextSortOrder(actor);
    await q`INSERT INTO contractor_doc_types(id, org_id, name, requires_expiry, sort_order) VALUES(${id}, ${actor.orgId}, ${name}, ${requiresExpiry}, ${sortOrder})`;
    await recordAudit(actor, "contractor_doc_type_added", id, { name, requiresExpiry, sortOrder });
    return ok({ id, name, requiresExpiry, sortOrder, active: true, createdAt: new Date().toISOString() });
  } catch (e) {
    if (e instanceof Error && /duplicate/i.test(e.message)) {
      return err("duplicate", `"${name}" is already a required type.`);
    }
    return err("database_error", e instanceof Error ? e.message : "Unable to add the document type.");
  }
}

/** Rename a type (case-insensitive duplicate check excludes itself). Audited. */
export async function renameDocTypeCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<DocTypeRow>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ id: z.string().trim().min(1).max(128), name: z.string().trim().min(1).max(40) }).safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Enter a document type name.");
  try {
    await ensure();
    const row = await loadDocType(actor, v.data.id);
    if (!row) return err("not_found", "That document type isn't on this account.");
    const q = await db();
    const dup = await q`SELECT id FROM contractor_doc_types WHERE org_id=${actor.orgId} AND LOWER(name)=${v.data.name.toLowerCase()} AND id != ${v.data.id} LIMIT 1`;
    if (dup.length) return err("duplicate", `"${v.data.name}" is already a required type.`);
    await q`UPDATE contractor_doc_types SET name=${v.data.name} WHERE id=${v.data.id} AND org_id=${actor.orgId}`;
    await recordAudit(actor, "contractor_doc_type_renamed", v.data.id, { from: String(row.name), to: v.data.name });
    return ok({
      id: v.data.id,
      name: v.data.name,
      requiresExpiry: row.requires_expiry === true,
      sortOrder: row.sort_order != null ? Number(row.sort_order) : 0,
      active: row.active === true,
      createdAt: new Date(String(row.created_at)).toISOString(),
    });
  } catch (e) {
    if (e instanceof Error && /duplicate/i.test(e.message)) return err("duplicate", `"${v.data.name}" is already a required type.`);
    return err("database_error", e instanceof Error ? e.message : "Unable to rename the document type.");
  }
}

/** Soft-remove: active=FALSE (files/history stay; the type just stops being
 *  required). Idempotent on an already-hidden type. Audited. */
export async function removeDocTypeCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<{ id: string }>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = TYPE_ID_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", "Invalid document type.");
  try {
    await ensure();
    const row = await loadDocType(actor, v.data.id);
    if (!row) return err("not_found", "That document type isn't on this account.");
    const q = await db();
    await q`UPDATE contractor_doc_types SET active=FALSE WHERE id=${v.data.id} AND org_id=${actor.orgId}`;
    await recordAudit(actor, "contractor_doc_type_removed", v.data.id, { name: String(row.name) });
    return ok({ id: v.data.id });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to remove the document type.");
  }
}

/** Toggle active (the AiToggle-style switch — re-activate brings a paused type
 *  back to required). Audited. */
export async function setDocTypeActiveCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<{ id: string; active: boolean }>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ id: z.string().trim().min(1).max(128), active: z.boolean() }).safeParse(data);
  if (!v.success) return err("invalid_input", "Invalid toggle.");
  try {
    await ensure();
    const row = await loadDocType(actor, v.data.id);
    if (!row) return err("not_found", "That document type isn't on this account.");
    const q = await db();
    await q`UPDATE contractor_doc_types SET active=${v.data.active} WHERE id=${v.data.id} AND org_id=${actor.orgId}`;
    await recordAudit(actor, "contractor_doc_type_toggled", v.data.id, { name: String(row.name), active: v.data.active });
    return ok({ id: v.data.id, active: v.data.active });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to update the document type.");
  }
}

/** Reorder: orderedIds = every ACTIVE type id in the new order (sort_order
 *  becomes the array position, 0-based). Only the caller's org's rows are
 *  touched; ids outside the org are ignored. Audited once. */
export async function reorderDocTypesCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<{ reordered: number }>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ orderedIds: z.array(z.string().trim().min(1).max(128)).max(200) }).safeParse(data);
  if (!v.success) return err("invalid_input", "Invalid order.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id FROM contractor_doc_types WHERE org_id=${actor.orgId} AND active=TRUE`;
    const mine = new Set((rows as Record<string, unknown>[]).map((r) => String(r.id)));
    const ordered = v.data.orderedIds.filter((id) => mine.has(id));
    let n = 0;
    for (const id of ordered) {
      await q`UPDATE contractor_doc_types SET sort_order=${n} WHERE id=${id} AND org_id=${actor.orgId}`;
      n += 1;
    }
    if (n > 0) await recordAudit(actor, "contractor_doc_type_reordered", actor.orgId, { ordered });
    return ok({ reordered: n });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to reorder document types.");
  }
}

/* --------------------------- per-contractor documents --------------------------- */

/** All ACTIVE required types + the contractor's current file row (null when
 *  MISSING), sorted by sort_order — the owner Documents section and the
 *  contractor's own Documents screen share this shape. Owner/admin can read
 *  any contractor in the org. */
export async function listContractorDocumentsCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<ContractorDocumentRow[]>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ contractorId: z.string().trim().min(1).max(128) }).safeParse(data);
  if (!v.success) return err("invalid_input", "Invalid contractor.");
  return listContractorDocumentsUnchecked(actor, v.data.contractorId);
}

const DOC_STATUS_SCHEMA = z.object({
  docId: z.string().trim().min(1).max(128),
  status: z.enum(["verified", "rejected", "expired"]),
  reviewNote: z.string().trim().max(300).optional().or(z.literal("")),
});

/** Owner review actions: verify (approve), reject (ask to re-upload, with the
 *  reason shown to the contractor), or force expired. Audited. */
export async function setDocumentStatusCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<{ docId: string; status: DocStatus }>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = DOC_STATUS_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Invalid review action.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, doc_type_id, status, review_note FROM contractor_documents WHERE id=${v.data.docId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!rows.length) return err("not_found", "That document isn't on this account.");
    const reviewNote = v.data.reviewNote && v.data.reviewNote.trim() ? v.data.reviewNote.trim() : null;
    await q`UPDATE contractor_documents SET status=${v.data.status}, review_note=${reviewNote}, updated_at=NOW() WHERE id=${v.data.docId} AND org_id=${actor.orgId}`;
    await recordAudit(actor, `contractor_doc_${v.data.status}`, v.data.docId, {
      docTypeId: String(rows[0].doc_type_id),
      fromStatus: String(rows[0].status),
      reviewNote,
    });
    return ok({ docId: v.data.docId, status: v.data.status });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to update the document.");
  }
}

const EXPIRY_SCHEMA = z.object({
  docId: z.string().trim().min(1).max(128),
  expiresOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date (YYYY-MM-DD).").optional().or(z.literal("").transform(() => null as string | null)),
});

/** Set (or clear with null/'') the document's expiry date. Audited. */
export async function setDocumentExpiryCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<{ docId: string; expiresOn: string | null }>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = EXPIRY_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Invalid expiry date.");
  const expiresOn = v.data.expiresOn && v.data.expiresOn.trim() ? v.data.expiresOn.trim() : null;
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, doc_type_id, expires_on FROM contractor_documents WHERE id=${v.data.docId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!rows.length) return err("not_found", "That document isn't on this account.");
    await q`UPDATE contractor_documents SET expires_on=${expiresOn}, updated_at=NOW() WHERE id=${v.data.docId} AND org_id=${actor.orgId}`;
    await recordAudit(actor, "contractor_doc_expiry_set", v.data.docId, {
      docTypeId: String(rows[0].doc_type_id),
      from: formatYmd(rows[0].expires_on),
      to: expiresOn,
    });
    return ok({ docId: v.data.docId, expiresOn });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to set the expiry date.");
  }
}

/** Read the document's stored file from B2 (base64 + mime for view/download).
 *  Owner/admin: any doc in the org. Contractor: own docs only — a
 *  cross-contractor read is rejected (403 semantics). */
export async function getDocumentFileCore(actor: ContractorAdminActor, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<ContractorAdminResult<DocFilePayload>> {
  const v = z.object({ docId: z.string().trim().min(1).max(128) }).safeParse(data);
  if (!v.success) return err("invalid_input", "Invalid document.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, contractor_id, storage_key, file_name, mime, size_bytes FROM contractor_documents WHERE id=${v.data.docId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!rows.length) return err("not_found", "That document isn't on this account.");
    const row = rows[0] as Record<string, unknown>;
    if (actor.role === "contractor" && String(row.contractor_id) !== actor.id) {
      return err("unauthorized", "This document belongs to another contractor.");
    }
    const key = String(row.storage_key);
    let b2;
    try {
      const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
      const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
      b2 = { config, s3ApiUrl: auth.s3ApiUrl };
    } catch (e) {
      return err("b2_not_configured", e instanceof Error ? e.message : "Document storage isn't connected.");
    }
    const got = await getObject({ config: b2.config, s3ApiUrl: b2.s3ApiUrl, key, fetchImpl: opts.fetchImpl });
    if (!got.ok || !got.bytes) return err("b2_failed", `Document storage rejected the read (HTTP ${got.status ?? "error"}).`);
    return ok({
      base64: Buffer.from(got.bytes).toString("base64"),
      mime: String(row.mime ?? "application/octet-stream"),
      fileName: row.file_name != null ? String(row.file_name) : null,
      sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : got.bytes.length,
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load the document.");
  }
}

/* ---------------------------------- payrate ---------------------------------- */

const PAYRATE_SCHEMA = z.object({
  contractorId: z.string().trim().min(1).max(128),
  payrateCents: z.number().int().min(0).max(10_000_000).nullable(),
});

/** Set (or clear with null) the per-job payrate. Upsert into
 *  contractor_profiles; audited ('contractor_payrate_set' with from/to).
 *  The roster payload picks it up on the next listContractors read. */
export async function setContractorPayrateCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<{ contractorId: string; payrateCents: number | null }>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = PAYRATE_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", "Enter an amount like 75.");
  try {
    await ensure();
    const q = await db();
    const member = await q`SELECT 1 FROM organization_memberships m WHERE m.org_id=${actor.orgId} AND m.user_id=${v.data.contractorId} AND m.role='contractor' LIMIT 1`;
    if (!member.length) return err("not_found", "That contractor isn't on this account.");
    const before = await q`SELECT payrate_cents FROM contractor_profiles WHERE org_id=${actor.orgId} AND user_id=${v.data.contractorId} LIMIT 1`;
    await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents, updated_at)
      VALUES(${actor.orgId}, ${v.data.contractorId}, ${v.data.payrateCents}, NOW())
      ON CONFLICT (org_id, user_id) DO UPDATE SET payrate_cents=EXCLUDED.payrate_cents, updated_at=NOW()`;
    await recordAudit(actor, "contractor_payrate_set", v.data.contractorId, {
      from: before.length ? (before[0].payrate_cents != null ? Number(before[0].payrate_cents) : null) : null,
      to: v.data.payrateCents,
    });
    return ok({ contractorId: v.data.contractorId, payrateCents: v.data.payrateCents });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to save the payrate.");
  }
}

/* ------------------------------- compliance counts ------------------------------- */

/** Per-contractor compliance for the roster strip. onFile = active required
 *  types with a file whose derived status is UPLOADED or VERIFIED — a file
 *  that is present AND not expired/rejected. */
export async function listContractorComplianceCore(actor: ContractorAdminActor): Promise<ContractorAdminResult<ContractorComplianceRow[]>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT u.id AS contractor_id, u.name,
        (SELECT COUNT(*)::int FROM contractor_doc_types t WHERE t.org_id=${actor.orgId} AND t.active) AS required_doc_count,
        (SELECT COUNT(*)::int FROM contractor_documents d
           JOIN contractor_doc_types t ON t.id = d.doc_type_id AND t.active
           WHERE d.org_id=${actor.orgId} AND d.contractor_id = u.id
             AND d.status IN ('uploaded','verified')
             AND (d.expires_on IS NULL OR d.expires_on >= CURRENT_DATE)) AS on_file_doc_count
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${actor.orgId} AND m.role = 'contractor'
      WHERE u.deactivated_at IS NULL
      ORDER BY LOWER(u.name)`;
    const out: ContractorComplianceRow[] = (rows as Record<string, unknown>[]).map((r) => ({
      contractorId: String(r.contractor_id),
      name: String(r.name ?? ""),
      requiredDocCount: r.required_doc_count != null ? Number(r.required_doc_count) : 0,
      onFileDocCount: r.on_file_doc_count != null ? Number(r.on_file_doc_count) : 0,
    }));
    return ok(out);
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load compliance.");
  }
}

/* --------------------------- contractor detail (part 2) --------------------------- */

/** The full per-contractor record for the owner detail screen
 *  (/owner/contractors/:id). Identity + sign-in meta + LD-only contact
 *  (phone/vehicle — never pushed to Towbook) + payrate + compliance counts +
 *  this-pay-period completed jobs (est. earnings = completed × payrate).
 *  INCLUDES removed (deactivated) contractors — the detail screen renders a
 *  removed contractor with history preserved. Seroval-safe: every property
 *  defined (null, never undefined). */
export type ContractorDetailRow = {
  id: string;
  name: string;
  email: string;
  loginHandle: string | null;
  towbookDriverId: string | null;
  towbookUserId: string | null;
  status: "signed_in" | "not_signed_in";
  lastActivityAt: string | null;
  createdAt: string | null;
  removedAt: string | null;
  phone: string | null;
  vehicleDesc: string | null;
  payrateCents: number | null;
  requiredDocCount: number;
  onFileDocCount: number;
  completedJobsThisPeriod: number;
  estEarningsCents: number | null;
};

/** Monday 00:00 (server-local) — the pay-period start. The payroll engine
 *  (part 4) owns the canonical weekly-period math; the detail card just needs
 *  "jobs completed this period" for the est-earnings line. */
function payPeriodStart(): Date {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = (d.getDay() + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  return d;
}

const DETAIL_SCHEMA = z.object({ contractorId: z.string().trim().min(1).max(128) });

/** One contractor's detail record — owner/admin only, INCLUDES removed rows
 *  (unlike the roster, which excludes them). */
export async function getContractorDetailCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<ContractorDetailRow>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = DETAIL_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", "Invalid contractor.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT u.id, u.name, u.email, u.login_handle, u.towbook_driver_id, u.towbook_user_id, u.created_at, u.deactivated_at,
        cp.phone, cp.vehicle_desc, cp.payrate_cents,
        ts.session_updated_at, ls.last_login, dl.last_ping,
        (SELECT COUNT(*)::int FROM contractor_doc_types t WHERE t.org_id = ${actor.orgId} AND t.active) AS required_doc_count,
        (SELECT COUNT(*)::int FROM contractor_documents d
           JOIN contractor_doc_types t ON t.id = d.doc_type_id AND t.active
           WHERE d.org_id = ${actor.orgId} AND d.contractor_id = u.id
             AND d.status IN ('uploaded','verified')
             AND (d.expires_on IS NULL OR d.expires_on >= CURRENT_DATE)) AS on_file_doc_count,
        (SELECT COUNT(*)::int FROM dispatch_jobs j
           WHERE j.org_id = ${actor.orgId} AND j.assigned_contractor_id = u.id
             AND j.status = 'completed' AND j.completed_at >= ${payPeriodStart()}) AS completed_this_period
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${actor.orgId} AND m.role = 'contractor'
      LEFT JOIN contractor_profiles cp ON cp.org_id = ${actor.orgId} AND cp.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT MAX(updated_at) AS session_updated_at
        FROM towbook_sessions ts
        WHERE ts.org_id = ${actor.orgId} AND ts.towbook_driver_id = u.towbook_driver_id
      ) ts ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_login
        FROM sessions s
        WHERE s.user_id = u.id AND s.expires_at > NOW()
      ) ls ON TRUE
      LEFT JOIN (
        SELECT driver_id, MAX(captured_at) AS last_ping
        FROM driver_locations WHERE org_id = ${actor.orgId}
        GROUP BY driver_id
      ) dl ON dl.driver_id = u.id
      WHERE u.id = ${v.data.contractorId} LIMIT 1`;
    if (!rows.length) return err("not_found", "That contractor isn't on this account.");
    const r = rows[0] as Record<string, unknown>;
    const lastPing = r.last_ping != null ? new Date(String(r.last_ping)) : null;
    const sessionAt = r.session_updated_at != null ? new Date(String(r.session_updated_at)) : null;
    const loginAt = r.last_login != null ? new Date(String(r.last_login)) : null;
    const signedIn = sessionAt != null || loginAt != null;
    const lastActivity = [lastPing, sessionAt, loginAt]
      .filter((d): d is Date => d != null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const completed = r.completed_this_period != null ? Number(r.completed_this_period) : 0;
    const payrate = r.payrate_cents != null ? Number(r.payrate_cents) : null;
    return ok({
      id: String(r.id),
      name: String(r.name ?? ""),
      email: String(r.email ?? ""),
      loginHandle: r.login_handle != null ? String(r.login_handle) : null,
      towbookDriverId: r.towbook_driver_id != null ? String(r.towbook_driver_id) : null,
      towbookUserId: r.towbook_user_id != null ? String(r.towbook_user_id) : null,
      status: signedIn ? "signed_in" : "not_signed_in",
      lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
      createdAt: r.created_at != null ? new Date(String(r.created_at)).toISOString() : null,
      removedAt: r.deactivated_at != null ? new Date(String(r.deactivated_at)).toISOString() : null,
      phone: r.phone != null ? String(r.phone) : null,
      vehicleDesc: r.vehicle_desc != null ? String(r.vehicle_desc) : null,
      payrateCents: payrate,
      requiredDocCount: r.required_doc_count != null ? Number(r.required_doc_count) : 0,
      onFileDocCount: r.on_file_doc_count != null ? Number(r.on_file_doc_count) : 0,
      completedJobsThisPeriod: completed,
      estEarningsCents: payrate != null ? payrate * completed : null,
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load the contractor.");
  }
}

const CONTACT_SCHEMA = z.object({
  contractorId: z.string().trim().min(1).max(128),
  phone: z.string().trim().max(40, "Keep the phone number under 40 characters.").optional().or(z.literal("")),
  vehicleDesc: z.string().trim().max(200, "Keep the vehicle description under 200 characters.").optional().or(z.literal("")),
});

export type ContractorContactResult = { contractorId: string; phone: string | null; vehicleDesc: string | null };

/** Update the LD-only contact fields (phone + vehicle description) on the
 *  contractor's operational profile. These are Lightning-Dispatch-only — never
 *  pushed to Towbook (Towbook's driver-editor phone/vehicle surface is
 *  unverified territory). Upsert + audited ('contractor_contact_updated'). */
export async function setContractorContactCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<ContractorContactResult>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = CONTACT_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Invalid contact details.");
  const phone = v.data.phone && v.data.phone.trim() ? v.data.phone.trim() : null;
  const vehicleDesc = v.data.vehicleDesc && v.data.vehicleDesc.trim() ? v.data.vehicleDesc.trim() : null;
  try {
    await ensure();
    const q = await db();
    const member = await q`SELECT 1 FROM organization_memberships m WHERE m.org_id=${actor.orgId} AND m.user_id=${v.data.contractorId} AND m.role='contractor' LIMIT 1`;
    if (!member.length) return err("not_found", "That contractor isn't on this account.");
    const before = await q`SELECT phone, vehicle_desc FROM contractor_profiles WHERE org_id=${actor.orgId} AND user_id=${v.data.contractorId} LIMIT 1`;
    await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents, phone, vehicle_desc, updated_at)
      VALUES(${actor.orgId}, ${v.data.contractorId}, NULL, ${phone}, ${vehicleDesc}, NOW())
      ON CONFLICT (org_id, user_id) DO UPDATE SET phone=EXCLUDED.phone, vehicle_desc=EXCLUDED.vehicle_desc, updated_at=NOW()`;
    await recordAudit(actor, "contractor_contact_updated", v.data.contractorId, {
      from: {
        phone: before.length ? (before[0].phone != null ? String(before[0].phone) : null) : null,
        vehicleDesc: before.length ? (before[0].vehicle_desc != null ? String(before[0].vehicle_desc) : null) : null,
      },
      to: { phone, vehicleDesc },
    });
    return ok({ contractorId: v.data.contractorId, phone, vehicleDesc });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to save the contact details.");
  }
}

/* ------------------------------ contractor-own docs ------------------------------ */

/** The acting contractor's own documents — same shape as
 *  listContractorDocumentsCore but session-scoped to self. */
export async function getMyDocumentsCore(actor: ContractorAdminActor): Promise<ContractorAdminResult<ContractorDocumentRow[]>> {
  if (actor.role !== "contractor") return err("unauthorized", "Driver access required.");
  return listContractorDocumentsUnchecked(actor, actor.id);
}

/** Ungated row loader (owner path gates first; the contractor-own path calls
 *  it with self — the cross-contractor read is impossible by construction). */
async function listContractorDocumentsUnchecked(actor: ContractorAdminActor, contractorId: string): Promise<ContractorAdminResult<ContractorDocumentRow[]>> {
  try {
    await ensure();
    const q = await db();
    const member = await q`SELECT 1 FROM organization_memberships m WHERE m.org_id=${actor.orgId} AND m.user_id=${contractorId} AND m.role='contractor' LIMIT 1`;
    if (!member.length) return err("not_found", "That contractor isn't on this account.");
    const rows = await q`SELECT t.id AS doc_type_id, t.name AS doc_type_name, t.requires_expiry, t.sort_order,
        d.id AS doc_id, d.file_name, d.mime, d.size_bytes, d.expires_on, d.review_note, d.uploaded_at, d.uploaded_by_user_id, d.status AS stored_status
      FROM contractor_doc_types t
      LEFT JOIN contractor_documents d ON d.org_id=${actor.orgId} AND d.contractor_id=${contractorId} AND d.doc_type_id=t.id
      WHERE t.org_id=${actor.orgId} AND t.active=TRUE
      ORDER BY t.sort_order ASC, t.created_at ASC`;
    const out: ContractorDocumentRow[] = (rows as Record<string, unknown>[]).map((r) => {
      const storedStatus = r.stored_status != null ? String(r.stored_status) : null;
      const expiresOn = formatYmd(r.expires_on);
      const status = storedStatus ? deriveDocStatus(storedStatus, expiresOn) : "missing";
      return {
        docTypeId: String(r.doc_type_id),
        docTypeName: String(r.doc_type_name),
        requiresExpiry: r.requires_expiry === true,
        status,
        docId: r.doc_id != null ? String(r.doc_id) : null,
        fileName: r.file_name != null ? String(r.file_name) : null,
        mime: r.mime != null ? String(r.mime) : null,
        sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
        expiresOn,
        reviewNote: r.review_note != null ? String(r.review_note) : null,
        uploadedAt: r.uploaded_at != null ? new Date(String(r.uploaded_at)).toISOString() : null,
        uploadedByUserId: r.uploaded_by_user_id != null ? String(r.uploaded_by_user_id) : null,
      };
    });
    return ok(out);
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load the contractor's documents.");
  }
}

/* --------------------------------- upload (part 3 core) --------------------------------- */

const DOC_MIME_ALLOWLIST = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
const DOC_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

/** Mirror of driver-photos-core's decodeDataUrl with the PDF branch — photos
 *  stay image-only, documents additionally accept application/pdf. Exported
 *  so part 3 (and hermetic tests) reuse the exact same gate. */
export function decodeDocumentDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!(DOC_MIME_ALLOWLIST as readonly string[]).includes(mime)) return null;
  return { bytes: new Uint8Array(Buffer.from(m[2], "base64")), mime };
}

const UPLOAD_SCHEMA = z.object({
  docTypeId: z.string().trim().min(1).max(128),
  dataUrl: z.string().min(20).max(20_000_000),
  fileName: z.string().trim().max(200).optional().or(z.literal("")),
  expiresOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date (YYYY-MM-DD).").optional().or(z.literal("")),
});

export type UploadDocumentResult =
  | { ok: true; storageKey: string; status: "uploaded"; expiresOn: string | null }
  | { ok: false; code: "unauthorized" | "invalid_input" | "not_found" | "b2_not_configured" | "b2_failed" | "database_error"; message: string };

/** Contractor uploads one document for a required type (driver upload UI is
 *  part 3 — the core + B2 path are implemented and hermetic-tested now with a
 *  mock fetchImpl). Storage key ld-docs/<org>/<driverId>/<docTypeId>.<ext>;
 *  limits ≥1KB ≤12MB; re-upload overwrites the same B2 object + upserts the
 *  same row (status resets to 'uploaded' — re-review required; review_note
 *  cleared; expires_on replaced unless re-entered). Audited. */
export async function uploadMyDocumentCore(actor: ContractorAdminActor, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<UploadDocumentResult> {
  if (actor.role !== "contractor") return { ok: false, code: "unauthorized", message: "Driver access required." };
  const v = UPLOAD_SCHEMA.safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_input", message: v.error.issues[0]?.message ?? "Invalid upload." };
  const decoded = decodeDocumentDataUrl(v.data.dataUrl);
  if (!decoded) return { ok: false, code: "invalid_input", message: "That file type isn't supported — use JPG, PNG, WebP or PDF." };
  if (decoded.bytes.length < 1024) return { ok: false, code: "invalid_input", message: "The file looks empty — try again." };
  if (decoded.bytes.length > 12 * 1024 * 1024) return { ok: false, code: "invalid_input", message: "The file is too large (max 12 MB)." };
  const expiresOn = v.data.expiresOn && v.data.expiresOn.trim() ? v.data.expiresOn.trim() : null;
  try {
    await ensure();
    const q = await db();
    const type = await q`SELECT id, name, requires_expiry, active FROM contractor_doc_types WHERE id=${v.data.docTypeId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!type.length || type[0].active !== true) return { ok: false, code: "not_found", message: "That document type isn't required on your account." };
    const ext = DOC_EXT[decoded.mime];
    const key = `ld-docs/${actor.orgId}/${actor.id}/${v.data.docTypeId}.${ext}`;
    let b2;
    try {
      const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
      const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
      b2 = { config, s3ApiUrl: auth.s3ApiUrl };
    } catch (e) {
      return { ok: false, code: "b2_not_configured", message: e instanceof Error ? e.message : "Document storage isn't connected." };
    }
    const put = await putObject({ config: b2.config, s3ApiUrl: b2.s3ApiUrl, key, bytes: decoded.bytes, contentType: decoded.mime, fetchImpl: opts.fetchImpl });
    if (!put.ok) return { ok: false, code: "b2_failed", message: `Document storage rejected the upload (HTTP ${put.status ?? "error"}). Try again.` };
    const fileName = v.data.fileName && v.data.fileName.trim() ? v.data.fileName.trim() : null;
    await q`INSERT INTO contractor_documents(id, org_id, contractor_id, doc_type_id, storage_key, file_name, mime, size_bytes, status, expires_on, review_note, uploaded_by_user_id, updated_at)
      VALUES(gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${v.data.docTypeId}, ${key}, ${fileName}, ${decoded.mime}, ${decoded.bytes.length}, 'uploaded', ${expiresOn}, NULL, ${actor.id}, NOW())
      ON CONFLICT (org_id, contractor_id, doc_type_id) DO UPDATE SET
        storage_key=EXCLUDED.storage_key, file_name=EXCLUDED.file_name, mime=EXCLUDED.mime,
        size_bytes=EXCLUDED.size_bytes, status='uploaded', expires_on=EXCLUDED.expires_on,
        review_note=NULL, uploaded_by_user_id=EXCLUDED.uploaded_by_user_id, uploaded_at=NOW(), updated_at=NOW()`;
    await recordAudit(actor, "contractor_doc_uploaded", v.data.docTypeId, {
      docTypeId: v.data.docTypeId,
      docTypeName: String(type[0].name),
      storageKey: key,
      fileName,
      mime: decoded.mime,
      sizeBytes: decoded.bytes.length,
      expiresOn,
    });
    return { ok: true, storageKey: key, status: "uploaded", expiresOn };
  } catch (e) {
    return { ok: false, code: "database_error", message: e instanceof Error ? e.message : "Unable to upload the document." };
  }
}

/* ----------------------------------- audit ----------------------------------- */

async function recordAudit(actor: ContractorAdminActor, action: string, entityId: string, detail: Record<string, unknown>): Promise<void> {
  try {
    const q = await db();
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, ${action}, 'contractor', ${entityId}, ${JSON.stringify(detail)}::jsonb, 'contractor-admin'`;
  } catch { /* audit is best-effort — never mask the outcome */ }
}

/* --------------------------------- handlers --------------------------------- */

function cryptoRandomId(): string {
  return randomBytes(16).toString("hex");
}

async function resolveOwnerActor(): Promise<ContractorAdminActor | null> {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || !OWNER_ROLES.includes(u.role)) return null;
  return { orgId: u.orgId, id: u.id, role: u.role };
}

async function resolveContractorActor(): Promise<ContractorAdminActor | null> {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || u.role !== "contractor") return null;
  return { orgId: u.orgId, id: u.id, role: u.role };
}

const DB_MODE_ERR = (msg: string): ContractorAdminResult<never> => err("database_error", `${msg} requires database mode.`);

export async function listRequiredDocTypesHandler(): Promise<ContractorAdminResult<DocTypeRow[]>> {
  if (!configured()) return DB_MODE_ERR("Document types");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return listRequiredDocTypesCore(actor);
}
export async function addDocTypeHandler(data: unknown): Promise<ContractorAdminResult<DocTypeRow>> {
  if (!configured()) return DB_MODE_ERR("Document types");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return addDocTypeCore(actor, data);
}
export async function renameDocTypeHandler(data: unknown): Promise<ContractorAdminResult<DocTypeRow>> {
  if (!configured()) return DB_MODE_ERR("Document types");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return renameDocTypeCore(actor, data);
}
export async function removeDocTypeHandler(data: unknown): Promise<ContractorAdminResult<{ id: string }>> {
  if (!configured()) return DB_MODE_ERR("Document types");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return removeDocTypeCore(actor, data);
}
export async function setDocTypeActiveHandler(data: unknown): Promise<ContractorAdminResult<{ id: string; active: boolean }>> {
  if (!configured()) return DB_MODE_ERR("Document types");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return setDocTypeActiveCore(actor, data);
}
export async function reorderDocTypesHandler(data: unknown): Promise<ContractorAdminResult<{ reordered: number }>> {
  if (!configured()) return DB_MODE_ERR("Document types");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return reorderDocTypesCore(actor, data);
}
export async function listContractorDocumentsHandler(data: unknown): Promise<ContractorAdminResult<ContractorDocumentRow[]>> {
  if (!configured()) return DB_MODE_ERR("Documents");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return listContractorDocumentsCore(actor, data);
}
export async function setDocumentStatusHandler(data: unknown): Promise<ContractorAdminResult<{ docId: string; status: DocStatus }>> {
  if (!configured()) return DB_MODE_ERR("Documents");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return setDocumentStatusCore(actor, data);
}
export async function setDocumentExpiryHandler(data: unknown): Promise<ContractorAdminResult<{ docId: string; expiresOn: string | null }>> {
  if (!configured()) return DB_MODE_ERR("Documents");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return setDocumentExpiryCore(actor, data);
}
export async function getDocumentFileHandler(data: unknown, opts?: { fetchImpl?: typeof fetch }): Promise<ContractorAdminResult<DocFilePayload>> {
  if (!configured()) return DB_MODE_ERR("Documents");
  const actor = await resolveOwnerOrContractorActor();
  if (!actor) return err("unauthorized", "Sign in first.");
  return getDocumentFileCore(actor, data, opts);
}
export async function setContractorPayrateHandler(data: unknown): Promise<ContractorAdminResult<{ contractorId: string; payrateCents: number | null }>> {
  if (!configured()) return DB_MODE_ERR("Payrate");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return setContractorPayrateCore(actor, data);
}
export async function listContractorComplianceHandler(): Promise<ContractorAdminResult<ContractorComplianceRow[]>> {
  if (!configured()) return DB_MODE_ERR("Compliance");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return listContractorComplianceCore(actor);
}
export async function getContractorDetailHandler(data: unknown): Promise<ContractorAdminResult<ContractorDetailRow>> {
  if (!configured()) return DB_MODE_ERR("Contractor details");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return getContractorDetailCore(actor, data);
}
export async function setContractorContactHandler(data: unknown): Promise<ContractorAdminResult<ContractorContactResult>> {
  if (!configured()) return DB_MODE_ERR("Contractor details");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return setContractorContactCore(actor, data);
}
export async function getMyDocumentsHandler(): Promise<ContractorAdminResult<ContractorDocumentRow[]>> {
  if (!configured()) return DB_MODE_ERR("Documents");
  const actor = await resolveContractorActor();
  if (!actor) return err("unauthorized", "Driver access required.");
  return getMyDocumentsCore(actor);
}
export async function uploadMyDocumentHandler(data: unknown, opts?: { fetchImpl?: typeof fetch }): Promise<UploadDocumentResult> {
  if (!configured()) return { ok: false, code: "database_error", message: "Document uploads require database mode." };
  const actor = await resolveContractorActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Driver access required." };
  return uploadMyDocumentCore(actor, data, opts);
}

async function resolveOwnerOrContractorActor(): Promise<ContractorAdminActor | null> {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  return { orgId: u.orgId, id: u.id, role: u.role };
}
