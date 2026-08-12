/**
 * Payment engine core (owner spec 2026-08-11, backlog #1 first slice) —
 * SERVER-ONLY.
 *
 * The payment LEDGER data layer: motor-club card charges are STAGED (from the
 * Gmail scanner in ./club-mail.ts or a manual entry), reviewed by the owner
 * via listStagedChargesCore, and executed per row by chargeStagedCore through
 * the OWNER's Square account (POST /v2/payments — funds never leave the
 * owner's Square balance). Nothing is ever auto-charged here: staging is the
 * safety rail. The payment tab UI, payday button, payrates and bulk auto-charge
 * are later delegations that build on this core.
 *
 * Square capability note (verified against developer.squareup.com 2026-08-11):
 * POST /v2/payments accepts `source_id` = a card NONCE (Web Payments SDK /
 * payment form), a card TOKEN, or a card-on-file id (`ccof:...` created via
 * the Cards API) — there are NO raw card fields (no exp_month/exp_year/
 * card_number) in the Create Payment request body. Card details parsed out of
 * an email therefore CANNOT be charged directly: the card must be tokenized
 * once (Web Payments SDK nonce in the payment tab, or stored as a card on file
 * via the Cards API) and that source recorded in payment_transactions.
 * card_source_id — the charge core reads it; a row without one returns
 * square_source_missing so the UI knows to collect a tokenized source. The PAN
 * is NEVER stored or logged (only last4 + brand).
 *
 * Idempotency: the charge idempotency key is `club-<txnId>-<attempt>`, attempt
 * increments ONLY on a CONFIRMED Square failure (4xx/decline/terminal status).
 * A network blip that throws mid-flight leaves the row 'staged' with the same
 * attempt, so a retry replays the SAME key — Square returns the same payment
 * for a replayed key and a double charge is impossible (same philosophy as
 * completion_tips). Staging is idempotent by (org, source_email_message_id):
 * re-scanning never double-stages (unique partial index backstop + guard).
 *
 * Tips keep living in completion_tips (driver attribution); mirrorTipCore
 * mirrors a paid tip into this ledger (kind='tip', idempotency key
 * tip-mirror-<tipId>) for the payment tab — called only from NEW code paths,
 * the existing completion-flow tip code is untouched.
 *
 * Testability (same split as the other cores): every handler is a thin auth
 * wrapper over a `*Core` function taking an explicit actor + injectable
 * fetchImpl / connectImpl / stableDir — hermetic tests call the cores directly
 * with mock Square + mock Gmail and real Neon QA orgs.
 *
 * Imported ONLY by the client-safe facade (src/data/payment-engine.ts, whose
 * createServerFn handlers dynamic-import this module) and by hermetic tests.
 * Every exported function RE-CHECKS the actor role (owner/admin) so the role
 * gate is enforced at the core, not just the handler.
 */
import { z } from "zod";
import { loadSquareConfig, loadSquarePublicConfig, createCardPayment, createCardOnFile, deleteCardOnFile } from "./square-client";
import { scanGmail, type ClubChargeCandidate } from "./club-mail";
import { randomUUID } from "node:crypto";

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

export type PaymentEngineActor = { orgId: string; id: string; role: string };
const ALLOWED_ROLES = ["owner", "admin"];
const canManage = (a: PaymentEngineActor) => ALLOWED_ROLES.includes(a.role);

/* --------------------------------- types --------------------------------- */

