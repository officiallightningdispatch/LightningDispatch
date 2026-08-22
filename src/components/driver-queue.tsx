/**
 * Shared driver-portal building blocks (2026-08-11): the Towbook-backed job
 * queue card, the GPS tracking loop/chip, and the queue hook. Extracted from
 * driver-portal.tsx so every driver page — Home (/driver), Offers
 * (/driver/offers), Active (/driver/active) — renders the SAME card and the
 * SAME live queue instead of placeholder shells. Client-safe: only imports
 * createServerFn wrappers (driver-auth), never server-only modules.
 */
import { useNavigate } from "@tanstack/react-router";
import { Check, LogOut, MapPin, Navigation, Radar, RefreshCw, ThumbsUp, Truck, Unplug, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BatterySalesAgent, isJumpstartService } from "~/components/battery-agent-ui";
import { TirePlugOffer } from "~/components/tire-plug-ui";
import { JobDetailDisclosure } from "~/components/job-detail";
import { JobPhotoFlow } from "~/components/driver-photos-ui";
import { DriverNotificationBanners, SoundToggle } from "~/components/notify-banners";
import { Button, Card, useToast } from "~/components/ui";
import { driverJobAction, driverJobs, driverLogout, driverReconnect, driverReconnectContext, type DriverCall } from "~/data/driver-auth";
import { orderDriverQueue } from "~/lib/driver-queue-core";
import { PUSH_RECEIVED_MESSAGE_TYPE } from "~/lib/push-received";
import { useDriverGpsState, type DriverGpsState } from "~/components/driver-gps-tracker";

