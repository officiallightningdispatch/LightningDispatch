/**
 * Damage-claims agent UI (Phase 1b, owner-directed 2026-08-12).
 * Owner Claims screen + driver sign screen. White-label: no user-facing
 * "Towbook" anywhere. The server cores (src/data/claims.ts facade →
 * claims-core.ts) own ALL gating: owner/admin for approve/reject/send,
 * assigned driver (or owner on behalf) for sign; the Send path refuses
 * without approval server-side. This file only renders + calls the facade.
 */
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileSignature,
  FileText,
  Inbox,
  Mail,
  PenLine,
  RefreshCw,
  Search,
  Send,
  User as UserIcon,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { SignaturePad } from "~/components/driver-photos-ui";
import { Button, Card, EmptyState, StatusBadge, useToast } from "~/components/ui";
import {
  approveClaim,
  listClaims,
  listMyClaimSignRequests,
  prepareClaimForm,
  rejectClaim,
  researchClaim,
  scanClaims,
  sendClaim,
  signClaim,
} from "~/data/claims";
import type { ClaimRow, ClaimStatus } from "~/data/claims";

/* ------------------------------ status meta ------------------------------ */

export const CLAIM_STATUS_META: Record<ClaimStatus, { label: string; className: string }> = {
  new: { label: "New", className: "bg-ink-100 text-ink-600" },
  researched: { label: "Researched", className: "bg-blue-50 text-blue-700" },
  form_ready: { label: "Form ready", className: "bg-amber-50 text-amber-700" },
  pending_approval: { label: "Pending approval", className: "bg-accent-50 text-accent-700" },
  approved: { label: "Approved", className: "bg-brand-50 text-brand-700" },
  sent: { label: "Sent", className: "bg-success-50 text-success-700" },
  resolved: { label: "Resolved", className: "bg-success-50 text-success-700" },
  closed: { label: "Closed", className: "bg-ink-100 text-ink-500" },
};

export function ClaimStatusBadge({ status }: { status: ClaimStatus }) {
  const meta = CLAIM_STATUS_META[status] ?? CLAIM_STATUS_META.new;
  return <StatusBadge className={meta.className}>{meta.label}</StatusBadge>;
}

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

function claimForm(c: ClaimRow): Record<string, unknown> {
  return (c.form ?? {}) as Record<string, unknown>;
}

