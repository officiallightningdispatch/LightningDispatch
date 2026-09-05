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

export type { InstantCashoutStatus, StripePayout } from "./stripe-payouts-core";

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
