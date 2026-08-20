import { useEffect, useState } from 'react';
import { isNative, online as nativeOnline, onConnectivityChange, onNativePushToken, registerPush, saveNativePushToken } from '~/lib/native-capabilities';
import { useDriverGpsState } from '~/components/driver-gps-tracker';

/** Native-only readiness strip. GPS ownership lives in DriverGate's global
 * tracker, so this component is display-only and cannot create duplicate native
 * watches or gate reporting on GO. */
export function NativeContractorStatus({ contractorOnline: _contractorOnline }: { contractorOnline: boolean }) {
  const [connected, setConnected] = useState(true);
  const [push, setPush] = useState<'checking'|'ready'|'blocked'|'error'>('checking');
  const gps = useDriverGpsState();
  useEffect(() => {
    if (!isNative()) return;
    let live = true;
    void nativeOnline().then((v) => live && setConnected(v)).catch(() => live && setConnected(false));
    const net = onConnectivityChange((v) => { if (live) setConnected(v); });
    void registerPush().then((r) => { if (live) setPush(r.granted ? 'ready' : 'blocked'); }).catch(() => live && setPush('error'));
    let tokenListener: ReturnType<typeof onNativePushToken>;
    void (async () => { tokenListener = await onNativePushToken((token) => { void saveNativePushToken(token).then((r) => live && setPush(r.ok ? 'ready' : 'error')); });
    })();
    return () => { live = false; void Promise.resolve(tokenListener).then((h) => h.remove()); void Promise.resolve(net).then((h) => h.remove()); };
  }, []);
  if (!isNative()) return null;
  const location = gps === 'tracking' ? 'active' : gps === 'denied' ? 'blocked' : gps === 'error' ? 'error' : 'idle';
  return <div className="mx-3 mt-2 rounded-xl border border-ink-200 bg-surface px-3 py-2 text-[11px] text-ink-600" role="status" aria-label="Native app status">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold">
      <span className={connected ? 'text-emerald-700' : 'text-amber-700'}>{connected ? '● Connected' : '● Offline'}</span>
      <span className={push === 'ready' ? 'text-emerald-700' : push === 'blocked' ? 'text-amber-700' : ''}>Alerts: {push === 'ready' ? 'ready' : push === 'blocked' ? 'permission needed' : push}</span>
      <span className={location === 'active' ? 'text-emerald-700' : location === 'blocked' ? 'text-amber-700' : ''}>Location: {location === 'active' ? 'sharing while signed in' : location === 'idle' ? 'starting' : location}</span>
    </div>
  </div>;
}
