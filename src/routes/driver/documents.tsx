import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Bell, Camera, CheckCircle2, ClipboardList, Clock3, Eye, FileText, ImageIcon, Loader2, MapPin, RefreshCw, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { DriverToolbar } from "~/components/driver-queue";
import { InlineError } from "~/components/mutation-status";
import { Button, Card, EmptyState, useToast } from "~/components/ui";
import {
  completeNotificationsLocation,
  getMyCompliance,
  getMyDocuments,
  getSelfieFile,
  getDocumentFile,
  getFormSubmission,
  uploadMyDocument,
  uploadMySelfie,
  submitW9Form,
  submitI9Form,
  type ContractorDocumentRow,
  type DocFilePayload,
  type FormSubmissionView,
  type MyCompliance,
} from "~/data/contractor-admin";
import { driverLogout } from "~/data/driver-auth";
import {
  ensurePushSubscription,
  notificationsSupported,
  pushSetupFailureCopy,
} from "~/lib/push-client";

/**
 * /driver/documents — the contractor's required-paperwork screen (spec §4.5,
 * part 3/3, owner-directed 2026-08-12). Every active required doc type from
 * the org shows with its read-time status (missing / submitted-pending-review /
 * approved / rejected); uploads go to B2 (ld-docs) via camera or file picker
 * (JPG/PNG/WebP/PDF, ≤12 MB, images client-resized ≤1600px). Driver's license
 * with facial verification renders a second "Live selfie" slot — both halves of
 * the pair are required; the owner approves them together.
 *
 * OFFICIAL FILLABLE FORMS (owner-directed 2026-08-12): the W-9 and I-9 required
 * docs are FILLABLE OFFICIAL FORMS — the driver fills the official fields
 * in-app (W9FormSheet / I9FormSheet) instead of uploading a file. The
 * completed-form PDF is generated server-side and is OWNER-ONLY (never shown
 * back to the driver — the SSN/EIN never renders here after submission); the
 * driver sees status only ("Submitted — pending owner review" until the owner
 * approves). White-label copy only — no backend brand ever appears here.
 */
export const Route = createFileRoute("/driver/documents")({ component: DocumentsView });

type DocRow = ContractorDocumentRow;
type Compliance = MyCompliance;

/* ------------------------------ status helpers ------------------------------ */

const STATUS_META: Record<DocRow["status"], { label: string; cls: string; icon: typeof Clock3 }> = {
  missing: { label: "Not uploaded", cls: "bg-ink-100 text-ink-600", icon: Clock3 },
  uploaded: { label: "Submitted — pending owner review", cls: "bg-info-50 text-info-700", icon: Clock3 },
  verified: { label: "Approved ✓", cls: "bg-success-50 text-success-700", icon: CheckCircle2 },
  expired: { label: "Expired — reupload needed", cls: "bg-danger-50 text-danger-700", icon: Clock3 },
  rejected: { label: "Rejected — please fix", cls: "bg-accent-100 text-accent-700", icon: Clock3 },
};

