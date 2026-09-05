/**
 * Stripe Connect — automated payouts CORE (automated-payouts Slice 2a,
 * owner-approved 2026-09-03). SERVER-ONLY. NON-LIVE (inert) by default.
 *
 * This slice adds the IMMUTABLE payout ledger (stripe_payouts) plus the first
 * real money-move: INSTANT CASH-OUT of a contractor's eligible tips (the same
 * server-authoritative pool the manual tip-cash-out flow covers — paid
 * completion_tips + paid tire_plug_transactions − already-covered rows). The
 * amount is ALWAYS computed server-side; the client can never pick a number.
 *
 * MONEY-MOVE GATE — OFF BY DEFAULT, FAIL-CLOSED:
 *   The transfer path refuses to fire unless BOTH of these hold:
 *     (a) STRIPE_SECRET_KEY is configured (getStripeClient, reused from
 *         stripe-connect-core — the Stripe singleton is NOT duplicated); AND
 *     (b) the explicit enable flag STRIPE_CONNECT_PAYOUTS_ENABLED is EXACTLY
 *         "true" (case-insensitive, trimmed).
 *   When the gate is off, requestInstantCashoutCore returns a structured
 *   { ok:false, code:"payouts_not_enabled", ... } and NEVER calls Stripe.
 *   This is the simplest honest approach (a single env flag) — no org_settings
 *   read helper existed for payout enablement and adding one is out of scope
 *   for this slice; the flag is documented here and read per-call (never cached)
 *   so a deploy flag flip takes effect without a code change.
 *
 * FAIL-CLOSED everywhere: missing key → "stripe_not_configured"; no linked
 * Connected Account → "bank_not_linked"; linked but not payouts_enabled →
 * "bank_not_ready". Every Stripe error is a structured failure — never a fake
 * success. The secret is read lazily from process.env (or an injected env for
 * tests) and never logged.
 *
 * IDEMPOTENCY (double-transfer guard): the idempotency key is DETERMINISTIC per
 * logical cash-out attempt — derived from (org, contractor, the exact covered
 * tip ids, the exact covered plug ids, the amount). A replay of the same request
 * INSERTs nothing (ON CONFLICT (org_id, idempotency_key) DO NOTHING) and returns
 * the existing row's state instead of creating a second Stripe transfer. The
 * SAME key is passed to Stripe transfers.create so Stripe's own 24h idempotency
 * backstop agrees. (A FAILED attempt releases its coverage — see availableTipsCore
 * — so a genuinely new cash-out computes a new covered set and therefore a new
 * key; a retry of a FAILED attempt with the identical covered set returns the
 * failed row rather than re-firing, which is the documented fail-closed replay
 * behaviour.)
 *
 * COVERAGE MIRROR: covered_tip_ids / covered_tire_plug_ids on stripe_payouts are
 * checked by availableTipsCore / uncoveredTipRowsCore / uncoveredTirePlugRowsCore
 * and by computePaydayCore — the manual (tip_cashouts) and Stripe flows therefore
 * cannot double-cover the same tip/plug. NON-FAILED rows reserve their rows;
 * FAILED rows release them.
 *
 * Imported ONLY by the client-safe facade (./stripe-payouts.ts, whose
 * createServerFn handlers dynamic-import this module) and by hermetic tests.
 * Static server imports are fine here — this module never enters the client
 * bundle graph (the facade only `import type`s from it).
 */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "~/db";
import { getStripeClient } from "./stripe-connect-core";
import {
  availableTipsCore,
  uncoveredTipRowsCore,
  uncoveredTirePlugRowsCore,
} from "./tip-cashout-core";

export type StripePayoutActor = {
  orgId: string;
  contractorId: string;
  actorUserId: string;
  actorRole: string;
};

export type StripePayoutStatus = "pending" | "succeeded" | "failed";
export type StripePayoutKind = "instant_cashout" | "weekly_payout";

/** One stripe_payouts ledger row — seroval-safe (null-or-value, never
 *  undefined). */
export type StripePayout = {
  id: string;
  orgId: string;
  contractorId: string;
  stripeAccountId: string;
  amountCents: number;
  kind: StripePayoutKind;
  status: StripePayoutStatus;
  idempotencyKey: string;
  stripeTransferId: string | null;
  coveredTipIds: string[];
  coveredPlugIds: string[];
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InstantCashoutAmount = {
  totalCents: number;
  tipCount: number;
  coveredTipIds: string[];
  coveredPlugIds: string[];
};

export type StripePayoutErrorCode =
  | "unauthorized"
  | "database_error"
  | "payouts_not_enabled"
  | "stripe_not_configured"
  | "bank_not_linked"
  | "bank_not_ready"
  | "no_funds"
  | "stripe_error";

export type StripePayoutResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: StripePayoutErrorCode; message: string };

