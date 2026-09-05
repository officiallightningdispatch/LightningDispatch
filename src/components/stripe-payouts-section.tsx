"use client";

import { Landmark, Scale, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatCents } from "~/components/contractor-admin";
import { Alert, Button, Card, EmptyState, StatusBadge } from "~/components/ui";
import type { PayoutRecord } from "~/data/payouts";
import {
  listStripePayouts,
  previewWeeklyPayouts,
  type StripePayout,
  type WeeklyPayoutPreview,
} from "~/data/stripe-payouts";

/**
 * Owner Stripe payouts (automated-payouts Slice 3) — READ-ONLY. Shows the
 * immutable Stripe payout ledger (instant cash-outs + weekly payouts) plus a
 * read-only weekly-payout preview. There is deliberately NO run/move-money
 * button in this slice — the preview only classifies who would receive a
 * weekly transfer and never calls Stripe (previewWeeklyPayoutsCore is a pure
 * read; the money-move gate stays inert by default).
 *
 * Amounts are SERVER-AUTHORITATIVE: the records passed in come from the already
 * computed pay-period manifest (`PayoutRecord[]`); this component re-derives
 * nothing — it only maps contractorId + totalCents into the preview's input
 * shape.
 */
const KIND_LABEL: Record<StripePayout["kind"], string> = {
  instant_cashout: "Instant cash-out",
  weekly_payout: "Weekly payout",
};
const STATUS_BADGE: Record<StripePayout["status"], { cls: string; label: string }> = {
  pending: { cls: "bg-info-100 text-info-700", label: "Pending" },
  succeeded: { cls: "bg-success-100 text-success-700", label: "Succeeded" },
  failed: { cls: "bg-danger-100 text-danger-700", label: "Failed" },
};
const money = (cents: number) => formatCents(cents);
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export function StripePayoutsSection({ records }: { records: PayoutRecord[] }) {
  const [ledger, setLedger] = useState<StripePayout[] | null>(null);
  const [ledgerError, setLedgerError] = useState(false);
  const [preview, setPreview] = useState<WeeklyPayoutPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of records) if (!m.has(r.contractorId)) m.set(r.contractorId, r.contractorName);
    return m;
  }, [records]);

  const recordInputs = useMemo(
    () =>
      records
        .filter((r) => !r.noActivityThisPeriod)
        .map((r) => ({ contractorId: r.contractorId, amountCents: r.totalCents })),
    [records],
  );

  const loadLedger = useCallback(async () => {
    setLedgerError(false);
    const r = await listStripePayouts();
    if (r.ok) setLedger(r.data);
    else setLedgerError(true);
  }, []);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  const runPreview = async () => {
    if (previewing) return;
    setPreviewing(true);
    setPreviewError("");
    setPreview(null);
    const r = await previewWeeklyPayouts({ data: { records: recordInputs } });
    setPreviewing(false);
    if (r.ok) setPreview(r.data);
    else setPreviewError(r.message);
  };

  const name = (contractorId: string) => nameById.get(contractorId) ?? contractorId;

  const previewCount =
    preview == null
      ? 0
      : preview.linked.length + preview.notLinked.length + preview.notReady.length + preview.skippedZeroAmount.length;

  return (
    <section aria-label="Stripe payouts" className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-ink-800">Stripe payouts</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Automated payouts through Stripe Connect — instant tip cash-outs and weekly payroll. Read-only: nothing moves money unless the owner enables automated payouts.
          </p>
        </div>
      </div>

      {/* ------------------------- weekly-payout preview ------------------------- */}
      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Wallet className="size-5" /></span>
            <div>
              <p className="text-sm font-bold text-ink-900">Weekly payout preview</p>
              <p className="text-xs text-ink-400">
                See which contractors would receive a weekly transfer for the selected period — no money moves.
              </p>
            </div>
          </div>
          <Button variant="secondary" size="sm" loading={previewing} disabled={previewing} onClick={() => void runPreview()}>
            <Scale className="size-3.5" /> {preview == null ? "Run preview" : "Refresh preview"}
          </Button>
        </div>

        {previewError && (
          <Alert variant="danger">
            <span>{previewError}</span>
          </Alert>
        )}

        {preview && (
          <div className="mt-3 space-y-3 border-t border-ink-100 pt-3">
            <p className="text-xs text-ink-500">
              {previewCount} contractor{previewCount === 1 ? "" : "s"} · {money(preview.linked.reduce((s, i) => s + i.amountCents, 0))} ready to transfer
              {" · "}{money(preview.notLinked.reduce((s, i) => s + i.amountCents, 0) + preview.notReady.reduce((s, i) => s + i.amountCents, 0))} needs bank setup
            </p>

            {preview.linked.length > 0 && (
              <div className="rounded-xl border border-success-100 bg-success-50/40 p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-success-700">Ready ({preview.linked.length})</p>
                <div className="mt-1.5 divide-y divide-success-100/70">
                  {preview.linked.map((i) => (
                    <div key={i.contractorId} className="flex items-center justify-between py-1.5 text-sm">
                      <span className="font-semibold text-ink-700">{name(i.contractorId)}</span>
                      <span className="tabular-nums font-bold text-ink-900">{money(i.amountCents)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {preview.notLinked.length > 0 && (
              <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-ink-500">No bank linked ({preview.notLinked.length})</p>
                <div className="mt-1.5 divide-y divide-ink-100">
                  {preview.notLinked.map((i) => (
                    <div key={i.contractorId} className="flex items-center justify-between py-1.5 text-sm">
                      <span className="font-semibold text-ink-600">{name(i.contractorId)}</span>
                      <span className="tabular-nums font-bold text-ink-500">{money(i.amountCents)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {preview.notReady.length > 0 && (
              <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-ink-500">Onboarding incomplete ({preview.notReady.length})</p>
                <div className="mt-1.5 divide-y divide-ink-100">
                  {preview.notReady.map((i) => (
                    <div key={i.contractorId} className="flex items-center justify-between py-1.5 text-sm">
                      <span className="font-semibold text-ink-600">{name(i.contractorId)}</span>
                      <span className="tabular-nums font-bold text-ink-500">{money(i.amountCents)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {preview.skippedZeroAmount.length > 0 && (
              <p className="text-xs text-ink-400">{preview.skippedZeroAmount.length} contractor{preview.skippedZeroAmount.length === 1 ? "" : "s"} with $0.00 payable (skipped).</p>
            )}
            {previewCount === 0 && <p className="text-xs text-ink-400">No contractors in the selected period.</p>}
          </div>
        )}
      </Card>

      {/* ------------------------------ ledger ------------------------------ */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2.5 border-b border-ink-100 bg-ink-50/50 px-4 py-3">
          <span className="grid size-8 place-items-center rounded-lg bg-ink-100 text-ink-600"><Landmark className="size-4" /></span>
          <span className="text-sm font-bold text-ink-700">Payout ledger</span>
          <span className="ml-auto rounded-full bg-ink-100 px-2 py-0.5 text-xs font-bold tabular-nums text-ink-600">{ledger?.length ?? 0}</span>
        </div>
        {ledgerError ? (
          <div className="p-4">
            <Alert variant="danger">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>Payout ledger could not be loaded. Try again.</span>
                <Button size="sm" variant="secondary" onClick={() => void loadLedger()}>Try again</Button>
              </div>
            </Alert>
          </div>
        ) : ledger === null ? (
          <div className="h-24 animate-pulse bg-ink-100/70" aria-busy="true" />
        ) : ledger.length === 0 ? (
          <EmptyState icon={Landmark} title="No payouts yet" body="Instant cash-outs and weekly payouts will appear here once automated payouts are enabled and money moves." />
        ) : (
          <div className="divide-y divide-ink-100">
            {ledger.map((p) => {
              const badge = STATUS_BADGE[p.status] ?? STATUS_BADGE.pending;
              return (
                <div key={p.id} className="space-y-1 px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="rounded-lg bg-ink-100 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-ink-600">{KIND_LABEL[p.kind] ?? p.kind}</span>
                    <p className="min-w-0 text-sm font-semibold text-ink-800">{name(p.contractorId)}</p>
                    <StatusBadge className={badge.cls} dot>{badge.label}</StatusBadge>
                    <p className="ml-auto text-[15px] font-extrabold tabular-nums text-ink-900">{money(p.amountCents)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px] tabular-nums text-ink-500">
                    <span>{fmtDate(p.createdAt)}</span>
                    {p.stripeTransferId ? <span className="break-all">Stripe {p.stripeTransferId}</span> : null}
                    {p.status === "failed" && p.failureMessage ? (
                      <span className="text-danger-600">{p.failureMessage}</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <p className="flex items-start gap-1.5 pb-4 text-[11px] leading-relaxed text-ink-400">
        <Scale className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        Automated payouts stay off until the owner enables them — nothing above can move money, and no run button is wired in this view.
      </p>
    </section>
  );
}
