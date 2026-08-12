/**
 * Customer completion capture (milestone "completion flow", owner-directed
 * 2026-08-11) — SERVER-ONLY core.
 *
 * Before a job completes the customer provides: (1) a signature (PNG stored in
 * Backblaze B2 under the ld-photos/<org>/<job>/completion/ prefix, key recorded
 * in job_completions), (2) a short survey (rating 1-5 + optional comment), and
 * (3) optionally a tip through the OWNER's Square account — a Square-hosted
 * payment link is created server-side (Create Payment Link API, Bearer token)
 * with the tip amount + the specific driver's Towbook id attributed to the
 * line item so tips are paid out to the right contractor. The tip is OPTIONAL:
 * a missing tip never blocks completion.
 *
 * The Square integration is LIVE-GATED exactly like B2 was: loadSquareConfig
 * resolves env → SQUARE_*_FILE → <site-parent>/.secrets/square-*; until the
 * owner supplies production credentials it fails loudly (square_not_configured)
 * and the tip block stays hidden in the UI. No card entry code lives here —
 * the customer pays on Square's own page.
 *
 * completeJobCore (driver-photos-core.ts) hard-gates completion on the capture:
 * no signature_storage_key + survey → completion_capture_required, job stays
 * arrived.
 *
 * Testability (same split as driver-photos-core): every handler is a thin auth
 * wrapper over a `*Core` function that takes an explicit user context —
 * hermetic tests call the cores directly with injectable fetchImpl (mock
 * Square/B2, in-memory object store, real Neon QA orgs).
 *
 * Imported ONLY by the client-safe facade (src/data/completion.ts, whose
 * createServerFn handlers dynamic-import this module) and by hermetic tests.
 */
import { z } from "zod";
import { loadB2Config, authorizeAccount, putObject } from "./b2-client";
import { loadSquareConfig, loadSquarePublicConfig, createPaymentLink, createCardPayment } from "./square-client";
import { resolveJob, isAssignedDriver, decodeDataUrl } from "./driver-photos-core";
import type { PhotoUser } from "./driver-photos-core";

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

/** Resolve the acting driver user + their Towbook driver id (handler helper). */
async function resolveCompletionUser(): Promise<PhotoUser | null> {
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return null;
  const q = await db();
  const rows = await q`SELECT towbook_driver_id FROM users WHERE id=${identity.userRowId}`;
  const user: PhotoUser = {
    orgId: u.orgId,
    id: identity.userRowId,
    role: "contractor",
    towbookDriverId: rows.length ? String(rows[0].towbook_driver_id ?? "") : "",
  };
  if (u.role !== "contractor") {
    user.actorUserId = u.id;
    user.actorRole = u.role;
    user.ownerInDriverView = true;
  }
  return user;
}

/* --------------------------------- domain --------------------------------- */

const TIP_STATUSES = ["none", "link_created", "paid"] as const;
export type TipStatus = (typeof TIP_STATUSES)[number];

export type CompletionTip = {
  amountCents: number;
  currency: string;
  status: TipStatus;
  squarePaymentLinkId: string | null;
  squarePaymentId: string | null;
  driverTowbookId: string | null;
};

export type CompletionCaptureStatus = {
  jobId: string;
  signatureCaptured: boolean;
  signatureStorageKey: string | null;
  survey: { rating: number; comment: string | null } | null;
  tip: CompletionTip | null;
  status: "none" | "captured" | "tip_link_created" | "tip_paid";
};

/** One job's completion capture (or absence) — the driver UI + owner queue
 *  badge read this. Tip stays optional: no tip jsonb → fine. */