export type PaymentTxnRow = {
  id: string;
  orgId: string;
  jobId: string | null;
  kind: "club_charge" | "tip" | "payout" | "adjustment";
  amountCents: number;
  currency: string;
  squarePaymentId: string | null;
  status: "staged" | "charged" | "failed" | "voided";
  clubName: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  cardSourceId: string | null;
  poRef: string | null;
  sourceEmailMessageId: string | null;
  sourceEmailReceivedAt: string | null;
  idempotencyKey: string | null;
  attempt: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScanItem = {
  messageId: string;
  receivedAt: string;
  from: string;
  subject: string;
  amountCents: number | null;
  cardLast4: string | null;
  clubName: string | null;
  poRef: string | null;
  outcome: "staged" | "already_staged" | "skipped" | "dry_run";
  reason: string | null;
};

export type ScanClubMailResult = {
  ok: boolean;
  dryRun: boolean;
  scanned: number;
  candidates: number;
  staged: number;
  alreadyStaged: number;
  skipped: number;
  items: ScanItem[];
  error: string | null;
};

export type StageClubChargeResult =
  | { ok: true; data: PaymentTxnRow }
  | { ok: false; code: "unauthorized" | "invalid_input" | "duplicate" | "database_error"; message: string };

export type ListStagedChargesResult =
  | { ok: true; data: PaymentTxnRow[] }
  | { ok: false; code: "unauthorized" | "database_error"; message: string };

export type ChargeStagedResult =
  | { ok: true; data: PaymentTxnRow }
  | { ok: false; code: "unauthorized" | "not_found" | "invalid_state" | "square_not_configured" | "square_source_missing" | "square_failed" | "database_error"; message: string; retryable?: boolean };

export type MirrorTipResult =
  | { ok: true; data: PaymentTxnRow }
  | { ok: false; code: "unauthorized" | "not_found" | "invalid_state" | "database_error"; message: string };

/* --------------------------- card on file (club) --------------------------- */

/** One stored motor-club card (motor_club_cards row) — the ccof payment source
 *  for auto-charging that club's staged charges. brand + last4 only, never the
 *  PAN. */
export type ClubCardRow = {
  id: string;
  orgId: string;
  clubName: string;
  squareCardId: string; // "ccof:…"
  brand: string | null;
  last4: string | null;
  createdAt: string;
};

export type ListClubCardsResult =
  | { ok: true; data: ClubCardRow[] }
  | { ok: false; code: "unauthorized" | "database_error"; message: string };

export type CreateClubCardResult =
  | { ok: true; data: ClubCardRow }
  | { ok: false; code: "unauthorized" | "invalid_input" | "square_not_configured" | "square_failed" | "database_error"; message: string };

export type DeleteClubCardResult =
  | { ok: true; data: { id: string; removedFromSquare: boolean } }
  | { ok: false; code: "unauthorized" | "not_found" | "square_failed" | "database_error"; message: string };

/** A tip ledger row with the paying driver's name (LEFT JOIN completion_tips →
 *  users) — the payment tab's tips view shows driver attribution without
 *  duplicating tip data. */
export type TipLedgerRow = PaymentTxnRow & { driverName: string | null; driverTowbookId: string | null };

export type ListTipsResult =
  | { ok: true; data: TipLedgerRow[] }
  | { ok: false; code: "unauthorized" | "database_error"; message: string };

export type SquarePublicConfigResult =
  | { ok: true; data: { applicationId: string; locationId: string } }
  | { ok: false; code: "unauthorized" | "square_not_configured"; message: string };

/* ------------------------------- row mapping ------------------------------- */

/** DB row → Seroval-safe ledger row. Every property defined (null, never
 *  undefined) — the seroval gotcha that has broken this app's client fns. */
function toTxnRow(r: Record<string, unknown>): PaymentTxnRow {
  const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
  const iso = (v: unknown): string | null => {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    jobId: str(r.job_id),
    kind: String(r.kind) as PaymentTxnRow["kind"],
    amountCents: Number.isFinite(Number(r.amount_cents)) ? Number(r.amount_cents) : 0,
    currency: String(r.currency ?? "USD"),
    squarePaymentId: str(r.square_payment_id),
    status: String(r.status) as PaymentTxnRow["status"],
    clubName: str(r.club_name),
    cardLast4: str(r.card_last4),
    cardBrand: str(r.card_brand),
    cardSourceId: str(r.card_source_id),
    poRef: str(r.po_ref),
    sourceEmailMessageId: str(r.source_email_message_id),
    sourceEmailReceivedAt: iso(r.source_email_received_at),
    idempotencyKey: str(r.idempotency_key),
    attempt: Number.isFinite(Number(r.attempt)) ? Number(r.attempt) : 0,
    error: str(r.error),
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

/** DB row → Seroval-safe club card row (brand/last4 null, never undefined). */
function toClubCardRow(r: Record<string, unknown>): ClubCardRow {
  const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    clubName: String(r.club_name),
    squareCardId: String(r.square_card_id),
    brand: str(r.brand),
    last4: str(r.last4),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(String(r.created_at)).toISOString(),
  };
}

/** Normalize a parsed club-charge candidate into insertable columns. */
function candidateColumns(orgId: string, c: ClubChargeCandidate) {
  const receivedAt = c.receivedAt instanceof Date && !Number.isNaN(c.receivedAt.getTime()) ? c.receivedAt : null;
  return {
    orgId,
    amountCents: c.amountCents,
    cardLast4: c.cardLast4 ?? null,
    clubName: c.clubName ?? null,
    poRef: c.poRef ?? null,
    messageId: c.messageId,
    receivedAt,
  };
}

/* ------------------------------- staging ------------------------------- */

/** Stage a scanned club-charge candidate (or a manual entry) as a
 *  payment_transactions row, status 'staged' — the safety rail: nothing is
 *  ever charged without the owner reviewing + explicitly charging the row.
 *  Idempotent by (org, source_email_message_id): a message already staged is
 *  returned as 'duplicate', never double-staged. */
export async function stageClubChargeCore(actor: PaymentEngineActor, data: unknown): Promise<StageClubChargeResult> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Only the owner or an admin can stage charges." };
  const v = z.object({
    amountCents: z.number().int().min(1).max(100_000_000),
    cardLast4: z.string().regex(/^\d{4}$/).optional(),
    clubName: z.string().max(120).optional(),
    poRef: z.string().max(80).optional(),
    messageId: z.string().max(255).optional(),
    receivedAt: z.string().optional(),
    jobId: z.string().max(128).optional(),
  }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_input", message: "A valid charge amount (in cents) is required." };
  try {
    await ensure();
    const q = await db();
    const messageId = v.data.messageId || null;
    if (messageId) {
      const existing = await q`SELECT id FROM payment_transactions WHERE org_id=${actor.orgId} AND source_email_message_id=${messageId} LIMIT 1`;
      if (existing.length) {
        return { ok: false, code: "duplicate", message: "This email was already staged." };
      }
    }
    const id = `ptx-${actor.orgId.slice(0, 8)}-${randomUUID()}`;
    let receivedAt: Date | null = null;
    if (v.data.receivedAt) {
      const d = new Date(v.data.receivedAt);
      if (!Number.isNaN(d.getTime())) receivedAt = d;
    }
    await q`INSERT INTO payment_transactions(id, org_id, job_id, kind, amount_cents, currency, status, club_name, card_last4, po_ref, source_email_message_id, source_email_received_at, idempotency_key, attempt)
      VALUES(${id}, ${actor.orgId}, ${v.data.jobId ?? null}, 'club_charge', ${v.data.amountCents}, 'USD', 'staged', ${v.data.clubName ?? null}, ${v.data.cardLast4 ?? null}, ${v.data.poRef ?? null}, ${messageId}, ${receivedAt}, NULL, 0)`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payment_charge_staged', 'payment_transaction', ${id},
          ${JSON.stringify({ amountCents: v.data.amountCents, clubName: v.data.clubName ?? null, messageId })}::jsonb, 'payment-engine'`;
    } catch { /* best-effort audit */ }
    const row = await q`SELECT * FROM payment_transactions WHERE id=${id} LIMIT 1`;
    return { ok: true, data: toTxnRow(row[0] as Record<string, unknown>) };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to stage the charge." };
  }
}

/* --------------------------------- list --------------------------------- */

/** Owner/admin ledger read: staged + charged + failed rows, newest first.
 *  The payment tab UI builds on this (tips/payouts join later slices). */
export async function listStagedChargesCore(actor: PaymentEngineActor): Promise<ListStagedChargesResult> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Only the owner or an admin can view charges." };
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT * FROM payment_transactions WHERE org_id=${actor.orgId} ORDER BY created_at DESC`;
    return { ok: true, data: rows.map((r: Record<string, unknown>) => toTxnRow(r)) };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to list charges." };
  }
}

/* ------------------------------- charging ------------------------------- */

const CHARGE_SCHEMA = z.object({
  txnId: z.string().min(1).max(128),
  /** Optional Square source override (nonce / card-on-file id) collected by
   *  the UI — falls back to the staged row's card_source_id. */
  sourceId: z.string().min(1).max(255).optional(),
});

/** Execute ONE staged club charge via the owner's Square account
 *  (POST /v2/payments, Bearer token server-side, idempotency key
 *  `club-<txnId>-<attempt>`). Success → status 'charged' + square_payment_id +
 *  attempt/idempotency_key recorded. Confirmed Square failure (4xx / terminal
 *  payment status) → status 'failed' with the error + attempt (a retry uses a
 *  fresh attempt → fresh key). A network/transport error → the row STAYS
 *  'staged' with the same attempt so a retry replays the SAME key — Square
 *  returns the same payment for a replayed key, so a double charge is
 *  impossible. Requires a tokenized source (nonce/card-on-file id) on the row
 *  or in the request — raw card details parsed from email are NOT accepted by
 *  Square (see module header) and surface as square_source_missing. */
export async function chargeStagedCore(actor: PaymentEngineActor, data: unknown, opts: { fetchImpl?: typeof fetch; squareStableDir?: string } = {}): Promise<ChargeStagedResult> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Only the owner or an admin can charge." };
  const v = CHARGE_SCHEMA.safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid request." };
  let config;
  try {
    config = await loadSquareConfig(process.env, { stableDir: opts.squareStableDir });
  } catch (err) {
    return { ok: false, code: "square_not_configured", message: err instanceof Error ? err.message : "Square isn't connected." };
  }
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT * FROM payment_transactions WHERE id=${v.data.txnId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!rows.length) return { ok: false, code: "not_found", message: "Charge not found." };
    const row = rows[0] as Record<string, unknown>;
    if (String(row.kind) !== "club_charge") return { ok: false, code: "invalid_state", message: "Only staged club charges can be charged here." };
    // 'staged' (first attempt) and 'failed' (owner retry after a confirmed
    // decline) are both chargeable; 'charged'/'voided' are terminal.
    const rowStatus = String(row.status);
    if (rowStatus !== "staged" && rowStatus !== "failed") return { ok: false, code: "invalid_state", message: `This charge is already ${rowStatus} — refresh the list.` };

    let sourceId = (v.data.sourceId && v.data.sourceId.trim()) || (row.card_source_id != null && String(row.card_source_id) !== "" ? String(row.card_source_id) : null);
    // Auto-resolve the club's stored card-on-file (payment tab slice): when the
    // staged row carries no tokenized source, charge through the club's ccof
    // card if one is on file — the owner-approved flow "charge club cards via
    // Square without re-entering card details". The resolved id is persisted on
    // the row so the ledger shows exactly which source was charged.
    if (!sourceId && row.club_name != null && String(row.club_name) !== "") {
      const clubCards = await q`SELECT square_card_id FROM motor_club_cards WHERE org_id=${actor.orgId} AND lower(club_name)=lower(${String(row.club_name)}) LIMIT 1`;
      if (clubCards.length) {
        sourceId = String(clubCards[0].square_card_id);
        await q`UPDATE payment_transactions SET card_source_id=${sourceId}, updated_at=NOW() WHERE id=${String(row.id)}`;
      }
    }
    if (!sourceId) {
      return {
        ok: false, code: "square_source_missing", retryable: true,
        message: "This charge has no tokenized card source. Square cannot charge raw card details parsed from an email — add this club's card on the Payments tab (card on file), then retry.",
      };
    }

    const amountCents = Number.isFinite(Number(row.amount_cents)) ? Number(row.amount_cents) : 0;
    const currency = String(row.currency ?? "USD");
    const clubName = row.club_name != null ? String(row.club_name) : "";
    const poRef = row.po_ref != null ? String(row.po_ref) : "";
    const jobRef = row.job_id != null ? String(row.job_id) : "";
    // The attempt to record: confirmed failures bump it; transport errors do
    // NOT (see the module header — same key must be replayable).
    const attempt = Number.isFinite(Number(row.attempt)) ? Number(row.attempt) + 1 : 1;
    const idempotencyKey = `club-${String(row.id)}-${attempt}`;
    const note = `Club charge — ${clubName || "motor club"}${poRef ? ` — PO ${poRef}` : ""}${jobRef ? ` — job ${jobRef}` : ""}`.slice(0, 500);

    let payment;
    try {
      payment = await createCardPayment({
        config,
        idempotencyKey,
        sourceId,
        amountCents,
        currency,
        note,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      // Transport error / Square 4xx both land here; 4xx means CONFIRMED
      // failure (record it), a throw before any response means UNKNOWN (keep
      // staged so the same key can be replayed).
      const message = err instanceof Error ? err.message : "Square request failed.";
      if (message.startsWith("Square payment failed (HTTP")) {
        await q`UPDATE payment_transactions SET status='failed', error=${message.slice(0, 400)}, attempt=${attempt}, idempotency_key=${idempotencyKey}, updated_at=NOW() WHERE id=${String(row.id)}`;
        try {
          await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
            SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payment_charge_failed', 'payment_transaction', ${String(row.id)},
              ${JSON.stringify({ amountCents, attempt, idempotencyKey, error: message.slice(0, 400) })}::jsonb, 'payment-engine'`;
        } catch { /* best-effort audit */ }
        return { ok: false, code: "square_failed", message, retryable: true };
      }
      return { ok: false, code: "square_failed", message, retryable: true };
    }

    const terminal = payment.status === "FAILED" || payment.status === "CANCELED";
    if (terminal) {
      const message = `Square declined the card (${payment.status}).`;
      await q`UPDATE payment_transactions SET status='failed', error=${message}, square_payment_id=${payment.paymentId}, attempt=${attempt}, idempotency_key=${idempotencyKey}, updated_at=NOW() WHERE id=${String(row.id)}`;
      try {
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payment_charge_failed', 'payment_transaction', ${String(row.id)},
            ${JSON.stringify({ amountCents, attempt, idempotencyKey, squarePaymentId: payment.paymentId, error: message })}::jsonb, 'payment-engine'`;
      } catch { /* best-effort audit */ }
      return { ok: false, code: "square_failed", message, retryable: true };
    }

    await q`UPDATE payment_transactions SET status='charged', square_payment_id=${payment.paymentId}, attempt=${attempt}, idempotency_key=${idempotencyKey}, error=NULL, updated_at=NOW() WHERE id=${String(row.id)}`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payment_charge_charged', 'payment_transaction', ${String(row.id)},
          ${JSON.stringify({ amountCents, attempt, idempotencyKey, paymentId: payment.paymentId, clubName, poRef })}::jsonb, 'payment-engine'`;
    } catch { /* best-effort audit */ }
    const finalRow = await q`SELECT * FROM payment_transactions WHERE id=${String(row.id)} LIMIT 1`;
    return { ok: true, data: toTxnRow(finalRow[0] as Record<string, unknown>) };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to charge." };
  }
}

/* ------------------------- scan orchestration ------------------------- */

const SCAN_SCHEMA = z.object({
  dryRun: z.boolean().optional().default(false),
  sinceDays: z.number().int().min(1).max(60).optional(),
});

/** Pull new mail from the owner's Gmail → parse → stage every valid
 *  club-charge candidate (idempotent by source email message id). NO
 *  auto-charge: staging is the safety rail; the owner reviews and charges per
 *  row. `dryRun:true` scans + parses WITHOUT writing. Injectable
 *  connectImpl/stableDir for hermetic tests. */
export async function scanClubMailCore(actor: PaymentEngineActor, data: unknown, opts: { connectImpl?: () => Promise<import("./club-mail").MailboxLike>; stableDir?: string } = {}): Promise<ScanClubMailResult> {
  if (!canManage(actor)) {
    return { ok: false, dryRun: false, scanned: 0, candidates: 0, staged: 0, alreadyStaged: 0, skipped: 0, items: [], error: "Only the owner or an admin can scan the mailbox." };
  }
  const v = SCAN_SCHEMA.safeParse(data);
  if (!v.success) {
    return { ok: false, dryRun: false, scanned: 0, candidates: 0, staged: 0, alreadyStaged: 0, skipped: 0, items: [], error: "Invalid scan options." };
  }
  const dryRun = v.data.dryRun === true;
  let mail;
  try {
    mail = await scanGmail({ sinceDays: v.data.sinceDays, connectImpl: opts.connectImpl, stableDir: opts.stableDir });
  } catch (err) {
    return { ok: false, dryRun, scanned: 0, candidates: 0, staged: 0, alreadyStaged: 0, skipped: 0, items: [], error: err instanceof Error ? err.message : "Gmail scan failed." };
  }
  if (!mail.ok) {
    return { ok: false, dryRun, scanned: 0, candidates: 0, staged: 0, alreadyStaged: 0, skipped: 0, items: [], error: mail.error ?? "Gmail scan failed." };
  }
  try {
    await ensure();
    const q = await db();
    const items: ScanItem[] = [];
    let staged = 0;
    let alreadyStaged = 0;
    let skipped = 0;
    for (const c of mail.candidates) {
      const { orgId, amountCents, cardLast4, clubName, poRef, messageId, receivedAt } = candidateColumns(actor.orgId, c);
      const base: ScanItem = {
        messageId,
        receivedAt: receivedAt ? receivedAt.toISOString() : "",
        from: c.from ?? "",
        subject: c.subject ?? "",
        amountCents,
        cardLast4,
        clubName,
        poRef,
        outcome: "dry_run",
        reason: null,
      };
      if (dryRun) {
        items.push({ ...base, outcome: "dry_run" });
        continue;
      }
      const existing = await q`SELECT id FROM payment_transactions WHERE org_id=${orgId} AND source_email_message_id=${messageId} LIMIT 1`;
      if (existing.length) {
        alreadyStaged += 1;
        items.push({ ...base, outcome: "already_staged" });
        continue;
      }
      const id = `ptx-${orgId.slice(0, 8)}-${randomUUID()}`;
      try {
        await q`INSERT INTO payment_transactions(id, org_id, kind, amount_cents, currency, status, club_name, card_last4, po_ref, source_email_message_id, source_email_received_at, attempt)
          VALUES(${id}, ${orgId}, 'club_charge', ${amountCents}, 'USD', 'staged', ${clubName}, ${cardLast4}, ${poRef}, ${messageId}, ${receivedAt}, 0)`;
      } catch (err) {
        // Unique (org, messageId) violation from a concurrent scan — count as already staged.
        if (err instanceof Error && /duplicate key value violates unique constraint/.test(err.message)) {
          alreadyStaged += 1;
          items.push({ ...base, outcome: "already_staged", reason: "concurrent scan staged it first" });
          continue;
        }
        throw err;
      }
      staged += 1;
      items.push({ ...base, outcome: "staged" });
    }
    for (const s of mail.skipped) {
      skipped += 1;
      items.push({ messageId: s.messageId, receivedAt: "", from: s.from, subject: s.subject, amountCents: null, cardLast4: null, clubName: null, poRef: null, outcome: "skipped", reason: s.reason });
    }
    // Dry-run promises zero writes — even the audit row is skipped.
    if (!dryRun) {
      try {
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payment_scan_ran', 'payment_transaction', 'scan',
            ${JSON.stringify({ dryRun, scanned: mail.scanned, staged, alreadyStaged, skipped })}::jsonb, 'payment-engine'`;
      } catch { /* best-effort audit */ }
    }
    return { ok: true, dryRun, scanned: mail.scanned, candidates: mail.candidates.length, staged, alreadyStaged, skipped, items, error: null };
  } catch (err) {
    return { ok: false, dryRun, scanned: mail.scanned, candidates: mail.candidates.length, staged: 0, alreadyStaged: 0, skipped: 0, items: [], error: err instanceof Error ? err.message : "Unable to stage scanned charges." };
  }
}

/* ------------------------------- tip mirror ------------------------------- */

const MIRROR_SCHEMA = z.object({ tipId: z.string().min(1).max(128) });

/** Mirror a PAID tip (completion_tips row) into the payment ledger as
 *  kind='tip' so the payment tab shows tips alongside club charges. Idempotent
 *  by idempotency_key `tip-mirror-<tipId>` — calling it again never
 *  duplicates. This is the NEW-code-path hook for tip creation; the existing
 *  completion-flow tip code is intentionally untouched. */
export async function mirrorTipCore(actor: PaymentEngineActor, data: unknown): Promise<MirrorTipResult> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Only the owner or an admin can mirror tips." };
  const v = MIRROR_SCHEMA.safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid request." };
  try {
    await ensure();
    const q = await db();
    const tips = await q`SELECT id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, square_payment_id, status FROM completion_tips WHERE id=${v.data.tipId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!tips.length) return { ok: false, code: "not_found", message: "Tip not found." };
    const tip = tips[0] as Record<string, unknown>;
    if (String(tip.status) !== "paid") return { ok: false, code: "invalid_state", message: "Only a paid tip can be mirrored (status must be 'paid')." };
    const idempotencyKey = `tip-mirror-${String(tip.id)}`;
    // Idempotent replay: an existing mirror row is returned as-is (no second
    // insert, no second audit row) — the payment tab can call this freely.
    const already = await q`SELECT * FROM payment_transactions WHERE idempotency_key=${idempotencyKey} AND org_id=${actor.orgId} LIMIT 1`;
    if (already.length) {
      return { ok: true, data: toTxnRow(already[0] as Record<string, unknown>) };
    }
    const id = `ptx-${actor.orgId.slice(0, 8)}-${randomUUID()}`;
    try {
      await q`INSERT INTO payment_transactions(id, org_id, job_id, kind, amount_cents, currency, square_payment_id, status, idempotency_key, attempt)
        VALUES(${id}, ${actor.orgId}, ${tip.job_id != null ? String(tip.job_id) : null}, 'tip', ${Number(tip.amount_cents) || 0}, ${String(tip.currency ?? "USD")}, ${tip.square_payment_id != null ? String(tip.square_payment_id) : null}, 'charged', ${idempotencyKey}, 1)`;
    } catch (err) {
      // Concurrent mirror won the insert — return the winner's row.
      if (err instanceof Error && /duplicate key value violates unique constraint/.test(err.message)) {
        const winner = await q`SELECT * FROM payment_transactions WHERE idempotency_key=${idempotencyKey} AND org_id=${actor.orgId} LIMIT 1`;
        if (winner.length) return { ok: true, data: toTxnRow(winner[0] as Record<string, unknown>) };
      }
      throw err;
    }
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payment_tip_mirrored', 'payment_transaction', ${String(tip.id)},
          ${JSON.stringify({ amountCents: Number(tip.amount_cents) || 0, driverId: String(tip.driver_id), driverTowbookId: tip.driver_towbook_id != null ? String(tip.driver_towbook_id) : null, jobId: tip.job_id != null ? String(tip.job_id) : null })}::jsonb, 'payment-engine'`;
    } catch { /* best-effort audit */ }
    const row = await q`SELECT * FROM payment_transactions WHERE idempotency_key=${idempotencyKey} AND org_id=${actor.orgId} LIMIT 1`;
    return { ok: true, data: toTxnRow(row[0] as Record<string, unknown>) };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to mirror the tip." };
  }
}