export const STATUS_META: Record<number, { label: string; badge: string; dot: string }> = {
  0: { label: "New", badge: "bg-ink-100 text-ink-600", dot: "bg-ink-400" },
  1: { label: "Offered", badge: "bg-amber-100 text-amber-700", dot: "bg-amber-500" },
  2: { label: "En route", badge: "bg-violet-100 text-violet-700", dot: "bg-violet-500" },
  3: { label: "On scene", badge: "bg-brand-100 text-brand-700", dot: "bg-brand-500" },
  4: { label: "Towing", badge: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" },
  5: { label: "Completed", badge: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" },
  6: { label: "Complete", badge: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" },
  // Towbook's terminal completion acknowledgement is 252. Keep it explicit
  // rather than allowing the unknown-status fallback to mislabel real work.
  252: { label: "Completed", badge: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" },
  255: { label: "Cancelled", badge: "bg-danger-100 text-danger-600", dot: "bg-danger-500" },
};
export const etaLabel = (iso: string | null): string => {
  if (!iso) return "ETA not set";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

export type GpsState = DriverGpsState;
/** The GPS tracker is mounted once by DriverGate and is deliberately not tied
 * to a queue call, Lightning GO state, or a foreground-only job screen. */
export function useDriverGps(_calls: DriverCall[] | null): GpsState {
  return useDriverGpsState();
}
const GPS_CHIP: Record<GpsState, { label: string; tone: string; icon: typeof Radar }> = {
  tracking: { label: "Live tracking on — sending your real position", tone: "bg-success-50 text-success-700", icon: Radar },
  idle: { label: "Location sharing starts while you're signed in", tone: "bg-ink-50 text-ink-500", icon: Radar },
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
  /** Terminal-inclusive snapshot (completed 5/6/252 + cancelled 255 still
   *  present) for the cancellation-banner diff. `calls` is the active-only
   *  ordered queue (orderDriverQueue strips terminal statuses), so a completed
   *  job would otherwise VANISH from `calls` and be misread as cancelled. The
   *  banner must read THIS raw list to key off the authoritative Towbook status. */
  const [allCalls, setAllCalls] = useState<DriverCall[] | null>(null);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [driverLocation, setDriverLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const gpsState = useDriverGps(calls);
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      (p) => setDriverLocation({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => { /* queue remains safe when location is unavailable */ },
      { enableHighAccuracy: true, maximumAge: 20000, timeout: 12000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, []);
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    const r = await driverJobs();
    if (r.ok) { setCalls(orderDriverQueue(r.calls, driverLocation)); setAllCalls(r.calls); setError(""); setExpired(false); }
    else { if (r.expired) setExpired(true); setError(r.message); }
    setLoading(false);
  }, [driverLocation]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), 20000); // fallback safety net
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return () => clearInterval(t);
    }
    const onPushReceived = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null | undefined;
      if (!data || data.type !== PUSH_RECEIVED_MESSAGE_TYPE) return;
      void load(true);
    };
    navigator.serviceWorker.addEventListener("message", onPushReceived);
    return () => {
      clearInterval(t);
      navigator.serviceWorker.removeEventListener("message", onPushReceived);
    };
  }, [load]);
  const act = async (callId: string, action: "accept" | "en_route" | "arrive") => {
    if (acting) return;
    setActing(callId); setError("");
    try {
      const r = await driverJobAction({ data: { jobId: callId, action } });
      if (r.ok) {
        toast(r.changed ? "Job updated — it's live." : "Already applied — nothing to do.");
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
  /** Reconnect (auth incident 2026-08-13): the expired chip used to sign the
   *  whole LD session out and dump the user on /login — a dead end for
   *  owner-with-linked-driver sessions (re-login as the owner never refreshes
   *  the linked driver's stored Towbook session, so the driver view stayed
   *  expired forever). Now the chip opens an IN-PLACE reconnect sheet that
   *  re-authenticates the driver against Towbook and refreshes the stored
   *  driver session without touching the LD session. After a successful
   *  reconnect the queue reloads and the expired state clears. */
  const openReconnect = useCallback(() => setReconnectOpen(true), []);
  const closeReconnect = useCallback(() => setReconnectOpen(false), []);
  const onReconnected = useCallback(() => { void load(true); }, [load]);
  return { calls, allCalls, error, expired, loading, acting, load, act, signOut, gpsState, reconnectOpen, openReconnect, closeReconnect, onReconnected };
}

/** In-place driver-session reconnect sheet (auth incident 2026-08-13). Shown
 *  when the queue reports the stored Towbook session is dead. The driver's
 *  dispatch username is pre-filled (from the effective driver's login_handle —
 *  for an owner in driver view this is the LINKED driver's username, e.g.
 *  24hourbattery); the user enters that driver's dispatch password and the
 *  server re-authenticates + persists a fresh session. The LD session is never
 *  touched, so the owner stays signed in — reconnect retains the intended
 *  portal. "Sign out instead" remains as the escape hatch. */
export function DriverReconnectSheet({ open, onClose, onReconnected, onSignOut }: {
  open: boolean;
  onClose: () => void;
  onReconnected: () => void;
  onSignOut: () => void;
}) {
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setPassword(""); setError(""); setBusy(false);
    void driverReconnectContext().then((r) => { if (r.ok && r.username) setUsername(r.username); }).catch(() => { /* empty username is still editable */ });
  }, [open]);
  if (!open) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const r = await driverReconnect({ data: { username: username.trim(), password } });
      if (r.ok) {
        toast("Driver session reconnected.");
        onReconnected();
        onClose();
      } else {
        setError(r.message);
      }
    } catch {
      setError("Reconnect failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-40 bg-ink-950/40 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Reconnect driver session" onClick={onClose}>
      <div className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-3xl bg-surface p-4 pb-6 shadow-[0_-8px_24px_rgba(14,14,17,0.16)]" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-ink-200" aria-hidden="true" />
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-amber-100 text-amber-700"><Unplug className="size-4" aria-hidden="true" /></span>
            <div>
              <p className="text-base font-bold text-ink-800">Reconnect your driver session</p>
              <p className="text-xs text-ink-500">Your dispatch session expired — jobs and actions are paused until you reconnect.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-9 shrink-0 place-items-center rounded-full text-ink-400 hover:bg-ink-50"><X className="size-4" /></button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm font-semibold text-ink-700">
            Dispatch username
            <input required type="text" autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. 24hourbattery"
              className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3 text-sm" />
          </label>
          <label className="block text-sm font-semibold text-ink-700">
            Dispatch password
            <input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="Your dispatch password"
              className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3 text-sm" />
          </label>
          {error && <p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-600">{error}</p>}
          <Button type="submit" loading={busy} className="w-full"><Unplug className="size-4" /> Reconnect</Button>
          <button type="button" onClick={onSignOut} className="flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-ink-500 hover:bg-ink-50">
            <LogOut className="size-3.5" /> Sign out instead
          </button>
        </form>
      </div>
    </div>
  );
}

/** Refresh + sound + sign-out row shared by every driver page. */
export function DriverToolbar({ loading, onRefresh, onSignOut }: { loading: boolean; onRefresh: () => void; onSignOut?: () => void }) {
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
      <p className="text-sm font-semibold text-amber-800">Your session expired.</p>
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

/** The dominant per-stage action block shared by DriverJobCard and the R2
 *  bottom sheets (TripSheet/HomeSheet): Accept → En route → photo callouts +
 *  JobPhotoFlow → detail disclosure. One source of truth for the act() wiring. */
export function JobCardActions({ call, acting, onAct, onQueueChanged }: { call: DriverCall; acting: boolean; onAct: (id: string, a: "accept" | "en_route" | "arrive") => Promise<void>; onQueueChanged: () => void }) {
  const jobStatus = call.statusId === 2 ? "en_route" : call.statusId === 3 ? "arrived" : call.statusId === 5 ? "completed" : "other";
  return (
    <>
      {call.statusId === 1 && (
        <Button className="mt-4 w-full" loading={acting} onClick={() => void onAct(call.id, "accept")}>
          <ThumbsUp className="size-5" /> Accept &amp; go — I&apos;m on it
        </Button>
      )}
      {call.statusId === 2 && (
        <>
          <Button className="mt-4 w-full" loading={acting} onClick={() => void onAct(call.id, "arrive")}>
            <MapPin className="size-5" /> I&apos;m on scene — arrived
          </Button>
          <Button className="mt-2 w-full" variant="ghost" loading={acting} onClick={() => void onAct(call.id, "en_route")}>
            <Navigation className="size-5" /> En route — started heading over
          </Button>
        </>
      )}
      {call.statusId === 3 && (
        <p className="mt-4 flex items-center gap-2 rounded-xl bg-violet-50 p-3 text-center text-sm font-medium text-violet-700">
          <Check className="size-4 shrink-0" /> You&apos;re on scene — take the arrival photos, then the service photos.
        </p>
      )}
      {call.statusId === 4 && (
        <p className="mt-4 flex items-center gap-2 rounded-xl bg-brand-50 p-3 text-center text-sm font-medium text-brand-700">
          <Navigation className="size-4 shrink-0" /> Towing — keep going until the drop-off is complete.
        </p>
      )}
      {(call.statusId === 2 || call.statusId === 3) && (
        <JobPhotoFlow callId={call.id} jobStatus={jobStatus} onCompleted={onQueueChanged} />
      )}
      {(call.statusId === 3 || call.statusId === 4) && isJumpstartService(call.serviceName) && (
        <BatterySalesAgent callId={call.id} />
      )}
      {(call.statusId === 3 || call.statusId === 4) && /tire[ _-]*(change|service)|tyre/i.test(call.serviceName || "") && (
        <TirePlugOffer jobId={call.id} />
      )}
      <JobDetailDisclosure jobId={call.id} label="Details & photos" />
    </>
  );
}

export function DriverJobCard({ call, acting, onAct, onQueueChanged }: { call: DriverCall; acting: boolean; onAct: (id: string, a: "accept" | "en_route" | "arrive") => Promise<void>; onQueueChanged: () => void }) {
  const meta = STATUS_META[call.statusId] ?? { label: `Status ${call.statusId}`, badge: "bg-ink-100 text-ink-600", dot: "bg-ink-400" };
  const address = [call.pickupAddress, call.zip].filter(Boolean).join(", ");
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
      <JobCardActions call={call} acting={acting} onAct={onAct} onQueueChanged={onQueueChanged} />
    </Card>
  );
}

export function DriverBanners({ calls, allCalls, expired, error, onReconnect }: { calls: DriverCall[] | null; allCalls?: DriverCall[] | null; expired: boolean; error: string; onReconnect: () => void }) {
  return (
    <>
      <DriverNotificationBanners calls={calls} allCalls={allCalls} />
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
