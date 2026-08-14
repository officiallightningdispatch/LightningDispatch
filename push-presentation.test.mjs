// Focused regression suite for the 2026-08-14 notification-presentation
// incident (owner: "everything works except the notification banner and
// sound" — the server delivered every push, Apple 201, but the open app showed
// nothing). This suite pins the FULL CLIENT PRESENTATION CHAIN that a phone
// exercises after delivery, in isolation:
//
//   SW receives  → sw.js push handler (sandbox-run against the ACTUAL live
//                  sw.js bytes) posts LD_PUSH_RECEIVED to window clients and
//                  calls showNotification (full options on Android, minimal on
//                  iOS) + carries the LD_SW_VERSION stamp that forces phones
//                  off a stale SW revision.
//   window/listener runs → push-received bridge (installPushReceivedListener)
//                  plays the alert through sound.ts.
//   audio plays   → playAlertSound uses the OWNER'S EXACT /sounds/alert.mp3,
//                  respects the per-role mute, falls back to the synthesized
//                  strike when play() is rejected, and — when the autoplay
//                  policy blocks the FIRST alert after launch — replays it on
//                  the next user gesture (pending-strike).
//   controlled page → registerServiceWorker self-heals an uncontrolled page
//                  (one-time reload on controllerchange) so SW→page messages
//                  can arrive at all.
//
// Hermetic: no DB, no network, no real push. The sw.js sandbox runs the file
// from public/ with mocked self/clients/registration.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ROOT = resolve(import.meta.dirname);

/* ============================ 1. sw.js sandbox ============================ */
const swSrc = readFileSync(resolve(ROOT, "public/sw.js"), "utf8");
check("sw.js carries the LD_SW_VERSION stamp (forces phones off stale SW bytes)", /LD_SW_VERSION\s*=\s*"2\d{3}-\d{2}-\d{2}\.\d+"/.test(swSrc));
check("sw.js still posts LD_PUSH_RECEIVED to window clients", swSrc.includes("LD_PUSH_RECEIVED"));
check("sw.js still points its default sound at /sounds/alert.mp3", swSrc.includes('"/sounds/alert.mp3"'));

/** Run the actual sw.js source in a sandboxed worker-like scope. */
function runSw(userAgent, maxTouchPoints = 0) {
  const listeners = {};
  const posted = [];
  const shown = [];
  const self = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => {},
    clients: {
      matchAll: async () => [{ postMessage: (m) => posted.push(m) }],
    },
    registration: {
      showNotification: async (title, opts) => { shown.push({ title, opts }); },
    },
  };
  const nav = { userAgent, maxTouchPoints };
  const fn = new Function("self", "navigator", swSrc);
  fn(self, nav);
  return { listeners, posted, shown };
}

function firePush(sw, payload) {
  return new Promise((resolve2, reject2) => {
    const ev = {
      waitUntil: (p) => p.then(() => resolve2(), (e) => reject2(e)),
      data: { json: () => payload },
    };
    sw.listeners.push(ev);
  });
}

const PAYLOAD = {
  title: "New job — Lightning Dispatch",
  body: "Tow job · Main St, 06606 · ETA ~9 min",
  tag: "job-280999001",
  data: { url: "/driver" },
  icon: "/favicon.svg",
  badge: "/favicon.svg",
  sound: "/sounds/alert.mp3",
  renotify: false,
};

const android = runSw("Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36");
await firePush(android, PAYLOAD);
check("SW (Android) posts LD_PUSH_RECEIVED to every open window", android.posted.length === 1 && android.posted[0].type === "LD_PUSH_RECEIVED" && android.posted[0].tag === "job-280999001" && android.posted[0].title === PAYLOAD.title && android.posted[0].body === PAYLOAD.body);
check("SW (Android) shows the OS notification with FULL options", android.shown.length === 1 && android.shown[0].title === PAYLOAD.title && android.shown[0].opts.tag === "job-280999001" && android.shown[0].opts.sound === "/sounds/alert.mp3" && android.shown[0].opts.vibrate?.[0] === 200 && android.shown[0].opts.renotify === false && android.shown[0].opts.data.url === "/driver", JSON.stringify(android.shown));

