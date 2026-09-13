import { createFileRoute } from "@tanstack/react-router";
import { Briefcase, Inbox, RefreshCw } from "lucide-react";
import { AppShell } from "~/components/app-shell";
import { useDriverQueue } from "~/components/driver-queue";
import { Button, Card, EmptyState } from "~/components/ui";

export const Route = createFileRoute("/driver/inbox")({ component: DriverInbox });

const statusText = (id: number) => {
  if (id === 1) return "New opportunity";
  if (id === 2) return "En route";
  if (id === 3) return "On scene";
  if (id === 4) return "In service";
  if (id === 5 || id === 6 || id === 252) return "Completed";
  if (id === 255) return "Canceled";
  return "Dispatch update";
};

function DriverInbox() {
  const { allCalls, loading, load } = useDriverQueue();
  const items = (allCalls ?? [])
    .filter((c) => [1,2,3,4,5,6,252,255].includes(c.statusId))
    .slice(0, 40);

  return (
    <AppShell portal="driver" title="Inbox" description="Your latest opportunities and dispatch updates.">
      <div className="mb-4 flex justify-end">
        <Button variant="secondary" size="sm" loading={loading} onClick={() => void load(true)}>
          <RefreshCw className="size-4" aria-hidden="true" /> Refresh
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState icon={Inbox} title="You're all caught up" body="New opportunities and job updates will appear here." />
      ) : (
        <div className="space-y-2">
          {items.map((call) => (
            <Card key={call.id} className="flex items-start gap-3 p-4">
              <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <Briefcase className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-ink-900">{statusText(call.statusId)}</p>
                <p className="mt-0.5 truncate text-sm text-ink-600">
                  {call.customer || call.vehicle || call.pickup || `Job #${call.id}`}
                </p>
                {(call.pickup || call.dropoff) && (
                  <p className="mt-1 line-clamp-2 text-xs text-ink-400">
                    {[call.pickup, call.dropoff].filter(Boolean).join(" → ")}
                  </p>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </AppShell>
  );
}
