/**
 * IMMEDIATE TIP CASH-OUT — server-only core (owner-directed 2026-08-12; Plaid
 * DROPPED, no debit-card rail, no automated money movement).
 *
 * The driver taps ONCE after a job completes ("Get your tips") or on Earnings
 * ("Cash out tips now") → submitTipCashoutCore creates ONE request for the
 * driver's FULL available tips at that instant (paid completion_tips NOT
 * already covered by a previous cash-out). The request lands on the owner
 * Money tab; the owner sends from their own app and marks it paid.
 *
 * Semantics:
 * - availableCents = Σ paid completion_tips (driver) − Σ ALL cash-outs
 *   (requested + paid). A requested cash-out RESERVES its tips — the partial
 *   unique index (org, contractor) WHERE status='requested' is the
 *   double-submit backstop (only ONE open request per contractor; a second
 *   submit for the same tips hits 23505 and surfaces as "already waiting").
 * - covered_tip_ids snapshots EXACTLY which tip rows the request covers
 *   (oldest paid tips first, skipping any row a previous cash-out covered).
 *   The weekly payday manifest (computePaydayCore) EXCLUDES any tip whose id
 *   appears in a PAID cash-out's covered set — forever, across every recompute
 *   and every later period ("a cashed-out tip must never appear in a later
 *   manifest again").
 * - Rail gate: the request REQUIRES a VERIFIED payout method (any rail).
 *   An unverified bank rail (micro-deposit not confirmed) or unverified
 *   Cash App/Venmo/Zelle handle is refused — same rule payday already enforces.
 * - No minimum. No money ever moves automatically — the owner always executes
 *   the send in their own app and marks paid (idempotent: a paid request can
 *   never be marked paid again).
 * - PII: full handles live only in payout_methods (owner surface). The
 *   cash-out row snapshots rail + handle_masked; audit detail carries the
 *   masked form only — never the full handle, never a bank account number.
 *
 * Imported ONLY by the client-safe facade (src/data/tip-cashout.ts, whose
 * createServerFn handlers dynamic-import this module) and by hermetic tests.
 */
import { z } from "zod";
import type { PayoutRail } from "./payouts-core";
import { maskHandle } from "./payouts-core";

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
export type TipCashoutActor = { orgId: string; id: string; role: string };
const OWNER_ROLES = ["owner", "admin"];
const canManage = (a: TipCashoutActor) => OWNER_ROLES.includes(a.role);
export type TipCashoutErrorCode = "unauthorized" | "invalid_input" | "not_found" | "database_error";
export type TipCashoutResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: TipCashoutErrorCode; message: string };
const err = (code: TipCashoutErrorCode, message: string) => ({ ok: false as const, code, message });
const ok = <T>(data: T): TipCashoutResult<T> => ({ ok: true, data });

/* ---------------------------------- types ---------------------------------- */

/** One cash-out request row — owner view. Seroval-safe: every field
 *  null-or-value, never undefined. handleMasked is the PII-safe snapshot. */
export type TipCashoutRequest = {
  id: string;
  orgId: string;
  contractorId: string;
  contractorName: string;
  amountCents: number;
  rail: PayoutRail;
  handleMasked: string;
  methodId: string | null;
  status: "requested" | "paid";
  createdAt: string;
  paidAt: string | null;
  note: string | null;
};

export type TipCashoutList = {
  open: TipCashoutRequest[];
  paid: TipCashoutRequest[];
  openTotalCents: number;
};
export type TirePlugLedgerRow = { id: string; contractorId: string; contractorName: string; jobId: string; amountCents: number; status: string; createdAt: string; paidAt: string | null };

/** Driver-facing cash-out state. The method is masked; bankDepositSent is
 *  TRUE when the owner has recorded a test deposit and the driver should
 *  confirm it (the amount itself NEVER crosses to the contractor client). */
export type DriverTipCashoutState = {
  availableCents: number;
  availableTipCount: number;
  method: {
    rail: PayoutRail;
    handleMasked: string;
    status: string;
    bankDepositSent: boolean;
  } | null;
  methodVerified: boolean;
  openRequest: { id: string; amountCents: number; createdAt: string } | null;
  paidOutTotalCents: number;
  paidOutCount: number;
};

