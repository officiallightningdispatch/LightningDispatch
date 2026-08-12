import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CalendarClock, FileText, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AppShell } from "~/components/app-shell";
import {
  ComplianceBadge,
  ComplianceSummary,
  OwnerDocumentRow,
  PayRateField,
  formatCents,
} from "~/components/contractor-admin";
import {
  ContractorProfileEditor,
  DocCompareSheet,
  ExpiryChip,
  scheduleSourceLine,
  scheduleSummary,
  vehicleDisplay,
  type EditorSection,
} from "~/components/contractor-profile-editor";
import { InlineError } from "~/components/mutation-status";
import { Alert, Avatar, Button, Card, EmptyState, StatusBadge, useToast } from "~/components/ui";
import {
  removeContractor,
  type TowbookPushOutcome,
} from "~/data/contractor-management";
import {
  getContractorDetail,
  getDocumentFile,
  getSelfieFile,
  listContractorDocuments,
  setContractorPayrate,
  setDocumentExpiry,
  setDocumentStatus,
  type ContractorDetailRow,
  type ContractorDocumentRow,
  type DocFilePayload,
} from "~/data/contractor-admin";
import { timeAgo } from "~/lib/job-ui";
export const Route = createFileRoute("/owner/contractors/$id")({ component: OwnerContractorDetail });
const DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** Owner contractor detail — the READ/review record (Contractor Management v2):
 *  identity card with an "Edit contractor" entry into the full-screen
 *  ContractorProfileEditor, extended details (phone/vehicle/address are
 *  Lightning-Dispatch-only — never pushed to Towbook), a read-only schedule
 *  card, payrate with est. earnings, the per-contractor Documents section
 *  (verify / reject / expiry + license↔selfie DocCompareSheet), and the danger
 *  zone. Every section's Edit affordance opens the modal at that section —
 *  the modal is the single EDIT surface. Real data only. */
