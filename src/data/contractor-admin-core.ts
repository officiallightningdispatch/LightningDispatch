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
import {
  submitW9FormCore,
  submitI9FormCore,
  getFormSubmissionCore,
  getFormDocFileCore,
  reviewI9Section2Core,
} from "./form-docs-core";
import type { FormKind, FormSubmissionView, SubmitFormResult } from "./form-docs-core";

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

export type { FormKind } from "./form-docs-core";

export type DocTypeRow = {
  id: string;
  name: string;
  requiresExpiry: boolean;
  /** Pair-bearing type (owner-directed 2026-08-12): the primary document AND a
   *  live selfie are both required; the owner approves the pair with one verify
   *  tap (no facial-matching service — approval is the owner's review). */
  requiresFacialVerification: boolean;
  /** Form-bearing type (owner-directed 2026-08-12): the W-9 / I-9 required
   *  docs are FILLABLE OFFICIAL FORMS, not uploads. 'i9' | 'w9' | null. */
  formKind: FormKind | null;
  /** SELF-COMPLETED permissions type (owner-directed 2026-08-13): the
   *  "Notifications & Location" required item. The driver completes it by
   *  granting notifications + saving a push subscription + sharing a live GPS
   *  fix; the server verifies all three and flips the doc to 'verified' —
   *  counted by the SAME compliance gate as every other required type. */
  requiresNotificationsLocation: boolean;
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
  /** Pair-bearing type — a live selfie is required alongside the primary file
   *  (part 3, owner-directed 2026-08-12); the pair is approved together. */
  requiresFacialVerification: boolean;
  /** Form-bearing type — the driver fills the official form instead of
   *  uploading a file ('i9' | 'w9' | null). */
  formKind: FormKind | null;
  /** The stored file may NOT be read back by the driver: completed official
   *  forms carry the tax id (SSN/EIN) — owner-only visibility after submission
   *  (owner-directed 2026-08-12). False for i9/w9 form docs. */
  formViewableByDriver: boolean;
  /** SELF-COMPLETED permissions type (owner-directed 2026-08-13): "Notifications
   *  & Location" — completed by the driver (notifications + push subscription +
   *  GPS fix), auto-verified by the server; no owner review. */
  requiresNotificationsLocation: boolean;
  status: DocStatus;
  docId: string | null;
  fileName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  expiresOn: string | null; // YYYY-MM-DD
  reviewNote: string | null;
  uploadedAt: string | null;
  uploadedByUserId: string | null;
  /** Selfie slot (only meaningful when requiresFacialVerification): binary —
   *  the selfie is either missing or submitted; its approval rides on the
   *  primary document's verify (the owner approves the PAIR with one tap). */
  selfieStatus: "missing" | "uploaded";
  selfieFileName: string | null;
  selfieUploadedAt: string | null;
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
  /** Required types VERIFIED by the owner (approved) — the roster badge reads
   *  "{approved}/{required} approved"; submitted-but-unapproved shows as the
   *  "N to review" pill. */
  approvedDocCount: number;
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
  const rows = await q`SELECT id, org_id, name, requires_expiry, requires_facial_verification, form_kind, requires_notifications_location, sort_order, active, created_at FROM contractor_doc_types WHERE id=${id} AND org_id=${actor.orgId} LIMIT 1`;
  return rows.length ? (rows[0] as Record<string, unknown>) : null;
}

/** All required doc types for the org (active first, then sort_order, then
 *  creation; hidden types sink to a muted "Paused" group in the UI). */
