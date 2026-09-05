/**
 * Stripe Connect — WEEKLY AUTO-PAYOUT CORE (automated-payouts Slice 2b,
 * owner-approved 2026-09-03). SERVER-ONLY. NON-LIVE (inert) by default.
 *
 * This slice adds the weekly-payroll money move as a BATCH: for each contractor
 * in a computed Mon–Sun payday manifest (the `payout_records` produced by
 * `computePaydayCore`), fire ONE Stripe Transfer to their Connected Account for
 * their server-authoritative amount. It REUSES the immutable `stripe_payouts`
 * ledger from Slice 2a with `kind='weekly_payout'` — no second ledger, no new
 * migration. A client-safe facade is NOT required this slice (core-only; the UI
 * + cron wiring arrive in a later slice).
 *
 * MONEY-MOVE GATE — OFF BY DEFAULT, FAIL-CLOSED (same contract as Slice 2a):
 *   refuses to fire unless BOTH hold:
 *     (a) STRIPE_SECRET_KEY is configured (getStripeClient, reused from
 *         stripe-connect-core — the Stripe singleton is NOT duplicated); AND
 *     (b) STRIPE_CONNECT_PAYOUTS_ENABLED is EXACTLY "true" (case-insensitive,
 *         trimmed).
 *   When the gate is off, runWeeklyPayoutCore returns
 *   { ok:false, code:"payouts_not_enabled", ... } and NEVER calls Stripe. A
 *   missing key yields a batch-level { ok:false, code:"stripe_not_configured" }.
 *   Per-contractor skip reasons are returned in the batch result — never a
 *   thrown error, never a fake success.
 *
 * IDEMPOTENCY (double-transfer guard): the idempotency key is DETERMINISTIC per
 * (org, contractor, period) — it does NOT include the amount, so re-running the
 * same week for the same contractor can never double-transfer, even if a
 * recompute nudges the amount. A replay returns the EXISTING ledger row's state
 * (succeeded → reported succeeded with its transfer id; failed → reported
 * failed) WITHOUT re-firing Stripe. INSERT pending → transfers.create (same
 * key) → succeeded+stripe_transfer_id | failed+failure_message, with an
 * audit_log row on every status transition (never a bare UPDATE).
 *
 * AMOUNTS ARE NEVER INVENTED HERE: this module takes the already-computed
 * per-contractor `payout_records` (contractorId + totalCents) as input — the
 * SAME server-authoritative amounts the manual payroll uses. Records with a
 * non-positive amount are skipped silently (Stripe requires amount > 0 and the
 * ledger CHECK enforces amount_cents > 0).
 *
 * Imported ONLY by hermetic tests (and, in a later slice, by the client-safe
 * facade / owner-cron handler). Static server imports are fine here — this
 * module never enters the client bundle graph.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "~/db";
import { getStripeClient } from "./stripe-connect-core";
import type { StripePayoutErrorCode, StripePayoutResult } from "./stripe-payouts-core";

/** The acting context for the batch. Weekly payouts are owner/system-initiated,
 *  so this carries the org plus the audit actor (not a single contractor). */
export type WeeklyPayoutActor = {
  orgId: string;
  actorUserId: string;
  actorRole: string;
};

/** One input record — mirrors a computed payout_record row: contractor + the
 *  server-authoritative totalCents. Callers pass
 *  `computePaydayCore(...).data.records.map(r => ({ contractorId: r.contractorId,
 *  amountCents: r.totalCents }))`. */
export type WeeklyPayoutRecordInput = {
  contractorId: string;
  amountCents: number;
};

export type WeeklyPayoutSucceededItem = {
  contractorId: string;
  amountCents: number;
  payoutId: string;
  stripeAccountId: string;
  stripeTransferId: string | null;
  status: "pending" | "succeeded";
};

export type WeeklyPayoutSkippedItem = {
  contractorId: string;
  amountCents: number;
  code: "bank_not_linked" | "bank_not_ready";
  message: string;
};

export type WeeklyPayoutFailedItem = {
  contractorId: string;
  amountCents: number;
  code: "stripe_error";
  failureMessage: string;
};

/** Batch result — Seroval-safe (null-or-value, never undefined). */
export type WeeklyPayoutBatchResult = {
  succeeded: WeeklyPayoutSucceededItem[];
  skippedNotLinked: WeeklyPayoutSkippedItem[];
  skippedNotReady: WeeklyPayoutSkippedItem[];
  failed: WeeklyPayoutFailedItem[];
};

export type WeeklyPayoutPreviewItem = {
  contractorId: string;
  amountCents: number;
  stripeAccountId: string | null;
};
export type WeeklyPayoutPreview = {
  linked: WeeklyPayoutPreviewItem[];
  notLinked: WeeklyPayoutPreviewItem[];
  notReady: WeeklyPayoutPreviewItem[];
  skippedZeroAmount: WeeklyPayoutPreviewItem[];
};

