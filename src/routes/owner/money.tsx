/**
 * /owner/money — PAYDAY MANIFEST (owner Money tab rebuild, payout-methods-spec
 * §5B, build order #8, owner-directed 2026-08-11). Three stat cards (Revenue /
 * Tips / Payouts) + the weekly manifest: pick a period (default = just-closed),
 * one-click Compute payday, records grouped BY RAIL with the FULL verified
 * handle (owner-only PII), per-row Mark paid with confirmation, and a
 * danger-tinted Blocked card for contractors without a verified payout method
 * (amount still shown — nothing silently dropped; unverified methods get
 * inline Verify/Reject). Tips are a separate line everywhere. DemoChip until
 * real money moves. Seroval rule: every client-visible field null, never
 * undefined (the core enforces it — this screen only renders).
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  Banknote, CalendarDays, CircleDollarSign, Landmark, RefreshCw, Send, Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { formatCents } from "~/components/contractor-admin";
import { Alert, Avatar, BoardSkeleton, Button, Card, DemoChip, EmptyState, StatCard, useToast } from "~/components/ui";
import {
  computePayday, getMoneyOverview, getPayPeriodDetail, listPayPeriods, markPayoutPaid,
  payPeriodLabel, rejectPayoutMethod, verifyPayoutMethod, type PayPeriod, type PayPeriodDetail,
  type PayoutRail, type PayoutRecord,
} from "~/data/payouts";

export const Route = createFileRoute("/owner/money")({ component: MoneyView });

const RAIL_ICONS: Record<PayoutRail, typeof Banknote> = {
  cash_app: Banknote,
  venmo: CircleDollarSign,
  zelle: Send,
  bank: Landmark,
};
const RAIL_LABELS: Record<PayoutRail, string> = {
  cash_app: "Cash App",
  venmo: "Venmo",
  zelle: "Zelle",
  bank: "Bank",
};
const money = (cents: number) => formatCents(cents);
const timeLabel = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

function MoneyView() {
  const toast = useToast();
  const [overview, setOverview] = useState<{ revenueCents: number; revenueChargedCount: number; revenueStagedCount: number; tipsCents: number; tipsCount: number; payoutsDueCents: number; payoutsDueCount: number; payoutsDueOn: string | null; hasRealMoney: boolean } | null>(null);
  const [periods, setPeriods] = useState<PayPeriod[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PayPeriodDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [confirmMarkId, setConfirmMarkId] = useState<string | null>(null);
  const [markNote, setMarkNote] = useState("");
  const [verifyBusy, setVerifyBusy] = useState<string | null>(null);
  const [rejectBusy, setRejectBusy] = useState<string | null>(null);
  const [rejectOpenFor, setRejectOpenFor] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const loadOverview = useCallback(async () => {
    const res = await getMoneyOverview();
    if (res.ok) setOverview(res.data);
  }, []);

  const loadDetail = useCallback(async (periodId: string) => {
    setDetailError(null);
    const res = await getPayPeriodDetail({ data: { periodId } });
    if (res.ok && res.data) setDetail(res.data);
    else if (res.ok) setDetail(null);
    else setDetailError(res.message);
  }, []);

  useEffect(() => {
    void loadOverview();
    void listPayPeriods().then((res) => {
      if (!res.ok) { setDetailError(res.message); return; }
      setPeriods(res.data.periods);
      const def = res.data.defaultPeriodId || res.data.currentPeriodId;
      setSelectedId(def);
      void loadDetail(def);
    });
  }, [loadDetail, loadOverview]);

  const selectedPeriod = useMemo(
    () => periods?.find((p) => p.id === selectedId) ?? null,
    [periods, selectedId],
  );
  const isOpenPeriod = selectedPeriod?.isCurrent === true;
  const computedAt = detail?.period.computedAt ?? null;
  const isPaid = detail?.period.status === "paid";

  const pickPeriod = (id: string) => {
    setSelectedId(id);
    setConfirmMarkId(null);
    setRejectOpenFor(null);
    void loadDetail(id);
  };

  const runCompute = async () => {
    if (!selectedId) return;
    setComputing(true);
    const res = await computePayday({ data: { periodId: selectedId } });
    setComputing(false);
    if (!res.ok) { setDetailError(res.message); return; }
    setDetail(res.data);
    toast(`Payday computed — ${res.data.totals.contractorCount} contractor${res.data.totals.contractorCount === 1 ? "" : "s"} · ${money(res.data.totals.totalCents)} due`);
    void loadOverview();
  };

  const confirmMarkPaid = async () => {
    if (!confirmMarkId) return;
    setMarkingId(confirmMarkId);
    const res = await markPayoutPaid({ data: { recordId: confirmMarkId, note: markNote.trim() || null } });
    setMarkingId(null);
    setConfirmMarkId(null);
    setMarkNote("");
    if (!res.ok) { setDetailError(res.message); return; }
    setDetail(res.data);
    const rec = res.data.records.find((r) => r.id === confirmMarkId);
    toast(`${rec?.contractorName ?? "Payout"} — ${money(rec?.totalCents ?? 0)} marked paid`);
    void loadOverview();
  };

  const runVerify = async (record: PayoutRecord) => {
    if (!record.methodId) { setDetailError("No payout method row on file for this contractor."); return; }
    setVerifyBusy(record.id);
    const res = await verifyPayoutMethod({ data: { methodId: record.methodId } });
    setVerifyBusy(null);
    if (!res.ok) { setDetailError(res.message); return; }
    toast(`Verified ${record.contractorName}'s payout method — recompute the period to move them into a rail group.`);
    void loadDetail(selectedId ?? "");
  };

  const runReject = async (record: PayoutRecord) => {
    if (!record.methodId) { setDetailError("No payout method row on file for this contractor."); return; }
    setRejectBusy(record.id);
    const res = await rejectPayoutMethod({ data: { methodId: record.methodId, note: rejectNote.trim() || "Rejected by owner" } });
    setRejectBusy(null);
    setRejectOpenFor(null);
    setRejectNote("");
    if (!res.ok) { setDetailError(res.message); return; }
    toast(`Rejected ${record.contractorName}'s payout method.`);
    void loadDetail(selectedId ?? "");
  };

  const groupByRail = useMemo(() => {
    const groups = new Map<PayoutRail, PayoutRecord[]>();
    for (const rec of detail?.records ?? []) {
      if (rec.status !== "computed" || !rec.rail) continue;
      const arr = groups.get(rec.rail) ?? [];
      arr.push(rec);
      groups.set(rec.rail, arr);
    }
    return [...groups.entries()].sort((a, b) => b[1].reduce((s, r) => s + r.totalCents, 0) - a[1].reduce((s, r) => s + r.totalCents, 0));
  }, [detail]);
  const blocked = useMemo(() => (detail?.records ?? []).filter((r) => r.status === "blocked"), [detail]);
  const paid = useMemo(() => (detail?.records ?? []).filter((r) => r.status === "paid"), [detail]);

  if (!periods || !overview) {
    return (
      <AppShell portal="owner" title="Money" description="Revenue, profit, and payroll at a glance.">
        <BoardSkeleton rows={3} />
      </AppShell>
    );
  }

  return (
    <AppShell portal="owner" title="Money" description="Revenue, profit, and payroll at a glance.">
      <div className="space-y-5">
        {!overview.hasRealMoney && (
          <DemoChip>demo — no real money has moved yet</DemoChip>
        )}

        {/* stat cards */}
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            topBar
            label="Revenue"
            value={<span className="text-brand-700">{money(overview.revenueCents)}</span>}
            detail={`Motor-club card charges — ${money(overview.revenueCents)} charged · ${overview.revenueStagedCount} staged`}
          />
          <StatCard
            label="Tips"
            value={<span className="text-success-600">{money(overview.tipsCents)}</span>}
            detail={`${overview.tipsCount} paid tips — attributed to drivers`}
          />
          <StatCard
            label="Payouts due"
            value={<span className="text-brand-700">{money(overview.payoutsDueCents)}</span>}
            detail={
              overview.payoutsDueOn
                ? `${overview.payoutsDueCount} contractor${overview.payoutsDueCount === 1 ? "" : "s"} · pays ${new Date(`${overview.payoutsDueOn}T00:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`
                : "Nothing due yet this period"
            }
          />
        </div>

        {/* payday manifest */}
        <section aria-label="Payday manifest" className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-ink-800">Payday manifest</h2>
              {selectedPeriod && (
                <p className="mt-0.5 text-xs text-ink-500">
                  {payPeriodLabel(selectedPeriod.startsAt, selectedPeriod.endsAt, selectedPeriod.payoutDueOn, selectedPeriod.isCurrent)}
                </p>
              )}
            </div>
            <select
              aria-label="Pay period"
              value={selectedId ?? ""}
              onChange={(e) => pickPeriod(e.target.value)}
              className="h-11 max-w-[220px] rounded-xl border border-ink-200 bg-surface px-3 text-sm text-ink-800 outline-none focus:border-brand-500"
            >
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.isCurrent ? "Open period" : `${new Date(p.startsAt).toLocaleDateString([], { month: "short", day: "numeric" })} – ${new Date(p.endsAt).toLocaleDateString([], { month: "short", day: "numeric" })}`}
                </option>
              ))}
            </select>
          </div>

          {isOpenPeriod && !isPaid && (
            <Alert variant="info">This period is still open — it closes Sunday 11:59 PM ET. The manifest is computed after it closes.</Alert>
          )}

          {!isOpenPeriod && !isPaid && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" loading={computing} onClick={() => void runCompute()} disabled={Boolean(detail?.period.status === "paid")}>
                {detail && detail.totals.contractorCount > 0 ? (<><RefreshCw className="size-4" /> Recompute</>) : "Compute payday"}
              </Button>
              {computedAt && (
                <p className="text-xs text-ink-400">
                  Last computed {timeLabel(computedAt)} · {detail?.totals.contractorCount ?? 0} contractor{detail?.totals.contractorCount === 1 ? "" : "s"} · {money(detail?.totals.totalCents ?? 0)} due
                </p>
              )}
            </div>
          )}

          {detailError && (
            <Alert variant="danger">{detailError}</Alert>
          )}

          {detail && detail.records.length === 0 && (
            <EmptyState
              icon={Wallet}
              title="No completed jobs in this period"
              body="Nothing to pay yet. Completed jobs with a per-job rate and paid tips appear here once you compute payday."
              action={
                !selectedPeriod?.isCurrent ? (
                  <Button variant="primary" size="sm" loading={computing} onClick={() => void runCompute()}>Compute payday</Button>
                ) : undefined
              }
            />
          )}

          {/* rail groups */}
          {groupByRail.map(([rail, recs]) => {
            const groupTotal = recs.reduce((s, r) => s + r.totalCents, 0);
            const Icon = RAIL_ICONS[rail];
            return (
              <Card key={rail} className="overflow-hidden">
                <div className="flex items-center gap-2.5 border-b border-ink-100 bg-ink-50/50 px-4 py-3">
                  <span className="grid size-8 place-items-center rounded-lg bg-ink-100 text-ink-600"><Icon className="size-4" strokeWidth={2} /></span>
                  <span className="text-sm font-bold text-ink-700">{RAIL_LABELS[rail]}</span>
                  <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-bold tabular-nums text-ink-600">{recs.length}</span>
                  <span className="ml-auto text-sm font-black tabular-nums text-ink-900">— {money(groupTotal)}</span>
                </div>
                {recs.map((rec) => (
                  <div key={rec.id} className="border-b border-ink-100 px-4 py-3.5 last:border-0">
                    <div className="flex items-center gap-3">
                      <Avatar name={rec.contractorName} className="size-9" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink-800">{rec.contractorName}</p>
                        <p className="truncate text-xs text-ink-400">
                          {rec.rail && rec.handleFull ? (
                            <span className="font-mono">{rec.handleFull} — verified ✓</span>
                          ) : (
                            "verified payout method"
                          )}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold tabular-nums text-ink-900">{money(rec.totalCents)}</p>
                        <p className="text-[11px] text-ink-400">
                          {rec.jobCount} job{rec.jobCount === 1 ? "" : "s"}
                          {rec.payrateCents == null ? " · rate not set" : ` · ${money(rec.grossCents)}`}
                          {rec.tipsCents > 0 && <span className="text-success-600"> + {money(rec.tipsCents)} tips</span>}
                        </p>
                      </div>
                      <Button variant="primary" size="sm" onClick={() => { setConfirmMarkId(rec.id); setMarkNote(""); }}>Mark paid</Button>
                    </div>

                    {confirmMarkId === rec.id && (
                      <div className="mt-3 rounded-xl border border-brand-200 bg-brand-50/50 p-3">
                        <p className="text-xs leading-relaxed text-ink-700">
                          Open <span className="font-bold">{RAIL_LABELS[rec.rail ?? "bank"]}</span> and send{" "}
                          <span className="font-bold tabular-nums text-brand-700">{money(rec.totalCents)}</span> to{" "}
                          <span className="font-mono font-bold">{rec.handleFull ?? rec.handleMasked}</span>{" "}
                          (verified) from your own app. Did the send go through?
                        </p>
                        <input
                          value={markNote}
                          onChange={(e) => setMarkNote(e.target.value)}
                          placeholder="Optional note"
                          className="mt-2 h-10 w-full rounded-lg border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500"
                        />
                        <div className="mt-2 flex gap-2">
                          <Button variant="primary" size="sm" loading={markingId === rec.id} onClick={() => void confirmMarkPaid()}>Yes — marked paid</Button>
                          <Button variant="ghost" size="sm" onClick={() => { setConfirmMarkId(null); setMarkNote(""); }}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </Card>
            );
          })}

          {/* paid rows */}
          {paid.length > 0 && (
            <Card className="overflow-hidden">
              <div className="flex items-center gap-2.5 border-b border-ink-100 bg-success-50/40 px-4 py-3">
                <span className="text-sm font-bold text-ink-700">Paid this period</span>
                <span className="ml-auto text-sm font-black tabular-nums text-success-600">{money(paid.reduce((s, r) => s + r.totalCents, 0))}</span>
              </div>
              {paid.map((rec) => (
                <div key={rec.id} className="flex items-center gap-3 border-b border-ink-100 px-4 py-3.5 last:border-0">
                  <Avatar name={rec.contractorName} className="size-9" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-800">{rec.contractorName} ✓</p>
                    <p className="truncate text-xs text-ink-400">
                      {rec.jobCount} job{rec.jobCount === 1 ? "" : "s"} · {money(rec.totalCents)}
                      {rec.tipsCents > 0 && <span className="text-success-600"> + {money(rec.tipsCents)} tips</span>}
                    </p>
                  </div>
                  <p className="text-xs font-semibold text-success-600">Paid {timeLabel(rec.paidAt)}</p>
                </div>
              ))}
            </Card>
          )}

          {/* blocked card */}
          {blocked.length > 0 && (
            <Card className="overflow-hidden border-danger-200">
              <div className="flex items-center gap-2.5 border-b border-danger-100 bg-danger-50/50 px-4 py-3">
                <span className="text-sm font-bold text-danger-700">Blocked — no verified payout method</span>
                <span className="ml-auto text-sm font-black tabular-nums text-danger-700">{money(blocked.reduce((s, r) => s + r.totalCents, 0))}</span>
              </div>
              {blocked.map((rec) => (
                <div key={rec.id} className="border-b border-ink-100 px-4 py-3.5 last:border-0">
                  <div className="flex items-center gap-3">
                    <Avatar name={rec.contractorName} className="size-9" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink-800">{rec.contractorName}</p>
                      <p className="truncate text-xs text-ink-400">
                        {rec.methodStatus === "connected_unverified" && (
                          <span className="text-info-600">Awaiting verification{rec.rail && rec.handleFull ? ` — ${rec.handleFull}` : ""}</span>
                        )}
                        {rec.methodStatus === "rejected" && <span className="text-danger-600">Rejected — ask the contractor to fix it</span>}
                        {rec.methodStatus === "none" && "No payout method on file"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold tabular-nums text-ink-900">{money(rec.totalCents)} due</p>
                      <p className="text-[11px] text-ink-400">
                        {rec.jobCount} job{rec.jobCount === 1 ? "" : "s"}
                        {rec.payrateCents == null ? " · rate not set" : ` · ${money(rec.grossCents)}`}
                        {rec.tipsCents > 0 && <span className="text-success-600"> + {money(rec.tipsCents)} tips</span>}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <span className="inline-flex min-h-[22px] items-center gap-1.5 rounded-full bg-danger-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-danger-700">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-80" /> Blocked
                    </span>
                    {(rec.methodStatus === "connected_unverified" || rec.methodStatus === "rejected") && (
                      <>
                        <Button variant="ghost" size="sm" loading={verifyBusy === rec.id} onClick={() => void runVerify(rec)}>Verify</Button>
                        {rejectOpenFor === rec.id ? (
                          <span className="flex items-center gap-1.5">
                            <input
                              value={rejectNote}
                              onChange={(e) => setRejectNote(e.target.value)}
                              placeholder="Reason"
                              className="h-8 w-36 rounded-lg border border-ink-200 bg-surface px-2 text-xs outline-none focus:border-brand-500"
                            />
                            <Button variant="danger-ghost" size="sm" loading={rejectBusy === rec.id} onClick={() => void runReject(rec)}>Confirm</Button>
                            <Button variant="ghost" size="sm" onClick={() => { setRejectOpenFor(null); setRejectNote(""); }}>Cancel</Button>
                          </span>
                        ) : (
                          <Button variant="danger-ghost" size="sm" onClick={() => { setRejectOpenFor(rec.id); setRejectNote(""); }}>Reject</Button>
                        )}
                      </>
                    )}
                    <p className="text-[11px] text-ink-400">Nothing is dropped — this amount waits for a verified method, then recompute moves it into its rail group.</p>
                  </div>
                </div>
              ))}
            </Card>
          )}

          {/* summary */}
          {detail && detail.records.length > 0 && (
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <p className="font-bold text-ink-800">Total due <span className="tabular-nums text-brand-700">{money(detail.totals.totalCents)}</span></p>
                {detail.totals.rails.map((g) => (
                  <p key={g.rail} className="text-xs text-ink-500">
                    {RAIL_LABELS[g.rail]}: <span className="tabular-nums text-ink-700">{money(g.totalCents)}</span>
                  </p>
                ))}
              </div>
              <p className="mt-1.5 flex items-center gap-1 text-xs text-ink-400">
                <CalendarDays className="size-3.5" />
                {detail.totals.contractorCount} contractor{detail.totals.contractorCount === 1 ? "" : "s"} · {detail.totals.jobCount} job{detail.totals.jobCount === 1 ? "" : "s"}
                {detail.totals.tipsCents > 0 && <span className="text-success-600"> · {money(detail.totals.tipsCents)} in tips</span>}
                {detail.totals.blockedCount > 0 && <span className="text-danger-600"> · {detail.totals.blockedCount} blocked</span>}
              </p>
            </Card>
          )}
        </section>
      </div>
    </AppShell>
  );
}