export async function listRequiredDocTypesCore(actor: ContractorAdminActor): Promise<ContractorAdminResult<DocTypeRow[]>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, name, requires_expiry, requires_facial_verification, form_kind, requires_notifications_location, sort_order, active, created_at
      FROM contractor_doc_types WHERE org_id=${actor.orgId}
      ORDER BY active DESC, sort_order ASC, created_at ASC`;
    const out: DocTypeRow[] = (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      requiresExpiry: r.requires_expiry === true,
      requiresFacialVerification: r.requires_facial_verification === true,
      formKind: r.form_kind === "i9" || r.form_kind === "w9" ? (r.form_kind as FormKind) : null,
      requiresNotificationsLocation: r.requires_notifications_location === true,
      sortOrder: r.sort_order != null ? Number(r.sort_order) : 0,
      active: r.active === true,
      createdAt: new Date(String(r.created_at)).toISOString(),
    }));
    return ok(out);
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load document types.");
  }
}

async function nextSortOrder(orgId: string): Promise<number> {
  const q = await db();
  const rows = await q`SELECT COALESCE(MAX(sort_order), -1)::int + 1 AS n FROM contractor_doc_types WHERE org_id=${orgId}`;
  return Number(rows[0]?.n ?? 0);
}

/** Add one required type. Case-insensitive duplicate → clear error, never a
 *  crash (DB unique index is the hard backstop). Audited. */
export async function addDocTypeCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<DocTypeRow>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = NAME_SCHEMA.extend({ requiresExpiry: z.boolean().optional(), requiresFacialVerification: z.boolean().optional() }).safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Enter a document type name.");
  const name = v.data.name;
  const requiresExpiry = v.data.requiresExpiry === true;
  const requiresFacialVerification = v.data.requiresFacialVerification === true;
  try {
    await ensure();
    const q = await db();
    const dup = await q`SELECT name FROM contractor_doc_types WHERE org_id=${actor.orgId} AND LOWER(name)=${name.toLowerCase()} LIMIT 1`;
    if (dup.length) return err("duplicate", `"${String(dup[0].name)}" is already a required type.`);
    const id = `dt-${cryptoRandomId()}`;
    const sortOrder = await nextSortOrder(actor.orgId);
    await q`INSERT INTO contractor_doc_types(id, org_id, name, requires_expiry, requires_facial_verification, sort_order) VALUES(${id}, ${actor.orgId}, ${name}, ${requiresExpiry}, ${requiresFacialVerification}, ${sortOrder})`;
    await recordAudit(actor, "contractor_doc_type_added", id, { name, requiresExpiry, requiresFacialVerification, sortOrder });
    return ok({ id, name, requiresExpiry, requiresFacialVerification, formKind: null, requiresNotificationsLocation: false, sortOrder, active: true, createdAt: new Date().toISOString() });
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
      requiresFacialVerification: row.requires_facial_verification === true,
      formKind: row.form_kind === "i9" || row.form_kind === "w9" ? (row.form_kind as FormKind) : null,
      requiresNotificationsLocation: row.requires_notifications_location === true,
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
    const rows = await q`SELECT d.id, d.contractor_id, d.doc_type_id, d.status, d.review_note, t.requires_facial_verification
      FROM contractor_documents d JOIN contractor_doc_types t ON t.id = d.doc_type_id
      WHERE d.id=${v.data.docId} AND d.org_id=${actor.orgId} LIMIT 1`;
    if (!rows.length) return err("not_found", "That document isn't on this account.");
    // Part 3 (owner-directed 2026-08-12): the owner approves the license+selfie
    // PAIR with one tap — verifying a facial-verification type without the
    // driver's live selfie on file is refused so a half-approved pair can never
    // unlock the GO gate.
    if (v.data.status === "verified" && rows[0].requires_facial_verification === true) {
      const selfie = await q`SELECT 1 FROM contractor_doc_selfies WHERE org_id=${actor.orgId} AND doc_type_id=${String(rows[0].doc_type_id)} AND contractor_id=${String(rows[0].contractor_id ?? "")} LIMIT 1`;
      if (!selfie.length) return err("invalid_input", "The driver hasn't uploaded their live selfie yet — approve the pair once both are in.");
    }
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
    const rows = await q`SELECT d.id, d.contractor_id, d.storage_key, d.file_name, d.mime, d.size_bytes, t.form_kind
      FROM contractor_documents d JOIN contractor_doc_types t ON t.id = d.doc_type_id
      WHERE d.id=${v.data.docId} AND d.org_id=${actor.orgId} LIMIT 1`;
    if (!rows.length) return err("not_found", "That document isn't on this account.");
    const row = rows[0] as Record<string, unknown>;
    if (actor.role === "contractor" && String(row.contractor_id) !== actor.id) {
      return err("unauthorized", "This document belongs to another contractor.");
    }
    // Completed official forms carry the tax id (SSN/EIN) — after submission
    // the FILE is owner-only, even for the contractor who filled it.
    // (owner-directed 2026-08-12: SSN/EIN never render to the contractor.)
    if (actor.role === "contractor" && (row.form_kind === "i9" || row.form_kind === "w9")) {
      return err("unauthorized", "This completed form is viewable by the owner only.");
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
             AND (d.expires_on IS NULL OR d.expires_on >= CURRENT_DATE)
             AND (t.requires_facial_verification = FALSE OR EXISTS (
               SELECT 1 FROM contractor_doc_selfies s
               WHERE s.org_id = d.org_id AND s.contractor_id = d.contractor_id AND s.doc_type_id = d.doc_type_id))) AS on_file_doc_count,
        (SELECT COUNT(*)::int FROM contractor_documents d
           JOIN contractor_doc_types t ON t.id = d.doc_type_id AND t.active
           WHERE d.org_id=${actor.orgId} AND d.contractor_id = u.id
             AND d.status = 'verified'
             AND (d.expires_on IS NULL OR d.expires_on >= CURRENT_DATE)
             AND (t.requires_facial_verification = FALSE OR EXISTS (
               SELECT 1 FROM contractor_doc_selfies s
               WHERE s.org_id = d.org_id AND s.contractor_id = d.contractor_id AND s.doc_type_id = d.doc_type_id))) AS approved_doc_count
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${actor.orgId} AND m.role = 'contractor'
      WHERE u.deactivated_at IS NULL
      ORDER BY LOWER(u.name)`;
    const out: ContractorComplianceRow[] = (rows as Record<string, unknown>[]).map((r) => ({
      contractorId: String(r.contractor_id),
      name: String(r.name ?? ""),
      requiredDocCount: r.required_doc_count != null ? Number(r.required_doc_count) : 0,
      onFileDocCount: r.on_file_doc_count != null ? Number(r.on_file_doc_count) : 0,
      approvedDocCount: r.approved_doc_count != null ? Number(r.approved_doc_count) : 0,
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
  address: string | null;
  vehicleDesc: string | null;
  /** Structured vehicle (v2 — LD-only, net-new; Towbook has no vehicle data). */
  vehicle: ContractorVehicle;
  /** Weekly availability template + who owns it (v2). Empty schedule = no
   *  limit. ownerOverride=TRUE ⇒ the owner took over editing (driver edits
   *  stop applying). */
  schedule: ContractorScheduleRow;
  /** Docs expiring within 14 days (expires_on in [today, today+14]) — the
   *  ExpiryChip + roster "Expiring soon" filter data. Seroval-safe. */
  docsExpiringSoon: { docTypeName: string; expiresOn: string; docId: string | null }[];
  docsExpiringSoonCount: number;
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
        cp.phone, cp.vehicle_desc, cp.address, cp.vehicle_type, cp.vehicle_make, cp.vehicle_model, cp.vehicle_year, cp.vehicle_plate, cp.vehicle_plate_state, cp.vehicle_color, cp.payrate_cents,
        cs.schedule, cs.source, cs.owner_override, cs.updated_at AS schedule_updated_at,
        ts.session_updated_at, ls.last_login, dl.last_ping,
        (SELECT COUNT(*)::int FROM contractor_doc_types t WHERE t.org_id = ${actor.orgId} AND t.active) AS required_doc_count,
        (SELECT COUNT(*)::int FROM contractor_documents d
           JOIN contractor_doc_types t ON t.id = d.doc_type_id AND t.active
           WHERE d.org_id = ${actor.orgId} AND d.contractor_id = u.id
             AND d.status IN ('uploaded','verified')
             AND (d.expires_on IS NULL OR d.expires_on >= CURRENT_DATE)
             AND (t.requires_facial_verification = FALSE OR EXISTS (
               SELECT 1 FROM contractor_doc_selfies s
               WHERE s.org_id = d.org_id AND s.contractor_id = d.contractor_id AND s.doc_type_id = d.doc_type_id))) AS on_file_doc_count,
        (SELECT COUNT(*)::int FROM dispatch_jobs j
           WHERE j.org_id = ${actor.orgId} AND j.assigned_contractor_id = u.id
             AND j.status = 'completed' AND j.completed_at >= ${payPeriodStart()}) AS completed_this_period
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${actor.orgId} AND m.role = 'contractor'
      LEFT JOIN contractor_profiles cp ON cp.org_id = ${actor.orgId} AND cp.user_id = u.id
      LEFT JOIN contractor_schedules cs ON cs.org_id = ${actor.orgId} AND cs.user_id = u.id
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
    const expiring = await q`SELECT d.id AS doc_id, t.name AS doc_type_name, d.expires_on
      FROM contractor_documents d JOIN contractor_doc_types t ON t.id = d.doc_type_id AND t.active
      WHERE d.org_id=${actor.orgId} AND d.contractor_id=${v.data.contractorId}
        AND d.expires_on >= CURRENT_DATE AND d.expires_on <= CURRENT_DATE + INTERVAL '14 days'
      ORDER BY d.expires_on ASC`;
    const docsExpiringSoon = (expiring as Record<string, unknown>[]).map((e) => ({
      docTypeName: String(e.doc_type_name ?? ""),
      expiresOn: formatYmd(e.expires_on) ?? "",
      docId: e.doc_id != null ? String(e.doc_id) : null,
    }));
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
      address: r.address != null ? String(r.address) : null,
      vehicleDesc: r.vehicle_desc != null ? String(r.vehicle_desc) : null,
      vehicle: {
        type: r.vehicle_type != null ? String(r.vehicle_type) : null,
        make: r.vehicle_make != null ? String(r.vehicle_make) : null,
        model: r.vehicle_model != null ? String(r.vehicle_model) : null,
        year: r.vehicle_year != null ? Number(r.vehicle_year) : null,
        plate: r.vehicle_plate != null ? String(r.vehicle_plate) : null,
        plateState: r.vehicle_plate_state != null ? String(r.vehicle_plate_state) : null,
        color: r.vehicle_color != null ? String(r.vehicle_color) : null,
      },
      schedule: rowToSchedule({ schedule: r.schedule, source: r.source, owner_override: r.owner_override, updated_at: r.schedule_updated_at }),
      docsExpiringSoon,
      docsExpiringSoonCount: docsExpiringSoon.length,
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
  address: z.string().trim().max(200, "Keep the address under 200 characters.").optional().or(z.literal("")),
});

export type ContractorContactResult = { contractorId: string; phone: string | null; vehicleDesc: string | null; address: string | null };

/** Update the LD-only contact fields (phone + vehicle description + address) on
 *  the contractor's operational profile. These are Lightning-Dispatch-only — never
 *  pushed to Towbook (Towbook's driver-editor phone/vehicle surface is
 *  unverified territory). Upsert + audited ('contractor_contact_updated'). */
export async function setContractorContactCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<ContractorContactResult>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = CONTACT_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Invalid contact details.");
  const phone = v.data.phone && v.data.phone.trim() ? v.data.phone.trim() : null;
  const vehicleDesc = v.data.vehicleDesc && v.data.vehicleDesc.trim() ? v.data.vehicleDesc.trim() : null;
  const address = v.data.address && v.data.address.trim() ? v.data.address.trim() : null;
  try {
    await ensure();
    const q = await db();
    const member = await q`SELECT 1 FROM organization_memberships m WHERE m.org_id=${actor.orgId} AND m.user_id=${v.data.contractorId} AND m.role='contractor' LIMIT 1`;
    if (!member.length) return err("not_found", "That contractor isn't on this account.");
    const before = await q`SELECT phone, vehicle_desc, address FROM contractor_profiles WHERE org_id=${actor.orgId} AND user_id=${v.data.contractorId} LIMIT 1`;
    await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents, phone, vehicle_desc, address, updated_at)
      VALUES(${actor.orgId}, ${v.data.contractorId}, NULL, ${phone}, ${vehicleDesc}, ${address}, NOW())
      ON CONFLICT (org_id, user_id) DO UPDATE SET phone=EXCLUDED.phone, vehicle_desc=EXCLUDED.vehicle_desc, address=EXCLUDED.address, updated_at=NOW()`;
    await recordAudit(actor, "contractor_contact_updated", v.data.contractorId, {
      from: {
        phone: before.length ? (before[0].phone != null ? String(before[0].phone) : null) : null,
        vehicleDesc: before.length ? (before[0].vehicle_desc != null ? String(before[0].vehicle_desc) : null) : null,
        address: before.length ? (before[0].address != null ? String(before[0].address) : null) : null,
      },
      to: { phone, vehicleDesc, address },
    });
    return ok({ contractorId: v.data.contractorId, phone, vehicleDesc, address });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to save the contact details.");
  }
}

/* --------------------- structured vehicle + weekly schedule (v2) --------------------- */

/** Structured vehicle (contractor-management-spec §3.2) — net-new LD-only
 *  columns on contractor_profiles; Towbook has no vehicle data (trucks.json =
 *  id/name/type-code/duty only), so nothing is imported. vehicle_type is the
 *  future AI-dispatcher capability-routing target. Seroval-safe (nulls). */
export type ContractorVehicle = {
  type: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  plate: string | null;
  plateState: string | null;
  color: string | null;
};

/** One weekly-availability entry — day 1 = Monday … 7 = Sunday, 24h "HH:MM"
 *  start/end (start < end). Repeating template, not date-specific shifts. */
export type ScheduleDay = { day: number; start: string; end: string };

/** The (org, contractor) schedule row — contractor-declared by default (owner
 *  decision B 2026-08-12: declared schedule = commitment, GO/Offline = reality);
 *  the owner can OVERRIDE (source='owner' + owner_override=TRUE), after which
 *  driver edits stop applying until the driver declares again. */
export type ContractorScheduleRow = {
  schedule: ScheduleDay[];
  source: "owner" | "contractor";
  ownerOverride: boolean;
  updatedAt: string | null;
};

const VEHICLE_TYPE_OPTIONS = ["Flatbed", "Wheel-lift", "Integrated", "Landoll", "Other"] as const;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "2019 Ford F-350 · Flatbed · CT ABC-123" — non-empty structured fields
 *  joined with " · "; null when nothing is set (the legacy vehicle_desc is then
 *  kept as-is on save). */
export function vehicleDisplayString(v: ContractorVehicle): string | null {
  const parts = [
    [v.year, v.make, v.model].filter((x): x is string | number => x != null && String(x).trim() !== "").map((x) => String(x).trim()).join(" "),
    v.type,
    [v.plateState, v.plate].filter((x): x is string => x != null && x.trim() !== "").map((x) => x.trim()).join(" "),
  ].map((s) => (s ?? "").trim()).filter((s) => s !== "");
  return parts.length ? parts.join(" · ") : null;
}

const VEHICLE_SCHEMA = z.object({
  contractorId: z.string().trim().min(1).max(128),
  type: z.enum(VEHICLE_TYPE_OPTIONS).nullable().optional().or(z.literal("").transform(() => null as string | null)),
  make: z.string().trim().max(60).nullable().optional().or(z.literal("").transform(() => null as string | null)),
  model: z.string().trim().max(60).nullable().optional().or(z.literal("").transform(() => null as string | null)),
  year: z.number().int().min(1980).max(new Date().getFullYear() + 1).nullable().optional(),
  plate: z.string().trim().toUpperCase().max(20).nullable().optional().or(z.literal("").transform(() => null as string | null)),
  plateState: z.string().trim().toUpperCase().max(2).nullable().optional().or(z.literal("").transform(() => null as string | null)),
  color: z.string().trim().max(30).nullable().optional().or(z.literal("").transform(() => null as string | null)),
});

export type ContractorVehicleResult = { contractorId: string; vehicle: ContractorVehicle; vehicleDesc: string | null };

/** Save the contractor's structured vehicle. Upserts contractor_profiles;
 *  when ANY structured field is set, vehicle_desc is overwritten with the
 *  generated display string (keeps legacy consumers non-null); when all fields
 *  are empty, vehicle_desc is left untouched. Audited ('contractor_vehicle_updated'
 *  with from/to). LD-only — never pushed to Towbook. */
export async function setContractorVehicleCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<ContractorVehicleResult>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = VEHICLE_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Invalid vehicle details.");
  const vehicle: ContractorVehicle = {
    type: v.data.type ?? null,
    make: v.data.make ?? null,
    model: v.data.model ?? null,
    year: v.data.year ?? null,
    plate: v.data.plate ?? null,
    plateState: v.data.plateState ?? null,
    color: v.data.color ?? null,
  };
  try {
    await ensure();
    const q = await db();
    const member = await q`SELECT 1 FROM organization_memberships m WHERE m.org_id=${actor.orgId} AND m.user_id=${v.data.contractorId} AND m.role='contractor' LIMIT 1`;
    if (!member.length) return err("not_found", "That contractor isn't on this account.");
    const before = await q`SELECT vehicle_type, vehicle_make, vehicle_model, vehicle_year, vehicle_plate, vehicle_plate_state, vehicle_color, vehicle_desc
      FROM contractor_profiles WHERE org_id=${actor.orgId} AND user_id=${v.data.contractorId} LIMIT 1`;
    const from: ContractorVehicle = {
      type: before.length && before[0].vehicle_type != null ? String(before[0].vehicle_type) : null,
      make: before.length && before[0].vehicle_make != null ? String(before[0].vehicle_make) : null,
      model: before.length && before[0].vehicle_model != null ? String(before[0].vehicle_model) : null,
      year: before.length && before[0].vehicle_year != null ? Number(before[0].vehicle_year) : null,
      plate: before.length && before[0].vehicle_plate != null ? String(before[0].vehicle_plate) : null,
      plateState: before.length && before[0].vehicle_plate_state != null ? String(before[0].vehicle_plate_state) : null,
      color: before.length && before[0].vehicle_color != null ? String(before[0].vehicle_color) : null,
    };
    const display = vehicleDisplayString(vehicle);
    const legacyDesc = before.length && before[0].vehicle_desc != null ? String(before[0].vehicle_desc) : null;
    const vehicleDesc = display ?? legacyDesc;
    await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents, vehicle_type, vehicle_make, vehicle_model, vehicle_year, vehicle_plate, vehicle_plate_state, vehicle_color, vehicle_desc, updated_at)
      VALUES(${actor.orgId}, ${v.data.contractorId}, NULL, ${vehicle.type}, ${vehicle.make}, ${vehicle.model}, ${vehicle.year}, ${vehicle.plate}, ${vehicle.plateState}, ${vehicle.color}, ${vehicleDesc}, NOW())
      ON CONFLICT (org_id, user_id) DO UPDATE SET
        vehicle_type=EXCLUDED.vehicle_type, vehicle_make=EXCLUDED.vehicle_make, vehicle_model=EXCLUDED.vehicle_model,
        vehicle_year=EXCLUDED.vehicle_year, vehicle_plate=EXCLUDED.vehicle_plate, vehicle_plate_state=EXCLUDED.vehicle_plate_state,
        vehicle_color=EXCLUDED.vehicle_color, vehicle_desc=EXCLUDED.vehicle_desc, updated_at=NOW()`;
    await recordAudit(actor, "contractor_vehicle_updated", v.data.contractorId, { from, to: vehicle, vehicleDesc });
    return ok({ contractorId: v.data.contractorId, vehicle, vehicleDesc });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to save the vehicle.");
  }
}