const err = (code: StripePayoutErrorCode, message: string): StripePayoutResult<never> => ({
  ok: false,
  code,
  message,
});
const ok = <T>(data: T): StripePayoutResult<T> => ({ ok: true, data });

const dbConfigured = () => Boolean(process.env.DATABASE_URL);
let schemaInit: Promise<void> | undefined;
function ensureDb() {
  if (!dbConfigured()) return Promise.resolve();
  schemaInit ??= (async () => {
    const { ensureSchema } = await import("./migrations");
    await ensureSchema();
  })();
  return schemaInit;
}

type PayoutOpts = {
  client?: import("stripe").default;
  env?: Record<string, string | undefined>;
  now?: Date;
};

/** The explicit money-move enable flag. OFF unless EXACTLY "true". */
const payoutsEnabled = (env: Record<string, string | undefined>) =>
  (env.STRIPE_CONNECT_PAYOUTS_ENABLED ?? "").trim().toLowerCase() === "true";

/** Deterministic idempotency key for one logical instant cash-out attempt. */
function instantCashoutKey(
  orgId: string,
  contractorId: string,
  amountCents: number,
  coveredTipIds: string[],
  coveredPlugIds: string[],
): string {
  const material = [
    "instant_cashout",
    orgId,
    contractorId,
    String(amountCents),
    [...coveredTipIds].sort().join(","),
    [...coveredPlugIds].sort().join(","),
  ].join(":");
  return createHash("sha256").update(material).digest("hex").slice(0, 40);
}

function rowToPayout(r: Record<string, unknown>): StripePayout {
  const parseIds = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.map(String);
  };
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    contractorId: String(r.contractor_id),
    stripeAccountId: String(r.stripe_account_id),
    amountCents: Number(r.amount_cents ?? 0),
    kind: String(r.kind ?? "instant_cashout") as StripePayoutKind,
    status: String(r.status ?? "pending") as StripePayoutStatus,
    idempotencyKey: String(r.idempotency_key ?? ""),
    stripeTransferId: r.stripe_transfer_id != null ? String(r.stripe_transfer_id) : null,
    coveredTipIds: parseIds(r.covered_tip_ids),
    coveredPlugIds: parseIds(r.covered_tire_plug_ids),
    failureMessage: r.failure_message != null ? String(r.failure_message) : null,
    createdAt: r.created_at != null ? new Date(String(r.created_at)).toISOString() : new Date(0).toISOString(),
    updatedAt: r.updated_at != null ? new Date(String(r.updated_at)).toISOString() : new Date(0).toISOString(),
  };
}

/* ----------------------------- amount computation ---------------------------- */

/** Server-authoritative eligible instant cash-out amount for a contractor: the
 *  SAME pool availableTipsCore uses (paid tips + paid plugs − already-covered),
 *  plus the EXACT covered tip/plug ids the transfer would consume. */
