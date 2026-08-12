/**
 * ContractorProfileEditor — the single full-screen EDIT surface for a
 * contractor (Contractor Management v2, designer spec 2026-08-12, owner
 * feedback "no way to review documents / no modal with all their
 * documentation, contact, vehicle, schedule"). Replaces the vague inline
 * name/email editor with an Uber-fleet-grade modal: sticky header + sticky
 * section nav (Profile / Contact / Vehicle / Schedule / Documents / Pay /
 * Compliance / Danger), per-section immediate save, elevated document review
 * (DocCompareSheet license+selfie pair compare + ExpiryChip warnings) and the
 * danger zone. Owner/admin only — every page that mounts it is behind the
 * OwnerGate. All writes go through the shipped server cores
 * (setContractorVehicleCore / setContractorScheduleCore / extended
 * getContractorDetailCore etc.) — nothing here re-implements server logic.
 */
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle, CalendarClock, FileText, IdCard, Loader2, MapPin, Pencil, Phone, Save, Trash2, X,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { InlineError } from "~/components/mutation-status";
import {
  ComplianceBadge, ComplianceSummary, OwnerDocumentRow, PayRateField, formatCents,
} from "~/components/contractor-admin";
import { Alert, Avatar, Button, Card, SkeletonBlock, useToast } from "~/components/ui";
import {
  getContractorDetail, getDocumentFile, getSelfieFile, listContractorDocuments,
  setContractorContact, setContractorPayrate, setContractorSchedule,
  setContractorVehicle, setDocumentExpiry, setDocumentStatus,
  type ContractorDetailRow, type ContractorDocumentRow, type ContractorScheduleRow,
  type ContractorVehicle, type DocFilePayload,
} from "~/data/contractor-admin";
import { editContractor, removeContractor, type TowbookPushOutcome } from "~/data/contractor-management";
import { timeAgo } from "~/lib/job-ui";

/** Weekly template day — {day: 1..7 (Mon..Sun), start/end "HH:MM" 24h}. */
export type ScheduleDay = { day: number; start: string; end: string };