const SCHEDULE_SCHEMA = z.object({
  contractorId: z.string().trim().min(1).max(128),
  schedule: z.array(z.object({
    day: z.number().int().min(1).max(7),
    start: z.string().regex(TIME_RE, "Use 24-hour times like 08:00."),
    end: z.string().regex(TIME_RE, "Use 24-hour times like 17:00."),
  })).max(28),
});

function parseSchedule(data: unknown): { contractorId: string; schedule: ScheduleDay[] } | { error: string } {
  const v = SCHEDULE_SCHEMA.safeParse(data);
  if (!v.success) return { error: v.error.issues[0]?.message ?? "Invalid schedule." };
  const seen = new Set<number>();
  for (const d of v.data.schedule) {
    if (seen.has(d.day)) return { error: "Each day can only appear once." };
    seen.add(d.day);
    if (d.start >= d.end) return { error: `Start time must come before the end time on day ${d.day}.` };
  }
  return { contractorId: v.data.contractorId, schedule: v.data.schedule.map((d) => ({ day: d.day, start: d.start, end: d.end })) };
}

/** Owner/admin: read one contractor's weekly schedule (+ who owns it). */
export async function getContractorScheduleCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<ContractorScheduleRow>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ contractorId: z.string().trim().min(1).max(128) }).safeParse(data);
  if (!v.success) return err("invalid_input", "Invalid contractor.");
  try {
    await ensure();
    const q = await db();
    const member = await q`SELECT 1 FROM organization_memberships m WHERE m.org_id=${actor.orgId} AND m.user_id=${v.data.contractorId} AND m.role='contractor' LIMIT 1`;
    if (!member.length) return err("not_found", "That contractor isn't on this account.");
    const rows = await q`SELECT schedule, source, owner_override, updated_at FROM contractor_schedules
      WHERE org_id=${actor.orgId} AND user_id=${v.data.contractorId} LIMIT 1`;
    return ok(rowToSchedule(rows[0] as Record<string, unknown> | undefined));
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load the schedule.");
  }
}

