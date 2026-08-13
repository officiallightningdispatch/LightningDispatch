/**
 * Official fillable forms (W-9 + I-9) — SERVER-ONLY core (owner-directed
 * 2026-08-12). The W-9 / I-9 required docs are FILLABLE OFFICIAL FORMS, not
 * photo uploads: the driver fills the official fields in-app; this module
 * generates the completed official-form PDF (src/data/form-pdf.ts — faithful
 * replica, same OMB/edition identifiers) and stores it in private B2 under
 * ld-docs/<org>/<driver>/<docTypeId>.pdf, then upserts the (contractor,
 * doc_type) contractor_documents row with status 'uploaded' — the existing
 * compliance gate, owner verify/reject, and roster counts work UNCHANGED.
 *
 * SENSITIVITY (owner-directed): the SSN/EIN never sits in the DB plaintext —
 * tax_id_encrypted is AES-256-GCM under the dedicated bank.key (same envelope
 * as bank rails); the tax id is never in the payload, never in audit detail,
 * and never rendered to the contractor after submission (the completed PDF is
 * owner-only — contractor-admin-core's getDocumentFileCore refuses contractor
 * reads of form docs).
 *
 * Imported ONLY by the server-only contractor-admin-core (type imports create
 * no runtime cycle) and hermetic tests — never by client-reachable modules.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { loadB2Config, authorizeAccount, putObject, getObject } from "./b2-client";
import { encryptBankValue, decryptBankValue } from "./bank-key";
import { buildW9Pdf, buildI9Pdf } from "./form-pdf";
import type { W9PdfValues, I9PdfValues } from "./form-pdf";
import type { ContractorAdminActor, ContractorAdminErrorCode, DocFilePayload, DocStatus } from "./contractor-admin-core";

/* ------------------------------ minimal locals ------------------------------ */

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
const OWNER_ROLES = ["owner", "admin"];
const canManage = (a: ContractorAdminActor) => OWNER_ROLES.includes(a.role);
const cryptoRandomId = () => randomBytes(16).toString("hex");
const err = (code: ContractorAdminErrorCode, message: string) => ({ ok: false as const, code, message });
const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });

/** DATE columns → canonical YYYY-MM-DD (mirrors contractor-admin-core). */
function formatYmd(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[0];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Mirrors contractor-admin-core's deriveDocStatus (read-time date wins). */
function deriveDocStatus(storedStatus: string | null | undefined, expiresOn: string | null | undefined): DocStatus {
  if (expiresOn && expiresOn < new Date().toISOString().slice(0, 10)) return "expired";
  switch (storedStatus) {
    case "verified": return "verified";
    case "expired": return "expired";
    case "rejected": return "rejected";
    default: return "uploaded";
  }
}

const DOC_MIME_ALLOWLIST = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
const DOC_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
function decodeDocumentDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!(DOC_MIME_ALLOWLIST as readonly string[]).includes(mime)) return null;
  return { bytes: new Uint8Array(Buffer.from(m[2], "base64")), mime };
}