export async function completionCaptureForJob(orgId: string, jobId: string): Promise<CompletionCaptureStatus> {
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT signature_storage_key, survey, tip FROM job_completions WHERE org_id=${orgId} AND job_id=${jobId} LIMIT 1`;
    const empty: CompletionCaptureStatus = { jobId, signatureCaptured: false, signatureStorageKey: null, survey: null, tip: null, status: "none" };
    if (!rows.length) return empty;
    const r = rows[0] as Record<string, unknown>;
    const signatureKey = r.signature_storage_key != null && String(r.signature_storage_key) !== "" ? String(r.signature_storage_key) : null;
    let survey: CompletionCaptureStatus["survey"] = null;
    if (r.survey && typeof r.survey === "object") {
      const s = r.survey as Record<string, unknown>;
      const rating = typeof s.rating === "number" && Number.isInteger(s.rating) && s.rating >= 1 && s.rating <= 5 ? s.rating : null;
      if (rating != null) survey = { rating, comment: typeof s.comment === "string" ? s.comment : null };
    }
    let tip: CompletionTip | null = null;
    if (r.tip && typeof r.tip === "object") {
      const t = r.tip as Record<string, unknown>;
      const status = TIP_STATUSES.includes(String(t.status) as TipStatus) ? (String(t.status) as TipStatus) : "none";
      tip = {
        amountCents: Number.isFinite(Number(t.amount_cents)) ? Number(t.amount_cents) : 0,
        currency: typeof t.currency === "string" ? t.currency : "USD",
        status,
        squarePaymentLinkId: t.square_payment_link_id != null ? String(t.square_payment_link_id) : null,
        squarePaymentId: t.square_payment_id != null ? String(t.square_payment_id) : null,
        driverTowbookId: t.driver_towbook_id != null ? String(t.driver_towbook_id) : null,
      };
    }
    const signatureCaptured = signatureKey != null;
    let status: CompletionCaptureStatus["status"] = "none";
    if (tip?.status === "paid") status = "tip_paid";
    else if (tip?.status === "link_created") status = "tip_link_created";
    else if (signatureCaptured && survey) status = "captured";
    return { jobId, signatureCaptured, signatureStorageKey: signatureKey, survey, tip, status };
  } catch {
    return { jobId, signatureCaptured: false, signatureStorageKey: null, survey: null, tip: null, status: "none" };
  }
}

/** Owner/ops: every job's completion capture for the queue cards (one query). */
export async function allCompletionCapturesCore(orgId: string): Promise<CompletionCaptureStatus[]> {
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT job_id, signature_storage_key, survey, tip FROM job_completions WHERE org_id=${orgId}`;
    const out: CompletionCaptureStatus[] = [];
    for (const r of rows as Record<string, unknown>[]) {
      out.push(await completionCaptureForJob(orgId, String(r.job_id)));
    }
    return out;
  } catch {
    return [];
  }
}

/** Is the owner's Square account wired? The driver UI hides the tip block until
 *  true — a customer must never be blocked from completing because tips are
 *  optional (and the credentials are still pending). */
export async function isSquareConfiguredCore(): Promise<boolean> {
  try {
    await loadSquareConfig(process.env);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------- capture --------------------------------- */

const SURVEY_SCHEMA = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(200).optional().default(""),
});

/** Real-image check for the customer signature: the payload must start with the
 *  magic bytes of its declared format (PNG / JPEG / WebP), so a random base64
 *  blob can never be stored as a "signature". */
function hasImageMagic(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/png") {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  if (mime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/webp") {
    return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  return false;
}

export type CaptureCompletionResult =
  | { ok: true; completion: CompletionCaptureStatus }
  | { ok: false; code: "invalid_input" | "b2_not_configured" | "b2_failed" | "not_found" | "unauthorized" | "invalid_state"; message: string };

/** Store the customer's signature (PNG → B2) + survey for the job, UPSERTING
 *  the job_completions row (a retake overwrites the same B2 object + row; an
 *  existing tip survives). Gated on B2 config like photos. Injectable
 *  fetchImpl + b2StableDir for hermetic tests. */
