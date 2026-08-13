/* Lightning Dispatch — assigned-offer push service worker (owner top priority
 * 2026-08-12). Registered from the contractor portal at /sw.js (static file,
 * scope = origin root). Two handlers:
 *
 *  push  — the server sends an encrypted RFC 8291 payload whose JSON carries
 *          { title, body, tag, data:{url}, icon, badge, sound, renotify }
 *          (built by push-core buildPushNotificationJson — spec A1 verbatim).
 *          showNotification with ONE single-burst vibrate [200] — the single
 *          lightning strike. The OS decides how much of `sound`/`vibrate` it
 *          honours: Android Chrome plays its own default once (still exactly
 *          one strike), iOS Safari ignores custom sound — the in-app WebAudio 
 *          LOUDNESS (owner-directed 2026-08-13): /sounds/lightning-strike.mp3
 *          was re-rendered to 98% full scale (scripts/generate-strike.mjs) and
 *          the WebAudio gains raised — the strike is unmistakable in a cab.
 *          strike (sound.ts) is the reliable sound path when the app is open.
 *          tag 'job-<callId>' replaces stale notifications for the same job.
 *
 *  notificationclick — focus an existing app tab, else open data.url ("/driver"
 *          — the Home sheet shows the primary job front-and-center). */
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
          sound: typeof parsed.sound === "string" ? parsed.sound : "lightning-strike.mp3",
          renotify: false,
        };
      }
    } catch {
      /* fall back to the defaults above — never crash the push handler */
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      data: data.data,
      icon: data.icon,
      badge: data.badge,
      sound: data.sound,
      renotify: data.renotify,
      vibrate: [200], // ONE single sharp burst — the lightning strike
    }),
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
