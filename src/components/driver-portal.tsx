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
import { CircleHelp } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { AvailabilityPill, useAvailability } from "~/components/driver-availability";
import { useRequoteFlash } from "~/components/driver-eta";
import { HomeSheet, MapChips, type HomeEarnings } from "~/components/driver-sheets";
import { useDriverQueue } from "~/components/driver-queue";
import { LiveMap } from "~/components/live-map";
import { DriverNotificationBanners } from "~/components/notify-banners";
import { driverEarnings } from "~/data/driver-auth";

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
  const { calls, error, expired, loading, acting, load, act, signOut, gpsState } = useDriverQueue();
  const { online, pending, toggle } = useAvailability();
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
  const primary = active[0] ?? offers[0] ?? null;
  const moreOffers = primary ? offers.filter((c) => c.id !== primary.id) : offers;
  const flash = useRequoteFlash(primary);

  const chips: { kind: "error" | "expired"; text: string; onAction?: () => void }[] = [];
  if (expired) chips.push({ kind: "expired", text: "Your Towbook session expired — tap to reconnect.", onAction: () => void signOut() });
  else if (error) chips.push({ kind: "error", text: error });

  return (
    <AppShell
      portal="driver"
      slim
      title="Home"
      description=""
      headerActions={
        <>
          <AvailabilityPill online={online} pending={pending} onToggle={() => void toggle()} />
          <HelpIcon />
        </>
      }
    >
      <div className="relative h-[calc(100dvh-3.5rem-4.25rem)] md:mx-auto md:h-[70vh] md:max-w-3xl">
        <LiveMap
          variant="hero"
          heightClass="h-full"
          emptyTitle="Live map unavailable"
          emptyBody="Sign in as a contractor to see your position, your active job, and nearby jobs here."
          onTap={() => setSnap(1)}
        />
        {flash && (
          <p className="absolute left-1/2 top-3 z-20 w-max max-w-[92vw] -translate-x-1/2 animate-[flash-in_0.25s_ease-out] rounded-full bg-accent-400 px-3.5 py-1.5 text-xs font-bold text-ink-950 shadow-card">
            {flash}
          </p>
        )}
        <MapChips chips={chips} gps={gpsState} />
      </div>

      <HomeSheet
        primary={primary}
        offers={moreOffers}
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
      />
      <DriverNotificationBanners calls={calls} />
    </AppShell>
  );
}
