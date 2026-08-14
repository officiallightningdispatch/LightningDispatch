import { useEffect, useState } from 'react';
import { isNative, online as nativeOnline, onConnectivityChange, onNativePushToken, registerPush, saveNativePushToken, startLocationUpdates, stopLocation } from '~/lib/native-capabilities';

/** Native-only readiness strip. Web returns null and keeps the existing portal untouched. */
export function NativeContractorStatus({ contractorOnline }: { contractorOnline: boolean }) {
  const [connected, setConnected] = useState(true);
  const [push, setPush] = useState<'checking'|'ready'|'blocked'|'error'>('checking');
  const [location, setLocation] = useState<'idle'|'active'|'blocked'|'error'>('idle');
  useEffect(() => {
    if (!isNative()) return;
    let live = true;
    let watch: string | null = null;
    void nativeOnline().then((v) => live && setConnected(v)).catch(() => live && setConnected(false));
    const net = onConnectivityChange((v) => { if (live) setConnected(v); });
    void registerPush().then((r) => { if (live) setPush(r.granted ? 'ready' : 'blocked'); }).catch(() => live && setPush('error'));
    const tokenListener = onNativePushToken((token) => { void saveNativePushToken(token).then((r) => live && setPush(r.ok ? 'ready' : 'error')); });
    return () => { live = false; void tokenListener.remove(); void net.remove(); if (watch) void stopLocation(watch); };
  }, []);
  useEffect(() => {
    if (!isNative() || !contractorOnline || !connected) { setLocation('idle'); return; }
    let cancelled = false;
    let watch: string | null = null;
    void startLocationUpdates(true).then((id) => { if (cancelled) { if (id) void stopLocation(id); } else { watch = id; setLocation(id ? 'active' : 'blocked'); } }).catch(() => !cancelled && setLocation('error'));
    return () => { cancelled = true; if (watch) void stopLocation(watch); };
  }, [contractorOnline, connected]);
  if (!isNative()) return null;
  return <div className="mx-3 mt-2 rounded-xl border border-ink-200 bg-surface px-3 py-2 text-[11px] text-ink-600" role="status" aria-label="Native app status">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold">
      <span className={connected ? 'text-emerald-700' : 'text-amber-700'}>{connected ? '● Connected' : '● Offline'}</span>
      <span className={push === 'ready' ? 'text-emerald-700' : push === 'blocked' ? 'text-amber-700' : ''}>Alerts: {push === 'ready' ? 'ready' : push === 'blocked' ? 'permission needed' : push}</span>
      <span>Location: {location === 'active' ? 'sharing while online' : location === 'idle' ? 'off while offline' : location}</span>
    </div>
  </div>;
}
