/**
 * Owner-side payout-method controls (owner-directed 2026-08-13, Phase A of the
 * owner-dashboard edit/verify mandate). The contractor portal promises "Pending
 * owner verification — usually the same day" for Cash App / Venmo / Zelle /
 * bank rails, but the owner dashboard had NO verify/approve/reject/edit control
 * for payout methods (a method could never be approved). This module gives the
 * OWNER roster (and the Money blocked card) the full lifecycle:
 *
 *   Verify (owner-confirmed — with the "send a test payment first" honesty
 *          prompt, per payout-methods-spec §3: no provider API can prove a
 *          cashtag/handle, so the owner's own send is the proof),
 *   Reject (with a reason shown to the contractor),
 *   Edit   (the owner corrects a typo'd handle/account before approving — any
 *          change re-triggers verification, matching the contractor self-edit
 *          semantics; bank numbers are decrypted owner-only and re-encrypted
 *          on save; audit rows `payout_method_verified|rejected|edited` are
 *          written with MASKED handles only — PII never lands in audit text).
 *
 * Client-safe: imports ONLY from ~/data/payouts (the client facade). No money
 * moves — this is data/status only.
 */
import { Banknote, Check, CircleDollarSign, CircleX, Clock, Landmark, Pencil, Send, X } from "lucide-react";
import { useState } from "react";
import {
  editPayoutMethod,
  rejectPayoutMethod,
  verifyPayoutMethod,
  PAYOUT_RAIL_LABELS,
  type OwnerPayoutMethod,
  type PayoutRail,
  type PayoutStatus,
} from "~/data/payouts";
import { Button, useToast } from "~/components/ui";

const RAIL_ICONS: Record<PayoutRail, typeof Banknote> = {
  cash_app: Banknote,
  venmo: CircleDollarSign,
  zelle: Send,
  bank: Landmark,
};
const RAIL_HINTS: Record<PayoutRail, string> = {
  cash_app: "Cashtag — e.g. $joe",
  venmo: "@handle or US phone",
  zelle: "Email or US phone",
  bank: "Institution + routing + account",
};

/** Small status pill: verified (success) / pending (info) / rejected (danger). */
export function OwnerPayoutStatusPill({ status }: { status: PayoutStatus }) {
  if (status === "verified") {
    return (
      <span className="inline-flex min-h-[22px] items-center gap-1.5 rounded-full bg-success-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-success-700">
        <Check className="size-3" aria-hidden="true" /> Verified
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className="inline-flex min-h-[22px] items-center gap-1.5 rounded-full bg-danger-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-danger-700">
        <CircleX className="size-3" aria-hidden="true" /> Rejected
      </span>
    );
  }
  return (
    <span className="inline-flex min-h-[22px] items-center gap-1.5 rounded-full bg-info-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-info-700">
      <Clock className="size-3" aria-hidden="true" /> Awaiting verification
    </span>
  );
}

/** Owner-only display of the method's details. App rails show the FULL handle
 *  (the owner must send the test payment TO it — owner-only surface). Bank
 *  shows the masked institution ••last4; the full routing/account appear only
 *  inside the Edit form (never in a list row). */
