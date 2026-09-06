/**
 * Stripe Connect bank-link return-routing helpers (automated payouts,
 * owner-approved 2026-09-03). CLIENT-SAFE — no server imports.
 *
 * These small pure/DI functions exist so the hermetic suite can assert the
 * exact return/refresh URL construction and the native-vs-web open path without
 * a DOM or device. The React surface (bank-link-card.tsx) uses them verbatim.
 *
 * Why a public HTTPS return route + custom scheme (2026-09-04 fix):
 *  - Stripe `accountLinks.create` REJECTS a non-HTTPS `return_url`/`refresh_url`
 *    (a `lightningdispatch://` scheme would 400).
 *  - On the native iOS shell the app is served from `server.url` (a public HTTPS
 *    origin), so the correct return URL is `${origin}/stripe-connect-complete`.
 *  - Stripe hosted onboarding must run OUTSIDE the webview, in a standalone
 *    browser (`@capacitor/browser` → SFSafariViewController). That browser does
 *    not share the webview session, so the return route is public and it fires
 *    the `lightningdispatch://` deep link to hand control back to the app.
 */
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";

/** Path of the public HTTPS return route (see src/routes/stripe-connect-complete.tsx). */
export const STRIPE_CONNECT_COMPLETE_PATH = "/stripe-connect-complete";
/** Custom-scheme deep link the return page fires to hand control back to the app. */
export const STRIPE_CONNECT_APP_SCHEME_URL = "lightningdispatch://stripe-connect-complete";
/** Window event fired after a Stripe-Connect return deep link so any mounted
 *  bank-link surface re-checks its status (fresh server read + Stripe refresh). */
export const STRIPE_CONNECT_REFRESH_EVENT = "lightning:stripe-connect-complete";

/**
 * Build the HTTPS return/refresh URL Stripe lands on after onboarding.
 * `origin` comes from `window.location.origin` (correct HTTPS origin on both
 * the native shell — which loads from `server.url` — and the web build).
 * Never returns a `lightningdispatch://` URL (Stripe rejects those).
 */
export function buildStripeConnectReturnUrl(origin: string): string {
  const base = String(origin ?? "").replace(/\/+$/, "");
  return `${base}${STRIPE_CONNECT_COMPLETE_PATH}`;
}

/** Whether we are running inside the native Capacitor shell. Exposed as a thin
 *  wrapper so tests can assert the native-vs-web branch deterministically. */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * True when a received deep link is the Stripe-Connect-complete return link
 * (the custom scheme fired by the public HTTPS return route after onboarding).
 * Used by the native `appUrlOpen` handler to hand control back to the app.
 */
export function isStripeConnectReturnDeepLink(url: string): boolean {
  return String(url ?? "").startsWith(STRIPE_CONNECT_APP_SCHEME_URL);
}

/**
 * Register the native `appUrlOpen` listener (Capacitor App). When a
 * `lightningdispatch://stripe-connect-complete` deep link arrives, dispatch a
 * window event that the bank-link surfaces listen for. Web-safe no-op: returns
 * an inert handle outside the native shell so callers can always call `remove`.
 */
export function installStripeConnectReturnListener(onReturn?: () => void): { remove: () => void } {
  if (!Capacitor.isNativePlatform()) {
    return { remove: () => {} };
  }
  let listener: { remove: () => Promise<void> } | null = null;
  let removed = false;
  void App.addListener("appUrlOpen", ({ url }) => {
    if (removed || !isStripeConnectReturnDeepLink(url)) return;
    try {
      window.dispatchEvent(new Event(STRIPE_CONNECT_REFRESH_EVENT));
    } catch {
      // Event dispatch is best-effort; the caller's callback still runs.
    }
    onReturn?.();
  }).then((handle) => {
    if (removed) void handle.remove();
    else listener = handle;
  });
  return {
    remove: () => {
      removed = true;
      if (listener) void listener.remove();
    },
  };
}

/**
 * Open the onboarding URL. On native this launches a standalone browser
 * (SFSafariViewController) via `@capacitor/browser`; on web it navigates the
 * current tab. `native` is injectable for tests; defaults to the live platform.
 */
export async function openStripeConnectUrl(
  url: string,
  native: boolean = Capacitor.isNativePlatform(),
): Promise<void> {
  if (native) {
    await Browser.open({ url });
    return;
  }
  window.location.assign(url);
}
