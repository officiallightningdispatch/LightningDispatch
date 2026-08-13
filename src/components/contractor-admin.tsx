/**
 * Contractor administration shared components (owner-directed 2026-08-11,
 * plan rev 17) — used by the owner Contractors tab and (parts 2/3) the owner
 * contractor detail + contractor Documents screen. Mobile-first, token-true:
 * brand orange #F27801 for money, ink for structure, success/danger/accent per
 * the doc-status color map, rounded-2xl cards / rounded-xl controls /
 * rounded-full badges, touch targets ≥44px (h-11), tabular-nums for numbers.
 */
import { Camera, Check, CheckCircle2, ChevronDown, ClipboardList, Eye, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui";
import type { ContractorDocumentRow, DocStatus, DocTypeRow } from "~/data/contractor-admin";

/* ------------------------------ ComplianceBadge ------------------------------ */
/** "{approved}/{required} approved" pill — green ✓ when every required doc is
 *  owner-approved, danger tint when some are still pending; hidden entirely
 *  when the org requires no document types. "Approved" = owner-verified
 *  (owner-directed 2026-08-12: the chip must reflect approved vs submitted —
 *  "shows 4/4 submitted but no option to approve"). */
export function ComplianceBadge({ approved, required, size = "sm" }: { approved: number; required: number; size?: "sm" | "lg" }) {
  if (required <= 0) return null;
  const complete = approved >= required;
  const pending = required - approved;
  const cls = size === "lg" ? "text-xs px-3 py-1.5" : "text-[11px] px-2.5 py-1";
  return (
    <span
      className={`inline-flex min-h-[22px] items-center gap-1.5 rounded-full font-bold uppercase tracking-wide tabular-nums ${cls} ${
        complete ? "bg-success-50 text-success-700" : "bg-danger-50 text-danger-700"
      }`}
      title={
        complete
          ? "All required documents approved"
          : `${pending} required document${pending === 1 ? "" : "s"} not approved yet — open the contractor to review`
      }
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full bg-current opacity-80 ${complete ? "bg-success-500" : "bg-danger-500"}`} />
      {approved}/{required} approved
      {complete ? " ✓" : ""}
    </span>
  );
}

/* ------------------------------- PayRateField ------------------------------- */
/** Inline per-job payrate edit: display "$75 / job" (brand-orange, tabular) +
 *  pencil; edit = $ prefix + decimal input + check/X (busy disables both);
 *  clearing an existing rate asks "Remove the rate?" first; unset renders "—".
 *  The parent owns the optimistic row update + toast + revert: onSave returns
 *  a promise that rejects on failure so the field can restore its display. */
export function PayRateField({
  valueCents,
  size = "sm",
  onSave,
  busy = false,
}: {
  valueCents: number | null;
  size?: "sm" | "lg";
  onSave: (cents: number | null) => Promise<void>;
  /** Parent-side in-flight guard (e.g. another row saving). */
  busy?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const display = valueCents == null ? null : formatCents(valueCents);
  const inFlight = saving || busy;

  const startEdit = () => {
    setDraft(valueCents == null ? "" : String(valueCents / 100));
    setError("");
    setConfirmingClear(false);
    setEditing(true);
  };

  const parseDraft = (): number | null => {
    const raw = draft.replace(/[$,\s]/g, "");
    if (raw === "") return null;
    if (!/^\d+(\.\d{0,2})?$/.test(raw)) return null;
    const cents = Math.round(parseFloat(raw) * 100);
    if (cents < 0 || cents > 9_999_999) return null;
    return cents;
  };

  const save = async () => {
    const cents = parseDraft();
    if (cents == null) { setError("Enter an amount like 75"); return; }
    setError("");
    setSaving(true);
    try {
      await onSave(cents);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the rate.");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave(null);
      setConfirmingClear(false);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't clear the rate.");
    } finally {
      setSaving(false);
    }
  };

  // Display mode
  if (!editing) {
    return (
      <span className="inline-flex min-h-9 items-center gap-1">
        {display != null ? (
          <span className={`font-bold tabular-nums text-brand-700 ${size === "lg" ? "text-lg" : "text-sm"}`}>
            {display} <span className="font-semibold text-ink-400">/ job</span>
          </span>
        ) : (
          <span className={`font-bold tabular-nums text-ink-300 ${size === "lg" ? "text-lg" : "text-sm"}`}>—</span>
        )}
        <button
          type="button"
          onClick={startEdit}
          disabled={inFlight}
          aria-label="Edit payrate"
          className="grid size-10 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-600 disabled:opacity-50"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      </span>
    );
  }

  // Confirm-clear (only offered when a rate already exists)
  if (confirmingClear) {
    return (
      <span className="inline-flex min-h-9 items-center gap-1.5">
        <span className="text-xs font-medium text-ink-500">Remove the rate?</span>
        <Button size="sm" variant="danger" loading={saving} onClick={() => void clear()}>Remove</Button>
        <Button size="sm" variant="secondary" disabled={saving} onClick={() => setConfirmingClear(false)}>Keep</Button>
      </span>
    );
  }

  // Edit mode
  return (
    <span className="inline-flex items-center gap-1">
      <span className="flex h-9 items-center rounded-lg border border-ink-200 bg-surface px-2 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100">
        <span className="text-sm font-semibold text-ink-400">$</span>
        <input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
          inputMode="decimal"
          autoFocus
          maxLength={8}
          placeholder="75"
          aria-label="Payrate per job"
          disabled={saving}
          className="w-16 bg-transparent px-1 text-sm font-bold tabular-nums text-brand-700 outline-none placeholder:text-ink-300"
        />
      </span>
      <Button size="sm" loading={saving} className="!px-2.5" title="Save rate" onClick={() => void save()}>
        <Check className="size-3.5" aria-hidden="true" />
      </Button>
      <Button size="sm" variant="secondary" className="!px-2.5" disabled={saving} title={valueCents != null ? "Clear rate" : "Cancel"}
        onClick={() => (valueCents != null ? setConfirmingClear(true) : setEditing(false))}>
        <X className="size-3.5" aria-hidden="true" />
      </Button>
      {error && <span role="alert" className="text-xs font-medium text-danger-600">{error}</span>}
    </span>
  );
}

/** 12345 → "$123.45" (2 decimals max, tabular-safe string). */
export function formatCents(cents: number): string {
  const v = (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `$${v}`;
}

/* --------------------------- DocumentTypeEditorRow --------------------------- */
/** Owner Required-documents editor row: up/down chevrons (sort_order swap),
 *  name + pencil (inline rename), AiToggle-style active switch, danger-ghost
 *  delete with confirm. Hides the controls that don't apply to a paused row. */
export function DocumentTypeEditorRow({
  type,
  isFirst,
  isLast,
  busy,
  onRename,
  onToggle,
  onRemove,
  onMove,
}: {
  type: DocTypeRow;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onRename: (name: string) => Promise<void>;
  onToggle: (active: boolean) => Promise<void>;
  onRemove: () => Promise<void>;
  onMove: (direction: "up" | "down") => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [draft, setDraft] = useState(type.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submitRename = async () => {
    const name = draft.trim();
    if (!name) { setError("Enter a name."); return; }
    if (name === type.name) { setRenaming(false); return; }
    setError("");
    setSaving(true);
    try {
      await onRename(name);
      setRenaming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't rename.");
    } finally {
      setSaving(false);
    }
  };

  const confirmRemove = async () => {
    setSaving(true);
    setError("");
    try {
      await onRemove();
      setConfirmingRemove(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`px-4 py-3.5 ${type.active ? "" : "bg-ink-50/40"} ${isLast ? "" : "border-b border-ink-100"}`}>
      <div className="flex items-center gap-2">
        {type.active && (
          <span className="flex flex-col">
            <button type="button" disabled={busy || isFirst} aria-label="Move up" onClick={() => void onMove("up")}
              className="grid size-9 place-items-center rounded text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-30">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
            </button>
            <button type="button" disabled={busy || isLast} aria-label="Move down" onClick={() => void onMove("down")}
              className="grid size-9 place-items-center rounded text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-30">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
          </span>
        )}
        <div className="min-w-0 flex-1">
          {renaming ? (
            <span className="flex items-center gap-1.5">
              <input
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") void submitRename(); if (e.key === "Escape") setRenaming(false); }}
                maxLength={40}
                autoFocus
                disabled={saving}
                aria-label="Document type name"
                className="h-9 w-full max-w-56 rounded-lg border border-ink-200 bg-surface px-2.5 text-sm font-medium outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
              <Button size="sm" loading={saving} className="!px-2.5" title="Save name" onClick={() => void submitRename()}>
                <Check className="size-3.5" aria-hidden="true" />
              </Button>
              <Button size="sm" variant="secondary" className="!px-2.5" disabled={saving} onClick={() => setRenaming(false)}>
                <X className="size-3.5" aria-hidden="true" />
              </Button>
            </span>
          ) : (
            <p className={`break-words text-sm font-semibold ${type.active ? "" : "text-ink-400"}`}>
              {type.name}
              {type.requiresExpiry && <span className="ml-2 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-500">expires</span>}
              {!type.active && <span className="ml-2 text-[11px] font-bold uppercase tracking-wide text-ink-400">paused</span>}
            </p>
          )}
          {error && <p role="alert" className="mt-1 text-xs font-medium text-danger-600">{error}</p>}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={type.active}
          aria-label={`${type.name} required`}
          disabled={busy}
          onClick={() => void onToggle(!type.active)}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-50 ${
            type.active ? "bg-brand-500" : "bg-ink-200"
          }`}
        >
          <span aria-hidden="true" className={`inline-block size-5 transform rounded-full bg-white shadow transition-transform duration-150 ${type.active ? "translate-x-6" : "translate-x-1"}`} />
        </button>
        {type.active && !renaming && (
          <button type="button" disabled={busy} aria-label={`Rename ${type.name}`} onClick={() => { setDraft(type.name); setError(""); setRenaming(true); }}
            className="grid size-10 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-600 disabled:opacity-50">
            <Pencil className="size-4" aria-hidden="true" />
          </button>
        )}
        <button type="button" disabled={busy} aria-label={`Remove ${type.name}`} onClick={() => { setError(""); setConfirmingRemove(true); }}
          className="grid size-10 place-items-center rounded-lg text-danger-600 transition-colors hover:bg-danger-50 disabled:opacity-50">
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
      {confirmingRemove && (
        <div className="mt-3 rounded-xl border border-danger-200 bg-danger-50/60 p-4">
          <p className="text-sm font-bold text-danger-800">Remove “{type.name}”?</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-600">
            Removing a type doesn&apos;t delete contractors&apos; files — it just stops being required.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="danger" size="sm" loading={saving} onClick={() => void confirmRemove()}>Remove type</Button>
            <Button variant="secondary" size="sm" disabled={saving} onClick={() => setConfirmingRemove(false)}>Keep it</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- DocStatusBadge ------------------------------- */
/** Per-doc status pill following the spec's color map: MISSING ink-neutral,
 *  UPLOADED info, VERIFIED success, EXPIRED danger, REJECTED accent (yellow is
 *  reserved for rejected + the driver-side docs-needed chip — nothing else). */
export function DocStatusBadge({ status, className }: { status: DocStatus; className?: string }) {
  const map = {
    missing: { cls: "bg-ink-100 text-ink-600", dot: "bg-ink-400", label: "Missing" },
    uploaded: { cls: "bg-info-50 text-info-700", dot: "bg-info-500", label: "Submitted" },
    verified: { cls: "bg-success-50 text-success-700", dot: "bg-success-500", label: "Verified ✓" },
    expired: { cls: "bg-danger-50 text-danger-700", dot: "bg-danger-500", label: "Expired" },
    rejected: { cls: "bg-accent-100 text-accent-700", dot: "bg-accent-500", label: "Reupload requested" },
  } as const;
  const m = map[status];
  return (
    <span
      className={`inline-flex min-h-[22px] items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${m.cls} ${className ?? ""}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

/* ------------------------------ ComplianceSummary ------------------------------ */
/** "{approved} of {required} approved — needs review: W-9, Insurance Cert"
 *  (names come from the caller's doc rows — the owner-actionable docs that are
 *  not yet verified); "all approved ✓" when complete. Hidden when the org
 *  requires no document types. Owner-directed 2026-08-12: approved vs
 *  submitted, so a "4/4 on file" row can't masquerade as approved. */
export function ComplianceSummary({ approved, required, actionNames = [] }: { approved: number; required: number; actionNames?: string[] }) {
  if (required <= 0) return null;
  const pending = required - approved;
  return (
    <p className="text-xs leading-relaxed">
      <span className="font-bold tabular-nums text-ink-900">{approved} of {required}</span>{" "}
      <span className="text-ink-500">approved</span>
      {pending > 0 ? (
        <>
          {" — needs review: "}
          <span className="font-semibold text-accent-600">{actionNames.length ? actionNames.join(", ") : `${pending} more`}</span>
        </>
      ) : (
        <>
          {" — "}
          <span className="font-semibold text-success-600">all approved ✓</span>
        </>
      )}
    </p>
  );
}

/* ------------------------- OwnerDocumentRow (owner view) ------------------------- */
/** One required type + the contractor's current file, owner review surface:
 *  tap the row body to expand the detail panel. MISSING has no actions (the
 *  owner doesn't upload in v1 — contractors upload from their app). UPLOADED →
 *  Verify (optional expiry when requiresExpiry) / Ask to reupload. VERIFIED →
 *  editable expiry + View + reupload request. EXPIRED / REJECTED → View +
 *  reupload paths. The parent owns the server calls + refresh + viewer. */
export function OwnerDocumentRow({
  doc,
  busy,
  onVerify,
  onReject,
  onSetExpiry,
  onView,
  onViewSelfie,
  onReviewPair,
  onReviewForm,
}: {
  doc: ContractorDocumentRow;
  busy: boolean;
  onVerify: (docId: string, expiresOn: string | null) => Promise<void>;
  onReject: (docId: string, reviewNote: string) => Promise<void>;
  onSetExpiry: (docId: string, expiresOn: string | null) => Promise<void>;
  onView: () => Promise<void>;
  /** Part 3 (owner-directed 2026-08-12): view the live selfie half of a
   *  facial-verification pair — the pair is approved with ONE verify tap, so
   *  the owner needs eyes on both files. */
  onViewSelfie?: () => Promise<void>;
  /** Contractor Management v2 (2026-08-12): open the side-by-side
   *  license+selfie compare sheet (DocCompareSheet) for pair-bearing types.
   *  When provided, the expanded row's primary action becomes "Review pair". */
  onReviewPair?: () => Promise<void>;
  /** Official fillable forms (2026-08-12): the W-9 / I-9 rows are FILLABLE
   *  OFFICIAL FORMS — the owner reviews the completed form in a dedicated
   *  sheet (decrypted SSN/EIN for the W-9, Section 2 completion for the I-9)
   *  instead of the generic verify tap. When provided, the primary action
   *  becomes "Review {W-9|I-9}". */
  onReviewForm?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [verifySheet, setVerifySheet] = useState(false);
  const [rejectSheet, setRejectSheet] = useState(false);
  const [expiryDraft, setExpiryDraft] = useState(doc.expiresOn ?? "");
  const [rejectNote, setRejectNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = busy || saving;
  const hasFile = doc.docId != null;

  const run = async (fn: () => Promise<void>) => {
    setSaving(true);
    setError("");
    try {
      await fn();
      setVerifySheet(false);
      setRejectSheet(false);
      setRejectNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That action didn't go through — try again.");
    } finally {
      setSaving(false);
    }
  };

  const meta = hasFile
    ? [doc.fileName, doc.uploadedAt ? `uploaded ${new Date(doc.uploadedAt).toLocaleDateString()}` : null, doc.expiresOn ? `expires ${doc.expiresOn}` : null]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <div className="border-b border-ink-100 px-4 py-3.5 last:border-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="break-words text-sm font-semibold text-ink-900">{doc.docTypeName}</span>
            {doc.requiresExpiry && (
              <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-500">expires</span>
            )}
          </span>
          <span className="mt-1 block">
            <DocStatusBadge status={doc.status} />
          </span>
        </span>
        <ChevronDown className={`size-4 shrink-0 text-ink-400 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {expanded && (
        <div className="mt-3 rounded-xl bg-ink-50/50 p-3">
          {!hasFile ? (
            <p className="text-xs italic text-ink-400">Awaiting contractor upload — the owner doesn&apos;t upload in v1.</p>
          ) : (
            <>
              {meta && <p className="mb-2 break-words text-xs text-ink-500">{meta}</p>}

              {doc.requiresFacialVerification && (
                <p className="mb-2 flex flex-wrap items-center gap-2">
                  {doc.selfieStatus === "uploaded" ? (
                    <>
                      <span className="inline-flex items-center gap-1 rounded-full bg-success-50 px-2 py-0.5 text-[11px] font-bold text-success-700">
                        <CheckCircle2 className="size-3" aria-hidden="true" /> Live selfie: submitted
                      </span>
                      {onReviewPair ? (
                        <Button size="sm" className="!px-2.5" disabled={inFlight} onClick={() => void onReviewPair()}>
                          <Eye className="size-3.5" aria-hidden="true" /> Review pair
                        </Button>
                      ) : onViewSelfie ? (
                        <Button size="sm" variant="ghost" className="!px-2.5" disabled={inFlight} onClick={() => void onViewSelfie()}>
                          <Eye className="size-3.5" aria-hidden="true" /> View selfie
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-semibold text-ink-600">
                      <Camera className="size-3" aria-hidden="true" /> Live selfie: not uploaded yet — the pair can&apos;t be approved without it
                    </span>
                  )}
                </p>
              )}
              {doc.status === "missing" && null}
              {doc.status === "rejected" && doc.reviewNote && (
                <p className="mb-2 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2 text-xs text-accent-800">
                  <strong>Reason:</strong> {doc.reviewNote}
                </p>
              )}

              {error && <p role="alert" className="mb-2 text-xs font-medium text-danger-600">{error}</p>}

              <div className="flex flex-wrap items-center gap-2">
                {doc.status !== "missing" && !doc.requiresNotificationsLocation && (
                  <Button size="sm" variant="secondary" className="!px-2.5" disabled={inFlight} onClick={() => void onView()}>
                    <Eye className="size-3.5" aria-hidden="true" /> View
                  </Button>
                )}
                {doc.requiresNotificationsLocation ? (
                  <span className="text-[11px] font-medium text-ink-400">
                    {doc.status === "verified" ? "Auto-completed by the driver — alerts + location on." : "Driver has not set this up yet."}
                  </span>
                ) : (doc.status === "uploaded" || doc.status === "rejected") && (
                  doc.formKind && onReviewForm ? (
                    <Button size="sm" className="!px-2.5" disabled={inFlight} onClick={() => { onReviewForm(); setError(""); }}>
                      <ClipboardList className="size-3.5" aria-hidden="true" /> {doc.formKind === "w9" ? "Review W-9" : "Review I-9"}
                    </Button>
                  ) : (
                    <Button size="sm" className="!px-2.5" disabled={inFlight} onClick={() => { setVerifySheet(true); setError(""); }}>
                      {doc.status === "rejected" ? "Clear & re-verify" : "Verify"}
                    </Button>
                  )
                )}
                {(doc.status === "verified" || doc.status === "expired") && !doc.requiresNotificationsLocation && (
                  <span className="flex items-center gap-1.5">
                    <input
                      type="date"
                      value={expiryDraft}
                      onChange={(e) => setExpiryDraft(e.target.value)}
                      disabled={inFlight}
                      aria-label={`Expiry for ${doc.docTypeName}`}
                      className="h-9 rounded-lg border border-ink-200 bg-surface px-2 text-xs tabular-nums text-ink-700 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      className="!px-2.5"
                      disabled={inFlight || expiryDraft === (doc.expiresOn ?? "")}
                      onClick={() => run(() => onSetExpiry(doc.docId!, expiryDraft || null))}
                    >
                      Save
                    </Button>
                  </span>
                )}
                {(doc.status === "uploaded" || doc.status === "verified" || doc.status === "expired") && !doc.requiresNotificationsLocation && (
                  <Button size="sm" variant="ghost" className="!px-2.5" disabled={inFlight} onClick={() => { setRejectSheet(true); setError(""); }}>
                    Ask to reupload
                  </Button>
                )}
              </div>

              {verifySheet && (
                <div className="mt-3 rounded-xl border border-ink-200 bg-surface p-3">
                  <p className="text-sm font-bold text-ink-900">Verify “{doc.docTypeName}”?</p>
                  {doc.requiresExpiry && (
                    <label className="mt-2 block">
                      <span className="mb-1 block text-xs font-semibold text-ink-500">Expires on <span className="font-normal text-ink-300">(optional — expired dates flag automatically)</span></span>
                      <input
                        type="date"
                        value={expiryDraft}
                        onChange={(e) => setExpiryDraft(e.target.value)}
                        className="h-11 w-full max-w-56 rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      />
                    </label>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" loading={saving} onClick={() => run(() => onVerify(doc.docId!, expiryDraft || null))}>Mark verified</Button>
                    <Button size="sm" variant="secondary" disabled={saving} onClick={() => setVerifySheet(false)}>Cancel</Button>
                  </div>
                </div>
              )}

              {rejectSheet && (
                <div className="mt-3 rounded-xl border border-ink-200 bg-surface p-3">
                  <p className="text-sm font-bold text-ink-900">Ask {doc.status === "expired" ? "for a reupload" : "to reupload"} — reason shown to the contractor</p>
                  <textarea
                    value={rejectNote}
                    onChange={(e) => setRejectNote(e.target.value)}
                    maxLength={300}
                    rows={2}
                    placeholder="e.g. The insurance certificate is blurry — please upload a clearer copy."
                    className="mt-2 h-auto w-full rounded-xl border border-ink-200 bg-surface px-3 py-2 text-sm outline-none placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" loading={saving} disabled={!rejectNote.trim()} onClick={() => run(() => onReject(doc.docId!, rejectNote.trim()))}>
                      Request reupload
                    </Button>
                    <Button size="sm" variant="secondary" disabled={saving} onClick={() => setRejectSheet(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
