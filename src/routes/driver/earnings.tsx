import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, DollarSign, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { DriverEmptyState, DriverToolbar, QueueSkeleton } from "~/components/driver-queue";
import { JobFeedbackPanel } from "~/components/driver-issues";
import { Card } from "~/components/ui";
import { driverEarnings, driverLogout, type DriverEarningsResult } from "~/data/driver-auth";

/**
 * /driver/earnings — R2 (spec §c item 9): Today/This-week segmented toggle,
 * per-job money rows (Call #N — service · pickup area · ✓ time · +tip), tips
 * list, and the honest stat cards + "Payday is handled by the owner" card kept
 * VERBATIM (no per-job payrate exists yet — owner-side payday milestone). Real
 * data only; Today = calendar day, week = Mon–Sun (local time).
 */
export const Route = createFileRoute("/driver/earnings")({ component: EarningsView });

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

type Range = "today" | "week";

const inRange = (iso: string | null, range: Range, now: Date): boolean => {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  if (range === "today") {
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }
  // Week = Mon–Sun.
  const start = new Date(now);
  const dow = (start.getDay() + 6) % 7; // Monday = 0
  start.setDate(start.getDate() - dow);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return d >= start && d < end;
};

const fmtTime = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

function EarningsView() {
  const nav = useNavigate();
  const [state, setState] = useState<DriverEarningsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>("week");
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

  const now = useMemo(() => new Date(), []);

  const filteredCompleted = useMemo(
    () => (state?.ok ? state.completed.filter((c) => inRange(c.updatedAtIso, range, now)) : []),
    [state, range, now],
  );
  const filteredTips = useMemo(
    () => (state?.ok ? state.tips.filter((t) => inRange(t.createdAtIso, range, now)) : []),
    [state, range, now],
  );
  // tip by call number (tip.callNumber === call.callNumber) for the per-job +$ line.
  const tipCentsByCall = useMemo(() => {
    const m = new Map<string, number>();
    if (state?.ok) for (const t of state.tips) if (t.callNumber) m.set(t.callNumber, t.amountCents);
    return m;
  }, [state]);

  return (
    <AppShell portal="driver" title="Earnings" description="Completed jobs and tips on your account — updated live.">
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

          {/* Today / This week toggle */}
          <div className="flex rounded-full bg-ink-100 p-1" role="tablist" aria-label="Earnings period">
            {(["today", "week"] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={range === r}
                onClick={() => setRange(r)}
                className={`h-9 flex-1 rounded-full text-xs font-bold capitalize transition-colors ${range === r ? "bg-surface text-ink-900 shadow-card" : "text-ink-500"}`}
              >
                {r === "today" ? "Today" : "This week"}
              </button>
            ))}
          </div>

          {filteredCompleted.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-bold text-ink-700">Completed jobs</h2>
              <Card className="divide-y divide-ink-100">
                {filteredCompleted.map((c) => {
                  const tip = tipCentsByCall.get(c.callNumber);
                  return (
                    <div key={c.id} className="p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-ink-800">
                            Call #{c.callNumber} — {c.serviceName}
                          </p>
                          <p className="truncate text-xs text-ink-400">
                            {[c.pickupAddress, c.zip].filter(Boolean).join(", ") || "Pickup"}
                            {c.customerName ? ` · ${c.customerName}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          {tip != null && tip > 0 && (
                            <p className="text-sm font-bold text-success-600">+{money(tip)}</p>
                          )}
                          {c.updatedAtIso && (
                            <p className="flex items-center justify-end gap-1 text-xs font-semibold tabular-nums text-ink-500">
                              <CheckCircle2 className="size-3.5 text-success-600" /> {fmtTime(c.updatedAtIso)}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="mt-2">
                        <JobFeedbackPanel jobId={c.id} callLabel={`Call #${c.callNumber} — ${c.serviceName}`} />
                      </div>
                    </div>
                  );
                })}
              </Card>
            </div>
          )}

          {filteredTips.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-bold text-ink-700">Tips</h2>
              <Card className="divide-y divide-ink-100">
                {filteredTips.map((t) => (
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

          {filteredCompleted.length === 0 && filteredTips.length === 0 && (
            <DriverEmptyState
              icon={DollarSign}
              title={state.completed.length === 0 && state.tips.length === 0 ? "No earnings yet" : `No ${range === "today" ? "jobs today" : "jobs this week"}`}
              body={
                state.completed.length === 0 && state.tips.length === 0
                  ? "Complete jobs and collect tips and they'll show up here."
                  : "Nothing completed in this period — completed work from earlier periods is below."
              }
            />
          )}
        </div>
      ) : null}
    </AppShell>
  );
}
