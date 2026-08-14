import { useEffect, useState } from "react";
import { Alert, Button, StatusBadge, useToast } from "~/components/ui";
import { driverSelectZone, getZonesWithBusyness } from "~/data/zones";
export type DriverZoneState = { ok: true; zoneId: string | null; zoneName: string | null; zoneChangedAt: string | null; zoneChangeCount: number; canChangeToday: boolean; selectionOpen: boolean } | { ok: false; message: string };

export type ZoneSummary = { id: string; name: string; busyness: "Low" | "Moderate" | "Busy"; availableDrivers: number; activeJobs: number; recentVolume24h: number; demandRatio: number; radiusMiles: number; tz: string };

const badge: Record<ZoneSummary["busyness"], string> = { Low: "bg-success-50 text-success-700", Moderate: "bg-accent-50 text-accent-800", Busy: "bg-danger-50 text-danger-700" };
export function DriverZonePicker({ open, onClose, state, onSelected }: { open: boolean; onClose: () => void; state: DriverZoneState | null; onSelected: () => void }) {
  const toast = useToast(); const [zones, setZones] = useState<ZoneSummary[]>([]); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) void getZonesWithBusyness().then((r) => setZones(r as ZoneSummary[])).catch(() => toast("Couldn't load zones — check your connection.")); }, [open, toast]);
  if (!open) return null;
  const locked = state?.ok === true && (!state.selectionOpen || !state.canChangeToday);
  const lockMessage = state?.ok === true && !state.selectionOpen ? "Zone selection opens at 6:00 AM local" : state?.ok === true && !state.canChangeToday ? "You can change your zone only once per day." : "";
  const select = async (zoneId: string) => { setBusy(true); const r = await driverSelectZone({ data: { zoneId } }); setBusy(false); if (!r.ok) { toast(r.message); return; } toast("Zone selected"); onSelected(); onClose(); };
  return <div className="fixed inset-0 z-40 bg-ink-950/40" role="dialog" aria-modal="true" aria-label="Choose your zone" onClick={onClose}>
    <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-surface p-4 pb-8 shadow-xl" onClick={(e) => e.stopPropagation()}>
      <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-ink-200" /><div className="flex items-center justify-between"><div><h2 className="text-lg font-bold">Choose your zone</h2><p className="mt-1 text-xs text-ink-500">Busyness is based on real jobs and available drivers.</p></div><Button size="sm" variant="ghost" onClick={onClose}>Close</Button></div>
      {lockMessage && <div className="mt-4"><Alert variant="warning">{lockMessage}</Alert></div>}
      <div className="mt-4 space-y-2">{zones.map((z) => <button key={z.id} type="button" disabled={locked || busy} onClick={() => void select(z.id)} className="w-full rounded-2xl border border-ink-100 p-4 text-left transition-colors hover:bg-ink-50 disabled:opacity-50"><div className="flex items-center justify-between gap-2"><span className="font-bold">{z.name}</span><StatusBadge className={badge[z.busyness]} dot>{z.busyness}</StatusBadge></div><p className="mt-2 text-xs text-ink-500">{z.availableDrivers} drivers online · {z.activeJobs} active jobs · {z.recentVolume24h} calls in 24h</p><p className="mt-1 text-[11px] text-ink-400">Demand ratio {z.demandRatio.toFixed(2)} · {z.radiusMiles} mi radius</p></button>)}</div>
      {!zones.length && <p className="py-8 text-center text-sm text-ink-500">No active zones available.</p>}
    </div></div>;
}
