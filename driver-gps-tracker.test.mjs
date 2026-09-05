// Hermetic fixture for the driver-gps-tracker queued-fix flush path
// (2026-08-22, GPS-reliability hardening). The tracker now keeps a `queuedFixes`
// ARRAY (cap + shift-oldest) and flushes it on app-active/visibility-visible/
// online events so a driver whose app session was briefly offline still delivers
// every real fix (with its ORIGINAL capturedAt preserved) once the connection
// returns. No database, no network, no React tree: browser globals are stubbed
// and the two tracker dependencies are module-mocked (bun:test `mock.module`
// works in a plain script), then the exported `subscribe` seam drives the web
// path. Run (plain script, like the other hermetic suites):
//   bun driver-gps-tracker.test.mjs
import { mock } from "bun:test";
import assert from "node:assert/strict";

const state = { fail: true, pings: [] };
let watchCb = null;
let captureCb = null;
const windowListeners = {};
const documentListeners = {};

mock.module("./src/lib/native-capabilities.ts", () => ({
  isNative: () => false,
  getLocation: async () => { throw new Error("not used by the web tracker path"); },
  onNativeAppState: () => ({ remove: async () => {} }),
  startLocationUpdates: async () => "watch-1",
  startMotionAssistedCapture: async () => ({ stop: async () => {} }),
  stopLocation: async () => {},
}));
mock.module("./src/data/driver-gps.ts", () => ({
  pingDriverLocation: async ({ data }) => {
    state.pings.push(data);
    if (state.fail) throw new Error("offline");
    return { ok: true };
  },
}));

globalThis.navigator = {
  geolocation: {
    watchPosition: (cb) => { watchCb = cb; return 1; },
    clearWatch: () => {},
    getCurrentPosition: (cb) => { captureCb = cb; },
  },
};
globalThis.window = {
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: (type, cb) => { windowListeners[type] = cb; },
  removeEventListener: (type) => { delete windowListeners[type]; },
};
globalThis.document = {
  visibilityState: "visible",
  addEventListener: (type, cb) => { documentListeners[type] = cb; },
  removeEventListener: (type) => { delete documentListeners[type]; },
};

const tracker = await import("./src/components/driver-gps-tracker.tsx");

const pos = (lat, ts) => ({ coords: { latitude: lat, longitude: -73.2, accuracy: 10, speed: 0 }, timestamp: ts });
const tick = () => new Promise((r) => setTimeout(r, 0));

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };
const reset = () => { state.fail = true; state.pings = []; watchCb = null; captureCb = null; };

/* 1. A fix captured while offline is flushed on the online event with its
   original capturedAt preserved (delayed upload never masquerades as fresh). */
{
  reset();
  const unsub = tracker.subscribe(() => {});
  assert.ok(typeof watchCb === "function", "web watch callback registered");
  const ts = Date.now() - 1000;
  watchCb(pos(41.1, ts)); // capture → upload fails → fix queued + retry scheduled
  await tick();
  ok(state.pings.length === 1, "offline upload attempted once and failed");
  ok(state.pings[0].capturedAt === ts, "first attempt keeps original capture time");

  state.fail = false; // connection returns
  windowListeners.online();
  await tick();
  ok(state.pings.length === 2, "online event flushes the queued fix");
  ok(state.pings[1].capturedAt === ts, "delivered fix preserves capturedAt (not faked fresh)");
  ok(state.pings[1].latitude === 41.1, "delivered fix has the real coordinates");
  ok(state.pings[1].jobTowbookId === null, "job association stays best-effort null");
  unsub();
}

/* 2. Multiple fixes queued during an outage are ALL delivered once the
   connection returns — the old single `queuedFix` would have dropped all but
   the most recent. */
{
  reset();
  const unsub = tracker.subscribe(() => {});
  const ts1 = Date.now() - 2000;
  const ts2 = Date.now() - 1000;
  watchCb(pos(41.1, ts1));
  await tick(); // P1 fails and is re-queued
  watchCb(pos(41.2, ts2));
  await tick(); // flush retries P1 (head-of-line) and fails again; P2 still queued

  state.fail = false;
  windowListeners.online();
  await tick();
  await tick(); // cascade flush drains the rest of the queue

  const delivered = state.pings;
  ok(delivered.length === 4, `two failed attempts + two successful deliveries (got ${delivered.length})`);
  ok(delivered[2].capturedAt === ts1 && delivered[2].latitude === 41.1, "first queued fix delivered intact");
  ok(delivered[3].capturedAt === ts2 && delivered[3].latitude === 41.2, "second queued fix delivered intact (not dropped)");
  unsub();
}

/* 3. A fix queued while backgrounded/offline is flushed when the page becomes
   visible again. */
{
  reset();
  const unsub = tracker.subscribe(() => {});
  const ts = Date.now() - 1000;
  watchCb(pos(41.3, ts));
  await tick(); // failed → queued

  state.fail = false;
  documentListeners.visibilitychange(); // visibilityState === "visible"
  await tick();
  ok(state.pings.length === 2, "visibility-visible flushes the queued fix");
  ok(state.pings[1].capturedAt === ts && state.pings[1].latitude === 41.3, "visibility flush preserves capturedAt + coords");
  unsub();
}

console.log(`driver-gps-tracker.test.mjs: ${n} assertions passed`);
