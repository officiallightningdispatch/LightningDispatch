/**
 * Client-side Web Push plumbing (assigned-offer push, owner top priority
 * 2026-08-12). Register the service worker, ask permission, subscribe via
 * PushManager (applicationServerKey = the server's VAPID public key — fetched
 * through the contractor-only server fn, never hardcoded), and POST the
 * subscription to the API (upsert — the server replaces by endpoint UNIQUE, so
 * a changed endpoint on re-subscribe is handled by re-saving).
 *
 * All entry points are best-effort and silent: permission denied, unsupported
 * browsers, or a failed save never block the portal — the in-app banner +
 * WebAudio strike (sound.ts) are the primary sound path; the OS push is the
 * background path.
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

/** Subscribe with the server's VAPID key; never throws. */
export async function subscribeToPush(reg: ServiceWorkerRegistration): Promise<PushSubscription | null> {
  try {
    const existing = await currentSubscription(reg);
    if (existing) return existing;
    const keyRes = await getPushVapidPublicKey();
    if (!keyRes.ok) return null;
    return await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyRes.data),
    });
  } catch {
    return null;
  }
}

/**
 * Ensure this browser is subscribed + registered: called after login and after
 * permission is granted. Idempotent — safe to call on every portal load.
 * Returns true when a subscription is active and saved.
 */
export async function ensurePushSubscription(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  const reg = await registerServiceWorker();
  if (!reg) return false;
  try {
    if (Notification.permission !== "granted") return false;
    const sub = await subscribeToPush(reg);
    if (!sub) return false;
    return await saveSubscriptionToServer(sub);
  } catch {
    return false;
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