export async function captureCompletionCore(user: PhotoUser, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<CaptureCompletionResult> {
  const v = z.object({
    jobId: z.string().min(1).max(128),
    signatureDataUrl: z.string().min(20).max(5_000_000),
    survey: SURVEY_SCHEMA,
  }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_input", message: "Signature and a 1-5 star rating are required." };
  const decoded = decodeDataUrl(v.data.signatureDataUrl);
  if (!decoded || !hasImageMagic(decoded.bytes, decoded.mime)) return { ok: false, code: "invalid_input", message: "The signature couldn't be read — have the customer sign again." };
  if (decoded.bytes.length === 0) return { ok: false, code: "invalid_input", message: "The signature is empty — have the customer sign again." };
  if (decoded.bytes.length > 5 * 1024 * 1024) return { ok: false, code: "invalid_input", message: "The signature is too large — try again." };
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    if (job.status !== "arrived" && job.status !== "completed") return { ok: false, code: "invalid_state", message: "Customer completion is available after arrival." };
    const q = await db();
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };

    const key = `ld-photos/${user.orgId}/${job.id}/completion/signature.png`;
    let b2;
    try {
      const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
      const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
      b2 = { config, s3ApiUrl: auth.s3ApiUrl };
    } catch (err) {
      return { ok: false, code: "b2_not_configured", message: err instanceof Error ? err.message : "Signature storage isn't connected." };
    }
    const put = await putObject({ config: b2.config, s3ApiUrl: b2.s3ApiUrl, key, bytes: decoded.bytes, contentType: decoded.mime, fetchImpl: opts.fetchImpl });
    if (!put.ok) return { ok: false, code: "b2_failed", message: `Signature storage rejected the upload (HTTP ${put.status ?? "error"}). Try again.` };

    const survey = { rating: v.data.survey.rating, comment: v.data.survey.comment || null };
    await q`INSERT INTO job_completions(org_id, job_id, signature_storage_key, survey)
      VALUES(${user.orgId}, ${job.id}, ${key}, ${JSON.stringify(survey)}::jsonb)
      ON CONFLICT (org_id, job_id) DO UPDATE
        SET signature_storage_key=EXCLUDED.signature_storage_key, survey=EXCLUDED.survey, updated_at=NOW()`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'job_capture_saved', 'job', ${job.id},
          ${JSON.stringify({ signatureStorageKey: key, rating: survey.rating })}::jsonb, 'completion-flow'`;
    } catch { /* best-effort audit */ }
    return { ok: true, completion: await completionCaptureForJob(user.orgId, job.id) };
  } catch (err) {
    return { ok: false, code: "b2_failed", message: err instanceof Error ? err.message : "Couldn't save the customer completion. Try again." };
  }
}

/* ---------------------------------- tip ---------------------------------- */

export type TipLinkResult =
  | { ok: true; paymentLinkUrl: string; paymentLinkId: string; amountCents: number; currency: string }
  | { ok: false; code: "square_not_configured" | "not_found" | "unauthorized" | "invalid_state" | "square_failed"; message: string };

/** Create a Square-hosted payment link for the customer's optional tip. ONLY
 *  fires when the owner's Square credentials are configured — otherwise
 *  square_not_configured and the job flow proceeds without a tip. The line
 *  item name carries the driver attribution (name + Towbook id) and the job so
 *  tips reconcile to the specific contractor. Injectable fetchImpl + stableDir
 *  override for hermetic tests. */
export async function createTipLinkCore(user: PhotoUser, data: unknown, opts: { fetchImpl?: typeof fetch; squareStableDir?: string } = {}): Promise<TipLinkResult> {
  const v = z.object({
    jobId: z.string().min(1).max(128),
    amountCents: z.number().int().min(100).max(1_000_000),
  }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Pick a tip amount ($1-$10,000)." };
  let config;
  try {
    config = await loadSquareConfig(process.env, { stableDir: opts.squareStableDir });
  } catch (err) {
    return { ok: false, code: "square_not_configured", message: err instanceof Error ? err.message : "Tips aren't connected yet." };
  }
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    if (job.status !== "arrived" && job.status !== "completed") return { ok: false, code: "invalid_state", message: "Tips are available once you've arrived." };
    const q = await db();
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };

    const names = await q`SELECT name FROM users WHERE id=${user.id} LIMIT 1`;
    const driverName = names.length && names[0].name ? String(names[0].name) : `Driver ${user.towbookDriverId}`;
    const lineItemName = `Tip — ${driverName} — job ${job.towbookJobId ?? job.id}`;
    const { randomUUID } = await import("node:crypto");
    const currency = "USD";
    let link;
    try {
      link = await createPaymentLink({
        config,
        idempotencyKey: randomUUID(),
        lineItemName,
        amountCents: v.data.amountCents,
        currency,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      return { ok: false, code: "square_failed", message: err instanceof Error ? err.message : "Couldn't create the tip link — try again." };
    }

    const tip = {
      amount_cents: v.data.amountCents,
      currency,
      status: "link_created",
      square_payment_link_id: link.paymentLinkId,
      driver_towbook_id: user.towbookDriverId || null,
    };
    await q`INSERT INTO job_completions(org_id, job_id, signature_storage_key, survey, tip)
      VALUES(${user.orgId}, ${job.id}, NULL, NULL, ${JSON.stringify(tip)}::jsonb)
      ON CONFLICT (org_id, job_id) DO UPDATE SET tip=EXCLUDED.tip, updated_at=NOW()`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'job_tip_link_created', 'job', ${job.id},
          ${JSON.stringify({ amountCents: v.data.amountCents, paymentLinkId: link.paymentLinkId, driverTowbookId: user.towbookDriverId })}::jsonb, 'completion-flow'`;
    } catch { /* best-effort audit */ }
    return { ok: true, paymentLinkUrl: link.url, paymentLinkId: link.paymentLinkId, amountCents: v.data.amountCents, currency };
  } catch (err) {
    return { ok: false, code: "square_failed", message: err instanceof Error ? err.message : "Couldn't create the tip link. Try again." };
  }
}

