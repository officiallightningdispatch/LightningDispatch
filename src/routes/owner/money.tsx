/**
 * /owner/money — PAYMENTS (owner Money tab: payday manifest + payment engine,
 * owner-directed 2026-08-11/12). Two halves:
 *
 * 1) PAYDAY MANIFEST (payout-methods-spec §5B, build order #8): three stat
 *    cards (Revenue / Tips / Payouts) + the weekly manifest: pick a period
 *    (default = just-closed), one-click Compute payday, records grouped BY
 *    RAIL with the FULL verified handle (owner-only PII), per-row Mark paid
 *    with confirmation, and a danger-tinted Blocked card for contractors
 *    without a verified payout method. Tips are a separate line everywhere.
 * 2) PAYMENT ENGINE (backlog #1, owner spec 2026-08-11, PER-PO CARD rework
 *    2026-08-12): scan lightroad29@gmail.com for motor-club (Allied Dispatch /
 *    Honk / Allstate) card-charge notifications → stage rows → owner reviews
 *    and charges EACH row through the OWNER's Square account. PER-PO CARD
 *    MODEL: clubs provide ONE CARD PER PO — each staged row carries ITS OWN
 *    card metadata parsed from that PO's email (brand/last4/expiry/billing
 *    zip; NO PAN anywhere), and the owner charges by entering that PO's card
 *    into Square's secure Web Payments form (nonce → POST /v2/payments,
 *    exactly one, idempotent; funds never leave the owner's Square balance).
 *    There is no per-club card on file. The owner may also charge in their own
 *    Square dashboard and tap "Mark charged (paid outside)". Plus a driver-tips
 *    ledger read (kind='tip', attribution via completion_tips).
 *
 * Safety rails: nothing is ever auto-charged — staging + per-row Charge (the
 * owner's explicit approval per charge, enforced server-side by
 * chargeStagedCore) is the gate; the card entered into Square's secure form is
 * tokenized and charged only AFTER the owner taps Charge on a staged row.
 * Seroval rule: every client-visible field null, never undefined.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle, Banknote, CalendarDays, CircleDollarSign, Landmark, Loader2,
  RefreshCcw, RefreshCw, Send, Wallet, Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { formatCents } from "~/components/contractor-admin";
import { Alert, Avatar, BoardSkeleton, Button, Card, EmptyState, StatCard, StatusBadge, useToast } from "~/components/ui";
import { OwnerPayoutMethodEditor } from "~/components/owner-payout-method";
import {
  computePayday, editPayoutMethod, formatEtDate, getContractorPayoutMethod, getMoneyOverview, getPayPeriodDetail, listPayPeriods, markPayoutPaid,
  payPeriodLabel, rejectPayoutMethod, setBankDeposit, verifyPayoutMethod,
  type PayPeriod, type PayPeriodDetail, type PayoutRail, type PayoutRecord, type OwnerPayoutMethod,
} from "~/data/payouts";
import {
  listTipCashoutRequests, markTipCashoutPaid, listTirePlugLedger, markTirePlugPaid,
  type TipCashoutList, type TipCashoutRequest, type TirePlugLedgerRow,
} from "~/data/tip-cashout";
import {
  chargeStaged,
  getPaymentSquareConfig,
  listStagedCharges,
  listTips,
  markChargedOutside,
  scanClubMail,
  type PaymentTxnRow,
  type TipLedgerRow,
} from "~/data/payment-engine";

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

function PaymentBreakdown({ record }: { record: PayoutRecord }) {
  const goa = record.goaJobCount * 1000;
  const standardJobs = Math.max(0, record.jobCount - record.goaJobCount);
  const standardGross = standardJobs * (record.payrateCents ?? 0);
  const lineTotal = standardGross + goa + record.tipsCents + record.tirePlugCents + record.batteryPayoutCents + record.busyBonusCents;
  return (
    <div className="mt-3 rounded-xl border border-ink-100 bg-ink-50/40 p-3 text-xs">
      <p className="mb-2 font-bold uppercase tracking-wide text-ink-500">Complete payment breakdown</p>
      {record.noActivityThisPeriod && <p className="mb-2 rounded-lg bg-ink-100/70 px-2.5 py-1.5 text-[11px] font-bold text-ink-600">No activity this period — this roster row is not a payout record.</p>}
      <div className="space-y-1.5 tabular-nums">
        <div className="flex justify-between gap-3"><span>Verified jobs ({record.jobCount}) × rate ({money(record.payrateCents ?? 0)})</span><span className="font-semibold">{money(standardGross)}</span></div>
        {record.goaJobCount > 0 ? <div className="flex justify-between gap-3"><span>GOA adjustment ({record.goaJobCount} × $10.00)</span><span className="font-semibold">{money(goa)}</span></div> : <div className="flex justify-between gap-3"><span>GOA adjustment</span><span>{money(0)}</span></div>}
        <div className="flex justify-between gap-3"><span>Tips</span><span className="font-semibold text-success-600">+ {money(record.tipsCents)}</span></div>
        <div className="flex justify-between gap-3"><span>Tire plugs</span><span className="font-semibold">+ {money(record.tirePlugCents)}</span></div>
        <div className="flex justify-between gap-3"><span>Battery payouts</span><span className="font-semibold">+ {money(record.batteryPayoutCents)}</span></div>
        <div className="flex justify-between gap-3"><span>Busy-time bonus</span><span className="font-semibold">+ {money(record.busyBonusCents)}</span></div>
        <div className="flex justify-between gap-3 border-t border-ink-200 pt-1.5 text-sm font-black text-ink-900"><span>Total</span><span>{money(record.totalCents)}</span></div>
      </div>
      <p className={`mt-2 text-[11px] font-semibold ${lineTotal === record.totalCents ? "text-success-600" : "text-danger-600"}`}>
        {lineTotal === record.totalCents ? "✓ Line items reconcile exactly" : "⚠ Line-item mismatch — review manifest"}
      </p>
      {record.payrateCents == null || record.payrateCents === 0 ? <p className="mt-1 text-[11px] font-bold text-danger-600">Rate is $0.00 / not set — owner review required; no rate was invented.</p> : null}
    </div>
  );
}

function MoneyView() {
  const toast = useToast();
  const [overview, setOverview] = useState<{ revenueCents: number; revenueChargedCount: number; revenueStagedCount: number; tipsCents: number; tipsCount: number; weeklyTipsCents: number; weeklyTipCount: number; weeklyTipsByDriver: { driverId: string; driverName: string; tipsCents: number; tipCount: number }[]; payoutsDueCents: number; payoutsDueCount: number; payoutsDueOn: string | null; hasRealMoney: boolean } | null>(null);
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
  // Owner edit (Phase A 2026-08-13): full method row loaded for the inline editor.
  const [editMethodFor, setEditMethodFor] = useState<OwnerPayoutMethod | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  // Tip cash-outs (owner-directed 2026-08-12) — open requests + recently paid.
  const [cashouts, setCashouts] = useState<TipCashoutList | null>(null);
  const [tireLedger, setTireLedger] = useState<TirePlugLedgerRow[] | null>(null);
  const [markingTireId, setMarkingTireId] = useState<string | null>(null);
  const [markingCashoutId, setMarkingCashoutId] = useState<string | null>(null);
  // Top Tips KPI disclosure: load the real ledger only when the owner opens it.
  const [tipsExpanded, setTipsExpanded] = useState(false);
  const [tipsBreakdown, setTipsBreakdown] = useState<TipLedgerRow[] | null>(null);
  const [tipsBreakdownLoading, setTipsBreakdownLoading] = useState(false);
  const [tipsBreakdownError, setTipsBreakdownError] = useState(false);
  // Bank rail micro-deposit recording (blocked card) — the owner sends a small
  // test deposit from their own bank app and records the amount here (the
  // driver confirms it; the amount is never shown to the contractor client).
  const [depositOpenFor, setDepositOpenFor] = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositBusyFor, setDepositBusyFor] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    const res = await getMoneyOverview();
    if (res.ok) setOverview(res.data);
  }, []);

  const loadCashouts = useCallback(async () => {
    const res = await listTipCashoutRequests();
    if (res.ok) setCashouts(res.data);
    const plugs = await listTirePlugLedger();
    if (plugs.ok) setTireLedger(plugs.data);
  }, []);

  const loadTipsBreakdown = useCallback(async () => {
    setTipsBreakdownLoading(true);
    setTipsBreakdownError(false);
    const res = await listTips();
    setTipsBreakdownLoading(false);
    if (res.ok) setTipsBreakdown(res.data);
    else setTipsBreakdownError(true);
  }, []);

  const toggleTips = () => {
    const next = !tipsExpanded;
    setTipsExpanded(next);
    if (next && tipsBreakdown === null && !tipsBreakdownLoading) void loadTipsBreakdown();
  };

  const loadDetail = useCallback(async (periodId: string) => {
    setDetailError(null);
    const res = await getPayPeriodDetail({ data: { periodId } });
    if (res.ok && res.data) setDetail(res.data);
    else if (res.ok) setDetail(null);
    else setDetailError(res.message);
  }, []);

  useEffect(() => {
    void loadOverview();
    void loadCashouts();
    void listPayPeriods().then((res) => {
      if (!res.ok) { setDetailError(res.message); return; }
      setPeriods(res.data.periods);
      const def = res.data.defaultPeriodId || res.data.currentPeriodId;
      setSelectedId(def);
      void loadDetail(def);
    });
  }, [loadDetail, loadOverview, loadCashouts]);

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
    setEditMethodFor(null);
    void loadDetail(id);
  };

  const runCompute = async () => {
    if (!selectedId) return;
    setComputing(true);
    const res = await computePayday({ data: { periodId: selectedId } });
    setComputing(false);
    if (!res.ok) { setDetailError(res.message); return; }
    if (!res.data) { setDetailError("Pay period not found."); return; }
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
    if (!res.data) { setDetailError("Pay period not found."); return; }
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

  /** Owner edit (Phase A 2026-08-13): fetch the FULL method row (decrypted
   *  bank numbers included — owner-only surface) so the owner can correct a
   *  typo'd handle/account before approving. */
  const openEdit = async (record: PayoutRecord) => {
    setDetailError(null);
    const res = await getContractorPayoutMethod({ data: { contractorId: record.contractorId } });
    if (!res.ok) { setDetailError(res.message); return; }
    if (!res.data) { setDetailError("No payout method row on file for this contractor."); return; }
    setEditMethodFor(res.data);
  };
  const saveEdit = async (input: { rail: PayoutRail; handle: string | null; bankInstitutionName: string | null; bankLast4: string | null; bankRoutingNumber: string | null; bankAccountNumber: string | null }) => {
    if (!editMethodFor) return;
    setEditSaving(true);
    const res = await editPayoutMethod({ data: { methodId: editMethodFor.id, ...input } });
    setEditSaving(false);
    if (!res.ok) { setDetailError(res.message); return; }
    const name = editMethodFor.contractorName;
    setEditMethodFor(null);
    toast(`${name}'s payout method updated — re-verification required before payday.`);
    void loadDetail(selectedId ?? "");
  };

  /** Owner confirms they already sent the tip cash-out from their own app —
   *  marks the request PAID (idempotent server-side). */
  const markCashoutPaid = async (r: TipCashoutRequest) => {
    setMarkingCashoutId(r.id);
    const res = await markTipCashoutPaid({ data: { cashoutId: r.id } });
    setMarkingCashoutId(null);
    if (!res.ok) { setDetailError(res.message); return; }
    toast(`${r.contractorName} — ${money(r.amountCents)} tip cash-out marked paid`);
    void loadCashouts();
    void loadOverview();
  };

  /** Bank rail micro-deposit: the owner sent a small test deposit from their
   *  own bank app — record the amount so the contractor can confirm it. The
   *  amount is the verification secret and never leaves this screen. */
  const recordDeposit = async (methodId: string) => {
    const amountCents = Number(depositAmount.replace(/\D/g, ""));
    if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 10000) {
      setDetailError("Enter the test deposit amount in cents (1–10000) — e.g. 12 for $0.12.");
      return;
    }
    setDepositBusyFor(methodId);
    const res = await setBankDeposit({ data: { methodId, amountCents } });
    setDepositBusyFor(null);
    setDepositOpenFor(null);
    setDepositAmount("");
    if (!res.ok) { setDetailError(res.message); return; }
    toast("Test deposit recorded — the contractor confirms the amount to verify the bank account.");
  };

  /** Cashed-out tip totals per contractor (PAID requests only — a requested
   *  cash-out still owes its tips in payday). Presentation-only: the manifest
   *  amounts already exclude covered tips; this annotates why. */
  const cashedOutByContractor = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of cashouts?.paid ?? []) m.set(r.contractorId, (m.get(r.contractorId) ?? 0) + r.amountCents);
    return m;
  }, [cashouts]);
  const cashedOutTotalCents = useMemo(
    () => [...cashedOutByContractor.values()].reduce((s, c) => s + c, 0),
    [cashedOutByContractor],
  );


  // Inactive contractors are hidden from roster rows only. Keep money totals based
  // on the complete payout_records-backed detail so a hidden row can never change
  // what is due, paid, or otherwise recorded.
  const groupTotalsByRail = useMemo(() => {
    const totals = new Map<PayoutRail, number>();
    for (const rec of detail?.records ?? []) {
      if (rec.noActivityThisPeriod || rec.status !== "computed" || !rec.rail) continue;
      totals.set(rec.rail, (totals.get(rec.rail) ?? 0) + rec.totalCents);
    }
    return totals;
  }, [detail]);
  const paidTotalCents = useMemo(
    () => (detail?.records ?? []).reduce((sum, rec) => sum + (!rec.noActivityThisPeriod && rec.status === "paid" ? rec.totalCents : 0), 0),
    [detail],
  );
  const blockedTotalCents = useMemo(
    () => (detail?.records ?? []).reduce((sum, rec) => sum + (!rec.noActivityThisPeriod && rec.status === "blocked" ? rec.totalCents : 0), 0),
    [detail],
  );
  const groupByRail = useMemo(() => {
    const groups = new Map<PayoutRail, PayoutRecord[]>();
    for (const rec of detail?.records ?? []) {
      if (rec.noActivityThisPeriod || rec.status !== "computed" || !rec.rail || rec.contractorActive === false) continue;
      const arr = groups.get(rec.rail) ?? [];
      arr.push(rec);
      groups.set(rec.rail, arr);
    }
    return [...groups.entries()].sort((a, b) => (groupTotalsByRail.get(b[0]) ?? 0) - (groupTotalsByRail.get(a[0]) ?? 0));
  }, [detail, groupTotalsByRail]);
  const blocked = useMemo(() => (detail?.records ?? []).filter((r) => !r.noActivityThisPeriod && r.status === "blocked" && r.contractorActive !== false), [detail]);
  const paid = useMemo(() => (detail?.records ?? []).filter((r) => !r.noActivityThisPeriod && r.status === "paid" && r.contractorActive !== false), [detail]);
  const noActivity = useMemo(() => (detail?.records ?? []).filter((r) => r.noActivityThisPeriod && r.contractorActive !== false), [detail]);

  if (!periods || !overview) {
    return (
      <AppShell portal="owner" title="Payments" description="Payday manifest, motor-club card charges, and driver tips.">
        <BoardSkeleton rows={3} />
      </AppShell>
    );
  }

  return (
    <AppShell portal="owner" title="Payments" description="Payday manifest, motor-club card charges, and driver tips — all money settles in your Square account, nothing is ever transferred out.">
      <div className="space-y-5">
        {!overview.hasRealMoney && (
          <Alert variant="info">No payments processed yet — Stripe onboarding not complete.</Alert>
        )}

        {/* stat cards */}
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            topBar
            label="Revenue"
            value={<span className="text-brand-700">{money(overview.revenueCents)}</span>}
            detail={`Motor-club card charges — ${money(overview.revenueCents)} charged · ${overview.revenueStagedCount} staged`}
          />
          <button
            type="button"
            className="min-h-[92px] rounded-2xl text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-expanded={tipsExpanded}
            aria-controls="tips-breakdown"
            onClick={toggleTips}
          >
            <StatCard
              label="Tips"
              value={<span className="text-success-600">{money(overview.tipsCents)}</span>}
              detail={`${overview.tipsCount} paid tips — attributed to drivers${(cashouts?.openTotalCents ?? 0) > 0 ? ` · ${money(cashouts!.openTotalCents)} in open cash-outs` : ""}`}
            />
          </button>
          <Card className="p-4 sm:col-span-3">
            <div className="flex items-center justify-between gap-3">
              <div><p className="text-xs font-bold uppercase tracking-wide text-ink-400">This week&apos;s tips</p><p className="text-2xl font-bold tabular-nums text-success-600">{money(overview.weeklyTipsCents)}</p></div>
              <p className="text-xs text-ink-500">{overview.weeklyTipCount} paid tip{overview.weeklyTipCount === 1 ? "" : "s"} · Mon–Sun</p>
            </div>
            <div className="mt-3 divide-y divide-ink-100 border-t border-ink-100">
              {overview.weeklyTipsByDriver.map((d) => <div key={d.driverId} className="flex items-center justify-between py-2 text-sm"><span className="font-semibold text-ink-700">{d.driverName}</span><span className="tabular-nums font-bold text-success-600">{money(d.tipsCents)} <span className="text-xs font-normal text-ink-400">({d.tipCount})</span></span></div>)}
              {overview.weeklyTipsByDriver.length === 0 && <p className="py-2 text-xs text-ink-400">No paid tips this week.</p>}
            </div>
          </Card>
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

        {tipsExpanded && (
          <section id="tips-breakdown" aria-label="Tips breakdown" className="-mt-2">
            {tipsBreakdownLoading ? (
              <div className="h-40 animate-pulse rounded-2xl bg-ink-100/70" aria-busy="true" aria-label="Loading tips breakdown" />
            ) : tipsBreakdownError ? (
              <Alert variant="danger">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>Tips could not be loaded. Try again.</span>
                  <Button size="sm" variant="secondary" onClick={() => void loadTipsBreakdown()}>Try again</Button>
                </div>
              </Alert>
            ) : tipsBreakdown?.length === 0 ? (
              <EmptyState icon={Wallet} title="No tips yet" body="Customer tips will appear here after a completed job records a tip." />
            ) : tipsBreakdown ? (
              <Card className="overflow-hidden">
                <div className="border-b border-ink-100 bg-ink-50/50 px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <h2 className="text-sm font-bold text-ink-800">Tips breakdown</h2>
                    <span className="text-sm font-bold tabular-nums text-ink-900">{money(overview.tipsCents)} · {overview.tipsCount} {overview.tipsCount === 1 ? "tip" : "tips"}{(cashouts?.openTotalCents ?? 0) > 0 ? ` · ${money(cashouts!.openTotalCents)} open cash-outs` : ""}</span>
                  </div>
                </div>
                <div className="divide-y divide-ink-100">
                  {tipsBreakdown.map((tip) => {
                    const badge = STATUS_BADGE[tip.status] ?? STATUS_BADGE.voided;
                    return (
                      <div key={tip.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
                        <Avatar name={tip.driverName ?? "Driver"} className="size-9" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-ink-800">{tip.driverName ?? "Driver"}</p>
                          <p className="flex flex-wrap gap-x-1 text-xs text-ink-400">
                            {tip.driverTowbookId ? <span>{tip.driverTowbookId}</span> : null}
                            {tip.jobId ? <span>· Job {tip.jobId}</span> : null}
                            <span>· {fmtDate(tip.createdAt)}</span>
                            {tip.squarePaymentId && tip.status === "charged" ? <span>· Square ✓</span> : null}
                          </p>
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-2">
                          <StatusBadge className={badge.cls} dot={badge.dot}>{badge.label}</StatusBadge>
                          <p className="text-[15px] font-extrabold tabular-nums text-ink-900">{money(tip.amountCents)}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            ) : null}
          </section>
        )}

        {/* ---------------------- battery sales (owner-spec'd 2026-08-13) ---------------------- */}
        <BatterySalesSection />

        {/* ------------------------- tip cash-outs ------------------------- */}
        <section aria-label="Tip cash-outs" className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-ink-800">Tip cash-outs</h2>
              <p className="mt-0.5 text-xs text-ink-500">
                Drivers cash out tips with one tap — you send from your own app and mark the request paid. Cashed-out tips never appear in payday again.
              </p>
            </div>
            {(cashouts?.openTotalCents ?? 0) > 0 && (
              <span className="shrink-0 rounded-full bg-accent-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-accent-700">
                {money(cashouts!.openTotalCents)} open
              </span>
            )}
          </div>

          {cashouts === null ? (
            <div className="h-28 animate-pulse rounded-2xl bg-ink-100/70" aria-busy="true" />
          ) : cashouts.open.length === 0 && cashouts.paid.length === 0 ? (
            <EmptyState
              icon={CircleDollarSign}
              title="No tip cash-outs yet"
              body="When a driver taps cash out, the request lands here — send it from your own app and mark it paid."
            />
          ) : (
            <Card className="divide-y divide-ink-100">
              {cashouts.open.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
                  <Avatar name={r.contractorName} className="size-9" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-800">{r.contractorName}</p>
                    <p className="text-xs text-ink-400">
                      {RAIL_LABELS[r.rail] ?? r.rail} {r.handleMasked} · {timeLabel(r.createdAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold tabular-nums text-ink-900">{money(r.amountCents)}</p>
                    <StatusBadge className="bg-info-100 text-info-700" dot>Requested</StatusBadge>
                  </div>
                  <Button variant="primary" size="md" loading={markingCashoutId === r.id} disabled={markingCashoutId !== null} onClick={() => void markCashoutPaid(r)}>
                    Mark paid
                  </Button>
                </div>
              ))}
              {cashouts.paid.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Avatar name={r.contractorName} className="size-9" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-800">{r.contractorName}</p>
                    <p className="text-xs text-ink-400">
                      {RAIL_LABELS[r.rail] ?? r.rail} {r.handleMasked} · paid {timeLabel(r.paidAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold tabular-nums text-ink-500">{money(r.amountCents)}</p>
                    <StatusBadge className="bg-success-100 text-success-700">Paid</StatusBadge>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </section>

        <section aria-label="Tire-plug ledger" className="space-y-3"><div><h2 className="text-base font-bold text-ink-800">Tire-plug requests</h2><p className="mt-0.5 text-xs text-ink-500">Send the contractor $45 outside Lightning Dispatch, then mark the request paid.</p></div>{tireLedger === null ? <div className="h-20 animate-pulse rounded-2xl bg-ink-100/70" /> : tireLedger.length === 0 ? <EmptyState icon={Zap} title="No tire-plug requests yet" body="Accepted tire-plug charges appear here after completion." /> : <Card className="divide-y divide-ink-100">{tireLedger.map((r) => <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5"><Avatar name={r.contractorName} className="size-9" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-ink-800">{r.contractorName}</p><p className="text-xs text-ink-400">Tire plug · {new Date(r.createdAt).toLocaleDateString()}</p></div><div className="text-right"><p className="text-sm font-bold">{money(r.amountCents)}</p><StatusBadge className={r.status === "paid" ? "bg-success-100 text-success-700" : "bg-info-100 text-info-700"}>{r.status}</StatusBadge></div>{r.status !== "paid" && <Button size="md" variant="primary" loading={markingTireId === r.id} onClick={async () => { setMarkingTireId(r.id); await markTirePlugPaid({ data: { transactionId: r.id } }); setMarkingTireId(null); void loadCashouts(); }}>Mark paid</Button>}</div>)}</Card>}</section>

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
                  {p.isCurrent ? "Open period" : `${formatEtDate(p.startsAt)} – ${formatEtDate(new Date(new Date(p.endsAt).getTime() - 1).toISOString())}`}
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
          {detail && detail.records.some((r) => r.payrateCents == null || r.payrateCents === 0) && (
            <Alert variant="danger"><strong>Rate review required:</strong> one or more contractors have a $0.00 or unset rate. The manifest preserves that real rate and does not invent pay.</Alert>
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

          {/* Complete roster rows with no earnings/components are display-only. */}
          {noActivity.length > 0 && (
            <Card className="overflow-hidden border-ink-200">
              <div className="flex items-center gap-2.5 border-b border-ink-100 bg-ink-50/50 px-4 py-3">
                <span className="text-sm font-bold text-ink-700">No activity this period</span>
                <span className="ml-auto text-sm font-black tabular-nums text-ink-500">{noActivity.length}</span>
              </div>
              {noActivity.map((rec) => (
                <div key={rec.id} className="border-b border-ink-100 px-4 py-3.5 last:border-0">
                  <div className="flex items-center gap-3">
                    <Avatar name={rec.contractorName} className="size-9" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink-800">{rec.contractorName}{rec.contractorActive === false && <span className="ml-2 text-[11px] font-bold uppercase tracking-wide text-ink-400">Inactive</span>}</p>
                      <p className="text-xs text-ink-400">0 jobs · display-only roster row</p>
                    </div>
                    <p className="text-sm font-bold tabular-nums text-ink-900">{money(0)}</p>
                  </div>
                  <PaymentBreakdown record={rec} />
                </div>
              ))}
            </Card>
          )}

          {/* rail groups */}
          {groupByRail.map(([rail, recs]) => {
            // This header remains based on all computed records, including hidden
            // inactive contractors; only the roster rows are display-filtered.
            const groupTotal = groupTotalsByRail.get(rail) ?? 0;
            const Icon = RAIL_ICONS[rail];
            return (
              <Card key={rail} className="overflow-hidden">
                <div className="flex items-center gap-2.5 border-b border-ink-100 bg-ink-50/50 px-4 py-3">
                  <span className="grid size-8 place-items-center rounded-lg bg-ink-100 text-ink-600"><Icon className="size-4" strokeWidth={2} /></span>
                  <span className="text-sm font-bold text-ink-700">{RAIL_LABELS[rail]}</span>
                  <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-bold tabular-nums text-ink-600">{recs.length}</span>
                  <span className="ml-auto text-sm font-black tabular-nums text-ink-900">— {money(groupTotal)}</span>
                </div>
                {recs.map((rec) => (
                  <div key={rec.id} className="border-b border-ink-100 px-4 py-3.5 last:border-0">
                    <div className="flex items-center gap-3">
                      <Avatar name={rec.contractorName} className="size-9" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-ink-800">{rec.contractorName}{rec.contractorActive === false && <span className="ml-2 text-[11px] font-bold uppercase tracking-wide text-ink-400">Inactive</span>}</p>
                        <p className="text-xs text-ink-400">
                          {rec.rail && rec.handleFull ? (
                            <span className="font-mono">{rec.handleFull} — verified ✓</span>
                          ) : (
                            "verified payout method"
                          )}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold tabular-nums text-ink-900">{money(rec.totalCents)}</p>
                        <PaymentBreakdown record={rec} />
                      </div>
                      <Button variant="primary" size="md" className="shrink-0" onClick={() => { setConfirmMarkId(rec.id); setMarkNote(""); }}>Mark paid</Button>
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
                <span className="ml-auto text-sm font-black tabular-nums text-success-600">{money(paidTotalCents)}</span>
              </div>
              {paid.map((rec) => (
                <div key={rec.id} className="flex items-center gap-3 border-b border-ink-100 px-4 py-3.5 last:border-0">
                  <Avatar name={rec.contractorName} className="size-9" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-800">{rec.contractorName} ✓</p>
                    <PaymentBreakdown record={rec} />
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
                <span className="ml-auto text-sm font-black tabular-nums text-danger-700">{money(blockedTotalCents)}</span>
              </div>
              {blocked.map((rec) => (
                <div key={rec.id} className="border-b border-ink-100 px-4 py-3.5 last:border-0">
                  <div className="flex items-center gap-3">
                    <Avatar name={rec.contractorName} className="size-9" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink-800">{rec.contractorName}</p>
                      <p className="text-xs text-ink-400">
                        {rec.methodStatus === "connected_unverified" && (
                          <span className="text-info-600">Awaiting verification{rec.rail && rec.handleFull ? ` — ${rec.handleFull}` : ""}</span>
                        )}
                        {rec.methodStatus === "rejected" && <span className="text-danger-600">Rejected — ask the contractor to fix it</span>}
                        {rec.methodStatus === "none" && "No payout method on file"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold tabular-nums text-ink-900">{money(rec.totalCents)} due</p>
                      <PaymentBreakdown record={rec} />
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <span className="inline-flex min-h-[22px] items-center gap-1.5 rounded-full bg-danger-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-danger-700">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-80" /> Blocked
                    </span>
                    {(rec.methodStatus === "connected_unverified" || rec.methodStatus === "rejected") && (
                      <>
                        {rec.rail === "bank" && rec.methodStatus === "connected_unverified" && (
                          <>
                            {depositOpenFor === rec.methodId ? (
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="text-[11px] text-ink-500">Sent $0.01–$1.00 from your bank app — enter the amount in cents:</span>
                                <input
                                  value={depositAmount}
                                  onChange={(e) => { setDepositAmount(e.target.value.replace(/\D/g, "").slice(0, 5)); }}
                                  placeholder="e.g. 12"
                                  inputMode="numeric"
                                  aria-label="Test deposit amount in cents"
                                  className="h-10 w-24 rounded-lg border border-ink-200 bg-surface px-2 text-xs outline-none focus:border-brand-500"
                                />
                                <Button variant="ghost" size="sm" loading={depositBusyFor === rec.methodId} onClick={() => void recordDeposit(rec.methodId!)}>Save</Button>
                                <Button variant="ghost" size="sm" onClick={() => { setDepositOpenFor(null); setDepositAmount(""); }}>Cancel</Button>
                              </span>
                            ) : (
                              <Button variant="ghost" size="sm" onClick={() => { setDepositOpenFor(rec.methodId); setDepositAmount(""); setRejectOpenFor(null); }}>
                                Record test deposit
                              </Button>
                            )}
                          </>
                        )}
                        <Button variant="ghost" size="sm" loading={verifyBusy === rec.id} onClick={() => void runVerify(rec)}>Verify</Button>
                        {rejectOpenFor === rec.id ? (
                          <span className="flex items-center gap-1.5">
                            <input
                              value={rejectNote}
                              onChange={(e) => setRejectNote(e.target.value)}
                              placeholder="Reason"
                              className="h-10 w-36 rounded-lg border border-ink-200 bg-surface px-2 text-xs outline-none focus:border-brand-500"
                            />
                            <Button variant="danger-ghost" size="sm" loading={rejectBusy === rec.id} onClick={() => void runReject(rec)}>Confirm</Button>
                            <Button variant="ghost" size="sm" onClick={() => { setRejectOpenFor(null); setRejectNote(""); }}>Cancel</Button>
                          </span>
                        ) : (
                          <Button variant="danger-ghost" size="sm" onClick={() => { setRejectOpenFor(rec.id); setRejectNote(""); }}>Reject</Button>
                        )}
                        <Button variant="ghost" size="sm" loading={editSaving && editMethodFor?.contractorId === rec.contractorId} disabled={editSaving} onClick={() => void openEdit(rec)}>Edit</Button>
                      </>
                    )}
                    <p className="text-[11px] text-ink-400">Nothing is dropped — this amount waits for a verified method, then recompute moves it into its rail group.</p>
                  </div>
                  {editMethodFor?.contractorId === rec.contractorId && (
                    <OwnerPayoutMethodEditor
                      method={editMethodFor}
                      saving={editSaving}
                      onSave={saveEdit}
                      onCancel={() => setEditMethodFor(null)}
                    />
                  )}
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
                {detail.totals.busyBonusCents > 0 && <span className="text-brand-700"> · {money(detail.totals.busyBonusCents)} busy-time bonus</span>}
                {detail.totals.batteryPayoutCents > 0 && <span className="text-brand-700"> · {money(detail.totals.batteryPayoutCents)} battery installs</span>}
                {cashedOutTotalCents > 0 && <span className="text-info-600"> · {money(cashedOutTotalCents)} cashed out directly to contractors</span>}
                {detail.totals.blockedCount > 0 && <span className="text-danger-600"> · {detail.totals.blockedCount} blocked</span>}
              </p>
            </Card>
          )}
        </section>

        {/* ------------------------- payment engine ------------------------- */}
        <div className="border-t border-ink-200 pt-5">
          <PaymentsSection />
        </div>
      </div>
    </AppShell>
  );
}

/* ============================ payment engine ============================ */

const fmtMoney = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

const STATUS_BADGE: Record<string, { cls: string; label: string; dot: boolean }> = {
  staged: { cls: "bg-accent-100 text-accent-700", label: "Staged", dot: true },
  charged: { cls: "bg-success-100 text-success-700", label: "Charged", dot: false },
  failed: { cls: "bg-danger-100 text-danger-700", label: "Failed", dot: false },
  voided: { cls: "bg-ink-100 text-ink-500", label: "Voided", dot: false },
};

/** The PO's own card, as parsed from its email: "Visa ••4242 · exp 12/27 ·
 *  zip 06606" (brand/last4/expiry/zip are display hints only — the full PAN
 *  never touches Lightning Dispatch). */
const cardLabel = (t: PaymentTxnRow): string | null => {
  const parts: string[] = [];
  if (t.cardBrand) parts.push(t.cardBrand);
  if (t.cardLast4) parts.push(`••${t.cardLast4}`);
  if (t.cardExpiry) parts.push(`exp ${t.cardExpiry}`);
  if (t.cardBillingZip) parts.push(`zip ${t.cardBillingZip}`);
  return parts.length ? parts.join(" · ") : null;
};

/* ---------- Square Web Payments SDK (client-side card tokenization) ---------- */
type SquareCard = {
  attach: (containerId: string) => Promise<void>;
  tokenize: () => Promise<{ status: string; token?: string; errors?: Array<{ code: string; detail: string }> }>;
  destroy: () => Promise<void>;
};
type SquarePaymentsFactory = { card: () => Promise<SquareCard> };
type SquareGlobal = { payments: (applicationId: string, locationId: string) => SquarePaymentsFactory };
let squareScriptPromise: Promise<void> | null = null;
function loadSquareScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Client only"));
  if ((window as unknown as { Square?: unknown }).Square) return Promise.resolve();
  squareScriptPromise ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://web.squarecdn.com/v1/square.js";
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { squareScriptPromise = null; reject(new Error("Square payments couldn't load — check the connection.")); };
    document.head.appendChild(el);
  });
  return squareScriptPromise;
}

/** Inline Square Web Payments card form for ONE staged row — the owner enters
 *  the card shown in THIS PO's email (the full number stays inside Square's
 *  secure iframe; Lightning Dispatch only ever sees the nonce). On submit the
 *  nonce is sent to chargeStaged → exactly one idempotent POST /v2/payments
 *  on the owner's Square account. */
function ChargeCardForm({ txn, onCharged, onCancel, publicConfig }: {
  txn: PaymentTxnRow;
  onCharged: (row: PaymentTxnRow) => void;
  onCancel: () => void;
  publicConfig: { applicationId: string; locationId: string } | null;
}) {
  const [card, setCard] = useState<SquareCard | null>(null);
  const [cardError, setCardError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const containerIdRef = useRef(`sq-charge-${Math.random().toString(36).slice(2, 10)}`);
  useEffect(() => {
    let disposed = false;
    let created: SquareCard | null = null;
    void (async () => {
      try {
        if (!publicConfig) throw new Error("Square payments aren't configured — add the owner's Square credentials first.");
        await loadSquareScript();
        if (disposed) return;
        const sq = (window as unknown as { Square?: SquareGlobal }).Square;
        const payments = sq?.payments(publicConfig.applicationId, publicConfig.locationId);
        if (!payments) throw new Error("Square payments couldn't start — refresh the page.");
        created = await payments.card();
        await created.attach(`#${containerIdRef.current}`);
        if (disposed) { await created.destroy().catch(() => {}); return; }
        setCard(created);
      } catch (err) {
        if (!disposed) setCardError(err instanceof Error ? err.message : "Couldn't start the card form.");
      }
    })();
    return () => {
      disposed = true;
      if (created) void created.destroy().catch(() => {});
    };
  }, [publicConfig]);
  const save = async () => {
    if (!card) return;
    setSaving(true);
    setError("");
    try {
      const tok = await card.tokenize();
      if (tok.status !== "OK" || !tok.token) {
        setError(tok.errors?.[0]?.detail ?? "The card couldn't be read — check the details and try again.");
        return;
      }
      const r = await chargeStaged({ data: { txnId: txn.id, sourceId: tok.token } });
      if (r.ok) {
        onCharged(r.data);
      } else {
        setError(r.message || "The charge failed — try again.");
      }
    } catch {
      setError("The charge failed — check your connection and try again.");
    }
    setSaving(false);
  };
  return (
    <div className="mt-3 rounded-xl border border-ink-200 bg-canvas/60 p-3">
      <p className="mb-2 text-xs font-semibold text-ink-700">
        {cardLabel(txn) ? (
          <>Card on file from email: <span className="text-ink-900">{cardLabel(txn)}</span> — enter the full number below.</>
        ) : (
          <>No card was in this email — check the PO email or enter the card details manually.</>
        )}
      </p>
      <div id={containerIdRef.current} className="min-h-[64px]" />
      {cardError && <p role="alert" className="mt-1.5 text-[11px] leading-snug text-danger-600">{cardError}</p>}
      {error && <p role="alert" className="mt-1.5 text-[11px] leading-snug text-danger-600">{error}</p>}
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" className="flex-1" loading={saving} disabled={!card} onClick={() => void save()}>
          {card ? `Charge ${fmtMoney(txn.amountCents)}` : "Loading card form…"}
        </Button>
        <Button size="sm" variant="secondary" disabled={saving} onClick={onCancel}>Cancel</Button>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-ink-400">
        The card is tokenized by Square in a secure iframe — the full number never touches Lightning Dispatch. The charge settles into your Square account; nothing is transferred out.
      </p>
    </div>
  );
}

/** The payment engine slice: scan inbox → staged club charges (each row shows
 *  ITS OWN card from the PO email) → owner charges per row either through
 *  Square's secure card form or by marking a charge they already made in their
 *  own Square dashboard. No per-club card on file. */
function PaymentsSection() {
  const [txns, setTxns] = useState<PaymentTxnRow[] | null>(null);
  const [tips, setTips] = useState<TipLedgerRow[] | null>(null);
  const [publicConfig, setPublicConfig] = useState<{ applicationId: string; locationId: string } | null>(null);
  const [configError, setConfigError] = useState("");
  const [scanning, setScanning] = useState<"scan" | "preview" | null>(null);
  const [scanMsg, setScanMsg] = useState<{ kind: "success" | "danger"; text: string } | null>(null);
  const [chargingId] = useState<string | null>(null);
  const [chargeErrors, setChargeErrors] = useState<Record<string, string>>({});
  /** txnId → open Square card form for that row */
  const [openChargeForm, setOpenChargeForm] = useState<string | null>(null);
  /** txnId → open "mark charged (outside)" confirmation */
  const [markOutsideConfirmId, setMarkOutsideConfirmId] = useState<string | null>(null);
  const [markingOutsideId, setMarkingOutsideId] = useState<string | null>(null);
  const [markOutsideNote, setMarkOutsideNote] = useState("");

  const refresh = async () => {
    const [t, ti, cfg] = await Promise.all([
      listStagedCharges(),
      listTips(),
      getPaymentSquareConfig(),
    ]);
    if (t.ok) setTxns(t.data);
    if (ti.ok) setTips(ti.data);
    if (cfg.ok) setPublicConfig(cfg.data);
    else setConfigError(cfg.message);
  };
  useEffect(() => { void refresh(); }, []);

  const clubRows = (txns ?? []).filter((t) => t.kind === "club_charge");
  const chargeable = (t: PaymentTxnRow) => t.status === "staged" || t.status === "failed";

  const runScan = async (dryRun: boolean) => {
    setScanning(dryRun ? "preview" : "scan");
    setScanMsg(null);
    const r = await scanClubMail({ data: { dryRun } });
    setScanning(null);
    if (!r.ok) {
      setScanMsg({ kind: "danger", text: r.error || "The mailbox scan failed." });
      return;
    }
    if (dryRun) {
      setScanMsg({ kind: "success", text: `Scanned ${r.scanned} messages — ${r.candidates} charge notification${r.candidates === 1 ? "" : "s"} found (${r.staged} would be staged, ${r.alreadyStaged} already staged, ${r.skipped} skipped). Preview only — nothing was written.` });
    } else {
      setScanMsg({ kind: "success", text: `Scanned ${r.scanned} messages — ${r.staged} new charge${r.staged === 1 ? "" : "s"} staged, ${r.alreadyStaged} already staged, ${r.skipped} skipped. Review them below and charge when ready.` });
      void refresh();
    }
  };

  const onCharged = (row: PaymentTxnRow) => {
    setOpenChargeForm(null);
    setScanMsg({ kind: "success", text: `${row.clubName ?? "Club charge"} — ${fmtMoney(row.amountCents)} charged to your Square account${row.squarePaymentId ? " ✓" : ""}.` });
    void refresh();
  };

  const confirmMarkOutside = async (t: PaymentTxnRow) => {
    setMarkingOutsideId(t.id);
    const r = await markChargedOutside({ data: { txnId: t.id, note: markOutsideNote.trim() || null } });
    setMarkingOutsideId(null);
    setMarkOutsideConfirmId(null);
    setMarkOutsideNote("");
    if (r.ok) {
      setScanMsg({ kind: "success", text: `${t.clubName ?? "Club charge"} — ${fmtMoney(t.amountCents)} marked charged (paid outside Square).` });
      void refresh();
    } else {
      setChargeErrors((e) => ({ ...e, [t.id]: r.message || "Couldn't mark the charge paid." }));
    }
  };

  return (
    <div className="space-y-6">
      <Alert variant="info">
        <div>
          <p className="font-semibold">How club charges work</p>
          <p className="mt-0.5 text-xs leading-relaxed opacity-90">
            The scanner pulls motor-club charge notifications from <strong>lightroad29@gmail.com</strong> and stages only real club payments that carry a card — each row shows that PO's own card hints (brand, last 4, expiry, zip — read from the email; the full card number never touches Lightning Dispatch). Nothing is ever auto-charged. To charge a row, open the card form — the card hints are shown right there, and you enter the full number into Square's secure form, which tokenizes it and charges your Square account (funds stay there, nothing is transferred out). Or charge it in your own Square dashboard and tap <strong>Mark charged</strong>.
          </p>
        </div>
      </Alert>

      {/* ------------------------------ scan ------------------------------ */}
      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><RefreshCcw className="size-5" /></span>
            <div>
              <p className="text-sm font-bold text-ink-900">Scan inbox</p>
              <p className="text-xs text-ink-400">Pull new motor-club charge notifications from Gmail (last 14 days).</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" loading={scanning === "preview"} disabled={scanning !== null} onClick={() => void runScan(true)}>
              Preview
            </Button>
            <Button size="sm" loading={scanning === "scan"} disabled={scanning !== null} onClick={() => void runScan(false)}>
              Run scan
            </Button>
          </div>
        </div>
        {scanMsg && (
          <p role={scanMsg.kind === "danger" ? "alert" : "status"} className={`mt-3 rounded-lg px-3 py-2 text-xs font-medium ${scanMsg.kind === "danger" ? "bg-danger-50 text-danger-700" : "bg-success-50 text-success-700"}`}>
            {scanMsg.text}
          </p>
        )}
        {configError && <Alert variant="warning"><span>Square payments aren't configured — the owner's Square credentials (access token, location id, application id) are needed before staged rows can be charged. Existing charges stay listed.</span></Alert>}
      </Card>

      {/* --------------------------- club charges --------------------------- */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">Club charges</h2>
          <span className="text-xs text-ink-400">{clubRows.length} total</span>
        </div>
        {txns === null ? (
          <Card className="p-6 text-center text-sm text-ink-400"><Loader2 className="mx-auto mb-2 size-5 animate-spin" />Loading charges…</Card>
        ) : clubRows.length === 0 ? (
          <EmptyState icon={Banknote} title="No club charges yet" body="Run a scan to pull motor-club charge notifications from the inbox, or wait for the next one to arrive." />
        ) : (
          <div className="space-y-2.5">
            {clubRows.map((t) => {
              const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.staged;
              const err = chargeErrors[t.id];
              const card = cardLabel(t);
              return (
                <Card key={t.id} className="p-3.5 sm:p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold text-ink-900">{t.clubName ?? "Unknown club"}</p>
                        <StatusBadge className={badge.cls} dot={badge.dot}>{badge.label}</StatusBadge>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-400">
                        {card ? <span className="font-medium text-ink-600">{card}</span> : t.status === "charged" ? null : <span className="text-ink-300">No card from email — manual entry</span>}
                        {t.poRef ? <> · PO {t.poRef}</> : null}
                        {t.status === "charged" && (
                          <span className={t.chargePath === "outside" ? "text-ink-500" : "text-success-600"}>
                            {" "}· {t.chargePath === "outside" ? "charged in your Square dashboard — marked paid" : "charged via Square ✓"}
                          </span>
                        )}
                        <span className="text-ink-300"> · received {fmtDate(t.sourceEmailReceivedAt ?? t.createdAt)}</span>
                      </p>
                      {err && <p role="alert" className="mt-1.5 text-[11px] leading-snug text-danger-600">{err}</p>}
                    </div>
                    <p className="shrink-0 text-[15px] font-extrabold tabular-nums text-ink-900">{fmtMoney(t.amountCents)}</p>
                  </div>
                  {chargeable(t) && (
                    <div className="mt-2.5 border-t border-ink-100 pt-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant={t.status === "failed" ? "danger" : "primary"}
                          loading={chargingId === t.id}
                          disabled={chargingId !== null || markingOutsideId !== null}
                          onClick={() => setOpenChargeForm(openChargeForm === t.id ? null : t.id)}
                        >
                          <Zap className="size-3.5" /> {t.status === "failed" ? "Retry charge" : "Charge"}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={chargingId !== null || markingOutsideId !== null}
                          onClick={() => setMarkOutsideConfirmId(markOutsideConfirmId === t.id ? null : t.id)}
                        >
                          Mark charged (outside)
                        </Button>
                        {t.status === "failed" && <span className="text-[11px] text-ink-400">Declined — retry with a fresh card entry.</span>}
                      </div>
                      {openChargeForm === t.id && (
                        <ChargeCardForm txn={t} publicConfig={publicConfig} onCharged={onCharged} onCancel={() => setOpenChargeForm(null)} />
                      )}
                      {markOutsideConfirmId === t.id && (
                        <div className="mt-3 rounded-xl border border-ink-200 bg-ink-50/50 p-3">
                          <p className="text-xs leading-relaxed text-ink-700">
                            Did you already charge <span className="font-bold tabular-nums">{fmtMoney(t.amountCents)}</span> for {t.clubName ?? "this club"}
                            {t.poRef ? <> (PO {t.poRef})</> : null} in your own Square dashboard? Marking it here records it as paid — no Square call is made.
                          </p>
                          <input
                            value={markOutsideNote}
                            onChange={(e) => setMarkOutsideNote(e.target.value)}
                            placeholder="Optional note (e.g. dashboard, date)"
                            className="mt-2 h-10 w-full rounded-lg border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500"
                          />
                          <div className="mt-2 flex gap-2">
                            <Button size="sm" loading={markingOutsideId === t.id} onClick={() => void confirmMarkOutside(t)}>Yes — marked paid</Button>
                            <Button size="sm" variant="ghost" disabled={markingOutsideId !== null} onClick={() => { setMarkOutsideConfirmId(null); setMarkOutsideNote(""); }}>Cancel</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ------------------------------ tips ------------------------------ */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">Driver tips</h2>
          <span className="text-xs text-ink-400">Separate from club charges</span>
        </div>
        {tips === null ? (
          <Card className="p-6 text-center text-sm text-ink-400"><Loader2 className="mx-auto mb-2 size-5 animate-spin" />Loading tips…</Card>
        ) : tips.length === 0 ? (
          <EmptyState icon={Wallet} title="No tips yet" body="Customer tips charged through your Square account appear here, attributed to the driver who earned them." />
        ) : (
          <div className="space-y-2.5">
            {tips.map((t) => (
              <Card key={t.id} className="flex items-center justify-between gap-3 p-3.5 sm:p-4">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-ink-900">{t.driverName ?? "Driver"}</p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {t.jobId ? <>Job {t.jobId} · </> : null}
                    {fmtDate(t.createdAt)}
                    {t.squarePaymentId ? <> · Square ✓</> : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge className={STATUS_BADGE[t.status]?.cls ?? STATUS_BADGE.staged.cls} dot={STATUS_BADGE[t.status]?.dot}>{STATUS_BADGE[t.status]?.label ?? t.status}</StatusBadge>
                  <p className="text-[15px] font-extrabold tabular-nums text-ink-900">{fmtMoney(t.amountCents)}</p>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <p className="flex items-start gap-1.5 pb-4 text-[11px] leading-relaxed text-ink-400">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        Funds never leave your Square account — club charges settle into your Square balance like any other payment. Every charge runs only after you tap Charge on the staged row (or mark it after charging in your own dashboard). Weekly payday payouts are in the manifest above.
      </p>
    </div>
  );
}

/* ------------------------- Battery sales (owner-spec'd 2026-08-13) ------------------------- */
import { BatteryCharging } from "lucide-react";
import { listBatterySales, type BatterySaleOwnerRow } from "~/data/battery-sales";
const SALE_META: Record<string, { label: string; badge: string }> = {
  quote: { label: "Quote", badge: "bg-ink-100 text-ink-600" },
  approved: { label: "Approved", badge: "bg-accent-100 text-accent-700" },
  paid: { label: "Paid", badge: "bg-success-100 text-success-700" },
  voided: { label: "Declined", badge: "bg-ink-50 text-ink-500" },
};
function BatterySalesSection() {
  const [sales, setSales] = useState<BatterySaleOwnerRow[] | null>(null);
  const load = useCallback(() => {
    void listBatterySales().then(setSales).catch(() => setSales([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <section aria-label="Battery sales" className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-ink-800">Battery sales</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Jumpstart battery sales run on the contractor&apos;s phone — customer-present charge to your Square account, tax + admin fee on the battery price only.
          </p>
        </div>
      </div>
      {sales === null ? (
        <div className="h-28 animate-pulse rounded-2xl bg-ink-100/70" aria-busy="true" />
      ) : sales.length === 0 ? (
        <EmptyState
          icon={BatteryCharging}
          title="No battery sales yet"
          body="When a contractor records a faulty battery on a jumpstart job, the AI Battery Sales Agent runs the sale — paid sales land here."
        />
      ) : (
        <Card className="divide-y divide-ink-100">
          {sales.map((s) => {
            const meta = SALE_META[s.status] ?? SALE_META.quote;
            return (
              <div key={s.id} className="space-y-1.5 px-4 py-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 text-sm font-bold text-ink-800">
                    {s.vehicleYear} {s.vehicleMake} {s.vehicleModel}
                    <span className="ml-2 font-normal text-ink-400">Vehicle details available in the assigned job</span>
                  </p>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.badge}`}>{meta.label}</span>
                </div>
                <p className="text-[11px] text-ink-500">
                  {s.contractorName} · job {s.jobLabel} · VIN •••••••••••{(s as BatterySaleOwnerRow & { vin?: string }).vin?.slice(-4) ?? "—"}
                  {s.installJobId ? ` · install job ${s.installJobId}` : ""}
                  {s.paidAt ? ` · paid ${new Date(s.paidAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
                  {s.squareChargeId ? ` · Square ${s.squareChargeId.slice(0, 12)}` : ""}
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-ink-500">
                  <span>Battery {formatCents(s.batteryPriceCents ?? 0)}</span>
                  <span>Install {formatCents(s.installFeeCents ?? 0)}</span>
                  <span>Tax {formatCents(s.salesTaxCents ?? 0)}</span>
                  <span>Admin {formatCents(s.adminFeeCents ?? 0)}</span>
                  <span className="text-xs font-black text-ink-800">Total {formatCents(s.totalCents ?? 0)}</span>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </section>
  );
}
