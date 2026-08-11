/**
 * Shared driver-portal building blocks (2026-08-11): the Towbook-backed job
 * queue card, the GPS tracking loop/chip, and the queue hook. Extracted from
 * driver-portal.tsx so every driver page — Home (/driver), Offers
 * (/driver/offers), Active (/driver/active) — renders the SAME card and the
 * SAME live queue instead of placeholder shells. Client-safe: only imports
 * createServerFn wrappers (driver-auth), never server-only modules.
 */
import { useNavigate } from "@tanstack/react-router";
import { Check, LogOut, MapPin, Navigation, Radar, RefreshCw, ThumbsUp, Truck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { JobDetailDisclosure } from "~/components/job-detail";
import { JobPhotoFlow } from "~/components/driver-photos-ui";
import { DriverNotificationBanners, SoundToggle } from "~/components/notify-banners";
import { Button, Card, useToast } from "~/components/ui";
import { driverJobAction, driverJobs, driverLogout, type DriverCall } from "~/data/driver-auth";
import { pingDriverLocation } from "~/data/driver-gps";

export const STATUS_META: Record<number, { label: string; badge: string; dot: string }> = {
  0: { label: "New", badge: "bg-ink-100 text-ink-600", dot: "bg-ink-400" },
  1: { label: "Offered", badge: "bg-amber-100 text-amber-700", dot: "bg-amber-500" },
  2: { label: "Accepted", badge: "bg-blue-100 text-blue-700", dot: "bg-blue-500" },
  3: { label: "En route", badge: "bg-violet-100 text-violet-700", dot: "bg-violet-500" },
  4: { label: "Arrived", badge: "bg-brand-100 text-brand-700", dot: "bg-brand-500" },
  5: { label: "Completed", badge: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" },
  6: { label: "Complete", badge: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" },
  255: { label: "Cancelled", badge: "bg-danger-100 text-danger-600", dot: "bg-danger-500" },
};
export const etaLabel = (iso: string | null): string => {
  if (!iso) return "ETA not set";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

export type GpsState = "idle" | "tracking" | "denied" | "unsupported" | "error";
/** GPS ping loop (milestone #3): while the driver has a job in en_route or
 *  arrived, capture browser geolocation every ~20s and ping the platform
 *  (driver_locations + best-effort Towbook checkin + geofence auto-arrive).
 *  Never throws, never blocks the job queue. */
export function useDriverGps(calls: DriverCall[] | null): GpsState {
  const [state, setState] = useState<GpsState>("idle");
  const activeJobRef = useRef<string | null>(null);
  useEffect(() => {
    const active = calls?.find((c) => c.statusId === 3 || c.statusId === 4);
    activeJobRef.current = active ? active.id : null;
  }, [calls]);
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState("unsupported");
      return;
    }
    let stopped = false;
    let lastFixAt = 0;
    const tick = () => {
      const jobId = activeJobRef.current;
      if (!jobId) { setState((s) => (s === "tracking" ? "idle" : s)); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (stopped) return;
          lastFixAt = Date.now();
          setState("tracking");
          void pingDriverLocation({
            data: {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
              jobTowbookId: jobId,
            },
          }).catch(() => { /* a failed ping never breaks the loop */ });
        },
        (err) => {
          if (stopped) return;
          if (err && err.code === err.PERMISSION_DENIED) setState("denied");
          else if (Date.now() - lastFixAt > 60000) setState("error");
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 },
      );
    };
    tick();
    const t = setInterval(tick, 20000);
    return () => { stopped = true; clearInterval(t); };
  }, []);
  return state;
}
const GPS_CHIP: Record<GpsState, { label: string; tone: string; icon: typeof Radar }> = {
  tracking: { label: "Live tracking on — sending your position every 20 seconds", tone: "bg-success-50 text-success-700", icon: Radar },
  idle: { label: "Location pings active once you're en route to a job", tone: "bg-ink-50 text-ink-500", icon: Radar },
  denied: { label: "Location access is off — allow location for live tracking and auto-arrival", tone: "bg-amber-50 text-amber-800", icon: MapPin },
  unsupported: { label: "This browser can't provide location — tracking unavailable", tone: "bg-ink-50 text-ink-500", icon: MapPin },
  error: { label: "Temporarily can't get your position — will keep retrying", tone: "bg-amber-50 text-amber-800", icon: MapPin },
};
export function GpsStatusChip({ state }: { state: GpsState }) {
  const meta = GPS_CHIP[state] ?? GPS_CHIP.idle;
  const Icon = meta.icon;
  return (
    <p className={`mb-4 flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium ${meta.tone}`}>
      <Icon className="size-4 shrink-0" /> {meta.label}
    </p>
  );
}

/** Live queue + actions for any driver page. Every mutation is idempotent
 *  server-side (a re-tap is a no-op); a dead Towbook session surfaces the
 *  "reconnect" banner instead of failing silently. */