function DocStatusBadge({ status }: { status: DocRow["status"] }) {
  const m = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${m.cls}`}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-80" />
      {m.label}
    </span>
  );
}

/* --------------------------- client-side file handling --------------------------- */

const ACCEPT = "image/*,application/pdf";
const MAX_BYTES = 12 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ""));
    fr.onerror = () => reject(new Error("Couldn't read that file — try again."));
    fr.readAsDataURL(file);
  });
}

/** Images are client-resized to ≤1600px longest edge (spec §5.4); PDFs pass
 *  through. Returns the dataUrl + decoded byte length for the size rails. */
async function fileToUpload(file: File): Promise<{ dataUrl: string; byteLength: number }> {
  const bytesOf = (dataUrl: string) => Math.ceil(((dataUrl.split(",")[1] ?? "").length * 3) / 4);
  if (file.type === "application/pdf") {
    const dataUrl = await readAsDataUrl(file);
    return { dataUrl, byteLength: bytesOf(dataUrl) };
  }
  if (!file.type.startsWith("image/")) throw new Error("Use a JPG, PNG, WebP or PDF file.");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    const dataUrl = await readAsDataUrl(file);
    return { dataUrl, byteLength: bytesOf(dataUrl) };
  }
  const max = 1600;
  let { width, height } = bitmap;
  if (width > max || height > max) {
    const scale = Math.min(max / width, max / height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process the photo — try again.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { dataUrl, byteLength: bytesOf(dataUrl) };
}

const mmddyyyy = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
};
const str = (v: unknown) => (v == null ? "" : String(v));

/* ------------------------------ main screen ------------------------------ */

function DocumentsView() {
  const nav = useNavigate();
  const toast = useToast();
  const [rows, setRows] = useState<DocRow[] | null>(null);
  const [compliance, setCompliance] = useState<Compliance | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<{ docTypeId: string; title: string; requiresExpiry: boolean; isSelfie: boolean } | null>(null);
  const [formSheet, setFormSheet] = useState<{ docTypeId: string; formKind: "w9" | "i9" } | null>(null);
  const [nlSheet, setNlSheet] = useState<{ docTypeId: string; title: string } | null>(null);
  const [viewer, setViewer] = useState<{ title: string; file: DocFilePayload } | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const [d, c] = await Promise.all([getMyDocuments(), getMyCompliance()]);
    if (d.ok) { setRows(d.data); setError(""); } else setError(d.message);
    if (c.ok) setCompliance(c.data);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const signOut = async () => {
    await driverLogout();
    void nav({ to: "/login", replace: true });
  };

  const openViewer = async (row: DocRow, isSelfie: boolean) => {
    setViewerLoading(true);
    setViewer(null);
    const r = isSelfie
      ? await getSelfieFile({ data: { docTypeId: row.docTypeId } })
      : row.docId ? await getDocumentFile({ data: { docId: row.docId } }) : null;
    setViewerLoading(false);
    if (r && r.ok) setViewer({ title: isSelfie ? `${row.docTypeName} — live selfie` : row.docTypeName, file: r.data });
    else if (r && !r.ok) toast(r.message);
  };

  const openUpload = (row: DocRow, isSelfie: boolean) => {
    setSheet({ docTypeId: row.docTypeId, title: row.docTypeName, requiresExpiry: row.requiresExpiry, isSelfie });
  };

  const onUploaded = (msg: string) => {
    toast(msg);
    void load();
  };

  const needed = compliance ? compliance.neededCount : 0;
  const pending = compliance ? compliance.pendingCount : 0;
  const approved = compliance ? compliance.approved : 0;
  const required = compliance ? compliance.required : 0;

  return (
    <AppShell portal="driver" title="Documents" description="Required paperwork — upload once, stay compliant.">
      <DriverToolbar loading={loading} onRefresh={() => void load()} onSignOut={() => void signOut()} />
      {loading && rows === null ? (
        <div className="space-y-3">
          <div className="h-24 animate-pulse rounded-2xl bg-ink-100/70" />
          <div className="h-40 animate-pulse rounded-2xl bg-ink-100/70" />
        </div>
      ) : rows === null ? (
        <Card className="p-4"><InlineError message={error || "Couldn't load your documents."} /></Card>
      ) : rows.length === 0 ? (
        <EmptyState icon={FileText} title="No required documents" body="Your account has no required paperwork right now — check back later." />
      ) : (
        <div className="space-y-4">
          {/* compliance summary */}
          <Card className="p-4">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide tabular-nums ${approved >= required && required > 0 ? "bg-success-50 text-success-700" : "bg-danger-50 text-danger-700"}`}>
                <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-80" />
                {approved}/{required} approved{approved >= required && required > 0 ? " ✓" : ""}
              </span>
            </div>
            {approved < required ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-600">
                {needed > 0 && <><span className="font-semibold text-ink-800">{needed} doc{needed === 1 ? "" : "s"} need{needed === 1 ? "s" : ""} your attention</span> — {compliance?.neededNames.join(", ")}.</>}
                {pending > 0 && <span className="text-ink-500"> {pending} submitted doc{pending === 1 ? "" : "s"} ({compliance?.pendingNames.join(", ")}) await the owner&apos;s review.</span>}
              </p>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-ink-600">All required documents are approved — you&apos;re clear to work.</p>
            )}
          </Card>

          {/* per-type rows */}
          <div className="space-y-3">
            {rows.map((row) => (
              <Card key={row.docTypeId} className="overflow-hidden">
                <div className="p-4 pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-bold text-ink-900">{row.docTypeName}</p>
                      <p className="mt-1"><DocStatusBadge status={row.status} /></p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {row.requiresNotificationsLocation ? (
                        row.status === "verified" ? null : (
                          <Button size="sm" onClick={() => setNlSheet({ docTypeId: row.docTypeId, title: row.docTypeName })}>
                            <Bell className="size-3.5" aria-hidden="true" />
                            {row.status === "missing" || row.status === "expired" ? "Set up now" : "Fix & set up"}
                          </Button>
                        )
                      ) : row.formKind ? (
                        row.status === "verified" ? null : (
                          <Button size="sm" onClick={() => setFormSheet({ docTypeId: row.docTypeId, formKind: row.formKind! })}>
                            <ClipboardList className="size-3.5" aria-hidden="true" />
                            {row.status === "missing" || row.status === "expired" ? "Fill out" : row.status === "rejected" ? "Fix & resubmit" : "Update"}
                          </Button>
                        )
                      ) : row.status === "missing" || row.status === "expired" || row.status === "rejected" ? (
                        <Button size="sm" onClick={() => openUpload(row, false)}><Upload className="size-3.5" aria-hidden="true" /> Upload</Button>
                      ) : row.docId ? (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => void openViewer(row, false)}><Eye className="size-3.5" aria-hidden="true" /> View</Button>
                          <Button size="sm" variant="ghost" onClick={() => openUpload(row, false)}>Replace</Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  {row.reviewNote && row.status === "rejected" && (
                    <p className="mt-2 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2 text-xs text-accent-800">
                      <span className="font-bold">Reason from the owner:</span> {row.reviewNote}
                    </p>
                  )}
                  {row.formKind && row.status === "uploaded" && (
                    <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                      Your completed form is with the owner for review — it&apos;s not shown back to you after submission.
                    </p>
                  )}
                  {row.requiresNotificationsLocation && row.status !== "verified" && (
                    <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                      Required before you can go online: allow notifications (one alert per new job) and share your location
                      so the dispatcher always knows where you are. Two taps — you&apos;ll be done in under a minute.
                    </p>
                  )}
                  {row.requiresNotificationsLocation && row.status === "verified" && (
                    <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                      Alerts are on for this device and your location is being shared. Reopen this screen from a new phone
                      to add it too.
                    </p>
                  )}
                  {row.fileName && (
                    <p className="mt-2 text-[11px] text-ink-400">
                      {row.fileName}{row.expiresOn ? ` · expires ${row.expiresOn}` : ""}{row.uploadedAt ? ` · uploaded ${new Date(row.uploadedAt).toLocaleDateString()}` : ""}
                    </p>
                  )}
                </div>

                {row.requiresFacialVerification && (
                  <div className="border-t border-ink-100 bg-ink-50/50 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-sm font-bold text-ink-900">
                          <ImageIcon className="size-4 text-brand-600" aria-hidden="true" /> Live selfie
                        </p>
                        <p className="mt-1">
                          {row.selfieStatus === "uploaded" ? (
                            <DocStatusBadge status={row.status === "verified" ? "verified" : "uploaded"} />
                          ) : (
                            <DocStatusBadge status="missing" />
                          )}
                        </p>
                        {row.selfieStatus === "uploaded" && row.selfieFileName && (
                          <p className="mt-1 text-[11px] text-ink-400">
                            {row.selfieFileName}{row.selfieUploadedAt ? ` · uploaded ${new Date(row.selfieUploadedAt).toLocaleDateString()}` : ""}
                          </p>
                        )}
                        {row.selfieStatus !== "uploaded" && (
                          <p className="mt-1 text-[11px] leading-relaxed text-ink-500">Required with the {row.docTypeName} — the owner approves the pair together.</p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {row.selfieStatus === "uploaded" ? (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => void openViewer(row, true)}><Eye className="size-3.5" aria-hidden="true" /> View</Button>
                            <Button size="sm" variant="ghost" onClick={() => openUpload(row, true)}>Replace</Button>
                          </>
                        ) : (
                          <Button size="sm" onClick={() => openUpload(row, true)}><Camera className="size-3.5" aria-hidden="true" /> Add selfie</Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* upload sheet — docTypeId injected via the parent state */}
      {sheet && (
        <SheetBridge
          sheet={sheet}
          onClose={() => setSheet(null)}
          onUploaded={onUploaded}
        />
      )}

      {/* fillable official form sheets (W-9 / I-9) */}
      {formSheet && formSheet.formKind === "w9" && (
        <W9FormSheet
          docTypeId={formSheet.docTypeId}
          onClose={() => setFormSheet(null)}
          onSubmitted={onUploaded}
        />
      )}
      {formSheet && formSheet.formKind === "i9" && (
        <I9FormSheet
          docTypeId={formSheet.docTypeId}
          onClose={() => setFormSheet(null)}
          onSubmitted={onUploaded}
        />
      )}

      {/* Notifications & Location self-completed required item (owner 2026-08-13) */}
      {nlSheet && (
        <NotificationsLocationSheet
          title={nlSheet.title}
          onClose={() => setNlSheet(null)}
          onDone={(msg) => { onUploaded(msg); }}
        />
      )}

      {/* viewer modal */}
      {viewerLoading && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/40 p-4" role="status">
          <Loader2 className="size-6 animate-spin text-white motion-reduce:animate-none" aria-hidden="true" />
        </div>
      )}
      {viewer && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/40 p-4" role="dialog" aria-modal="true" aria-label={viewer.title}>
          <div className="w-full max-w-lg rounded-2xl bg-surface p-5 shadow-card">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="break-words text-sm font-bold text-ink-900">{viewer.title}</p>
              <button type="button" onClick={() => setViewer(null)} aria-label="Close" className="grid size-9 place-items-center rounded-full text-ink-400 hover:bg-ink-50">
                <X className="size-5" />
              </button>
            </div>
            {viewer.file.mime.startsWith("image/") ? (
              <img src={`data:${viewer.file.mime};base64,${viewer.file.base64}`} alt={viewer.title} className="max-h-[55vh] w-full rounded-xl border border-ink-100 object-contain" />
            ) : (
              <div className="rounded-xl border border-ink-100 bg-ink-50 p-4 text-center">
                <FileText className="mx-auto mb-2 size-8 text-brand-600" aria-hidden="true" />
                <p className="text-sm font-semibold text-ink-700">{viewer.file.fileName ?? `${viewer.title}.pdf`}</p>
                <a
                  href={`data:${viewer.file.mime};base64,${viewer.file.base64}`}
                  download={viewer.file.fileName ?? `${viewer.title}.pdf`}
                  className="mt-3 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white hover:bg-brand-600"
                >
                  Open PDF
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}

/** UploadSheet wrapper that injects the docTypeId (the sheet component keeps
 *  its local state; the server call needs the parent-selected type id). */
function SheetBridge({
  sheet,
  onClose,
  onUploaded,
}: {
  sheet: { docTypeId: string; title: string; requiresExpiry: boolean; isSelfie: boolean };
  onClose: () => void;
  onUploaded: (msg: string) => void;
}) {
  const [selected, setSelected] = useState<{ file: File; dataUrl: string; byteLength: number } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [expiresOn, setExpiresOn] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  const pick = async (file: File | undefined) => {
    setError("");
    if (!file) return;
    try {
      const { dataUrl, byteLength } = await fileToUpload(file);
      if (byteLength < 1024) throw new Error("The file looks empty — try again.");
      if (byteLength > MAX_BYTES) throw new Error("The file is too large (max 12 MB).");
      setSelected({ file, dataUrl, byteLength });
      setPreview(file.type === "application/pdf" ? null : dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that file — try again.");
    }
  };

  const upload = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const r = sheet.isSelfie
        ? await uploadMySelfie({ data: { docTypeId: sheet.docTypeId, dataUrl: selected.dataUrl, fileName: selected.file.name } })
        : await uploadMyDocument({ data: { docTypeId: sheet.docTypeId, dataUrl: selected.dataUrl, fileName: selected.file.name, expiresOn } });
      if (!r.ok) throw new Error(r.message);
      onUploaded(sheet.isSelfie ? "Live selfie uploaded — the owner reviews the pair together." : `${sheet.title} uploaded — the owner will review it.`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`Upload ${sheet.title}`}>
      <div className="w-full max-w-lg rounded-t-3xl bg-surface p-5 pb-8 shadow-card sm:rounded-3xl">
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-ink-200" aria-hidden="true" />
        <div className="mb-4 flex items-center justify-between gap-2">
          <p className="text-base font-bold text-ink-900">{sheet.isSelfie ? "Add live selfie" : `Add ${sheet.title}`}</p>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-9 place-items-center rounded-full text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-600">
            <X className="size-5" />
          </button>
        </div>
        {sheet.isSelfie && (
          <p className="mb-3 text-xs leading-relaxed text-ink-500">
            Take a live photo of your face — the owner verifies it together with the {sheet.title} document.
          </p>
        )}
        {!selected ? (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-ink-200 p-5 text-ink-600 transition-colors hover:border-brand-400 hover:bg-brand-50/40"
            >
              <Camera className="size-7 text-brand-600" aria-hidden="true" />
              <span className="text-sm font-bold text-ink-800">Take photo</span>
              <span className="text-[11px] text-ink-400">Use your camera</span>
            </button>
            <button
              type="button"
              onClick={() => pickerRef.current?.click()}
              className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-ink-200 p-5 text-ink-600 transition-colors hover:border-brand-400 hover:bg-brand-50/40"
            >
              <FileText className="size-7 text-brand-600" aria-hidden="true" />
              <span className="text-sm font-bold text-ink-800">Choose file</span>
              <span className="text-[11px] text-ink-400">Gallery or PDF</span>
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {preview ? (
              <img src={preview} alt="Selected document preview" className="mx-auto max-h-56 rounded-xl border border-ink-100 object-contain" />
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-ink-100 bg-ink-50 p-3">
                <span className="grid size-10 place-items-center rounded-lg bg-surface text-brand-600 ring-1 ring-ink-100">
                  <FileText className="size-5" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block break-words text-sm font-semibold text-ink-800">{selected.file.name}</span>
                  <span className="block text-xs text-ink-400">PDF</span>
                </span>
              </div>
            )}
            {sheet.requiresExpiry && !sheet.isSelfie && (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-ink-500">Expires on <span className="font-normal text-ink-300">(optional)</span></span>
                <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
              </label>
            )}
            {error && <InlineError message={error} />}
            <div className="flex gap-2">
              <Button className="flex-1" loading={busy} onClick={() => void upload()}>{busy ? "Uploading…" : "Upload"}</Button>
              <Button variant="secondary" disabled={busy} onClick={() => { setSelected(null); setPreview(null); setExpiresOn(""); setError(""); }}>
                <RefreshCw className="size-4" aria-hidden="true" /> Retake
              </Button>
            </div>
          </div>
        )}
        <p className="mt-4 text-center text-[11px] text-ink-400">JPG, PNG or PDF · max 12 MB</p>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={pickerRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
    </div>
  );
}

/* ------------------------------ Notifications & Location (owner 2026-08-13) ------------------------------ */

/** The "Notifications & Location" REQUIRED compliance item. Two steps, both
 *  proven to the SERVER before the item flips to approved:
 *    1. Allow alerts — grants Notification permission and saves a real push
 *       subscription (the fixed push-client flow; failures show the exact
 *       driver-readable reason + retry, never a silent hide).
 *    2. Share location — captures a live browser geolocation fix and POSTs it;
 *       the server stores the ping and verifies the push subscription exists
 *       before marking the doc verified (completeNotificationsLocation).
 *  The SAME compliance gate as W-9/I-9/license/insurance then opens — going
 *  online stays blocked until this item is done.
 *  OS note: the background alert sound is OS-limited (Android Chrome plays one
 *  default sound; iOS Safari ignores custom audio in push). The in-app strike
 *  always plays — it is the reliable path, and it is LOUD (sound.ts).
 */
function NotificationsLocationSheet({ title, onClose, onDone }: { title: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [notifState, setNotifState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [locState, setLocState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [error, setError] = useState("");
  const supported = typeof window !== "undefined" && notificationsSupported();

  const allowNotifications = async () => {
    setError("");
    if (!supported) return setError("This browser can't receive alerts — use a recent Chrome, Safari or Edge.");
    setNotifState("busy");
    try {
      if (Notification.permission !== "granted") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          setNotifState("failed");
          return setError("Notifications are blocked in your browser settings. Turn them on for this site, then tap again.");
        }
      }
      const result = await ensurePushSubscription();
      if (!result.ok) {
        setNotifState("failed");
        return setError(pushSetupFailureCopy(result.reason));
      }
      setNotifState("done");
    } catch {
      setNotifState("failed");
      setError(pushSetupFailureCopy("subscribe_failed"));
    }
  };

  const shareLocation = () => {
    setError("");
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocState("failed");
      return setError("Your browser doesn't support location sharing — use a recent Chrome, Safari or Edge.");
    }
    setLocState("busy");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        if (latitude === 0 && longitude === 0) {
          setLocState("failed");
          return setError("Your location couldn't be read. Allow location for this site in your browser settings, then try again.");
        }
        try {
          const r = await completeNotificationsLocation({ data: { latitude, longitude, accuracy: accuracy ?? null } });
          if (!r.ok) {
            setLocState("failed");
            return setError(r.message);
          }
          setLocState("done");
          onDone("Notifications & location are on — you're all set.");
        } catch {
          setLocState("failed");
          setError("We couldn't finish setting this up — check your connection and try again.");
        }
      },
      () => {
        setLocState("failed");
        setError("We couldn't get your location. Allow location for this site in your browser settings, then tap again.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  };

  return (
    <FormSheetFrame title={`Set up ${title}`} eyebrow="Required before you go online" onClose={onClose}>
      <div className="space-y-4">
        <p className="rounded-xl bg-ink-50 px-3 py-2.5 text-xs leading-relaxed text-ink-600">
          Two quick steps. When you&apos;re done, this item shows <span className="font-bold text-ink-800">Approved ✓</span> and
          nothing else blocks you from working.
        </p>

        <div className="rounded-2xl border border-ink-200 bg-ink-50/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Bell className="size-4" aria-hidden="true" /></span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink-900">1. Allow alerts</p>
                <p className="text-[11px] text-ink-500">One alert + a loud strike per new job</p>
              </div>
            </div>
            {notifState === "done" ? (
              <CheckCircle2 className="size-5 shrink-0 text-success-600" aria-label="Done" />
            ) : (
              <Button size="sm" loading={notifState === "busy"} disabled={locState === "done"} onClick={() => void allowNotifications()}>
                {notifState === "failed" ? "Try again" : "Allow"}
              </Button>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-ink-200 bg-ink-50/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><MapPin className="size-4" aria-hidden="true" /></span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink-900">2. Share your location</p>
                <p className="text-[11px] text-ink-500">So the dispatcher knows where you are</p>
              </div>
            </div>
            {locState === "done" ? (
              <CheckCircle2 className="size-5 shrink-0 text-success-600" aria-label="Done" />
            ) : (
              <Button size="sm" variant={notifState === "done" ? "primary" : "secondary"} loading={locState === "busy"} disabled={notifState !== "done"} onClick={shareLocation}>
                {locState === "failed" ? "Try again" : "Share location"}
              </Button>
            )}
          </div>
        </div>

        {error && <InlineError message={error} />}

        <p className="text-center text-[11px] leading-relaxed text-ink-400">
          On iPhone, alert sounds in the background depend on Apple&apos;s settings; the in-app strike always plays. You can
          turn alerts off anytime from the speaker icon — but this item must stay on to keep working.
        </p>
      </div>
    </FormSheetFrame>
  );
}

/* ------------------------------ shared form-sheet bits ------------------------------ */

function FormSheetFrame({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-3xl bg-surface shadow-card sm:rounded-3xl">
        <div className="mx-auto mt-3 h-1.5 w-10 shrink-0 rounded-full bg-ink-200" aria-hidden="true" />
        <div className="flex shrink-0 items-center justify-between gap-2 px-5 pb-3 pt-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wide text-brand-600">{eyebrow}</p>
            <p className="break-words text-base font-bold text-ink-900">{title}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-9 shrink-0 place-items-center rounded-full text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-600">
            <X className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-ink-500">
        {label} {required ? <span className="text-danger-500">*</span> : <span className="font-normal text-ink-300">(optional)</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-ink-400">{hint}</span>}
    </label>
  );
}

const INPUT_CLS = "h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm text-ink-900 outline-none placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

function RadioPills<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`rounded-xl px-3 py-2 text-xs font-bold transition-colors ${value === o.value ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Load the driver's own previous submission (SSN-free by design) to prefill a
 *  re-opened form. Returns null when nothing is on file. */
async function loadPrefill(docTypeId: string): Promise<FormSubmissionView | null> {
  const r = await getFormSubmission({ data: { docTypeId } });
  return r.ok ? r.data : null;
}

/* ------------------------------ W-9 fillable form sheet ------------------------------ */

const TAX_CLASSES: { value: string; label: string }[] = [
  { value: "individual", label: "Individual / sole proprietor" },
  { value: "llc", label: "LLC" },
  { value: "s_corp", label: "S Corporation" },
  { value: "c_corp", label: "C Corporation" },
  { value: "partnership", label: "Partnership" },
  { value: "trust_estate", label: "Trust / estate" },
  { value: "other", label: "Other" },
];

function W9FormSheet({ docTypeId, onClose, onSubmitted }: { docTypeId: string; onClose: () => void; onSubmitted: (msg: string) => void }) {
  const toast = useToast();
  const [prefilled, setPrefilled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [taxClassification, setTaxClassification] = useState("individual");
  const [llcTaxClass, setLlcTaxClass] = useState("");
  const [otherDescription, setOtherDescription] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [taxIdType, setTaxIdType] = useState<"ssn" | "ein">("ssn");
  const [taxId, setTaxId] = useState("");
  const [signature, setSignature] = useState("");
  const [date, setDate] = useState(mmddyyyy());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadPrefill(docTypeId).then((sub) => {
      if (!alive) return;
      if (sub) {
        const p = sub.payload ?? {};
        setName(str(p.name)); setBusinessName(str(p.businessName)); setTaxClassification(str(p.taxClassification) || "individual");
        setLlcTaxClass(str(p.llcTaxClass)); setOtherDescription(str(p.otherDescription));
        setAddress(str(p.address)); setCity(str(p.city)); setState(str(p.state)); setZip(str(p.zip));
        if (p.taxIdType === "ein" || p.taxIdType === "ssn") setTaxIdType(p.taxIdType);
        setPrefilled(true);
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, [docTypeId]);

  const submit = async () => {
    setError("");
    if (!name.trim()) return setError("Enter the name shown on your tax return.");
    if (!address.trim() || !city.trim() || !state.trim() || !zip.trim()) return setError("Enter your full address.");
    const digits = taxId.replace(/\D/g, "").slice(0, 9);
    if (digits.length !== 9) return setError("Enter the 9-digit SSN or EIN (no dashes).");
    setBusy(true);
    try {
      const r = await submitW9Form({
        data: {
          docTypeId,
          name: name.trim(), businessName: businessName.trim(),
          taxClassification, llcTaxClass, otherDescription: otherDescription.trim(),
          payeeCode: "", exemptionCode: "", fatcaCode: "",
          address: address.trim(), city: city.trim(), state: state.trim().toUpperCase(), zip: zip.trim(),
          accountNumbers: "", requesterName: "", requesterAddress: "",
          taxIdType, taxId: digits, signature: signature.trim(), date,
        },
      });
      if (!r.ok) throw new Error(r.message);
      toast("W-9 submitted — the owner will review it.");
      onSubmitted("W-9 submitted — the owner will review it.");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't submit the W-9 — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormSheetFrame title="Fill out your W-9" eyebrow="IRS Form W-9 · Rev. March 2024" onClose={onClose}>
      {loading ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-5 animate-spin text-brand-500 motion-reduce:animate-none" aria-hidden="true" /></div>
      ) : (
        <div className="space-y-4">
          {prefilled && (
            <p className="rounded-xl border border-info-100 bg-info-50 px-3 py-2.5 text-xs leading-relaxed text-info-700">
              A W-9 is already on file. Your SSN/EIN is never shown back to you — type it again only if it changed.
            </p>
          )}
          <Field label="Name" required>
            <input className={INPUT_CLS} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name as shown on your tax return" autoComplete="name" />
          </Field>
          <Field label="Business name" hint="Only if you're filling this out for a business.">
            <input className={INPUT_CLS} value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Federal tax classification" required>
            <select className={INPUT_CLS} value={taxClassification} onChange={(e) => setTaxClassification(e.target.value)}>
              {TAX_CLASSES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          {taxClassification === "llc" && (
            <Field label="LLC tax classification" required>
              <RadioPills
                options={[
                  { value: "c", label: "C corporation" },
                  { value: "s", label: "S corporation" },
                  { value: "p", label: "Partnership" },
                  { value: "other", label: "Other" },
                ]}
                value={llcTaxClass || "c"}
                onChange={(v) => setLlcTaxClass(v)}
              />
            </Field>
          )}
          {taxClassification === "other" && (
            <Field label="Describe the other classification" required>
              <input className={INPUT_CLS} value={otherDescription} onChange={(e) => setOtherDescription(e.target.value)} placeholder="e.g. Disregarded entity" />
            </Field>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Address" required>
              <input className={INPUT_CLS} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street address" autoComplete="street-address" />
            </Field>
            <Field label="City" required>
              <input className={INPUT_CLS} value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" autoComplete="address-level2" />
            </Field>
            <Field label="State" required>
              <input className={INPUT_CLS} value={state} onChange={(e) => setState(e.target.value.toUpperCase())} maxLength={2} placeholder="CT" autoComplete="address-level1" />
            </Field>
            <Field label="ZIP" required>
              <input className={INPUT_CLS} value={zip} onChange={(e) => setZip(e.target.value)} placeholder="06606" inputMode="numeric" autoComplete="postal-code" />
            </Field>
          </div>
          <div>
            <span className="mb-1 block text-xs font-semibold text-ink-500">Taxpayer ID <span className="text-danger-500">*</span></span>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setTaxIdType("ssn")} aria-pressed={taxIdType === "ssn"} className={`rounded-xl px-3 py-2 text-xs font-bold transition-colors ${taxIdType === "ssn" ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200"}`}>SSN</button>
              <button type="button" onClick={() => setTaxIdType("ein")} aria-pressed={taxIdType === "ein"} className={`rounded-xl px-3 py-2 text-xs font-bold transition-colors ${taxIdType === "ein" ? "bg-brand-500 text-white" : "bg-ink-100 text-ink-600 hover:bg-ink-200"}`}>EIN</button>
            </div>
            <input
              className={`${INPUT_CLS} mt-2 font-mono tabular-nums tracking-widest`}
              value={taxId}
              onChange={(e) => setTaxId(e.target.value.replace(/\D/g, "").slice(0, 9))}
              placeholder={taxIdType === "ssn" ? "123456789" : "123456789"}
              inputMode="numeric"
              autoComplete="off"
              aria-label="Taxpayer ID number"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-ink-400">9 digits, no dashes. Encrypted and visible to the owner only — never shown back to you.</p>
          </div>
          <Field label="Sign (type your full name)" required hint="Typing your name is your signature on the official form.">
            <input className={INPUT_CLS} value={signature} onChange={(e) => setSignature(e.target.value)} autoComplete="name" />
          </Field>
          <Field label="Date" required>
            <input className={INPUT_CLS} value={date} onChange={(e) => setDate(e.target.value)} placeholder="MM/DD/YYYY" />
          </Field>
          {error && <InlineError message={error} />}
          <div className="flex gap-2 pt-1">
            <Button className="flex-1" loading={busy} onClick={() => void submit()}>{busy ? "Submitting…" : "Submit W-9"}</Button>
            <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          </div>
          <p className="text-center text-[11px] leading-relaxed text-ink-400">
            Your completed official W-9 (PDF) is sent to the owner for review. It is not shown back to you after submission.
          </p>
        </div>
      )}
    </FormSheetFrame>
  );
}

/* ------------------------------ I-9 fillable form sheet ------------------------------ */

const CITIZENSHIP_OPTIONS: { value: string; label: string }[] = [
  { value: "citizen", label: "U.S. citizen" },
  { value: "noncitizen_national", label: "Noncitizen national" },
  { value: "lpr", label: "Lawful permanent resident" },
  { value: "noncitizen_authorized", label: "Noncitizen authorized to work" },
];

const LIST_A_TITLES = ["U.S. Passport", "Permanent Resident Card (I-551)", "Foreign passport with I-94", "Employment Authorization Document (I-766)"];
const LIST_B_TITLES = ["Driver's license", "State ID card", "School ID with photo", "Voter registration card", "U.S. Military ID card", "Native American tribal document"];
const LIST_C_TITLES = ["U.S. Social Security Card", "Birth certificate", "Native American tribal document", "U.S. Citizen ID Card (Form I-197)"];

type IdentityDocDraft = {
  list: "A" | "B" | "C";
  title: string;
  issuingAuthority: string;
  number: string;
  expiration: string;
  file: { name: string; dataUrl: string } | null;
};

function IdentityDocField({ doc, onChange, onFileError }: { doc: IdentityDocDraft; onChange: (patch: Partial<IdentityDocDraft>) => void; onFileError: (msg: string) => void }) {
  const pickRef = useRef<HTMLInputElement>(null);
  return (
    <div className="rounded-2xl border border-ink-200 bg-ink-50/40 p-3">
      <p className="mb-2 text-xs font-bold text-ink-800">
        {doc.list === "A" ? "List A — identity & employment authorization" : doc.list === "B" ? "List B — identity" : "List C — employment authorization"}
      </p>
      <div className="space-y-3">
        <Field label="Document title" required>
          <input className={INPUT_CLS} list={`i9-titles-${doc.list}`} value={doc.title} onChange={(e) => onChange({ title: e.target.value })} placeholder={doc.list === "A" ? "U.S. Passport" : doc.list === "B" ? "Driver's license" : "Birth certificate"} />
          <datalist id={`i9-titles-${doc.list}`}>
            {(doc.list === "A" ? LIST_A_TITLES : doc.list === "B" ? LIST_B_TITLES : LIST_C_TITLES).map((t) => <option key={t} value={t} />)}
          </datalist>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Issuing authority" required>
            <input className={INPUT_CLS} value={doc.issuingAuthority} onChange={(e) => onChange({ issuingAuthority: e.target.value })} placeholder="e.g. CT DMV" />
          </Field>
          <Field label="Document number" required>
            <input className={INPUT_CLS} value={doc.number} onChange={(e) => onChange({ number: e.target.value })} />
          </Field>
        </div>
        <Field label="Expiration" hint="Leave blank if the document doesn't expire.">
          <input className={INPUT_CLS} value={doc.expiration} onChange={(e) => onChange({ expiration: e.target.value })} placeholder="MM/DD/YYYY" />
        </Field>
        <div>
          <span className="mb-1 block text-xs font-semibold text-ink-500">Photo or scan of the document <span className="text-danger-500">*</span></span>
          {doc.file ? (
            <div className="flex items-center gap-3 rounded-xl border border-ink-200 bg-surface p-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                <FileText className="size-5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-semibold text-ink-800">{doc.file.name}</span>
                <span className="block text-xs text-ink-400">JPG, PNG, WebP or PDF</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => pickRef.current?.click()}>Change</Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => pickRef.current?.click()}
              className="flex w-full flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-ink-200 bg-surface p-4 text-ink-500 transition-colors hover:border-brand-400 hover:bg-brand-50/40"
            >
              <Upload className="size-5 text-brand-600" aria-hidden="true" />
              <span className="text-xs font-bold text-ink-700">Upload document</span>
            </button>
          )}
          <input
            ref={pickRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              void (async () => {
                try {
                  const { dataUrl, byteLength } = await fileToUpload(f);
                  if (byteLength < 1024) throw new Error("The file looks empty — try again.");
                  if (byteLength > MAX_BYTES) throw new Error("The file is too large (max 12 MB).");
                  onChange({ file: { name: f.name, dataUrl } });
                } catch (err) {
                  onFileError(err instanceof Error ? err.message : "Couldn't read that file — try again.");
                }
              })();
            }}
          />
        </div>
      </div>
    </div>
  );
}

function I9FormSheet({ docTypeId, onClose, onSubmitted }: { docTypeId: string; onClose: () => void; onSubmitted: (msg: string) => void }) {
  const toast = useToast();
  const [prefilled, setPrefilled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [middleInitial, setMiddleInitial] = useState("");
  const [otherNames, setOtherNames] = useState("");
  const [address, setAddress] = useState("");
  const [apt, setApt] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [dob, setDob] = useState("");
  const [ssn, setSsn] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [citizenship, setCitizenship] = useState("citizen");
  const [alienNumber, setAlienNumber] = useState("");
  const [uscisNumber, setUscisNumber] = useState("");
  const [i94Number, setI94Number] = useState("");
  const [i94Expiration, setI94Expiration] = useState("");
  const [signature, setSignature] = useState("");
  const [date, setDate] = useState(mmddyyyy());
  const [mode, setMode] = useState<"A" | "BC">("A");
  const [docsA, setDocsA] = useState<IdentityDocDraft>({ list: "A", title: "", issuingAuthority: "", number: "", expiration: "", file: null });
  const [docsB, setDocsB] = useState<IdentityDocDraft>({ list: "B", title: "", issuingAuthority: "", number: "", expiration: "", file: null });
  const [docsC, setDocsC] = useState<IdentityDocDraft>({ list: "C", title: "", issuingAuthority: "", number: "", expiration: "", file: null });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadPrefill(docTypeId).then((sub) => {
      if (!alive) return;
      if (sub) {
        const p = sub.payload ?? {};
        setLastName(str(p.lastName)); setFirstName(str(p.firstName)); setMiddleInitial(str(p.middleInitial));
        setOtherNames(str(p.otherNames)); setAddress(str(p.address)); setApt(str(p.apt));
        setCity(str(p.city)); setState(str(p.state)); setZip(str(p.zip)); setDob(str(p.dob));
        setEmail(str(p.email)); setPhone(str(p.phone));
        if (typeof p.citizenship === "string" && CITIZENSHIP_OPTIONS.some((c) => c.value === p.citizenship)) setCitizenship(p.citizenship);
        setAlienNumber(str(p.alienNumber)); setUscisNumber(str(p.uscisNumber));
        setI94Number(str(p.i94Number)); setI94Expiration(str(p.i94Expiration));
        const prev = sub.identityDocs ?? [];
        if (prev.length === 2) { setMode("BC"); }
        const fill = (d: IdentityDocDraft, list: "A" | "B" | "C") => {
          const hit = prev.find((x) => x.list === list);
          if (hit) return { ...d, title: str(hit.title), issuingAuthority: str(hit.issuingAuthority), number: str(hit.number), expiration: str(hit.expiration) };
          return d;
        };
        setDocsA((d) => fill(d, "A")); setDocsB((d) => fill(d, "B")); setDocsC((d) => fill(d, "C"));
        setPrefilled(true);
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, [docTypeId]);

  const submit = async () => {
    setError("");
    if (!lastName.trim() || !firstName.trim()) return setError("Enter your legal name.");
    if (!address.trim() || !city.trim() || !state.trim() || !zip.trim()) return setError("Enter your full address.");
    if (!dob.trim()) return setError("Enter your date of birth.");
    if (citizenship === "lpr" && !alienNumber.trim()) return setError("Enter your Alien Registration Number (A-number).");
    if (citizenship === "noncitizen_authorized" && !(alienNumber.trim() || uscisNumber.trim())) return setError("Enter your A-number or USCIS number.");
    if (citizenship === "noncitizen_authorized" && (!i94Number.trim() || !i94Expiration.trim())) return setError("Enter your I-94 number and its expiration.");
    if (!signature.trim()) return setError("Type your name to sign.");
    const identityDocs: { list: "A" | "B" | "C"; title: string; issuingAuthority: string; number: string; expiration: string; dataUrl: string; fileName: string }[] = [];
    const need = (doc: IdentityDocDraft, label: string): string | null => {
      if (!doc.file) return `Attach a file for the ${label} document.`;
      if (!doc.title.trim()) return `Enter the title of the ${label} document.`;
      if (!doc.issuingAuthority.trim()) return `Enter the issuing authority of the ${label} document.`;
      if (!doc.number.trim()) return `Enter the number of the ${label} document.`;
      return null;
    };
    if (mode === "A") {
      const e = need(docsA, "List A");
      if (e) return setError(e);
      identityDocs.push({ list: "A", title: docsA.title.trim(), issuingAuthority: docsA.issuingAuthority.trim(), number: docsA.number.trim(), expiration: docsA.expiration.trim(), dataUrl: docsA.file!.dataUrl, fileName: docsA.file!.name });
    } else {
      const eb = need(docsB, "List B");
      if (eb) return setError(eb);
      const ec = need(docsC, "List C");
      if (ec) return setError(ec);
      identityDocs.push({ list: "B", title: docsB.title.trim(), issuingAuthority: docsB.issuingAuthority.trim(), number: docsB.number.trim(), expiration: docsB.expiration.trim(), dataUrl: docsB.file!.dataUrl, fileName: docsB.file!.name });
      identityDocs.push({ list: "C", title: docsC.title.trim(), issuingAuthority: docsC.issuingAuthority.trim(), number: docsC.number.trim(), expiration: docsC.expiration.trim(), dataUrl: docsC.file!.dataUrl, fileName: docsC.file!.name });
    }
    setBusy(true);
    try {
      const r = await submitI9Form({
        data: {
          docTypeId,
          lastName: lastName.trim(), firstName: firstName.trim(), middleInitial: middleInitial.trim(), otherNames: otherNames.trim(),
          address: address.trim(), apt: apt.trim(), city: city.trim(), state: state.trim().toUpperCase(), zip: zip.trim(),
          dob: dob.trim(), ssn: ssn.replace(/\D/g, "").slice(0, 9), email: email.trim(), phone: phone.trim(),
          citizenship, alienNumber: alienNumber.trim(), uscisNumber: uscisNumber.trim(), i94Number: i94Number.trim(), i94Expiration: i94Expiration.trim(),
          signature: signature.trim(), date,
          identityDocs,
        },
      });
      if (!r.ok) throw new Error(r.message);
      toast("I-9 submitted — the owner will complete Section 2.");
      onSubmitted("I-9 submitted — the owner will complete Section 2.");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't submit the I-9 — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormSheetFrame title="Fill out Form I-9" eyebrow="Form I-9 · Edition 08/01/23" onClose={onClose}>
      {loading ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-5 animate-spin text-brand-500 motion-reduce:animate-none" aria-hidden="true" /></div>
      ) : (
        <div className="space-y-4">
          <p className="rounded-xl bg-ink-50 px-3 py-2.5 text-xs leading-relaxed text-ink-600">
            <span className="font-bold text-ink-800">Section 1 — employee information.</span> You fill this in; the owner completes Section 2 after reviewing your documents.
          </p>
          {prefilled && (
            <p className="rounded-xl border border-info-100 bg-info-50 px-3 py-2.5 text-xs leading-relaxed text-info-700">
              An I-9 is already on file. Your SSN is never shown back to you — re-enter it only if it changed.
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Last name" required>
              <input className={INPUT_CLS} value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
            </Field>
            <Field label="First name" required>
              <input className={INPUT_CLS} value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
            </Field>
            <Field label="Middle initial">
              <input className={INPUT_CLS} value={middleInitial} onChange={(e) => setMiddleInitial(e.target.value.slice(0, 1))} maxLength={1} />
            </Field>
          </div>
          <Field label="Other last names used">
            <input className={INPUT_CLS} value={otherNames} onChange={(e) => setOtherNames(e.target.value)} placeholder="Maiden name, former name, etc." />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Street address" required>
              <input className={INPUT_CLS} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" />
            </Field>
            <Field label="Apt. / suite">
              <input className={INPUT_CLS} value={apt} onChange={(e) => setApt(e.target.value)} />
            </Field>
            <Field label="City" required>
              <input className={INPUT_CLS} value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="State" required>
                <input className={INPUT_CLS} value={state} onChange={(e) => setState(e.target.value.toUpperCase())} maxLength={2} placeholder="CT" autoComplete="address-level1" />
              </Field>
              <Field label="ZIP" required>
                <input className={INPUT_CLS} value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" autoComplete="postal-code" />
              </Field>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Date of birth" required>
              <input className={INPUT_CLS} value={dob} onChange={(e) => setDob(e.target.value)} placeholder="MM/DD/YYYY" />
            </Field>
            <Field label="SSN" hint="Optional for Section 1 — encrypted at rest, owner-only.">
              <input className={`${INPUT_CLS} font-mono tabular-nums tracking-widest`} value={ssn} onChange={(e) => setSsn(e.target.value.replace(/\D/g, "").slice(0, 9))} inputMode="numeric" autoComplete="off" placeholder="9 digits, no dashes" />
            </Field>
            <Field label="Email">
              <input className={INPUT_CLS} value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" />
            </Field>
            <Field label="Phone">
              <input className={INPUT_CLS} value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" autoComplete="tel" />
            </Field>
          </div>
          <div>
            <span className="mb-1 block text-xs font-semibold text-ink-500">Citizenship status <span className="text-danger-500">*</span></span>
            <RadioPills options={CITIZENSHIP_OPTIONS} value={citizenship} onChange={(v) => setCitizenship(v)} />
          </div>
          {citizenship === "lpr" && (
            <Field label="Alien Registration Number (A-number)" required hint="Format A-000-000-000 or 000-000-000.">
              <input className={`${INPUT_CLS} font-mono`} value={alienNumber} onChange={(e) => setAlienNumber(e.target.value)} placeholder="A-number" />
            </Field>
          )}
          {citizenship === "noncitizen_authorized" && (
            <div className="space-y-3 rounded-2xl border border-ink-200 bg-ink-50/40 p-3">
              <Field label="Alien Registration Number (A-number)" hint="Provide the A-number or the USCIS number below.">
                <input className={`${INPUT_CLS} font-mono`} value={alienNumber} onChange={(e) => setAlienNumber(e.target.value)} placeholder="A-number" />
              </Field>
              <Field label="USCIS number" hint="I-94 admission number, if you don't have an A-number.">
                <input className={`${INPUT_CLS} font-mono`} value={uscisNumber} onChange={(e) => setUscisNumber(e.target.value)} placeholder="USCIS number" />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="I-94 number" required>
                  <input className={`${INPUT_CLS} font-mono`} value={i94Number} onChange={(e) => setI94Number(e.target.value)} placeholder="I-94 number" />
                </Field>
                <Field label="I-94 expiration" required>
                  <input className={INPUT_CLS} value={i94Expiration} onChange={(e) => setI94Expiration(e.target.value)} placeholder="MM/DD/YYYY" />
                </Field>
              </div>
            </div>
          )}
          <div>
            <span className="mb-1 block text-xs font-semibold text-ink-500">Identity documents <span className="text-danger-500">*</span></span>
            <p className="mb-2 text-[11px] leading-relaxed text-ink-400">
              Choose <strong>one List A document</strong> (proves identity and work authorization), or <strong>one List B plus one List C</strong> document.
            </p>
            <RadioPills
              options={[
                { value: "A", label: "One List A document" },
                { value: "BC", label: "List B + List C" },
              ]}
              value={mode}
              onChange={(v) => setMode(v)}
            />
          </div>
          <div className="space-y-3">
            {mode === "A" ? <IdentityDocField doc={docsA} onChange={(patch) => setDocsA((d) => ({ ...d, ...patch }))} onFileError={(m) => setError(m)} />
              : (
                <>
                  <IdentityDocField doc={docsB} onChange={(patch) => setDocsB((d) => ({ ...d, ...patch }))} onFileError={(m) => setError(m)} />
                  <IdentityDocField doc={docsC} onChange={(patch) => setDocsC((d) => ({ ...d, ...patch }))} onFileError={(m) => setError(m)} />
                </>
              )}
          </div>
          <Field label="Sign (type your full name)" required hint="Typing your name is your signature on Section 1.">
            <input className={INPUT_CLS} value={signature} onChange={(e) => setSignature(e.target.value)} autoComplete="name" />
          </Field>
          <Field label="Date" required>
            <input className={INPUT_CLS} value={date} onChange={(e) => setDate(e.target.value)} placeholder="MM/DD/YYYY" />
          </Field>
          {error && <InlineError message={error} />}
          <div className="flex gap-2 pt-1">
            <Button className="flex-1" loading={busy} onClick={() => void submit()}>{busy ? "Submitting…" : "Submit I-9"}</Button>
            <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          </div>
          <p className="text-center text-[11px] leading-relaxed text-ink-400">
            Your completed official I-9 (PDF) goes to the owner, who completes Section 2. It is not shown back to you after submission.
          </p>
        </div>
      )}
    </FormSheetFrame>
  );
}
