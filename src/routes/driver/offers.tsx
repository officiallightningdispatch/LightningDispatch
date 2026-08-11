import { createFileRoute } from "@tanstack/react-router";
import { Clock, Inbox, MapPin, ThumbsDown, ThumbsUp, Truck } from "lucide-react";
import { useState } from "react";
import { AppShell } from "~/components/app-shell";
import { etaMinutesLabel } from "~/components/driver-eta";
import {
  DriverBanners,
  DriverEmptyState,
  DriverToolbar,
  GpsStatusChip,
  QueueSkeleton,
  STATUS_META,
  useDriverQueue,
} from "~/components/driver-queue";
import { Button, Card, useToast } from "~/components/ui";
import { submitDriverIssue } from "~/data/driver-support";
import type { DriverCall } from "~/data/driver-auth";

/**
 * /driver/offers — Uber-clean offers list (R2 spec §b/§c item 8): no map hero,
 * AppShell non-slim. Each card: ETA chip (brand-50 "~12 min"), service,
 * customer/pickup, vehicle, a dominant Accept, and "Can't take it" — which
 * records the decline INTENT (driver_issues kind='decline', SAFE interim per
 * spec §e Q1): dispatch is notified, the offer stays in the list, and the AI
 * dispatcher's reassign path is NOT touched (later milestone, owner decision).
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
            <OfferCard key={c.id} call={c} acting={acting === c.id} onAct={act} onQueueChanged={() => void load(true)} />
          ))}
        </div>
      )}
    </AppShell>
  );
}

function OfferCard({
  call,
  acting,
  onAct,
  onQueueChanged,
}: {
  call: DriverCall;
  acting: boolean;
  onAct: (id: string, a: "accept" | "en_route") => Promise<void>;
  onQueueChanged: () => void;
}) {
  const toast = useToast();
  const [declining, setDeclining] = useState(false);
  const meta = STATUS_META[1];
  const address = [call.pickupAddress, call.zip].filter(Boolean).join(", ");

  const cantTakeIt = async () => {
    setDeclining(true);
    try {
      const r = await submitDriverIssue({
        data: { kind: "decline", jobId: call.id, message: `Driver declined offer — Call #${call.callNumber} (${call.serviceName}).` },
      });
      toast(r.ok ? "Dispatch notified — the offer stays open for now." : (r.message ?? "Couldn't notify dispatch — try again."));
    } catch {
      toast("Couldn't notify dispatch — check your connection.");
    } finally {
      setDeclining(false);
      onQueueChanged();
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 p-4 pb-3">
        <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
          <Truck className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-bold leading-tight text-ink-800">{call.serviceName}</h3>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.badge}`}>
              <span className={`size-1.5 rounded-full ${meta.dot}`} /> {meta.label}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Call #{call.callNumber}</p>
          {call.customerName && <p className="mt-0.5 text-sm font-medium text-ink-700">{call.customerName}</p>}
          {address && (
            <p className="mt-1 flex items-start gap-1.5 text-sm text-ink-600">
              <MapPin className="mt-0.5 size-3.5 shrink-0 text-brand-600" /> <span className="min-w-0">{address}</span>
            </p>
          )}
          {call.vehicle && <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-500"><Truck className="size-3.5 shrink-0" /> {call.vehicle}</p>}
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-bold tabular-nums text-brand-700">
            <Clock className="size-3.5" /> {etaMinutesLabel(call)}
          </span>
        </div>
      </div>
      <div className="flex gap-2 border-t border-ink-100 p-3">
        <Button className="flex-1" loading={acting} onClick={() => void onAct(call.id, "accept")}>
          <ThumbsUp className="size-4" /> Accept
        </Button>
        <Button variant="danger-ghost" className="border border-danger-100" loading={declining} onClick={() => void cantTakeIt()}>
          <ThumbsDown className="size-4" /> Can&apos;t take it
        </Button>
      </div>
      <p className="border-t border-ink-100 px-3 pb-2.5 pt-2 text-[11px] text-ink-400">
        &quot;Can&apos;t take it&quot; notifies dispatch — the offer stays here until someone claims it.
      </p>
    </Card>
  );
}