function rowToSchedule(r: Record<string, unknown> | undefined): ContractorScheduleRow {
  if (!r) return { schedule: [], source: "contractor", ownerOverride: false, updatedAt: null };
  let schedule: ScheduleDay[] = [];
  const raw = r.schedule;
  if (Array.isArray(raw)) {
    schedule = raw.filter((d): d is ScheduleDay =>
      Boolean(d && typeof d === "object" && (d as Record<string, unknown>).day != null
        && typeof (d as Record<string, unknown>).start === "string" && typeof (d as Record<string, unknown>).end === "string"));
  }
  return {
    schedule,
    source: String(r.source ?? "contractor") === "owner" ? "owner" : "contractor",
    ownerOverride: r.owner_override === true,
    updatedAt: r.updated_at != null ? new Date(String(r.updated_at)).toISOString() : null,
  };
}

/** Owner/admin: set (or clear) a contractor's schedule. Taking over ownership:
 *  source='owner' + owner_override=TRUE — the driver's declared availability is
 *  replaced and driver-side edits stop applying. Audited
 *  ('contractor_schedule_set' first time, 'contractor_schedule_override' when
 *  taking over / replacing). */
export async function setContractorScheduleCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<ContractorScheduleRow>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const parsed = parseSchedule(data);
  if ("error" in parsed) return err("invalid_input", parsed.error);
  try {
    await ensure();
    const q = await db();
    const member = await q`SELECT 1 FROM organization_memberships m WHERE m.org_id=${actor.orgId} AND m.user_id=${parsed.contractorId} AND m.role='contractor' LIMIT 1`;
    if (!member.length) return err("not_found", "That contractor isn't on this account.");
    const before = await q`SELECT source, owner_override FROM contractor_schedules
      WHERE org_id=${actor.orgId} AND user_id=${parsed.contractorId} LIMIT 1`;
    const wasOverride = before.length > 0 && before[0].owner_override === true;
    const scheduleJson = JSON.stringify(parsed.schedule);
    await q`INSERT INTO contractor_schedules(org_id, user_id, schedule, source, owner_override, updated_by_user_id, updated_at)
      VALUES(${actor.orgId}, ${parsed.contractorId}, ${scheduleJson}::jsonb, 'owner', TRUE, ${actor.id}, NOW())
      ON CONFLICT (org_id, user_id) DO UPDATE SET
        schedule=EXCLUDED.schedule, source='owner', owner_override=TRUE,
        updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=NOW()`;
    await recordAudit(actor, wasOverride ? "contractor_schedule_override" : "contractor_schedule_set", parsed.contractorId, {
      schedule: parsed.schedule,
      source: "owner",
      ownerOverride: true,
    });
    return ok({ schedule: parsed.schedule, source: "owner", ownerOverride: true, updatedAt: new Date().toISOString() });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to save the schedule.");
  }
}

const MY_SCHEDULE_SCHEMA = z.object({
  schedule: z.array(z.object({
    day: z.number().int().min(1).max(7),
    start: z.string().regex(TIME_RE, "Use 24-hour times like 08:00."),
    end: z.string().regex(TIME_RE, "Use 24-hour times like 17:00."),
  })).max(28),
});

/** The acting driver's own schedule — the actor's id IS the effective driver's
 *  row id (resolveContractorActor resolves through the view-toggle resolver, so
 *  an owner in driver view manages their own contractor identity's schedule). */