export type EditorSection = "profile" | "contact" | "vehicle" | "schedule" | "documents" | "pay" | "compliance" | "danger";
export const EDITOR_SECTIONS: { id: EditorSection; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "contact", label: "Contact" },
  { id: "vehicle", label: "Vehicle" },
  { id: "schedule", label: "Schedule" },
  { id: "documents", label: "Documents" },
  { id: "pay", label: "Pay" },
  { id: "compliance", label: "Compliance" },
  { id: "danger", label: "Danger" },
];
const DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "08:00" → "8:00a"; "17:00" → "5:00p". */
function fmtTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "p" : "a";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${period}`;
}

/** "Mon–Fri 8:00a–5:00p" for a weekly template; null when nothing is set. */
export function scheduleSummary(schedule: ScheduleDay[]): string | null {
  if (!schedule.length) return null;
  const sorted = [...schedule].sort((a, b) => a.day - b.day);
  // Collapse consecutive-day runs sharing the same start/end.
  const runs: { from: number; to: number; start: string; end: string }[] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.to === d.day - 1 && last.start === d.start && last.end === d.end) last.to = d.day;
    else runs.push({ from: d.day, to: d.day, start: d.start, end: d.end });
  }
  const label = (d: number) => DAY_SHORT[d - 1];
  return runs.map((r) => {
    const days = r.from === r.to ? label(r.from) : `${label(r.from)}–${label(r.to)}`;
    return `${days} ${fmtTime(r.start)}–${fmtTime(r.end)}`;
  }).join(" · ");
}

/** Source-driven display line for the schedule card / section. */
export function scheduleSourceLine(s: ContractorScheduleRow): string {
  if (s.ownerOverride) return "Set by owner (override)";
  return s.schedule.length ? "Declared by contractor" : "No schedule set — availability isn't limited";
}

/** Accent expiry warning pill (the ONLY new yellow usage on the owner side —
 *  design-token budget 2026-08-12: REJECTED badges + expiring states). */
export function ExpiryChip({ expiresOn }: { expiresOn: string }) {
  const today = new Date();
  const target = new Date(`${expiresOn}T00:00:00`);
  const days = Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-bold text-accent-700"
      title={`Expires ${expiresOn}`}
    >
      <AlertTriangle className="size-3" aria-hidden="true" />
      {days < 0 ? `expired ${expiresOn}` : days === 0 ? "expires today" : days === 1 ? "expires tomorrow" : `expires in ${days} days`}
    </span>
  );
}

/** Towbook push outcome → user-facing notice (same mapping as the roster). */
function noticeFor(t: TowbookPushOutcome): { kind: "ok" | "warn"; text: string } {
  if (t.status === "verified") return { kind: "ok", text: t.notice };
  if (t.status === "skipped" || t.status === "unsupported") return { kind: "warn", text: t.notice };
  return { kind: "warn", text: t.notice + " This was escalated to the ops queue for review." };
}

/* ------------------------------ DocCompareSheet ------------------------------ */
/** Side-by-side document + live selfie compare for facial-verification types
 *  (owner's #1 ask: "no way to review the documents"). Two half-width panels
 *  on every screen — never stacked. Approve pair = one tap (the server guard
 *  refuses verify without the selfie on file); reject-with-reason reuses the
 *  shipped reupload flow. */
export function DocCompareSheet({
  doc,
  onApprove,
  onReject,
  onClose,
}: {
  doc: ContractorDocumentRow;
  onApprove: (expiresOn: string | null) => Promise<void>;
  onReject: (reviewNote: string) => Promise<void>;
  onClose: () => void;
}) {
  const [docFile, setDocFile] = useState<DocFilePayload | null>(null);
  const [selfie, setSelfie] = useState<DocFilePayload | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(true);
  const [loadingSelfie, setLoadingSelfie] = useState(true);
  const [docError, setDocError] = useState("");
  const [selfieError, setSelfieError] = useState("");
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [expiryDraft, setExpiryDraft] = useState(doc.expiresOn ?? "");
  const loadDoc = async () => {
    if (!doc.docId) return;
    setLoadingDoc(true); setDocError("");
    const r = await getDocumentFile({ data: { docId: doc.docId } });
    setLoadingDoc(false);
    if (!r.ok) setDocError(r.message); else setDocFile(r.data);
  };
  const loadSelfie = async () => {
    setLoadingSelfie(true); setSelfieError("");
    const r = await getSelfieFile({ data: { docTypeId: doc.docTypeId } });
    setLoadingSelfie(false);
    if (!r.ok) setSelfieError(r.message); else setSelfie(r.data);
  };
  useEffect(() => { void loadDoc(); void loadSelfie(); }, [doc.docId, doc.docTypeId]);
  const approve = async () => {
    setApproving(true); setError("");
    try {
      await onApprove(expiryDraft || null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't approve the pair — try again.");
    } finally {
      setApproving(false);
    }
  };
  const reject = async () => {
    setRejecting(true); setError("");
    try {
      await onReject(rejectNote.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't request the reupload — try again.");
    } finally {
      setRejecting(false);
    }
  };
  const panel = (label: string, file: DocFilePayload | null, loading: boolean, err: string, retry: () => void, empty: ReactNode) => (
    <div className="rounded-xl border border-ink-100 bg-canvas p-2.5">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-ink-400">{label}</p>
      {loading ? (
        <div className="grid h-48 place-items-center gap-2 text-xs text-ink-400">
          <Loader2 className="size-4 animate-spin text-brand-500 motion-reduce:animate-none" aria-hidden="true" />
          {label === "Document" ? "Loading document…" : "Loading selfie…"}
        </div>
      ) : err ? (
        <div className="grid h-48 place-items-center">
          <div className="text-center">
            <p className="text-xs text-danger-600">{err}</p>
            <Button size="sm" variant="secondary" className="mt-2 !px-2.5" onClick={retry}>Try again</Button>
          </div>
        </div>
      ) : !file ? (
        <div className="grid h-48 place-items-center text-center">{empty}</div>
      ) : file.mime.startsWith("image/") ? (
        <img src={`data:${file.mime};base64,${file.base64}`} alt={label} className="max-h-64 w-full rounded-lg object-contain" />
      ) : (
        <div className="grid h-48 place-items-center">
          <a
            href={`data:${file.mime};base64,${file.base64}`}
            download={file.fileName ?? `${doc.docTypeName}.pdf`}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white hover:bg-brand-600"
          >
            <FileText className="size-4" aria-hidden="true" /> Open PDF
          </a>
        </div>
      )}
      {file?.fileName && <p className="mt-1.5 truncate text-[11px] text-ink-400">{file.fileName}</p>}
    </div>
  );
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-ink-950/40 p-4" role="dialog" aria-modal="true" aria-label={`Verify ${doc.docTypeName} — document & live selfie`}>
      <div className="w-full max-w-2xl rounded-2xl bg-surface shadow-card-hover">
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">Verify {doc.docTypeName}</p>
            <p className="text-xs text-ink-400">Document &amp; live selfie — approve the pair together</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close compare" className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-500 hover:bg-ink-50 hover:text-ink-700">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 p-4">
          {panel("Document", docFile, loadingDoc, docError, () => void loadDoc(), <p className="text-xs italic text-ink-400">No document file on record.</p>)}
          {panel("Live selfie", selfie, loadingSelfie, selfieError, () => void loadSelfie(),
            doc.selfieStatus === "uploaded"
              ? <p className="text-xs italic text-ink-400">Selfie failed to load — try again.</p>
              : <p className="text-xs italic text-ink-400">Live selfie not uploaded yet — the pair can&apos;t be approved without it.</p>)}
        </div>
        {doc.requiresExpiry && (
          <label className="block px-4 pb-2">
            <span className="mb-1 block text-xs font-semibold text-ink-500">Expires on <span className="font-normal text-ink-300">(optional — expired dates flag automatically)</span></span>
            <input
              type="date"
              value={expiryDraft}
              onChange={(e) => setExpiryDraft(e.target.value)}
              className="h-11 w-full max-w-56 rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
        )}
        {error && <div className="px-4 pb-2"><InlineError message={error} /></div>}
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 px-4 py-3">
          {rejecting ? (
            <span className="flex flex-1 flex-wrap items-center gap-2">
              <textarea
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                maxLength={300}
                rows={2}
                placeholder="Reason shown to the contractor, e.g. the license photo is blurry"
                className="h-auto w-full min-w-52 flex-1 rounded-xl border border-ink-200 bg-surface px-3 py-2 text-sm outline-none placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
              <Button size="sm" loading={approving || !rejectNote.trim()} disabled={!rejectNote.trim()} onClick={() => void reject()}>Request reupload</Button>
              <Button size="sm" variant="secondary" disabled={approving} onClick={() => setRejecting(false)}>Cancel</Button>
            </span>
          ) : (
            <>
              <Button loading={approving} disabled={loadingDoc || loadingSelfie || doc.selfieStatus !== "uploaded" || doc.status === "verified"} onClick={() => void approve()}>
                <IdCard className="size-4" aria-hidden="true" /> {doc.status === "verified" ? "Pair already approved" : "Approve pair"}
              </Button>
              <Button variant="secondary" disabled={approving} onClick={() => { setRejecting(true); setError(""); }}>
                Ask to reupload
              </Button>
              <span className="ml-auto text-xs text-ink-400">
                {doc.selfieStatus !== "uploaded" ? "Waiting on the live selfie" : doc.status === "verified" ? "Already verified" : "Ready to approve"}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ schedule editor (owner) ------------------------------ */
type Row = ScheduleDay & { on: boolean };
/** The owner's 7-day template editor (mirrors the driver's /driver/schedule
 *  UI). Save → setContractorSchedule (owner_override=TRUE; driver edits stop
 *  applying until they declare again). */
function ScheduleEditor({ initial, onSave, saving }: {
  initial: ScheduleDay[];
  onSave: (schedule: ScheduleDay[]) => Promise<void>;
  saving: boolean;
}) {
  const map = new Map(initial.map((d) => [d.day, d]));
  const [rows, setRows] = useState<Row[]>(DAY_LABELS.map((_, i) => {
    const day = i + 1;
    const existing = map.get(day);
    return existing ? { ...existing, on: true } : { day, start: "08:00", end: "17:00", on: false };
  }));
  const [error, setError] = useState("");
  const toggle = (day: number) => setRows((prev) => prev.map((r) => (r.day === day ? { ...r, on: !r.on } : r)));
  const setTime = (day: number, key: "start" | "end", value: string) =>
    setRows((prev) => prev.map((r) => (r.day === day ? { ...r, [key]: value } : r)));
  const save = async () => {
    const schedule = rows.filter((r) => r.on);
    for (const r of schedule) {
      if (r.start >= r.end) { setError(`${DAY_LABELS[r.day - 1]}: start must come before the end time.`); return; }
    }
    setError("");
    await onSave(schedule.map(({ day, start, end }) => ({ day, start, end })));
  };
  return (
    <div>
      <Card className="overflow-hidden">
        <p className="border-b border-ink-100 px-4 py-3 text-xs font-bold uppercase tracking-wide text-ink-400">Days they work</p>
        <ul>
          {rows.map((r, i) => (
            <li key={r.day} className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-ink-100" : ""}`}>
              <button
                type="button"
                role="switch"
                aria-checked={r.on}
                aria-label={`${DAY_LABELS[r.day - 1]} available`}
                onClick={() => toggle(r.day)}
                className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${r.on ? "bg-brand-500" : "bg-ink-200"}`}
              >
                <span aria-hidden="true" className={`inline-block size-5 transform rounded-full bg-white shadow transition-transform duration-150 ${r.on ? "translate-x-6" : "translate-x-1"}`} />
              </button>
              <span className={`w-24 shrink-0 text-sm font-semibold ${r.on ? "text-ink-900" : "text-ink-300"}`}>{DAY_LABELS[r.day - 1]}</span>
              <span className={`flex flex-1 items-center gap-2 ${r.on ? "" : "opacity-40"}`}>
                <input type="time" value={r.start} disabled={!r.on} onChange={(e) => setTime(r.day, "start", e.target.value)}
                  aria-label={`${DAY_LABELS[r.day - 1]} start time`}
                  className="h-11 flex-1 rounded-xl border border-ink-200 bg-surface px-2 text-sm tabular-nums text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:opacity-60" />
                <span className="text-xs font-semibold text-ink-400">to</span>
                <input type="time" value={r.end} disabled={!r.on} onChange={(e) => setTime(r.day, "end", e.target.value)}
                  aria-label={`${DAY_LABELS[r.day - 1]} end time`}
                  className="h-11 flex-1 rounded-xl border border-ink-200 bg-surface px-2 text-sm tabular-nums text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:opacity-60" />
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {error && <div className="mt-2"><InlineError message={error} /></div>}
      <Button className="mt-3 w-full" loading={saving} onClick={() => void save()}>
        <Save className="size-4" aria-hidden="true" /> Save schedule
      </Button>
      <p className="mt-2 text-center text-xs text-ink-400">Takes over from the driver — their schedule edits stop applying until they declare again.</p>
    </div>
  );
}

/* ------------------------------ the modal ------------------------------ */
export function ContractorProfileEditor({ contractorId, initialSection = "profile", onClose, onChanged }: {
  contractorId: string;
  initialSection?: EditorSection;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [section, setSection] = useState<EditorSection>(initialSection);
  const [detail, setDetail] = useState<ContractorDetailRow | null>(null);
  const [docs, setDocs] = useState<ContractorDocumentRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [compare, setCompare] = useState<ContractorDocumentRow | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const refresh = async () => {
    const [d, dc] = await Promise.all([
      getContractorDetail({ data: { contractorId } }),
      listContractorDocuments({ data: { contractorId } }),
    ]);
    if (d.ok) { setDetail(d.data); setLoadError(""); } else setLoadError(d.message);
    if (dc.ok) setDocs(dc.data);
    setLoaded(true);
  };
  useEffect(() => { void refresh(); }, [contractorId]);
  const goto = (s: EditorSection) => {
    setSection(s);
    document.getElementById(`cm-sec-${s}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const removed = detail?.removedAt != null;
  const onFileCount = (docs ?? []).filter((d) => d.status === "uploaded" || d.status === "verified").length;
  const missingNames = (docs ?? []).filter((d) => d.status !== "uploaded" && d.status !== "verified").map((d) => d.docTypeName);
  const docsBadge = detail && detail.requiredDocCount > 0
    ? { complete: onFileCount >= detail.requiredDocCount, missing: detail.requiredDocCount - onFileCount }
    : null;
  /* -------- save handlers -------- */
  const saveIdentity = async (name: string, email: string): Promise<{ kind: "ok" | "warn"; text: string }> => {
    const r = await editContractor({ data: { contractorId, name, email } });
    if (!r.ok) throw new Error(r.message);
    await refresh();
    return noticeFor(r.data.towbook);
  };
  const saveContact = async (phone: string, address: string): Promise<void> => {
    const r = await setContractorContact({ data: { contractorId, phone, address } });
    if (!r.ok) throw new Error(r.message);
    setDetail((d) => (d ? { ...d, phone: r.data.phone, address: r.data.address } : d));
    toast("Contact saved — Lightning Dispatch only, not pushed to Towbook");
  };
  const saveVehicle = async (vehicle: ContractorVehicle): Promise<void> => {
    const r = await setContractorVehicle({ data: { contractorId, ...vehicle } });
    if (!r.ok) throw new Error(r.message);
    setDetail((d) => (d ? { ...d, vehicle: r.data.vehicle, vehicleDesc: r.data.vehicleDesc } : d));
    toast("Vehicle saved — Lightning Dispatch only, not pushed to Towbook");
  };
  const saveSchedule = async (schedule: ScheduleDay[]): Promise<void> => {
    const r = await setContractorSchedule({ data: { contractorId, schedule } });
    if (!r.ok) throw new Error(r.message);
    setDetail((d) => (d ? { ...d, schedule: r.data } : d));
    toast("Schedule saved — set by owner, driver edits now stop applying");
  };
  const savePayrate = async (cents: number | null): Promise<void> => {
    const prev = detail;
    setDetail((d) => (d ? { ...d, payrateCents: cents, estEarningsCents: cents != null ? cents * d.completedJobsThisPeriod : null } : d));
    const r = await setContractorPayrate({ data: { contractorId, payrateCents: cents } });
    if (!r.ok) { setDetail(prev); throw new Error(r.message); }
    toast(cents == null ? "Rate removed — payday math won't count it" : `${formatCents(cents)} / job saved — applies to all completed jobs`);
  };
  const actVerify = async (docId: string, expiresOn: string | null) => {
    const r = await setDocumentStatus({ data: { docId, status: "verified" } });
    if (!r.ok) throw new Error(r.message);
    if (expiresOn) {
      const e = await setDocumentExpiry({ data: { docId, expiresOn } });
      if (!e.ok) throw new Error(e.message);
    }
    toast("Document verified");
    await refresh();
  };
  const actReject = async (docId: string, reviewNote: string) => {
    const r = await setDocumentStatus({ data: { docId, status: "rejected", reviewNote } });
    if (!r.ok) throw new Error(r.message);
    toast("Reupload requested — the contractor will see your reason");
    await refresh();
  };
  const actSetExpiry = async (docId: string, expiresOn: string | null) => {
    const r = await setDocumentExpiry({ data: { docId, expiresOn: expiresOn ?? "" } });
    if (!r.ok) throw new Error(r.message);
    toast("Expiry updated");
    await refresh();
  };
  const confirmRemove = async (reason: string) => {
    const r = await removeContractor({ data: { contractorId, reason } });
    if (!r.ok) throw new Error(r.message);
    return noticeFor(r.data.towbook);
  };
  return (
    <div className="fixed inset-0 z-50 bg-ink-950/40" role="dialog" aria-modal="true" aria-label={`Edit ${detail?.name ?? "contractor"}`}>
      <div className="flex h-full w-full flex-col bg-surface sm:inset-x-0 sm:top-[5vh] sm:mx-auto sm:max-h-[90dvh] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-ink-100 sm:shadow-2xl">
        {/* ------- sticky header ------- */}
        <header className="z-10 flex items-center gap-3 border-b border-ink-100 bg-surface px-4 py-3">
          <Avatar name={detail?.name ?? "?"} className="size-10" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-ink-900">{detail ? detail.name : "Loading…"}</p>
            {detail && <ComplianceBadge onFile={onFileCount} required={detail.requiredDocCount} />}
          </div>
          <Button size="sm" variant="secondary" className="!px-2.5" onClick={onClose} aria-label="Close contractor editor">
            <X className="size-4" aria-hidden="true" />
          </Button>
        </header>
        {/* ------- sticky section nav ------- */}
        <nav aria-label="Contractor sections" className="z-10 flex gap-1 overflow-x-auto border-b border-ink-100 bg-surface px-4 py-2">
          {EDITOR_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => goto(s.id)}
              aria-current={section === s.id ? "true" : undefined}
              className={`flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-semibold transition-colors ${section === s.id ? "bg-ink-950 text-white" : "text-ink-500 hover:bg-ink-50 hover:text-ink-700"}`}
            >
              {s.label}
              {s.id === "documents" && docsBadge && (
                <span className={`grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-bold tabular-nums ${docsBadge.complete ? "bg-success-400/80 text-white" : "bg-accent-400 text-white"}`}>
                  {docsBadge.missing > 0 ? docsBadge.missing : "✓"}
                </span>
              )}
            </button>
          ))}
        </nav>
        {/* ------- scrollable body ------- */}
        <div className="flex-1 overflow-y-auto">
          {!loaded && !loadError ? (
            <div className="space-y-4 p-4">
              <SkeletonBlock className="h-24" />
              <SkeletonBlock className="h-40" />
              <SkeletonBlock className="h-64" />
            </div>
          ) : loadError && !detail ? (
            <div className="p-4"><InlineError message={loadError} /><Button variant="secondary" className="mt-3" onClick={() => void refresh()}>Try again</Button></div>
          ) : detail ? (
            <div className="space-y-8 p-4 pb-6">
              {/* ---- compliance overview (top) ---- */}
              <section id="cm-sec-compliance" className="scroll-mt-2">
                <ComplianceCard detail={detail} docs={docs ?? []} onFileCount={onFileCount} missingNames={missingNames} />
              </section>
              {/* ---- profile ---- */}
              <section id="cm-sec-profile" className="scroll-mt-2">
                <ProfileSection detail={detail} removed={removed} onSaved={(n, e) => saveIdentity(n, e)} />
              </section>
              {/* ---- contact ---- */}
              {!removed && (
                <section id="cm-sec-contact" className="scroll-mt-2">
                  <ContactSection detail={detail} onSaved={(p, a) => saveContact(p, a)} />
                </section>
              )}
              {/* ---- vehicle ---- */}
              {!removed && (
                <section id="cm-sec-vehicle" className="scroll-mt-2">
                  <VehicleSection detail={detail} onSaved={(v) => saveVehicle(v)} />
                </section>
              )}
              {/* ---- schedule ---- */}
              {!removed && (
                <section id="cm-sec-schedule" className="scroll-mt-2">
                  <ScheduleSection detail={detail} onSaved={(s) => saveSchedule(s)} />
                </section>
              )}
              {/* ---- documents ---- */}
              {!removed && (
                <section id="cm-sec-documents" className="scroll-mt-2">
                  <DocumentsSection
                    docs={docs}
                    removed={removed}
                    onVerify={actVerify}
                    onReject={actReject}
                    onSetExpiry={actSetExpiry}
                    onCompare={(d) => setCompare(d)}
                  />
                </section>
              )}
              {/* ---- pay ---- */}
              {!removed && (
                <section id="cm-sec-pay" className="scroll-mt-2">
                  <PaySection detail={detail} onSave={(c) => savePayrate(c)} />
                </section>
              )}
              {/* ---- danger ---- */}
              {!removed && (
                <section id="cm-sec-danger" className="scroll-mt-2">
                  <DangerSection name={detail.name} onRemoved={(notice) => { toast(notice.text); onChanged(); onClose(); }} onRemove={confirmRemove} />
                </section>
              )}
              <div className="border-t border-ink-100 pt-4 text-center">
                <Link to="/owner/contractors/$id" params={{ id: contractorId }} className="text-sm font-semibold text-brand-600 hover:underline">
                  View full profile →
                </Link>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {compare && (
        <DocCompareSheet
          doc={compare}
          onApprove={(expiresOn) => actVerify(compare.docId!, expiresOn)}
          onReject={(note) => actReject(compare.docId!, note)}
          onClose={() => setCompare(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------ section cards ------------------------------ */
function SectionCard({ title, caption, action, children }: { title: string; caption?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-5 py-4">
        <div className="min-w-0">
          <p className="text-sm font-bold">{title}</p>
          {caption && <p className="mt-0.5 text-xs text-ink-400">{caption}</p>}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}
function DetailRow({ label, value, mono, sub }: { label: string; value: string; mono?: boolean; sub?: string }) {
  return (
    <div className="px-5 py-3.5">
      <p className="text-[10px] font-bold uppercase tracking-wide text-ink-300">{label}</p>
      <p className={`mt-0.5 truncate text-sm font-semibold text-ink-900 ${mono ? "font-mono tabular-nums" : ""}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-400">{sub}</p>}
    </div>
  );
}
/** Input styling shared by every section form (house style). */
const INPUT_CLS = "h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

/* ------------------------------ compliance overview ------------------------------ */
function ComplianceCard({ detail, docs, onFileCount, missingNames }: {
  detail: ContractorDetailRow; docs: ContractorDocumentRow[]; onFileCount: number; missingNames: string[];
}) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold">Compliance</p>
        <ComplianceBadge onFile={onFileCount} required={detail.requiredDocCount} size="lg" />
      </div>
      <div className="mt-3">
        <ComplianceSummary onFile={onFileCount} required={detail.requiredDocCount} missingNames={missingNames} />
      </div>
      {detail.docsExpiringSoon.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent-200 bg-accent-50 px-3 py-2.5">
          <AlertTriangle className="size-4 shrink-0 text-accent-700" aria-hidden="true" />
          <p className="text-xs text-accent-800">
            <strong>{detail.docsExpiringSoon.length} doc{detail.docsExpiringSoon.length === 1 ? "" : "s"} expire{detail.docsExpiringSoon.length === 1 ? "s" : ""} within 14 days:</strong>{" "}
            {detail.docsExpiringSoon.map((d) => d.docTypeName).join(", ")}
          </p>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------ profile ------------------------------ */
function ProfileSection({ detail, removed, onSaved }: {
  detail: ContractorDetailRow; removed: boolean; onSaved: (name: string, email: string) => Promise<{ kind: "ok" | "warn"; text: string }>;
}) {
  const [name, setName] = useState(detail.name);
  const [email, setEmail] = useState(detail.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(""); setNotice(null);
    try {
      setNotice(await onSaved(name, email));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard title="Profile" caption="Name & email sync to Towbook when it's connected.">
      {removed && <div className="mb-4"><Alert variant="danger">Removed contractor — the record is kept read-only.</Alert></div>}
      <form onSubmit={(e) => void save(e)} className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} className={INPUT_CLS} disabled={removed} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Email <span className="font-normal text-ink-300">(optional)</span></span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" maxLength={200} className={INPUT_CLS} disabled={removed} />
        </label>
        {error && <div className="sm:col-span-2"><InlineError message={error} /></div>}
        {notice && (
          <div className={`rounded-xl border px-4 py-3 text-sm sm:col-span-2 ${notice.kind === "ok" ? "border-success-100 bg-success-50 text-success-700" : "border-accent-200 bg-accent-50 text-accent-800"}`}>
            {notice.text}
          </div>
        )}
        {!removed && <Button type="submit" loading={busy} className="sm:w-auto"><Save className="size-4" aria-hidden="true" /> Save</Button>}
      </form>
      <div className="mt-4 divide-y divide-ink-100 border-t border-ink-100">
        <DetailRow label="Towbook driver ID" mono value={detail.towbookDriverId ?? "—"} sub="Set at import — read-only" />
        <DetailRow label="Login handle" mono value={detail.loginHandle ?? "—"} />
        <DetailRow label="Sign-in status" value={detail.status === "signed_in" ? "Signed in" : "Not signed in yet"} sub={detail.lastActivityAt ? `Last activity ${timeAgo(detail.lastActivityAt)}` : undefined} />
        <DetailRow label="Added" value={detail.createdAt ? timeAgo(detail.createdAt) : "—"} />
      </div>
    </SectionCard>
  );
}

/* ------------------------------ contact ------------------------------ */
function ContactSection({ detail, onSaved }: {
  detail: ContractorDetailRow; onSaved: (phone: string, address: string) => Promise<void>;
}) {
  const [phone, setPhone] = useState(detail.phone ?? "");
  const [address, setAddress] = useState(detail.address ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await onSaved(phone.trim(), address.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard title="Contact" caption="Lightning Dispatch only — not pushed to Towbook.">
      <form onSubmit={(e) => void save(e)} className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Phone</span>
          <div className="relative">
            <Phone className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-300" aria-hidden="true" />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" maxLength={40} placeholder="e.g. (475) 555-0134" className={`${INPUT_CLS} pl-9`} />
          </div>
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Address</span>
          <div className="relative">
            <MapPin className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-300" aria-hidden="true" />
            <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} placeholder="e.g. 55 Central Ave, Bridgeport CT" className={`${INPUT_CLS} pl-9`} />
          </div>
        </label>
        {error && <div className="sm:col-span-2"><InlineError message={error} /></div>}
        <Button type="submit" loading={busy} className="sm:w-auto"><Save className="size-4" aria-hidden="true" /> Save</Button>
      </form>
    </SectionCard>
  );
}

/* ------------------------------ vehicle ------------------------------ */
const VEHICLE_TYPES = ["Flatbed", "Wheel-lift", "Integrated", "Landoll", "Other"] as const;
export function vehicleDisplay(v: ContractorVehicle): string {
  const parts = [
    [v.year, v.make, v.model].filter((x): x is string | number => x != null && String(x).trim() !== "").map((x) => String(x).trim()).join(" "),
    v.type,
    [v.plateState, v.plate].filter((x): x is string => x != null && x.trim() !== "").map((x) => x.trim()).join(" "),
  ].map((s) => (s ?? "").trim()).filter((s) => s !== "");
  return parts.length ? parts.join(" · ") : "";
}
function VehicleSection({ detail, onSaved }: { detail: ContractorDetailRow; onSaved: (v: ContractorVehicle) => Promise<void> }) {
  const v = detail.vehicle;
  const [type, setType] = useState(v.type ?? "");
  const [make, setMake] = useState(v.make ?? "");
  const [model, setModel] = useState(v.model ?? "");
  const [year, setYear] = useState(v.year != null ? String(v.year) : "");
  const [plate, setPlate] = useState(v.plate ?? "");
  const [plateState, setPlateState] = useState(v.plateState ?? "");
  const [color, setColor] = useState(v.color ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    const yearNum = year.trim() === "" ? null : Number(year);
    try {
      await onSaved({
        type: type || null,
        make: make.trim() || null,
        model: model.trim() || null,
        year: yearNum && Number.isFinite(yearNum) ? yearNum : null,
        plate: plate.trim().toUpperCase() || null,
        plateState: plateState.trim().toUpperCase() || null,
        color: color.trim() || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard title="Vehicle" caption="Lightning Dispatch only — structured for dispatch capability routing.">
      <form onSubmit={(e) => void save(e)} className="grid gap-3 sm:grid-cols-3">
        <label className="block sm:col-span-3">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Type <span className="font-normal text-ink-300">(capability)</span></span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={INPUT_CLS}>
            <option value="">— Not set —</option>
            {VEHICLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Make</span>
          <input value={make} onChange={(e) => setMake(e.target.value)} maxLength={60} placeholder="e.g. Ford" className={INPUT_CLS} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Model</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} maxLength={60} placeholder="e.g. F-350" className={INPUT_CLS} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Year</span>
          <input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" maxLength={4} placeholder="e.g. 2019" className={`${INPUT_CLS} tabular-nums`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Plate</span>
          <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} maxLength={20} placeholder="e.g. ABC-123" className={`${INPUT_CLS} uppercase`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Plate state</span>
          <input value={plateState} onChange={(e) => setPlateState(e.target.value.toUpperCase())} maxLength={2} placeholder="e.g. CT" className={`${INPUT_CLS} uppercase`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-500">Color</span>
          <input value={color} onChange={(e) => setColor(e.target.value)} maxLength={30} placeholder="e.g. White" className={INPUT_CLS} />
        </label>
        {error && <div className="sm:col-span-3"><InlineError message={error} /></div>}
        <Button type="submit" loading={busy} className="sm:w-auto"><Save className="size-4" aria-hidden="true" /> Save</Button>
      </form>
    </SectionCard>
  );
}

/* ------------------------------ schedule ------------------------------ */
function ScheduleSection({ detail, onSaved }: { detail: ContractorDetailRow; onSaved: (schedule: ScheduleDay[]) => Promise<void> }) {
  const s = detail.schedule;
  const [editing, setEditing] = useState(s.ownerOverride);
  const [saving, setSaving] = useState(false);
  const summary = scheduleSummary(s.schedule);
  const save = async (schedule: ScheduleDay[]) => {
    setSaving(true);
    try {
      await onSaved(schedule);
      setEditing(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <SectionCard
      title="Availability schedule"
      caption={s.ownerOverride ? "Set by owner — the driver can't change it until they declare again." : "Declared by the contractor — GO/Offline remains the on-demand override."}
      action={!editing ? (
        <Button size="sm" variant="secondary" className="!px-2.5" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" aria-hidden="true" /> Override
        </Button>
      ) : undefined}
    >
      {editing ? (
        <ScheduleEditor initial={s.schedule} onSave={save} saving={saving} />
      ) : (
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
            <CalendarClock className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink-900">{summary ?? "No schedule set — availability isn't limited"}</p>
            <p className="mt-0.5 text-xs text-ink-500">{scheduleSourceLine(s)}</p>
            {s.schedule.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {[...s.schedule].sort((a, b) => a.day - b.day).map((d) => (
                  <li key={d.day} className="text-xs text-ink-600">
                    <span className="inline-block w-24 font-semibold">{DAY_LABELS[d.day - 1]}</span>
                    {fmtTime(d.start)}–{fmtTime(d.end)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/* ------------------------------ documents ------------------------------ */
function DocumentsSection({ docs, removed, onVerify, onReject, onSetExpiry, onCompare }: {
  docs: ContractorDocumentRow[] | null;
  removed: boolean;
  onVerify: (docId: string, expiresOn: string | null) => Promise<void>;
  onReject: (docId: string, reviewNote: string) => Promise<void>;
  onSetExpiry: (docId: string, expiresOn: string | null) => Promise<void>;
  onCompare: (doc: ContractorDocumentRow) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-100 px-5 py-4">
        <p className="text-sm font-bold">Required documents</p>
        <p className="mt-0.5 text-xs text-ink-400">Review each upload — verify, request a reupload, or compare a license with its live selfie.</p>
      </div>
      {docs === null ? (
        <div className="grid place-items-center gap-3 p-10 text-center">
          <Loader2 className="size-5 animate-spin text-brand-500 motion-reduce:animate-none" aria-hidden="true" />
          <p className="text-sm text-ink-400">Loading documents…</p>
        </div>
      ) : docs.length === 0 ? (
        <p className="p-5 text-sm text-ink-500">No required document types yet — add them on the Contractors tab.</p>
      ) : removed ? (
        <p className="p-5 text-sm text-ink-500">Documents are hidden for removed contractors; their files are kept.</p>
      ) : (
        docs.map((doc) => (
          <OwnerDocumentRow
            key={doc.docTypeId}
            doc={doc}
            busy={false}
            onVerify={onVerify}
            onReject={onReject}
            onSetExpiry={onSetExpiry}
            onView={() => Promise.resolve()}
            onViewSelfie={doc.requiresFacialVerification && doc.selfieStatus === "uploaded" ? () => Promise.resolve() : undefined}
            onReviewPair={doc.requiresFacialVerification && doc.selfieStatus === "uploaded" ? () => onCompare(doc) : undefined}
          />
        ))
      )}
    </Card>
  );
}

/* ------------------------------ pay ------------------------------ */
function PaySection({ detail, onSave }: { detail: ContractorDetailRow; onSave: (cents: number | null) => Promise<void> }) {
  return (
    <SectionCard title="Pay rate" caption="Per-job rate — drives payday math: rate × completed jobs + tips.">
      <PayRateField valueCents={detail.payrateCents} size="lg" onSave={onSave} />
      {detail.completedJobsThisPeriod > 0 && (
        <p className="mt-2 rounded-xl bg-brand-50 px-3 py-2.5 text-sm">
          <span className="font-bold tabular-nums text-ink-900">{detail.completedJobsThisPeriod} job{detail.completedJobsThisPeriod === 1 ? "" : "s"} completed</span>{" "}
          <span className="text-ink-600">this pay period · est. </span>
          <span className="font-bold tabular-nums text-brand-700">{detail.estEarningsCents != null ? formatCents(detail.estEarningsCents) : "—"}</span>
        </p>
      )}
    </SectionCard>
  );
}

/* ------------------------------ danger ------------------------------ */
function DangerSection({ name, onRemove, onRemoved }: {
  name: string;
  onRemove: (reason: string) => Promise<{ kind: "ok" | "warn"; text: string }>;
  onRemoved: (notice: { kind: "ok" | "warn"; text: string }) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true); setError("");
    try {
      onRemoved(await onRemove(reason));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove the contractor.");
      setBusy(false);
    }
  };
  return (
    <Card className="border-danger-200 p-5">
      <p className="text-sm font-bold text-danger-800">Danger zone</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-600">
        Removing {name.split(" ")[0]} stops new jobs, revokes their portal access immediately, and disables them in Towbook when
        connected. Their job history, photos and records are <strong>kept</strong>.
      </p>
      {error && <div className="mt-3"><InlineError message={error} /></div>}
      {confirming ? (
        <div className="mt-3 rounded-xl border border-danger-200 bg-danger-50/60 p-4">
          <p className="text-sm font-bold text-danger-800">Remove {name}?</p>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-semibold text-ink-500">Reason <span className="font-normal text-ink-300">(optional, recorded in the audit log)</span></span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Left the company"
              className={INPUT_CLS} />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="danger" loading={busy} onClick={() => void run()}>Remove contractor</Button>
            <Button variant="secondary" disabled={busy} onClick={() => { setConfirming(false); setError(""); setReason(""); }}>Keep them</Button>
          </div>
        </div>
      ) : (
        <Button variant="danger-ghost" className="mt-3" onClick={() => { setConfirming(true); setError(""); }}>
          <Trash2 className="size-4" aria-hidden="true" /> Remove contractor
        </Button>
      )}
    </Card>
  );
}