/** Statement + facts block shown to the owner and the signing driver. */
export function ClaimStatementCard({ claim, title = "Prepared response" }: { claim: ClaimRow; title?: string }) {
  const form = claimForm(claim);
  const statement = String(form.statement ?? "");
  const rows: Array<[string, string]> = [
    ["Company", claim.company],
    ["Case / claim number", claim.claimNumber ?? "—"],
    ["Reference (PO)", String(form.referenceNumber ?? claim.research?.referenceNumber ?? "—")],
    ["Owner", String(form.ownerName ?? claim.research?.ownerName ?? "—")],
    ["Vehicle", String(form.vehicleInfo ?? claim.research?.vehicleInfo ?? "—")],
    ["Damage reported", String(form.damageDescription ?? claim.research?.damageDescription ?? "—")],
    ["Service performed", String(form.servicePerformed ?? "—")],
  ];
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-ink-100 bg-white p-3.5">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-400">{title}</p>
        <p className="text-[13px] leading-relaxed text-ink-700">
          {statement || "The response hasn't been prepared yet."}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="rounded-xl border border-ink-100 bg-white px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-ink-400">{k}</p>
            <p className="truncate text-[13px] font-medium text-ink-700" title={v}>{v}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Where the signed form will be returned (sendTo / sendMethod). */
export function SendTargetCard({ claim }: { claim: ClaimRow }) {
  const email = claim.sendTo;
  const webForm = claim.sendMethod === "web_form";
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-ink-100 bg-white px-3 py-2.5">
      {webForm ? <FileText className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" /> : <Mail className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" />}
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-wide text-ink-400">Return to {claim.company}</p>
        {webForm ? (
          <p className="text-[13px] font-medium text-ink-700">{claim.company} requires its own web form — the per-company adapter is phase 2. Nothing can be emailed.</p>
        ) : (
          <p className="truncate text-[13px] font-medium text-ink-700">{email ?? "No return address on file yet"}</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ owner screen ------------------------------ */

export function OwnerClaimsView() {
  const toast = useToast();
  const [claims, setClaims] = useState<ClaimRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // action key for spinner
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [ownerSig, setOwnerSig] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const load = () => {
    void listClaims().then((r) => {
      if (r.ok) {
        setClaims(r.data);
        setError(null);
      } else {
        setError(r.message ?? "Couldn't load claims.");
      }
    }).catch(() => setError("Couldn't load claims — check your connection."));
  };

  useEffect(load, [reloadTick]);

  const scan = () => {
    setScanning(true);
    setError(null);
    void scanClaims({ data: {} }).then((r) => {
      if (r.ok) {
        toast(`Inbox scanned — ${r.data.created} new claim${r.data.created === 1 ? "" : "s"} found.`);
        setClaims(r.data.claims.length ? [...r.data.claims, ...(claims ?? []).filter((c) => !r.data.claims.some((n) => n.id === c.id))] : claims ?? []);
        setReloadTick((n) => n + 1);
      } else {
        setError(r.message ?? "Inbox scan failed.");
      }
    }).catch(() => setError("Inbox scan failed — check the mail connection.")).finally(() => setScanning(false));
  };

  const run = (key: string, p: Promise<{ ok: boolean; message?: string }>, okMsg: string) => {
    setBusy(key);
    setError(null);
    void p.then((r) => {
      if (r.ok) {
        toast(okMsg);
        setReloadTick((n) => n + 1);
      } else {
        setError(r.message ?? "Action failed.");
      }
    }).catch(() => setError("Action failed — try again.")).finally(() => setBusy(null));
  };

  const selected = claims?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {error && (
        <p role="alert" className="rounded-xl border border-danger-200 bg-danger-50 px-3.5 py-2.5 text-[13px] font-semibold text-danger-700">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-extrabold tracking-tight text-ink-900">Damage claims</h2>
          <p className="text-xs text-ink-500">Auto-detected from the owner's inbox. Nothing is sent without your approval.</p>
        </div>
        <Button onClick={() => void scan()} loading={scanning} size="sm">
          <RefreshCw className="size-4" aria-hidden="true" /> Scan inbox
        </Button>
      </div>

      {claims === null ? (
        <div className="space-y-2">
          <div className="h-20 animate-pulse rounded-2xl bg-ink-100/70" />
          <div className="h-20 animate-pulse rounded-2xl bg-ink-100/70" />
        </div>
      ) : claims.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No damage claims yet"
          body="Tap “Scan inbox” to check the owner's email for damage notifications from Agero, Sixt, and other companies."
        />
      ) : (
        <ul className="space-y-2.5">
          {claims.map((c) => (
            <li key={c.id}>
              <Card interactive className="overflow-hidden">
                <button
                  type="button"
                  onClick={() => setSelectedId(selectedId === c.id ? null : c.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                    <FileSignature className="size-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-ink-900">
                      {c.company || "Unknown company"} <span className="font-medium text-ink-400">· {c.claimNumber ?? "no case #"}</span>
                    </p>
                    <p className="truncate text-xs text-ink-500">
                      {c.driverName ? `Driver: ${c.driverName}` : "No driver assigned yet"} · {fmtDate(c.createdAt)}
                    </p>
                  </div>
                  <ClaimStatusBadge status={c.status} />
                </button>
                {selectedId === c.id && selected && <ClaimDetail claim={selected} busy={busy} run={run} onChanged={() => setReloadTick((n) => n + 1)} rejectReason={rejectReason} setRejectReason={setRejectReason} ownerSig={ownerSig} setOwnerSig={setOwnerSig} />}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ClaimDetail({
  claim,
  busy,
  run,
  onChanged,
  rejectReason,
  setRejectReason,
  ownerSig,
  setOwnerSig,
}: {
  claim: ClaimRow;
  busy: string | null;
  run: (key: string, p: Promise<{ ok: boolean; message?: string }>, okMsg: string) => void;
  onChanged: () => void;
  rejectReason: string;
  setRejectReason: (s: string) => void;
  ownerSig: string | null;
  setOwnerSig: (s: string | null) => void;
}) {
  const toast = useToast();
  const [signing, setSigning] = useState(false);
  const webFormOnly = claim.sendMethod === "web_form";

  const signOnBehalf = () => {
    if (!ownerSig) return;
    setSigning(true);
    void signClaim({ data: { claimId: claim.id, signatureDataUrl: ownerSig } }).then((r) => {
      if (r.ok) {
        toast("Signed on behalf — pending the owner's approval.");
        setOwnerSig(null);
        onChanged();
      } else {
        toast(r.message ?? "Couldn't sign the form.");
      }
    }).catch(() => toast("Couldn't sign the form — try again.")).finally(() => setSigning(false));
  };

  return (
    <div className="space-y-3 border-t border-ink-100 bg-ink-50/50 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-ink-500">
        <span className="inline-flex items-center gap-1"><Mail className="size-3" aria-hidden="true" /> {claim.emailFrom || "unknown sender"}</span>
        <span className="inline-flex items-center gap-1"><UserIcon className="size-3" aria-hidden="true" /> {claim.driverName ?? "No driver assigned"}</span>
        {claim.jobId && <span className="inline-flex items-center gap-1"><FileText className="size-3" aria-hidden="true" /> Linked job</span>}
      </div>

      <ClaimStatementCard claim={claim} />

      {claim.status === "form_ready" || claim.status === "researched" || claim.status === "new" ? <SendTargetCard claim={claim} /> : null}

      {claim.status === "new" && (
        <div className="flex gap-2">
          <Button size="sm" loading={busy === "research"} onClick={() => run("research", researchClaim({ data: claim.id }), "Researched — job + driver linked where found.")}>
            <Search className="size-4" aria-hidden="true" /> Research
          </Button>
        </div>
      )}
      {claim.status === "researched" && (
        <div className="flex gap-2">
          <Button size="sm" loading={busy === "prepare"} onClick={() => run("prepare", prepareClaimForm({ data: { claimId: claim.id } }), "Response form prepared.")}>
            <PenLine className="size-4" aria-hidden="true" /> Prepare form
          </Button>
        </div>
      )}
      {claim.status === "form_ready" && (
        <div className="space-y-2.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-700">
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            {claim.driverUserId ? `Waiting for ${claim.driverName ?? "the assigned driver"} to review and sign.` : "No driver is linked — you can sign on behalf, or assign the driver in a later step."}
          </p>
          {!claim.driverUserId && (
            <div className="space-y-2 rounded-xl border border-ink-100 bg-white p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">Sign on behalf of the company</p>
              <SignaturePad label="Owner signs here" onChange={setOwnerSig} />
              <Button size="sm" className="w-full" loading={signing} disabled={!ownerSig} onClick={() => void signOnBehalf()}>
                <FileSignature className="size-4" aria-hidden="true" /> Sign the response
              </Button>
            </div>
          )}
        </div>
      )}
      {claim.status === "pending_approval" && (
        <div className="space-y-2.5">
          <p className="text-xs font-semibold text-ink-600">Signed{claim.signedByName ? ` by ${claim.signedByName}` : ""} · waiting for your approval. Nothing sends until you approve.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" loading={busy === "approve"} onClick={() => run("approve", approveClaim({ data: claim.id }), "Approved — you can now send it.")}>
              <CheckCircle2 className="size-4" aria-hidden="true" /> Approve
            </Button>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Reason for rejection (required)"
                className="h-9 w-full min-w-0 flex-1 rounded-lg border border-ink-200 bg-white px-2.5 text-[13px] text-ink-700 outline-none placeholder:text-ink-300 focus:border-brand-400"
              />
              <Button size="sm" variant="danger-ghost" loading={busy === "reject"} disabled={rejectReason.trim().length < 2}
                onClick={() => run("reject", rejectClaim({ data: { claimId: claim.id, reason: rejectReason.trim() } }), "Claim closed — nothing was sent.")}>
                <XCircle className="size-4" aria-hidden="true" /> Reject
              </Button>
            </div>
          </div>
        </div>
      )}
      {claim.status === "approved" && !webFormOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" loading={busy === "send"} onClick={() => run("send", sendClaim({ data: claim.id }), "Sent to the company.")}>
            <Send className="size-4" aria-hidden="true" /> Send to {claim.sendTo ?? "company"}
          </Button>
          <p className="text-[11px] text-ink-400">The signed form goes to {claim.sendTo ?? "the company"} via email.</p>
        </div>
      )}
      {claim.status === "approved" && webFormOnly && (
        <p className="text-xs font-semibold text-ink-500">{claim.company} requires its own web form — sending is a phase-2 adapter.</p>
      )}
      {claim.status === "sent" && (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-success-700">
          <CheckCircle2 className="size-3.5" aria-hidden="true" /> Sent to {claim.sendTo ?? "the company"} on {fmtDate(claim.sentAt)}.
        </p>
      )}
      {claim.status === "closed" && (
        <p className="text-xs font-semibold text-ink-500">Closed{claim.resolvedReason ? ` — ${claim.resolvedReason}` : ""}. Nothing was sent.</p>
      )}
      {claim.status === "resolved" && (
        <p className="text-xs font-semibold text-success-700">Marked resolved by the research pass. Nothing was sent.</p>
      )}
    </div>
  );
}

/* ------------------------------ driver sign screen ------------------------------ */

/** Loads the claim assigned to the acting driver and renders the review +
 *  signature flow. Uses the driver-feed list (server-scoped to the acting
 *  driver identity) so a driver can only ever see their own claims. */
export function DriverClaimSignView({ claimId }: { claimId: string }) {
  const toast = useToast();
  const nav = useNavigate();
  const [claim, setClaim] = useState<ClaimRow | null | "loading">("loading");
  const [signature, setSignature] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    void listMyClaimSignRequests().then((r) => {
      if (!live) return;
      if (!r.ok) { setClaim(null); return; }
      setClaim(r.data.find((c) => c.id === claimId) ?? null);
    }).catch(() => live && setClaim(null));
    return () => { live = false; };
  }, [claimId]);

  const submit = () => {
    if (!signature || claim === null || claim === "loading") return;
    setSaving(true);
    void signClaim({ data: { claimId: claim.id, signatureDataUrl: signature } }).then((r) => {
      if (r.ok) { setDone(true); toast("Your signature was submitted for the owner's review."); }
      else toast(r.message ?? "Couldn't submit your signature — try again.");
    }).catch(() => toast("Couldn't submit your signature — check your connection.")).finally(() => setSaving(false));
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-5">
      <button type="button" onClick={() => void nav({ to: "/driver" })} className="inline-flex items-center gap-1 text-xs font-bold text-ink-500 hover:text-ink-700">
        <ArrowLeft className="size-3.5" aria-hidden="true" /> Back to Home
      </button>

      {claim === "loading" ? (
        <div className="space-y-2"><div className="h-24 animate-pulse rounded-2xl bg-ink-100/70" /><div className="h-40 animate-pulse rounded-2xl bg-ink-100/70" /></div>
      ) : claim === null ? (
        <Card className="p-6 text-center">
          <AlertTriangle className="mx-auto size-8 text-ink-300" aria-hidden="true" />
          <p className="mt-2 text-sm font-bold text-ink-700">No sign request found</p>
          <p className="mt-1 text-xs text-ink-500">This claim isn't assigned to you, or it's already been handled.</p>
        </Card>
      ) : done ? (
        <Card className="p-6 text-center">
          <CheckCircle2 className="mx-auto size-10 text-success-500" aria-hidden="true" />
          <p className="mt-2 text-sm font-bold text-ink-900">Signature submitted</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            Your signed response for {claim.company} case {claim.claimNumber ?? ""} is with the owner for review. You'll be notified if anything else is needed.
          </p>
          <Button className="mt-4" size="sm" onClick={() => void nav({ to: "/driver" })}>Back to Home</Button>
        </Card>
      ) : (
        <>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-danger-50 text-danger-600">
                <FileSignature className="size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-extrabold text-ink-900">Damage claim needs your review &amp; signature</p>
                <p className="text-xs text-ink-500">{claim.company} · case {claim.claimNumber ?? "—"} · {fmtDate(claim.createdAt)}</p>
              </div>
              <ClaimStatusBadge status={claim.status} />
            </div>
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold leading-relaxed text-amber-800">
              A customer says damage happened during your service. Read the prepared response below — it's your statement. Sign it only if you agree with it.
            </p>
          </Card>

          <ClaimStatementCard claim={claim} title="Prepared response — review carefully" />
          <SendTargetCard claim={claim} />

          <Card className="p-4">
            <p className="mb-1 text-xs font-semibold text-ink-700">Your signature <span className="text-danger-500">*</span></p>
            <SignaturePad label="Sign here to confirm this statement" onChange={setSignature} />
            <Button className="mt-3 w-full" loading={saving} disabled={!signature} onClick={() => void submit()}>
              <PenLine className="size-4" aria-hidden="true" /> Sign &amp; submit for review
            </Button>
            {!signature && <p className="mt-1.5 text-center text-[11px] text-ink-400">Sign above to submit your response.</p>}
          </Card>
        </>
      )}
    </div>
  );
}

/* ------------------------------ driver home card ------------------------------ */

/** URGENT card on the driver Home: any claim assigned to this driver that is
 *  waiting for their signature (form_ready / pending_approval). Tapping opens
 *  the sign screen. Fetches via listMyClaimSignRequestsCore (server-scoped). */
export function DriverClaimReviewCard() {
  const nav = useNavigate();
  const [claims, setClaims] = useState<ClaimRow[] | null>(null);
  useEffect(() => {
    let live = true;
    void listMyClaimSignRequests().then((r) => {
      if (!live || !r.ok) return;
      setClaims(r.data);
    }).catch(() => { /* hide silently */ });
    return () => { live = false; };
  }, []);
  const first = claims?.find((c) => c.status === "form_ready") ?? claims?.[0];
  if (!first) return null;
  return (
    <button
      type="button"
      onClick={() => void nav({ to: "/driver/claims/$id", params: { id: first.id } })}
      className="absolute left-1/2 top-28 z-20 flex w-max max-w-[92vw] -translate-x-1/2 items-center gap-2.5 rounded-2xl border border-danger-200 bg-surface px-3.5 py-2.5 text-left shadow-card transition-transform active:scale-95"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-danger-600 text-white">
        <FileSignature className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-extrabold text-danger-700">Damage claim needs your review</span>
        <span className="block truncate text-[11px] font-medium text-ink-500">{first.company} · case {first.claimNumber ?? "—"} — tap to sign</span>
      </span>
    </button>
  );
}
