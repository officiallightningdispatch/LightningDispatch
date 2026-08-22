/**
 * Real driver portal — Home (/driver), R2 Uber-style redesign (2026-08-11):
 * slim shell + full-bleed LiveMap hero + GO/Offline availability pill + "?"
 * Help icon in the header + the draggable HomeSheet (peek: one prominent job
 * front-and-center + earnings strip; expanded: full job + "More offers" list).
 *
 * Real (Towbook-backed) mode only. Jobs come from GET /api/calls scoped to
 * this driver's session (useDriverQueue, 20s poll); the map keeps its own 15s
 * poll. No demo/seed data anywhere — when the queue is empty/errored the sheet
 * shows the honest empty state and the map still renders (self + nearby pins).
 */
import { CircleHelp, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { DriverClaimReviewCard } from "~/components/claims-ui";
import { AvailabilityPill, useAvailability } from "~/components/driver-availability";
import { useRequoteFlash } from "~/components/driver-eta";
import { HomeSheet, MapChips, type HomeEarnings } from "~/components/driver-sheets";
import { DriverReconnectSheet, useDriverQueue } from "~/components/driver-queue";
import { LiveMap } from "~/components/live-map";
import { DriverNotificationBanners } from "~/components/notify-banners";
import { PushNotificationSetup, PushPermissionCard } from "~/components/push-setup";
import { getMyCompliance } from "~/data/contractor-admin";
import { driverEarnings } from "~/data/driver-auth";
import { NativeContractorStatus } from "~/components/native-contractor-status";
import { DriverZonePicker, type DriverZoneState } from "~/components/driver-zone-picker";
import { getMyZoneState } from "~/data/zones";

/** Home compliance chip (contractor-admin part 3, owner-directed 2026-08-12):
 *  over the map hero when required docs aren't all approved — yellow "N docs
 *  needed — tap to upload" (the ONE accent attention chip on the driver side);
 *  a calmer brand chip when everything's uploaded but the owner's review is
 *  still pending. Either state explains why GO stays blocked (the pill toast
 *  gives the full message). Tapping opens the Documents screen. */
export function ComplianceHomeChip() {
  const nav = useNavigate();
  const [needed, setNeeded] = useState(0);
  const [pending, setPending] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void getMyCompliance().then((r) => {
      if (!live || !r.ok) return;
      setNeeded(r.data.neededCount);
      setPending(r.data.pendingCount);
      setReady(true);
    }).catch(() => { /* hide silently */ });
    return () => { live = false; };
  }, []);
  if (!ready || (needed === 0 && pending === 0)) return null;
  const needsAction = needed > 0;
  return (
    <button
      type="button"
      onClick={() => void nav({ to: "/driver/documents" })}
      className={`absolute left-1/2 top-14 z-20 flex w-max max-w-[92vw] -translate-x-1/2 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold shadow-card transition-transform active:scale-95 ${
        needsAction ? "bg-accent-400 text-ink-950" : "bg-surface text-ink-700 ring-1 ring-ink-200"
      }`}
    >
      <FileText className="size-3.5 shrink-0" aria-hidden="true" />
      {needsAction
        ? `${needed} doc${needed === 1 ? "" : "s"} needed — tap to upload`
        : `${pending} doc${pending === 1 ? "" : "s"} awaiting the owner's review — tap to view`}
    </button>
  );
}

function HelpIcon({ className = "" }: { className?: string }) {
  const nav = useNavigate();
  return (
    <button
      type="button"
      onClick={() => void nav({ to: "/driver/help" })}
      aria-label="Help & support"
      title="Help & support"
      className={`grid size-11 place-items-center rounded-full text-ink-500 transition-colors hover:bg-ink-50 ${className}`}
    >
      <CircleHelp className="size-6" />
    </button>
  );
}

const ACTIVE_STATUSES = [2, 3, 4];