export async function getMyScheduleCore(actor: ContractorAdminActor): Promise<ContractorAdminResult<ContractorScheduleRow>> {
  if (actor.role !== "contractor") return err("unauthorized", "Driver access required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT schedule, source, owner_override, updated_at FROM contractor_schedules
      WHERE org_id=${actor.orgId} AND user_id=${actor.id} LIMIT 1`;
    return ok(rowToSchedule(rows[0] as Record<string, unknown> | undefined));
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load your schedule.");
  }
}

/** The acting driver declares their own weekly availability (source='contractor',
 *  owner_override=FALSE). Refused while the owner has OVERRIDDEN the schedule —
 *  the driver sees "Set by owner" and can't silently replace it; clearing the
 *  override happens here: a driver save while overridden is REJECTED (the owner
 *  must clear it, or the driver's next declaration after the owner clears it
 *  applies). Audited ('contractor_schedule_set'). */
export async function setMyScheduleCore(actor: ContractorAdminActor, data: unknown): Promise<ContractorAdminResult<ContractorScheduleRow>> {
  if (actor.role !== "contractor") return err("unauthorized", "Driver access required.");
  const v = MY_SCHEDULE_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Invalid schedule.");
  const seen = new Set<number>();
  for (const d of v.data.schedule) {
    if (seen.has(d.day)) return err("invalid_input", "Each day can only appear once.");
    seen.add(d.day);
    if (d.start >= d.end) return err("invalid_input", "Start time must come before the end time.");
  }
  try {
    await ensure();
    const q = await db();
    const existing = await q`SELECT owner_override FROM contractor_schedules
      WHERE org_id=${actor.orgId} AND user_id=${actor.id} LIMIT 1`;
    if (existing.length > 0 && existing[0].owner_override === true) {
      return err("invalid_input", "Your schedule is set by the owner right now — reach out to dispatch if your availability changed.");
    }
    const scheduleJson = JSON.stringify(v.data.schedule);
    await q`INSERT INTO contractor_schedules(org_id, user_id, schedule, source, owner_override, updated_by_user_id, updated_at)
      VALUES(${actor.orgId}, ${actor.id}, ${scheduleJson}::jsonb, 'contractor', FALSE, ${actor.id}, NOW())
      ON CONFLICT (org_id, user_id) DO UPDATE SET
        schedule=EXCLUDED.schedule, source='contractor', owner_override=FALSE,
        updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=NOW()`;
    await recordAudit(actor, "contractor_schedule_set", actor.id, {
      schedule: v.data.schedule,
      source: "contractor",
      ownerOverride: false,
    });
    return ok({ schedule: v.data.schedule, source: "contractor", ownerOverride: false, updatedAt: new Date().toISOString() });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to save your schedule.");
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
    const rows = await q`SELECT t.id AS doc_type_id, t.name AS doc_type_name, t.requires_expiry, t.requires_facial_verification, t.form_kind, t.requires_notifications_location, t.sort_order,
        d.id AS doc_id, d.file_name, d.mime, d.size_bytes, d.expires_on, d.review_note, d.uploaded_at, d.uploaded_by_user_id, d.status AS stored_status,
        s.file_name AS selfie_file_name, s.uploaded_at AS selfie_uploaded_at
      FROM contractor_doc_types t
      LEFT JOIN contractor_documents d ON d.org_id=${actor.orgId} AND d.contractor_id=${contractorId} AND d.doc_type_id=t.id
      LEFT JOIN contractor_doc_selfies s ON s.org_id=${actor.orgId} AND s.contractor_id=${contractorId} AND s.doc_type_id=t.id
      WHERE t.org_id=${actor.orgId} AND t.active=TRUE
      ORDER BY t.sort_order ASC, t.created_at ASC`;
    const out: ContractorDocumentRow[] = (rows as Record<string, unknown>[]).map((r) => {
      const storedStatus = r.stored_status != null ? String(r.stored_status) : null;
      const expiresOn = formatYmd(r.expires_on);
      const status = storedStatus ? deriveDocStatus(storedStatus, expiresOn) : "missing";
      const formKind = r.form_kind === "i9" || r.form_kind === "w9" ? (r.form_kind as FormKind) : null;
      return {
        docTypeId: String(r.doc_type_id),
        docTypeName: String(r.doc_type_name),
        requiresExpiry: r.requires_expiry === true,
        requiresFacialVerification: r.requires_facial_verification === true,
        formKind,
        formViewableByDriver: formKind === null,
        requiresNotificationsLocation: r.requires_notifications_location === true,
        status,
        docId: r.doc_id != null ? String(r.doc_id) : null,
        fileName: r.file_name != null ? String(r.file_name) : null,
        mime: r.mime != null ? String(r.mime) : null,
        sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
        expiresOn,
        reviewNote: r.review_note != null ? String(r.review_note) : null,
        uploadedAt: r.uploaded_at != null ? new Date(String(r.uploaded_at)).toISOString() : null,
        uploadedByUserId: r.uploaded_by_user_id != null ? String(r.uploaded_by_user_id) : null,
        selfieStatus: r.selfie_file_name != null ? "uploaded" : "missing",
        selfieFileName: r.selfie_file_name != null ? String(r.selfie_file_name) : null,
        selfieUploadedAt: r.selfie_uploaded_at != null ? new Date(String(r.selfie_uploaded_at)).toISOString() : null,
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
    const type = await q`SELECT id, name, requires_expiry, form_kind, active FROM contractor_doc_types WHERE id=${v.data.docTypeId} AND org_id=${actor.orgId} LIMIT 1`;
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

/* ------------------------ live selfie (facial-verification pair) ------------------------ */

const SELFIE_SCHEMA = z.object({
  docTypeId: z.string().trim().min(1).max(128),
  dataUrl: z.string().min(20).max(20_000_000),
  fileName: z.string().trim().max(200).optional().or(z.literal("")),
});

export type UploadSelfieResult =
  | { ok: true; storageKey: string }
  | { ok: false; code: "unauthorized" | "invalid_input" | "not_found" | "b2_not_configured" | "b2_failed" | "database_error"; message: string };

/** The live selfie half of a facial-verification pair (owner-directed
 *  2026-08-12): only valid for a type with requires_facial_verification=TRUE
 *  and active. Storage key ld-docs/<org>/<driver>/<docTypeId>.selfie.<ext>;
 *  images only (a selfie is never a PDF — the allowlist is
 *  image/jpeg|png|webp); re-upload UPSERTs the same row + overwrites the same
 *  B2 object. Audited ('contractor_doc_selfie_uploaded'). */
export async function uploadMySelfieCore(actor: ContractorAdminActor, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<UploadSelfieResult> {
  if (actor.role !== "contractor") return { ok: false, code: "unauthorized", message: "Driver access required." };
  const v = SELFIE_SCHEMA.safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_input", message: v.error.issues[0]?.message ?? "Invalid upload." };
  const decoded = decodeDocumentDataUrl(v.data.dataUrl);
  if (!decoded) return { ok: false, code: "invalid_input", message: "That file type isn't supported — use JPG, PNG or WebP." };
  if (decoded.mime === "application/pdf") return { ok: false, code: "invalid_input", message: "A live selfie must be a photo — use JPG, PNG or WebP." };
  if (decoded.bytes.length < 1024) return { ok: false, code: "invalid_input", message: "The photo looks empty — try again." };
  if (decoded.bytes.length > 12 * 1024 * 1024) return { ok: false, code: "invalid_input", message: "The photo is too large (max 12 MB)." };
  try {
    await ensure();
    const q = await db();
    const type = await q`SELECT id, name, requires_facial_verification, active FROM contractor_doc_types WHERE id=${v.data.docTypeId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!type.length || type[0].active !== true) return { ok: false, code: "not_found", message: "That document type isn't required on your account." };
    if (type[0].requires_facial_verification !== true) {
      return { ok: false, code: "invalid_input", message: "This document type doesn't need a live selfie." };
    }
    const ext = DOC_EXT[decoded.mime];
    const key = `ld-docs/${actor.orgId}/${actor.id}/${v.data.docTypeId}.selfie.${ext}`;
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
    await q`INSERT INTO contractor_doc_selfies(id, org_id, contractor_id, doc_type_id, storage_key, file_name, mime, size_bytes, uploaded_by_user_id, updated_at)
      VALUES(gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${v.data.docTypeId}, ${key}, ${fileName}, ${decoded.mime}, ${decoded.bytes.length}, ${actor.id}, NOW())
      ON CONFLICT (org_id, contractor_id, doc_type_id) DO UPDATE SET
        storage_key=EXCLUDED.storage_key, file_name=EXCLUDED.file_name, mime=EXCLUDED.mime,
        size_bytes=EXCLUDED.size_bytes, uploaded_by_user_id=EXCLUDED.uploaded_by_user_id, uploaded_at=NOW(), updated_at=NOW()`;
    await recordAudit(actor, "contractor_doc_selfie_uploaded", v.data.docTypeId, {
      docTypeId: v.data.docTypeId,
      docTypeName: String(type[0].name),
      storageKey: key,
      fileName,
      mime: decoded.mime,
      sizeBytes: decoded.bytes.length,
    });
    return { ok: true, storageKey: key };
  } catch (e) {
    return { ok: false, code: "database_error", message: e instanceof Error ? e.message : "Unable to upload the selfie." };
  }
}