function OwnerContractorDetail() {
  const { id } = useParams({ from: "/owner/contractors/$id" });
  const toast = useToast();
  const [detail, setDetail] = useState<ContractorDetailRow | null>(null);
  const [detailError, setDetailError] = useState("");
  const [docs, setDocs] = useState<ContractorDocumentRow[] | null>(null);
  const [docsError, setDocsError] = useState("");
  const [loaded, setLoaded] = useState(false);
  /* Contractor Management v2: the profile editor + compare sheet */
  const [editing, setEditing] = useState<EditorSection | null>(null);
  const [compare, setCompare] = useState<ContractorDocumentRow | null>(null);
  /* remove */
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [reason, setReason] = useState("");
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [removeNotice, setRemoveNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  /* document viewer */
  const [viewer, setViewer] = useState<{ doc: ContractorDocumentRow; file: DocFilePayload | null; loading: boolean; error?: string; titleOverride?: string } | null>(null);
  const refresh = async () => {
    const [d, dc] = await Promise.all([
      getContractorDetail({ data: { contractorId: id } }),
      listContractorDocuments({ data: { contractorId: id } }),
    ]);
    if (d.ok) { setDetail(d.data); setDetailError(""); } else setDetailError(d.message);
    if (dc.ok) { setDocs(dc.data); setDocsError(""); } else setDocsError(dc.message);
    setLoaded(true);
  };
  useEffect(() => { void refresh(); }, [id]);
  const removed = detail?.removedAt != null;
  const noticeFor = (t: TowbookPushOutcome): { kind: "ok" | "warn"; text: string } => {
    if (t.status === "verified") return { kind: "ok", text: t.notice };
    if (t.status === "skipped" || t.status === "unsupported") return { kind: "warn", text: t.notice };
    return { kind: "warn", text: t.notice + " This was escalated to the ops queue for review." };
  };
  /* --------------------------------- payrate --------------------------------- */
  const savePayrate = async (cents: number | null) => {
    const prev = detail;
    setDetail((d) => (d ? { ...d, payrateCents: cents, estEarningsCents: cents != null ? cents * d.completedJobsThisPeriod : null } : d));
    const r = await setContractorPayrate({ data: { contractorId: id, payrateCents: cents } });
    if (!r.ok) { setDetail(prev); throw new Error(r.message); }
    toast(cents == null ? "Rate removed — payday math won't count it" : `${formatCents(cents)} / job saved — applies to all completed jobs`);
  };
  /* ------------------------------- documents ------------------------------- */
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
  const openViewer = async (doc: ContractorDocumentRow) => {
    if (!doc.docId) return;
    setViewer({ doc, file: null, loading: true });
    const r = await getDocumentFile({ data: { docId: doc.docId } });
    if (!r.ok) setViewer({ doc, file: null, loading: false, error: r.message });
    else setViewer({ doc, file: r.data, loading: false });
  };
  const openSelfieViewer = async (doc: ContractorDocumentRow) => {
    setViewer({ doc, file: null, loading: true, titleOverride: `${doc.docTypeName} — live selfie` });
    const r = await getSelfieFile({ data: { docTypeId: doc.docTypeId } });
    if (!r.ok) setViewer({ doc, file: null, loading: false, error: r.message, titleOverride: `${doc.docTypeName} — live selfie` });
    else setViewer({ doc, file: r.data, loading: false, titleOverride: `${doc.docTypeName} — live selfie` });
  };
  /* -------------------------------- danger zone -------------------------------- */
  const confirmRemove = async () => {
    setRemoving(true); setRemoveError(""); setRemoveNotice(null);
    const r = await removeContractor({ data: { contractorId: id, reason } });
    setRemoving(false);
    if (r.ok) {
      setRemoveNotice(noticeFor(r.data.towbook));
      setConfirmingRemove(false);
      setReason("");
      void refresh();
    } else setRemoveError(r.message);
  };
  const missingNames = (docs ?? [])
    .filter((d) => d.status !== "uploaded" && d.status !== "verified")
    .map((d) => d.docTypeName);
  const onFileCount = (docs ?? []).filter((d) => d.status === "uploaded" || d.status === "verified").length;
  return (
    <AppShell
      portal="owner"
      title={detail ? detail.name : "Contractor"}
      description="Contractor account details — payrate, documents and access. Phone and vehicle are Lightning Dispatch only."
    >
      <div className="mb-5">
        <Link to="/owner/contractors" className="inline-flex h-9 items-center gap-1.5 text-sm font-semibold text-ink-500 transition-colors hover:text-ink-700">
          <ArrowLeft className="size-4" aria-hidden="true" /> Contractors
        </Link>
      </div>
      {!loaded ? (
        <Card className="grid place-items-center gap-3 p-10 text-center">
          <Loader2 className="size-5 animate-spin text-brand-500 motion-reduce:animate-none" aria-hidden="true" />
          <p className="text-sm text-ink-400">Loading contractor…</p>
        </Card>
      ) : !detail ? (
        <EmptyState
          icon={FileText}
          title={detailError || "Contractor not found"}
          body="They may have been removed from this account. Back to the roster to see who's on it."
          action={
            <Link to="/owner/contractors">
              <Button>Back to Contractors</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            {/* ------------------------------ identity card ------------------------------ */}
            <Card className="p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-bold uppercase tracking-wider text-ink-400">Contractor</p>
                {!removed && (
                  <Button size="sm" onClick={() => setEditing("profile")}>
                    <Pencil className="size-3.5" aria-hidden="true" /> Edit contractor
                  </Button>
                )}
              </div>
              <div className="mt-3 flex items-center gap-4">
                <Avatar name={detail.name} className="size-14 text-lg" />
                <div className="min-w-0 flex-1">
                  <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-bold ${removed ? "text-ink-400 line-through decoration-ink-300" : ""}`}>
                    {detail.name}
                    {removed ? (
                      <StatusBadge dot className="bg-ink-200 text-ink-600">Removed {timeAgo(detail.removedAt ?? undefined)}</StatusBadge>
                    ) : (
                      <StatusBadge dot className={detail.status === "signed_in" ? "bg-success-50 text-success-700" : "bg-ink-100 text-ink-500"}>
                        {detail.status === "signed_in" ? "Signed in" : "Not signed in yet"}
                      </StatusBadge>
                    )}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-ink-500">
                    {detail.email}
                    {detail.loginHandle ? ` · handle ${detail.loginHandle}` : ""}
                  </p>
                  {!removed && (
                    <p className="mt-2 flex flex-wrap items-center gap-2">
                      <ComplianceBadge onFile={onFileCount} required={detail.requiredDocCount} size="lg" />
                      {detail.docsExpiringSoon.length > 0 && <ExpiryChip expiresOn={detail.docsExpiringSoon[0].expiresOn} />}
                    </p>
                  )}
                </div>
              </div>
              {!removed && <div className="mt-3"><ComplianceSummary onFile={onFileCount} required={detail.requiredDocCount} missingNames={missingNames} /></div>}
              {removed && (
                <div className="mt-3">
                  <Alert variant="danger">
                    Removed {detail.removedAt ? timeAgo(detail.removedAt) : ""} — they can&apos;t sign in or receive jobs. Their job history and records are kept.
                  </Alert>
                </div>
              )}
            </Card>
            {/* ------------------------------ details card ------------------------------ */}
            {!removed && (
              <Card className="overflow-hidden">
                <div className="border-b border-ink-100 px-5 py-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold">Details</p>
                    <Button size="sm" variant="secondary" className="!px-2.5" onClick={() => setEditing("contact")}>
                      <Pencil className="size-3.5" aria-hidden="true" /> Edit
                    </Button>
                  </div>
                </div>
                <div className="divide-y divide-ink-100">
                  <DetailRow label="Name" value={detail.name} />
                  <DetailRow label="Email" value={detail.email} />
                  <DetailRow label="Phone" value={detail.phone ?? "—"} sub="Lightning Dispatch only — not pushed to Towbook" />
                  <DetailRow label="Address" value={detail.address ?? "—"} sub="Lightning Dispatch only — not pushed to Towbook" />
                  <DetailRow
                    label="Vehicle"
                    value={vehicleDisplay(detail.vehicle) || detail.vehicleDesc || "—"}
                    sub="Structured — Lightning Dispatch only, not pushed to Towbook"
                    action={<button type="button" title="Edit vehicle" aria-label="Edit vehicle" onClick={() => setEditing("vehicle")} className="grid size-8 place-items-center rounded-lg text-ink-300 transition-colors hover:bg-ink-50 hover:text-ink-600"><Pencil className="size-3.5" aria-hidden="true" /></button>}
                  />
                  <DetailRow label="Towbook driver ID" mono value={detail.towbookDriverId ?? "—"} sub="Set at import — read-only (re-linking is out of scope)" />
                </div>
              </Card>
            )}
            {/* ------------------------------ schedule card ------------------------------ */}
            {!removed && (
              <Card className="p-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold">Availability schedule</p>
                  <Button size="sm" variant="secondary" className="!px-2.5" onClick={() => setEditing("schedule")}>
                    <Pencil className="size-3.5" aria-hidden="true" /> Edit
                  </Button>
                </div>
                <div className="mt-3 flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                    <CalendarClock className="size-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-900">{scheduleSummary(detail.schedule.schedule) ?? "No schedule set — availability isn't limited"}</p>
                    <p className="mt-0.5 text-xs text-ink-500">{scheduleSourceLine(detail.schedule)}</p>
                    {detail.schedule.schedule.length > 0 && (
                      <ul className="mt-2 space-y-0.5">
                        {[...detail.schedule.schedule].sort((a, b) => a.day - b.day).map((d) => (
                          <li key={d.day} className="text-xs text-ink-600">
                            <span className="inline-block w-24 font-semibold">{DAY_LABELS[d.day - 1]}</span>
                            {d.start}–{d.end}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </Card>
            )}
            {/* ------------------------------ payrate card ------------------------------ */}
            {!removed && (
              <Card className="p-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold">Pay rate</p>
                  <Button size="sm" variant="secondary" className="!px-2.5" onClick={() => setEditing("pay")}>
                    <Pencil className="size-3.5" aria-hidden="true" /> Edit
                  </Button>
                </div>
                <div className="mt-3">
                  <PayRateField valueCents={detail.payrateCents} size="lg" onSave={savePayrate} />
                </div>
                <p className="mt-2 text-xs text-ink-500">Drives payday math: <strong className="text-ink-700">payrate × completed jobs + tips</strong>.</p>
                {detail.completedJobsThisPeriod > 0 && (
                  <p className="mt-2 rounded-xl bg-brand-50 px-3 py-2.5 text-sm">
                    <span className="font-bold tabular-nums text-ink-900">{detail.completedJobsThisPeriod} job{detail.completedJobsThisPeriod === 1 ? "" : "s"} completed</span>{" "}
                    <span className="text-ink-600">this pay period · est. </span>
                    <span className="font-bold tabular-nums text-brand-700">{detail.estEarningsCents != null ? formatCents(detail.estEarningsCents) : "—"}</span>
                  </p>
                )}
              </Card>
            )}
          </div>
          <div className="space-y-6">
            {/* ------------------------------ documents card ------------------------------ */}
            <Card className="overflow-hidden">
              <div className="border-b border-ink-100 px-5 py-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold">Required documents</p>
                  {!removed && (
                    <Button size="sm" variant="secondary" className="!px-2.5" onClick={() => setEditing("documents")}>
                      <Pencil className="size-3.5" aria-hidden="true" /> Review
                    </Button>
                  )}
                </div>
                {!removed && <div className="mt-1"><ComplianceSummary onFile={onFileCount} required={detail.requiredDocCount} missingNames={missingNames} /></div>}
              </div>
              {docsError ? (
                <div className="p-4"><InlineError message={docsError} /></div>
              ) : docs === null ? (
                <div className="grid place-items-center gap-3 p-10 text-center">
                  <Loader2 className="size-5 animate-spin text-brand-500 motion-reduce:animate-none" aria-hidden="true" />
                  <p className="text-sm text-ink-400">Loading documents…</p>
                </div>
              ) : docs.length === 0 ? (
                <div className="p-5">
                  <p className="text-sm text-ink-500">No required document types yet — add them on the <Link to="/owner/contractors" className="font-semibold text-brand-600 hover:underline">Contractors</Link> tab.</p>
                </div>
              ) : removed ? (
                <div className="p-5">
                  <p className="text-sm text-ink-500">Documents are hidden for removed contractors; their files are kept.</p>
                </div>
              ) : (
                docs.map((doc) => (
                  <OwnerDocumentRow
                    key={doc.docTypeId}
                    doc={doc}
                    busy={removing}
                    onVerify={actVerify}
                    onReject={actReject}
                    onSetExpiry={actSetExpiry}
                    onView={() => openViewer(doc)}
                    onViewSelfie={doc.requiresFacialVerification && doc.selfieStatus === "uploaded" ? () => openSelfieViewer(doc) : undefined}
                    onReviewPair={doc.requiresFacialVerification && doc.selfieStatus === "uploaded" ? () => setCompare(doc) : undefined}
                  />
                ))
              )}
            </Card>
            {/* ------------------------------ danger zone ------------------------------ */}
            {!removed && (
              <Card className="border-danger-200 p-5">
                <p className="text-sm font-bold text-danger-800">Danger zone</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-600">
                  Removing {detail.name.split(" ")[0]} stops new jobs, revokes their portal access immediately, and disables them in
                  Towbook when connected. Their job history, photos and records are <strong>kept</strong>.
                </p>
                {removeNotice && (
                  <div className={`mt-3 rounded-xl border px-4 py-3 text-sm ${removeNotice.kind === "ok" ? "border-success-100 bg-success-50 text-success-700" : "border-accent-200 bg-accent-50 text-accent-800"}`}>
                    {removeNotice.text}
                  </div>
                )}
                {removeError && <div className="mt-3"><InlineError message={removeError} /></div>}
                {confirmingRemove ? (
                  <div className="mt-3 rounded-xl border border-danger-200 bg-danger-50/60 p-4">
                    <p className="text-sm font-bold text-danger-800">Remove {detail.name}?</p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-600">
                      They will <strong>stop receiving new jobs</strong> and lose portal access immediately (their session is revoked).
                      Their job history, photos and records are <strong>kept</strong>.
                    </p>
                    <label className="mt-3 block">
                      <span className="mb-1 block text-xs font-semibold text-ink-500">Reason <span className="font-normal text-ink-300">(optional, recorded in the audit log)</span></span>
                      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Left the company"
                        className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none placeholder:text-ink-300 focus:border-danger-500 focus:ring-2 focus:ring-danger-100" />
                    </label>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="danger" loading={removing} onClick={() => void confirmRemove()}>Remove contractor</Button>
                      <Button variant="secondary" disabled={removing} onClick={() => { setConfirmingRemove(false); setRemoveError(""); setRemoveNotice(null); setReason(""); }}>Keep them</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="danger-ghost" className="mt-3" onClick={() => { setConfirmingRemove(true); setRemoveError(""); setRemoveNotice(null); }}>
                    <Trash2 className="size-4" aria-hidden="true" /> Remove contractor
                  </Button>
                )}
              </Card>
            )}
          </div>
        </div>
      )}
      {/* ------------------------------ document viewer ------------------------------ */}
      {viewer && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/40 p-4" role="dialog" aria-modal="true" aria-label={`View ${viewer.titleOverride ?? viewer.doc.docTypeName}`}>
          <div className="w-full max-w-lg rounded-2xl bg-surface p-5 shadow-card-hover">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{viewer.titleOverride ?? viewer.doc.docTypeName}</p>
                <p className="text-xs text-ink-400">{viewer.file?.fileName ?? viewer.doc.fileName ?? ""}</p>
              </div>
              <button type="button" onClick={() => setViewer(null)} aria-label="Close document" className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-500 hover:bg-ink-50 hover:text-ink-700">
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            {viewer.loading ? (
              <div className="grid h-48 place-items-center">
                <Loader2 className="size-5 animate-spin text-brand-500 motion-reduce:animate-none" aria-hidden="true" />
              </div>
            ) : viewer.error ? (
              <InlineError message={viewer.error} />
            ) : viewer.file ? (
              viewer.file.mime.startsWith("image/") ? (
                <img src={`data:${viewer.file.mime};base64,${viewer.file.base64}`} alt={viewer.titleOverride ?? viewer.doc.docTypeName} className="max-h-[55vh] w-full rounded-xl border border-ink-100 object-contain" />
              ) : (
                <div className="grid gap-3 rounded-xl border border-ink-100 bg-ink-50/50 p-6 text-center">
                  <FileText className="mx-auto size-8 text-ink-400" aria-hidden="true" />
                  <p className="text-sm text-ink-600">This document is a PDF — open it to view.</p>
                  <a
                    href={`data:${viewer.file.mime};base64,${viewer.file.base64}`}
                    download={viewer.file.fileName ?? `${viewer.doc.docTypeName}.pdf`}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white hover:bg-brand-600"
                  >
                    Open PDF
                  </a>
                </div>
              )
            ) : null}
          </div>
        </div>
      )}
      {/* ------------------------------ profile editor + compare sheet ------------------------------ */}
      {editing && (
        <ContractorProfileEditor
          contractorId={id}
          initialSection={editing}
          onClose={() => setEditing(null)}
          onChanged={() => void refresh()}
        />
      )}
      {compare && (
        <DocCompareSheet
          doc={compare}
          onApprove={(expiresOn) => actVerify(compare.docId!, expiresOn)}
          onReject={(note) => actReject(compare.docId!, note)}
          onClose={() => setCompare(null)}
        />
      )}
    </AppShell>
  );
}
/* ------------------------------ small display helpers ------------------------------ */
function DetailRow({ label, value, mono, sub, action }: { label: string; value: string; mono?: boolean; sub?: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-wide text-ink-300">{label}</p>
        <p className={`mt-0.5 truncate text-sm font-semibold text-ink-900 ${mono ? "font-mono tabular-nums" : ""}`}>{value}</p>
        {sub && <p className="mt-0.5 text-xs text-ink-400">{sub}</p>}
      </div>
      {action}
    </div>
  );
}
