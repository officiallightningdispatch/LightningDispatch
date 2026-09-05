import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Check, CheckCircle2, ChevronRight, CircleX, Clock, DollarSign, Wallet, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { DriverEmptyState, DriverToolbar, QueueSkeleton } from "~/components/driver-queue";
import { JobFeedbackPanel } from "~/components/driver-issues";
import { InstantCashoutCard } from "~/components/instant-cashout-card";
import { Button, Card, useToast } from "~/components/ui";
import { driverEarnings, driverLogout, type DriverEarningsResult } from "~/data/driver-auth";
import { formatEtDate, getMyPayoutMethod, PAYOUT_RAIL_LABELS } from "~/data/payouts";
import { TipCashoutPanel } from "~/components/tip-cashout-ui";

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

function DriverPaymentBreakdown({ title, card }: { title: string; card: NonNullable<Extract<DriverEarningsResult, { ok: true }>["payPeriods"]>["current"] }) {
  const goa = card.goaJobCount * 1000;
  const standardGross = Math.max(0, card.jobCount - card.goaJobCount) * card.payrateCents;
  const lineTotal = standardGross + goa + card.tipsCents + card.tirePlugCents + card.batteryPayoutCents + card.busyBonusCents;
  return <Card className="p-4">
    <div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-bold uppercase tracking-wide text-brand-600">{title}</p><p className="mt-0.5 text-xs text-ink-400">{fmtPeriodLabel(card.startsAt, card.endsAt)}</p></div><p className="text-xl font-black tabular-nums text-ink-900">{money(card.totalCents)}</p></div>
    <div className="mt-3 space-y-1.5 border-t border-ink-100 pt-3 text-xs tabular-nums">
      <div className="flex justify-between gap-3"><span>Verified jobs ({card.jobCount}) × rate ({money(card.payrateCents)})</span><span className="font-semibold">{money(standardGross)}</span></div>
      <div className="flex justify-between gap-3"><span>GOA adjustment ({card.goaJobCount})</span><span>{money(goa)}</span></div>
      <div className="flex justify-between gap-3"><span>Tips</span><span className="text-success-600">+ {money(card.tipsCents)}</span></div>
      <div className="flex justify-between gap-3"><span>Tire plugs</span><span>+ {money(card.tirePlugCents)}</span></div>
      <div className="flex justify-between gap-3"><span>Battery sales</span><span>+ {money(card.batteryPayoutCents)}</span></div>
      <div className="flex justify-between gap-3"><span>Busy-time bonus</span><span>+ {money(card.busyBonusCents)}</span></div>
      <div className="flex justify-between gap-3 border-t border-ink-200 pt-1.5 text-sm font-black"><span>Total</span><span>{money(card.totalCents)}</span></div>
    </div>
    <p className={`mt-2 text-[11px] font-semibold ${lineTotal === card.totalCents ? "text-success-600" : "text-danger-600"}`}>{lineTotal === card.totalCents ? "✓ Line items reconcile exactly" : "⚠ Line-item mismatch — contact the owner"}</p>
    {card.payrateCents === 0 ? <p className="mt-1 text-[11px] font-bold text-amber-700">Your configured rate is $0.00; the owner must resolve it. No rate was invented.</p> : null}
  </Card>;
}
const fmtPeriodLabel = (startsAt: string, endsAt: string) => { const end = new Date(endsAt); return `${formatEtDate(startsAt)} – ${formatEtDate(new Date(end.getTime() - 1).toISOString())}`; };

