import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Briefcase, CircleHelp } from "lucide-react";
import { useState } from "react";
import { AppShell } from "~/components/app-shell";
import { useRequoteFlash, EtaHero } from "~/components/driver-eta";
import { MapChips, TripSheet } from "~/components/driver-sheets";
import { DriverReconnectSheet, useDriverQueue } from "~/components/driver-queue";
import { LiveMap } from "~/components/live-map";
import { DriverNotificationBanners } from "~/components/notify-banners";

/**
 * /driver/active — the active-trip screen: compact LiveMap widget, ETA
 * countdown overlay (EtaHero), and the TripSheet
 * (pickup row · call/navigate · ProgressRail · dominant action · photo flow).
 * Banners/errors/GPS render as floating chips over the map. When there is no
 * active job but an offer is waiting, the offer-first flow claims the sheet
 * (spec §e Q8 — recommended; flagged for owner confirmation).
 */
export const Route = createFileRoute("/driver/active")({ component: ActiveView });

const ACTIVE_STATUSES = [2, 3, 4];

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

function ActiveView() {
  const nav = useNavigate();
  const { calls, error, expired, loading, acting, load, act, signOut, gpsState, reconnectOpen, openReconnect, closeReconnect, onReconnected } = useDriverQueue();
  const [snap, setSnap] = useState(0);
  const active = calls?.filter((c) => ACTIVE_STATUSES.includes(c.statusId)) ?? null;
  const current = active && active.length > 0 ? active[0] : null;
  const offer = !current ? (calls?.find((c) => c.statusId === 1) ?? null) : null;
  const sheetCall = current ?? offer ?? null;
  const flash = useRequoteFlash(sheetCall);

  const chips: { kind: "error" | "expired"; text: string; onAction?: () => void }[] = [];
  if (expired) chips.push({ kind: "expired", text: "Your session expired — tap to reconnect.", onAction: () => void openReconnect() });
  else if (error) chips.push({ kind: "error", text: error });

  const headerActions = (
    <>
      {current ? (
        <span className="flex h-11 items-center gap-1.5 rounded-full bg-success-50 px-3.5 text-xs font-bold text-success-700 ring-1 ring-success-200">
          <span className="size-2 rounded-full bg-success-500" /> On job
        </span>
      ) : null}
      <HelpIcon />
    </>
  );

  return (
    <AppShell portal="driver" slim title="Active job" description="" headerActions={headerActions}>
      <div className="mx-auto w-full max-w-3xl px-3 pt-3 md:px-0">
        <div className="relative h-56 overflow-hidden rounded-2xl border border-ink-100 bg-surface shadow-sm sm:h-64">
        <LiveMap
          variant="hero"
          heightClass="h-full"
          emptyTitle="Live map unavailable"
          emptyBody="Sign in as a contractor to see your position, your active job, and nearby jobs here."
          driverScope
        />
        {sheetCall && (
          <div className="absolute left-3 top-3 z-10">
            <EtaHero call={sheetCall} />
          </div>
        )}
        {flash && (
          <p className="absolute left-1/2 top-3 z-20 w-max max-w-[92vw] -translate-x-1/2 animate-[flash-in_0.25s_ease-out] rounded-full bg-accent-400 px-3.5 py-1.5 text-xs font-bold text-ink-950 shadow-card">
            {flash}
          </p>
        )}
        <MapChips chips={chips} gps={gpsState} />
        </div>
      </div>

      {sheetCall ? (
        <TripSheet
          call={sheetCall}
          acting={acting === sheetCall.id}
          onAct={act}
          onQueueChanged={() => void load(true)}
          snapIndex={snap}
          onSnapChange={setSnap}
        />
      ) : (
        <div className="mx-auto max-w-lg px-4 pb-24 pt-8 text-center">
          <div className="mx-auto mb-3 grid size-14 place-items-center rounded-full bg-ink-100">
            <Briefcase className="size-7 text-ink-400" />
          </div>
          <p className="font-bold text-ink-700">
            {loading && calls === null ? "Loading your queue…" : "No active job"}
          </p>
          <p className="mt-1 text-sm text-ink-400">
            {loading && calls === null
              ? "Checking for offers and trips."
              : "Accept an offer and it will show up here — en route, arrival photos, and completion."}
          </p>
          <button
            type="button"
            onClick={() => void nav({ to: "/driver/offers" })}
            className="mt-4 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-brand-600"
          >
            View offers
          </button>
        </div>
      )}
      <DriverNotificationBanners calls={calls} />
      <DriverReconnectSheet open={reconnectOpen} onClose={closeReconnect} onReconnected={onReconnected} onSignOut={() => void signOut()} />
    </AppShell>
  );
}
