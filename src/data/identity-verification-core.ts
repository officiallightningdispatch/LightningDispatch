/** Stripe Identity — automated driver's-license + matching-selfie verification.
 * SERVER-ONLY. Lightning Dispatch persists only Stripe's session id/status and
 * compliance proof; captured ID/selfie images stay with Stripe.
 */
import { sql } from "~/db";
import { getStripeClient } from "./stripe-connect-core";

export type IdentityStatus = {
  configured: boolean;
  status: "not_started" | "requires_input" | "processing" | "verified" | "canceled" | "unknown";
  sessionId: string | null;
  url: string | null;
  verifiedAt: string | null;
  message: string | null;
};
export type IdentityResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

let schemaInit: Promise<void> | undefined;
async function ensure() {
  schemaInit ??= import("./migrations").then((m) => m.ensureSchema());
  await schemaInit;
}
async function actor() {
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || u.role !== "contractor") return null;
  return { orgId: u.orgId, userId: u.id };
}
const normalizeStatus = (v: string | null | undefined): IdentityStatus["status"] =>
  v === "requires_input" || v === "processing" || v === "verified" || v === "canceled" ? v : v ? "unknown" : "not_started";

async function markIdentityDocsVerified(orgId: string, userId: string, sessionId: string) {
  const q = sql();
  const types = await q`SELECT id, name FROM contractor_doc_types
    WHERE org_id=${orgId} AND active=TRUE
      AND LOWER(name) IN ('driver''s license — front','driver''s license — back')
    ORDER BY sort_order ASC`;
  for (const row of types as Record<string, unknown>[]) {
    const docTypeId = String(row.id);
    const docId = `identity-${sessionId}-${docTypeId}`;
    await q`INSERT INTO contractor_documents
      (id,org_id,contractor_id,doc_type_id,storage_key,file_name,mime,size_bytes,status,uploaded_by_user_id,uploaded_at,updated_at)
      VALUES(${docId},${orgId},${userId},${docTypeId},${`stripe-identity://${sessionId}`},'Identity verified automatically',NULL,NULL,'verified',${userId},NOW(),NOW())
      ON CONFLICT (org_id,contractor_id,doc_type_id) DO UPDATE SET
        storage_key=EXCLUDED.storage_key,file_name=EXCLUDED.file_name,mime=NULL,size_bytes=NULL,
        status='verified',review_note=NULL,uploaded_by_user_id=EXCLUDED.uploaded_by_user_id,uploaded_at=NOW(),updated_at=NOW()`;
  }
  const front = (types as Record<string, unknown>[]).find((r) => String(r.name).toLowerCase().includes("front"));
  if (front) {
    const docTypeId = String(front.id);
    await q`INSERT INTO contractor_doc_selfies
      (id,org_id,contractor_id,doc_type_id,storage_key,file_name,mime,size_bytes,uploaded_by_user_id,uploaded_at,updated_at)
      VALUES(${`identity-selfie-${sessionId}`},${orgId},${userId},${docTypeId},${`stripe-identity://${sessionId}/selfie`},'Matching selfie verified automatically',NULL,NULL,${userId},NOW(),NOW())
      ON CONFLICT (org_id,contractor_id,doc_type_id) DO UPDATE SET
        storage_key=EXCLUDED.storage_key,file_name=EXCLUDED.file_name,mime=NULL,size_bytes=NULL,
        uploaded_by_user_id=EXCLUDED.uploaded_by_user_id,uploaded_at=NOW(),updated_at=NOW()`;
  }
}

export async function startIdentityVerificationCore(returnUrl: string): Promise<IdentityResult<{ url: string }>> {
  const a = await actor();
  if (!a) return { ok: false, code: "unauthorized", message: "Contractor access required." };
  await ensure();
  const stripe = getStripeClient();
  if (!stripe.configured) return { ok: false, code: "stripe_not_configured", message: "Automatic identity verification is not configured yet." };
  let safeReturn: URL;
  try {
    safeReturn = new URL(returnUrl);
    if (safeReturn.protocol !== "https:" || !/\.vercel\.app$/.test(safeReturn.hostname)) throw new Error("bad origin");
    safeReturn.pathname = "/driver/documents";
    safeReturn.search = "?identity=return";
    safeReturn.hash = "";
  } catch {
    return { ok: false, code: "invalid_input", message: "Invalid return URL." };
  }

  const q = sql();
  const existing = await q`SELECT stripe_identity_session_id,stripe_identity_status
    FROM contractor_profiles WHERE org_id=${a.orgId} AND user_id=${a.userId} LIMIT 1`;
  const existingId = existing.length ? String(existing[0].stripe_identity_session_id ?? "") : "";
  const existingStatus = existing.length ? String(existing[0].stripe_identity_status ?? "") : "";
  if (existingId && existingStatus === "verified") {
    await markIdentityDocsVerified(a.orgId, a.userId, existingId);
    return { ok: false, code: "already_verified", message: "Your identity is already verified." };
  }

  try {
    if (existingId && (existingStatus === "requires_input" || existingStatus === "processing")) {
      const prior = await stripe.client.identity.verificationSessions.retrieve(existingId);
      if (prior.status === "requires_input" && prior.url) return { ok: true, data: { url: prior.url } };
      if (prior.status === "verified") {
        await q`UPDATE contractor_profiles SET stripe_identity_status='verified',stripe_identity_verified_at=NOW(),stripe_identity_last_error=NULL
          WHERE org_id=${a.orgId} AND user_id=${a.userId}`;
        await markIdentityDocsVerified(a.orgId, a.userId, prior.id);
        return { ok: false, code: "already_verified", message: "Your identity is already verified." };
      }
    }

    const session = await stripe.client.identity.verificationSessions.create({
      type: "document",
      options: { document: { require_matching_selfie: true } },
      client_reference_id: a.userId,
      metadata: { org_id: a.orgId, contractor_user_id: a.userId },
      return_url: safeReturn.toString(),
    });
    if (!session.url) return { ok: false, code: "stripe_error", message: "Verification could not be started." };
    await q`INSERT INTO contractor_profiles(org_id,user_id,stripe_identity_session_id,stripe_identity_status,stripe_identity_last_error)
      VALUES(${a.orgId},${a.userId},${session.id},${session.status},NULL)
      ON CONFLICT (org_id,user_id) DO UPDATE SET
        stripe_identity_session_id=EXCLUDED.stripe_identity_session_id,
        stripe_identity_status=EXCLUDED.stripe_identity_status,
        stripe_identity_last_error=NULL,stripe_identity_verified_at=NULL`;
    return { ok: true, data: { url: session.url } };
  } catch (e) {
    return { ok: false, code: "stripe_error", message: e instanceof Error ? e.message : "Identity verification could not be started." };
  }
}

export async function getIdentityVerificationStatusCore(): Promise<IdentityResult<IdentityStatus>> {
  const a = await actor();
  if (!a) return { ok: false, code: "unauthorized", message: "Contractor access required." };
  await ensure();
  const stripe = getStripeClient();
  if (!stripe.configured) return { ok: true, data: { configured: false, status: "not_started", sessionId: null, url: null, verifiedAt: null, message: null } };
  const q = sql();
  const rows = await q`SELECT stripe_identity_session_id,stripe_identity_status,stripe_identity_verified_at,stripe_identity_last_error
    FROM contractor_profiles WHERE org_id=${a.orgId} AND user_id=${a.userId} LIMIT 1`;
  const sessionId = rows.length && rows[0].stripe_identity_session_id ? String(rows[0].stripe_identity_session_id) : null;
  if (!sessionId) return { ok: true, data: { configured: true, status: "not_started", sessionId: null, url: null, verifiedAt: null, message: null } };
  try {
    const session = await stripe.client.identity.verificationSessions.retrieve(sessionId);
    const status = normalizeStatus(session.status);
    const lastError = session.last_error?.reason ?? null;
    await q`UPDATE contractor_profiles SET stripe_identity_status=${status},
      stripe_identity_verified_at=CASE WHEN ${status}='verified' THEN COALESCE(stripe_identity_verified_at,NOW()) ELSE stripe_identity_verified_at END,
      stripe_identity_last_error=${lastError}
      WHERE org_id=${a.orgId} AND user_id=${a.userId}`;
    if (status === "verified") await markIdentityDocsVerified(a.orgId, a.userId, sessionId);
    return { ok: true, data: {
      configured: true,
      status,
      sessionId,
      url: session.status === "requires_input" ? session.url : null,
      verifiedAt: status === "verified" ? new Date().toISOString() : (rows[0].stripe_identity_verified_at ? new Date(String(rows[0].stripe_identity_verified_at)).toISOString() : null),
      message: lastError,
    }};
  } catch (e) {
    return { ok: false, code: "stripe_error", message: e instanceof Error ? e.message : "Unable to check identity verification." };
  }
}
