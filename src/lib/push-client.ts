/**
 * Client-side Web Push plumbing (assigned-offer push, owner top priority
 * 2026-08-12; hard-fix + compliance 2026-08-13). Register the service worker,
 * ask permission, subscribe via PushManager (applicationServerKey = the
 * server's VAPID public key — fetched through the contractor-only server fn,
 * never hardcoded), and POST the subscription to the API (upsert — the server
 * replaces by endpoint UNIQUE, so a changed endpoint on re-subscribe is
 * handled by re-saving).
 *
 * 2026-08-13 fix: ensurePushSubscription() now RETURNS A DIAGNOSTIC RESULT
 * (ok | { reason }) instead of a bare boolean. Before this change the
 * permission card hid itself on ANY failure ("granted" but a failed save, a
 * refused VAPID-key fetch, a service-worker registration error, an iOS
 * subscribe rejection) — silently, with no retry — which is why ZERO
 * subscriptions ever landed in production. Every step now reports a
 * driver-readable reason and the caller (push-setup.tsx) keeps the card up
 * with the message + a Retry button.
 */
import {
  deletePushSubscription,
  getPushVapidPublicKey,
  listPushSubscriptions,
  savePushSubscription,
} from "~/data/push";

export const ASK_COUNTER_KEY = "ld-notify-asked-v1";
export const MAX_ASKS = 3;

export function notificationsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** True on iPhone/iPad/iPod — including iPadOS, which masquerades as a Mac
 *  (platform "MacIntel" + touch). iOS Safari only exposes the Web Push APIs
 *  AFTER the site is added to the Home Screen (iOS 16.4+), so callers branch
 *  on this to teach the install steps instead of declaring a fully-capable
 *  browser broken (owner-hit 2026-08-13: iPhone Safari dead-ended the
 *  compliance sheet with "can't receive alerts"). */
export function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Why this browser can't subscribe to push right now. "supported" means the
 *  APIs exist (go). "ios_not_installed" is a fully-capable iPhone/iPad stuck
 *  in a normal Safari tab — the caller teaches Add to Home Screen instead of
 *  dead-ending. "webview" is an in-app browser (Facebook/Instagram/iMessage)
 *  that can never receive push — the caller says "open in Safari/Chrome".
 *  "unsupported" is a genuinely old browser. */
export type NotificationSupportStatus = "supported" | "ios_not_installed" | "webview" | "unsupported";

export function notificationSupportStatus(): NotificationSupportStatus {
  if (notificationsSupported()) return "supported";
  if (isIOSDevice()) return "ios_not_installed";
  if (isInAppWebView()) return "webview";
  return "unsupported";
}

/** In-app browsers run a webview without ServiceWorker/push APIs; their UA
 *  usually carries the host app's token (FBAN/FBAV, Instagram, WeChat's
 *  MicroMessenger, …) or Android's "; wv)" marker. */
function isInAppWebView(): boolean {
  if (typeof navigator === "undefined") return false;
  const UA = navigator.userAgent;
  return (
    /(FBAN|FBAV|FB_IAB|FBSV|Instagram|MicroMessenger|KakaoTalk|Snapchat|Discord|TikTok|Pinterest|Electron)/i.test(UA) ||
    (/Android/i.test(UA) && /; wv\)/i.test(UA))
  );
}

/** How many times the permission card has been shown (for the 3-ask cap). */
export function asksRemaining(): number {
  try {
    const n = Number(localStorage.getItem(ASK_COUNTER_KEY) ?? "0");
    return Math.max(0, MAX_ASKS - (Number.isFinite(n) ? n : 0));
  } catch {
    return 0;
  }
}

export function recordAsk(): void {
  try {
    const n = Number(localStorage.getItem(ASK_COUNTER_KEY) ?? "0");
    localStorage.setItem(ASK_COUNTER_KEY, String((Number.isFinite(n) ? n : 0) + 1));
  } catch { /* best-effort */ }
}

