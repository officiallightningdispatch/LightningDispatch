import { useEffect, useState, type ReactNode } from "react";
import { pingDriverLocation } from "~/data/driver-gps";
import { getLocation, isNative, onNativeAppState, startLocationUpdates, startMotionAssistedCapture, stopLocation } from "~/lib/native-capabilities";

/**
 * A driver's location is a dispatch signal, not a job/GO signal. Keep one
 * tracker alive for the whole authenticated driver portal so a driver who is
 * working a Towbook-side assignment still reports a real app GPS fix. Native
 * Capacitor watches continue while the app is backgrounded; web uses the
 * browser watch plus a five-minute safety capture while the page is active.
 *
 * Uploads are deliberately decoupled from collection. A short network outage
 * queues each real fix and retries it with backoff; the original capture time
 * is preserved so a delayed upload can never masquerade as a fresh location.
 */
export type DriverGpsState = "idle" | "tracking" | "denied" | "unsupported" | "error";
const WEB_CAPTURE_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
/** Keep transiently failed fixes for 15 minutes, while dispatch still applies
 * its own <=15-minute freshness gate to the captured timestamp. */
const MAX_FIX_RETRY_AGE_MS = 15 * 60 * 1000;
/** Bound memory during a prolonged outage (20-second fixes ≈ 40 minutes). */
const MAX_QUEUED_FIXES = 120;

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

let queuedFixes: CapturedFix[] = [];
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
  if (retryTimer != null || !queuedFixes.length) return;
  const oldest = queuedFixes[0];
  if (!oldest || Date.now() - oldest.capturedAt > MAX_FIX_RETRY_AGE_MS) {
    // A fix older than the dispatch freshness window cannot be useful for
    // routing. Drop only expired queued evidence; newer fixes remain queued.
    queuedFixes = queuedFixes.filter((fix) => Date.now() - fix.capturedAt <= MAX_FIX_RETRY_AGE_MS);
    if (!queuedFixes.length) {
      setState("error");
      return;
    }
  }
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushUploadQueue();
  }, delay);
}

async function flushUploadQueue() {
  if (uploadInFlight || !queuedFixes.length) return;
  uploadInFlight = true;
  const fix = queuedFixes.shift() as CapturedFix;
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
        queuedFixes.unshift(fix);
        setState("error");
        scheduleRetry();
      }
    } else {
      retryAttempt = 0;
      setState("tracking");
    }
  } catch {
    // Server-function/network failures are transient until proven otherwise.
    // Keep the captured timestamp so a delayed upload cannot make an old fix
    // look fresh and cannot weaken the dispatch freshness rule.
    if (running) {
      queuedFixes.unshift(fix);
      setState("error");
      scheduleRetry();
    }
  } finally {
    uploadInFlight = false;
    if (queuedFixes.length && retryTimer == null) void flushUploadQueue();
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
  if (queuedFixes.length >= MAX_QUEUED_FIXES) queuedFixes.shift();
  queuedFixes.push({
    latitude: c.latitude,
    longitude: c.longitude,
    accuracy: typeof c.accuracy === "number" && Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null,
    speedMph: typeof c.speed === "number" && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed * 2.236936 : null,
    capturedAt,
  });
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
        if (isActive) {
          retryAttempt = 0;
          clearRetryTimer();
          void getLocation().then(report).catch(reportError);
          void flushUploadQueue();
        }
      });
      // Motion-assisted capture is a best-effort ENHANCEMENT. This start() runs
      // on a user-initiated action (the authenticated driver enters the portal),
      // so it is a valid time to request Motion & Fitness. Denial or absence
      // returns a no-op handle and the location watch above continues unchanged.
      const motionHandle = await startMotionAssistedCapture(report);
      cleanup = () => {
        void stopLocation(watchId);
        void appStateListener.remove();
        void motionHandle.stop();
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
  const onVisible = () => { if (document.visibilityState === "visible") { capture(); void flushUploadQueue(); } };
  const onOnline = () => { retryAttempt = 0; clearRetryTimer(); void flushUploadQueue(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  cleanup = () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
  };
}

/** Low-level subscription seam (used by the hook below and by the hermetic
 *  tracker fixture). Starts the tracker on first subscriber and tears it down
 *  when the last subscriber leaves. Exported so the flush-on-resume queue
 *  behavior is testable without mounting a React tree. */
export function subscribe(listener: (next: DriverGpsState) => void) {
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
      queuedFixes = [];
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