const ios = runSw("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148");
await firePush(ios, PAYLOAD);
check("SW (iOS) still posts LD_PUSH_RECEIVED (in-app sound path)", ios.posted.length === 1 && ios.posted[0].type === "LD_PUSH_RECEIVED");
check("SW (iOS) shows the OS banner with MINIMAL options (unsupported keys drop the whole banner)", ios.shown.length === 1 && ios.shown[0].opts.sound === undefined && ios.shown[0].opts.vibrate === undefined && ios.shown[0].opts.badge === undefined && ios.shown[0].opts.renotify === undefined && ios.shown[0].opts.tag === "job-280999001", JSON.stringify(ios.shown));

const iosDesktop = runSw("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", 5);
await firePush(iosDesktop, PAYLOAD);
check("SW treats iPadOS-style touch-Macs as iOS (minimal banner options)", iosDesktop.shown[0]?.opts.sound === undefined);

/* ==================== 2. sound.ts — the audio leg ==================== */
const audioPlays = [];
let audioReject = false;
globalThis.Audio = class {
  constructor(src) { this.src = src; audioPlays.push(["new", src]); }
  set preload(_v) {}
  set volume(_v) {}
  get volume() { return 1; }
  set currentTime(_t) {}
  get currentTime() { return 0; }
  play() { audioPlays.push(["play"]); return audioReject ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve(); }
  load() {}
};

let ctxState = "running";
let resumeRejects = false;
let started = 0;
globalThis.AudioContext = class {
  // state is a live getter: sound.ts caches ONE context for the process, so
  // flipping ctxState between tests must be reflected by the cached instance.
  get state() { return ctxState; }
  get currentTime() { return 0; }
  get destination() { return {}; }
  resume() {
    if (resumeRejects) return Promise.reject(new Error("blocked"));
    ctxState = "running";
    return Promise.resolve();
  }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  createDynamicsCompressor() { return { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect() {} }; }
  createBuffer() { return { getChannelData() { return new Float32Array(32); } }; }
  createBufferSource() { return { buffer: null, loop: false, connect() {}, start() { started++; }, stop() {}, onended: null }; }
  createBiquadFilter() { return { type: "", frequency: { value: 0 }, Q: { value: 0 }, connect() {} }; }
  createOscillator() { return { type: "", frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() { started++; }, stop() {}, onended: null }; }
};

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.window = {
  location: { pathname: "/driver" },
  AudioContext: globalThis.AudioContext,
  webkitAudioContext: globalThis.AudioContext,
};

const { playAlertSound, playLightning, primeAudio, setSoundMuted } = await import("./src/lib/sound.ts");

// playAlertSound/primeAudio resolve their fallbacks on MICROTASKS (play().catch
// → playLightning, resume().then → firePendingStrike) — flush between act and
// assert so the synthesized/pending paths have run.
const flush = () => new Promise((r) => setTimeout(r, 0));

audioPlays.length = 0; started = 0;
playAlertSound("driver"); await flush();
check("playAlertSound plays the OWNER'S EXACT MP3 (/sounds/alert.mp3) with currentTime reset", audioPlays.length === 2 && audioPlays[0][0] === "new" && audioPlays[0][1] === "/sounds/alert.mp3" && audioPlays[1][0] === "play", JSON.stringify(audioPlays));
check("MP3 happy path does not need the synthesized fallback", started === 0);

// Mute gate: driver muted → nothing plays, no Audio constructed.
storage.set("ld-sound-driver", "1");
const before = audioPlays.length;
playAlertSound("driver");
playLightning("driver");
await flush();
check("muted driver → playAlertSound and playLightning are silent no-ops", audioPlays.length === before && started === 0);
storage.delete("ld-sound-driver");

// play() rejected (autoplay policy) → synthesized strike fallback when the
// AudioContext is running (already primed by an earlier user gesture).
audioReject = true; ctxState = "running"; started = 0;
playAlertSound("driver"); await flush();
check("play() rejection falls back to the synthesized strike when the context is running", started === 2, `started=${started}`);
audioReject = false;