export function OwnerPayoutMethodDetails({ method, className }: { method: OwnerPayoutMethod; className?: string }) {
  const details = method.rail === "bank"
    ? [method.bankInstitutionName, method.bankLast4 ? `••${method.bankLast4}` : null].filter(Boolean).join(" · ") || "Bank account"
    : method.handleFull ?? method.handleMasked;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className ?? ""}`}>
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-ink-100 text-ink-500" aria-hidden="true">
        {(() => { const Icon = RAIL_ICONS[method.rail]; return <Icon className="size-3.5" strokeWidth={2} />; })()}
      </span>
      <span className="min-w-0 truncate">
        <span className="font-semibold text-ink-700">{PAYOUT_RAIL_LABELS[method.rail]}</span>{" "}
        <span className="font-mono text-ink-600">{details}</span>
      </span>
    </span>
  );
}

/** Inline owner editor — pre-filled with the current details (FULL handle for
 *  app rails; FULL routing/account for bank — owner-only decrypt surface). Any
 *  change re-triggers verification. */
export function OwnerPayoutMethodEditor({ method, onSave, onCancel, saving, saveLabel }: {
  method: OwnerPayoutMethod;
  onSave: (input: {
    rail: PayoutRail;
    handle: string | null;
    bankInstitutionName: string | null;
    bankLast4: string | null;
    bankRoutingNumber: string | null;
    bankAccountNumber: string | null;
  }) => Promise<void> | void;
  onCancel: () => void;
  saving?: boolean;
  saveLabel?: string;
}) {
  const [rail, setRail] = useState<PayoutRail>(method.rail);
  const [handle, setHandle] = useState(method.handleFull ?? "");
  const [bankName, setBankName] = useState(method.bankInstitutionName ?? "");
  const [bankRouting, setBankRouting] = useState(method.bankRoutingNumberFull ?? "");
  const [bankAccount, setBankAccount] = useState(method.bankAccountNumberFull ?? "");
  const [localError, setLocalError] = useState("");

  const submit = () => {
    setLocalError("");
    if (rail === "bank") {
      const routing = bankRouting.replace(/\D/g, "");
      const account = bankAccount.replace(/\D/g, "");
      if (!bankName.trim()) { setLocalError("Enter the bank name."); return; }
      if (!/^\d{9}$/.test(routing)) { setLocalError("Routing numbers are 9 digits."); return; }
      if (!/^\d{4,17}$/.test(account)) { setLocalError("Enter the full account number (4–17 digits)."); return; }
      void onSave({ rail, handle: null, bankInstitutionName: bankName.trim(), bankLast4: account.slice(-4), bankRoutingNumber: routing, bankAccountNumber: account });
      return;
    }
    if (!handle.trim()) { setLocalError("Enter the handle."); return; }
    void onSave({ rail, handle: handle.trim(), bankInstitutionName: null, bankLast4: null, bankRoutingNumber: null, bankAccountNumber: null });
  };

  return (
    <div className="mt-2.5 rounded-xl border border-brand-200 bg-brand-50/40 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-ink-800">
        <Pencil className="size-3.5" aria-hidden="true" /> Edit payout method
      </p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {(Object.keys(RAIL_ICONS) as PayoutRail[]).map((r) => {
          const Icon = RAIL_ICONS[r];
          const selected = rail === r;
          return (
            <button
              key={r}
              type="button"
              onClick={() => { setRail(r); setLocalError(""); }}
              aria-pressed={selected}
              className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-xs font-bold transition-colors ${
                selected ? "border-brand-500 bg-brand-500 text-white" : "border-ink-200 bg-surface text-ink-600 hover:border-brand-300"
              }`}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" /> {PAYOUT_RAIL_LABELS[r]}
            </button>
          );
        })}
      </div>
      <div className="mt-2.5 space-y-2">
        {rail === "bank" ? (
          <>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-ink-600">Bank name</span>
              <input value={bankName} onChange={(e) => setBankName(e.target.value)} maxLength={40}
                className="h-10 w-full rounded-lg border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-ink-600">Routing number</span>
              <input value={bankRouting} onChange={(e) => setBankRouting(e.target.value.replace(/\D/g, "").slice(0, 9))} inputMode="numeric" maxLength={9}
                className="h-10 w-full rounded-lg border border-ink-200 bg-surface px-3 text-sm font-mono outline-none focus:border-brand-500" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-ink-600">Account number</span>
              <input value={bankAccount} onChange={(e) => setBankAccount(e.target.value.replace(/\D/g, "").slice(0, 17))} inputMode="numeric" maxLength={17}
                className="h-10 w-full rounded-lg border border-ink-200 bg-surface px-3 text-sm font-mono outline-none focus:border-brand-500" />
              <span className="mt-1 block text-[10px] leading-relaxed text-ink-400">
                Shown to you only — stored encrypted (AES-256); the contractor never sees the full numbers.
              </span>
            </label>
          </>
        ) : (
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-600">{RAIL_HINTS[rail]}</span>
            <input value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={120}
              placeholder={RAIL_HINTS[rail]}
              className="h-10 w-full rounded-lg border border-ink-200 bg-surface px-3 text-sm font-mono outline-none focus:border-brand-500" />
          </label>
        )}
        {localError && <p role="alert" className="text-[11px] font-semibold text-danger-600">{localError}</p>}
        <p className="text-[10px] leading-relaxed text-ink-400">
          Saving a change resets the method to &quot;awaiting verification&quot; — you&apos;ll verify again after the change lands. App rails can&apos;t be auto-verified (no provider API proves a cashtag) — send a small test payment from your own app before verifying.
        </p>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button size="sm" loading={saving} disabled={saving} onClick={submit}>{saveLabel ?? "Save changes"}</Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}><X className="size-3.5" aria-hidden="true" /> Cancel</Button>
      </div>
    </div>
  );
}

