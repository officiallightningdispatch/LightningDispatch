/** Cross-platform capability boundary. Web keeps existing browser APIs; native uses Capacitor.
 * Native adapters call the existing authenticated server functions; no backend contract changes. */
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Network } from '@capacitor/network';
import { App } from '@capacitor/app';
import { Camera, CameraResultType, CameraSource, type Photo } from '@capacitor/camera';
import { Geolocation, type Position } from '@capacitor/geolocation';
import { PushNotifications } from '@capacitor/push-notifications';
import { savePushSubscription } from '~/data/push';
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
/** Register APNS/FCM token through the existing authenticated subscription gate.
 * The server stores the opaque token durably; a native push delivery adapter can
 * consume the native:// endpoint later without changing the contractor session. */
export async function registerPush() {
  if (!isNative()) return { granted: typeof Notification !== 'undefined' && Notification.permission === 'granted' } as const;
  let p = await PushNotifications.checkPermissions();
  if (p.receive === 'prompt') p = await PushNotifications.requestPermissions();
  if (p.receive !== 'granted') return { granted: false as const, reason: 'permission_denied' };
  await PushNotifications.register();
  return { granted: true as const };
}
export async function saveNativePushToken(token: string) {
  if (!isNative() || !token) return { ok: false as const, error: 'Native push is unavailable.' };
  try {
    const result = await savePushSubscription({ data: { endpoint: `native://${platform()}/${token}`, p256dh: token, auth: token, userAgent: `LightningDispatch/${platform()}` } });
    return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
  } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : 'Session unavailable.' }; }
}
export async function requestLocation() { if (!isNative()) return typeof navigator !== 'undefined' && !!navigator.geolocation; const p = await Geolocation.requestPermissions(); return p.location === 'granted'; }
export async function getLocation(): Promise<Position | GeolocationPosition> { if (isNative()) return Geolocation.getCurrentPosition(); return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject)); }
export async function watchLocation(callback: (position: Position | GeolocationPosition) => void) { if (isNative()) return Geolocation.watchPosition({}, (p, e) => { if (p) callback(p); else if (e) console.warn('location update', e); }); const id = navigator.geolocation.watchPosition(callback, console.warn); return String(id); }
export async function stopLocation(watchId: string | null | undefined) { if (!watchId) return; if (isNative()) await Geolocation.clearWatch({ id: watchId }); else navigator.geolocation.clearWatch(Number(watchId)); }
export async function startLocationUpdates(online: boolean, jobTowbookId?: string | null) {
  if (!online || !(await requestLocation())) return null;
  return watchLocation((p) => { const c = 'coords' in p ? p.coords : p.coords; void pingDriverLocation({ data: { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy ?? null, jobTowbookId: jobTowbookId ?? null } }); });
}
export async function capturePhoto(): Promise<Photo | File> { if (isNative()) return Camera.getPhoto({ resultType: CameraResultType.Uri, source: CameraSource.Camera, quality: 85 }); throw new Error('Use the existing web photo input'); }
export async function online() { return isNative() ? (await Network.getStatus()).connected : navigator.onLine; }
export function onConnectivityChange(callback: (connected: boolean) => void) { if (isNative()) return Network.addListener('networkStatusChange', s => callback(s.connected)); const handler = () => callback(navigator.onLine); window.addEventListener('online', handler); window.addEventListener('offline', handler); return { remove: async () => { window.removeEventListener('online', handler); window.removeEventListener('offline', handler); } }; }
export function onDeepLink(callback: (url: string) => void) { if (!isNative()) return { remove: async () => {} }; return App.addListener('appUrlOpen', ({ url }) => callback(url)); }
export const capabilityQueue = { async enqueue(kind: 'update' | 'photo', payload: unknown) { const key = `lightning-native-queue-${kind}`; const raw = await secureSession.get(key); const items: QueueItem[] = raw ? JSON.parse(raw) : []; items.push({ id: crypto.randomUUID(), payload, queuedAt: new Date().toISOString(), attempts: 0 }); await secureSession.set(key, JSON.stringify(items)); }, async drain(kind: 'update' | 'photo', send: (payload: unknown) => Promise<void>) { const key = `lightning-native-queue-${kind}`; const raw = await secureSession.get(key); const items: QueueItem[] = raw ? JSON.parse(raw) : []; const remaining: QueueItem[] = []; for (const item of items) { try { await send(item.payload); } catch { remaining.push({ ...item, attempts: item.attempts + 1, lastError: 'retryable failure' }); } } if (remaining.length) await secureSession.set(key, JSON.stringify(remaining)); else await secureSession.remove(key); return { sent: items.length - remaining.length, remaining: remaining.length }; } };
type QueueItem = { id: string; payload: unknown; queuedAt: string; attempts: number; lastError?: string };

/** Testable native event registration. Token listener is intentionally installed only by the native shell. */
export function onNativePushToken(callback: (token: string) => void) { if (!isNative()) return { remove: async () => {} }; return PushNotifications.addListener('registration', ({ value }) => callback(value)); }