async function recordAudit(actor: ContractorAdminActor, action: string, entityId: string, detail: Record<string, unknown>): Promise<void> {
  try {
    const q = await db();
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, ${action}, 'contractor', ${entityId}, ${JSON.stringify(detail)}::jsonb, 'contractor-admin'`;
  } catch { /* audit is best-effort — never masks the outcome */ }
}

/* --------------------------------- schemas --------------------------------- */

const MM_DD_YYYY = /^\d{2}\/\d{2}\/\d{4}$/;
const ZIP_RE = /^[0-9]{5}(-[0-9]{4})?$/;
const TAX_CLASSIFICATIONS = ["individual", "c_corp", "s_corp", "partnership", "trust_estate", "llc", "other"] as const;
const LLC_TAX_CLASSES = ["c", "s", "p", "other"] as const;
const CITIZENSHIP = ["citizen", "noncitizen_national", "lpr", "noncitizen_authorized"] as const;

const todayMmddyyyy = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
};

const W9_SCHEMA = z
  .object({
    docTypeId: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1, "Enter the name shown on your tax return.").max(120),
    businessName: z.string().trim().max(120).optional().or(z.literal("")),
    taxClassification: z.enum(TAX_CLASSIFICATIONS),
    llcTaxClass: z.enum(LLC_TAX_CLASSES).optional().or(z.literal("")),
    otherDescription: z.string().trim().max(120).optional().or(z.literal("")),
    payeeCode: z.string().trim().max(20).optional().or(z.literal("")),
    exemptionCode: z.string().trim().max(20).optional().or(z.literal("")),
    fatcaCode: z.string().trim().max(20).optional().or(z.literal("")),
    address: z.string().trim().min(1, "Enter your address.").max(160),
    city: z.string().trim().min(1, "Enter your city.").max(80),
    state: z.string().trim().min(2, "Enter the two-letter state.").max(2),
    zip: z.string().trim().regex(ZIP_RE, "Enter a valid ZIP code."),
    accountNumbers: z.string().trim().max(120).optional().or(z.literal("")),
    requesterName: z.string().trim().max(120).optional().or(z.literal("")),
    requesterAddress: z.string().trim().max(200).optional().or(z.literal("")),
    taxIdType: z.enum(["ssn", "ein"]),
    taxId: z.string().trim().regex(/^[0-9]{9}$/, "Enter the 9-digit number (no dashes)."),
    signature: z.string().trim().min(1, "Type your name to sign.").max(120),
    date: z.string().trim().regex(MM_DD_YYYY, "Use mm/dd/yyyy.").optional().or(z.literal("")),
  })
  .refine(
    // SSN area codes 001–099 (e.g. Connecticut 040–049) ARE legitimately
    // issued — only 000, 666, and 900–999 are invalid for SSNs (owner-hit
    // 2026-08-13: a valid CT SSN starting "04x" was refused). EINs (taxIdType
    // "ein") are unaffected by the SSN area-code rules.
    (v) => v.taxId !== "000000000" && !(v.taxIdType === "ssn" && (v.taxId.slice(0, 3) === "000" || v.taxId.slice(0, 3) === "666" || v.taxId.startsWith("9"))),
    { message: "That tax ID doesn't look valid — check the number.", path: ["taxId"] },
  );

const I9_IDENTITY_DOC_SCHEMA = z.object({
  list: z.enum(["A", "B", "C"]),
  title: z.string().trim().min(1, "Enter the document title.").max(120),
  issuingAuthority: z.string().trim().min(1, "Enter the issuing authority.").max(120),
  number: z.string().trim().min(1, "Enter the document number.").max(80),
  expiration: z.string().trim().regex(MM_DD_YYYY, "Use mm/dd/yyyy.").optional().or(z.literal("")),
  dataUrl: z.string().min(20).max(20_000_000),
  fileName: z.string().trim().max(200).optional().or(z.literal("")),
});

const I9_SCHEMA = z
  .object({
    docTypeId: z.string().trim().min(1).max(128),
    lastName: z.string().trim().min(1, "Enter your last name.").max(80),
    firstName: z.string().trim().min(1, "Enter your first name.").max(80),
    middleInitial: z.string().trim().max(1).optional().or(z.literal("")),
    otherNames: z.string().trim().max(120).optional().or(z.literal("")),
    address: z.string().trim().min(1, "Enter your address.").max(160),
    apt: z.string().trim().max(40).optional().or(z.literal("")),
    city: z.string().trim().min(1, "Enter your city.").max(80),
    state: z.string().trim().min(2, "Enter the two-letter state.").max(2),
    zip: z.string().trim().regex(ZIP_RE, "Enter a valid ZIP code."),
    dob: z.string().trim().regex(MM_DD_YYYY, "Use mm/dd/yyyy."),
    ssn: z.string().trim().regex(/^[0-9]{9}$/, "Enter the 9-digit SSN (no dashes), or leave it blank.").optional().or(z.literal("")),
    email: z.string().trim().max(120).optional().or(z.literal("")),
    phone: z.string().trim().max(40).optional().or(z.literal("")),
    citizenship: z.enum(CITIZENSHIP),
    alienNumber: z.string().trim().max(40).optional().or(z.literal("")),
    uscisNumber: z.string().trim().max(40).optional().or(z.literal("")),
    i94Number: z.string().trim().max(40).optional().or(z.literal("")),
    i94Expiration: z.string().trim().regex(MM_DD_YYYY, "Use mm/dd/yyyy.").optional().or(z.literal("")),
    signature: z.string().trim().min(1, "Type your name to sign.").max(120),
    date: z.string().trim().regex(MM_DD_YYYY, "Use mm/dd/yyyy.").optional().or(z.literal("")),
    identityDocs: z.array(I9_IDENTITY_DOC_SCHEMA).min(1, "Attach at least one identity document.").max(3),
  })
  .refine(
    (v) => {
      const lists = v.identityDocs.map((d) => d.list);
      return lists.includes("A") || (lists.includes("B") && lists.includes("C"));
    },
    { message: "Attach one List A document, or one List B plus one List C document.", path: ["identityDocs"] },
  );

/* --------------------------------- result types --------------------------------- */

export type FormKind = "i9" | "w9";

export type SubmitFormResult =
  | { ok: true; docTypeId: string; storageKey: string; status: "uploaded" }
  | { ok: false; code: ContractorAdminErrorCode; message: string };

type FormIdentityDoc = {
  list: "A" | "B" | "C";
  title: string;
  issuingAuthority: string;
  number: string;
  expiration: string | null;
  storageKey: string;
  fileName: string | null;
  mime: string;
  sizeBytes: number;
};

type FormWriteMeta = {
  docTypeId: string;
  docTypeName: string;
  formKind: FormKind;
  pdfKey: string;
  pdfBytes: Uint8Array;
  /** "ssn:123456789" / "ein:123456789" — encrypted at rest under bank.key. */
  taxIdValue: string | null;
  payload: Record<string, unknown>;
  identityDocs?: FormIdentityDoc[];
};

async function connectB2(opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<{ b2: { config: Awaited<ReturnType<typeof loadB2Config>>; s3ApiUrl: string } } | { b2: null; error: string }> {
  try {
    const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
    const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
    return { b2: { config, s3ApiUrl: auth.s3ApiUrl } };
  } catch (e) {
    return { b2: null, error: e instanceof Error ? e.message : "Document storage isn't connected." };
  }
}

/** Shared persistence for a completed official-form submission: B2 PUT of the
 *  generated PDF, upsert of the form submission row (payload WITHOUT the tax
 *  id; the tax id goes encrypted), identity-doc rows for the I-9, and the
 *  contractor_documents upsert that the compliance gate reads (status
 *  'uploaded' → owner review). Audited WITHOUT the tax id / payload. */
async function writeFormSubmission(actor: ContractorAdminActor, meta: FormWriteMeta, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<SubmitFormResult> {
  try {
    await ensure();
    const q = await db();
    const conn = await connectB2(opts);
    if (!conn.b2) return { ok: false, code: "b2_not_configured", message: conn.error };
    const put = await putObject({ config: conn.b2.config, s3ApiUrl: conn.b2.s3ApiUrl, key: meta.pdfKey, bytes: meta.pdfBytes, contentType: "application/pdf", fetchImpl: opts.fetchImpl });
    if (!put.ok) return { ok: false, code: "b2_failed", message: `Document storage rejected the upload (HTTP ${put.status ?? "error"}). Try again.` };
    const taxIdEncrypted = meta.taxIdValue ? await encryptBankValue(meta.taxIdValue) : null;
    const submissionId = `fs-${cryptoRandomId()}`;
    await q`INSERT INTO contractor_form_submissions(id, org_id, contractor_id, doc_type_id, form_kind, pdf_storage_key, payload, tax_id_encrypted, updated_at)
      VALUES(${submissionId}, ${actor.orgId}, ${actor.id}, ${meta.docTypeId}, ${meta.formKind}, ${meta.pdfKey}, ${JSON.stringify(meta.payload)}::jsonb, ${taxIdEncrypted}, NOW())
      ON CONFLICT (org_id, contractor_id, doc_type_id) DO UPDATE SET
        pdf_storage_key=EXCLUDED.pdf_storage_key, payload=EXCLUDED.payload, tax_id_encrypted=EXCLUDED.tax_id_encrypted,
        section2=NULL, section2_approved_by=NULL, section2_approved_at=NULL, updated_at=NOW()`;
    if (meta.formKind === "i9" && meta.identityDocs) {
      const sub = await q`SELECT id FROM contractor_form_submissions WHERE org_id=${actor.orgId} AND contractor_id=${actor.id} AND doc_type_id=${meta.docTypeId} LIMIT 1`;
      const sid = sub.length ? String(sub[0].id) : submissionId;
      await q`DELETE FROM contractor_form_docs WHERE submission_id=${sid}`;
      for (const d of meta.identityDocs) {
        await q`INSERT INTO contractor_form_docs(id, org_id, contractor_id, submission_id, list, storage_key, file_name, mime, size_bytes, title, issuing_authority, number, expiration)
          VALUES(gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${sid}, ${d.list}, ${d.storageKey}, ${d.fileName}, ${d.mime}, ${d.sizeBytes}, ${d.title}, ${d.issuingAuthority}, ${d.number}, ${d.expiration})`;
      }
    }
    const formFileName = `${meta.formKind === "i9" ? "Form I-9" : "Form W-9"} (completed).pdf`;
    await q`INSERT INTO contractor_documents(id, org_id, contractor_id, doc_type_id, storage_key, file_name, mime, size_bytes, status, expires_on, review_note, uploaded_by_user_id, updated_at)
      VALUES(gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${meta.docTypeId}, ${meta.pdfKey}, ${formFileName}, 'application/pdf', ${meta.pdfBytes.length}, 'uploaded', NULL, NULL, ${actor.id}, NOW())
      ON CONFLICT (org_id, contractor_id, doc_type_id) DO UPDATE SET
        storage_key=EXCLUDED.storage_key, file_name=EXCLUDED.file_name, mime=EXCLUDED.mime,
        size_bytes=EXCLUDED.size_bytes, status='uploaded', expires_on=NULL,
        review_note=NULL, uploaded_by_user_id=EXCLUDED.uploaded_by_user_id, uploaded_at=NOW(), updated_at=NOW()`;
    await recordAudit(actor, "contractor_form_submitted", meta.docTypeId, {
      docTypeId: meta.docTypeId,
      docTypeName: meta.docTypeName,
      formKind: meta.formKind,
      storageKey: meta.pdfKey,
      mime: "application/pdf",
      sizeBytes: meta.pdfBytes.length,
      // NOTE: deliberately NO payload and NO tax id — the SSN/EIN must never
      // appear in audit detail (owner-directed 2026-08-12).
    });
    return { ok: true, docTypeId: meta.docTypeId, storageKey: meta.pdfKey, status: "uploaded" };
  } catch (e) {
    return { ok: false, code: "database_error", message: e instanceof Error ? e.message : "Unable to save the form." };
  }
}

/* ------------------------------- W-9 submit ------------------------------- */

/** The contractor fills the OFFICIAL W-9 (IRS Form W-9, Rev. March 2024). The
 *  completed PDF is stored to private B2; the SSN/EIN is encrypted at rest and
 *  is NEVER returned to the driver after submission. */
export async function submitW9FormCore(actor: ContractorAdminActor, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<SubmitFormResult> {
  if (actor.role !== "contractor") return { ok: false, code: "unauthorized", message: "Driver access required." };
  const v = W9_SCHEMA.safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_input", message: v.error.issues[0]?.message ?? "Check the W-9 fields." };
  try {
    await ensure();
    const q = await db();
    const type = await q`SELECT id, name, form_kind, active FROM contractor_doc_types WHERE id=${v.data.docTypeId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!type.length || type[0].active !== true) return { ok: false, code: "not_found", message: "That document type isn't required on your account." };
    if (type[0].form_kind !== "w9") return { ok: false, code: "invalid_input", message: "This document type isn't the fillable W-9 form." };
    const date = v.data.date || todayMmddyyyy();
    const w9Values: W9PdfValues = {
      name: v.data.name, businessName: v.data.businessName ?? "", taxClassification: v.data.taxClassification,
      llcTaxClass: v.data.llcTaxClass ?? "", otherDescription: v.data.otherDescription ?? "",
      payeeCode: v.data.payeeCode ?? "", exemptionCode: v.data.exemptionCode ?? "", fatcaCode: v.data.fatcaCode ?? "",
      address: v.data.address, city: v.data.city, state: v.data.state, zip: v.data.zip,
      accountNumbers: v.data.accountNumbers ?? "", requesterName: v.data.requesterName ?? "", requesterAddress: v.data.requesterAddress ?? "",
      taxIdType: v.data.taxIdType, taxId: v.data.taxId, signature: v.data.signature, date,
    };
    const payload: Record<string, unknown> = {
      name: v.data.name, businessName: v.data.businessName ?? "", taxClassification: v.data.taxClassification,
      llcTaxClass: v.data.llcTaxClass ?? "", otherDescription: v.data.otherDescription ?? "",
      payeeCode: v.data.payeeCode ?? "", exemptionCode: v.data.exemptionCode ?? "", fatcaCode: v.data.fatcaCode ?? "",
      address: v.data.address, city: v.data.city, state: v.data.state, zip: v.data.zip,
      accountNumbers: v.data.accountNumbers ?? "", requesterName: v.data.requesterName ?? "", requesterAddress: v.data.requesterAddress ?? "",
      taxIdType: v.data.taxIdType, signature: v.data.signature, date,
    };
    return writeFormSubmission(actor, {
      docTypeId: v.data.docTypeId, docTypeName: String(type[0].name), formKind: "w9",
      pdfKey: `ld-docs/${actor.orgId}/${actor.id}/${v.data.docTypeId}.pdf`,
      pdfBytes: buildW9Pdf(w9Values),
      taxIdValue: `${v.data.taxIdType}:${v.data.taxId}`,
      payload,
    }, opts);
  } catch (e) {
    return { ok: false, code: "database_error", message: e instanceof Error ? e.message : "Unable to submit the W-9." };
  }
}