/** base64url → Uint8Array (applicationServerKey expects raw bytes). */
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Why subscription setup failed (2026-08-13). The permission card surfaces
 * pushSetupFailureCopy(reason) so the driver sees a REAL error + retry instead
 * of the old silent hide (which is the root cause of 0 saved subscriptions).
 */
export type PushSetupFailureReason =
  | "unsupported"      // browser has no ServiceWorker/PushManager/Notification
  | "sw_failed"        // navigator.serviceWorker.register("/sw.js") threw
  | "not_granted"      // Notification.permission !== "granted"
  | "key_failed"       // the VAPID public key wasn't returned (role gate / outage)
  | "subscribe_failed" // pushManager.subscribe threw (iOS needs home-screen install)
  | "save_failed";     // the server refused the subscription (auth gate / validation)

export type PushSetupResult = { ok: true } | { ok: false; reason: PushSetupFailureReason; detail?: string };

/** Driver-readable copy for each failure reason (white-label, no backend
 *  jargon; iOS keeps its real limitation visible so the driver knows WHY). */
export function pushSetupFailureCopy(reason: PushSetupFailureReason): string {
  switch (reason) {
    case "unsupported":
      return "This browser can't receive job alerts. Use a recent version of Chrome, Safari, or Edge on your phone.";
    case "sw_failed":
      return "We couldn't set up the alert service on this browser. Refresh the page and try again.";
    case "not_granted":
      return "Notifications are blocked in your browser settings. Turn them on for Lightning Dispatch and try again.";
    case "key_failed":
      return "We couldn't reach the alert service. Check your connection and try again.";
    case "subscribe_failed":
      return "Your browser didn't allow the alert subscription. Try again — and on iPhone, make sure you opened Lightning Dispatch from the Home Screen icon (not Safari), then tap Allow.";
    case "save_failed":
      return "The alert service couldn't save this device. Sign out and back in, then try again.";
  }
}

/** Session flag: the one-time uncontrolled-page reload already ran (prevents a
 *  reload loop if the browser never grants control). */
const SW_HEAL_KEY = "ld-sw-healed-v1";

/** Register the SW at the ORIGIN ROOT (/sw.js — root scope). Returns null on
 *  failure (diagnosed as "sw_failed" by ensurePushSubscription).
 *
 *  Self-heal (2026-08-14, owner report: "no banner/sound"): browsers only
 *  deliver SW→page messages (the SW's LD_PUSH_RECEIVED postMessage) to pages
 *  the SW CONTROLS. A page that loaded before the SW activated/updated is
 *  uncontrolled, so the push round-trip silently dies — the phone got the push
 *  (Apple 201) but the open app never heard about it. After registering, if
 *  this page still has no controller, reload ONCE as soon as the new SW takes
 *  control, so the bridge works from this session forward. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    if (typeof navigator !== "undefined" && navigator.serviceWorker.controller === null) {
      try {
        if (!sessionStorage.getItem(SW_HEAL_KEY)) {
          sessionStorage.setItem(SW_HEAL_KEY, "1");
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => window.location.reload(),
            { once: true },
          );
        }
      } catch { /* storage blocked — skip self-heal, still return the reg */ }
    }
    await navigator.serviceWorker.ready;
    return reg;
  } catch {
    return null;
  }
}