/* ------------------------- Web Payments (card, in-app) ------------------------- */

export type TipChargeResult =
  | { ok: true; paymentId: string; amountCents: number; currency: string; status: string }
  | { ok: false; code: "square_not_configured" | "not_found" | "unauthorized" | "invalid_state" | "square_failed"; message: string; retryable?: boolean };

/** Charge the customer's card (Web Payments token from the CLIENT-side SDK) for
 *  the optional tip, recording the attribution row in completion_tips (org /
 *  job / driver / amount / Square payment id / status) so tips reconcile to the
 *  specific driver. The access token stays server-side; the client only held the
 *  PUBLIC application id + location id. Idempotency key per attempt
 *  (tip-<job>-<driver>-<attempt>): a retry with the same attempt can never
 *  double-charge. A FAILED payment is recorded + surfaced with retryable=true —
 *  the caller offers retry or decline; the tip NEVER blocks completion (the
 *  completeJobCore gate only requires signature + survey). Injectable fetchImpl
 *  + squareStableDir for hermetic tests. */
export async function chargeTipCore(user: PhotoUser, data: unknown, opts: { fetchImpl?: typeof fetch; squareStableDir?: string } = {}): Promise<TipChargeResult> {
  const v = z.object({
    jobId: z.string().min(1).max(128),
    token: z.string().min(8).max(4096), // Square Web Payments card token/nonce
    amountCents: z.number().int().min(100).max(1_000_000),
    attempt: z.number().int().min(1).max(50).default(1),
  }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Pick a tip amount ($1-$10,000)." };
  let config;
  try {
    config = await loadSquareConfig(process.env, { stableDir: opts.squareStableDir });
  } catch (err) {
    return { ok: false, code: "square_not_configured", message: err instanceof Error ? err.message : "Tips aren't connected yet." };
  }
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    if (job.status !== "arrived" && job.status !== "completed") return { ok: false, code: "invalid_state", message: "Tips are available once you've arrived." };
    const q = await db();
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };

    const names = await q`SELECT name FROM users WHERE id=${user.id} LIMIT 1`;
    const driverName = names.length && names[0].name ? String(names[0].name) : `Driver ${user.towbookDriverId}`;
    const currency = "USD";
    const idempotencyKey = `tip-${job.id}-${user.towbookDriverId || user.id}-${v.data.attempt}`;
    let payment;
    try {
      payment = await createCardPayment({
        config,
        idempotencyKey,
        sourceId: v.data.token,
        amountCents: v.data.amountCents,
        currency,
        note: `Tip — ${driverName} — job ${job.towbookJobId ?? job.id}`,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't charge the tip — try again.";
      await recordTipAttempt(user, job.id, {
        status: "failed", amountCents: v.data.amountCents, currency, attempt: v.data.attempt, idempotencyKey,
        error: message.slice(0, 400),
      });
      try {
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'job_tip_failed', 'job', ${job.id},
            ${JSON.stringify({ amountCents: v.data.amountCents, attempt: v.data.attempt, idempotencyKey, error: message.slice(0, 400) })}::jsonb, 'completion-flow'`;
      } catch { /* best-effort audit */ }
      return { ok: false, code: "square_failed", message, retryable: true };
    }
    const terminal = payment.status === "FAILED" || payment.status === "CANCELED";
    if (terminal) {
      const message = `Square declined the card (${payment.status}).`;
      await recordTipAttempt(user, job.id, {
        status: "failed", amountCents: v.data.amountCents, currency, attempt: v.data.attempt, idempotencyKey,
        error: message, squarePaymentId: payment.paymentId,
      });
      try {
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'job_tip_failed', 'job', ${job.id},
            ${JSON.stringify({ amountCents: v.data.amountCents, attempt: v.data.attempt, idempotencyKey, squarePaymentId: payment.paymentId, error: message })}::jsonb, 'completion-flow'`;
      } catch { /* best-effort audit */ }
      return { ok: false, code: "square_failed", message, retryable: true };
    }

    // Success: the job settles with at most one paid tip — clear any declined
    // rows first, then record the attribution row + the job_completions.tip
    // jsonb. The idempotency-key unique index makes a replayed attempt (same
    // key) UPSERT the SAME row: a network blip after Square charged can never
    // double-record the tip.
    await q`DELETE FROM completion_tips WHERE org_id=${user.orgId} AND job_id=${job.id} AND status='declined'`;
    await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, square_payment_id, status, attempt, idempotency_key)
      VALUES(gen_random_uuid()::text, ${user.orgId}, ${job.id}, ${user.id}, ${user.towbookDriverId || null}, ${v.data.amountCents}, ${currency}, ${payment.paymentId}, 'paid', ${v.data.attempt}, ${idempotencyKey})
      ON CONFLICT (idempotency_key) DO UPDATE SET status='paid', square_payment_id=EXCLUDED.square_payment_id,
        amount_cents=EXCLUDED.amount_cents, error=NULL, attempt=EXCLUDED.attempt, updated_at=NOW()`;
    const tip = {
      status: "paid",
      amount_cents: v.data.amountCents,
      currency,
      square_payment_id: payment.paymentId,
      driver_towbook_id: user.towbookDriverId || null,
      attempt: v.data.attempt,
    };
    await q`INSERT INTO job_completions(org_id, job_id, signature_storage_key, survey, tip)
      VALUES(${user.orgId}, ${job.id}, NULL, NULL, ${JSON.stringify(tip)}::jsonb)
      ON CONFLICT (org_id, job_id) DO UPDATE SET tip=EXCLUDED.tip, updated_at=NOW()`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'job_tip_charged', 'job', ${job.id},
          ${JSON.stringify({ amountCents: v.data.amountCents, paymentId: payment.paymentId, driverTowbookId: user.towbookDriverId, attempt: v.data.attempt })}::jsonb, 'completion-flow'`;
    } catch { /* best-effort audit */ }
    return { ok: true, paymentId: payment.paymentId, amountCents: v.data.amountCents, currency, status: payment.status };
  } catch (err) {
    return { ok: false, code: "square_failed", message: err instanceof Error ? err.message : "Couldn't charge the tip. Try again.", retryable: true };
  }
}

