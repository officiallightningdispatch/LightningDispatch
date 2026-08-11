/**
 * Real driver portal v1 (owner-directed 2026-08-11): the Towbook-backed job
 * queue. Rendered by /driver when a contractor is signed in via the unified
 * login (their platform credentials ARE their Towbook login). Jobs come from
 * GET /api/calls scoped to this driver's session; thumbs-up → en route is a
 * PUT via the DRIVER's own Towbook session with an LD write-through so the
 * owner and ops portals see the change immediately (the 30s sync re-confirms).
 *
 * Every mutation is idempotent server-side (a re-tap is a no-op); a dead
 * Towbook session surfaces a "reconnect" prompt instead of failing silently.
 */
import { useNavigate } from "@tanstack/react-router";
import { LogOut, MapPin, Navigation, RefreshCw, ThumbsUp, Truck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { Button, Card, useToast } from "~/components/ui";
import { driverJobAction, driverJobs, driverLogout, type DriverCall } from "~/data/driver-auth";

const STATUS_META: Record<number, { label: string; badge: string; dot: string }> = {
  0: { label: "New", badge: "bg-ink-100 text-ink-600", dot: "bg-ink-400" },
  1: { label: "Offered", badge: "bg-amber-100 text-amber-700", dot: "bg-amber-500" },
  2: { label: "Accepted", badge: "bg-blue-100 text-blue-700", dot: "bg-blue-500" },
  3: { label: "En route", badge: "bg-violet-100 text-violet-700", dot: "bg-violet-500" },
  4: { label: "Arrived", badge: "bg-brand-100 text-brand-700", dot: "bg-brand-500" },
  5: { label: "Completed", badge: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" },
  6: { label: "Complete", badge: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" },
  255: { label: "Cancelled", badge: "bg-danger-100 text-danger-600", dot: "bg-danger-500" },
};
const etaLabel = (iso: string | null): string => {
  if (!iso) return "ETA not set";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

export function RealDriverPortal() {
  const nav = useNavigate();
  const toast = useToast();
  const [calls, setCalls] = useState<DriverCall[] | null>(null);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null); // callId being acted on

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
        if (r.expired) { setExpired(true); }
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

  return (
    <AppShell portal="driver" title="My jobs" description="Offers and active calls from the dispatch board — status stays in sync with Towbook.">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void load(false)} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void signOut()}><LogOut className="size-4" /> Sign out</Button>
      </div>

      {expired && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-800">Your Towbook session expired.</p>
          <p className="mt-1 text-xs text-amber-700">Sign in again to keep receiving and updating jobs.</p>
          <Button className="mt-3" size="sm" onClick={() => void signOut()}>Reconnect — sign in again</Button>
        </div>
      )}
      {error && !expired && <p role="alert" className="mb-4 rounded-xl bg-danger-50 p-3 text-sm text-danger-600">{error}</p>}

      {loading && calls === null ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-ink-100/70" />)}
        </div>
      ) : calls !== null && calls.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-ink-100"><Truck className="size-6 text-ink-400" /></div>
          <p className="font-semibold text-ink-700">No jobs right now</p>
          <p className="mt-1 text-sm text-ink-400">New offers from the AI dispatcher will appear here automatically. We refresh every 20 seconds.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {calls?.map((c) => <DriverJobCard key={c.id} call={c} acting={acting === c.id} onAct={act} />)}
        </div>
      )}
    </AppShell>
  );
}

function DriverJobCard({ call, acting, onAct }: { call: DriverCall; acting: boolean; onAct: (id: string, a: "accept" | "en_route") => Promise<void> }) {
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
      {(call.statusId === 3 || call.statusId === 4) && (
        <p className="mt-4 rounded-xl bg-ink-50 p-3 text-center text-sm font-medium text-ink-600">
          {call.statusId === 3 ? "On the way — keep the app open for arrival." : "You've arrived — the next steps unlock after arrival."}
        </p>
      )}
    </Card>
  );
}