async function currentSubscription(reg: ServiceWorkerRegistration): Promise<PushSubscription | null> {
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** Save (or replace) the given subscription through the contractor API. */
export async function saveSubscriptionToServer(sub: PushSubscription): Promise<{ ok: boolean; detail?: string }> {
  // Build the payload WITHOUT an undefined-valued userAgent prop (Seroval-safe:
  // an undefined property in the server-fn input can drop the whole POST in
  // some serializers — a silent save-loss on every browser that lacks a UA).
  const data: { endpoint: string; p256dh: string; auth: string; userAgent?: string } = {
    endpoint: sub.endpoint,
    p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")!))),
    auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey("auth")!))),
  };
  if (typeof navigator !== "undefined" && navigator.userAgent) data.userAgent = navigator.userAgent.slice(0, 512);
  try {
    const res = await savePushSubscription({ data });
    return res.ok ? { ok: true } : { ok: false, detail: res.error };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Subscribe with the server's VAPID key. Returns null on failure (the
 *  failure is diagnosed by ensurePushSubscription from the step that threw:
 *  "key_failed" when the key fetch is refused, "subscribe_failed" when the
 *  browser rejects PushManager.subscribe — iOS requires the site installed to
 *  the home screen, which throws a NotAllowedError here). */
export async function subscribeToPush(reg: ServiceWorkerRegistration): Promise<PushSubscription | null> {
  const existing = await currentSubscription(reg);
  if (existing) return existing;
  const keyRes = await getPushVapidPublicKey();
  if (!keyRes.ok) return null;
  return await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyRes.data) as BufferSource,
  });
}

/**
 * Ensure this browser is subscribed + registered: called after login and after
 * permission is granted. Idempotent — safe to call on every portal load.
 * 2026-08-13: returns a DIAGNOSTIC RESULT so the caller can surface the exact
 * failure and offer a retry (the old boolean hid every failure — 0 saved
 * subscriptions in production).
 */
export async function ensurePushSubscription(): Promise<PushSetupResult> {
  if (!notificationsSupported()) return { ok: false, reason: "unsupported" };
  const reg = await registerServiceWorker();
  if (!reg) return { ok: false, reason: "sw_failed" };
  try {
    if (Notification.permission !== "granted") return { ok: false, reason: "not_granted" };
    const sub = await subscribeToPush(reg);
    if (!sub) {
      // Distinguish a refused VAPID-key fetch from a rejected subscribe: retry
      // the key fetch — if it fails again it's a server-side key problem.
      const keyRes = await getPushVapidPublicKey();
      return { ok: false, reason: keyRes.ok ? "subscribe_failed" : "key_failed" };
    }
    const saved = await saveSubscriptionToServer(sub);
    return saved.ok ? { ok: true } : { ok: false, reason: "save_failed", detail: saved.detail };
  } catch {
    return { ok: false, reason: "subscribe_failed" };
  }
}

/** Remove this browser's subscription from the server (e.g. on sign-out). */
export async function removePushSubscription(): Promise<void> {
  if (!notificationsSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await deletePushSubscription({ data: { endpoint: sub.endpoint } });
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* best-effort */ }
}

/** One-time "new job" confirmation strike via HTMLAudioElement (the OWNER'S
 *  EXACT alert MP3 — public/sounds/alert.mp3) — used ONLY to preview the sound
 *  after the driver enables notifications and as the fallback in-app alert
 *  (push-received.ts). The in-app strike itself stays on the same asset per
 *  the owner's 2026-08-13 direction (one sound everywhere). */
export function playStrikeAsset(): void {
  try {
    if (typeof Audio === "undefined") return;
    const a = new Audio("/sounds/alert.mp3");
    void a.play().catch(() => { /* muted/blocked — silent */ });
  } catch { /* silent */ }
}

/** Preload the alert asset so the first play has no fetch latency. */
export function preloadStrikeAsset(): void {
  try {
    if (typeof Audio === "undefined") return;
    const a = new Audio("/sounds/alert.mp3");
    a.preload = "auto";
    a.volume = 0;
    void a.load();
  } catch { /* silent */ }
}

/** The currently saved server-side subscription (for the settings row). */
export async function hasServerSubscription(): Promise<boolean> {
  const res = await listPushSubscriptions();
  return res.ok && res.data.length > 0;
}