/* --------------------------- card on file (club) --------------------------- */

const CLUB_CARD_SCHEMA = z.object({
  clubName: z.string().min(1).max(120),
  /** The Web Payments SDK card nonce (cnon:…) collected CLIENT-SIDE — never a
   *  raw PAN (Square rejects raw card fields on /v2/cards). */
  sourceId: z.string().min(8).max(255),
});

/** Store one motor-club card on the OWNER's Square account (Cards API
 *  POST /v2/cards — the nonce becomes a `ccof:…` card id) and record it in
 *  motor_club_cards. UPSERT semantics per club: re-adding a card for a club
 *  that already has one REPLACES the local row and best-effort deletes the
 *  replaced Square card (never fails the call if that cleanup hiccups). The
 *  PAN never touches this code — Square returns only card id/brand/last4.
 *  Injectable fetchImpl/squareStableDir for hermetic tests. */
export async function createClubCardCore(actor: PaymentEngineActor, data: unknown, opts: { fetchImpl?: typeof fetch; squareStableDir?: string } = {}): Promise<CreateClubCardResult> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Only the owner or an admin can store club cards." };
  const v = CLUB_CARD_SCHEMA.safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_input", message: "A club name and a tokenized card (from the card form) are required." };
  let config;
  try {
    config = await loadSquareConfig(process.env, { stableDir: opts.squareStableDir });
  } catch (err) {
    return { ok: false, code: "square_not_configured", message: err instanceof Error ? err.message : "Square isn't connected." };
  }
  const id = `clubcard-${actor.orgId.slice(0, 8)}-${randomUUID()}`;
  // Max 45 chars per the Cards API docs; the uuid suffix keeps keys unique.
  const idempotencyKey = `clubcard-${actor.orgId.slice(0, 8)}-${randomUUID()}`.slice(0, 45);
  let card;
  try {
    card = await createCardOnFile({
      config,
      idempotencyKey,
      sourceId: v.data.sourceId,
      referenceId: actor.orgId.slice(0, 64),
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Square could not store the card.";
    return { ok: false, code: "square_failed", message, retryable: true };
  }
  try {
    await ensure();
    const q = await db();
    // UPSERT per (org, club): one stored card per club. The replaced Square
    // card is deleted best-effort AFTER the local row points at the new one.
    const existing = await q`SELECT square_card_id FROM motor_club_cards WHERE org_id=${actor.orgId} AND lower(club_name)=lower(${v.data.clubName}) LIMIT 1`;
    const replacedCardId = existing.length ? String(existing[0].square_card_id) : null;
    await q`INSERT INTO motor_club_cards(id, org_id, club_name, square_card_id, brand, last4)
      VALUES(${id}, ${actor.orgId}, ${v.data.clubName}, ${card.cardId}, ${card.brand}, ${card.last4})
      ON CONFLICT (org_id, lower(club_name)) DO UPDATE SET square_card_id=${card.cardId}, brand=${card.brand}, last4=${card.last4}, created_at=NOW()`;
    if (replacedCardId && replacedCardId !== card.cardId) {
      try { await deleteCardOnFile({ config, cardId: replacedCardId, fetchImpl: opts.fetchImpl }); } catch { /* the new card is stored — cleanup is best-effort */ }
    }
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payment_club_card_saved', 'motor_club_card', ${id},
          ${JSON.stringify({ clubName: v.data.clubName, squareCardId: card.cardId, brand: card.brand ?? null, last4: card.last4 ?? null, replaced: replacedCardId != null })}::jsonb, 'payment-engine'`;
    } catch { /* best-effort audit */ }
    const row = await q`SELECT * FROM motor_club_cards WHERE id=${id} LIMIT 1`;
    if (!row.length) {
      // ON CONFLICT kept the original id — re-read by (org, club).
      const rows = await q`SELECT * FROM motor_club_cards WHERE org_id=${actor.orgId} AND lower(club_name)=lower(${v.data.clubName}) LIMIT 1`;
      return { ok: true, data: toClubCardRow(rows[0] as Record<string, unknown>) };
    }
    return { ok: true, data: toClubCardRow(row[0] as Record<string, unknown>) };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to store the club card." };
  }
}

/** Owner/admin read: every stored club card for the org, club name A→Z. */
export async function listClubCardsCore(actor: PaymentEngineActor): Promise<ListClubCardsResult> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Only the owner or an admin can view club cards." };
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT * FROM motor_club_cards WHERE org_id=${actor.orgId} ORDER BY lower(club_name) ASC, created_at DESC`;
    return { ok: true, data: rows.map((r: Record<string, unknown>) => toClubCardRow(r)) };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to list club cards." };
  }
}

const DELETE_CARD_SCHEMA = z.object({ clubCardId: z.string().min(1).max(128) });

/** Remove a stored club card: DELETE /v2/cards/{id} on Square (a 404 there is
 *  treated as already-gone) and delete the local row. A Square failure that is
 *  NOT a 404 keeps the local row and surfaces as square_failed (retryable). */
export async function deleteClubCardCore(actor: PaymentEngineActor, data: unknown, opts: { fetchImpl?: typeof fetch; squareStableDir?: string } = {}): Promise<DeleteClubCardResult> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Only the owner or an admin can remove club cards." };
  const v = DELETE_CARD_SCHEMA.safeParse(data);
  if (!v.success) return { ok: false, code: "not_found", message: "Invalid card reference." };
  let config;
  try {
    config = await loadSquareConfig(process.env, { stableDir: opts.squareStableDir });
  } catch (err) {
    return { ok: false, code: "square_failed", message: err instanceof Error ? err.message : "Square isn't connected." };
  }
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT * FROM motor_club_cards WHERE id=${v.data.clubCardId} AND org_id=${actor.orgId} LIMIT 1`;
    if (!rows.length) return { ok: false, code: "not_found", message: "Club card not found." };
    const row = rows[0] as Record<string, unknown>;
    const squareCardId = String(row.square_card_id);
    let removedFromSquare = true;
    try {
      const res = await deleteCardOnFile({ config, cardId: squareCardId, fetchImpl: opts.fetchImpl });
      removedFromSquare = res.deleted;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Square could not remove the card.";
      return { ok: false, code: "square_failed", message, retryable: true };
    }
    await q`DELETE FROM motor_club_cards WHERE id=${v.data.clubCardId} AND org_id=${actor.orgId}`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payment_club_card_removed', 'motor_club_card', ${v.data.clubCardId},
          ${JSON.stringify({ clubName: String(row.club_name), squareCardId, removedFromSquare })}::jsonb, 'payment-engine'`;
    } catch { /* best-effort audit */ }
    return { ok: true, data: { id: v.data.clubCardId, removedFromSquare } };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to remove the club card." };
  }
}