export function useDriverQueue() {
  const nav = useNavigate();
  const toast = useToast();
  const [calls, setCalls] = useState<DriverCall[] | null>(null);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const gpsState = useDriverGps(calls);
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    const r = await driverJobs();
    if (r.ok) { setCalls(r.calls); setError(""); setExpired(false); }
    else { if (r.expired) setExpired(true); setError(r.message); }
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), 20000); // keep the queue live
    return () => clearInterval(t);
  }, [load]);
  const act = async (callId: string, action: "accept" | "en_route") => {
    if (acting) return;
    setActing(callId); setError("");
    try {
      const r = await driverJobAction({ data: { jobId: callId, action } });
      if (r.ok) {
        toast(r.changed ? "Towbook updated — job is live." : "Already applied — nothing to do.");
        await load(true);
      } else {
        if (r.expired) setExpired(true);
        else toast(r.message);
      }
    } catch {
      toast("Update failed — check your connection and try again.");
    } finally {
      setActing(null);
    }
  };
  const signOut = async () => {
    await driverLogout(); // best-effort Towbook checkout so we're not left "online"
    void nav({ to: "/login", replace: true });
  };
  return { calls, error, expired, loading, acting, load, act, signOut, gpsState };
}

/** Refresh + sound + sign-out row shared by every driver page. */
export function DriverToolbar({ loading, onRefresh, onSignOut }: { loading: boolean; onRefresh: () => void; onSignOut: () => void }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <SoundToggle role="driver" />
        <Button variant="ghost" size="sm" onClick={onSignOut}><LogOut className="size-4" /> Sign out</Button>
      </div>
    </div>
  );
}

/** Expired-session banner with a reconnect (sign out → login) action. */
export function ExpiredBanner({ onReconnect }: { onReconnect: () => void }) {
  return (
    <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-800">Your Towbook session expired.</p>
      <p className="mt-1 text-xs text-amber-700">Sign in again to keep receiving and updating jobs.</p>
      <Button className="mt-3" size="sm" onClick={onReconnect}>Reconnect — sign in again</Button>
    </div>
  );
}

export function QueueSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      {[0, 1].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-ink-100/70" />)}
    </div>
  );
}

export function DriverJobCard({ call, acting, onAct, onQueueChanged }: { call: DriverCall; acting: boolean; onAct: (id: string, a: "accept" | "en_route") => Promise<void>; onQueueChanged: () => void }) {
  const meta = STATUS_META[call.statusId] ?? { label: `Status ${call.statusId}`, badge: "bg-ink-100 text-ink-600", dot: "bg-ink-400" };
  const address = [call.pickupAddress, call.zip].filter(Boolean).join(", ");
  const jobStatus = call.statusId === 3 ? "en_route" : call.statusId === 4 ? "arrived" : call.statusId === 5 ? "completed" : "other";
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Call #{call.callNumber}</p>
          <p className="text-base font-bold text-ink-800">{call.serviceName}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.badge}`}>
          <span className={`size-1.5 rounded-full ${meta.dot}`} /> {meta.label}
        </span>
      </div>
      <dl className="space-y-2 text-sm">
        {address && (
          <div className="flex gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-brand-600" /><dd className="text-ink-700">{address}</dd></div>
        )}
        {call.vehicle && (
          <div className="flex gap-2"><Truck className="mt-0.5 size-4 shrink-0 text-ink-400" /><dd className="text-ink-700">{call.vehicle}</dd></div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
          <span>ETA: <strong className="font-semibold text-ink-700">{etaLabel(call.arrivalETA)}</strong></span>
          {call.purchaseOrderNumber && <span>PO: <strong className="font-semibold text-ink-700">{call.purchaseOrderNumber}</strong></span>}
        </div>
      </dl>
      {call.statusId === 1 && (
        <Button className="mt-4 w-full" loading={acting} onClick={() => void onAct(call.id, "accept")}>
          <ThumbsUp className="size-5" /> Accept — I&apos;m on it
        </Button>
      )}
      {call.statusId === 2 && (
        <Button className="mt-4 w-full" loading={acting} onClick={() => void onAct(call.id, "en_route")}>
          <Navigation className="size-5" /> En route — started heading over
        </Button>
      )}
      {call.statusId === 3 && (
        <p className="mt-4 flex items-center gap-2 rounded-xl bg-violet-50 p-3 text-center text-sm font-medium text-violet-700">
          <Navigation className="size-4 shrink-0" /> On the way — take the arrival photos when you reach the vehicle.
        </p>
      )}
      {call.statusId === 4 && (
        <p className="mt-4 flex items-center gap-2 rounded-xl bg-brand-50 p-3 text-center text-sm font-medium text-brand-700">
          <Check className="size-4 shrink-0" /> You&apos;ve arrived — finish the photo steps to complete the job.
        </p>
      )}
      {(call.statusId === 3 || call.statusId === 4) && (
        <JobPhotoFlow callId={call.id} jobStatus={jobStatus} onCompleted={onQueueChanged} />
      )}
      <JobDetailDisclosure jobId={call.id} label="Details & photos" />
    </Card>
  );
}

export function DriverBanners({ calls, expired, error, onReconnect }: { calls: DriverCall[] | null; expired: boolean; error: string; onReconnect: () => void }) {
  return (
    <>
      <DriverNotificationBanners calls={calls} />
      {expired && <ExpiredBanner onReconnect={onReconnect} />}
      {error && !expired && <p role="alert" className="mb-4 rounded-xl bg-danger-50 p-3 text-sm text-danger-600">{error}</p>}
    </>
  );
}

/** Shared "nothing here" empty state for the segmented driver pages. */
export function DriverEmptyState({ icon, title, body }: { icon: typeof Truck; title: string; body: string }) {
  const Icon = icon;
  return (
    <Card className="p-8 text-center">
      <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-ink-100"><Icon className="size-6 text-ink-400" /></div>
      <p className="font-semibold text-ink-700">{title}</p>
      <p className="mt-1 text-sm text-ink-400">{body}</p>
    </Card>
  );
}
