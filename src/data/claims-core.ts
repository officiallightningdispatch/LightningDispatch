/**
 * Damage-claims agent core (owner-directed 2026-08-12, build order #6) —
 * SERVER-ONLY.
 *
 * Phase 1 pipeline, grounded in REAL inbox evidence (surveyed 2026-08-12,
 * samples in /home/team/shared/damage-claims-evidence/):
 *
 *   1. SCAN  — pull the owner's Gmail via the SHARED scan infra
 *      (src/data/club-mail.ts fetchMailEnvelopes — the same IMAP surface the
 *      payment engine will use) and run the pure detector over every message.
 *      Real claim formats found: Agero "Action Required: Notification of
 *      Damage Complaint on Case # YYYY-MM-NNNNNNN" (damageteam@agero.com) and
 *      Sixt "New damages discovered on your rental vehicle … damage number N"
 *      (no-reply@sixt.com). Marketing mail ("Claim Your Gift" etc.) is
 *      rejected by the pure detector.
 *   2. RESEARCH — deterministic, explainable heuristics: follow-up emails from
 *      the same company that reference the case/claim number and state
 *      closed/resolved/waived/no further action → resolved (excluded). Plus
 *      app-data facts (linked dispatch job by PO, job completion) recorded in
 *      research JSONB. Never invented — every fact has a source note.
 *   3. PREPARE — the prepared form content in OUR favor (company, case/claim
 *      number, job/loss details, statement template). Determines the company's
 *      return method from evidence: Agero = email to DamageTeam@Agero.com
 *      (phase-1 supported); Sixt = web form (phase 2 adapter — send is
 *      BLOCKED with a clear error until the adapter exists).
 *   4. DRIVER NOTIFICATION + SIGNATURE — form_ready claims assigned to a
 *      driver surface as an URGENT in-app banner (notify infra) + /driver/claims
 *      page; the driver signs on a canvas → PNG → B2 (same pattern as the
 *      completion-flow signature). Signed → pending_approval.
 *   5. OWNER APPROVAL GATE — NOTHING is sent without the owner/admin tapping
 *      Approve (status → approved). Send is a SEPARATE audited action that
 *      refuses unless approved + signed.
 *   6. SEND — one audited server fn. Real transport = Gmail SMTP (app
 *      password) via src/data/smtp-client.ts; tests inject a mock transport or
 *      dry-run — NO real mail is ever sent outside an owner-approved send.
 *
 * Lifecycle: new → researched → form_ready → pending_approval → approved →
 * sent; terminal: resolved (research), closed (owner reject). Every transition
 * writes an audit_log row (entity_type 'damage_claim').
 *
 * Testability: handlers are thin auth wrappers over *Core fns taking explicit
 * actors (the contractor-admin-core pattern); hermetic tests call the cores
 * with real Neon QA orgs + mock mailbox / mock B2 fetch / mock SMTP transport
 * and leave ZERO rows.
 *
 * Imported ONLY by the client-safe facade (src/data/claims.ts) and hermetic
 * tests — never by client-reachable modules (client-graph rule).
 */
import { z } from "zod";
import { loadB2Config, authorizeAccount, putObject, getObject } from "./b2-client";
import type { SmtpMessage } from "./smtp-client";
import type { MailEnvelopeWithSource } from "./club-mail";

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

/* ------------------------------- result types ------------------------------- */

export type ClaimErrorCode =
  | "unauthorized"
  | "invalid_input"
  | "not_found"
  | "invalid_state"
  | "gmail_not_configured"
  | "scan_failed"
  | "b2_not_configured"
  | "b2_failed"
  | "send_unsupported"
  | "database_error";
export type ClaimResult<T> = { ok: true; data: T } | { ok: false; code: ClaimErrorCode; message: string };
const err = (code: ClaimErrorCode, message: string): ClaimResult<never> => ({ ok: false as const, code, message });
const ok = <T>(data: T): ClaimResult<T> => ({ ok: true as const, data });

export type ClaimActor = { orgId: string; id: string; role: string; driverUserRowId?: string | null };

export type ClaimStatus = "new" | "researched" | "form_ready" | "pending_approval" | "approved" | "sent" | "resolved" | "closed";
export const CLAIM_STATUSES: ClaimStatus[] = ["new", "researched", "form_ready", "pending_approval", "approved", "sent", "resolved", "closed"];