/** Full owner strip for one contractor's payout method — rail + details +
 *  status + Verify / Reject (with reason) / Edit actions. Used on the owner
 *  Contractors roster so EVERY contractor's method (even with no earnings in
 *  any computed period) is verifiable — the gap the owner hit. */
export function OwnerPayoutMethodStrip({ method, onChanged, compact }: {
  method: OwnerPayoutMethod;
  onChanged: () => void;
  /** compact: no outer card chrome (used inside an existing row). */
  compact?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<"verify" | "reject" | "edit" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmVerify, setConfirmVerify] = useState(false);
  const [error, setError] = useState("");

  const runVerify = async () => {
    setBusy("verify"); setError("");
    const res = await verifyPayoutMethod({ data: { methodId: method.id } });
    setBusy(null); setConfirmVerify(false);
    if (!res.ok) { setError(res.message); return; }
    toast(`${method.contractorName}'s ${PAYOUT_RAIL_LABELS[method.rail]} method verified ✓ — recompute the payday period to move them into a rail group.`);
    onChanged();
  };
  const runReject = async () => {
    setBusy("reject"); setError("");
    const res = await rejectPayoutMethod({ data: { methodId: method.id, note: reason.trim() || "Rejected by owner" } });
    setBusy(null); setRejecting(false); setReason("");
    if (!res.ok) { setError(res.message); return; }
    toast(`Rejected ${method.contractorName}'s payout method — the reason is shown to them.`);
    onChanged();
  };
  const saveEdit = async (input: { rail: PayoutRail; handle: string | null; bankInstitutionName: string | null; bankLast4: string | null; bankRoutingNumber: string | null; bankAccountNumber: string | null }) => {
    setBusy("edit"); setError("");
    const res = await editPayoutMethod({ data: { methodId: method.id, ...input } });
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    setEditing(false);
    toast(`${method.contractorName}'s payout method updated — re-verification required before payday.`);
    onChanged();
  };

  const showActions = true;

  return (
    <div className={compact ? "" : "rounded-xl border border-ink-100 bg-surface p-3"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <OwnerPayoutMethodDetails method={method} className="flex-1" />
        <OwnerPayoutStatusPill status={method.status} />
        {showActions && !editing && (
          <span className="flex flex-wrap items-center gap-1.5">
            {method.status !== "verified" && (
              <>
                {confirmVerify ? (
                  <span className="flex flex-wrap items-center gap-1.5 rounded-lg bg-success-50 px-2 py-1">
                    <span className="max-w-[220px] text-[11px] leading-snug text-success-800">
                      Confirm you sent a test payment to this {PAYOUT_RAIL_LABELS[method.rail].toLowerCase()} from your own app first?
                    </span>
                    <Button size="sm" loading={busy === "verify"} onClick={() => void runVerify()}>Yes — verified</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmVerify(false)}>Cancel</Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => { setConfirmVerify(true); setRejecting(false); }}>Verify</Button>
                )}
              </>
            )}
            {rejecting ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (shown to contractor)"
                  maxLength={300}
                  className="h-9 w-44 rounded-lg border border-ink-200 bg-surface px-2 text-xs outline-none focus:border-danger-400"
                />
                <Button size="sm" variant="danger-ghost" loading={busy === "reject"} onClick={() => void runReject()}>Confirm</Button>
                <Button size="sm" variant="ghost" onClick={() => { setRejecting(false); setReason(""); }}>Cancel</Button>
              </span>
            ) : (
              <Button size="sm" variant="danger-ghost" onClick={() => { setRejecting(true); setConfirmVerify(false); }}>Reject</Button>
            )}
            <Button size="sm" variant="secondary" loading={busy === "edit"} disabled={busy !== null} onClick={() => { setEditing(true); setError(""); }}>
              <Pencil className="size-3.5" aria-hidden="true" /> Edit
            </Button>
          </span>
        )}
      </div>
      {method.status === "rejected" && method.rejectNote && (
        <p className="mt-1.5 text-[11px] font-semibold leading-snug text-danger-600">
          Reason shown to contractor: &quot;{method.rejectNote}&quot;
        </p>
      )}
      {error && <p role="alert" className="mt-1.5 text-[11px] font-semibold text-danger-600">{error}</p>}
      {editing && (
        <OwnerPayoutMethodEditor method={method} onSave={saveEdit} onCancel={() => { setEditing(false); setError(""); }} saving={busy === "edit"} />
      )}
    </div>
  );
}