/* ------------------------------ tips (ledger) ------------------------------ */

/** Owner/admin tips read: kind='tip' ledger rows newest first, with the paying
 *  driver's name (users join via completion_tips driver_id — the ledger row
 *  itself stays slim; the mirror already preserved attribution in
 *  completion_tips). Seroval-safe (driverName null, never undefined). */
export async function listTipsCore(actor: PaymentEngineActor): Promise<ListTipsResult> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Only the owner or an admin can view tips." };
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT pt.*, u.name AS driver_name, ct.driver_towbook_id AS tip_driver_towbook_id
      FROM payment_transactions pt
      LEFT JOIN completion_tips ct ON pt.org_id=ct.org_id AND pt.idempotency_key = 'tip-mirror-' || ct.id
      LEFT JOIN users u ON u.id = ct.driver_id
      WHERE pt.org_id=${actor.orgId} AND pt.kind='tip'
      ORDER BY pt.created_at DESC`;
    return {
      ok: true,
      data: rows.map((r: Record<string, unknown>) => {
        const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
        return { ...toTxnRow(r), driverName: str(r.driver_name), driverTowbookId: str(r.tip_driver_towbook_id) };
      }),
    };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to list tips." };
  }
}

/** Owner/admin PUBLIC Square Web Payments config (application id + location id
 *  ONLY — the access token never leaves the server). Drives the card form in
 *  the payment tab; the tab renders a graceful "payments not configured" state
 *  when this fails. */
export async function getPaymentSquareConfigCore(opts: { squareStableDir?: string } = {}): Promise<SquarePublicConfigResult> {
  try {
    const config = await loadSquarePublicConfig(process.env, { stableDir: opts.squareStableDir });
    return { ok: true, data: { applicationId: config.applicationId, locationId: config.locationId } };
  } catch (err) {
    return { ok: false, code: "square_not_configured", message: err instanceof Error ? err.message : "Square isn't connected." };
  }
}

/* ------------------------------ handler layer ------------------------------ */

/** Thin auth wrappers for the client-safe facade — resolve the real session
 *  user and re-check the role before delegating to the cores. */
async function resolveManageActor(): Promise<PaymentEngineActor | null> {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || !ALLOWED_ROLES.includes(u.role)) return null;
  return { orgId: u.orgId, id: u.id, role: u.role };
}

export async function stageClubChargeHandler(data: unknown): Promise<StageClubChargeResult> {
  if (!configured()) return { ok: false, code: "database_error", message: "Requires database mode." };
  const actor = await resolveManageActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Sign in as the owner or an admin first." };
  return stageClubChargeCore(actor, data);
}

export async function listStagedChargesHandler(): Promise<ListStagedChargesResult> {
  if (!configured()) return { ok: false, code: "database_error", message: "Requires database mode." };
  const actor = await resolveManageActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Sign in as the owner or an admin first." };
  return listStagedChargesCore(actor);
}

export async function chargeStagedHandler(data: unknown): Promise<ChargeStagedResult> {
  if (!configured()) return { ok: false, code: "database_error", message: "Requires database mode." };
  const actor = await resolveManageActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Sign in as the owner or an admin first." };
  return chargeStagedCore(actor, data);
}

export async function scanClubMailHandler(data: unknown): Promise<ScanClubMailResult> {
  if (!configured()) return { ok: false, dryRun: false, scanned: 0, candidates: 0, staged: 0, alreadyStaged: 0, skipped: 0, items: [], error: "Requires database mode." };
  const actor = await resolveManageActor();
  if (!actor) return { ok: false, dryRun: false, scanned: 0, candidates: 0, staged: 0, alreadyStaged: 0, skipped: 0, items: [], error: "Sign in as the owner or an admin first." };
  return scanClubMailCore(actor, data);
}

export async function mirrorTipHandler(data: unknown): Promise<MirrorTipResult> {
  if (!configured()) return { ok: false, code: "database_error", message: "Requires database mode." };
  const actor = await resolveManageActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Sign in as the owner or an admin first." };
  return mirrorTipCore(actor, data);
}

export async function createClubCardHandler(data: unknown): Promise<CreateClubCardResult> {
  if (!configured()) return { ok: false, code: "square_not_configured", message: "Requires database mode." };
  const actor = await resolveManageActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Sign in as the owner or an admin first." };
  return createClubCardCore(actor, data);
}

export async function listClubCardsHandler(): Promise<ListClubCardsResult> {
  if (!configured()) return { ok: false, code: "database_error", message: "Requires database mode." };
  const actor = await resolveManageActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Sign in as the owner or an admin first." };
  return listClubCardsCore(actor);
}

export async function deleteClubCardHandler(data: unknown): Promise<DeleteClubCardResult> {
  if (!configured()) return { ok: false, code: "square_failed", message: "Requires database mode." };
  const actor = await resolveManageActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Sign in as the owner or an admin first." };
  return deleteClubCardCore(actor, data);
}

export async function listTipsHandler(): Promise<ListTipsResult> {
  if (!configured()) return { ok: false, code: "database_error", message: "Requires database mode." };
  const actor = await resolveManageActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Sign in as the owner or an admin first." };
  return listTipsCore(actor);
}

export async function getPaymentSquareConfigHandler(): Promise<SquarePublicConfigResult> {
  if (!configured()) return { ok: false, code: "square_not_configured", message: "Requires database mode." };
  const actor = await resolveManageActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Sign in as the owner or an admin first." };
  return getPaymentSquareConfigCore();
}