/* ------------------------------- availability ------------------------------- */

/** The driver's available tips: paid completion_tips minus every cash-out
 *  (requested OR paid — a requested cash-out reserves its tips so the same
 *  tips can never be cashed out twice). */
export async function availableTipsCore(orgId: string, driverId: string): Promise<{ totalCents: number; tipCount: number }> {
  await ensure();
  const q = await db();
  const paid = await q`SELECT COALESCE(SUM(amount_cents),0)::int AS total, COUNT(*)::int AS cnt
    FROM completion_tips WHERE org_id=${orgId} AND driver_id=${driverId} AND status='paid'`;
  const plugs = await q`SELECT COALESCE(SUM(amount_cents),0)::int AS total, COUNT(*)::int AS cnt
    FROM tire_plug_transactions WHERE org_id=${orgId} AND contractor_user_id=${driverId} AND status='paid'`;
  const cash = await q`SELECT COALESCE(SUM(amount_cents),0)::int AS total
    FROM tip_cashouts WHERE org_id=${orgId} AND contractor_id=${driverId}`;
  const totalCents = Number(paid[0]?.total ?? 0) + Number(plugs[0]?.total ?? 0) - Number(cash[0]?.total ?? 0);
  return { totalCents: Math.max(0, totalCents), tipCount: Number(paid[0]?.cnt ?? 0) + Number(plugs[0]?.cnt ?? 0) };
}

/** Oldest paid tips NOT already covered by a cash-out (requested or paid),
 *  oldest-first — the exact tip rows a new request would cover. */
async function uncoveredTipRowsCore(orgId: string, driverId: string): Promise<{ id: string; amountCents: number }[]> {
  const q = await db();
  const rows = await q`
    SELECT ct.id, ct.amount_cents
    FROM completion_tips ct
    WHERE ct.org_id=${orgId} AND ct.driver_id=${driverId} AND ct.status='paid'
      AND NOT EXISTS (
        SELECT 1 FROM tip_cashouts tc, jsonb_array_elements_text(tc.covered_tip_ids) tid
        WHERE tc.org_id = ct.org_id AND tid = ct.id
      )
    ORDER BY ct.created_at ASC, ct.id ASC`;
  return (rows as Record<string, unknown>[]).map((r) => ({ id: String(r.id), amountCents: Number(r.amount_cents ?? 0) }));
}

/* ---------------------------------- cores ---------------------------------- */

/** Driver: current cash-out state for the Earnings card / post-completion CTA.
 *  Never returns the full handle or a bank account number. */
