/** Cross-platform capability boundary. Web keeps using existing browser APIs; native uses Capacitor.
 * No auth or backend duplication lives here: callers continue to use the existing /api endpoints. */
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Network } from '@capacitor/network';
import { App } from '@capacitor/app';
import { Camera, CameraResultType, CameraSource, type Photo } from '@capacitor/camera';
import { Geolocation, type Position } from '@capacitor/geolocation';
import { PushNotifications } from '@capacitor/push-notifications';

export const isNative = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform();

const webStore = { get: (key: string) => typeof localStorage === 'undefined' ? null : localStorage.getItem(key), set: (key: string, value: string) => { localStorage.setItem(key, value); }, remove: (key: string) => { localStorage.removeItem(key); } };
/** Secure on-device preferences (Keychain/Keystore in native builds); localStorage only on web. */
export const secureSession = {
  async get(key: string) { return isNative() ? (await Preferences.get({ key })).value : webStore.get(key); },
  async set(key: string, value: string) { if (isNative()) await Preferences.set({ key, value }); else webStore.set(key, value); },
  async remove(key: string) { if (isNative()) await Preferences.remove({ key }); else webStore.remove(key); },
};

export async function registerPush() {
  if (isNative()) { let p = await PushNotifications.checkPermissions(); if (p.receive === 'prompt') p = await PushNotifications.requestPermissions(); if (p.receive !== 'granted') return { granted: false as const }; await PushNotifications.register(); return { granted: true as const }; }
  return { granted: typeof Notification !== 'undefined' && Notification.permission === 'granted' };
}
export async function requestLocation() { if (!isNative()) return navigator.geolocation?.getCurrentPosition ? true : false; const p = await Geolocation.requestPermissions(); return p.location === 'granted'; }
export async function getLocation(): Promise<Position | GeolocationPosition> { if (isNative()) return Geolocation.getCurrentPosition(); return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject)); }
export async function watchLocation(callback: (position: Position | GeolocationPosition) => void) { if (isNative()) return Geolocation.watchPosition({}, (p, e) => { if (p) callback(p); else if (e) console.warn('location update', e); }); const id = navigator.geolocation.watchPosition(callback, console.warn); return String(id); }
export async function capturePhoto(): Promise<Photo | File> { if (isNative()) return Camera.getPhoto({ resultType: CameraResultType.Uri, source: CameraSource.Camera, quality: 85 }); return new Promise((resolve, reject) => { reject(new Error('Use the existing web photo input')); }); }
export async function online() { return (await Network.getStatus()).connected; }
export function onConnectivityChange(callback: (connected: boolean) => void) { if (isNative()) return Network.addListener('networkStatusChange', s => callback(s.connected)); const handler = () => callback(navigator.onLine); window.addEventListener('online', handler); window.addEventListener('offline', handler); return { remove: async () => { window.removeEventListener('online', handler); window.removeEventListener('offline', handler); } }; }
export function onDeepLink(callback: (url: string) => void) { if (!isNative()) return { remove: async () => {} }; return App.addListener('appUrlOpen', ({ url }) => callback(url)); }
export const capabilityQueue = { async enqueue(kind: 'update' | 'photo', payload: unknown) { const key = `lightning-native-queue-${kind}`; const raw = await secureSession.get(key); const items: unknown[] = raw ? JSON.parse(raw) : []; items.push({ payload, queuedAt: new Date().toISOString() }); await secureSession.set(key, JSON.stringify(items)); }, async drain(kind: 'update' | 'photo', send: (payload: unknown) => Promise<void>) { const key = `lightning-native-queue-${kind}`; const raw = await secureSession.get(key); const items: { payload: unknown }[] = raw ? JSON.parse(raw) : []; for (const item of items) await send(item.payload); await secureSession.remove(key); } };
