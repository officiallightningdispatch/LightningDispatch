"use client";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Public HTTPS return route for Stripe Connect bank onboarding (automated
 * payouts, owner-approved 2026-09-03).
 *
 * Stripe `accountLinks.create` requires an HTTPS `return_url`/`refresh_url`
 * (a `lightningdispatch://` custom scheme is REJECTED). On the native iOS shell
 * the app is loaded from `server.url` (a public HTTPS origin), so Stripe lands
 * back here in the standalone browser (SFSafariViewController) after
 * onboarding. That browser does NOT share the webview session, so this page is
 * deliberately PUBLIC — no auth gate.
 *
 * On client mount it navigates to the app's custom scheme
 * (`lightningdispatch://stripe-connect-complete`), which the native app shell
 * intercepts via Capacitor `appUrlOpen` and routes back to /driver/earnings
 * with a fresh bank-link status check. A visible fallback button does the same
 * in case the automatic navigation is blocked.
 */
export const Route = createFileRoute("/stripe-connect-complete")({
  component: StripeConnectComplete,
});

const APP_RETURN_URL = "lightningdispatch://stripe-connect-complete";

function StripeConnectComplete() {
  useEffect(() => {
    // Fire the deep link once on mount so the native shell re-opens the app.
    window.location.href = APP_RETURN_URL;
  }, []);
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-6 text-ink-900">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-brand-500 text-white">
          <svg
            className="size-6"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor" stroke="none" />
          </svg>
        </div>
        <h1 className="text-xl font-bold tracking-tight">Returning to Lightning Dispatch…</h1>
        <p className="mt-2 text-sm text-ink-500">
          You&apos;re being returned to the app to finish linking your bank.
        </p>
        <button
          type="button"
          onClick={() => {
            window.location.href = APP_RETURN_URL;
          }}
          className="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-brand-500 px-5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-brand-600 active:scale-[0.98] motion-reduce:transform-none"
        >
          Return to the app
        </button>
      </div>
    </main>
  );
}