export async function getMyTipCashoutStateCore(user: { orgId: string; id: string }): Promise<TipCashoutResult<DriverTipCashoutState>> {
  try {
    await ensure();
    const q = await db();
    const avail = await availableTipsCore(user.orgId, user.id);
    const methodRows = await q`SELECT rail, handle, bank_institution_name, bank_last4, status, bank_deposit_sent_at
      FROM payout_methods WHERE org_id=${user.orgId} AND contractor_id=${user.id} LIMIT 1`;
    const open = await q`SELECT id, amount_cents, created_at FROM tip_cashouts
      WHERE org_id=${user.orgId} AND contractor_id=${user.id} AND status='requested'
      ORDER BY created_at DESC LIMIT 1`;
    const paid = await q`SELECT COALESCE(SUM(amount_cents),0)::int AS total, COUNT(*)::int AS cnt
      FROM tip_cashouts WHERE org_id=${user.orgId} AND contractor_id=${user.id} AND status='paid'`;
    const m = methodRows.length ? methodRows[0] as Record<string, unknown> : null;
    const method = m
      ? {
          rail: String(m.rail ?? "cash_app") as PayoutRail,
          handleMasked: maskHandle(String(m.rail ?? "cash_app") as PayoutRail, m.handle != null ? String(m.handle) : null, m.bank_institution_name != null ? String(m.bank_institution_name) : null, m.bank_last4 != null ? String(m.bank_last4) : null),
          status: String(m.status ?? "connected_unverified"),
          bankDepositSent: m.bank_deposit_sent_at != null,
        }
      : null;
    return ok({
      availableCents: avail.totalCents,
      availableTipCount: avail.tipCount,
      method,
      methodVerified: Boolean(m && String(m.status) === "verified"),
      openRequest: open.length
        ? { id: String(open[0].id), amountCents: Number((open[0] as Record<string, unknown>).amount_cents ?? 0), createdAt: new Date(String((open[0] as Record<string, unknown>).created_at ?? new Date(0).toISOString())).toISOString() }
        : null,
      paidOutTotalCents: Number(paid[0]?.total ?? 0),
      paidOutCount: Number(paid[0]?.cnt ?? 0),
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load your tip balance.");
  }
}

/** Driver: ONE TAP — request a cash-out of the FULL available tips balance.
 *  Server-computed amount (the client can never pick a number), verified-rail
 *  gate, one open request per contractor (partial unique index = backstop),
 *  covered_tip_ids snapshot for the payday exclusion. */
export async function submitTipCashoutCore(user: { orgId: string; id: string; actorUserId: string; actorRole: string }): Promise<TipCashoutResult<TipCashoutRequest>> {
  try {
    await ensure();
    const q = await db();
    const methodRows = await q`SELECT id, rail, handle, bank_institution_name, bank_last4, status
      FROM payout_methods WHERE org_id=${user.orgId} AND contractor_id=${user.id} LIMIT 1`;
    if (!methodRows.length) return err("invalid_input", "Set a payout method first — the owner verifies it, then you can cash out tips.");
    const m = methodRows[0] as Record<string, unknown>;
    if (String(m.status) !== "verified") {
      return err("invalid_input", "Your payout method isn't verified yet — the owner verifies it before tips can be cashed out.");
    }
    const open = await q`SELECT id FROM tip_cashouts
      WHERE org_id=${user.orgId} AND contractor_id=${user.id} AND status='requested' LIMIT 1`;
    if (open.length) return err("invalid_input", "You already have a cash-out request waiting — the owner pays it from the Payments tab.");
    const avail = await availableTipsCore(user.orgId, user.id);
    if (avail.totalCents <= 0) return err("invalid_input", "No tips available to cash out right now.");
    const uncovered = await uncoveredTipRowsCore(user.orgId, user.id);
    const plugRows = await q`SELECT t.id, t.amount_cents FROM tire_plug_transactions t WHERE t.org_id=${user.orgId} AND t.contractor_user_id=${user.id} AND t.status='paid' AND NOT EXISTS (SELECT 1 FROM tip_cashouts tc, jsonb_array_elements_text(tc.covered_tire_plug_ids) tid WHERE tc.org_id=t.org_id AND tid=t.id) ORDER BY t.paid_at ASC, t.id ASC`;
    const uncoveredPlugs = (plugRows as Record<string, unknown>[]).map((r) => ({ id: String(r.id), amountCents: Number(r.amount_cents ?? 0) }));
    // Walk oldest-first until the covered set sums EXACTLY to available.
    const coveredIds: string[] = []; const coveredPlugIds: string[] = [];
    let sum = 0;
    for (const t of [...uncovered, ...uncoveredPlugs]) {
      (uncovered.includes(t) ? coveredIds : coveredPlugIds).push(t.id);
      sum += t.amountCents;
      if (sum === avail.totalCents) break;
      if (sum > avail.totalCents) return err("database_error", "Tip balance changed — try again.");
    }
    if (sum !== avail.totalCents) return err("database_error", "Tip balance changed — try again.");
    const rail = String(m.rail ?? "cash_app") as PayoutRail;
    const handleMasked = maskHandle(rail, m.handle != null ? String(m.handle) : null, m.bank_institution_name != null ? String(m.bank_institution_name) : null, m.bank_last4 != null ? String(m.bank_last4) : null);
    const id = `tc-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      const inserted = await q`INSERT INTO tip_cashouts(id, org_id, contractor_id, amount_cents, rail, handle_masked, method_id, covered_tip_ids, covered_tire_plug_ids)
        VALUES(${id}, ${user.orgId}, ${user.id}, ${avail.totalCents}, ${rail}, ${handleMasked}, ${String(m.id)}, ${JSON.stringify(coveredIds)}, ${JSON.stringify(coveredPlugIds)})
        RETURNING id, created_at`;
      const created = Array.isArray(inserted) && inserted.length > 0 ? inserted[0] as Record<string, unknown> : null;
      try {
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${user.orgId}, ${user.actorUserId}, ${user.actorRole}, 'tip_cashout_requested', 'tip_cashout', ${id},
            jsonb_build_object('amountCents', ${avail.totalCents}::int, 'rail', ${rail}::text, 'handleMasked', ${handleMasked}::text), 'driver-portal'`;
      } catch { /* best-effort audit */ }
      return ok({
        id,
        orgId: user.orgId,
        contractorId: user.id,
        contractorName: "",
        amountCents: avail.totalCents,
        rail,
        handleMasked,
        methodId: String(m.id),
        status: "requested",
        createdAt: created && created.created_at ? new Date(String(created.created_at)).toISOString() : new Date().toISOString(),
        paidAt: null,
        note: null,
      });
    } catch (insertErr) {
      const msg = insertErr instanceof Error ? insertErr.message : "";
      if (msg.includes("duplicate key") || msg.includes("23505")) {
        return err("invalid_input", "You already have a cash-out request waiting — the owner pays it from the Payments tab.");
      }
      throw insertErr;
    }
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to request a tip cash-out.");
  }
}

