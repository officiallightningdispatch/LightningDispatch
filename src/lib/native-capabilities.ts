/** Cross-platform capability boundary. Web keeps existing browser APIs; native uses Capacitor.
 * Native adapters call the existing authenticated server functions; no backend contract changes. */
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Network } from '@capacitor/network';
import { App } from '@capacitor/app';
import { Camera, CameraResultType, CameraSource, type Photo } from '@capacitor/camera';
import { Geolocation, type Position } from '@capacitor/geolocation';
import { Motion } from '@capacitor/motion';
import { PushNotifications } from '@capacitor/push-notifications';
import { saveNativePushToken as saveApnsToken } from '~/data/push';
import { pingDriverLocation } from '~/data/driver-gps';

export const isNative = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform();
const webStore = { get: (key: string) => typeof localStorage === 'undefined' ? null : localStorage.getItem(key), set: (key: string, value: string) => { localStorage.setItem(key, value); }, remove: (key: string) => { localStorage.removeItem(key); } };
export const secureSession = {
  async get(key: string) { return isNative() ? (await Preferences.get({ key })).value : webStore.get(key); },
  async set(key: string, value: string) { if (isNative()) await Preferences.set({ key, value }); else webStore.set(key, value); },
  async remove(key: string) { if (isNative()) await Preferences.remove({ key }); else webStore.remove(key); },
};

export type NativeSetupState = { native: boolean; connected: boolean; push: 'unknown' | 'granted' | 'denied' | 'saved' | 'error'; location: 'unknown' | 'granted' | 'denied' | 'error' };
/** READ-ONLY notification permission status (NO prompt, NO register). The
 * "Allow notifications" card drives the real permission prompt + APNs
 * registration through ensureNativePushRegistration; this status strip must
 * never fire the iOS prompt or register at boot. A boot-time register() leaves
 * the device already-registered, so the user's later tap register() never
 * re-emits the token and hangs for the full 10s timeout. */
export async function registerPush() {
  if (!isNative()) return { granted: typeof Notification !== 'undefined' && Notification.permission === 'granted' } as const;
  const p = await PushNotifications.checkPermissions();
  return p.receive === 'granted'
    ? { granted: true as const }
    : { granted: false as const, reason: 'permission_denied' };
}
export async function saveNativePushToken(token: string) {
  if (!isNative() || !token) return { ok: false as const, error: 'Native push is unavailable.' };
  try {
    const result = await saveApnsToken({ data: { token, deviceLabel: `LightningDispatch/${platform()}` } });
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : 'Session unavailable.' }; }
}
export async function requestLocation() { if (!isNative()) return typeof navigator !== 'undefined' && !!navigator.geolocation; const p = await Geolocation.requestPermissions(); return p.location === 'granted'; }
export async function getLocation(): Promise<Position | GeolocationPosition> { if (isNative()) return Geolocation.getCurrentPosition(); return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject)); }
export async function watchLocation(callback: (position: Position | GeolocationPosition) => void) {
  if (isNative()) {
    return Geolocation.watchPosition(
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0, minimumUpdateInterval: 15_000, interval: 30_000 },
      (p, e) => { if (p) callback(p); else if (e) console.warn('location update', e); },
    );
  }
  const id = navigator.geolocation.watchPosition(callback, console.warn, { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 });
  return String(id);
}
export async function stopLocation(watchId: string | null | undefined) { if (!watchId) return; if (isNative()) await Geolocation.clearWatch({ id: watchId }); else navigator.geolocation.clearWatch(Number(watchId)); }
/** Observe native foreground transitions so a driver who returns from Towbook
 * gets an immediate fresh app fix. The native location watch remains the
 * background source; this is a resume safety capture, never a fallback
 * coordinate. */
export function onNativeAppState(callback: (isActive: boolean) => void) {
  if (!isNative()) return { remove: async () => {} };
  return App.addListener('appStateChange', ({ isActive }) => callback(isActive));
}

export async function startLocationUpdates(
  enabled: boolean,
  jobTowbookId?: string | null,
  onPosition?: (position: Position | GeolocationPosition) => void,
) {
  if (!enabled || !(await requestLocation())) return null;
  return watchLocation((p: Position | GeolocationPosition) => {
    if (onPosition) {
      onPosition(p);
      return;
    }
    const c = p.coords;
    void pingDriverLocation({
      data: {
        latitude: c.latitude,
        longitude: c.longitude,
        accuracy: c.accuracy ?? null,
        speedMph: typeof c.speed === 'number' && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed * 2.236936 : null,
        jobTowbookId: jobTowbookId ?? null,
      },
    });
  });
}
/** Motion & Fitness is an ENHANCEMENT to location capture, never a gate.
 * @capacitor/motion is backed by the web DeviceMotionEvent/DeviceOrientationEvent
 * APIs (no native pod), so on iOS its access is surfaced through
 * `DeviceMotionEvent.requestPermission()` and the prompt copy comes from the
 * Info.plist key `NSMotionUsageDescription`. Accelerometer/orientation data does
 * NOT change GPS math — Core Motion's step/activity classifier is not exposed
 * here. What motion genuinely buys us is the ability to trigger FRESHER
 * high-accuracy GPS fixes when the device is physically moving, and waste less
 * battery while it is still. It is never allowed to block or regress the
 * existing GPS pipeline. */
