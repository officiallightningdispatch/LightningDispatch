/**
 * /driver/payout — feature batch 8 (owner-directed 2026-08-12): the driver
 * picks their payout rail (Cash App / Venmo / Zelle / bank account) and
 * enters their handle/account. Verification is owner-confirmed to happen
 * OUTSIDE the app (the owner sends from their own app and marks paid —
 * nothing can prove a cashtag; Plaid cannot verify handles), so this screen
 * only captures and stores the choice with a "pending owner verification"
 * state. White-label: Lightning Dispatch copy only, no Towbook mention.
 *
 * BANK RAIL (owner-directed 2026-08-12, Plaid DROPPED): routing + account
 * number entry with client-side shape checks; the numbers are encrypted
 * server-side under a dedicated key and NEVER stored/logged in plaintext or
 * kept in localStorage. Verification = micro-deposit: the owner records a
 * small test deposit from their own bank app, then the driver confirms the
 * exact amount here — the amount never crosses to this client (only a
 * bankDepositSent flag does). Verified bank shows "✓ Bank verified".
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { Banknote, ChevronLeft, Clock, Landmark, Lock, Mail, Plus, Smartphone, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { DriverToolbar } from "~/components/driver-queue";
import { Button, Card } from "~/components/ui";
import {
  confirmBankDeposit,
  getMyPayoutMethod,
  removeMyPayoutMethod,
  setMyPayoutMethod,
  PAYOUT_RAIL_LABELS,
  type MyPayoutMethod,
  type PayoutRail,
} from "~/data/payouts";

export const Route = createFileRoute("/driver/payout")({ component: PayoutView });

const RAIL_OPTIONS: { rail: PayoutRail; label: string; hint: string; icon: typeof Smartphone; placeholder: string }[] = [
  { rail: "cash_app", label: "Cash App", hint: "Your $cashtag", icon: Smartphone, placeholder: "$yourcashtag" },
  { rail: "venmo", label: "Venmo", hint: "@handle or phone number", icon: Smartphone, placeholder: "@yourhandle" },
  { rail: "zelle", label: "Zelle", hint: "Email or phone number", icon: Mail, placeholder: "you@example.com" },
  { rail: "bank", label: "Bank account", hint: "Institution + routing + account", icon: Landmark, placeholder: "e.g. Chase" },
];

function PayoutView() {
  const [method, setMethod] = useState<MyPayoutMethod | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rail, setRail] = useState<PayoutRail>("cash_app");
  const [handle, setHandle] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankRouting, setBankRouting] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Micro-deposit confirmation (bank rail): the amount the driver received.
  const [depositInput, setDepositInput] = useState("");
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositError, setDepositError] = useState("");

  const load = async () => {
    const res = await getMyPayoutMethod();
    if (res.ok) setMethod(res.data);
    setLoaded(true);
  };
  useEffect(() => { void load(); }, []);

  const startEdit = () => {
    setRail(method?.rail ?? "cash_app");
    setBankName(method?.bankInstitutionName ?? "");
    setBankRouting("");
    setBankAccount("");
    setHandle("");
    setEditing(true);
    setMessage(null);
    setDepositError("");
  };
  const save = async () => {
    setSaving(true);
    setMessage(null);
    if (rail === "bank") {
      const routing = bankRouting.replace(/\D/g, "");
      const account = bankAccount.replace(/\D/g, "");
      if (!bankName.trim()) { setSaving(false); setMessage({ kind: "err", text: "Enter the bank name." }); return; }
      if (!/^\d{9}$/.test(routing)) { setSaving(false); setMessage({ kind: "err", text: "Routing numbers are 9 digits — check the number on your checks or bank statement." }); return; }
      if (!/^\d{4,17}$/.test(account)) { setSaving(false); setMessage({ kind: "err", text: "Enter the full account number (4–17 digits). It's stored encrypted — only the owner can see it." }); return; }
      const res = await setMyPayoutMethod({
        data: { rail, bankInstitutionName: bankName.trim(), bankLast4: account.slice(-4), bankRoutingNumber: routing, bankAccountNumber: account },
      });
      setSaving(false);
      if (!res.ok) { setMessage({ kind: "err", text: res.message }); return; }
      setMethod(res.data);
      setEditing(false);
      setMessage({ kind: "ok", text: "Bank details saved. The owner verifies payouts outside the app — bank accounts are verified with a small test deposit." });
      return;
    }
    const res = await setMyPayoutMethod({ data: { rail, handle } });
    setSaving(false);
    if (!res.ok) { setMessage({ kind: "err", text: res.message }); return; }
    setMethod(res.data);
    setEditing(false);
    setMessage({ kind: "ok", text: "Saved. The owner verifies payouts outside the app before the first payday." });
  };
  const remove = async () => {
    await removeMyPayoutMethod({ data: {} });
    setMethod(null);
    setEditing(false);
    setMessage(null);
    setDepositError("");
  };

  /** Confirm the micro-deposit amount the owner recorded (bank rail). The
   *  amount is compared server-side — it never crossed to this client. */
  const confirmDeposit = async () => {
    const amountCents = Number(depositInput.replace(/\D/g, ""));
    if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 10000) {
      setDepositError("Enter the deposit amount in cents — e.g. 12 for $0.12.");
      return;
    }
    setDepositBusy(true);
    setDepositError("");
    const res = await confirmBankDeposit({ data: { amountCents } });
    setDepositBusy(false);
    if (!res.ok) {
      setDepositError(res.message || "That didn't match — check the amount in your bank account and try again.");
    } else if (res.data) {
      setMethod(res.data);
      setDepositInput("");
      setMessage({ kind: "ok", text: "Bank verified ✓ — tips and payday can now go to this account." });
    }
  };

  const railLabel = method ? PAYOUT_RAIL_LABELS[method.rail] : null;
  const isBank = method?.rail === "bank";

  return (
    <AppShell portal="driver" title="Payout method" description="How you get paid — Cash App, Venmo, Zelle or bank.">
      <DriverToolbar loading={false} onRefresh={() => void load()} onSignOut={undefined} />
      <div className="space-y-4">
        {!loaded ? (
          <div className="h-40 animate-pulse rounded-2xl bg-ink-100/70" aria-busy="true" />
        ) : (
          <>
            {message && (
              <p className={`rounded-xl px-3 py-2 text-xs font-semibold ${message.kind === "ok" ? "bg-success-50 text-success-700" : "bg-danger-50 text-danger-600"}`} role="status">
                {message.text}
              </p>
            )}

            {!editing && method && (
              <Card className="p-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-600"><Wallet className="size-5" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-ink-800">{railLabel}</p>
                    <p className="font-mono text-sm text-ink-600">{method.handleMasked}</p>
                  </div>
                </div>
                <p className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  method.status === "verified" ? "bg-success-50 text-success-700" : method.status === "rejected" ? "bg-danger-50 text-danger-600" : "bg-info-50 text-info-700"
                }`}>
                  {method.status === "verified"
                    ? isBank ? "✓ Bank verified" : "✓ Verified by owner"
                    : method.status === "rejected" ? `Rejected — ${method.rejectNote ?? "contact the owner"}`
                    : "Pending owner verification — usually the same day"}
                </p>

                {/* Bank rail micro-deposit flow (never shows the amount). */}
                {isBank && method.status === "connected_unverified" && (
                  <div className="mt-3 rounded-xl border border-info-100 bg-info-50/60 p-3">
                    {method.bankDepositSent ? (
                      <>
                        <p className="flex items-start gap-1.5 text-xs font-semibold leading-snug text-ink-700">
                          <Banknote className="mt-0.5 size-3.5 shrink-0 text-info-600" />
                          The owner sent a test deposit — enter the exact amount in cents to verify this bank account.
                        </p>
                        <div className="mt-2 flex gap-2">
                          <input
                            value={depositInput}
                            onChange={(e) => { setDepositInput(e.target.value.replace(/\D/g, "").slice(0, 5)); setDepositError(""); }}
                            placeholder="e.g. 12 = $0.12"
                            inputMode="numeric"
                            aria-label="Test deposit amount in cents"
                            className="h-11 w-full min-w-0 flex-1 rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500"
                          />
                          <Button size="md" loading={depositBusy} onClick={() => void confirmDeposit()}>Verify bank</Button>
                        </div>
                        {depositError && <p role="alert" className="mt-1.5 text-xs font-medium leading-snug text-danger-600">{depositError}</p>}
                      </>
                    ) : (
                      <p className="flex items-start gap-1.5 text-xs font-semibold leading-snug text-info-700">
                        <Clock className="mt-0.5 size-3.5 shrink-0" />
                        Waiting for the owner&apos;s test deposit — once they send it, confirm the amount here to verify this bank account.
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-4 flex gap-2">
                  <Button variant="primary" size="sm" className="flex-1" onClick={startEdit}>Change method</Button>
                  <Button variant="ghost" size="sm" className="flex-1" onClick={() => void remove()}>Remove</Button>
                </div>
              </Card>
            )}

            {!editing && !method && (
              <Card className="p-6 text-center">
                <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-brand-50 text-brand-600"><Banknote className="size-7" /></span>
                <h2 className="mt-3 text-base font-bold text-ink-800">Add a payout method</h2>
                <p className="mt-1 text-sm leading-relaxed text-ink-500">
                  Pick where you want weekly paydays and tip cash-outs sent. You&apos;ll see your earnings on the Earnings tab —
                  the owner verifies your payout details before your first payment.
                </p>
                <Button variant="primary" size="sm" className="mt-4 w-full" onClick={startEdit}><Plus className="size-4" /> Add payout method</Button>
              </Card>
            )}

            {editing && (
              <Card className="p-4">
                <div className="space-y-2">
                  {RAIL_OPTIONS.map((o) => (
                    <button
                      key={o.rail}
                      type="button"
                      onClick={() => setRail(o.rail)}
                      className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-colors ${
                        rail === o.rail ? "border-brand-500 bg-brand-50/60" : "border-ink-200 bg-surface hover:bg-hover"
                      }`}
                    >
                      <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${rail === o.rail ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-500"}`}>
                        <o.icon className="size-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold text-ink-800">{o.label}</span>
                        <span className="block text-xs text-ink-500">{o.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="mt-4 space-y-3">
                  {rail === "bank" ? (
                    <>
                      <label className="block">
                        <span className="mb-1 block text-xs font-semibold text-ink-600">Bank name</span>
                        <input
                          value={bankName}
                          onChange={(e) => setBankName(e.target.value)}
                          placeholder="e.g. Chase"
                          autoComplete="organization"
                          className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-semibold text-ink-600">Routing number</span>
                        <input
                          value={bankRouting}
                          onChange={(e) => setBankRouting(e.target.value.replace(/\D/g, "").slice(0, 9))}
                          placeholder="9 digits — on your checks or bank statement"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={9}
                          className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-semibold text-ink-600">Account number</span>
                        <input
                          value={bankAccount}
                          onChange={(e) => setBankAccount(e.target.value.replace(/\D/g, "").slice(0, 17))}
                          placeholder="Full account number"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={17}
                          className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500"
                        />
                        <span className="mt-1.5 flex items-start gap-1 text-[11px] leading-relaxed text-ink-400">
                          <Lock className="mt-0.5 size-3 shrink-0" />
                          {bankAccount.replace(/\D/g, "").length >= 4
                            ? `Account •••• ${bankAccount.replace(/\D/g, "").slice(-4)} — stored encrypted, only the owner can see it.`
                            : "Stored encrypted (AES-256) — only the owner can ever see the full number."}
                        </span>
                      </label>
                    </>
                  ) : (
                    <label className="block">
                      <span className="mb-1 block text-xs font-semibold text-ink-600">{RAIL_OPTIONS.find((o) => o.rail === rail)?.hint}</span>
                      <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder={RAIL_OPTIONS.find((o) => o.rail === rail)?.placeholder} className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500" />
                      <span className="mt-1.5 block text-[11px] leading-relaxed text-ink-400">
                        {method ? "Your saved handle stays until you type a new one. " : ""}
                        The platform can&apos;t verify $cashtags or @handles automatically — the owner confirms yours by sending a small test payment from their own app.
                      </span>
                    </label>
                  )}
                </div>
                <div className="mt-4 flex gap-2">
                  <Button variant="primary" size="sm" className="flex-1" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save payout method"}</Button>
                  <Button variant="ghost" size="sm" className="flex-1" disabled={saving} onClick={() => { setEditing(false); setMessage(null); }}>Cancel</Button>
                </div>
              </Card>
            )}

            <Card className="p-4">
              <p className="text-sm font-bold text-ink-800">How payday works</p>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-ink-500">
                <li>• Pay periods run Monday through Sunday.</li>
                <li>• Paydays land Wednesday morning after the period closes.</li>
                <li>• You earn your per-job rate for every completed job, plus any tips.</li>
                <li>• The owner sends your pay from their own account to the verified handle you set here.</li>
                <li>• Bank accounts are verified with a small test deposit — the owner sends it, you confirm the amount here.</li>
              </ul>
            </Card>

            <Link to="/driver/earnings" className="inline-flex items-center gap-1 text-xs font-bold text-brand-600">
              <ChevronLeft className="size-3.5" /> Back to Earnings
            </Link>
          </>
        )}
      </div>
    </AppShell>
  );
}
