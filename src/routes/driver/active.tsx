import { createFileRoute } from "@tanstack/react-router";
import { Briefcase, Clock, MapPin } from "lucide-react";
import { AppShell } from "~/components/app-shell";
import { LiveMap } from "~/components/live-map";
import {
  DriverBanners,
  DriverEmptyState,
  DriverJobCard,
  DriverToolbar,
  etaLabel,
  GpsStatusChip,
  QueueSkeleton,
  useDriverQueue,
} from "~/components/driver-queue";

/**
 * /driver/active — the job in progress: accepted (2), en route (3), arrived
 * (4). En route → arrival photos → complete all happen from this card (photo
 * flow + finish-up included), same as Home. The live map on top shows the
 * driver's own position (self pin), their active job's pickup pin, and the
 * quoted ETA from the job queue.
 */
export const Route = createFileRoute("/driver/active")({ component: ActiveView });

const ACTIVE_STATUSES = [2, 3, 4];

function ActiveView() {
  const { calls, error, expired, loading, acting, load, act, signOut, gpsState } = useDriverQueue();
  const active = calls?.filter((c) => ACTIVE_STATUSES.includes(c.statusId)) ?? null;
  const current = active && active.length > 0 ? active[0] : null;
  const address = current ? [current.pickupAddress, current.zip].filter(Boolean).join(", ") : null;
  return (
    <AppShell portal="driver" title="Active job" description="The job you're working right now — status stays in sync with Towbook.">
      <DriverBanners calls={calls} expired={expired} error={error} onReconnect={() => void signOut()} />
      <DriverToolbar loading={loading} onRefresh={() => void load(false)} onSignOut={() => void signOut()} />
      <GpsStatusChip state={gpsState} />
      <div className="mb-4">
        {current && (
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-brand-100 bg-brand-50/70 px-4 py-3 text-sm">
            <span className="flex items-center gap-1.5 font-bold text-brand-800">
              <Clock className="size-4" /> ETA {etaLabel(current.arrivalETA)}
            </span>
            {address && (
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink-600">
                <MapPin className="size-3.5 shrink-0 text-brand-600" /> <span className="truncate">{address}</span>
              </span>
            )}
          </div>
        )}
        <LiveMap
          emptyTitle="Live map unavailable"
          emptyBody="Sign in as a contractor to see your position, your active job, and nearby jobs here."
        />
      </div>
      {loading && calls === null ? (
        <QueueSkeleton />
      ) : active !== null && active.length === 0 ? (
        <DriverEmptyState
          icon={Briefcase}
          title="No active job"
          body="Accept an offer and it will show up here — en route, arrival photos, and completion."
        />
      ) : (
        <div className="space-y-3">
          {active?.map((c) => (
            <DriverJobCard key={c.id} call={c} acting={acting === c.id} onAct={act} onQueueChanged={() => void load(true)} />
          ))}
        </div>
      )}
    </AppShell>
  );
}