export type TipDeclineResult =
  | { ok: true; declined: true }
  | { ok: false; code: "not_found" | "unauthorized" | "invalid_state"; message: string };

/** The customer declines the tip — recorded in completion_tips (status
 *  'declined') for the reconciliation paper trail; completion proceeds. Calling
 *  this is idempotent per job (prior declined rows are replaced, never stacked). */
export async function declineTipCore(user: PhotoUser, data: unknown): Promise<TipDeclineResult> {
  const v = z.object({ jobId: z.string().min(1).max(128) }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid request." };
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    if (job.status !== "arrived" && job.status !== "completed") return { ok: false, code: "invalid_state", message: "Tips are available once you've arrived." };
    const q = await db();
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
    await q`DELETE FROM completion_tips WHERE org_id=${user.orgId} AND job_id=${job.id} AND status='declined'`;
    await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, status, error)
      VALUES(gen_random_uuid()::text, ${user.orgId}, ${job.id}, ${user.id}, ${user.towbookDriverId || null}, 0, 'USD', 'declined', 'customer declined the tip')`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'job_tip_declined', 'job', ${job.id},
          ${JSON.stringify({ driverTowbookId: user.towbookDriverId })}::jsonb, 'completion-flow'`;
    } catch { /* best-effort audit */ }
    return { ok: true, declined: true };
  } catch {
    return { ok: false, code: "invalid_state", message: "Unable to record the tip decision. Try again." };
  }
}

