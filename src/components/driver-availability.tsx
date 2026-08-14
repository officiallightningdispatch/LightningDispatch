/**
 * AvailabilityPill + useAvailability — the Uber-style GO/Offline pill (R2 spec
 * §c item 4, lead interim 2026-08-11).
 *
 * SEMANTICS (lead-decided interim): the pill is a VISIBLE availability control
 * that performs a real Towbook checkin/checkout (driverSetAvailability). GO =
 * actively working / checked in; Offline = still assignable and reachable via
 * push (per the owner's dispatch directive the AI picks the next available AND
 * closest driver — even if offline), so the pill NEVER blocks assignment.
 * The local state is persisted per-driver (localStorage); actual pool
 * semantics get wired when the owner confirms (spec §e Q2).
 */
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { driverSetAvailability } from "~/data/driver-auth";
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

  const toggle = useCallback(async () => {
    const target = !online;
    if (target && !zone?.zoneId) { onNeedZone?.(); toast("Pick a zone before going online."); return; }
    setOnline(target);
    setPending(true);
    try {
      const r = await driverSetAvailability({ data: target ? { online: true, zoneId: zone.zoneId } : { online: false } });
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
