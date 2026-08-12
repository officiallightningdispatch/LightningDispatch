/**
 * Tip cash-out UI (owner-directed 2026-08-12) — the ONE-TAP surface shared by
 * the Earnings card ("Cash out tips now") and the post-completion flow in
 * driver-photos-ui. Every state is handled here so the two surfaces can never
 * drift:
 *
 *  - open request (server double-submit backstop) → "Request sent — the owner
 *    pays it from the Payments tab" — no second submit possible.
 *  - no payout rail → prompt to set one up, routes to /driver/payout.
 *  - rail present but unverified → clear message + link (cash-out requires a
 *    VERIFIED rail — enforced server-side, mirrored here).
 *  - verified rail + tips available → one-tap "Cash out $X now".
 *
 * The amount is ALWAYS server-computed (getMyTipCashoutState); the client can
 * never pick a number. Seroval-safe: the facade returns null-or-value fields,
 * never undefined. Bank numbers never appear here — the state carries only the
 * masked handle.
 */
import { Link } from "@tanstack/react-router";
import { Banknote, CheckCircle2, Clock, ShieldCheck, Wallet } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Card } from "~/components/ui";
import {
  getMyTipCashoutState,
  submitTipCashout,
  type DriverTipCashoutState,
} from "~/data/tip-cashout";

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** One-tap tip cash-out panel. compact = tighter padding for the completion
 *  flow; onSubmitted fires after a successful request so the host can toast;
 *  refreshKey re-runs the state load when it changes (e.g. a tip was just
 *  charged in the completion flow). */
export function TipCashoutPanel({
  compact = false,
  onSubmitted,
  refreshKey,
}: {
  compact?: boolean;
  onSubmitted?: () => void;
  refreshKey?: unknown;
}) {
  const [state, setState] = useState<DriverTipCashoutState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const r = await getMyTipCashoutState();
    if (r.ok) setState(r.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!state) return null;

  const hasTips = state.availableCents > 0;
  const pending = state.openRequest != null;
  const railMissing = state.method == null;
  const railUnverified = state.method != null && !state.methodVerified;
  const shownBefore = state.paidOutTotalCents > 0 || state.paidOutCount > 0;

  // Nothing actionable and nothing to explain → stay out of the way.
  if (!hasTips && !pending && !shownBefore) return null;

  const submit = async () => {
    setBusy(true);
    setError("");
    const r = await submitTipCashout();
    setBusy(false);
    if (r.ok) {
      await load();
      onSubmitted?.();
    } else {
      setError(r.message);
    }
  };

  let body: ReactNode;
  if (pending) {
    body = (
      <p className="flex items-center gap-1.5 rounded-xl bg-info-50 px-3 py-2.5 text-xs font-semibold leading-snug text-info-700">
        <Clock className="size-3.5 shrink-0" />
        Request sent — {money(state.openRequest!.amountCents)}. The owner pays it from the Payments tab — no action needed.
      </p>
    );
  } else if (!hasTips) {
    body = (
      <p className="flex items-center gap-1.5 rounded-xl bg-ink-50 px-3 py-2.5 text-xs font-medium leading-snug text-ink-500">
        <CheckCircle2 className="size-3.5 shrink-0 text-success-600" />
        You&apos;ve cashed out {money(state.paidOutTotalCents)} in tips so far — they&apos;re paid outside weekly payday.
      </p>
    );
  } else if (railMissing) {
    body = (
      <div className="space-y-2">
        <p className="text-xs leading-snug text-ink-600">
          Set up a payout method to cash out your {money(state.availableCents)} — the owner verifies it, then one tap sends your tips.
        </p>
        <Link to="/driver/payout" className="block">
          <Button variant="primary" size="md" className="w-full">
            <Wallet className="size-4" /> Set up payout method
          </Button>
        </Link>
      </div>
    );
  } else if (railUnverified) {
    body = (
      <div className="space-y-2">
        <p className="flex items-start gap-1.5 text-xs leading-snug text-ink-600">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-info-600" />
          Your payout method isn&apos;t verified yet — the owner verifies it before tips can be cashed out.
        </p>
        <Link to="/driver/payout" className="block">
          <Button variant="secondary" size="md" className="w-full">Check payout status</Button>
        </Link>
      </div>
    );
  } else {
    body = (
      <Button variant="primary" size="md" className="w-full" loading={busy} onClick={() => void submit()}>
        <Banknote className="size-4" /> Cash out {money(state.availableCents)} now
      </Button>
    );
  }

  return (
    <Card className={`border-brand-200 ${compact ? "p-3.5" : "p-4"}`}>
      <div className="flex items-center gap-2.5">
        <span className={`grid ${compact ? "size-9" : "size-10"} shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600`}>
          <Banknote className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink-800">Cash out tips now</p>
          <p className="text-xs text-ink-500">
            {hasTips ? (
              <>
                <span className="font-bold tabular-nums text-brand-700">{money(state.availableCents)}</span>
                {state.availableTipCount > 0
                  ? ` available from ${state.availableTipCount} tip${state.availableTipCount === 1 ? "" : "s"}`
                  : " available"}
              </>
            ) : pending ? (
              "One request at a time"
            ) : (
              "Instant tip cash-outs"
            )}
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2.5 rounded-lg bg-danger-50 px-3 py-2 text-xs font-medium leading-snug text-danger-600">
          {error}
        </p>
      )}
      <div className="mt-3">{body}</div>
    </Card>
  );
}