/** Append one tip attempt to the attribution ledger. */
async function recordTipAttempt(
  user: PhotoUser,
  jobId: string,
  row: { status: "failed"; amountCents: number; currency: string; attempt: number; idempotencyKey: string; error: string; squarePaymentId?: string },
): Promise<void> {
  try {
    const q = await db();
    await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, square_payment_id, status, error, attempt, idempotency_key)
      VALUES(gen_random_uuid()::text, ${user.orgId}, ${jobId}, ${user.id}, ${user.towbookDriverId || null}, ${row.amountCents}, ${row.currency}, ${row.squarePaymentId ?? null}, ${row.status}, ${row.error}, ${row.attempt}, ${row.idempotencyKey})`;
  } catch { /* never mask the outcome */ }
}

export type SquarePublicConfigResult =
  | { ok: true; applicationId: string; locationId: string }
  | { ok: false; code: "square_not_configured"; message: string };

/** PUBLIC Web Payments config for the driver portal's card form — application id
 *  + location id ONLY. The access token is never exposed to the client.
 *  Injectable stableDir for hermetic tests (same pattern as the other cores). */
export async function getSquareWebPaymentsConfigCore(opts: { stableDir?: string } = {}): Promise<SquarePublicConfigResult> {
  try {
    const config = await loadSquarePublicConfig(process.env, { stableDir: opts.stableDir });
    return { ok: true, applicationId: config.applicationId, locationId: config.locationId };
  } catch (err) {
    return { ok: false, code: "square_not_configured", message: err instanceof Error ? err.message : "Tips aren't connected yet." };
  }
}

/* ------------------------------ reads + handlers ------------------------------ */

export type CompletionReadResult =
  | { ok: true; completion: CompletionCaptureStatus }
  | { ok: false; code: "not_found" | "unauthorized" | "invalid_state"; message: string };

/** Driver (own jobs only) / owner / admin / dispatcher read of one capture. */
export async function getCompletionCaptureCore(user: { orgId: string; role: string; id: string; towbookDriverId: string }, data: unknown): Promise<CompletionReadResult> {
  const v = z.object({ jobId: z.string().min(1).max(128) }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid request." };
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found." };
    if (user.role === "contractor") {
      const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
      if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
    }
    return { ok: true, completion: await completionCaptureForJob(user.orgId, job.id) };
  } catch {
    return { ok: false, code: "invalid_state", message: "Unable to load the completion capture." };
  }
}

export async function captureCompletionHandler(data: unknown, opts?: { fetchImpl?: typeof fetch; b2StableDir?: string }): Promise<CaptureCompletionResult> {
  if (!configured()) return { ok: false, code: "b2_not_configured", message: "Customer completion requires database mode." };
  const u = await resolveCompletionUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in as a driver first." };
  return captureCompletionCore(u, data, opts);
}

export async function createTipLinkHandler(data: unknown, opts?: { fetchImpl?: typeof fetch; squareStableDir?: string }): Promise<TipLinkResult> {
  if (!configured()) return { ok: false, code: "square_not_configured", message: "Tips require database mode." };
  const u = await resolveCompletionUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in as a driver first." };
  return createTipLinkCore(u, data, opts);
}

export async function getCompletionCaptureHandler(data: unknown): Promise<CompletionReadResult> {
  if (!configured()) return { ok: false, code: "invalid_state", message: "Requires database mode." };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in first." };
  const q = await db();
  const rows = await q`SELECT towbook_driver_id FROM users WHERE id=${u.id}`;
  return getCompletionCaptureCore(
    { orgId: u.orgId, role: u.role, id: u.id, towbookDriverId: rows.length ? String(rows[0].towbook_driver_id ?? "") : "" },
    data,
  );
}

export async function allCompletionCapturesHandler(): Promise<CompletionCaptureStatus[]> {
  if (!configured()) return [];
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || (u.role !== "owner" && u.role !== "admin" && u.role !== "dispatcher")) return [];
  return allCompletionCapturesCore(u.orgId);
}

export async function isSquareConfiguredHandler(): Promise<{ configured: boolean }> {
  if (!configured()) return { configured: false };
  return { configured: await isSquareConfiguredCore() };
}

export async function chargeTipHandler(data: unknown, opts?: { fetchImpl?: typeof fetch; squareStableDir?: string }): Promise<TipChargeResult> {
  if (!configured()) return { ok: false, code: "square_not_configured", message: "Tips require database mode." };
  const u = await resolveCompletionUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in as a driver first." };
  return chargeTipCore(u, data, opts);
}

export async function declineTipHandler(data: unknown): Promise<TipDeclineResult> {
  if (!configured()) return { ok: false, code: "invalid_state", message: "Requires database mode." };
  const u = await resolveCompletionUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in as a driver first." };
  return declineTipCore(u, data);
}

export async function getSquareWebPaymentsConfigHandler(): Promise<SquarePublicConfigResult> {
  if (!configured()) return { ok: false, code: "square_not_configured", message: "Requires database mode." };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false, code: "square_not_configured", message: "Sign in first." };
  return getSquareWebPaymentsConfigCore();
}
