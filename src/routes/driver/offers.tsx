import { createFileRoute } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
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
 * /driver/offers — job offers waiting on this driver's thumbs-up. Same live
 * queue + card as Home, filtered to offered calls (Towbook status 1). Accepting
 * moves the job to Active and out of this list (queue reloads after the PUT).
 */
export const Route = createFileRoute("/driver/offers")({ component: OffersView });

function OffersView() {
  const { calls, error, expired, loading, acting, load, act, signOut, gpsState } = useDriverQueue();
  const offers = calls?.filter((c) => c.statusId === 1) ?? null;
  return (
    <AppShell portal="driver" title="Offers" description="New jobs waiting on your thumbs-up — accept to claim them.">
      <DriverBanners calls={calls} expired={expired} error={error} onReconnect={() => void signOut()} />
      <DriverToolbar loading={loading} onRefresh={() => void load(false)} onSignOut={() => void signOut()} />
      <GpsStatusChip state={gpsState} />
      {loading && calls === null ? (
        <QueueSkeleton />
      ) : offers !== null && offers.length === 0 ? (
        <DriverEmptyState
          icon={Inbox}
          title="No offers right now"
          body="When the AI dispatcher sends you a job, it appears here for your thumbs-up."
        />
      ) : (
        <div className="space-y-3">
          {offers?.map((c) => (
            <DriverJobCard key={c.id} call={c} acting={acting === c.id} onAct={act} onQueueChanged={() => void load(true)} />
          ))}
        </div>
      )}
    </AppShell>
  );
}
