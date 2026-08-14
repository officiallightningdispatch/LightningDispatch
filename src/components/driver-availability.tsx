/**
 * AvailabilityPill + useAvailability — the Uber-style GO/Offline pill (R2 spec
 * §c item 4, lead interim 2026-08-11).
 *
 * SEMANTICS: GO persists server-side; the heartbeat keeps the availability
 * lease fresh. Closing the tab lets that lease expire after 90 seconds, so a
 * driver is never falsely available forever. STOP removes the lease immediately.
 * The AI-dispatch path still uses Towbook's nearest-driver lookup (not this
 * availability table), while ops-center manual assignment, roster online state,
 * and zone preference use the lease.
 */
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { driverSetAvailability, driverAvailabilityHeartbeat, AVAILABILITY_HEARTBEAT_INTERVAL_MS } from "~/data/driver-auth";
import { useToast } from "~/components/ui";

const AVAIL_KEY = "lightning-driver-availability-v1";
function driverKey(): string {
  try { return `${AVAIL_KEY}:${localStorage.getItem("lightning-contractor-identity-v1") ?? "current"}`; } catch { return `${AVAIL_KEY}:current`; }
}

export function useAvailability(zone: { zoneId: string | null } | null, onNeedZone?: () => void) {
  const toast = useToast();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(driverKey()) === "off") setOnline(false);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!online) return;
    let stopped = false;
    const id = window.setInterval(() => {
      void driverAvailabilityHeartbeat({ data: undefined }).then((result) => {
        if (stopped || result.ok) return;
        // The server has dropped the lease (or cannot refresh it). Never leave
        // the pill claiming GO after a failed heartbeat.
        stopped = true;
        window.clearInterval(id);
        setOnline(false);
        try { localStorage.setItem(driverKey(), "off"); } catch { /* ignore */ }
        toast(result.message ?? "Availability expired — tap GO to reconnect.");
      }).catch(() => {
        if (stopped) return;
        stopped = true;
        window.clearInterval(id);
        setOnline(false);
        try { localStorage.setItem(driverKey(), "off"); } catch { /* ignore */ }
        toast("Availability expired — check your connection, then tap GO.");
      });
    }, AVAILABILITY_HEARTBEAT_INTERVAL_MS);
    return () => { stopped = true; window.clearInterval(id); };
  }, [online, toast]);
  const toggle = useCallback(async () => {
    const target = !online;
    const zid = zone?.zoneId ?? null;
    if (target && !zid) { onNeedZone?.(); toast("Pick a zone before going online."); return; }
    setOnline(target);
    setPending(true);
    try {
      const r = await driverSetAvailability({ data: target ? { online: true, zoneId: zid! } : { online: false } });
      if (!r.ok) {
        setOnline(!target);
        toast(r.message ?? "Couldn't update availability — try again.");
      }
    } catch {
      setOnline(!target);
      toast("Couldn't update availability — check your connection.");
    } finally {
      setPending(false);
    }
    try {
      localStorage.setItem(driverKey(), target ? "on" : "off");
    } catch { /* ignore */ }
  }, [online, toast]);

  return { online, pending, toggle };
}

export function AvailabilityPill({
  online,
  pending,
  onToggle,
}: {
  online: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={pending}
      aria-pressed={online}
      title={online ? "GO — you're actively working. Tap to go Offline." : "Offline — you can still be assigned. Tap to GO."}
      className={`flex h-11 min-w-[6.5rem] items-center justify-center gap-2 rounded-full px-4 text-sm font-bold transition-all duration-150 active:scale-95 motion-reduce:transform-none disabled:pointer-events-none disabled:opacity-60 ${
        online ? "bg-brand-500 text-white shadow-card" : "bg-ink-950 text-white"
      }`}
    >
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      <span>{online ? "GO" : "Offline"}</span>
    </button>
  );
}
