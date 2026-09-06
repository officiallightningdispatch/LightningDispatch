"use client";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getBankLinkStatus } from "~/data/stripe-connect";
import {
  installStripeConnectReturnListener,
  STRIPE_CONNECT_REFRESH_EVENT,
} from "~/lib/stripe-connect-linking";

/**
 * Driver-shell deep-link handler for Stripe Connect bank onboarding
 * (automated payouts, owner-approved 2026-09-03).
 *
 * The public HTTPS return route (src/routes/stripe-connect-complete.tsx) fires
 * `lightningdispatch://stripe-connect-complete` from the standalone onboarding
 * browser. This component (mounted once by the driver gate) listens for
 * Capacitor `appUrlOpen`, and on that deep link:
 *   1. navigates the driver to /driver/earnings, and
 *   2. fires a fresh `getBankLinkStatus()` server read (which also refreshes the
 *      persisted Stripe flags), and
 *   3. dispatches a window event so any mounted bank-link / cash-out surface
 *      re-reads its status immediately.
 *
 * Web-safe: outside the native shell the listener is an inert no-op.
 */
export function StripeConnectReturnHandler() {
  const nav = useNavigate();
  useEffect(() => {
    const handle = installStripeConnectReturnListener(() => {
      // Fresh server read → refreshes persisted charges/payouts flags from Stripe.
      void getBankLinkStatus().then(() => {
        try {
          window.dispatchEvent(new Event(STRIPE_CONNECT_REFRESH_EVENT));
        } catch {
          // Best-effort; the navigation below is the authoritative hand-back.
        }
      });
      void nav({ to: "/driver/earnings" });
    });
    return () => handle.remove();
  }, [nav]);
  return null;
}
