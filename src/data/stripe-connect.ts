/**
 * Stripe Connect contractor bank-linking — CLIENT-SAFE FACADE (automated-payouts
 * Slice 1, owner-approved 2026-09-03). This module is the ONLY piece of the
 * feature imported by client code (the contractor "Link your bank" surface). It
 * defines the createServerFn server functions; their handlers dynamic-import the
 * SERVER-ONLY core (./stripe-connect-core.ts) so the client bundle never pulls
 * in the Stripe SDK / db / auth-server code. No other exports (client-graph
 * rule — see square-readback.ts / payouts.ts precedents).
 */
import { createServerFn } from "@tanstack/react-start";
import type { StripeConnectResult, StripeConnectStatus } from "./stripe-connect-core";

export type { StripeConnectStatus } from "./stripe-connect-core";

const passthrough = (x: unknown) => x;

/** Start the Connect onboarding flow for the acting contractor: provisions a
 *  Connected Account if needed and returns a single-use onboarding URL. The
 *  return/refresh URLs come from the client (the contractor's own origin) so
 *  Stripe lands them back on their payout screen. */
export const startBankLink = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<StripeConnectResult<{ url: string }>> => {
    const core = await import("./stripe-connect-core");
    const d = (data ?? {}) as { returnUrl?: string; refreshUrl?: string };
    const returnUrl = typeof d.returnUrl === "string" && d.returnUrl ? d.returnUrl : "";
    const refreshUrl = typeof d.refreshUrl === "string" && d.refreshUrl ? d.refreshUrl : returnUrl;
    return core.startBankLinkHandler({ returnUrl, refreshUrl });
  });

/** Read the acting contractor's bank-link status (linked / pending / not
 *  configured). Read-only — never a money move. */
export const getBankLinkStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<StripeConnectResult<StripeConnectStatus>> => {
    const core = await import("./stripe-connect-core");
    return core.getBankLinkStatusHandler();
  },
);