export function RealDriverPortal() {
  const nav = useNavigate();
  const { calls, allCalls, error, expired, loading, acting, load, act, signOut, gpsState, reconnectOpen, openReconnect, closeReconnect, onReconnected } = useDriverQueue();
  const [zone, setZone] = useState<DriverZoneState | null>(null);
  const [zoneOpen, setZoneOpen] = useState(false);
  const loadZone = () => { void getMyZoneState().then((r) => setZone(r as DriverZoneState)).catch(() => setZone(null)); };
  useEffect(() => { loadZone(); }, []);
  const { online, pending, toggle } = useAvailability(zone?.ok ? zone : null, () => setZoneOpen(true));
  const [snap, setSnap] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [earnings, setEarnings] = useState<HomeEarnings>(null);

  useEffect(() => {
    if (calls !== null) setLastUpdated(new Date());
  }, [calls]);

  // Earnings strip — honest "N completed · $X in tips". Errors hide it silently.
  useEffect(() => {
    let live = true;
    void driverEarnings().then((r) => {
      if (!live || !r.ok) return;
      setEarnings({ completed: r.totals.completedJobs, tipsCents: r.totals.tipsTotalCents });
    }).catch(() => { /* hide silently */ });
    return () => { live = false; };
  }, []);

  const active = calls?.filter((c) => ACTIVE_STATUSES.includes(c.statusId)) ?? [];
  const offers = calls?.filter((c) => c.statusId === 1) ?? [];
  // History (owner-directed 2026-08-12): completed (5/6/252) + cancelled (255)
  // calls leave Active/Offers and render as the expanded HomeSheet History
  // list with a distinct Cancelled badge — Uber-style.
  const history =
    calls?.filter((c) => c.statusId === 5 || c.statusId === 6 || c.statusId === 252 || c.statusId === 255) ?? [];
  const primary = active[0] ?? offers[0] ?? null;
  // Keep every live assigned job in the sheet; the first is the next stop and
  // the remainder stay visible beneath it (offers remain available too).
  const moreOffers = [...active.slice(1), ...offers.filter((c) => c.id !== primary?.id)];
  const flash = useRequoteFlash(primary);

  const chips: { kind: "error" | "expired"; text: string; onAction?: () => void }[] = [];
  if (expired) chips.push({ kind: "expired", text: "Your session expired — tap to reconnect.", onAction: () => void openReconnect() });
  else if (error) chips.push({ kind: "error", text: error });

  return (
    <AppShell
      portal="driver"
      slim
      title="Home"
      description=""
      headerActions={
        <>
          <button type="button" onClick={() => setZoneOpen(true)} className="block max-w-[7.5rem] truncate rounded-full border border-ink-200 bg-surface px-3 py-2 text-xs font-bold text-ink-700 sm:max-w-[10rem]">{zone?.ok && zone.zoneName ? zone.zoneName : "Choose zone"}</button>
          <AvailabilityPill online={online} pending={pending} onToggle={() => void toggle()} />
          <HelpIcon />
        </>
      }
    >
      <NativeContractorStatus contractorOnline={online} />
      <div className="relative h-[calc(100dvh-3.5rem-4.25rem)] md:mx-auto md:h-[70vh] md:max-w-3xl">
        <LiveMap
          variant="hero"
          heightClass="h-full"
          emptyTitle="Live map unavailable"
          emptyBody="Sign in as a contractor to see your position, your active job, and nearby jobs here."
          onTap={() => setSnap(1)}
          driverScope
        />
        {flash && (
          <p className="absolute left-1/2 top-3 z-20 w-max max-w-[92vw] -translate-x-1/2 animate-[flash-in_0.25s_ease-out] rounded-full bg-accent-400 px-3.5 py-1.5 text-xs font-bold text-ink-950 shadow-card">
            {flash}
          </p>
        )}
        <ComplianceHomeChip />
        <DriverClaimReviewCard />
        <MapChips chips={chips} gps={gpsState} />
      </div>

      <HomeSheet
        primary={primary}
        offers={moreOffers}
        history={history}
        acting={acting}
        onAct={act}
        onQueueChanged={() => void load(true)}
        onRefresh={() => void load(true)}
        refreshing={loading}
        lastUpdated={lastUpdated}
        snapIndex={snap}
        onSnapChange={setSnap}
        earnings={earnings}
        onOpenEarnings={() => void nav({ to: "/driver/earnings" })}
        topSlot={<PushPermissionCard />}
      />
      <DriverNotificationBanners calls={calls} allCalls={allCalls} showSoundToggle />
      <PushNotificationSetup />
      <DriverReconnectSheet open={reconnectOpen} onClose={closeReconnect} onReconnected={onReconnected} onSignOut={() => void signOut()} />
      <DriverZonePicker open={zoneOpen} onClose={() => setZoneOpen(false)} state={zone?.ok ? zone : null} onSelected={loadZone} />
    </AppShell>
  );
}
