import { useEffect, useState, type ReactNode } from "react";
import { pingDriverLocation } from "~/data/driver-gps";
import { isNative, startLocationUpdates, stopLocation } from "~/lib/native-capabilities";

/**
 * A driver's location is a dispatch signal, not a job/GO signal. Keep one
 * tracker alive for the whole authenticated driver portal so a driver who is
 * working a Towbook-side assignment still reports a real app GPS fix. Native
 * Capacitor watches continue while the app is backgrounded; web uses the
 * browser watch plus a five-minute safety capture while the page is active.
 */
export type DriverGpsState = "idle" | "tracking" | "denied" | "unsupported" | "error";
const WEB_CAPTURE_INTERVAL_MS = 5 * 60 * 1000;

let state: DriverGpsState = "idle";
let running = false;
let cleanup: (() => void) | null = null;
const subscribers = new Set<(next: DriverGpsState) => void>();

function setState(next: DriverGpsState) {
  state = next;
  for (const subscriber of subscribers) subscriber(next);
}

type DriverPosition = { coords: { latitude: number; longitude: number; accuracy?: number | null; speed?: number | null } };
function report(position: DriverPosition | GeolocationPosition) {
  const c = position.coords;
  if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude) || (c.latitude === 0 && c.longitude === 0)) {
    setState("error");
    return;
  }
  setState("tracking");
  void pingDriverLocation({
    data: {
      latitude: c.latitude,
      longitude: c.longitude,
      accuracy: typeof c.accuracy === "number" && Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null,
      speedMph: typeof c.speed === "number" && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed * 2.236936 : null,
      // Job association is best-effort. A null job is intentional: Towbook-side
      // assignments must still create an authoritative driver_locations row.
      jobTowbookId: null,
    },
  }).catch(() => {
    // A transient network/auth failure must not stop location collection.
  });
}

function reportError(error: GeolocationPositionError | unknown) {
  if (typeof error === "object" && error !== null && "code" in error && Number((error as { code?: unknown }).code) === 1) setState("denied");
  else if (state !== "tracking") setState("error");
}

async function start() {
  if (running || typeof navigator === "undefined") return;
  running = true;
  if (isNative()) {
    try {
      const watchId = await startLocationUpdates(true, null, report);
      if (!watchId) {
        running = false;
        setState("denied");
        return;
      }
      cleanup = () => { void stopLocation(watchId); };
    } catch {
      running = false;
      setState("error");
    }
    return;
  }
  if (!navigator.geolocation) {
    running = false;
    setState("unsupported");
    return;
  }
  let watchId: number | null = null;
  const options: PositionOptions = { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 };
  try {
    watchId = navigator.geolocation.watchPosition(report, reportError, options);
  } catch {
    setState("error");
  }
  const capture = () => navigator.geolocation.getCurrentPosition(report, reportError, options);
  capture();
  const timer = window.setInterval(capture, WEB_CAPTURE_INTERVAL_MS);
  const onVisible = () => { if (document.visibilityState === "visible") capture(); };
  document.addEventListener("visibilitychange", onVisible);
  cleanup = () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function subscribe(listener: (next: DriverGpsState) => void) {
  subscribers.add(listener);
  listener(state);
  void start();
  return () => {
    subscribers.delete(listener);
    // DriverGate unmounts when the authenticated driver leaves the portal.
    if (!subscribers.size && running) {
      cleanup?.();
      cleanup = null;
      running = false;
      state = "idle";
    }
  };
}

export function useDriverGpsState(): DriverGpsState {
  const [current, setCurrent] = useState<DriverGpsState>(state);
  useEffect(() => subscribe(setCurrent), []);
  return current;
}

/** Mounted once by DriverGate. It deliberately has no GO/session/job prop. */
export function DriverGpsTracker({ children }: { children: ReactNode }) {
  useDriverGpsState();
  return <>{children}</>;
}
