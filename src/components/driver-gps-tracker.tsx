import { useEffect, useState, type ReactNode } from "react";
import { pingDriverLocation } from "~/data/driver-gps";
import { getLocation, isNative, onNativeAppState, startLocationUpdates, stopLocation } from "~/lib/native-capabilities";

/**
 * A driver's location is a dispatch signal, not a job/GO signal. Keep one
 * tracker alive for the whole authenticated driver portal so a driver who is
 * working a Towbook-side assignment still reports a real app GPS fix. Native
 * Capacitor watches continue while the app is backgrounded; web uses the
 * browser watch plus a five-minute safety capture while the page is active.
 *
 * The upload path is deliberately separate from GPS collection: a slow or
 * temporarily unreachable server must not stop the native watch/browser watch.
 * Failed transient uploads retry the same captured fix briefly, preserving its
 * original timestamp; an auth failure is surfaced and is never retried in a
 * tight loop.
 */
export type DriverGpsState = "idle" | "tracking" | "denied" | "unsupported" | "error";
const WEB_CAPTURE_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
const MAX_FIX_RETRY_AGE_MS = 2 * 60 * 1000;

let state: DriverGpsState = "idle";
let running = false;
let cleanup: (() => void) | null = null;
const subscribers = new Set<(next: DriverGpsState) => void>();

type DriverPosition = {
  coords: { latitude: number; longitude: number; accuracy?: number | null; speed?: number | null };
  timestamp?: number;
};
type CapturedFix = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speedMph: number | null;
  capturedAt: number;
};

let queuedFix: CapturedFix | null = null;
let uploadInFlight = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function setState(next: DriverGpsState) {
  state = next;
  for (const subscriber of subscribers) subscriber(next);
}

function isAuthFailure(reason: string): boolean {
  return /sign in as a driver|account is not linked|deactivated|session/i.test(reason);
}

function clearRetryTimer() {
  if (retryTimer != null) clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry() {
  if (retryTimer != null || !queuedFix) return;
  const fix = queuedFix;
  if (Date.now() - fix.capturedAt > MAX_FIX_RETRY_AGE_MS) {
    queuedFix = null;
    setState("error");
    return;
  }
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushUploadQueue();
  }, delay);
}

async function flushUploadQueue() {
  if (uploadInFlight || !queuedFix) return;
  uploadInFlight = true;
  const fix = queuedFix;
  queuedFix = null;
  try {
    const result = await pingDriverLocation({
      data: {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracy: fix.accuracy,
        speedMph: fix.speedMph,
        capturedAt: fix.capturedAt,
        // Job association is best-effort. A null job is intentional: Towbook-side
        // assignments must still create an authoritative driver_locations row.
        jobTowbookId: null,
      },
    });
    if (!result.ok) {
      // Do not spin on a dead Lightning session. The driver-facing state makes
      // the failure visible, while a later fresh fix can still try again.
      if (isAuthFailure(result.reason)) {
        retryAttempt = 0;
        setState("error");
      } else if (running) {
        queuedFix = queuedFix ?? fix;
        setState("error");
        scheduleRetry();
      }
    } else {
      retryAttempt = 0;
      setState("tracking");
    }
  } catch {
    // Server-function/network failures are transient until proven otherwise.
    // Keep the captured timestamp so a delayed upload cannot masquerade as a
    // newly captured GPS fix and cannot weaken the dispatch freshness rule.
    if (running) {
      queuedFix = queuedFix ?? fix;
      setState("error");
      scheduleRetry();
    }
  } finally {
    uploadInFlight = false;
    if (queuedFix && retryTimer == null) void flushUploadQueue();
  }
}

function report(position: DriverPosition | GeolocationPosition) {
  if (!running) return;
  const c = position.coords;
  if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude) || (c.latitude === 0 && c.longitude === 0)) {
    setState("error");
    return;
  }
  const rawTimestamp = "timestamp" in position && typeof position.timestamp === "number" ? position.timestamp : Date.now();
  const capturedAt = Number.isFinite(rawTimestamp) && rawTimestamp > 0 ? rawTimestamp : Date.now();
  queuedFix = {
    latitude: c.latitude,
    longitude: c.longitude,
    accuracy: typeof c.accuracy === "number" && Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null,
    speedMph: typeof c.speed === "number" && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed * 2.236936 : null,
    capturedAt,
  };
  clearRetryTimer();
  retryAttempt = 0;
  void flushUploadQueue();
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
      if (!running) {
        await stopLocation(watchId);
        return;
      }
      const appStateListener = await onNativeAppState((isActive) => {
        if (isActive) void getLocation().then(report).catch(reportError);
      });
      cleanup = () => {
        void stopLocation(watchId);
        void appStateListener.remove();
      };
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
      clearRetryTimer();
      queuedFix = null;
      retryAttempt = 0;
      uploadInFlight = false;
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
