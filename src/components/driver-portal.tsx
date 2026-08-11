/**
 * Real driver portal v1 (owner-directed 2026-08-11): the Towbook-backed job
 * queue. Rendered by /driver when a contractor is signed in via the unified
 * login (their platform credentials ARE their Towbook login). Jobs come from
 * GET /api/calls scoped to this driver's session; thumbs-up → en route is a
 * PUT via the DRIVER's own Towbook session with an LD write-through so the
 * owner and ops portals see the change immediately (the 3s sync re-confirms).
 *
 * The queue logic + job card now live in components/driver-queue.tsx and are
 * shared by the segmented driver pages (/driver/offers, /driver/active) so
 * every page renders the same live queue.
 */
import { Truck } from "lucide-react";
import { AppShell } from "~/components/app-shell";
import {
  DriverJobCard,
  DriverToolbar,
  ExpiredBanner,
  GpsStatusChip,
  QueueSkeleton,
  useDriverQueue,
} from "~/components/driver-queue";
import { DriverNotificationBanners } from "~/components/notify-banners";
import { Card } from "~/components/ui";

export function RealDriverPortal() {
  const { calls, error, expired, loading, acting, load, act, signOut, gpsState } = useDriverQueue();
  return (
    <AppShell portal="driver" title="My jobs" description="Offers and active calls from the dispatch board — status stays in sync with Towbook.">
      <DriverNotificationBanners calls={calls} />
      <DriverToolbar loading={loading} onRefresh={() => void load(false)} onSignOut={() => void signOut()} />
      <GpsStatusChip state={gpsState} />
      {expired && <ExpiredBanner onReconnect={() => void signOut()} />}
      {error && !expired && <p role="alert" className="mb-4 rounded-xl bg-danger-50 p-3 text-sm text-danger-600">{error}</p>}
      {loading && calls === null ? (
        <QueueSkeleton />
      ) : calls !== null && calls.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-ink-100"><Truck className="size-6 text-ink-400" /></div>
          <p className="font-semibold text-ink-700">No jobs right now</p>
          <p className="mt-1 text-sm text-ink-400">New offers from the AI dispatcher will appear here automatically. We refresh every 20 seconds.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {calls?.map((c) => (
            <DriverJobCard key={c.id} call={c} acting={acting === c.id} onAct={act} onQueueChanged={() => void load(true)} />
          ))}
        </div>
      )}
    </AppShell>
  );
}
