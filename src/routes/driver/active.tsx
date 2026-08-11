import { createFileRoute } from "@tanstack/react-router";
import { Briefcase } from "lucide-react";
import { AppShell } from "~/components/app-shell";
import {
  DriverBanners,
  DriverEmptyState,
  DriverJobCard,
  DriverToolbar,
  GpsStatusChip,
  QueueSkeleton,
  useDriverQueue,
} from "~/components/driver-queue";

/**
 * /driver/active — the job in progress: accepted (2), en route (3), arrived
 * (4). En route → arrival photos → complete all happen from this card (photo
 * flow + finish-up included), same as Home.
 */
export const Route = createFileRoute("/driver/active")({ component: ActiveView });

const ACTIVE_STATUSES = [2, 3, 4];

function ActiveView() {
  const { calls, error, expired, loading, acting, load, act, signOut, gpsState } = useDriverQueue();
  const active = calls?.filter((c) => ACTIVE_STATUSES.includes(c.statusId)) ?? null;
  return (
    <AppShell portal="driver" title="Active job" description="The job you're working right now — status stays in sync with Towbook.">
      <DriverBanners calls={calls} expired={expired} error={error} onReconnect={() => void signOut()} />
      <DriverToolbar loading={loading} onRefresh={() => void load(false)} onSignOut={() => void signOut()} />
      <GpsStatusChip state={gpsState} />
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