/** Read a stored selfie from B2 (base64 + mime for view/download). Owner/admin:
 *  any selfie in the org. Contractor: own only — cross-contractor reads are
 *  rejected. */
export async function getSelfieFileCore(actor: ContractorAdminActor, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<ContractorAdminResult<DocFilePayload>> {
  const v = z.object({ docTypeId: z.string().trim().min(1).max(128) }).safeParse(data);
  if (!v.success) return err("invalid_input", "Invalid document.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, contractor_id, storage_key, file_name, mime, size_bytes FROM contractor_doc_selfies WHERE doc_type_id=${v.data.docTypeId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!rows.length) return err("not_found", "No selfie on file for that document.");
    const row = rows[0] as Record<string, unknown>;
    if (actor.role === "contractor" && String(row.contractor_id) !== actor.id) {
      return err("unauthorized", "This selfie belongs to another contractor.");
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
    return err("database_error", e instanceof Error ? e.message : "Unable to load the selfie.");
  }
}

/* -------------------- compliance summary + GO/Offline gate (part 3) -------------------- */

/** The driver-facing compliance snapshot — counts + names for the Home
 *  compliance chip and the Documents screen header. Derived from the SAME
 *  read-time rules as the roster counts, with the part-3 addition that a
 *  facial-verification pair only counts once its live selfie is on file.
 *  approved = derived status 'verified' (pair complete); onFile = present +
 *  not expired/rejected (uploaded or verified); needed = the driver can act
 *  (missing / expired / rejected); pending = awaiting the owner's review
 *  (uploaded). Seroval-safe. */
export type MyCompliance = {
  required: number;
  approved: number;
  onFile: number;
  neededCount: number;
  pendingCount: number;
  neededNames: string[];
  pendingNames: string[];
};
export async function getMyComplianceCore(actor: ContractorAdminActor): Promise<ContractorAdminResult<MyCompliance>> {
  if (actor.role !== "contractor") return err("unauthorized", "Driver access required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT t.id AS doc_type_id, t.name AS doc_type_name, t.requires_facial_verification,
        d.status AS stored_status, d.expires_on,
        (s.id IS NOT NULL) AS has_selfie
      FROM contractor_doc_types t
      LEFT JOIN contractor_documents d ON d.org_id=${actor.orgId} AND d.contractor_id=${actor.id} AND d.doc_type_id=t.id
      LEFT JOIN contractor_doc_selfies s ON s.org_id=${actor.orgId} AND s.contractor_id=${actor.id} AND s.doc_type_id=t.id
      WHERE t.org_id=${actor.orgId} AND t.active=TRUE`;
    let required = 0, approved = 0, onFile = 0, neededCount = 0, pendingCount = 0;
    const neededNames: string[] = [];
    const pendingNames: string[] = [];
    for (const r of rows as Record<string, unknown>[]) {
      required += 1;
      const name = String(r.doc_type_name ?? "");
      const pairComplete = r.requires_facial_verification !== true || r.has_selfie === true;
      const stored = r.stored_status != null ? String(r.stored_status) : null;
      const expiresOn = formatYmd(r.expires_on);
      const status = stored ? deriveDocStatus(stored, expiresOn) : "missing";
      const isVerified = status === "verified";
      if (isVerified && pairComplete) { approved += 1; onFile += 1; continue; }
      if ((status === "uploaded" || status === "verified") && pairComplete) { onFile += 1; }
      if (status === "missing" || status === "expired" || status === "rejected") { neededCount += 1; neededNames.push(name); continue; }
      if (status === "uploaded") { pendingCount += 1; pendingNames.push(name); continue; }
      // verified-but-pair-incomplete (selfie missing) → the driver must act
      if (!pairComplete) { neededCount += 1; neededNames.push(`${name} — live selfie`); }
    }
    return ok({ required, approved, onFile, neededCount, pendingCount, neededNames, pendingNames });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load your compliance.");
  }
}

/** The GO/Offline compliance gate (part 3, owner-directed 2026-08-12):
 *  going online is BLOCKED until EVERY active required type is approved —
 *  derived status 'verified' with the selfie present on facial-verification
 *  types. Returns the driver-facing block message (white-label, points at the
 *  Documents screen) with the approved/required counts; ok when compliant.
 *  Shared by driverSetAvailability (driver-auth) and the Home surface — the
 *  owner-in-driver-view session resolves to the same effective driver, so the
 *  gate is identical for staff driving from the contractor app. */
export async function getComplianceGateCore(actor: ContractorAdminActor): Promise<
  { ok: true } | { ok: false; code: "docs_incomplete"; approved: number; required: number; message: string }
> {
  if (actor.role !== "contractor") return { ok: true };
  const r = await getMyComplianceCore(actor);
  if (!r.ok) return { ok: true }; // gate fails OPEN on read errors — never strand a driver over a DB hiccup
  const c = r.data;
  if (c.required === 0) return { ok: true };
  if (c.approved >= c.required) return { ok: true };
  const pendingNote = c.pendingCount > 0 ? ` ${c.pendingCount} submitted doc${c.pendingCount === 1 ? "" : "s"} ${c.pendingCount === 1 ? "is" : "are"} awaiting the owner's review.` : "";
  return {
    ok: false,
    code: "docs_incomplete",
    approved: c.approved,
    required: c.required,
    message: `You can't go online yet — ${c.approved} of ${c.required} required documents are approved.${pendingNote} Open Documents (Profile → Documents) to upload the rest.`,
  };
}

/* ---------------- Notifications & Location (self-completed, owner 2026-08-13) ---------------- */

const NOTIF_LOC_SCHEMA = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000).nullable().optional(),
});

/** The "Notifications & Location" REQUIRED item (owner-directed 2026-08-13):
 *  the driver completes it IN the driver app — this endpoint verifies BOTH
 *  halves server-side before marking the doc verified:
 *    1. a REAL push subscription is saved for this contractor
 *       (push_subscriptions row — set up by the fixed push-setup flow), and
 *    2. a REAL geolocation fix captured in THIS call (stored as a
 *       driver_locations ping — the same table the owner live map reads).
 *  Only then is the contractor_documents row for the org's active
 *  "Notifications & Location" type flipped to 'verified' — the SAME status the
 *  compliance gate requires from every required type, so going online stays
 *  blocked until it's done. No owner review (the proof is the rows, not a
 *  photo). Never throws; audited. */
export type CompleteNotificationsLocationResult =
  | { ok: true; document: ContractorDocumentRow }
  | { ok: false; code: ContractorAdminErrorCode; message: string };