export async function requestMotionPermission(): Promise<boolean> {
  if (!isNative()) return true; // web: no-op, never blocks
  try {
    const DeviceMotionEventCtor = (globalThis as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (typeof DeviceMotionEventCtor?.requestPermission === 'function') {
      return (await DeviceMotionEventCtor.requestPermission()) === 'granted';
    }
    return true; // feature absent → nothing to gate, don't block the GPS pipeline
  } catch {
    return false; // fail closed: any throw → treated as denied
  }
}

const MOTION_DEBOUNCE_MS = 30_000;
const MOTION_MOVEMENT_THRESHOLD_MS2 = 1.5;

type AccelVector = { x: number; y: number; z: number };
function toAccelVector(a: { x: number; y: number; z: number } | null | undefined): AccelVector | null {
  if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) return null;
  return { x: a.x, y: a.y, z: a.z };
}

export type MotionAssistOptions = { debounceMs?: number; movementThresholdMs2?: number };
export type MotionAssistHandle = { stop: () => Promise<void> };

/** Starts accelerometer-triggered high-accuracy GPS captures (motion-assisted
 * location). When Motion & Fitness permission is granted, listens for `accel`
 * events and, on a meaningful change in the acceleration vector (exceeding
 * `movementThresholdMs2` m/s²), fires a fresh `getLocation()` and routes the fix
 * through the same `onPosition` report path the location tracker uses. Captures
 * are debounced to at most one per `debounceMs` (default 30s) so motion can
 * never spam GPS. Returns a `stop()` cleanup handle; on web (or when permission
 * is denied / the plugin is absent) this is a no-op that leaves the existing
 * location pipeline untouched. */
export async function startMotionAssistedCapture(
  onPosition: (position: Position | GeolocationPosition) => void,
  options?: MotionAssistOptions,
): Promise<MotionAssistHandle> {
  if (!isNative()) return { stop: async () => {} };
  const debounceMs = options?.debounceMs ?? MOTION_DEBOUNCE_MS;
  const movementThreshold = options?.movementThresholdMs2 ?? MOTION_MOVEMENT_THRESHOLD_MS2;
  try {
    const granted = await requestMotionPermission();
    if (!granted) return { stop: async () => {} }; // denied → no enhancement, GPS unaffected
    let lastCaptureAt = 0;
    let prev: AccelVector | null = null;
    const handle = await Motion.addListener('accel', (event) => {
      const vec = toAccelVector(event.acceleration) ?? toAccelVector(event.accelerationIncludingGravity);
      if (!vec) return;
      if (!prev) { prev = vec; return; } // first sample is only a baseline, not a capture
      const delta = Math.hypot(vec.x - prev.x, vec.y - prev.y, vec.z - prev.z);
      if (delta < movementThreshold) return; // below threshold: not meaningful movement
      const now = Date.now();
      if (now - lastCaptureAt < debounceMs) return; // debounce: never spam GPS
      prev = vec;
      lastCaptureAt = now;
      void getLocation().then(onPosition).catch(() => { /* motion capture is best-effort; the watch remains the authoritative source */ });
    });
    return {
      stop: async () => {
        try { await handle.remove(); } catch { /* already removed */ }
        try { await Motion.removeAllListeners(); } catch { /* nothing to remove */ }
      },
    };
  } catch {
    return { stop: async () => {} }; // fail closed: any throw → no enhancement, GPS unaffected
  }
}

export async function capturePhoto(): Promise<Photo | File> { if (isNative()) return Camera.getPhoto({ resultType: CameraResultType.Uri, source: CameraSource.Camera, quality: 85 }); throw new Error('Use the existing web photo input'); }
export async function online() { return isNative() ? (await Network.getStatus()).connected : navigator.onLine; }
export function onConnectivityChange(callback: (connected: boolean) => void) { if (isNative()) return Network.addListener('networkStatusChange', s => callback(s.connected)); const handler = () => callback(navigator.onLine); window.addEventListener('online', handler); window.addEventListener('offline', handler); return { remove: async () => { window.removeEventListener('online', handler); window.removeEventListener('offline', handler); } }; }
export function onDeepLink(callback: (url: string) => void) { if (!isNative()) return { remove: async () => {} }; return App.addListener('appUrlOpen', ({ url }) => callback(url)); }
export const capabilityQueue = { async enqueue(kind: 'update' | 'photo', payload: unknown) { const key = `lightning-native-queue-${kind}`; const raw = await secureSession.get(key); const items: QueueItem[] = raw ? JSON.parse(raw) : []; items.push({ id: crypto.randomUUID(), payload, queuedAt: new Date().toISOString(), attempts: 0 }); await secureSession.set(key, JSON.stringify(items)); }, async drain(kind: 'update' | 'photo', send: (payload: unknown) => Promise<void>) { const key = `lightning-native-queue-${kind}`; const raw = await secureSession.get(key); const items: QueueItem[] = raw ? JSON.parse(raw) : []; const remaining: QueueItem[] = []; for (const item of items) { try { await send(item.payload); } catch { remaining.push({ ...item, attempts: item.attempts + 1, lastError: 'retryable failure' }); } } if (remaining.length) await secureSession.set(key, JSON.stringify(remaining)); else await secureSession.remove(key); return { sent: items.length - remaining.length, remaining: remaining.length }; } };
type QueueItem = { id: string; payload: unknown; queuedAt: string; attempts: number; lastError?: string };

/** Testable native event registration. Token listener is intentionally installed only by the native shell. */
export function onNativePushToken(callback: (token: string) => void) { if (!isNative()) return { remove: async () => {} }; return PushNotifications.addListener('registration', ({ value }) => callback(value)); }
