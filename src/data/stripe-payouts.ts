/**
 * Stripe Connect automated payouts — CLIENT-SAFE FACADE (automated-payouts Slice
 * 2a, owner-approved 2026-09-03). This module is the ONLY piece of the feature
 * imported by client code (later UI slice). It defines the createServerFn server
 * functions; their handlers dynamic-import the SERVER-ONLY core
 * (./stripe-payouts-core.ts) so the client bundle never pulls in the Stripe SDK /
 * db / auth-server / tip-cashout code. `import type` only for shared types
 * (client-graph rule — see stripe-connect.ts precedent).
 */
import { createServerFn } from "@tanstack/react-start";
import type {
  InstantCashoutStatus,
  StripePayout,
  StripePayoutResult,
} from "./stripe-payouts-core";
import type { WeeklyPayoutPreview, WeeklyPayoutRecordInput } from "./stripe-payouts-weekly-core";

export type { InstantCashoutStatus, StripePayout } from "./stripe-payouts-core";
export type { WeeklyPayoutPreview } from "./stripe-payouts-weekly-core";

const passthrough = (x: unknown) => x;

/** Read-only: eligible amount + bank-link readiness + last payout state. Never a
 *  money move. */
export const getInstantCashoutStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<StripePayoutResult<InstantCashoutStatus>> => {
    const core = await import("./stripe-payouts-core");
    return core.getInstantCashoutStatusHandler();
  },
);

/** INSTANT CASH-OUT — move the contractor's full eligible tips via a Stripe
 *  Transfer. The validator accepts NO client amount (server-computed). */
export const requestInstantCashout = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async (): Promise<StripePayoutResult<StripePayout>> => {
    const core = await import("./stripe-payouts-core");
    return core.requestInstantCashoutHandler();
  });

/* ------------------------- owner/admin read-only ------------------------- */

/** Owner/admin: read the Stripe payout ledger (instant cash-outs + weekly
 *  payouts), newest first. Read-only — never a money move. */
export const listStripePayouts = createServerFn({ method: "GET" }).handler(
  async (): Promise<StripePayoutResult<StripePayout[]>> => {
    const core = await import("./stripe-payouts-core");
    return core.listStripePayoutsHandler();
  },
);

/** Owner/admin: read-only weekly-payout preview for the given records (the same
 *  server-authoritative amounts the payday manifest computes — NEVER computed
 *  client-side). The records come from the already-computed pay-period detail;
 *  the facade re-derives nothing. No run/move-money button is wired in this
 *  slice. */
export const previewWeeklyPayouts = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<StripePayoutResult<WeeklyPayoutPreview>> => {
    const core = await import("./stripe-payouts-weekly-core");
    const { currentUser } = await import("./auth-server");
    const u = await currentUser();
    if (!u || (u.role !== "owner" && u.role !== "admin")) {
      return { ok: false as const, code: "unauthorized", message: "Sign in as the owner or an admin first." };
    }
    const d = (data ?? {}) as { records?: unknown };
    const records: WeeklyPayoutRecordInput[] = Array.isArray(d.records)
      ? d.records
          .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : null))
          .filter((r): r is Record<string, unknown> => r != null)
          .map((r) => ({
            contractorId: typeof r.contractorId === "string" ? r.contractorId : "",
            amountCents: typeof r.amountCents === "number" ? Math.trunc(r.amountCents) : 0,
          }))
      : [];
    return core.previewWeeklyPayoutsHandler({ orgId: u.orgId }, records);
  });
