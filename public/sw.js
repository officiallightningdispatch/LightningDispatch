/* Lightning Dispatch — assigned-offer push service worker (owner top priority
 * 2026-08-12). Registered from the contractor portal at /sw.js (static file,
 * scope = origin root). Two handlers:
 *
 *  push  — the server sends an encrypted RFC 8291 payload whose JSON carries
 *          { title, body, tag, data:{url}, icon, badge, sound, renotify }
 *          (built by push-core buildPushNotificationJson — spec A1 verbatim).
 *          showNotification with a single-burst vibrate [200]. The OS decides
 *          how much of `sound`/`vibrate` it honours: Android Chrome plays the
 *          sound once per push — the ~5 s THUNDER STORM (owner-directed
 *          2026-08-13: /sounds/lightning-strike.mp3 re-rendered full-scale,
 *          ~-0.5 dBFS, by scripts/generate-strike.mjs — loud in a cab), iOS
 *          Safari ignores custom sound — the in-app WebAudio strike (sound.ts)
 *          is the reliable sound path when the app is open.
 *          tag 'job-<callId>' replaces stale notifications for the same job.
 *
 *  notificationclick — focus an existing app tab, else open data.url ("/driver"
 *          — the Home sheet shows the primary job front-and-center).
 *
 *  iOS-defensive display (2026-08-13, root-caused: Apple accepted every push
 *  (HTTP 201) but the banner NEVER appeared on the owner's iPhone — iOS WebKit
 *  silently DROPS web-push notifications whose options include unsupported
 *  keys (custom `sound`, `vibrate`, `badge`, `renotify`). Fix: detect iOS here
 *  and show a MINIMAL option set (title/body/tag/data/icon only); keep the
 *  full set incl. loud strike on Android. Also ping open app windows with an
 *  "LD_PUSH_RECEIVED" message so the in-app strike plays for self-tests even
 *  though iOS never shows a banner for the foreground app. */
const LD_UA = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
const LD_IS_IOS = /iPhone|iPad|iPod/i.test(LD_UA) ||
  (/Macintosh|Mac OS X/i.test(LD_UA) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);

async function ldNotifyClients(payload) {
  try {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clientsList) {
      try {
        c.postMessage({ type: "LD_PUSH_RECEIVED", tag: payload.tag, title: payload.title, body: payload.body });
      } catch {}
    }
  } catch {}
}

self.addEventListener("push", (event) => {
  let data = { title: "New job — Lightning Dispatch", body: "A new job landed in your queue.", tag: "new-assignment", data: { url: "/driver" } };
  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        data = {
          title: typeof parsed.title === "string" && parsed.title ? parsed.title : data.title,
          body: typeof parsed.body === "string" && parsed.body ? parsed.body : data.body,
          tag: typeof parsed.tag === "string" && parsed.tag ? parsed.tag : data.tag,
          data: parsed.data && typeof parsed.data === "object" && typeof parsed.data.url === "string" ? { url: parsed.data.url } : { url: "/driver" },
          icon: typeof parsed.icon === "string" ? parsed.icon : "/favicon.svg",
          badge: typeof parsed.badge === "string" ? parsed.badge : "/favicon.svg",
          sound: typeof parsed.sound === "string" && parsed.sound ? parsed.sound : "/sounds/lightning-strike.mp3",
          renotify: false,
        };
      }
    } catch {
      /* fall back to the defaults above — never crash the push handler */
    }
  }
  event.waitUntil(
    (async () => {
      try {
        await ldNotifyClients(data);
        const opts = { body: data.body, tag: data.tag, data: data.data, icon: data.icon };
        if (!LD_IS_IOS) {
          opts.badge = data.badge;
          opts.sound = data.sound;
          opts.renotify = data.renotify;
          opts.vibrate = [200]; // ONE single sharp burst — the lightning strike
        }
        await self.registration.showNotification(data.title, opts);
      } catch {
        // Last resort: bare title+body — never let one bad option swallow the banner.
        try {
          await self.registration.showNotification(data.title, { body: data.body, tag: data.tag, data: data.data });
        } catch {}
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && typeof event.notification.data.url === "string"
    ? event.notification.data.url
    : "/driver";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        // Reuse an existing app tab (any page) and navigate it to the job route.
        if ("focus" in client && client.focus) {
          await client.focus();
          if ("navigate" in client && client.navigate) await client.navigate(url).catch(() => {});
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
