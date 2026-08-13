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

export type PushSetupResult = { ok: true } | { ok: false; reason: PushSetupFailureReason };

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
      return "Your browser didn't allow the alert subscription. On iPhone: open Safari → Share → \"Add to Home Screen\", open the app from your home screen, then try again.";
    case "save_failed":
      return "The alert service couldn't save this device. Sign out and back in, then try again.";
  }
}

/** Register the SW at the ORIGIN ROOT (/sw.js — root scope). Returns null on
 *  failure (diagnosed as "sw_failed" by ensurePushSubscription). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
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
export async function saveSubscriptionToServer(sub: PushSubscription): Promise<boolean> {
  const res = await savePushSubscription({
    data: {
      endpoint: sub.endpoint,
      p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")!))),
      auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey("auth")!))),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 512) : undefined,
    },
  });
  return res.ok;
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
    return saved ? { ok: true } : { ok: false, reason: "save_failed" };
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

/** One-time "new job" confirmation strike via HTMLAudioElement (the rendered
 *  lightning-strike.mp3 asset) — used ONLY to preview the sound after the
 *  driver enables notifications. The in-app strike itself stays on the
 *  WebAudio synthesis (sound.ts) per the design spec. */
export function playStrikeAsset(): void {
  try {
    if (typeof Audio === "undefined") return;
    const a = new Audio("/sounds/lightning-strike.mp3");
    void a.play().catch(() => { /* muted/blocked — silent */ });
  } catch { /* silent */ }
}

/** Preload the strike asset so the first play has no fetch latency. */
export function preloadStrikeAsset(): void {
  try {
    if (typeof Audio === "undefined") return;
    const a = new Audio("/sounds/lightning-strike.mp3");
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
