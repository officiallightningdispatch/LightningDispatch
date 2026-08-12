/**
 * /driver/help — Help & Support (R2 spec §c item 11). Centerpiece: the call
 * dispatch card (owner-provided (475) 219-8328, 2026-08-11 — hardcoded as
 * tel:+14752198328). Below: "Report a problem" → submitDriverIssue (driver_issues
 * table, owner-readable day one); job picker lists the driver's current queue
 * (offers/active) so they can attach a job — optional. Payment note card keeps
 * the honest "tips attributed to you, paid by the owner at payday" framing.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronDown, LifeBuoy, Phone, Wallet } from "lucide-react";
import { useState } from "react";
import { AppShell } from "~/components/app-shell";
import { useDriverQueue } from "~/components/driver-queue";
import { Button, Card } from "~/components/ui";
import { submitDriverIssue } from "~/data/driver-support";

export const Route = createFileRoute("/driver/help")({ component: HelpView });

/** Owner-provided dispatch number (2026-08-11) — single source of truth. */
export const DISPATCH_PHONE_DISPLAY = "(475) 219-8328";
export const DISPATCH_PHONE_TEL = "tel:+14752198328";

const KINDS = [
  { id: "job_issue", label: "Job issue" },
  { id: "payment", label: "Payment" },
  { id: "account", label: "Account" },
] as const;
type KindId = (typeof KINDS)[number]["id"];

function HelpView() {
  const nav = useNavigate();
  const { calls, expired, signOut } = useDriverQueue();
  const [kind, setKind] = useState<KindId>("job_issue");
  const [jobId, setJobId] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const queueJobs = calls ?? [];
  const jobOptions = queueJobs.filter((c) => c.statusId === 1 || c.statusId === 2 || c.statusId === 3 || c.statusId === 4);

  const submit = async () => {
    if (!message.trim()) {
      setError("Add a short description so dispatch knows what happened.");
      return;
    }
    setSending(true);
    setError("");
    try {
      const r = await submitDriverIssue({
        data: { kind, message: message.trim(), jobId: jobId || null },
      });
      if (r.ok) {
        setSent(true);
      } else {
        setError(r.message ?? "Couldn't send your report — try again.");
      }
    } catch {
      setError("Couldn't send your report — check your connection.");
    } finally {
      setSending(false);
    }
  };

  return (
    <AppShell
      portal="driver"
      slim
      title="Help"
      description="Help & support"
      headerActions={
        <button
          type="button"
          onClick={() => void nav({ to: "/driver/profile" })}
          aria-label="Back to profile"
          className="grid size-11 place-items-center rounded-full text-ink-500 transition-colors hover:bg-ink-50"
        >
          <ChevronDown className="size-5 rotate-90" />
        </button>
      }
    >
      <div className="mx-auto max-w-lg px-4 pb-24 pt-5 sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight">Help &amp; Support</h1>
        <p className="mt-1 text-sm text-ink-500">Dispatch is a phone call away — or report a problem and we&apos;ll see it.</p>

        {/* Call dispatch — the centerpiece */}
        <a
          href={DISPATCH_PHONE_TEL}
          className="mt-5 flex w-full items-center gap-4 rounded-2xl bg-brand-50 p-4 ring-1 ring-brand-100 transition-all duration-150 hover:bg-brand-100/70 active:scale-[0.99]"
        >
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-500 text-white">
            <Phone className="size-6" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-brand-700">Call dispatch</span>
            <span className="block text-lg font-black tabular-nums text-brand-800">{DISPATCH_PHONE_DISPLAY}</span>
            <span className="block text-xs text-brand-700/80">24/7 — a dispatcher picks up.</span>
          </span>
        </a>

        {/* Report a problem */}
        <Card className="mt-5 p-4">
          <h2 className="flex items-center gap-2 font-bold text-ink-800">
            <LifeBuoy className="size-4 text-brand-600" /> Report a problem
          </h2>
          {sent ? (
            <div className="mt-3 rounded-xl bg-success-50 p-3 text-sm font-semibold text-success-700">
              Sent — dispatch has it. ✓
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {jobOptions.length > 0 && (
                <label className="block">
                  <span className="text-xs font-semibold text-ink-500">Related job (optional)</span>
                  <select
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value)}
                    className="mt-1 h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm text-ink-900 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40"
                  >
                    <option value="">No specific job</option>
                    {jobOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        Call #{c.callNumber} — {c.serviceName} ({c.pickupAddress || "pickup"})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div role="radiogroup" aria-label="Problem type" className="flex flex-wrap gap-2">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    role="radio"
                    aria-checked={kind === k.id}
                    onClick={() => setKind(k.id)}
                    className={`h-9 rounded-full px-3.5 text-xs font-bold transition-colors ${
                      kind === k.id ? "bg-brand-500 text-white" : "bg-ink-50 text-ink-600 hover:bg-ink-100"
                    }`}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, 300))}
                rows={3}
                placeholder={`Describe the ${KINDS.find((k) => k.id === kind)?.label.toLowerCase() ?? "problem"}…`}
                className="w-full resize-none rounded-xl border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] tabular-nums text-ink-400">{message.length}/300</span>
                <Button size="sm" loading={sending} onClick={() => void submit()}>Send report</Button>
              </div>
              {error && <p role="alert" className="text-xs font-semibold text-danger-600">{error}</p>}
              {expired && (
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Your session expired — reports still reach dispatch, but reconnect to keep getting jobs.{" "}
                  <button type="button" onClick={() => void signOut()} className="font-bold underline">Reconnect</button>
                </p>
              )}
            </div>
          )}
        </Card>

        {/* Note card */}
        <Card className="mt-5 p-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink-100">
              <Wallet className="size-5 text-ink-500" />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink-700">Payment questions?</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                Tips are attributed to you and paid by the owner at payday. Per-job payrate × completed jobs plus tips — the
                owner handles payouts from the Payments tab.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
