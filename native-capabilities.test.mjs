import { describe, test, expect, beforeEach, mock } from 'bun:test';

// Hermetic bridge tests: no database, native SDK, network, or device required.
const state = { native: false, platform: 'web', push: { receive: 'prompt' }, listeners: [], watch: [], cameraError: null, motionListeners: [], motionPermission: 'granted', motionPermissionThrow: false };
mock.module('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => state.native, getPlatform: () => state.platform } }));
mock.module('@capacitor/preferences', () => ({ Preferences: { get: async ({ key }) => ({ value: globalThis.localStorage?.getItem(key) ?? null }), set: async ({ key, value }) => globalThis.localStorage.setItem(key, value), remove: async ({ key }) => globalThis.localStorage.removeItem(key) } }));
mock.module('@capacitor/network', () => ({ Network: { getStatus: async () => ({ connected: true }), addListener: async (_event, cb) => { state.listeners.push(cb); return { remove: async () => {} }; } } }));
mock.module('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: async () => {} }) } }));
mock.module('@capacitor/camera', () => ({ CameraResultType: { Uri: 'uri' }, CameraSource: { Camera: 'camera' }, Camera: { getPhoto: async () => { if (state.cameraError) throw state.cameraError; return { path: 'native-photo' }; } } }));
mock.module('@capacitor/geolocation', () => ({ Geolocation: { requestPermissions: async () => state.locationPermission ?? { location: 'granted' }, getCurrentPosition: async () => ({ coords: { latitude: 1, longitude: 2 } }), watchPosition: async (_o, cb) => { state.watch.push(cb); return 'watch-1'; }, clearWatch: async ({ id }) => { state.cleared = id; } } }));
mock.module('@capacitor/motion', () => ({ Motion: { addListener: async (event, cb) => { state.motionListeners.push({ event, cb }); return { remove: async () => { state.motionRemoved = true; } }; }, removeAllListeners: async () => { state.motionListeners = []; } } }));
mock.module('@capacitor/push-notifications', () => ({ PushNotifications: { checkPermissions: async () => state.push, requestPermissions: async () => state.pushAfter ?? { receive: 'granted' }, register: async () => { state.registered = true; }, addListener: async (_e, cb) => { state.tokenCallback = cb; return { remove: async () => {} }; } } }));
mock.module('./src/data/push.ts', () => ({ saveNativePushToken: async ({ data }) => state.savePush?.(data) ?? { ok: true } }));
mock.module('./src/data/driver-gps.ts', () => ({ pingDriverLocation: async ({ data }) => { (state.pings ??= []).push(data); return { ok: true }; } }));

globalThis.localStorage = { data: new Map(), getItem(k) { return this.data.get(k) ?? null; }, setItem(k, v) { this.data.set(k, String(v)); }, removeItem(k) { this.data.delete(k); } };
const bridge = await import('./src/lib/native-capabilities.ts');

beforeEach(() => { state.native = false; state.platform = 'web'; state.push = { receive: 'prompt' }; state.pushAfter = undefined; state.locationPermission = { location: 'granted' }; state.watch = []; state.cleared = undefined; state.pings = []; state.savePush = undefined; state.cameraError = null; state.motionListeners = []; state.motionRemoved = false; state.motionPermission = 'granted'; state.motionPermissionThrow = false; globalThis.DeviceMotionEvent = { requestPermission: async () => { if (state.motionPermissionThrow) throw new Error('motion denied'); return state.motionPermission; } }; localStorage.data.clear(); });

describe('native contractor bridge', () => {
  test('web feature detection preserves existing web behavior', async () => {
    globalThis.Notification = { permission: 'granted' };
    expect(bridge.isNative()).toBe(false);
    expect(await bridge.registerPush()).toEqual({ granted: true });
    expect(await bridge.requestLocation()).toBe(false); // no navigator geolocation in this seam
    expect(await bridge.saveNativePushToken('x')).toEqual({ ok: false, error: 'Native push is unavailable.' });
  });

  test('push permission and token registration save diagnostics', async () => {
    state.native = true; state.platform = 'ios'; state.push = { receive: 'granted' };
    // registerPush is READ-ONLY now: it reports granted WITHOUT registering.
    expect(await bridge.registerPush()).toEqual({ granted: true });
    expect(state.registered).toBe(undefined);
    state.savePush = async () => ({ ok: false, error: 'Sign in as a driver first.' });
    expect(await bridge.saveNativePushToken('abc')).toEqual({ ok: false, error: 'Sign in as a driver first.' });
    state.savePush = async () => { throw new Error('session expired'); };
    expect(await bridge.saveNativePushToken('abc')).toEqual({ ok: false, error: 'session expired' });
  });

  test('registerPush never prompts nor registers at boot (read-only status)', async () => {
    state.native = true; state.platform = 'ios'; state.push = { receive: 'prompt' }; state.pushAfter = { receive: 'granted' };
    const r = await bridge.registerPush();
    expect(r).toEqual({ granted: false, reason: 'permission_denied' }); // prompt ≠ granted, and it did NOT request
    expect(state.registered).toBe(undefined);
  });

  test('push permission denial and location permission denial are explicit', async () => {
    state.native = true; state.push = { receive: 'denied' };
    expect(await bridge.registerPush()).toEqual({ granted: false, reason: 'permission_denied' });
    state.locationPermission = { location: 'denied' };
    expect(await bridge.requestLocation()).toBe(false);
    expect(await bridge.startLocationUpdates(true)).toBeNull();
  });

  test('queue retains failed updates, increments attempts, and loses nothing', async () => {
    await bridge.capabilityQueue.enqueue('update', { id: 1 });
    await bridge.capabilityQueue.enqueue('update', { id: 2 });
    const result = await bridge.capabilityQueue.drain('update', async (payload) => { if (payload.id === 1) throw new Error('offline'); });
    expect(result).toEqual({ sent: 1, remaining: 1 });
    const retained = JSON.parse(localStorage.getItem('lightning-native-queue-update'));
    expect(retained).toHaveLength(1); expect(retained[0].payload).toEqual({ id: 1 }); expect(retained[0].attempts).toBe(1); expect(retained[0].lastError).toBe('retryable failure');
    expect(await bridge.capabilityQueue.drain('update', async () => {})).toEqual({ sent: 1, remaining: 0 });
    expect(localStorage.getItem('lightning-native-queue-update')).toBeNull();
  });

  test('camera adapter failures propagate to caller', async () => {
    state.native = true; state.cameraError = new Error('camera unavailable');
    await expect(bridge.capturePhoto()).rejects.toThrow('camera unavailable');
  });

  test('requestMotionPermission returns true on web (non-blocking no-op)', async () => {
    state.native = false;
    expect(await bridge.requestMotionPermission()).toBe(true);
  });

  test('requestMotionPermission granted/denied/absent-feature paths', async () => {
    state.native = true;
    // granted
    state.motionPermission = 'granted';
    expect(await bridge.requestMotionPermission()).toBe(true);
    // denied
    state.motionPermission = 'denied';
    expect(await bridge.requestMotionPermission()).toBe(false);
    // absent feature (no DeviceMotionEvent.requestPermission) → true (don't block GPS)
    globalThis.DeviceMotionEvent = {};
    expect(await bridge.requestMotionPermission()).toBe(true);
    // throw → fail closed → false
    globalThis.DeviceMotionEvent = { requestPermission: async () => { throw new Error('boom'); } };
    expect(await bridge.requestMotionPermission()).toBe(false);
  });

  test('motion denied leaves location tracking unaffected', async () => {
    state.native = true; state.motionPermission = 'denied';
    // location permission still granted → location tracking proceeds normally
    expect(await bridge.requestLocation()).toBe(true);
    const handle = await bridge.startMotionAssistedCapture(() => {});
    // no accel listener registered because permission was denied
    expect(state.motionListeners).toHaveLength(0);
    // handle is a harmless no-op
    await handle.stop();
    expect(state.motionRemoved).toBe(false);
  });

  test('motion-triggered capture is debounced', async () => {
    state.native = true; state.motionPermission = 'granted';
    const fixes = [];
    const handle = await bridge.startMotionAssistedCapture((p) => fixes.push(p), { debounceMs: 30_000 });
    expect(state.motionListeners).toHaveLength(1);
    const accel = state.motionListeners[0].cb;
    // First significant movement triggers a capture.
    accel({ acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 });
    accel({ acceleration: { x: 2, y: 0, z: 0 }, accelerationIncludingGravity: { x: 2, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 });
    await new Promise((r) => setTimeout(r, 0));
    expect(fixes).toHaveLength(1);
    // Immediately-following movement within the debounce window does NOT trigger another capture.
    accel({ acceleration: { x: 9, y: 9, z: 9 }, accelerationIncludingGravity: { x: 9, y: 9, z: 9 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 });
    await new Promise((r) => setTimeout(r, 0));
    expect(fixes).toHaveLength(1);
    await handle.stop();
    expect(state.motionRemoved).toBe(true);
  });
});

// The status component is deliberately native-only and presents all operational states.
const statusSource = await Bun.file('./src/components/native-contractor-status.tsx').text();
test('native status surface renders connected/offline, push, and location states', () => {
  expect(statusSource).toContain("if (!isNative()) return null");
  for (const label of ['Connected', 'Offline', 'permission needed', 'sharing while signed in', 'starting']) expect(statusSource).toContain(label);
});
