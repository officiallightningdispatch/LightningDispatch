/**
 * SW → page push-received bridge (2026-08-13, owner report: "notifications
 * still not working"). The service worker (public/sw.js) posts
 * `LD_PUSH_RECEIVED` to every open window client on EVERY delivered push. This
 * module is the MISSING client half of that round-trip: without a "message"
 * listener the push is delivered (Apple HTTP 201 — proven in production audit
 * rows) but the app never reacts, and on iOS Safari the system banner is
 * suppressed while the app is in the foreground by design — so the owner's
 * open iPhone did nothing at all.
 *
 * On receipt we play the OWNER'S EXACT alert MP3 in-app (sound.ts
 * playAlertSound, respects the per-role mute + the synthesized fallback when
 * autoplay is blocked). The in-app banner itself still comes from the queue
 * poll (DriverNotificationBanners / OwnerNotificationLayer), so there is no
 * duplicate banner; the sound is what was missing.
 *
 * CLIENT-GRAPH SAFE: imports only ~/lib/sound (client module). Guards every
 * DOM/API access so the module is also importable under bun for the focused
 * test (push-alert-asset.test.mjs).
 */

import { playAlertSound, type SoundRole } from "~/lib/sound";

export const PUSH_RECEIVED_MESSAGE_TYPE = "LD_PUSH_RECEIVED";

/** The role whose mute setting governs the alert, inferred from the current
 *  portal path: /owner and /ops are the owner-side portals; everything else
 *  (incl. /driver) is driver-side. Re-evaluated per message so the mute
 *  follows the portal the user is actually looking at. */
export function alertRoleForPath(path: string): SoundRole {
  return /^\/(owner|ops)(\/|$)/.test(path) ? "owner" : "driver";
}

/** Register the SW message listener. Returns an unsubscribe function.
 *  Idempotent per caller (the mount point calls it once). Never throws. */
export function installPushReceivedListener(): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => {};
  }
  const onMessage = (ev: MessageEvent) => {
    const data = ev.data as { type?: unknown } | null | undefined;
    if (!data || data.type !== PUSH_RECEIVED_MESSAGE_TYPE) return;
    let path = "/driver";
    try {
      if (typeof window !== "undefined") path = window.location.pathname;
    } catch { /* keep the default */ }
    playAlertSound(alertRoleForPath(path));
  };
  try {
    navigator.serviceWorker.addEventListener("message", onMessage);
  } catch {
    return () => {};
  }
  return () => {
    try {
      navigator.serviceWorker.removeEventListener("message", onMessage);
    } catch { /* already gone */ }
  };
}