export async function completeNotificationsLocationCore(
  actor: ContractorAdminActor,
  data: unknown,
): Promise<CompleteNotificationsLocationResult> {
  if (actor.role !== "contractor") return err("unauthorized", "Driver access required.");
  const v = NOTIF_LOC_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", "We need a valid location fix to mark this complete.");
  // Geolocation-denied sentinel — never mark complete on a 0,0 fix (mirrors
  // driver-gps-core evaluateGeofence: 0,0 means the browser refused).
  if (v.data.latitude === 0 && v.data.longitude === 0) {
    return err("invalid_input", "Your location couldn't be read. Allow location for this site in your browser settings, then try again.");
  }
  try {
    await ensure();
    const q = await db();
    const types = await q`SELECT id FROM contractor_doc_types WHERE org_id=${actor.orgId} AND active=TRUE AND requires_notifications_location=TRUE ORDER BY created_at ASC LIMIT 1`;
    if (!types.length) return err("not_found", "Notifications & Location isn't a required item on this account.");
    const docTypeId = String(types[0].id);
    const subs = await q`SELECT COUNT(*)::int AS c FROM push_subscriptions WHERE org_id=${actor.orgId} AND user_id=${actor.id}`;
    if (Number(subs[0]?.c ?? 0) === 0) {
      return err("invalid_input", "Enable notifications first — tap “Allow notifications” and make sure your phone confirms they're on.");
    }
    // Real GPS fix → real driver_locations ping (owner live map sees it too).
    await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, job_id, latitude, longitude, accuracy)
      VALUES(gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, NULL, NULL, ${v.data.latitude}, ${v.data.longitude}, ${v.data.accuracy ?? null})`;
    // Flip the doc to verified (upsert — the unique (org, contractor, type) index).
    const id = `doc-${cryptoRandomId()}`;
    const rows = await q`INSERT INTO contractor_documents(id, org_id, contractor_id, doc_type_id, storage_key, file_name, mime, size_bytes, status, uploaded_by_user_id, uploaded_at, updated_at)
      VALUES(${id}, ${actor.orgId}, ${actor.id}, ${docTypeId}, 'permissions://notifications-location', 'Notifications + location enabled', NULL, NULL, 'verified', ${actor.id}, NOW(), NOW())
      ON CONFLICT (org_id, contractor_id, doc_type_id) DO UPDATE SET
        status='verified', storage_key='permissions://notifications-location', file_name='Notifications + location enabled', review_note=NULL, updated_at=NOW()
      RETURNING id, doc_type_id, status, expires_on, review_note, uploaded_at, uploaded_by_user_id`;
    const row = rows[0] as Record<string, unknown>;
    await recordAudit(actor, "contractor_doc_verified", String(row.id), {
      docTypeId,
      name: "Notifications & Location",
      via: "driver-self-complete",
      latitude: v.data.latitude,
      longitude: v.data.longitude,
    });
    const nameRows = await q`SELECT name FROM contractor_doc_types WHERE id=${docTypeId}`;
    const doc: ContractorDocumentRow = {
      docTypeId,
      docTypeName: String(nameRows[0]?.name ?? "Notifications & Location"),
      requiresExpiry: false,
      requiresFacialVerification: false,
      formKind: null,
      formViewableByDriver: false,
      requiresNotificationsLocation: true,
      status: "verified",
      docId: String(row.id),
      fileName: String(row.file_name ?? "Notifications + location enabled"),
      mime: null,
      sizeBytes: null,
      expiresOn: null,
      reviewNote: null,
      uploadedAt: new Date(String(row.uploaded_at)).toISOString(),
      uploadedByUserId: String(row.uploaded_by_user_id ?? actor.id),
      selfieStatus: "missing",
      selfieFileName: null,
      selfieUploadedAt: null,
    };
    return { ok: true, document: doc };
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to complete this item.");
  }
}

/* ----------------------- mandated doc set seed (owner-directed) ----------------------- */

/** The owner-mandated required doc set (2026-08-12): W-9, I-9, Driver's license
 *  with facial verification (license photo + live selfie pair, both required),
 *  and Insurance information. This SUPERSEDES the spec's original "suggestions,
 *  never auto-seeded" stance: the set is auto-seeded for the PRODUCTION org at
 *  server boot (serve.ts) so the owner's real drivers see the mandated types on
 *  day one, and owner/admin can seed any org on demand from the Required-
 *  documents editor ("Add standard set"). Idempotent — existing types
 *  (case-insensitive) are left untouched; missing ones are appended.
 *  formKind (owner-directed 2026-08-12): W-9 and I-9 are FILLABLE OFFICIAL
 *  FORMS — the driver fills the form instead of uploading a photo. */
export const MANDATED_DOC_TYPES: Array<{ name: string; requiresExpiry: boolean; requiresFacialVerification: boolean; formKind: FormKind | null; requiresNotificationsLocation?: boolean }> = [
  { name: "W-9", requiresExpiry: false, requiresFacialVerification: false, formKind: "w9" },
  { name: "I-9", requiresExpiry: false, requiresFacialVerification: false, formKind: "i9" },
  { name: "Driver's License", requiresExpiry: true, requiresFacialVerification: true, formKind: null },
  { name: "Insurance information", requiresExpiry: true, requiresFacialVerification: false, formKind: null },
  // Owner-directed 2026-08-13: EVERY driver must enable notifications +
  // location. This is a SELF-COMPLETED item (no owner review): the driver
  // grants notifications (saving a real push subscription) and shares a live
  // GPS fix; completeNotificationsLocationCore verifies both server-side and
  // flips the doc to 'verified'. The SAME compliance gate enforces it — going
  // online is blocked until every required item, this one included, is done.
  { name: "Notifications & Location", requiresExpiry: false, requiresFacialVerification: false, formKind: null, requiresNotificationsLocation: true },
];

/** Core seeding logic — throws on failure so callers decide how to surface it.
 *  Returns the newly ADDED rows (empty when everything already existed).
 *  Audit rows are written per ADDED type (best-effort, never masks the seed):
 *  under auditActor when seeded from the portal, or the org's first owner/admin
 *  member when seeded system-side (boot); no member row → audit rows skipped. */
async function seedMandatedDocTypesUnsafe(orgId: string, auditActor?: ContractorAdminActor | null): Promise<DocTypeRow[]> {
  await ensure();
  const q = await db();
  const existing = await q`SELECT LOWER(name) AS n FROM contractor_doc_types WHERE org_id=${orgId}`;
  const have = new Set((existing as Record<string, unknown>[]).map((r) => String(r.n)));
  const added: DocTypeRow[] = [];
  let sortOrder = await nextSortOrder(orgId);
  for (const m of MANDATED_DOC_TYPES) {
    if (have.has(m.name.toLowerCase())) continue;
    const id = `dt-${cryptoRandomId()}`;
    const inserted = await q`INSERT INTO contractor_doc_types(id, org_id, name, requires_expiry, requires_facial_verification, form_kind, requires_notifications_location, sort_order)
      VALUES(${id}, ${orgId}, ${m.name}, ${m.requiresExpiry}, ${m.requiresFacialVerification}, ${m.formKind}, ${m.requiresNotificationsLocation === true}, ${sortOrder})
      ON CONFLICT (org_id, LOWER(name)) DO NOTHING`;
    // Race-proof idempotency backstop: a concurrent seed (or a migration
    // backfill) may have created the row between our read and this insert.
    // ON CONFLICT skips it; only a real insert counts as ADDED (audited below).
    const affected = Number((inserted as { count?: unknown })?.count ?? 1);
    if (!(affected > 0)) continue;
    added.push({ id, name: m.name, requiresExpiry: m.requiresExpiry, requiresFacialVerification: m.requiresFacialVerification, formKind: m.formKind, requiresNotificationsLocation: m.requiresNotificationsLocation === true, sortOrder, active: true, createdAt: new Date().toISOString() });
    sortOrder += 1;
  }
  if (added.length) {
    const actor = auditActor ?? (await firstManagerActor(orgId));
    if (actor) {
      for (const r of added) {
        await recordAudit(actor, "contractor_doc_type_added", r.id, { name: r.name, requiresExpiry: r.requiresExpiry, requiresFacialVerification: r.requiresFacialVerification, formKind: r.formKind, sortOrder: r.sortOrder });
      }
    }
  }
  return added;
}

/** Idempotent mandated-set seed for ANY org (server boot + tests). Best-effort:
 *  a DB failure returns [] — the boot path must never take the server down. */
export async function ensureMandatedDocTypesForOrg(orgId: string, auditActor?: ContractorAdminActor | null): Promise<DocTypeRow[]> {
  try {
    return await seedMandatedDocTypesUnsafe(orgId, auditActor);
  } catch {
    return [];
  }
}

/** The org's first owner/admin member (system-side audit attribution). */
async function firstManagerActor(orgId: string): Promise<ContractorAdminActor | null> {
  try {
    const q = await db();
    const rows = await q`SELECT m.user_id AS id, m.role FROM organization_memberships m
      WHERE m.org_id=${orgId} AND m.role IN ('owner','admin')
      ORDER BY (m.role = 'owner') DESC, m.user_id ASC LIMIT 1`;
    return rows.length ? { orgId, id: String(rows[0].id), role: String(rows[0].role) } : null;
  } catch {
    return null;
  }
}

/** Owner/admin portal entry point ("Add standard set" button): seeds the
 *  mandated types for the acting owner's org (idempotent), audited under them. */
export async function seedMandatedDocTypesCore(actor: ContractorAdminActor): Promise<ContractorAdminResult<DocTypeRow[]>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    return ok(await seedMandatedDocTypesUnsafe(actor.orgId, actor));
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to add the standard document set.");
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
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return null;
  // Owner↔contractor view toggle: an owner/admin in driver view resolves to
  // their effective driver identity — docs live on the linked driver's row
  // (spec §2: contractor_documents.contractor_id = linked driver user row id,
  // or own row id for shape a), so the actor id IS the driver's row id here.
  return { orgId: u.orgId, id: identity.userRowId, role: "contractor" };
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
export async function uploadMySelfieHandler(data: unknown, opts?: { fetchImpl?: typeof fetch }): Promise<UploadSelfieResult> {
  if (!configured()) return { ok: false, code: "database_error", message: "Selfie uploads require database mode." };
  const actor = await resolveContractorActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Driver access required." };
  return uploadMySelfieCore(actor, data, opts);
}
export async function getSelfieFileHandler(data: unknown, opts?: { fetchImpl?: typeof fetch }): Promise<ContractorAdminResult<DocFilePayload>> {
  if (!configured()) return DB_MODE_ERR("Documents");
  const actor = await resolveOwnerOrContractorActor();
  if (!actor) return err("unauthorized", "Sign in first.");
  return getSelfieFileCore(actor, data, opts);
}
export async function getMyComplianceHandler(): Promise<ContractorAdminResult<MyCompliance>> {
  if (!configured()) return DB_MODE_ERR("Compliance");
  const actor = await resolveContractorActor();
  if (!actor) return err("unauthorized", "Driver access required.");
  return getMyComplianceCore(actor);
}
export async function getComplianceGateHandler(): Promise<{ ok: true } | { ok: false; code: "docs_incomplete"; approved: number; required: number; message: string }> {
  if (!configured()) return { ok: true };
  const actor = await resolveContractorActor();
  if (!actor) return { ok: true };
  return getComplianceGateCore(actor);
}
/** Driver completes the "Notifications & Location" required item (owner-directed
 *  2026-08-13): grants notifications (push subscription saved) + shares a live
 *  GPS fix. The server verifies both and marks the doc verified — the SAME
 *  compliance gate then opens. Owner-in-driver-view resolves to the same
 *  effective driver. */
export async function completeNotificationsLocationHandler(data: unknown): Promise<CompleteNotificationsLocationResult> {
  if (!configured()) return err("database_error", "Notifications & Location requires database mode.");
  const actor = await resolveContractorActor();
  if (!actor) return err("unauthorized", "Driver access required.");
  return completeNotificationsLocationCore(actor, data);
}
export async function seedMandatedDocTypesHandler(): Promise<ContractorAdminResult<DocTypeRow[]>> {
  if (!configured()) return DB_MODE_ERR("Document types");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return seedMandatedDocTypesCore(actor);
}
export async function setContractorVehicleHandler(data: unknown): Promise<ContractorAdminResult<ContractorVehicleResult>> {
  if (!configured()) return DB_MODE_ERR("Contractor details");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return setContractorVehicleCore(actor, data);
}
export async function getContractorScheduleHandler(data: unknown): Promise<ContractorAdminResult<ContractorScheduleRow>> {
  if (!configured()) return DB_MODE_ERR("Schedule");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return getContractorScheduleCore(actor, data);
}
export async function setContractorScheduleHandler(data: unknown): Promise<ContractorAdminResult<ContractorScheduleRow>> {
  if (!configured()) return DB_MODE_ERR("Schedule");
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return setContractorScheduleCore(actor, data);
}
export async function getMyScheduleHandler(): Promise<ContractorAdminResult<ContractorScheduleRow>> {
  if (!configured()) return DB_MODE_ERR("Schedule");
  const actor = await resolveContractorActor();
  if (!actor) return err("unauthorized", "Driver access required.");
  return getMyScheduleCore(actor);
}
export async function setMyScheduleHandler(data: unknown): Promise<ContractorAdminResult<ContractorScheduleRow>> {
  if (!configured()) return DB_MODE_ERR("Schedule");
  const actor = await resolveContractorActor();
  if (!actor) return err("unauthorized", "Driver access required.");
  return setMyScheduleCore(actor, data);
}

async function resolveOwnerOrContractorActor(): Promise<ContractorAdminActor | null> {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  return { orgId: u.orgId, id: u.id, role: u.role };
}

/* ---------------- official fillable forms — serverFn entry points (2026-08-12) ---------------- */

export { submitW9FormCore, submitI9FormCore, getFormSubmissionCore, getFormDocFileCore, reviewI9Section2Core } from "./form-docs-core";
export type { FormSubmissionView, SubmitFormResult, I9IdentityDocRow } from "./form-docs-core";

export async function submitW9FormHandler(data: unknown): Promise<SubmitFormResult> {
  const actor = await resolveContractorActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Driver access required." };
  return submitW9FormCore(actor, data);
}

export async function submitI9FormHandler(data: unknown): Promise<SubmitFormResult> {
  const actor = await resolveContractorActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Driver access required." };
  return submitI9FormCore(actor, data);
}

export async function getFormSubmissionHandler(data: unknown): Promise<ContractorAdminResult<FormSubmissionView>> {
  const owner = await resolveOwnerActor();
  if (owner) return getFormSubmissionCore(owner, data);
  const contractor = await resolveContractorActor();
  if (!contractor) return err("unauthorized", "Sign in to continue.");
  return getFormSubmissionCore(contractor, data);
}

export async function getFormDocFileHandler(data: unknown): Promise<ContractorAdminResult<DocFilePayload>> {
  const owner = await resolveOwnerActor();
  if (owner) return getFormDocFileCore(owner, data);
  const contractor = await resolveContractorActor();
  if (!contractor) return err("unauthorized", "Sign in to continue.");
  return getFormDocFileCore(contractor, data);
}

export async function reviewI9Section2Handler(data: unknown): Promise<ContractorAdminResult<{ docId: string; status: "verified" | "rejected" }>> {
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return reviewI9Section2Core(actor, data);
}