/** What THIS browser actually exposes for push, read straight from the APIs
 *  (2026-08-13, owner-directed): Notification.permission + whether
 *  PushManager and ServiceWorker are present — so a driver with notifications
 *  off in their browser/OS settings sees "Browser permission: denied" instead
 *  of a silent failure. "unsupported" permission = no Notification API. */
export type PushBrowserTruth = {
  permission: "granted" | "denied" | "default" | "unsupported";
  pushManager: boolean;
  serviceWorker: boolean;
};

export function pushBrowserTruth(): PushBrowserTruth {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return { permission: "unsupported", pushManager: false, serviceWorker: false };
  }
  return {
    permission: Notification.permission,
    pushManager: "PushManager" in window,
    serviceWorker: "serviceWorker" in navigator,
  };
}

/** Driver-readable one-liner for the permission part of the readout. */
export function pushPermissionCopy(permission: PushBrowserTruth["permission"]): string {
  switch (permission) {
    case "granted":
      return "Browser permission: granted";
    case "denied":
      return "Browser permission: denied — turn on notifications for Lightning Dispatch in your browser settings";
    case "default":
      return "Browser permission: not set yet — allow notifications to receive job alerts";
    case "unsupported":
      return "This browser can't receive push alerts";
  }
}


/* ------------------------- native (Capacitor) push ------------------------- */

/** True when the page is running inside the Lightning Dispatch native iOS/
 *  Android shell (Capacitor), where the Web Push APIs (service worker /
 *  PushManager) do not exist but the native push plugin does. SSR-safe: the
 *  dynamic import is only evaluated on the client. */