/* ------------------------------- I-9 submit ------------------------------- */

/** The contractor fills OFFICIAL Form I-9 Section 1 (edition 08/01/23) and
 *  attaches identity documents (one List A, or one List B + one List C) as
 *  uploads. The owner later completes Section 2 (reviewI9Section2Core) before
 *  the doc is 'verified'. The optional Section 1 SSN is encrypted at rest. */
export async function submitI9FormCore(actor: ContractorAdminActor, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<SubmitFormResult> {
  if (actor.role !== "contractor") return { ok: false, code: "unauthorized", message: "Driver access required." };
  const v = I9_SCHEMA.safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_input", message: v.error.issues[0]?.message ?? "Check the I-9 fields." };
  try {
    await ensure();
    const q = await db();
    const type = await q`SELECT id, name, form_kind, active FROM contractor_doc_types WHERE id=${v.data.docTypeId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!type.length || type[0].active !== true) return { ok: false, code: "not_found", message: "That document type isn't required on your account." };
    if (type[0].form_kind !== "i9") return { ok: false, code: "invalid_input", message: "This document type isn't the fillable I-9 form." };
    const date = v.data.date || todayMmddyyyy();
    const identityDocs: FormIdentityDoc[] = [];
    const conn = await connectB2(opts);
    if (!conn.b2) return { ok: false, code: "b2_not_configured", message: conn.error };
    let idx = 0;
    for (const d of v.data.identityDocs) {
      const decoded = decodeDocumentDataUrl(d.dataUrl);
      if (!decoded) return { ok: false, code: "invalid_input", message: `${d.title}: unsupported file — use JPG, PNG, WebP or PDF.` };
      if (decoded.bytes.length < 1024) return { ok: false, code: "invalid_input", message: `${d.title}: the file looks empty — try again.` };
      if (decoded.bytes.length > 12 * 1024 * 1024) return { ok: false, code: "invalid_input", message: `${d.title}: the file is too large (max 12 MB).` };
      const ext = DOC_EXT[decoded.mime];
      const key = `ld-docs/${actor.orgId}/${actor.id}/${v.data.docTypeId}.i9doc-${idx}.${ext}`;
      const put = await putObject({ config: conn.b2.config, s3ApiUrl: conn.b2.s3ApiUrl, key, bytes: decoded.bytes, contentType: decoded.mime, fetchImpl: opts.fetchImpl });
      if (!put.ok) return { ok: false, code: "b2_failed", message: `Document storage rejected the ${d.title} upload (HTTP ${put.status ?? "error"}). Try again.` };
      identityDocs.push({
        list: d.list, title: d.title, issuingAuthority: d.issuingAuthority, number: d.number,
        expiration: d.expiration && d.expiration.trim() ? d.expiration.trim() : null,
        storageKey: key,
        fileName: d.fileName && d.fileName.trim() ? d.fileName.trim() : null,
        mime: decoded.mime, sizeBytes: decoded.bytes.length,
      });
      idx += 1;
    }
    const i9Values: I9PdfValues = {
      lastName: v.data.lastName, firstName: v.data.firstName, middleInitial: v.data.middleInitial ?? "",
      otherNames: v.data.otherNames ?? "", address: v.data.address, apt: v.data.apt ?? "",
      city: v.data.city, state: v.data.state, zip: v.data.zip, dob: v.data.dob,
      ssn: v.data.ssn ?? "", email: v.data.email ?? "", phone: v.data.phone ?? "",
      citizenship: v.data.citizenship, alienNumber: v.data.alienNumber ?? "", uscisNumber: v.data.uscisNumber ?? "",
      i94Number: v.data.i94Number ?? "", i94Expiration: v.data.i94Expiration ?? "",
      signature: v.data.signature, date,
      identityDocs: identityDocs.map((d) => ({
        list: d.list, title: d.title, issuingAuthority: d.issuingAuthority, number: d.number, expiration: d.expiration ?? "",
      })),
    };
    const payload: Record<string, unknown> = {
      lastName: v.data.lastName, firstName: v.data.firstName, middleInitial: v.data.middleInitial ?? "",
      otherNames: v.data.otherNames ?? "", address: v.data.address, apt: v.data.apt ?? "",
      city: v.data.city, state: v.data.state, zip: v.data.zip, dob: v.data.dob,
      email: v.data.email ?? "", phone: v.data.phone ?? "",
      citizenship: v.data.citizenship, alienNumber: v.data.alienNumber ?? "", uscisNumber: v.data.uscisNumber ?? "",
      i94Number: v.data.i94Number ?? "", i94Expiration: v.data.i94Expiration ?? "",
      signature: v.data.signature, date,
      // NOTE: no 'ssn' key — the I-9 SSN rides only in tax_id_encrypted.
    };
    return writeFormSubmission(actor, {
      docTypeId: v.data.docTypeId, docTypeName: String(type[0].name), formKind: "i9",
      pdfKey: `ld-docs/${actor.orgId}/${actor.id}/${v.data.docTypeId}.pdf`,
      pdfBytes: buildI9Pdf(i9Values),
      taxIdValue: v.data.ssn && v.data.ssn.trim() ? `ssn:${v.data.ssn.trim()}` : null,
      payload,
      identityDocs,
    }, opts);
  } catch (e) {
    return { ok: false, code: "database_error", message: e instanceof Error ? e.message : "Unable to submit the I-9." };
  }
}

/* ------------------------------ read backs ------------------------------ */

export type I9IdentityDocRow = {
  id: string;
  list: "A" | "B" | "C";
  title: string | null;
  issuingAuthority: string | null;
  number: string | null;
  expiration: string | null;
  fileName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  uploadedAt: string;
};

export type FormSubmissionView = {
  docTypeId: string;
  formKind: FormKind;
  status: DocStatus;
  /** All form fields EXCEPT the tax id (seroval-safe — null, never undefined;
   *  values are the driver-entered strings/booleans, typed primitives so the
   *  serverFn return passes TanStack's strict serializable check). */
  payload: Record<string, string | number | boolean | null>;
  taxIdType: "ssn" | "ein" | null;
  /** Decrypted tax id — OWNER-ONLY (null for contractor reads; the SSN/EIN
   *  must never render to the contractor after submission). */
  taxId: string | null;
  identityDocs: I9IdentityDocRow[];
  section2: Record<string, string | number | boolean | null> | null;
  section2ApprovedAt: string | null;
  submittedAt: string;
};

/** Owner: read any contractor's form submission (decrypted tax id, identity
 *  docs, Section 2 record) for the review surface. Contractor: read their own
 *  submission WITHOUT the tax id (re-open a rejected form prefilled). */
export async function getFormSubmissionCore(actor: ContractorAdminActor, data: unknown): Promise<{ ok: true; data: FormSubmissionView } | { ok: false; code: ContractorAdminErrorCode; message: string }> {
  const v = z.object({ contractorId: z.string().trim().min(1).max(128).optional(), docTypeId: z.string().trim().min(1).max(128) }).safeParse(data);
  if (!v.success) return err("invalid_input", "Invalid form.");
  try {
    await ensure();
    const q = await db();
    const contractorId = actor.role === "contractor" ? actor.id : (v.data.contractorId ?? actor.id);
    if (actor.role === "contractor" && v.data.contractorId && v.data.contractorId !== actor.id) {
      return err("unauthorized", "This form belongs to another contractor.");
    }
    const rows = await q`SELECT s.id, s.form_kind, s.payload, s.tax_id_encrypted, s.section2, s.section2_approved_at, s.updated_at,
        d.status AS stored_status, d.expires_on
      FROM contractor_form_submissions s
      LEFT JOIN contractor_documents d ON d.org_id=s.org_id AND d.contractor_id=s.contractor_id AND d.doc_type_id=s.doc_type_id
      WHERE s.org_id=${actor.orgId} AND s.contractor_id=${contractorId} AND s.doc_type_id=${v.data.docTypeId} LIMIT 1`;
    if (!rows.length) return err("not_found", "No form submission on file for that document.");
    const r = rows[0] as Record<string, unknown>;
    const formKind: FormKind = r.form_kind === "i9" ? "i9" : "w9";
    const payload = (r.payload ?? {}) as Record<string, string | number | boolean | null>;
    const taxIdType = payload.taxIdType === "ein" || payload.taxIdType === "ssn" ? (payload.taxIdType as "ssn" | "ein") : null;
    let taxId: string | null = null;
    const enc = r.tax_id_encrypted != null ? String(r.tax_id_encrypted) : null;
    if (enc && canManage(actor)) {
      try {
        const dec = await decryptBankValue(enc);
        taxId = dec.includes(":") ? dec.split(":").slice(1).join(":") : dec;
      } catch { /* wrong key / tampered — surface null, never the ciphertext */ }
    }
    let identityDocs: I9IdentityDocRow[] = [];
    if (formKind === "i9") {
      const docs = await q`SELECT id, list, title, issuing_authority, number, expiration, file_name, mime, size_bytes, uploaded_at
        FROM contractor_form_docs WHERE submission_id=${String(r.id)} ORDER BY uploaded_at ASC, id ASC`;
      identityDocs = (docs as Record<string, unknown>[]).map((d) => ({
        id: String(d.id),
        list: (d.list === "B" || d.list === "C" ? d.list : "A") as "A" | "B" | "C",
        title: d.title != null ? String(d.title) : null,
        issuingAuthority: d.issuing_authority != null ? String(d.issuing_authority) : null,
        number: d.number != null ? String(d.number) : null,
        expiration: d.expiration != null ? formatYmd(d.expiration) : null,
        fileName: d.file_name != null ? String(d.file_name) : null,
        mime: d.mime != null ? String(d.mime) : null,
        sizeBytes: d.size_bytes != null ? Number(d.size_bytes) : null,
        uploadedAt: new Date(String(d.uploaded_at)).toISOString(),
      }));
    }
    const stored = r.stored_status != null ? String(r.stored_status) : null;
    const status = stored ? deriveDocStatus(stored, formatYmd(r.expires_on)) : "missing";
    return ok({
      docTypeId: v.data.docTypeId,
      formKind,
      status,
      payload,
      taxIdType,
      taxId,
      identityDocs,
      section2: r.section2 != null && typeof r.section2 === "object" ? (r.section2 as Record<string, string | number | boolean | null>) : null,
      section2ApprovedAt: r.section2_approved_at != null ? new Date(String(r.section2_approved_at)).toISOString() : null,
      submittedAt: new Date(String(r.updated_at ?? r.section2_approved_at)).toISOString(),
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load the form.");
  }
}

/** Read one I-9 identity document file (owner: any in org; driver: own only —
 *  the driver uploaded it and may re-review after a rejection). */
export async function getFormDocFileCore(actor: ContractorAdminActor, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<{ ok: true; data: DocFilePayload } | { ok: false; code: ContractorAdminErrorCode; message: string }> {
  const v = z.object({ docId: z.string().trim().min(1).max(128) }).safeParse(data);
  if (!v.success) return err("invalid_input", "Invalid document.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, contractor_id, storage_key, file_name, mime, size_bytes FROM contractor_form_docs WHERE id=${v.data.docId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!rows.length) return err("not_found", "That identity document isn't on this account.");
    const row = rows[0] as Record<string, unknown>;
    if (actor.role === "contractor" && String(row.contractor_id) !== actor.id) {
      return err("unauthorized", "This identity document belongs to another contractor.");
    }
    const key = String(row.storage_key);
    const conn = await connectB2(opts);
    if (!conn.b2) return err("b2_not_configured", conn.error);
    const got = await getObject({ config: conn.b2.config, s3ApiUrl: conn.b2.s3ApiUrl, key, fetchImpl: opts.fetchImpl });
    if (!got.ok || !got.bytes) return err("b2_failed", `Document storage rejected the read (HTTP ${got.status ?? "error"}).`);
    return ok({
      base64: Buffer.from(got.bytes).toString("base64"),
      mime: String(row.mime ?? "application/octet-stream"),
      fileName: row.file_name != null ? String(row.file_name) : null,
      sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : got.bytes.length,
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load the identity document.");
  }
}

/* ------------------------- I-9 Section 2 (owner review) ------------------------- */

const SECTION2_SCHEMA = z.object({
  docId: z.string().trim().min(1).max(128),
  approve: z.boolean(),
  repName: z.string().trim().min(1, "Enter your name (the certifying representative).").max(120),
  repTitle: z.string().trim().max(120).optional().or(z.literal("")),
  reviewNote: z.string().trim().max(300).optional().or(z.literal("")),
});

/** The OWNER completes Section 2 of the I-9 (owner-directed 2026-08-12):
 *  reviewing the driver's Section 1 + identity docs, then approving — which
 *  records the Section 2 certification, REGENERATES the completed PDF with
 *  Section 2 stamped in (private B2), and flips the doc to 'verified' so the
 *  compliance gate passes. Reject asks the driver to fix and resubmit. */
export async function reviewI9Section2Core(actor: ContractorAdminActor, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<{ ok: true; data: { docId: string; status: "verified" | "rejected" } } | { ok: false; code: ContractorAdminErrorCode; message: string }> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = SECTION2_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Invalid review.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT d.id, d.contractor_id, d.doc_type_id, d.storage_key, t.name AS doc_type_name, t.form_kind
      FROM contractor_documents d JOIN contractor_doc_types t ON t.id = d.doc_type_id
      WHERE d.id=${v.data.docId} AND d.org_id=${actor.orgId} LIMIT 1`;
    if (!rows.length) return err("not_found", "That document isn't on this account.");
    const row = rows[0] as Record<string, unknown>;
    if (row.form_kind !== "i9") return err("invalid_input", "Section 2 review applies only to the I-9 form.");
    const reviewNote = v.data.reviewNote && v.data.reviewNote.trim() ? v.data.reviewNote.trim() : null;
    const sub = await q`SELECT id, payload, tax_id_encrypted FROM contractor_form_submissions
      WHERE org_id=${actor.orgId} AND contractor_id=${String(row.contractor_id)} AND doc_type_id=${String(row.doc_type_id)} LIMIT 1`;
    if (!sub.length) return err("not_found", "The driver hasn't submitted the I-9 form yet.");
    if (!v.data.approve) {
      await q`UPDATE contractor_documents SET status='rejected', review_note=${reviewNote}, updated_at=NOW() WHERE id=${v.data.docId} AND org_id=${actor.orgId}`;
      await recordAudit(actor, "contractor_doc_rejected", v.data.docId, { docTypeId: String(row.doc_type_id), fromStatus: "uploaded", reviewNote });
      return ok({ docId: v.data.docId, status: "rejected" });
    }
    // Approve: build the Section 2 record from the identity docs the owner reviewed.
    const org = await q`SELECT name FROM organizations WHERE id=${actor.orgId} LIMIT 1`;
    const orgName = org.length ? String(org[0].name) : "";
    const docsRows = await q`SELECT list, title, issuing_authority, number, expiration FROM contractor_form_docs WHERE submission_id=${String(sub[0].id)} ORDER BY uploaded_at ASC, id ASC`;
    const docs = (docsRows as Record<string, unknown>[]).map((d) => ({
      list: (d.list === "B" || d.list === "C" ? d.list : "A") as "A" | "B" | "C",
      title: d.title != null ? String(d.title) : "",
      issuingAuthority: d.issuing_authority != null ? String(d.issuing_authority) : "",
      number: d.number != null ? String(d.number) : "",
      expiration: d.expiration != null ? (formatYmd(d.expiration) ?? "") : "",
    }));
    const section2 = { docs, repName: v.data.repName, repTitle: v.data.repTitle ?? "", orgName, date: todayMmddyyyy() };
    const payload = (sub[0].payload ?? {}) as Record<string, unknown>;
    let ssn = "";
    const enc = sub[0].tax_id_encrypted != null ? String(sub[0].tax_id_encrypted) : null;
    if (enc) {
      try {
        const dec = await decryptBankValue(enc);
        ssn = dec.includes(":") ? dec.split(":").slice(1).join(":") : "";
      } catch { ssn = ""; }
    }
    const i9Values: I9PdfValues = {
      lastName: String(payload.lastName ?? ""), firstName: String(payload.firstName ?? ""), middleInitial: String(payload.middleInitial ?? ""),
      otherNames: String(payload.otherNames ?? ""), address: String(payload.address ?? ""), apt: String(payload.apt ?? ""),
      city: String(payload.city ?? ""), state: String(payload.state ?? ""), zip: String(payload.zip ?? ""), dob: String(payload.dob ?? ""),
      ssn, email: String(payload.email ?? ""), phone: String(payload.phone ?? ""),
      citizenship: (["citizen", "noncitizen_national", "lpr", "noncitizen_authorized"].includes(String(payload.citizenship))
        ? String(payload.citizenship) : "citizen") as I9PdfValues["citizenship"],
      alienNumber: String(payload.alienNumber ?? ""), uscisNumber: String(payload.uscisNumber ?? ""),
      i94Number: String(payload.i94Number ?? ""), i94Expiration: String(payload.i94Expiration ?? ""),
      signature: String(payload.signature ?? ""), date: String(payload.date ?? ""),
      identityDocs: docs.map((d) => ({
        list: (d.list === "B" || d.list === "C" ? d.list : "A") as "A" | "B" | "C",
        title: d.title, issuingAuthority: d.issuingAuthority, number: d.number, expiration: d.expiration,
      })),
    };
    const pdf = buildI9Pdf(i9Values, section2);
    const key = String(row.storage_key);
    const conn = await connectB2(opts);
    if (!conn.b2) return err("b2_not_configured", conn.error);
    const put = await putObject({ config: conn.b2.config, s3ApiUrl: conn.b2.s3ApiUrl, key, bytes: pdf, contentType: "application/pdf", fetchImpl: opts.fetchImpl });
    if (!put.ok) return err("b2_failed", `Document storage rejected the upload (HTTP ${put.status ?? "error"}).`);
    await q`UPDATE contractor_form_submissions SET section2=${JSON.stringify(section2)}::jsonb, section2_approved_by=${actor.id}, section2_approved_at=NOW(), pdf_storage_key=${key}, updated_at=NOW() WHERE id=${String(sub[0].id)}`;
    await q`UPDATE contractor_documents SET status='verified', storage_key=${key}, mime='application/pdf', size_bytes=${pdf.length}, review_note=NULL, updated_at=NOW() WHERE id=${v.data.docId} AND org_id=${actor.orgId}`;
    await recordAudit(actor, "contractor_doc_verified", v.data.docId, {
      docTypeId: String(row.doc_type_id),
      fromStatus: "uploaded",
      section2Rep: v.data.repName,
      docTitles: docs.map((d) => d.title), // titles only — never the document numbers
    });
    return ok({ docId: v.data.docId, status: "verified" });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to review the I-9.");
  }
}