type WeeklyPayoutOpts = {
  client?: import("stripe").default;
  env?: Record<string, string | undefined>;
};

const err = (code: StripePayoutErrorCode, message: string): StripePayoutResult<never> => ({
  ok: false,
  code,
  message,
});
const ok = <T>(data: T): StripePayoutResult<T> => ({ ok: true, data });

/** The explicit money-move enable flag — OFF unless EXACTLY "true" (mirrors
 *  the Slice 2a gate; the flag is read per-call, never cached). */
const payoutsEnabled = (env: Record<string, string | undefined>) =>
  (env.STRIPE_CONNECT_PAYOUTS_ENABLED ?? "").trim().toLowerCase() === "true";

/** Deterministic idempotency key per (org, contractor, period). Amount is
 *  deliberately EXCLUDED so a period replay can never double-transfer. */
function weeklyPayoutKey(orgId: string, contractorId: string, periodId: string): string {
  const material = ["weekly_payout", orgId, contractorId, periodId].join(":");
  return createHash("sha256").update(material).digest("hex").slice(0, 40);
}

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

function writeAudit(
  q: ReturnType<typeof sql>,
  actor: WeeklyPayoutActor,
  action: string,
  payoutId: string,
  detail: Record<string, unknown>,
): Promise<unknown> {
  return q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
    SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.actorUserId}, ${actor.actorRole}, ${action}, 'stripe_payout', ${payoutId},
      ${JSON.stringify(detail)}::jsonb, 'weekly-payout'`;
}

/** WEEKLY AUTO-PAYOUT — move each contractor's computed payday total via a
 *  Stripe Transfer to their Connected Account. Fail-closed money-move gate,
 *  server-supplied amounts, deterministic per-period idempotency key, immutable
 *  ledger rows + audit_log on every status transition. */
export async function runWeeklyPayoutCore(
  actor: WeeklyPayoutActor,
  periodId: string,
  records: WeeklyPayoutRecordInput[],
  opts: WeeklyPayoutOpts = {},
): Promise<StripePayoutResult<WeeklyPayoutBatchResult>> {
  try {
    await ensureDb();
    if (!dbConfigured()) return err("database_error", "Database is not configured.");
    const q = sql();
    const env = opts.env ?? process.env;

    // (0) Money-move gate — OFF by default, fail-closed, never a fake success.
    if (!payoutsEnabled(env)) {
      return err("payouts_not_enabled", "Automated payouts are not enabled.");
    }

    // (1) Fail-closed Stripe client (reused singleton; injected client in tests).
    const client = opts.client
      ? { configured: true as const, client: opts.client }
      : getStripeClient(env);
    if (!client.configured) return err("stripe_not_configured", client.reason);

    const result: WeeklyPayoutBatchResult = {
      succeeded: [],
      skippedNotLinked: [],
      skippedNotReady: [],
      failed: [],
    };

    for (const rec of records) {
      const amountCents = Math.max(0, Math.trunc(Number(rec.amountCents) || 0));
      if (amountCents <= 0) continue; // $0 payable → nothing to transfer

      // (2) Resolve the contractor's Connected Account — skip (not fail the
      // batch) when not linked / not ready.
      const profiles = await q`SELECT stripe_account_id, stripe_payouts_enabled
        FROM contractor_profiles WHERE org_id=${actor.orgId} AND user_id=${rec.contractorId} LIMIT 1`;
      const profile = profiles[0] as Record<string, unknown> | undefined;
      const stripeAccountId = profile && profile.stripe_account_id != null ? String(profile.stripe_account_id) : null;
      if (!profile || !stripeAccountId) {
        result.skippedNotLinked.push({
          contractorId: rec.contractorId,
          amountCents,
          code: "bank_not_linked",
          message: "Link your bank first — no Stripe account is connected.",
        });
        continue;
      }
      if (profile.stripe_payouts_enabled !== true) {
        result.skippedNotReady.push({
          contractorId: rec.contractorId,
          amountCents,
          code: "bank_not_ready",
          message: "Your bank link isn't ready for payouts yet — finish Stripe onboarding.",
        });
        continue;
      }

      // (3) Deterministic key + INSERT (concurrent duplicate = no-op on the
      // (org_id, idempotency_key) unique index).
      const idempotencyKey = weeklyPayoutKey(actor.orgId, rec.contractorId, periodId);
      const id = `spw_${randomUUID()}`;
      const inserted = await q`INSERT INTO stripe_payouts
          (id, org_id, contractor_id, stripe_account_id, amount_cents, kind, status, idempotency_key)
        VALUES
          (${id}, ${actor.orgId}, ${rec.contractorId}, ${stripeAccountId}, ${amountCents}, 'weekly_payout', 'pending', ${idempotencyKey})
        ON CONFLICT (org_id, idempotency_key) DO NOTHING
        RETURNING id`;
      if (!inserted.length) {
        // Replay: return the existing row's state, NEVER re-fire.
        const existing = await q`SELECT * FROM stripe_payouts
          WHERE org_id=${actor.orgId} AND idempotency_key=${idempotencyKey} LIMIT 1`;
        if (existing.length) {
          const r = existing[0] as Record<string, unknown>;
          const status = String(r.status);
          if (status === "failed") {
            result.failed.push({
              contractorId: rec.contractorId,
              amountCents: Number(r.amount_cents ?? 0),
              code: "stripe_error",
              failureMessage: r.failure_message != null ? String(r.failure_message) : "Weekly payout previously failed.",
            });
          } else {
            result.succeeded.push({
              contractorId: rec.contractorId,
              amountCents: Number(r.amount_cents ?? 0),
              payoutId: String(r.id),
              stripeAccountId: String(r.stripe_account_id),
              stripeTransferId: r.stripe_transfer_id != null ? String(r.stripe_transfer_id) : null,
              status: status === "succeeded" ? "succeeded" : "pending",
            });
          }
        }
        continue;
      }

      // (4) Fire the Stripe Transfer with the SAME deterministic idempotency key.
      try {
        const transfer = await client.client.transfers.create(
          { amount: amountCents, currency: "usd", destination: stripeAccountId },
          { idempotencyKey },
        );
        const updated = await q`UPDATE stripe_payouts
          SET status='succeeded', stripe_transfer_id=${transfer.id}, failure_message=NULL, updated_at=NOW()
          WHERE org_id=${actor.orgId} AND id=${id} AND status='pending'
          RETURNING *`;
        await writeAudit(q, actor, "stripe_weekly_payout_succeeded", id, {
          amountCents,
          stripeTransferId: transfer.id,
          periodId,
        }).catch(() => {});
        const row = (updated.length ? updated[0] : null) as Record<string, unknown> | null;
        if (row) {
          result.succeeded.push({
            contractorId: rec.contractorId,
            amountCents: Number(row.amount_cents ?? amountCents),
            payoutId: String(row.id),
            stripeAccountId: String(row.stripe_account_id),
            stripeTransferId: transfer.id,
            status: "succeeded",
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Stripe transfer failed.";
        await q`UPDATE stripe_payouts
          SET status='failed', failure_message=${msg}, updated_at=NOW()
          WHERE org_id=${actor.orgId} AND id=${id} AND status='pending'`;
        await writeAudit(q, actor, "stripe_weekly_payout_failed", id, {
          amountCents,
          failureMessage: msg,
          periodId,
        }).catch(() => {});
        result.failed.push({
          contractorId: rec.contractorId,
          amountCents,
          code: "stripe_error",
          failureMessage: msg,
        });
      }
    }

    return ok(result);
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to run weekly payouts.");
  }
}

/** READ-ONLY plan: which contractors would receive a weekly transfer for a
 *  given period, without moving money. Never calls Stripe. */
export async function previewWeeklyPayoutsCore(
  orgId: string,
  records: WeeklyPayoutRecordInput[],
): Promise<StripePayoutResult<WeeklyPayoutPreview>> {
  try {
    await ensureDb();
    if (!dbConfigured()) return err("database_error", "Database is not configured.");
    const q = sql();
    const profiles = await q`SELECT user_id, stripe_account_id, stripe_payouts_enabled
      FROM contractor_profiles WHERE org_id=${orgId}`;
    const byUser = new Map<string, Record<string, unknown>>();
    for (const p of profiles as Record<string, unknown>[]) byUser.set(String(p.user_id), p);

    const preview: WeeklyPayoutPreview = { linked: [], notLinked: [], notReady: [], skippedZeroAmount: [] };
    for (const rec of records) {
      const amountCents = Math.max(0, Math.trunc(Number(rec.amountCents) || 0));
      const profile = byUser.get(rec.contractorId);
      const stripeAccountId = profile && profile.stripe_account_id != null ? String(profile.stripe_account_id) : null;
      const item: WeeklyPayoutPreviewItem = { contractorId: rec.contractorId, amountCents, stripeAccountId };
      if (amountCents <= 0) preview.skippedZeroAmount.push(item);
      else if (!profile || !stripeAccountId) preview.notLinked.push(item);
      else if (profile.stripe_payouts_enabled !== true) preview.notReady.push(item);
      else preview.linked.push(item);
    }
    return ok(preview);
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to preview weekly payouts.");
  }
}
