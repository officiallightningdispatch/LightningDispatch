"use client";

import { Landmark, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui";
import { getBankLinkStatus, startBankLink } from "~/data/stripe-connect";

/**
 * "Link your bank" (automated-payouts Slice 1) — the single point where a
 * contractor links their bank via Stripe Connect onboarding. Self-contained:
 * a status line (linked / pending / not configured) plus a button that mints an
 * onboarding URL and opens it in the current tab. White-label, Lightning copy.
 */
export function BankLinkCard() {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"loading" | "not_configured" | "pending" | "linked">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    void (async () => {
      const res = await getBankLinkStatus();
      if (stopped) return;
      if (!res.ok) {
        setState(res.code === "stripe_not_configured" ? "not_configured" : "loading");
        if (res.code !== "stripe_not_configured") setError(res.message);
        return;
      }
      if (res.data.onboardingStatus === "complete" || (res.data.chargesEnabled && res.data.payoutsEnabled)) {
        setState("linked");
      } else if (res.data.linked) {
        setState("pending");
      } else {
        setState("not_configured");
      }
    })();
    return () => {
      stopped = true;
    };
  }, []);

  const onLink = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await startBankLink({
      data: { returnUrl: window.location.href, refreshUrl: window.location.href },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    window.location.assign(res.data.url);
  };

  if (state === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-500">
        <Loader2 className="size-4 animate-spin" /> Checking bank link…
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {state === "linked" ? (
        <div className="flex items-center gap-2 text-sm font-semibold text-success-600">
          <Landmark className="size-4" /> Bank linked
        </div>
      ) : state === "pending" ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-info-600">Bank link in progress</span>
          <Button variant="primary" size="sm" loading={busy} onClick={() => void onLink()}>
            Continue
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink-600">Link your bank for payouts</span>
          <Button variant="primary" size="sm" loading={busy} onClick={() => void onLink()}>
            Link bank
          </Button>
        </div>
      )}
      {error ? <p className="text-xs text-danger-600">{error}</p> : null}
    </div>
  );
}