/** Owner/admin: the Money-tab list of tip cash-out requests — open first
 *  (newest first), then recently paid. Masked handles only; full payout
 *  details live on the owner payout-methods surface. */
export async function listTirePlugLedgerCore(actor: TipCashoutActor): Promise<TipCashoutResult<TirePlugLedgerRow[]>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure(); const q = await db();
    const rows = await q`SELECT t.*, u.name AS contractor_name FROM tire_plug_transactions t JOIN users u ON u.id=t.contractor_user_id WHERE t.org_id=${actor.orgId} ORDER BY t.created_at DESC LIMIT 100`;
    return ok((rows as Record<string, unknown>[]).map((r) => ({ id:String(r.id), contractorId:String(r.contractor_user_id), contractorName:String(r.contractor_name ?? ""), jobId:String(r.job_id), amountCents:Number(r.amount_cents ?? 0), status:String(r.status), createdAt:new Date(String(r.created_at)).toISOString(), paidAt:r.paid_at ? new Date(String(r.paid_at)).toISOString() : null })));
  } catch (e) { return err("database_error", e instanceof Error ? e.message : "Unable to load tire-plug ledger."); }
}

export async function markTirePlugPaidCore(actor: TipCashoutActor, data: unknown): Promise<TipCashoutResult<TirePlugLedgerRow>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ transactionId: z.string().min(1) }).safeParse(data); if (!v.success) return err("invalid_input", "Transaction id required.");
  try {
    await ensure(); const q = await db();
    const rows = await q`UPDATE tire_plug_transactions SET status='paid', paid_at=NOW() WHERE org_id=${actor.orgId} AND id=${v.data.transactionId} AND status IN ('offered','approved','charged') RETURNING *`;
    if (!rows.length) return err("invalid_input", "Only an unpaid tire-plug request can be marked paid.");
    const r = rows[0] as Record<string, unknown>;
    return ok({ id:String(r.id), contractorId:String(r.contractor_user_id), contractorName:"", jobId:String(r.job_id), amountCents:Number(r.amount_cents ?? 0), status:"paid", createdAt:new Date(String(r.created_at)).toISOString(), paidAt:new Date().toISOString() });
  } catch (e) { return err("database_error", e instanceof Error ? e.message : "Unable to mark tire-plug paid."); }
}

