import { describe, test, expect, beforeEach, mock } from "bun:test";

// Hermetic tests for Stripe Connect bank-link return routing (2026-09-04 fix):
// return/refresh URL construction + native-vs-web open path + deep-link
// recognition. No database, no device, no network — @capacitor plugins are
// mocked so the module's logic is exercised in isolation.

const state = {
  native: false,
  browserOpened: [],
  browserError: null,
  appUrlListeners: [],
  assignedUrl: null,
};

mock.module("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => state.native, getPlatform: () => (state.native ? "ios" : "web") },
}));
mock.module("@capacitor/browser", () => ({
  Browser: {
    open: async ({ url }) => {
      if (state.browserError) throw state.browserError;
      state.browserOpened.push(url);
    },
  },
}));
mock.module("@capacitor/app", () => ({
  App: {
    addListener: async (event, cb) => {
      state.appUrlListeners.push({ event, cb });
      return { remove: async () => {} };
    },
  },
}));

globalThis.window = {
  location: { assign: (url) => { state.assignedUrl = url; } },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};

const linking = await import("./src/lib/stripe-connect-linking.ts");

beforeEach(() => {
  state.native = false;
  state.browserOpened = [];
  state.browserError = null;
  state.appUrlListeners = [];
  state.assignedUrl = null;
});

describe("stripe-connect-linking", () => {
  test("buildStripeConnectReturnUrl uses origin + public path (never a custom scheme)", () => {
    expect(linking.buildStripeConnectReturnUrl("https://909fd9d2fde94962cd798bdcbee436ba.ctonew.app"))
      .toBe("https://909fd9d2fde94962cd798bdcbee436ba.ctonew.app/stripe-connect-complete");
    expect(linking.buildStripeConnectReturnUrl("https://www.lightningdispatch.app/"))
      .toBe("https://www.lightningdispatch.app/stripe-connect-complete");
    expect(linking.buildStripeConnectReturnUrl("")).toBe("/stripe-connect-complete");
    expect(linking.buildStripeConnectReturnUrl("https://x/")).not.toContain("lightningdispatch://");
  });

  test("return URL is HTTPS-qualified on the native shell origin (Stripe requires HTTPS)", () => {
    const url = linking.buildStripeConnectReturnUrl("https://909fd9d2fde94962cd798bdcbee436ba.ctonew.app");
    expect(url.startsWith("https://")).toBe(true);
    expect(url.endsWith(linking.STRIPE_CONNECT_COMPLETE_PATH)).toBe(true);
  });

  test("openStripeConnectUrl on web assigns the URL to the current window", async () => {
    await linking.openStripeConnectUrl("https://connect.stripe.com/setup/s/qa-link", false);
    expect(state.assignedUrl).toBe("https://connect.stripe.com/setup/s/qa-link");
    expect(state.browserOpened).toHaveLength(0);
  });

  test("openStripeConnectUrl on native opens a standalone browser (SFSafariViewController)", async () => {
    await linking.openStripeConnectUrl("https://connect.stripe.com/setup/s/qa-link", true);
    expect(state.browserOpened).toEqual(["https://connect.stripe.com/setup/s/qa-link"]);
    expect(state.assignedUrl).toBeNull();
  });

  test("openStripeConnectUrl on native propagates Browser failures to the caller", async () => {
    state.browserError = new Error("browser unavailable");
    await expect(linking.openStripeConnectUrl("https://connect.stripe.com/setup/s/qa-link", true)).rejects.toThrow("browser unavailable");
  });

  test("isStripeConnectReturnDeepLink matches the app scheme and ignores others", () => {
    expect(linking.isStripeConnectReturnDeepLink("lightningdispatch://stripe-connect-complete")).toBe(true);
    expect(linking.isStripeConnectReturnDeepLink("lightningdispatch://stripe-connect-complete?x=1")).toBe(true);
    expect(linking.isStripeConnectReturnDeepLink("https://example.com/stripe-connect-complete")).toBe(false);
    expect(linking.isStripeConnectReturnDeepLink("")).toBe(false);
    expect(linking.isStripeConnectReturnDeepLink(null)).toBe(false);
  });

  test("installStripeConnectReturnListener is a no-op on web", () => {
    const handle = linking.installStripeConnectReturnListener(() => {
      throw new Error("must not fire on web");
    });
    expect(handle.remove).toBeTypeOf("function");
    expect(state.appUrlListeners).toHaveLength(0);
  });

  test("installStripeConnectReturnListener fires on the app scheme on native", async () => {
    state.native = true;
    let fired = 0;
    const handle = linking.installStripeConnectReturnListener(() => { fired += 1; });
    await Promise.resolve(); // let the .then() attach register the listener
    expect(state.appUrlListeners).toHaveLength(1);
    // Non-matching URL is ignored.
    state.appUrlListeners[0].cb({ url: "https://example.com/other" });
    expect(fired).toBe(0);
    // Matching deep link fires the callback exactly once.
    state.appUrlListeners[0].cb({ url: "lightningdispatch://stripe-connect-complete" });
    expect(fired).toBe(1);
    handle.remove();
  });
});