function EarningsView() {
  const nav = useNavigate();
  const toast = useToast();
  const [state, setState] = useState<DriverEarningsResult | null>(null);
  const [payoutMethod, setPayoutMethod] = useState<{ rail: string; handleMasked: string; status: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>("week");
  const load = async () => {
    setLoading(true);
    setState(await driverEarnings());
    const pm = await getMyPayoutMethod();
    if (pm.ok && pm.data) setPayoutMethod({ rail: pm.data.rail, handleMasked: pm.data.handleMasked, status: pm.data.status });
    else setPayoutMethod(null);
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
    () => (state?.ok ? state.completed.filter((c) => inRange(c.completedAtIso, range, now)) : []),
    [state, range, now],
  );
  const filteredTirePlugs = useMemo(
    () => (state?.ok ? state.tirePlugs.filter((t) => inRange(t.createdAtIso, range, now)) : []),
    [state, range, now],
  );
  const filteredBatteryInstalls = useMemo(
    () => (state?.ok ? state.batteryInstalls.filter((b) => inRange(b.createdAtIso, range, now)) : []),
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

  // Busy-time bonus (owner-locked 2026-08-13): line item per busy hour —
  // "Busy-time bonus — <day> <hour>" +$1 × jobs completed in that hour.
  // The server derives the hours from this driver's dispatch_jobs; the
  // Today/Week toggle filters by the hour start.
  const fmtBusyHour = (isoStart: string) => formatEtDate(isoStart, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
  const filteredBusyHours = useMemo(
    () => (state?.ok ? state.busyBonus.hours.filter((h) => inRange(h.startsAtIso, range, now)) : []),
    [state, range, now],
  );
  const busyRangeTotal = useMemo(() => filteredBusyHours.reduce((s, h) => s + h.bonusCents, 0), [filteredBusyHours]);

  /* Payday is calculated on the server from Towbook completionTime and the
   * same source used by owner Money. The client only formats the returned ET
   * half-open boundaries; it never derives job counts or money. */
  const payPeriods = state?.ok ? state.payPeriods : null;

  return (
    <AppShell portal="driver" title="Earnings" description="Completed jobs and tips on your account — updated live.">
      <DriverToolbar loading={loading} onRefresh={() => void load()} onSignOut={() => void signOut()} />
      {loading && state === null ? (
        <QueueSkeleton />
      ) : state && !state.ok ? (
        <p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-600">{state.message}</p>
      ) : state && state.ok ? (
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-bold text-ink-800">Jobs completed</p>
                <p className="mt-0.5 text-xs text-ink-500">Real completed work · ET</p>
              </div>
              <CheckCircle2 className="size-5 text-success-600" />
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center">
              {([
                ["DAY", state.completedCounts.day],
                ["WEEK", state.completedCounts.week],
                ["MONTH", state.completedCounts.month],
                ["YEAR", state.completedCounts.year],
              ] as const).map(([label, count]) => (
                <div key={label} className="rounded-xl bg-ink-50 px-1 py-2">
                  <p className="text-[10px] font-bold tracking-wide text-ink-400">{label}</p>
                  <p className="mt-0.5 text-xl font-bold tabular-nums text-ink-800">{count}</p>
                </div>
              ))}
            </div>
          </Card>
          <div className="grid grid-cols-2 gap-3">
            <Card className="p-4">
              <p className="text-xs font-medium text-ink-400">Jobs completed (queue)</p>
              <p className="mt-1 text-2xl font-bold text-ink-800">{state.totals.completedJobs}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium text-ink-400">Tips received</p>
              <p className="mt-1 text-2xl font-bold text-brand-700">{money(state.totals.tipsTotalCents)}</p>
              <p className="text-xs text-ink-400">{state.totals.tipCount} tip{state.totals.tipCount === 1 ? "" : "s"}</p>
            </Card>
          </div>

          {filteredTirePlugs.length > 0 && <Card className="p-4"><p className="text-sm font-bold text-ink-800">Tire-plug earnings</p><div className="mt-2 space-y-2">{filteredTirePlugs.map((plug) => <div key={plug.jobId} className="flex justify-between text-sm"><span>Tire plug{plug.callNumber ? ` · Call #${plug.callNumber}` : ""}</span><span className="font-bold text-brand-700">+{money(plug.amountCents)}</span></div>)}</div></Card>}
          {filteredBatteryInstalls.length > 0 && <Card className="p-4"><p className="text-sm font-bold text-ink-800">Battery install earnings</p><div className="mt-2 space-y-2">{filteredBatteryInstalls.map((install) => <div key={install.saleId} className="flex justify-between text-sm"><span>Battery install{install.callNumber ? ` · Call #${install.callNumber}` : ""}</span><span className="font-bold text-brand-700">+{money(install.amountCents)}</span></div>)}</div></Card>}

          {/* Immediate tip cash-out (owner-directed 2026-08-12) — ONE TAP.
              Server-computed amount; states handled in the shared panel. */}
          <TipCashoutPanel onSubmitted={() => toast("Cash-out requested — the owner pays it from the Payments tab.")} />

          {/* Stripe Connect instant cash-out (automated payouts, owner-gated).
              Non-blocking; gate-off state renders "coming soon" until the
              owner enables automated payouts. */}
          <InstantCashoutCard />

          {/* Pay periods (feature batch 8): current open week + last closed
              week — earnings = rate × completed + tips, Mon→Sun. */}
          {payPeriods && <div className="grid gap-3 md:grid-cols-2">
            <DriverPaymentBreakdown title="This pay period" card={payPeriods.current} />
            <DriverPaymentBreakdown title="Last pay period" card={payPeriods.previous} />
          </div>}
          {payPeriods?.diagnostics.unknownCompletionTimeRows ? <p role="status" className="text-xs text-amber-700">Some completed Towbook rows have no parseable completion time and were held out of payday totals; owner review is required.</p> : null}

          <Link
            to="/driver/payout"
            className="flex items-center gap-3 rounded-2xl bg-surface p-4 ring-1 ring-ink-100 transition-colors duration-150 hover:bg-hover"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Wallet className="size-5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-ink-800">Payout method</span>
              <span className="block text-xs text-ink-500">Set how payday sends your money</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-ink-400" />
          </Link>

          <Card className="p-4">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink-100"><Wallet className="size-5 text-ink-500" /></div>
              <div>
                <p className="text-sm font-semibold text-ink-700">Payday is handled by the owner</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                  Your completed jobs are logged here for reconciliation. The owner pays contractors from the Payments tab —{" "}
                  {state.profile.payrateCents != null ? (
                    <>at <span className="font-semibold tabular-nums text-brand-700">{money(state.profile.payrateCents)}</span> per job × completed jobs plus tips.</>
                  ) : (
                    <>per-job payrate × completed jobs plus tips.</>
                  )}{" "}
                  This screen shows completed work, not payouts issued yet.
                </p>
              </div>
            </div>
            {/* Payout method line (spec §5 A1 — body above kept verbatim) */}
            <div className="mt-3 border-t border-ink-100 pt-3">
              {payoutMethod && payoutMethod.status === "verified" ? (
                <Link to="/driver/payout" className="flex items-center gap-1.5 text-xs font-semibold text-success-600">
                  <Check className="size-3.5" /> Paid via {PAYOUT_RAIL_LABELS[payoutMethod.rail as keyof typeof PAYOUT_RAIL_LABELS] ?? payoutMethod.rail} {payoutMethod.handleMasked} ✓
                  <span className="ml-auto font-bold text-brand-600">Change</span>
                </Link>
              ) : payoutMethod && payoutMethod.status === "rejected" ? (
                <Link to="/driver/payout" className="flex items-center gap-1.5 text-xs font-semibold text-danger-600">
                  <CircleX className="size-3.5" /> Payout method rejected — tap to fix
                </Link>
              ) : payoutMethod ? (
                <Link to="/driver/payout" className="flex items-center gap-1.5 text-xs font-semibold text-info-600">
                  <Clock className="size-3.5" /> Awaiting owner verification — usually the same day
                </Link>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-danger-600">No payout method set — add one so payday doesn&apos;t block you.</p>
                  <Link to="/driver/payout" className="shrink-0"><Button variant="primary" size="sm">Add payout method</Button></Link>
                </div>
              )}
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

          {/* Busy-time bonus (owner-locked 2026-08-13): 3+ assigned calls in a
              clock hour = busy hour; +$1 per job completed in that hour. */}
          {filteredBusyHours.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-bold text-ink-700">Busy-time bonus</h2>
              <Card className="divide-y divide-ink-100">
                {filteredBusyHours.map((h) => (
                  <div key={h.startsAtIso} className="flex items-center justify-between gap-2 p-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Zap className="size-4 shrink-0 text-brand-600" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink-800">{fmtBusyHour(h.startsAtIso)}</p>
                        <p className="text-xs text-ink-400">Busy hour — {h.completedJobs} job{h.completedJobs === 1 ? "" : "s"} completed · +$1 each</p>
                      </div>
                    </div>
                    <span className="shrink-0 text-sm font-bold tabular-nums text-brand-700">+{money(h.bonusCents)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-2 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-ink-400">Bonus total</p>
                  <p className="text-sm font-bold tabular-nums text-brand-700">+{money(busyRangeTotal)}</p>
                </div>
              </Card>
            </div>
          )}

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
                          <p className="text-sm font-semibold text-ink-800">
                            Call #{c.callNumber} — {c.serviceName}
                          </p>
                          <p className="text-xs text-ink-400">
                            {[c.pickupAddress, c.zip].filter(Boolean).join(", ") || "Pickup"}
                            {c.customerName ? ` · ${c.customerName}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          {state.profile.payrateCents != null && state.profile.payrateCents > 0 && (
                            <p className="text-sm font-bold tabular-nums text-brand-600">+{money(state.profile.payrateCents)}</p>
                          )}
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
                        <p className="text-sm font-semibold text-ink-700">
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
