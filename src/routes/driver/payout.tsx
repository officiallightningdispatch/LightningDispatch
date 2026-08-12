/**
 * /driver/payout — feature batch 8 (owner-directed 2026-08-12): the driver
 * picks their payout rail (Cash App / Venmo / Zelle / bank account) and
 * enters their handle/account. Verification is owner-confirmed to happen
 * OUTSIDE the app (the owner sends from their own app and marks paid —
 * nothing can prove a cashtag; Plaid cannot verify handles), so this screen
 * only captures and stores the choice with a "pending owner verification"
 * state. White-label: Lightning Dispatch copy only, no Towbook mention.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { Banknote, ChevronLeft, Landmark, Mail, Plus, Smartphone, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { DriverToolbar } from "~/components/driver-queue";
import { Button, Card } from "~/components/ui";
import { getMyPayoutMethod, removeMyPayoutMethod, setMyPayoutMethod, PAYOUT_RAIL_LABELS, type MyPayoutMethod, type PayoutRail } from "~/data/payouts";

export const Route = createFileRoute("/driver/payout")({ component: PayoutView });

const RAIL_OPTIONS: { rail: PayoutRail; label: string; hint: string; icon: typeof Smartphone; placeholder: string }[] = [
  { rail: "cash_app", label: "Cash App", hint: "Your $cashtag", icon: Smartphone, placeholder: "$yourcashtag" },
  { rail: "venmo", label: "Venmo", hint: "@handle or phone number", icon: Smartphone, placeholder: "@yourhandle" },
  { rail: "zelle", label: "Zelle", hint: "Email or phone number", icon: Mail, placeholder: "you@example.com" },
  { rail: "bank", label: "Bank account", hint: "Institution + last 4 digits", icon: Landmark, placeholder: "e.g. Chase, 4321" },
];

function PayoutView() {
  const [method, setMethod] = useState<MyPayoutMethod | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rail, setRail] = useState<PayoutRail>("cash_app");
  const [handle, setHandle] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankLast4, setBankLast4] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    const res = await getMyPayoutMethod();
    if (res.ok) setMethod(res.data);
    setLoaded(true);
  };
  useEffect(() => { void load(); }, []);

  const startEdit = () => {
    setRail(method?.rail ?? "cash_app");
    setBankName(method?.bankInstitutionName ?? "");
    setBankLast4(method?.bankLast4 ?? "");
    setHandle("");
    setEditing(true);
    setMessage(null);
  };
  const save = async () => {
    setSaving(true);
    setMessage(null);
    const res = await setMyPayoutMethod({
      data: rail === "bank"
        ? { rail, bankInstitutionName: bankName, bankLast4 }
        : { rail, handle },
    });
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
  };

  const railLabel = method ? PAYOUT_RAIL_LABELS[method.rail] : null;

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
                  {method.status === "verified" ? "✓ Verified by owner"
                    : method.status === "rejected" ? `Rejected — ${method.rejectNote ?? "contact the owner"}`
                    : "Pending owner verification — usually the same day"}
                </p>
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
                  Pick where you want weekly paydays sent. You&apos;ll see your earnings on the Earnings tab —
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
                        <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. Chase" className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500" />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-semibold text-ink-600">Last 4 digits of the account</span>
                        <input value={bankLast4} onChange={(e) => setBankLast4(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="4321" inputMode="numeric" maxLength={4} className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500" />
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