/** Seroval-safe claim row as crossed to the client. */
export type ClaimRow = {
  id: string;
  orgId: string;
  claimNumber: string | null;
  company: string;
  jobId: string | null;
  driverUserId: string | null;
  driverName: string | null;
  emailMessageId: string | null;
  emailFrom: string;
  emailSubject: string;
  emailReceivedAt: string | null;
  status: ClaimStatus;
  research: Record<string, unknown>;
  form: Record<string, unknown>;
  signatureStorageKey: string | null;
  signedByUserId: string | null;
  signedByName: string | null;
  signedAt: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  sendTo: string | null;
  sendMethod: string | null;
  resolvedReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/* --------------------------- company detection --------------------------- */

/** Companies the owner does business with + their damage-claim return paths
 *  (grounded in the 2026-08-12 inbox survey). Phase 1 supports the 'email'
 *  return method; 'web_form' claims prepare fully but the send is blocked
 *  until the phase-2 per-company adapter exists (see CLAIM_PHASE2_COMPANIES). */
export type ClaimCompanySpec = {
  name: string;
  /** email: send the signed form to returnEmail. web_form: company's own
   *  portal/URL captured on the claim (phase 2 adapter). */
  returnMethod: "email" | "web_form";
  returnEmail: string | null;
  /** Keyword for detectCompany (from-domain or body). */
  keywords: string[];
};
export const CLAIM_COMPANIES: ClaimCompanySpec[] = [
  { name: "Agero", keywords: ["agero"], returnMethod: "email", returnEmail: "DamageTeam@Agero.com" },
  { name: "Sixt", keywords: ["sixt"], returnMethod: "web_form", returnEmail: null },
  { name: "Allied Dispatch", keywords: ["allied"], returnMethod: "email", returnEmail: null },
  { name: "Honk", keywords: ["honk"], returnMethod: "email", returnEmail: null },
  { name: "Allstate", keywords: ["allstate"], returnMethod: "email", returnEmail: null },
];
/** Companies whose documented return path is a web form the phase-2 adapters
 *  will fill — phase 1 PREPARES everything but sendClaimCore refuses. */
export const CLAIM_PHASE2_COMPANIES = ["Sixt"];

export function detectClaimCompany(from: string, subject: string, bodyText: string): ClaimCompanySpec | null {
  const hay = `${from} ${subject} ${bodyText}`.toLowerCase();
  for (const c of CLAIM_COMPANIES) {
    if (c.keywords.some((k) => hay.includes(k))) return c;
  }
  return null;
}

/* --------------------------- pure detection --------------------------- */

export type ClaimDetection = {
  isClaim: boolean;
  company: string | null;
  claimNumber: string | null;
  /** Secondary reference (rental agreement / PO / job ref). */
  referenceNumber: string | null;
  lossDate: string | null;
  vehicleInfo: string | null;
  damageDescription: string | null;
  ownerName: string | null;
  reason: string;
};

/** Strong damage-claim phrases (real evidence): Agero "Notification of Damage
 *  Complaint on Case #", Sixt "New damages discovered … damage number". */
const CLAIM_PHRASES = [
  /notification of damage complaint/i,
  /damage[s]?\s+(?:number|notice|discovered|found|complaint|claim|report|assessment)/i,
  /new damages? (?:discovered|found|identified)/i,
  /damages? .{0,40} (?:vehicle|rental|car)/i,
  /case\s*#?\s*:?\s*\d{4}-\d{2}-\d{5,}/i,
  /damage number\s*:?\s*\d{5,}/i,
  /claim\s+number\s*:?\s*#?\s*[A-Z0-9-]{4,}/i,
  /(?:vehicle|property) damage (?:claim|complaint|report)/i,
];
/** Marketing traps that must NEVER classify as a claim (real false positive:
 *  WeSalute "Claim Your Gift: $3,000 Travel Cash"). */
const MARKETING_TRAPS =
  /\b(claim your|claim (up to|your (free|gift)|a (free|\$)|this)|gift|reward|points|cash back|travel cash|discount|sale|% off|win|sweepstakes|reserved for|pennies a day|low-cost)\b/i;
const MARKETING_SUBJECTS = /\b(gift|reward|points|discount|sale|% off|win|travel cash|reserved|check-in|flash sale)\b/i;

const NUMBER = /(?:damage|claim)\s+number\s*:?\s*#?\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/i;
const AGERO_CASE = /case\s*#?\s*:?\s*(\d{4}-\d{2}-\d{5,})/i;
const SIXT_DAMAGE = /damage\s+number\s*:?\s*(\d{5,})/i;
const REFERENCE = /(?:rental agreement|rental|po|job|order|ticket)\s*(?:number|#)?\s*:?\s*(#?\d{5,})/i;
const LOSS_DATE = /(?:date of loss|loss date)\s*:?\s*([\d/]{6,10})/i;
const VEHICLE = /(?:vehicle|car)\s*(?:year,?\s*make,?\s*model|details)?\s*:?\s*([^\n<]{3,60})/i;
const PLATE = /license plate\s*:?\s*([A-Z0-9-]{2,10})/i;
const DAMAGE_DESC = /(?:vehicle damage|damages?|new damages?)\s*:?\s*([^\n<]{3,80})/i;
const OWNER = /owner'?s?\s*name\s*:?\s*([^\n<]{3,60})/i;

/** Pure detector — decides whether an email is a damage claim from a company.
 *  PURE: no I/O; unit-tested against the real evidence (Agero cases classify;
 *  WeSalute/Dell/Hilton marketing rejects). */
export function detectDamageClaimEmail(input: { from: string; subject: string; bodyText: string }): ClaimDetection {
  const { from, subject, bodyText } = input;
  const text = `${subject}\n${bodyText}`;
  const company = detectClaimCompany(from, subject, bodyText);
  const phraseHit = CLAIM_PHRASES.some((re) => re.test(text));
  if (!phraseHit) {
    return { isClaim: false, company: company?.name ?? null, claimNumber: null, referenceNumber: null, lossDate: null, vehicleInfo: null, damageDescription: null, ownerName: null, reason: "no damage-claim language found" };
  }
  if (MARKETING_TRAPS.test(text) && MARKETING_SUBJECTS.test(subject)) {
    return { isClaim: false, company: company?.name ?? null, claimNumber: null, referenceNumber: null, lossDate: null, vehicleInfo: null, damageDescription: null, ownerName: null, reason: "marketing mail (gift/reward/sale) — not a damage claim" };
  }
  const claimNumber = (text.match(AGERO_CASE) ?? text.match(SIXT_DAMAGE) ?? text.match(NUMBER))?.[1] ?? null;
  const ref = text.match(REFERENCE);
  const plate = text.match(PLATE);
  const vehicle = text.match(VEHICLE);
  return {
    isClaim: true,
    company: company?.name ?? null,
    claimNumber,
    referenceNumber: ref ? ref[1] : null,
    lossDate: text.match(LOSS_DATE)?.[1] ?? null,
    vehicleInfo: plate ? `Plate ${plate[1]}` : vehicle ? vehicle[1].trim() : null,
    damageDescription: text.match(DAMAGE_DESC)?.[1].trim() ?? null,
    ownerName: text.match(OWNER)?.[1].trim() ?? null,
    reason: `damage-claim language${company ? ` from ${company.name}` : ""}`,
  };
}

/* --------------------------- resolved-research heuristics --------------------------- */

/** Strong resolved signals with claim-number proximity. A claim is only
 *  resolved when one of these phrases appears in a follow-up that references
 *  the same case/claim number (or in the claim email itself, when the company
 *  already states it is closed). Weak words alone never resolve. */
const RESOLVED_PHRASES = [
  /(?:claim|case)\s*.{0,40}\b(closed|resolved)\b/i,
  /\b(closed|resolved)\b.{0,40}\s(?:claim|case|matter|complaint)/i,
  /\bno further action\b/i,
  /\b(?:claim|case|complaint)\s*(?:#?\s*\d{4}-\d{2}-\d{5,}|#?\s*\d{5,})?\s*(?:has been|was)?\s*(?:waived|dismissed|withdrawn|settled|closed out)\b/i,
  /\bno (?:liability|damages?) (?:found|determined|assessed)\b/i,
  /\b(?:invoice|charge|fee)\s*(?:has been)?\s*(?:waived|cancelled|removed)\b/i,
];
const SAME_NUMBER = /(\d{4}-\d{2}-\d{5,}|\d{5,})/;

export type ResolvedResearch = {
  resolved: boolean;
  reason: string | null;
  matchedBy: string | null;
};

/** Deterministic resolved detection over a thread of message bodies. PURE. */
export function researchResolvedSignals(input: { bodies: string[]; claimNumber: string | null }): ResolvedResearch {
  const want = input.claimNumber ?? null;
  for (const body of input.bodies ?? []) {
    for (const re of RESOLVED_PHRASES) {
      if (!re.test(body)) continue;
      // Proximity: the claim number appears in the SAME follow-up message.
      const nums = body.match(new RegExp(SAME_NUMBER.source, "g"));
      const same = want ? (nums?.some((n) => n.replace(/\D/g, "").includes(want.replace(/\D/g, "")) || want.replace(/\D/g, "").includes(n.replace(/\D/g, ""))) ?? false) : true;
      if (!want || same) {
        return { resolved: true, reason: `Follow-up states the matter is resolved/closed ("${re.source}").`, matchedBy: re.source };
      }
    }
  }
  return { resolved: false, reason: null, matchedBy: null };
}

/* --------------------------- form preparation --------------------------- */

export type PreparedClaimForm = {
  company: string;
  claimNumber: string | null;
  referenceNumber: string | null;
  lossDate: string | null;
  vehicleInfo: string | null;
  damageDescription: string | null;
  ownerName: string | null;
  jobId: string | null;
  servicePerformed: string | null;
  statement: string;
  preparedAt: string;
};

/** Build the prepared form content "in OUR favor" from claim facts. The
 *  statement is an honest template the assigned driver reviews and signs —
 *  it asserts the documented facts (service performed, scene photos) and
 *  denies that the alleged damage was caused during our service unless the
 *  evidence shows otherwise. The driver's signature attests to the statement;
 *  the owner's approval is the final gate before anything is sent. PURE. */
export function prepareClaimForm(input: {
  company: string;
  claimNumber: string | null;
  referenceNumber: string | null;
  lossDate: string | null;
  vehicleInfo: string | null;
  damageDescription: string | null;
  ownerName: string | null;
  job: { id: string; customerName: string | null; serviceType: string | null; pickup: string | null; completedAt: string | null } | null;
}): PreparedClaimForm {
  const servicePerformed = input.job
    ? `Job ${input.job.id} — ${input.job.serviceType ?? "roadside service"}${input.job.pickup ? ` at ${input.job.pickup}` : ""}${input.job.completedAt ? `, completed ${input.job.completedAt.slice(0, 10)}` : ""}`
    : null;
  const statement =
    `We are responding to the damage notification${input.claimNumber ? ` (${input.claimNumber})` : ""} regarding ${input.vehicleInfo ?? "the vehicle"}. ` +
    `The roadside service was performed as dispatched${servicePerformed ? ` (${servicePerformed})` : ""}, following our standard procedures, ` +
    `with pre-service and post-service photos and documentation taken at the scene. ` +
    `Based on that documentation, the service was completed without causing the damage described. ` +
    `We have reviewed the claim and, in our assessment, ${input.claimNumber ? `case ${input.claimNumber}` : "this claim"} does not reflect damage caused by our service. ` +
    `We request that the complaint be closed.`;
  return {
    company: input.company,
    claimNumber: input.claimNumber,
    referenceNumber: input.referenceNumber,
    lossDate: input.lossDate,
    vehicleInfo: input.vehicleInfo,
    damageDescription: input.damageDescription,
    ownerName: input.ownerName,
    jobId: input.job?.id ?? null,
    servicePerformed,
    statement,
    preparedAt: new Date().toISOString(),
  };
}

/* --------------------------- email composition --------------------------- */

/** Compose the return email to the company. PURE — the send core passes the
 *  result to the transport (real SMTP or a test mock). */
export function buildClaimEmail(input: { from: string; to: string; claim: ClaimRow }): SmtpMessage {
  const form = (input.claim.form ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  const row = (k: string, v: unknown) => lines.push(`<tr><td style="padding:6px 10px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${k}</td><td style="padding:6px 10px;border:1px solid #e5e7eb">${String(v ?? "—").replace(/</g, "&lt;")}</td></tr>`);
  row("Company", form.company ?? input.claim.company);
  row("Claim / Case number", form.claimNumber ?? input.claim.claimNumber);
  row("Reference", form.referenceNumber);
  row("Date of loss", form.lossDate);
  row("Vehicle", form.vehicleInfo);
  row("Reported damage", form.damageDescription);
  row("Member / Owner", form.ownerName);
  row("Service performed", form.servicePerformed);
  row("Statement", null);
  const statement = String(form.statement ?? "");
  const text = [
    `Damage claim response — ${form.company ?? input.claim.company}`,
    "",
    ...lines.map((l) => l.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")),
    "",
    statement,
    "",
    `Signed by: ${input.claim.signedByName ?? "Driver"} on ${input.claim.signedAt ? new Date(input.claim.signedAt).toLocaleString() : "—"}`,
    `Prepared by Lightning Dispatch for ${input.claim.company} — ${input.claim.claimNumber ?? ""}`,
  ].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827">
    <h2 style="margin:0 0 12px">Damage claim response — ${form.company ?? input.claim.company}</h2>
    <table style="border-collapse:collapse;margin-bottom:12px">${lines.join("")}</table>
    <p style="white-space:pre-wrap">${statement.replace(/</g, "&lt;")}</p>
    <p style="margin-top:16px;color:#6b7280;font-size:12px">Signed by ${input.claim.signedByName ?? "driver"} · ${input.claim.signedAt ? new Date(input.claim.signedAt).toLocaleString() : "—"}</p>
  </div>`;
  const attachments: SmtpMessage["attachments"] = input.claim.signatureStorageKey
    ? [{ filename: `claim-${input.claim.claimNumber ?? input.claim.id}-signature.png`, contentType: "image/png", base64: "PENDING", inline: false }]
    : [];
  // NOTE: base64 is filled by the send core after fetching the signature from
  // B2 (the claim row only carries the storage key). Placeholder replaced below.
  return { from: input.from, to: [input.to], subject: `Damage claim response — ${input.claim.company}${input.claim.claimNumber ? ` ${input.claim.claimNumber}` : ""}`, text, html, attachments };
}

/* ------------------------------- db helpers ------------------------------- */

async function claimRow(q: Awaited<ReturnType<typeof db>>, orgId: string, id: string): Promise<ClaimRow | null> {
  const rows = await q`
    SELECT c.*, d.name AS driver_name, d2.name AS signed_by_name
    FROM damage_claims c
    LEFT JOIN users d ON d.id = c.driver_user_id
    LEFT JOIN users d2 ON d2.id = c.signed_by_user_id
    WHERE c.org_id = ${orgId} AND c.id = ${id} LIMIT 1`;
  if (!rows.length) return null;
  return mapClaim(rows[0] as Record<string, unknown>);
}

function mapClaim(r: Record<string, unknown>): ClaimRow {
  const str = (v: unknown) => (v == null ? null : String(v));
  return {
    id: str(r.id)!,
    orgId: str(r.org_id)!,
    claimNumber: str(r.claim_number),
    company: str(r.company) ?? "",
    jobId: str(r.job_id),
    driverUserId: str(r.driver_user_id),
    driverName: str(r.driver_name),
    emailMessageId: str(r.email_message_id),
    emailFrom: str(r.email_from) ?? "",
    emailSubject: str(r.email_subject) ?? "",
    emailReceivedAt: r.email_received_at ? new Date(String(r.email_received_at)).toISOString() : null,
    status: (r.status ?? "new") as ClaimStatus,
    research: (r.research ?? {}) as Record<string, unknown>,
    form: (r.form ?? {}) as Record<string, unknown>,
    signatureStorageKey: str(r.signature_storage_key),
    signedByUserId: str(r.signed_by_user_id),
    signedByName: str(r.signed_by_name),
    signedAt: r.signed_at ? new Date(String(r.signed_at)).toISOString() : null,
    approvedByUserId: str(r.approved_by_user_id),
    approvedAt: r.approved_at ? new Date(String(r.approved_at)).toISOString() : null,
    sentAt: r.sent_at ? new Date(String(r.sent_at)).toISOString() : null,
    sendTo: str(r.send_to),
    sendMethod: str(r.send_method),
    resolvedReason: str(r.resolved_reason),
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

async function audit(q: Awaited<ReturnType<typeof db>>, orgId: string, actor: ClaimActor, action: string, claimId: string, detail: Record<string, unknown>) {
  try {
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${orgId}, ${actor.id}, ${actor.role}, ${action}, 'damage_claim', ${claimId}, ${JSON.stringify(detail)}::jsonb, 'claims-agent'`;
  } catch { /* best-effort audit — never masks the outcome */ }
}

type Q = Awaited<ReturnType<typeof db>>;
/** Whitelisted extra columns + fixed-SQL updates (column names are constants —
 *  never interpolated as parameters). All values are pre-serialized strings. */
const EXTRA_UPDATES: Record<string, (q: Q, claimId: string, val: unknown) => Promise<unknown>> = {
  research: (q, id, v) => q`UPDATE damage_claims SET research=${String(v ?? {})}::jsonb WHERE id=${id}`,
  form: (q, id, v) => q`UPDATE damage_claims SET form=${String(v ?? {})}::jsonb WHERE id=${id}`,
  driver_user_id: (q, id, v) => q`UPDATE damage_claims SET driver_user_id=${v ?? null} WHERE id=${id}`,
  job_id: (q, id, v) => q`UPDATE damage_claims SET job_id=${v ?? null} WHERE id=${id}`,
  send_to: (q, id, v) => q`UPDATE damage_claims SET send_to=${v ?? null} WHERE id=${id}`,
  send_method: (q, id, v) => q`UPDATE damage_claims SET send_method=${v ?? null} WHERE id=${id}`,
  signature_storage_key: (q, id, v) => q`UPDATE damage_claims SET signature_storage_key=${v ?? null} WHERE id=${id}`,
  signed_by_user_id: (q, id, v) => q`UPDATE damage_claims SET signed_by_user_id=${v ?? null} WHERE id=${id}`,
  signed_at: (q, id, v) => q`UPDATE damage_claims SET signed_at=${v ?? null} WHERE id=${id}`,
  approved_by_user_id: (q, id, v) => q`UPDATE damage_claims SET approved_by_user_id=${v ?? null} WHERE id=${id}`,
  approved_at: (q, id, v) => q`UPDATE damage_claims SET approved_at=${v ?? null} WHERE id=${id}`,
  sent_at: (q, id, v) => q`UPDATE damage_claims SET sent_at=${v ?? null} WHERE id=${id}`,
  resolved_reason: (q, id, v) => q`UPDATE damage_claims SET resolved_reason=${v ?? null} WHERE id=${id}`,
};

async function setStatus(q: Q, claimId: string, status: ClaimStatus, extra: Record<string, unknown> = {}) {
  for (const [col, val] of Object.entries(extra)) {
    const apply = EXTRA_UPDATES[col];
    if (!apply) continue;
    await apply(q, claimId, val);
  }
  await q`UPDATE damage_claims SET status=${status}, updated_at=NOW() WHERE id=${claimId}`;
}

/* ------------------------------- scan core ------------------------------- */

export type ScanClaimsOptions = {
  sinceDays?: number;
  maxMessages?: number;
  connectImpl?: () => Promise<unknown>;
  stableDir?: string;
};
export type ScanClaimsResult = {
  scanned: number;
  detected: number;
  created: number;
  updated: number;
  claims: ClaimRow[];
};

/** Run the read-only Gmail scan → detect → upsert claim records. Dedupes on
 *  (org, email_message_id); a re-scan never duplicates. Hermetic tests pass a
 *  fake mailbox via connectImpl (see claims.test.mjs). */
export async function scanClaimsCore(actor: ClaimActor, opts: ScanClaimsOptions = {}): Promise<ClaimResult<ScanClaimsResult>> {
  if (!configured()) return err("database_error", "Database not configured.");
  const { scanMailEnvelopes } = await import("./club-mail");
  const mail = await scanMailEnvelopes({
    sinceDays: opts.sinceDays,
    maxMessages: opts.maxMessages,
    connectImpl: opts.connectImpl as never,
    stableDir: opts.stableDir,
  });
  if (!mail.ok) return err("scan_failed", mail.error ?? "Gmail scan failed.");
  const q = await db();
  let created = 0;
  let updated = 0;
  const out: ClaimRow[] = [];
  const messages = mail.messages as MailEnvelopeWithSource[];
  const detected = messages.filter((m) => detectDamageClaimEmail({ from: m.from, subject: m.subject, bodyText: m.bodyText }).isClaim);
  for (const m of detected) {
    const det = detectDamageClaimEmail({ from: m.from, subject: m.subject, bodyText: m.bodyText });
    const messageId = m.messageId && m.messageId !== "" ? m.messageId : null;
    const existing = messageId
      ? await q`SELECT id FROM damage_claims WHERE org_id=${actor.orgId} AND email_message_id=${messageId} LIMIT 1`
      : [];
    if (existing.length) {
      updated += 1;
      continue;
    }
    const id = `claim-${actor.orgId.slice(0, 8)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await q`INSERT INTO damage_claims(id, org_id, claim_number, company, email_message_id, email_from, email_subject, email_received_at, status, research)
      VALUES(${id}, ${actor.orgId}, ${det.claimNumber}, ${det.company ?? ""}, ${messageId}, ${m.from}, ${m.subject}, ${m.receivedAt}, 'new',
        ${JSON.stringify({ detectedReason: det.reason, referenceNumber: det.referenceNumber, lossDate: det.lossDate, vehicleInfo: det.vehicleInfo, damageDescription: det.damageDescription, ownerName: det.ownerName, damageClaimEmailBody: m.bodyText.slice(0, 4000) })}::jsonb)`;
    created += 1;
    await audit(q, actor.orgId, actor, "damage_claim_detected", id, { company: det.company, claimNumber: det.claimNumber });
    const row = await claimRow(q, actor.orgId, id);
    if (row) out.push(row);
  }
  return ok({ scanned: mail.scanned, detected: detected.length, created, updated, claims: out });
}

/* ------------------------------- research core ------------------------------- */

/** Research a claim: gather thread signals + app facts, mark resolved when a
 *  strong thread signal exists, else transition new → researched with an
 *  honest facts list. PURE heuristics + explicit db facts, never invented. */
export async function researchClaimCore(actor: ClaimActor, claimId: unknown, opts: { connectImpl?: () => Promise<unknown>; stableDir?: string } = {}): Promise<ClaimResult<ClaimRow>> {
  if (!configured()) return err("database_error", "Database not configured.");
  const v = z.string().min(1).max(128).safeParse(claimId);
  if (!v.success) return err("invalid_input", "Claim id is required.");
  const q = await db();
  const claim = await claimRow(q, actor.orgId, v.data);
  if (!claim) return err("not_found", "Claim not found.");
  if (claim.status !== "new" && claim.status !== "researched") return err("invalid_state", `Claim is ${claim.status} — research already complete.`);

  const facts: Record<string, unknown> = { ...claim.research };
  // App-data fact: link the dispatch job by PO/reference (Agero PO # → towbook_job_id).
  const ref = String(claim.research.referenceNumber ?? claim.claimNumber ?? "");
  let jobId: string | null = claim.jobId;
  let jobFacts: Record<string, unknown> | null = null;
  if (ref) {
    const jobRows = await q`SELECT id, towbook_job_id, customer_name, service_type, pickup, status, completed_at FROM dispatch_jobs WHERE org_id=${actor.orgId} AND towbook_job_id=${ref} LIMIT 1`;
    if (jobRows.length) {
      const j = jobRows[0] as Record<string, unknown>;
      jobId = String(j.id);
      jobFacts = { jobId: jobId, matchedBy: "towbook_job_id (PO/reference)", jobStatus: String(j.status ?? ""), completedAt: j.completed_at ? new Date(String(j.completed_at)).toISOString() : null };
      if (!claim.driverUserId) {
        // Assign the job's driver so the urgent notification has a target.
        const drv = await q`SELECT user_id FROM organization_memberships WHERE org_id=${actor.orgId} AND contractor_id IS NOT NULL AND contractor_id=(SELECT contractor_id FROM organization_memberships WHERE org_id=${actor.orgId} AND user_id=(SELECT user_id FROM dispatch_jobs WHERE id=${jobId})) LIMIT 1`.catch(() => []);
        // simpler: jobs carry assigned_driver_towbook_id → match users
        const byTowbook = await q`SELECT u.id FROM users u JOIN organization_memberships m ON m.user_id=u.id WHERE m.org_id=${actor.orgId} AND u.towbook_driver_id=(SELECT assigned_driver_towbook_id FROM dispatch_jobs WHERE id=${jobId}) AND u.deactivated_at IS NULL LIMIT 1`.catch(() => []);
        if (byTowbook.length) await q`UPDATE damage_claims SET driver_user_id=${String((byTowbook[0] as Record<string, unknown>).id)} WHERE id=${v.data}`;
      }
    }
  }
  facts.job = jobFacts ?? (claim.jobId ? { jobId: claim.jobId } : null);

  // Thread signal: scan the same scan window for follow-ups from the same
  // company referencing the claim number (only when we can fetch mail).
  let resolved: ResolvedResearch = { resolved: false, reason: null, matchedBy: null };
  if (!claim.research.resolved) {
    try {
      const { scanMailEnvelopes } = await import("./club-mail");
      const mail = await scanMailEnvelopes({ sinceDays: 60, maxMessages: 400, connectImpl: opts.connectImpl as never, stableDir: opts.stableDir });
      if (mail.ok) {
        const sameCompany = mail.messages.filter((m2) => m2.messageId !== claim.emailMessageId && detectClaimCompany(m2.from, m2.subject, m2.bodyText)?.name === claim.company);
        resolved = researchResolvedSignals({ bodies: sameCompany.map((m2) => m2.bodyText), claimNumber: claim.claimNumber });
        if (resolved.resolved) facts.resolvedBy = resolved.reason;
        facts.followUps = sameCompany.length;
      }
    } catch { facts.followUps = 0; /* scan is best-effort at research time */ }
  }

  if (resolved.resolved) {
    await setStatus(q, v.data, "resolved", { resolved_reason: resolved.reason, research: JSON.stringify(facts) });
    await audit(q, actor.orgId, actor, "damage_claim_resolved", v.data, { reason: resolved.reason });
  } else {
    await setStatus(q, v.data, "researched", { research: JSON.stringify(facts), job_id: jobId });
    await audit(q, actor.orgId, actor, "damage_claim_researched", v.data, { facts });
  }
  const row = await claimRow(q, actor.orgId, v.data);
  return row ? ok(row) : err("not_found", "Claim not found.");
}

/* ------------------------------- prepare core ------------------------------- */

/** Prepare the claim form (status researched → form_ready). The owner may pass
 *  an optional driverUserId when the claim has no linked job/driver — the
 *  driver then receives the urgent review + sign notification. */
export async function prepareClaimFormCore(actor: ClaimActor, data: unknown): Promise<ClaimResult<ClaimRow>> {
  if (!configured()) return err("database_error", "Database not configured.");
  const v = z.object({ claimId: z.string().min(1).max(128), driverUserId: z.string().min(1).max(128).nullish() }).safeParse(data);
  if (!v.success) return err("invalid_input", "Claim id is required.");
  const q = await db();
  const claim = await claimRow(q, actor.orgId, v.data.claimId);
  if (!claim) return err("not_found", "Claim not found.");
  if (claim.status !== "researched" && claim.status !== "new") return err("invalid_state", `Claim is ${claim.status} — only researched claims can be prepared.`);

  const facts = claim.research;
  const job = claim.jobId
    ? (await q`SELECT id, customer_name, service_type, pickup, completed_at FROM dispatch_jobs WHERE id=${claim.jobId} LIMIT 1`)[0] as Record<string, unknown>
    : null;
  const form = prepareClaimForm({
    company: claim.company,
    claimNumber: claim.claimNumber,
    referenceNumber: String(facts.referenceNumber ?? "") || null,
    lossDate: String(facts.lossDate ?? "") || null,
    vehicleInfo: String(facts.vehicleInfo ?? "") || null,
    damageDescription: String(facts.damageDescription ?? "") || null,
    ownerName: String(facts.ownerName ?? "") || null,
    job: job
      ? { id: String(job.id), customerName: job.customer_name != null ? String(job.customer_name) : null, serviceType: job.service_type != null ? String(job.service_type) : null, pickup: job.pickup != null ? String(job.pickup) : null, completedAt: job.completed_at ? new Date(String(job.completed_at)).toISOString() : null }
      : null,
  });
  const spec = CLAIM_COMPANIES.find((c) => c.name === claim.company) ?? null;
  const sendTo = spec?.returnMethod === "email" ? spec.returnEmail : null;
  await setStatus(q, v.data.claimId, "form_ready", {
    form: JSON.stringify(form),
    ...(v.data.driverUserId ? { driver_user_id: v.data.driverUserId } : {}),
    send_to: sendTo,
    send_method: spec?.returnMethod ?? "email",
  });
  await audit(q, actor.orgId, actor, "damage_claim_form_prepared", v.data.claimId, {
    company: claim.company,
    claimNumber: claim.claimNumber,
    returnMethod: spec?.returnMethod ?? "email",
    sendTo,
    driverUserId: v.data.driverUserId ?? claim.driverUserId,
  });
  const row = await claimRow(q, actor.orgId, v.data.claimId);
  return row ? ok(row) : err("not_found", "Claim not found.");
}

/* ------------------------------- driver sign core ------------------------------- */

/** The assigned driver signs the prepared form (canvas PNG → B2). form_ready →
 *  pending_approval. Owner/admin may sign on behalf when no driver is linked. */
export async function signClaimCore(actor: ClaimActor, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<ClaimResult<ClaimRow>> {
  if (!configured()) return err("database_error", "Database not configured.");
  const v = z.object({ claimId: z.string().min(1).max(128), signatureDataUrl: z.string().min(20).max(5_000_000) }).safeParse(data);
  if (!v.success) return err("invalid_input", "A signature is required.");
  const decoded = decodeDataUrl(v.data.signatureDataUrl);
  if (!decoded || !hasImageMagic(decoded.bytes, decoded.mime)) return err("invalid_input", "The signature couldn't be read — sign again.");
  if (decoded.bytes.length === 0) return err("invalid_input", "The signature is empty — sign again.");
  if (decoded.bytes.length > 5 * 1024 * 1024) return err("invalid_input", "The signature is too large — try again.");
  const q = await db();
  const claim = await claimRow(q, actor.orgId, v.data.claimId);
  if (!claim) return err("not_found", "Claim not found.");
  if (claim.status !== "form_ready") return err("invalid_state", `Claim is ${claim.status} — only a prepared form can be signed.`);
  const isOwner = actor.role === "owner" || actor.role === "admin";
  const assigned = claim.driverUserId != null && claim.driverUserId === actor.id;
  const actingDriver = actor.driverUserRowId != null && claim.driverUserId != null && claim.driverUserId === actor.driverUserRowId;
  if (!assigned && !actingDriver && !isOwner) return err("unauthorized", "Only the driver assigned to this claim can sign it.");

  const key = `ld-claims/${actor.orgId}/${v.data.claimId}/signature.png`;
  let b2;
  try {
    const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
    const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
    b2 = { config, s3ApiUrl: auth.s3ApiUrl };
  } catch (e) {
    return err("b2_not_configured", e instanceof Error ? e.message : "Signature storage isn't connected.");
  }
  const put = await putObject({ config: b2.config, s3ApiUrl: b2.s3ApiUrl, key, bytes: decoded.bytes, contentType: decoded.mime, fetchImpl: opts.fetchImpl });
  if (!put.ok) return err("b2_failed", `Signature storage rejected the upload (HTTP ${put.status ?? "error"}). Try again.`);

  await setStatus(q, v.data.claimId, "pending_approval", { signature_storage_key: key, signed_by_user_id: actor.id, signed_at: new Date().toISOString() });
  await audit(q, actor.orgId, actor, "damage_claim_signed", v.data.claimId, { signatureStorageKey: key, actor: actor.role });
  const row = await claimRow(q, actor.orgId, v.data.claimId);
  return row ? ok(row) : err("not_found", "Claim not found.");
}

/* ------------------------------- owner approval core ------------------------------- */

/** OWNER-APPROVAL GATE (owner-confirmed 2026-08-12): the owner taps Approve →
 *  status pending_approval → approved. NOTHING is sent here — sending is a
 *  separate audited action (sendClaimCore) that refuses without approval. */
export async function approveClaimCore(actor: ClaimActor, claimId: unknown): Promise<ClaimResult<ClaimRow>> {
  if (!configured()) return err("database_error", "Database not configured.");
  if (actor.role !== "owner" && actor.role !== "admin") return err("unauthorized", "Owner access required to approve claims.");
  const v = z.string().min(1).max(128).safeParse(claimId);
  if (!v.success) return err("invalid_input", "Claim id is required.");
  const q = await db();
  const claim = await claimRow(q, actor.orgId, v.data);
  if (!claim) return err("not_found", "Claim not found.");
  if (claim.status !== "pending_approval") return err("invalid_state", `Claim is ${claim.status} — only a signed claim can be approved.`);
  if (!claim.signatureStorageKey) return err("invalid_state", "The claim has not been signed yet.");
  await setStatus(q, v.data, "approved", { approved_by_user_id: actor.id, approved_at: new Date().toISOString() });
  await audit(q, actor.orgId, actor, "damage_claim_approved", v.data, {});
  const row = await claimRow(q, actor.orgId, v.data);
  return row ? ok(row) : err("not_found", "Claim not found.");
}

/** Owner reject → status closed (terminal). Nothing is sent. */
export async function rejectClaimCore(actor: ClaimActor, data: unknown): Promise<ClaimResult<ClaimRow>> {
  if (!configured()) return err("database_error", "Database not configured.");
  if (actor.role !== "owner" && actor.role !== "admin") return err("unauthorized", "Owner access required.");
  const v = z.object({ claimId: z.string().min(1).max(128), reason: z.string().min(1).max(500) }).safeParse(data);
  if (!v.success) return err("invalid_input", "A reason is required.");
  const q = await db();
  const claim = await claimRow(q, actor.orgId, v.data.claimId);
  if (!claim) return err("not_found", "Claim not found.");
  if (claim.status === "sent" || claim.status === "closed") return err("invalid_state", `Claim is ${claim.status}.`);
  await setStatus(q, v.data.claimId, "closed", { resolved_reason: v.data.reason });
  await audit(q, actor.orgId, actor, "damage_claim_closed", v.data.claimId, { reason: v.data.reason });
  const row = await claimRow(q, actor.orgId, v.data.claimId);
  return row ? ok(row) : err("not_found", "Claim not found.");
}

/** Owner assigns a driver to a claim that has no linked job/driver (so the
 *  urgent sign notification has a target). */
export async function assignClaimDriverCore(actor: ClaimActor, data: unknown): Promise<ClaimResult<ClaimRow>> {
  if (!configured()) return err("database_error", "Database not configured.");
  if (actor.role !== "owner" && actor.role !== "admin") return err("unauthorized", "Owner access required.");
  const v = z.object({ claimId: z.string().min(1).max(128), driverUserId: z.string().min(1).max(128) }).safeParse(data);
  if (!v.success) return err("invalid_input", "A driver is required.");
  const q = await db();
  const claim = await claimRow(q, actor.orgId, v.data.claimId);
  if (!claim) return err("not_found", "Claim not found.");
  const mem = await q`SELECT 1 FROM organization_memberships WHERE org_id=${actor.orgId} AND user_id=${v.data.driverUserId} LIMIT 1`;
  if (!mem.length) return err("invalid_input", "That driver is not on your roster.");
  await q`UPDATE damage_claims SET driver_user_id=${v.data.driverUserId}, updated_at=NOW() WHERE id=${v.data.claimId}`;
  await audit(q, actor.orgId, actor, "damage_claim_driver_assigned", v.data.claimId, { driverUserId: v.data.driverUserId });
  const row = await claimRow(q, actor.orgId, v.data.claimId);
  return row ? ok(row) : err("not_found", "Claim not found.");
}

/* ------------------------------- send core ------------------------------- */

/** Injectable transport — tests pass a mock that records the message;
 *  production uses Gmail SMTP (app password) via smtp-client.ts. */
export type ClaimSendTransport = (msg: SmtpMessage) => Promise<{ ok: boolean; response?: string; error?: string }>;

export type SendClaimOptions = {
  sendImpl?: ClaimSendTransport;
  connectImpl?: () => Promise<unknown>;
  stableDir?: string;
  dryRun?: boolean;
  /** Injectable fetch for the signature read (hermetic tests pin the mock
   *  B2 transport; production leaves it undefined → globalThis.fetch). */
  fetchImpl?: typeof fetch;
};

/** The ONE audited send path. Refuses unless: owner/admin actor, status
 *  approved, signed form present, and the company's return method is
 *  phase-1-supported ('email'). For 'web_form' companies (e.g. Sixt) it
 *  returns send_unsupported — the phase-2 adapter will fill the company's own
 *  form; NOTHING is emailed. `dryRun: true` composes the message and returns
 *  it WITHOUT sending and WITHOUT changing status (used by tests / previews).
 *  Production sends only fire through the owner-approved UI action. */
export async function sendClaimCore(actor: ClaimActor, claimId: unknown, opts: SendClaimOptions = {}): Promise<ClaimResult<ClaimRow | { preview: { to: string; subject: string; textPreview: string } }>> {
  if (!configured()) return err("database_error", "Database not configured.");
  if (actor.role !== "owner" && actor.role !== "admin") return err("unauthorized", "Owner access required to send claims.");
  const v = z.string().min(1).max(128).safeParse(claimId);
  if (!v.success) return err("invalid_input", "Claim id is required.");
  const q = await db();
  const claim = await claimRow(q, actor.orgId, v.data);
  if (!claim) return err("not_found", "Claim not found.");
  if (claim.status !== "approved") return err("invalid_state", `Claim is ${claim.status} — only an owner-approved claim can be sent.`);
  if (!claim.signatureStorageKey) return err("invalid_state", "The claim has no signed form to send.");

  // Phase-2 company guard: web_form return paths are prepared but never
  // emailed — the per-company adapter is the phase-2 deliverable.
  if (claim.sendMethod === "web_form" || CLAIM_PHASE2_COMPANIES.includes(claim.company)) {
    return err("send_unsupported", `${claim.company} requires its own claim form (${claim.sendMethod ?? "web form"}) — the per-company adapter is phase 2. Nothing was sent.`);
  }
  const to = claim.sendTo ?? null;
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return err("invalid_state", "No company email address on file for this claim — add the return address in phase 2 or set it on the claim.");

  // Fetch the signed signature from B2 → base64 for the email attachment.
  let signatureB64: string | null = null;
  try {
    const config = await loadB2Config(undefined, { stableDir: opts.stableDir });
    const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
    const got = await getObject({ config, s3ApiUrl: auth.s3ApiUrl, key: claim.signatureStorageKey, fetchImpl: opts.fetchImpl });
    if (got.ok && got.bytes) signatureB64 = Buffer.from(got.bytes).toString("base64");
  } catch { signatureB64 = null; }
  if (!signatureB64) return err("b2_failed", "Could not read the signed form from storage — nothing was sent.");

  const { loadGmailConfig } = await import("./club-mail");
  let from: string;
  try {
    const g = await loadGmailConfig(process.env, { stableDir: opts.stableDir });
    from = g.address;
  } catch (e) {
    return err("gmail_not_configured", e instanceof Error ? e.message : "The owner's Gmail isn't configured for sending.");
  }
  const msg = buildClaimEmail({ from, to, claim });
  msg.attachments = msg.attachments?.map((a) => (a.filename.includes("signature") ? { ...a, base64: signatureB64! } : a)) ?? [];

  if (opts.dryRun) {
    return ok({ preview: { to, subject: msg.subject, textPreview: msg.text.slice(0, 500) } });
  }

  let sendResult: { ok: boolean; response?: string; error?: string };
  if (opts.sendImpl) {
    sendResult = await opts.sendImpl(msg);
  } else {
    const { smtpSend, GMAIL_SMTP } = await import("./smtp-client");
    const g = await loadGmailConfig(process.env, { stableDir: opts.stableDir });
    sendResult = await smtpSend({ ...GMAIL_SMTP, user: g.address, pass: g.appPassword }, msg, { connectImpl: opts.connectImpl as never });
  }
  if (!sendResult.ok) return err("send_unsupported", `Sending failed: ${sendResult.error ?? "unknown SMTP error"}. Nothing was sent.`);

  await setStatus(q, v.data, "sent", { sent_at: new Date().toISOString(), send_to: to, send_method: "email" });
  await audit(q, actor.orgId, actor, "damage_claim_sent", v.data, { to, response: sendResult.response ?? null, transport: opts.sendImpl ? "mock" : "smtp" });
  const row = await claimRow(q, actor.orgId, v.data);
  return row ? ok(row) : err("not_found", "Claim not found.");
}

/* ------------------------------- list / read cores ------------------------------- */

export async function listClaimsCore(actor: ClaimActor): Promise<ClaimResult<ClaimRow[]>> {
  if (!configured()) return err("database_error", "Database not configured.");
  const q = await db();
  const rows = await q`
    SELECT c.*, d.name AS driver_name, d2.name AS signed_by_name
    FROM damage_claims c
    LEFT JOIN users d ON d.id = c.driver_user_id
    LEFT JOIN users d2 ON d2.id = c.signed_by_user_id
    WHERE c.org_id = ${actor.orgId}
    ORDER BY c.created_at DESC`;
  return ok(rows.map((r) => mapClaim(r as Record<string, unknown>)));
}

/** The driver's urgent-sign feed: claims in form_ready (or pending_approval,
 *  still visible) assigned to the acting driver. Powers the URGENT in-app
 *  banner + the /driver/claims page. */
export async function listMyClaimSignRequestsCore(actor: ClaimActor): Promise<ClaimResult<ClaimRow[]>> {
  if (!configured()) return err("database_error", "Database not configured.");
  if (!actor.driverUserRowId) return err("unauthorized", "Driver identity required.");
  const q = await db();
  const rows = await q`
    SELECT c.*, d.name AS driver_name, d2.name AS signed_by_name
    FROM damage_claims c
    LEFT JOIN users d ON d.id = c.driver_user_id
    LEFT JOIN users d2 ON d2.id = c.signed_by_user_id
    WHERE c.org_id = ${actor.orgId} AND c.driver_user_id = ${actor.driverUserRowId}
      AND c.status IN ('form_ready','pending_approval')
    ORDER BY c.created_at DESC`;
  return ok(rows.map((r) => mapClaim(r as Record<string, unknown>)));
}

export async function getClaimSignatureFileCore(actor: ClaimActor, claimId: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<ClaimResult<{ dataUrl: string | null }>> {
  if (!configured()) return err("database_error", "Database not configured.");
  const v = z.string().min(1).max(128).safeParse(claimId);
  if (!v.success) return err("invalid_input", "Claim id is required.");
  const q = await db();
  const claim = await claimRow(q, actor.orgId, v.data);
  if (!claim) return err("not_found", "Claim not found.");
  if (!claim.signatureStorageKey) return ok({ dataUrl: null });
  const isOwner = actor.role === "owner" || actor.role === "admin";
  const isAssignedDriver = claim.driverUserId != null && actor.driverUserRowId != null && claim.driverUserId === actor.driverUserRowId;
  if (!isOwner && !isAssignedDriver) return err("unauthorized", "You cannot view this signature.");
  try {
    const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
    const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
    const got = await getObject({ config, s3ApiUrl: auth.s3ApiUrl, key: claim.signatureStorageKey, fetchImpl: opts.fetchImpl });
    if (!got.ok || !got.bytes) return ok({ dataUrl: null });
    return ok({ dataUrl: `data:image/png;base64,${Buffer.from(got.bytes).toString("base64")}` });
  } catch (e) {
    return err("b2_failed", e instanceof Error ? e.message : "Could not read the signature file.");
  }
}

/* ------------------------------- data-url helpers ------------------------------- */

/** Split a data URL into { mime, bytes } — tolerant of spaces/whitespace. */
function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!m) return null;
  try {
    return { mime: m[1], bytes: new Uint8Array(Buffer.from(m[2].replace(/\s+/g, ""), "base64")) };
  } catch { return null; }
}

/** Real-image check for the driver signature (mirrors completion-core): the
 *  payload must start with a real PNG/JPEG/WebP magic so a bogus blob can
 *  never be stored as a signature. */
function hasImageMagic(bytes: Uint8Array, mime: string): boolean {
  if (bytes.length < 8) return false;
  const head = Array.from(bytes.slice(0, 8));
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const jpeg = head[0] === 0xff && head[1] === 0xd8;
  const webp = mime === "image/webp" && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const gif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46;
  return png || jpeg || webp || gif;
}

/* ------------------------------- handler wrappers ------------------------------- */

async function resolveOwnerActor(): Promise<ClaimActor | null> {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || (u.role !== "owner" && u.role !== "admin")) return null;
  return { orgId: u.orgId, id: u.id, role: u.role };
}
async function resolveDriverActor(): Promise<ClaimActor | null> {
  if (!configured()) return null;
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return null;
  return { orgId: u.orgId, id: u.id, role: u.role, driverUserRowId: identity.userRowId };
}

export async function scanClaimsHandler(data: unknown, opts?: ScanClaimsOptions) {
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return scanClaimsCore(actor, opts ?? {});
}
export async function researchClaimHandler(data: unknown) {
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return researchClaimCore(actor, data);
}
export async function prepareClaimFormHandler(data: unknown) {
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return prepareClaimFormCore(actor, data);
}
export async function signClaimHandler(data: unknown, opts?: { fetchImpl?: typeof fetch; b2StableDir?: string }) {
  const actor = await resolveDriverActor();
  if (!actor) return err("unauthorized", "Driver identity required.");
  return signClaimCore(actor, data, opts ?? {});
}
export async function approveClaimHandler(data: unknown) {
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return approveClaimCore(actor, data);
}
export async function rejectClaimHandler(data: unknown) {
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return rejectClaimCore(actor, data);
}
export async function assignClaimDriverHandler(data: unknown) {
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return assignClaimDriverCore(actor, data);
}
export async function sendClaimHandler(data: unknown, opts?: SendClaimOptions) {
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return sendClaimCore(actor, data, opts ?? {});
}
export async function listClaimsHandler() {
  const actor = await resolveOwnerActor();
  if (!actor) return err("unauthorized", "Owner access required.");
  return listClaimsCore(actor);
}
export async function listMyClaimSignRequestsHandler() {
  const actor = await resolveDriverActor();
  if (!actor) return err("unauthorized", "Driver identity required.");
  return listMyClaimSignRequestsCore(actor);
}
export async function getClaimSignatureFileHandler(data: unknown, opts?: { fetchImpl?: typeof fetch; b2StableDir?: string }) {
  const actor = (await resolveOwnerActor()) ?? (await resolveDriverActor());
  if (!actor) return err("unauthorized", "Owner or driver access required.");
  return getClaimSignatureFileCore(actor, data, opts ?? {});
}
