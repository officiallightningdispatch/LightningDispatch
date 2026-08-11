import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DollarSign, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { DriverEmptyState, DriverJobCard, DriverToolbar, QueueSkeleton } from "~/components/driver-queue";
import { Card } from "~/components/ui";
import { driverEarnings, driverLogout, type DriverEarningsResult } from "~/data/driver-auth";

/**
 * /driver/earnings — the driver's money view. Real data only: completed calls
 * from the Towbook queue + tips attributed to THIS driver (job_completions
 * tip->>'driver_towbook_id'). Tips are accounted separately from card payments
 * per the owner's payments spec; per-job payrate/payday is the owner-side
 * compensation engine (later milestone) — this page shows what the driver has
 * completed and been tipped, with a "reserved" note so nothing is overstated.
 */
export const Route = createFileRoute("/driver/earnings")({ component: EarningsView });

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

function EarningsView() {
  const nav = useNavigate();
  const [state, setState] = useState<DriverEarningsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setState(await driverEarnings());
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, []);
  const signOut = async () => {
    await driverLogout();
    void nav({ to: "/login", replace: true });
  };
  return (
    <AppShell portal="driver" title="Earnings" description="Completed jobs and tips on your account — updated live from Towbook.">
      <DriverToolbar loading={loading} onRefresh={() => void load()} onSignOut={() => void signOut()} />
      {loading && state === null ? (
        <QueueSkeleton />
      ) : state && !state.ok ? (
        <p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-600">{state.message}</p>
      ) : state && state.ok ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Card className="p-4">
              <p className="text-xs font-medium text-ink-400">Jobs completed</p>
              <p className="mt-1 text-2xl font-bold text-ink-800">{state.totals.completedJobs}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium text-ink-400">Tips received</p>
              <p className="mt-1 text-2xl font-bold text-brand-700">{money(state.totals.tipsTotalCents)}</p>
              <p className="text-xs text-ink-400">{state.totals.tipCount} tip{state.totals.tipCount === 1 ? "" : "s"}</p>
            </Card>
          </div>
          <Card className="p-4">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink-100"><Wallet className="size-5 text-ink-500" /></div>
              <div>
                <p className="text-sm font-semibold text-ink-700">Payday is handled by the owner</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                  Your completed jobs are logged here for reconciliation. The owner pays contractors from the Payments tab — per-job
                  payrate × completed jobs plus tips. This screen shows completed work, not payouts issued yet.
                </p>
              </div>
            </div>
          </Card>
          {state.completed.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-bold text-ink-700">Completed jobs</h2>
              <div className="space-y-3">
                {state.completed.map((c) => (
                  <DriverJobCard key={c.id} call={c} acting={false} onAct={async () => {}} onQueueChanged={() => undefined} />
                ))}
              </div>
            </div>
          )}
          {state.tips.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-bold text-ink-700">Tips</h2>
              <Card className="divide-y divide-ink-100">
                {state.tips.map((t) => (
                  <div key={t.jobId} className="flex items-center justify-between gap-2 p-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <DollarSign className="size-4 shrink-0 text-success-600" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink-700">
                          {t.callNumber ? `Call #${t.callNumber}` : "Tip"}
                          {t.customerName ? ` — ${t.customerName}` : ""}
                        </p>
                        <p className="text-xs text-ink-400">{t.status === "paid" ? "Paid" : t.status === "link_created" ? "Link sent — awaiting payment" : t.status}</p>
                      </div>
                    </div>
                    <span className="shrink-0 text-sm font-bold text-ink-800">{money(t.amountCents)}</span>
                  </div>
                ))}
              </Card>
            </div>
          )}
          {state.completed.length === 0 && state.tips.length === 0 && (
            <DriverEmptyState
              icon={DollarSign}
              title="No earnings yet"
              body="Complete jobs and collect tips and they'll show up here."
            />
          )}
        </div>
      ) : null}
    </AppShell>
  );
}