export async function listTipCashoutRequestsCore(actor: TipCashoutActor): Promise<TipCashoutResult<TipCashoutList>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`
      SELECT tc.*, u.name AS contractor_name
      FROM tip_cashouts tc JOIN users u ON u.id = tc.contractor_id
      WHERE tc.org_id=${actor.orgId}
      ORDER BY tc.created_at DESC
      LIMIT 60`;
    const all: TipCashoutRequest[] = (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      orgId: String(r.org_id),
      contractorId: String(r.contractor_id),
      contractorName: String(r.contractor_name ?? ""),
      amountCents: Number(r.amount_cents ?? 0),
      rail: String(r.rail ?? "cash_app") as PayoutRail,
      handleMasked: String(r.handle_masked ?? ""),
      methodId: r.method_id != null ? String(r.method_id) : null,
      status: String(r.status ?? "requested") as "requested" | "paid",
      createdAt: r.created_at != null ? new Date(String(r.created_at)).toISOString() : new Date(0).toISOString(),
      paidAt: r.paid_at != null ? new Date(String(r.paid_at)).toISOString() : null,
      note: r.note != null ? String(r.note) : null,
    }));
    const open = all.filter((r) => r.status === "requested");
    const paid = all.filter((r) => r.status === "paid");
    return ok({
      open,
      paid,
      openTotalCents: open.reduce((s, r) => s + r.amountCents, 0),
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load tip cash-out requests.");
  }
}

/** Owner/admin: mark a cash-out request PAID — the owner already sent the
 *  money from their own app; this records it. Idempotent: a paid request
 *  refuses a second mark. Audit carries amount + masked handle only. */
export async function markTipCashoutPaidCore(actor: TipCashoutActor, data: unknown): Promise<TipCashoutResult<TipCashoutRequest>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ cashoutId: z.string().min(1), note: z.string().max(300).nullable().optional() }).safeParse(data);
  if (!v.success) return err("invalid_input", "Cash-out request id required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT tc.*, u.name AS contractor_name
      FROM tip_cashouts tc JOIN users u ON u.id = tc.contractor_id
      WHERE tc.org_id=${actor.orgId} AND tc.id=${v.data.cashoutId} LIMIT 1`;
    if (!rows.length) return err("not_found", "Cash-out request not found.");
    const r = rows[0] as Record<string, unknown>;
    if (String(r.status) === "paid") return err("invalid_input", "This cash-out is already marked paid.");
    await q`UPDATE tip_cashouts SET status='paid', paid_at=NOW(), paid_by_user_id=${actor.id}, note=${v.data.note ?? null}
      WHERE org_id=${actor.orgId} AND id=${v.data.cashoutId}`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'tip_cashout_paid', 'tip_cashout', ${v.data.cashoutId},
          jsonb_build_object('amountCents', ${Number(r.amount_cents ?? 0)}::int, 'handleMasked', ${String(r.handle_masked ?? "")}::text, 'note', ${v.data.note ?? null}::text), 'owner-money'`;
    } catch { /* best-effort audit */ }
    return ok({
      id: String(r.id),
      orgId: String(r.org_id),
      contractorId: String(r.contractor_id),
      contractorName: String(r.contractor_name ?? ""),
      amountCents: Number(r.amount_cents ?? 0),
      rail: String(r.rail ?? "cash_app") as PayoutRail,
      handleMasked: String(r.handle_masked ?? ""),
      methodId: r.method_id != null ? String(r.method_id) : null,
      status: "paid",
      createdAt: r.created_at != null ? new Date(String(r.created_at)).toISOString() : new Date(0).toISOString(),
      paidAt: new Date().toISOString(),
      note: v.data.note ?? null,
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to mark the cash-out paid.");
  }
}

/** Core helper for computePaydayCore: the tip ids covered by PAID cash-outs
 *  in this org — those tips must NEVER appear in a payday manifest again. */
export async function paidCashoutCoveredTipIdsCore(orgId: string): Promise<Set<string>> {
  await ensure();
  const q = await db();
  const rows = await q`
    SELECT DISTINCT tid AS id
    FROM tip_cashouts tc, jsonb_array_elements_text(tc.covered_tip_ids) tid
    WHERE tc.org_id=${orgId} AND tc.status='paid'`;
  return new Set((rows as Record<string, unknown>[]).map((r) => String(r.id)));
}