export async function computeInstantCashoutAmountCore(
  orgId: string,
  contractorId: string,
): Promise<StripePayoutResult<InstantCashoutAmount>> {
  try {
    await ensureDb();
    if (!dbConfigured()) return err("database_error", "Database is not configured.");
    const avail = await availableTipsCore(orgId, contractorId);
    const tips = await uncoveredTipRowsCore(orgId, contractorId);
    const plugs = await uncoveredTirePlugRowsCore(orgId, contractorId);
    const coveredTipIds: string[] = [];
    const coveredPlugIds: string[] = [];
    let sum = 0;
    for (const t of [...tips, ...plugs]) {
      (tips.includes(t) ? coveredTipIds : coveredPlugIds).push(t.id);
      sum += t.amountCents;
      if (sum === avail.totalCents) break;
      if (sum > avail.totalCents) return err("database_error", "Tip balance changed — try again.");
    }
    if (sum !== avail.totalCents) return err("database_error", "Tip balance changed — try again.");
    return ok({
      totalCents: avail.totalCents,
      tipCount: avail.tipCount,
      coveredTipIds,
      coveredPlugIds,
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to compute the instant cash-out amount.");
  }
}

/* ------------------------------ read-only status ----------------------------- */

export type InstantCashoutStatus = {
  linked: boolean;
  stripeAccountId: string | null;
  payoutsEnabled: boolean;
  eligibleTotalCents: number;
  eligibleTipCount: number;
  enabled: boolean;
  lastPayout: StripePayout | null;
};

/** Read-only: bank-link readiness + eligible amount + last payout state. NEVER
 *  a money move. */
export async function getInstantCashoutStatusCore(
  actor: StripePayoutActor,
): Promise<StripePayoutResult<InstantCashoutStatus>> {
  try {
    await ensureDb();
    if (!dbConfigured()) return err("database_error", "Database is not configured.");
    const q = sql();
    const profiles = await q`SELECT stripe_account_id, stripe_payouts_enabled
      FROM contractor_profiles WHERE org_id=${actor.orgId} AND user_id=${actor.contractorId} LIMIT 1`;
    const stripeAccountId = profiles.length && profiles[0].stripe_account_id != null
      ? String((profiles[0] as Record<string, unknown>).stripe_account_id)
      : null;
    const payoutsEnabledFlag = Boolean(profiles.length && (profiles[0] as Record<string, unknown>).stripe_payouts_enabled === true);
    const eligible = await computeInstantCashoutAmountCore(actor.orgId, actor.contractorId);
    const lastRows = await q`SELECT * FROM stripe_payouts
      WHERE org_id=${actor.orgId} AND contractor_id=${actor.contractorId}
      ORDER BY created_at DESC LIMIT 1`;
    return ok({
      linked: stripeAccountId != null,
      stripeAccountId,
      payoutsEnabled: payoutsEnabledFlag,
      eligibleTotalCents: eligible.ok ? eligible.data.totalCents : 0,
      eligibleTipCount: eligible.ok ? eligible.data.tipCount : 0,
      enabled: payoutsEnabled(process.env),
      lastPayout: lastRows.length ? rowToPayout(lastRows[0] as Record<string, unknown>) : null,
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load payout status.");
  }
}

/* ------------------------------ money move: instant ------------------------------ */

function writeAudit(
  q: ReturnType<typeof sql>,
  actor: StripePayoutActor,
  action: string,
  payoutId: string,
  detail: Record<string, unknown>,
): Promise<unknown> {
  return q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
    SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.actorUserId}, ${actor.actorRole}, ${action}, 'stripe_payout', ${payoutId},
      ${JSON.stringify(detail)}::jsonb, 'driver-portal'`;
}

/** INSTANT CASH-OUT — move the contractor's full eligible tips via a Stripe
 *  Transfer to their Connected Account. Fail-closed money-move gate, server-
 *  authoritative amount, deterministic idempotency key, immutable ledger row +
 *  audit_log on every status transition. */
export async function requestInstantCashoutCore(
  actor: StripePayoutActor,
  opts: PayoutOpts = {},
): Promise<StripePayoutResult<StripePayout>> {
  try {
    await ensureDb();
    if (!dbConfigured()) return err("database_error", "Database is not configured.");
    const q = sql();
    const env = opts.env ?? process.env;

    // (0) Money-move gate — OFF by default, fail-closed, never a fake success.
    // Checked FIRST (and independently of bank-link/amount) so the transfer
    // path refuses to move money whenever the flag is not exactly "true".
    if (!payoutsEnabled(env)) {
      return err("payouts_not_enabled", "Automated payouts are not enabled.");
    }

    // (1) Resolve the contractor's Connected Account — fail if not linked/ready.
    const profiles = await q`SELECT stripe_account_id, stripe_payouts_enabled
      FROM contractor_profiles WHERE org_id=${actor.orgId} AND user_id=${actor.contractorId} LIMIT 1`;
    if (!profiles.length) return err("bank_not_linked", "Link your bank first — no Stripe account is connected.");
    const stripeAccountId = profiles[0].stripe_account_id != null ? String((profiles[0] as Record<string, unknown>).stripe_account_id) : null;
    if (!stripeAccountId) return err("bank_not_linked", "Link your bank first — no Stripe account is connected.");
    if ((profiles[0] as Record<string, unknown>).stripe_payouts_enabled !== true) {
      return err("bank_not_ready", "Your bank link isn't ready for payouts yet — finish Stripe onboarding.");
    }

    // (3) Server-authoritative amount + covered rows.
    const amount = await computeInstantCashoutAmountCore(actor.orgId, actor.contractorId);
    if (!amount.ok) return amount;
    if (amount.data.totalCents <= 0) return err("no_funds", "No tips available to cash out right now.");

    // (4) Fail-closed Stripe client (reused singleton; injected client in tests).
    const client = opts.client
      ? { configured: true as const, client: opts.client }
      : getStripeClient(env);
    if (!client.configured) return err("stripe_not_configured", client.reason);

    // (5) Deterministic key + INSERT (concurrent duplicate = no-op on the
    // (org_id, idempotency_key) unique index; id uses randomUUID so the PK can
    // never collide with an earlier row from a different logical attempt).
    const idempotencyKey = instantCashoutKey(
      actor.orgId,
      actor.contractorId,
      amount.data.totalCents,
      amount.data.coveredTipIds,
      amount.data.coveredPlugIds,
    );
    const id = `sp_${randomUUID()}`;
    const inserted = await q`INSERT INTO stripe_payouts
        (id, org_id, contractor_id, stripe_account_id, amount_cents, kind, status, idempotency_key, covered_tip_ids, covered_tire_plug_ids)
      VALUES
        (${id}, ${actor.orgId}, ${actor.contractorId}, ${stripeAccountId}, ${amount.data.totalCents}, 'instant_cashout', 'pending', ${idempotencyKey}, ${JSON.stringify(amount.data.coveredTipIds)}, ${JSON.stringify(amount.data.coveredPlugIds)})
      ON CONFLICT (org_id, idempotency_key) DO NOTHING
      RETURNING id`;
    if (!inserted.length) {
      const existing = await q`SELECT * FROM stripe_payouts
        WHERE org_id=${actor.orgId} AND idempotency_key=${idempotencyKey} LIMIT 1`;
      if (existing.length) return ok(rowToPayout(existing[0] as Record<string, unknown>));
      return err("database_error", "Payout row could not be created.");
    }

    // (6) Fire the Stripe Transfer with the SAME deterministic idempotency key.
    try {
      const transfer = await client.client.transfers.create(
        {
          amount: amount.data.totalCents,
          currency: "usd",
          destination: stripeAccountId,
        },
        { idempotencyKey },
      );
      const updated = await q`UPDATE stripe_payouts
        SET status='succeeded', stripe_transfer_id=${transfer.id}, failure_message=NULL, updated_at=NOW()
        WHERE org_id=${actor.orgId} AND id=${id} AND status='pending'
        RETURNING *`;
      await writeAudit(q, actor, "stripe_payout_succeeded", id, {
        amountCents: amount.data.totalCents,
        stripeTransferId: transfer.id,
      }).catch(() => {});
      if (updated.length) return ok(rowToPayout(updated[0] as Record<string, unknown>));
      // Concurrent writer won the transition — read the current row.
      const row = await q`SELECT * FROM stripe_payouts WHERE org_id=${actor.orgId} AND id=${id} LIMIT 1`;
      return ok(rowToPayout(row[0] as Record<string, unknown>));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe transfer failed.";
      await q`UPDATE stripe_payouts
        SET status='failed', failure_message=${msg}, updated_at=NOW()
        WHERE org_id=${actor.orgId} AND id=${id} AND status='pending'`;
      await writeAudit(q, actor, "stripe_payout_failed", id, {
        amountCents: amount.data.totalCents,
        failureMessage: msg,
      }).catch(() => {});
      return err("stripe_error", msg);
    }
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to request an instant cash-out.");
  }
}

/* -------------------------- session-resolving handlers ---------------------- */

async function resolveActor(): Promise<StripePayoutActor | null> {
  if (!dbConfigured()) return null;
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return null;
  return {
    orgId: u.orgId,
    contractorId: identity.userRowId,
    actorUserId: u.id,
    actorRole: u.role,
  };
}

export async function getInstantCashoutStatusHandler(): Promise<StripePayoutResult<InstantCashoutStatus>> {
  const actor = await resolveActor();
  if (!actor) return err("unauthorized", "Sign in as a driver first.");
  return getInstantCashoutStatusCore(actor);
}

export async function requestInstantCashoutHandler(): Promise<StripePayoutResult<StripePayout>> {
  const actor = await resolveActor();
  if (!actor) return err("unauthorized", "Sign in as a driver first.");
  return requestInstantCashoutCore(actor);
}
