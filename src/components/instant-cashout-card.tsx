"use client";

import { Banknote, CheckCircle2, Clock, Loader2, ShieldCheck, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "~/components/ui";
import {
  getInstantCashoutStatus,
  requestInstantCashout,
  type InstantCashoutStatus,
} from "~/data/stripe-payouts";

/**
 * Instant cash-out (automated-payouts Slice 3) — the driver's Stripe Connect
 * instant cash-out surface. The AMOUNT IS ALWAYS SERVER-COMPUTED: the client
 * only reads `getInstantCashoutStatus` (GET, read-only) and taps
 * `requestInstantCashout` (POST, NO amount argument). This component never
 * computes, sends, or edits a number.
 *
 * States (all non-blocking, never surface Stripe internals or raw errors):
 *  - gate off / not configured  → "coming soon" (money never moves until the
 *    owner enables automated payouts);
 *  - no bank linked           → "requires setup" (points at the BankLinkCard);
 *  - linked, onboarding incomplete → "pending" (finish Stripe onboarding);
 *  - linked + ready            → "Cash out $X now";
 *  - no eligible tips          → "nothing to cash out right now";
 *  - last payout failed        → friendly "didn't go through — try again".
 */
export function InstantCashoutCard() {
  const [status, setStatus] = useState<InstantCashoutStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await getInstantCashoutStatus();
    if (r.ok) setStatus(r.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const r = await requestInstantCashout();
    setBusy(false);
    if (r.ok) {
      await load();
    } else if (r.code === "no_funds") {
      setError("No tips available to cash out right now.");
    } else if (r.code === "payouts_not_enabled") {
      setError("Instant cash-out isn't available yet — it will be once the owner enables automated payouts.");
    } else if (r.code === "bank_not_linked") {
      setError("Link your bank first — cash-out needs a connected account.");
    } else if (r.code === "bank_not_ready") {
      setError("Your bank link isn't finished yet — complete onboarding, then try again.");
    } else {
      setError("That didn't go through — try again in a moment.");
    }
  };

  if (!status) {
    return (
      <div className="flex items-center gap-2 py-1 text-sm text-ink-500">
        <Loader2 className="size-4 animate-spin" /> Checking cash-out…
      </div>
    );
  }

  const money = (cents: number) =>
    (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

  // Money-move gate OFF (or Stripe not configured) → coming soon. This is the
  // inert-by-default contract: no button, no call, no raw env detail.
  const gateOff = !status.enabled;
  const notLinked = !status.linked;
  const pendingOnboarding = status.linked && !status.payoutsEnabled;
  const eligible = status.eligibleTotalCents;
  const lastFailed = status.lastPayout?.status === "failed";
  const lastSucceeded = status.lastPayout?.status === "succeeded";
  const lastPending = status.lastPayout?.status === "pending";

  return (
    <Card className="border-brand-200 p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
          <Zap className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink-800">Instant cash-out</p>
          <p className="text-xs text-ink-500">
            {gateOff ? (
              "Automated payouts are coming soon"
            ) : notLinked ? (
              "Link your bank to enable instant cash-out"
            ) : pendingOnboarding ? (
              "Finish your bank setup to cash out"
            ) : eligible > 0 ? (
              <>
                <span className="font-bold tabular-nums text-brand-700">{money(eligible)}</span>
                {" available"}
              </>
            ) : (
              "Nothing to cash out right now"
            )}
          </p>
        </div>
      </div>

      <div className="mt-3">
        {gateOff ? (
          <p className="flex items-start gap-1.5 rounded-xl bg-ink-50 px-3 py-2.5 text-xs font-medium leading-snug text-ink-500">
            <Clock className="mt-0.5 size-3.5 shrink-0" />
            Instant cash-out is being set up — it&apos;ll be available once the owner enables automated payouts.
          </p>
        ) : notLinked ? (
          <p className="flex items-start gap-1.5 rounded-xl bg-ink-50 px-3 py-2.5 text-xs font-medium leading-snug text-ink-500">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-info-600" />
            Link your bank above, then cash out your tips instantly.
          </p>
        ) : pendingOnboarding ? (
          <p className="flex items-start gap-1.5 rounded-xl bg-info-50 px-3 py-2.5 text-xs font-semibold leading-snug text-info-700">
            <Clock className="mt-0.5 size-3.5 shrink-0" />
            Your bank link is in progress — finish onboarding to enable instant cash-out.
          </p>
        ) : lastFailed ? (
          <p className="flex items-start gap-1.5 rounded-xl bg-danger-50 px-3 py-2.5 text-xs font-medium leading-snug text-danger-600">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            Your last cash-out didn&apos;t go through — you can try again.
          </p>
        ) : lastSucceeded ? (
          <p className="flex items-center gap-1.5 rounded-xl bg-success-50 px-3 py-2.5 text-xs font-semibold leading-snug text-success-700">
            <CheckCircle2 className="size-3.5 shrink-0" />
            Cash-out complete — {money(status.lastPayout!.amountCents)} sent to your bank.
          </p>
        ) : lastPending ? (
          <p className="flex items-start gap-1.5 rounded-xl bg-info-50 px-3 py-2.5 text-xs font-semibold leading-snug text-info-700">
            <Clock className="mt-0.5 size-3.5 shrink-0" />
            Your cash-out is processing — it&apos;ll be here shortly.
          </p>
        ) : (
          <Button
            variant="primary"
            size="md"
            className="w-full"
            loading={busy}
            disabled={eligible <= 0}
            onClick={() => void submit()}
          >
            <Banknote className="size-4" /> Cash out {money(eligible)} now
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2.5 rounded-lg bg-danger-50 px-3 py-2 text-xs font-medium leading-snug text-danger-600">
          {error}
        </p>
      )}
    </Card>
  );
}