export async function isNativeShell(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export type NativePushFailureReason = "not_native" | "not_granted" | "register_failed" | "save_failed" | "error";

export type NativePushSetupResult =
  | { ok: true }
  | { ok: false; reason: NativePushFailureReason; detail?: string };

/** Driver-readable copy for each native (Capacitor) push failure reason. Unlike
 *  the old one-size-fits-all "Couldn't turn on alerts on this phone. Try again.",
 *  this names the actual failure so the owner's next physical-device tap shows
 *  exactly WHY it failed: permission denied vs APNs register failed vs server
 *  save refused vs a thrown error. `detail` (the APNs error string or the
 *  server's refusal message) is appended when present, so an entitlement or
 *  role-gate problem is visible on-device instead of buried. */
export function nativePushFailureCopy(reason: NativePushFailureReason, detail?: string): string {
  const base: Record<NativePushFailureReason, string> = {
    not_native: "This browser can't receive job alerts. Open Lightning Dispatch in the app to turn on alerts.",
    not_granted: "Notifications are off for Lightning Dispatch in your iPhone Settings. Turn them on, then come back and tap Allow.",
    register_failed: "We couldn't register this phone with Apple's alert service. Check your connection and tap Allow again.",
    save_failed: "We couldn't save this phone for alerts. Sign out and back in, then try again.",
    error: "Couldn't turn on alerts on this phone. Try again.",
  };
  const msg = base[reason];
  return detail ? `${msg} (${detail.slice(0, 180)})` : msg;
}

/* In-memory (per-launch) cache of the APNs device token. iOS does NOT re-invoke
 * didRegisterForRemoteNotificationsWithDeviceToken for an already-registered
 * device whose token is unchanged — a second register() returns immediately but
 * the "registration" event never re-fires, so re-registering on every tap would
 * hang for the full 10s timeout. We capture the token the FIRST time it arrives
 * (from any register() this launch) in a persistent listener and reuse it. This
 * is in-memory only — never persisted — per the "token re-fetched fresh every
 * launch, NEVER cached" rule (a fresh launch re-registers and re-captures). */
let cachedNativeToken: string | null = null;
let lastNativeRegistrationError: string | null = null;
let nativeTokenListenerPromise: Promise<void> | null = null;

/** Install (once per launch) a persistent "registration"/"registrationError"
 *  listener that stashes the APNs token the moment any register() produces one,
 *  so a later tap can reuse it instead of re-registering (see note above). */
function ensurePersistentNativeTokenListener(PushNotifications: {
  // The plugin's addListener is overloaded on literal event names; the
  // overloaded method is not assignable to a widened string signature, so type
  // it loosely here — we only ever call it with the literal "registration" and
  // "registrationError" events.
  addListener: any;
}): Promise<void> {
  if (!nativeTokenListenerPromise) {
    nativeTokenListenerPromise = (async () => {
      await PushNotifications.addListener("registration", (t: { value: string }) => {
        cachedNativeToken = t.value;
        lastNativeRegistrationError = null;
      });
      await PushNotifications.addListener("registrationError", (e: { error?: string }) => {
        lastNativeRegistrationError = typeof e?.error === "string" ? e.error : "APNs registration failed";
      });
    })();
  }
  return nativeTokenListenerPromise;
}

/** Request notification permission, register with APNs, capture the device
 *  token, and forward it to the server (upsert). The token is re-fetched fresh
 *  every launch — NEVER cached (in-memory reuse only within a launch; see the
 *  cache note above). Idempotent and safe to call on every load.
 *  Returns a diagnostic result so the caller can surface a real error + retry.
 *
 *  `prompt` (default true) controls whether a not-yet-granted permission is
 *  requested here. The boot-time caller passes `prompt:false` so the app launch
 *  NEVER fires the iOS permission dialog out from under the user — the prompt is
 *  reserved for the explicit "Allow notifications" tap (which calls with the
 *  default). Boot still silently re-registers when permission is ALREADY granted. */
export async function ensureNativePushRegistration(options: { prompt?: boolean } = {}): Promise<NativePushSetupResult> {
  if (typeof window === "undefined") return { ok: false, reason: "not_native" };
  let Capacitor, PushNotifications, saveNativePushToken;
  try {
    ({ Capacitor } = await import("@capacitor/core"));
    ({ PushNotifications } = await import("@capacitor/push-notifications"));
    ({ saveNativePushToken } = await import("~/data/push"));
  } catch {
    return { ok: false, reason: "not_native" };
  }
  if (!Capacitor.isNativePlatform()) return { ok: false, reason: "not_native" };
  try {
    // Install the persistent token listener FIRST — before any permission
    // await — so a token issued by ANY register() this launch (including the
    // boot-time NativeContractorStatus path) lands in the cache.
    await ensurePersistentNativeTokenListener(PushNotifications);

    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== "granted") {
      if (!options.prompt) return { ok: false, reason: "not_granted" };
      perm = await PushNotifications.requestPermissions();
      if (perm.receive !== "granted") return { ok: false, reason: "not_granted" };
    }

    // Reuse the already-captured token (idempotent save) instead of re-registering
    // — the second register() would never re-emit the token on iOS.
    if (cachedNativeToken) {
      const saved = await saveNativePushToken({ data: { token: cachedNativeToken } });
      return saved.ok ? { ok: true } : { ok: false, reason: "save_failed", detail: saved.error };
    }

    // First registration this launch: register() and wait for the persistent
    // listener to capture the token (the plugin's register() resolves before the
    // token arrives). Resolve immediately on a terminal registrationError; fail
    // closed at 10s otherwise.
    await PushNotifications.register();
    const token = await new Promise<string | null>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (cachedNativeToken) { clearInterval(poll); resolve(cachedNativeToken); }
        else if (lastNativeRegistrationError) { clearInterval(poll); resolve(null); }
        else if (Date.now() - started >= 10000) { clearInterval(poll); resolve(null); }
      }, 50);
    });
    if (!token) {
      return { ok: false, reason: "register_failed", detail: lastNativeRegistrationError ?? "Timed out waiting for Apple to issue a device token." };
    }
    const saved = await saveNativePushToken({ data: { token } });
    return saved.ok ? { ok: true } : { ok: false, reason: "save_failed", detail: saved.error };
  } catch (err) {
    return { ok: false, reason: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}