// The FIRST alert after launch with NO prior gesture: play() rejects AND the
// context is suspended → both legs blocked → pending strike replays on the
// next user gesture (primeAudio). This is the silent-first-alert gap.
audioReject = true; ctxState = "suspended"; resumeRejects = true; started = 0;
playAlertSound("driver"); await flush();
check("blocked alert (play rejected + context suspended) still never throws", true);
check("no sound while blocked (banner-only)", started === 0);
primeAudio(); await flush(); // gesture #1 while still blocked — resume rejects
check("blocked gesture keeps the context unprimed and silent", started === 0);
ctxState = "running"; resumeRejects = false; // OS now allows audio (user unlocked)
primeAudio(); await flush(); // gesture #2 — context runs → the pending strike replays
check("pending strike replays on the next unlockable user gesture", started === 2, `started=${started}`);
audioReject = false;

// Muting while a strike is pending cancels the replay.
audioReject = true; ctxState = "suspended"; resumeRejects = true; started = 0;
playAlertSound("driver"); await flush();
setSoundMuted("driver", true); // pending cleared by mute
ctxState = "running"; resumeRejects = false;
primeAudio(); await flush();
check("muting clears a pending strike (no replay on the next gesture)", started === 0);
setSoundMuted("driver", false);
audioReject = false;

/* ==================== 3. push-received bridge ==================== */
const swListeners = new Map();
globalThis.navigator = {
  serviceWorker: {
    addEventListener: (t, fn) => swListeners.set(t, fn),
    removeEventListener: (t) => swListeners.delete(t),
  },
};
const { installPushReceivedListener, alertRoleForPath, PUSH_RECEIVED_MESSAGE_TYPE } = await import("./src/lib/push-received.ts");
const unsub = installPushReceivedListener();
const before3 = audioPlays.length;
swListeners.get("message")({ data: { type: PUSH_RECEIVED_MESSAGE_TYPE, tag: "self-test-1", title: "t", body: "b" } });
check("LD_PUSH_RECEIVED on the DRIVER portal plays the alert (cached Audio element re-plays)", audioPlays.length === before3 + 1 && audioPlays.at(-1)[0] === "play", JSON.stringify(audioPlays.slice(before3)));
swListeners.get("message")({ data: { type: "something-else" } });
check("non-push SW messages are ignored", audioPlays.length === before3 + 1);
check("role mapping: /driver → driver, /ops → owner", alertRoleForPath("/driver") === "driver" && alertRoleForPath("/ops/queue") === "owner");
unsub();
check("unsubscribe removes the bridge listener", !swListeners.has("message"));

/* ============ 4. registerServiceWorker — controlled-page self-heal ============ */
const healListeners = {};
let healCount = 0;
let reloads = 0;
const session = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (session.has(k) ? session.get(k) : null),
  setItem: (k, v) => session.set(k, String(v)),
};
globalThis.navigator = {
  serviceWorker: {
    controller: null,
    addEventListener: (t, fn) => { healListeners[t] = fn; healCount++; },
    register: async () => ({ active: true }),
    ready: Promise.resolve({}),
  },
  userAgent: "bun-test",
};
globalThis.window = { location: { reload: () => { reloads++; } } };
const { registerServiceWorker } = await import("./src/lib/push-client.ts");
await registerServiceWorker();
check("uncontrolled page → one-time controllerchange self-heal listener registered", typeof healListeners.controllerchange === "function" && healCount === 1);
check("self-heal session flag set (no reload loop)", session.get("ld-sw-healed-v1") === "1");
await registerServiceWorker(); // second registration in the same session
check("second registration does not stack another heal listener", healCount === 1);
healListeners.controllerchange();
check("controllerchange fires exactly ONE reload", reloads === 1);
// Controlled page → no heal needed.
globalThis.navigator.serviceWorker.controller = { state: "activated" };
healCount = 0;
await registerServiceWorker();
check("already-controlled page adds no heal listener", healCount === 0);

/* ============================ summary ============================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`push-presentation.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
for (const [name, ok, extra] of checks) console.log(`  ${ok ? "ok" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
if (failed.length) process.exit(1);
console.log("cleanup: none (hermetic — no DB, no network, no real push)");
