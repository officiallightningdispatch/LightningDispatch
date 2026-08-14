// Focused regression suite for the 2026-08-13 push-incident fix: the OWNER'S
// EXACT alert MP3 is bundled under our origin, every notification-sound
// reference points at it, and the SW->page LD_PUSH_RECEIVED round-trip that
// was previously posted-into-the-void now has a client listener that plays
// it. Hermetic: no DB writes, no network (the MP3 is read from the local
// bundle — the byte hash below is the hash of the owner-supplied source URL
// captured at bundle time).
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ROOT = resolve(import.meta.dirname);

/* ------------------------------ 1. the bundled asset ------------------------------ */

const ALERT_PATH = resolve(ROOT, "public/sounds/alert.mp3");
const OWNER_MP3_SHA256 = "51b7b8fe3d2550bd8c1459213c720870e0fa90faf0850f41465d13037b7bfde5";
const OWNER_MP3_SIZE = 229041;

const asset = readFileSync(ALERT_PATH);
check("alert.mp3 exists and is non-empty", asset.length > 0);
check(`alert.mp3 size is the owner's exact file (${OWNER_MP3_SIZE})`, statSync(ALERT_PATH).size === OWNER_MP3_SIZE);
check("alert.mp3 sha256 == owner-supplied URL bytes (byte-identical bundle)", createHash("sha256").update(asset).digest("hex") === OWNER_MP3_SHA256);

// MPEG-1 Layer III frame header sanity: sync 0xFFE, layer 01 (Layer III),
// version 11 (MPEG1), bitrate index for 256kbps (0x0E), sample rate 44.1kHz.
// The file may start with an ID3 tag; scan to the first valid frame.
let off = 0;
if (asset.subarray(0, 3).toString("latin1") === "ID3") {
  const size =
    ((asset[6] & 0x7f) << 21) | ((asset[7] & 0x7f) << 14) | ((asset[8] & 0x7f) << 7) | (asset[9] & 0x7f);
  off = 10 + size;
}
const sync = (asset[off] << 8) | asset[off + 1];
check("first MPEG frame sync present (0xFFE)", (sync & 0xffe0) === 0xffe0, `sync=0x${sync.toString(16)}`);
const version = (asset[off + 1] >> 3) & 0x3;
const layer = (asset[off + 1] >> 1) & 0x3;
const brIdx = (asset[off + 2] >> 4) & 0x0f;
const srIdx = (asset[off + 2] >> 2) & 0x3;
check("MPEG1 layer III", version === 3 && layer === 1, `v=${version} l=${layer}`);
check("256 kbps", brIdx === 13, `brIdx=${brIdx}`);
check("44.1 kHz", srIdx === 0, `srIdx=${srIdx}`);

/* ------------------------------ 2. push payload sound URL ------------------------------ */

const { buildPushNotificationJson } = await import("./src/data/push-core.ts");
const { encryptPush } = await import("./src/data/webpush.ts");
const payload = { callId: "280999001", callRequestId: null, jobType: "Tow job", location: "Main St, 06606", etaMinutes: 9, jobUrl: "/driver" };
const notifJson = buildPushNotificationJson(payload);
check("payload sound = /sounds/alert.mp3 (Android notification plays the OWNER's exact MP3)", notifJson.sound === "/sounds/alert.mp3");
check("payload keeps the rest of spec A1 (including visible re-alert)", notifJson.title === "New job — Lightning Dispatch" && notifJson.body.includes("ETA ~9 min") && notifJson.tag === "job-280999001" && notifJson.data.url === "/driver" && notifJson.renotify === true);

/* ------------------------------ 3. service worker wiring ------------------------------ */

const sw = readFileSync(resolve(ROOT, "public/sw.js"), "utf8");
check("sw.js default sound = /sounds/alert.mp3", sw.includes('"/sounds/alert.mp3"'));
check("sw.js posts LD_PUSH_RECEIVED to open windows (round-trip sender)", sw.includes("LD_PUSH_RECEIVED"));
check("sw.js keeps the iOS-defensive minimal-option display", sw.includes("LD_IS_IOS"));

/* ------------------------------ 4. client listener (the missing half) ------------------------------ */

// Stub the browser surface BEFORE importing the client module.
const plays = [];
globalThis.Audio = class {
  preload = "";
  currentTime = 0;
  volume = 1;
  play() {
    plays.push("play");
    return Promise.resolve();
  }
  load() { /* noop */ }
};
globalThis.window = { location: { pathname: "/owner" } };
const swListeners = new Map();
globalThis.navigator = {
  serviceWorker: {
    addEventListener: (type, fn) => swListeners.set(type, fn),
    removeEventListener: (type) => swListeners.delete(type),
  },
};
const { installPushReceivedListener, alertRoleForPath, PUSH_RECEIVED_MESSAGE_TYPE } = await import("./src/lib/push-received.ts");
const unsub = installPushReceivedListener();
check("listener registers on navigator.serviceWorker 'message'", swListeners.has("message"));
check("LD_PUSH_RECEIVED on the owner portal plays the alert (role=owner)", (() => {
  swListeners.get("message")({ data: { type: PUSH_RECEIVED_MESSAGE_TYPE } });
  return plays.length === 1;
})());
check("non-push messages are ignored", (() => {
  swListeners.get("message")({ data: { type: "other" } });
  return plays.length === 1;
})());
check("driver portal maps to the driver role", alertRoleForPath("/driver") === "driver" && alertRoleForPath("/driver/active") === "driver");
check("owner/ops portals map to the owner role", alertRoleForPath("/owner") === "owner" && alertRoleForPath("/ops/queue") === "owner");
unsub();
check("unsubscribe removes the listener", !swListeners.has("message"));

/* ------------------------------ 5. root mount wiring ------------------------------ */

const root = readFileSync(resolve(ROOT, "src/routes/__root.tsx"), "utf8");
check("__root.tsx mounts the push-received bridge", root.includes("installPushReceivedListener") && root.includes("<PushReceivedSound />"));

/* ------------------------------ summary ------------------------------ */

const failed = checks.filter(([, ok]) => !ok);
console.log(`push-alert-asset.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
for (const [name, ok, extra] of checks) console.log(`  ${ok ? "ok" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
if (failed.length) process.exit(1);
console.log("cleanup: none (hermetic — no DB, no network)");
