import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Camera, CheckCircle2, Clock3, Eye, FileText, ImageIcon, Loader2, RefreshCw, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { DriverToolbar } from "~/components/driver-queue";
import { InlineError } from "~/components/mutation-status";
import { Button, Card, EmptyState, useToast } from "~/components/ui";
import {
  getMyCompliance,
  getMyDocuments,
  getSelfieFile,
  getDocumentFile,
  uploadMyDocument,
  uploadMySelfie,
  type ContractorDocumentRow,
  type DocFilePayload,
  type MyCompliance,
} from "~/data/contractor-admin";
import { driverLogout } from "~/data/driver-auth";

/**
 * /driver/documents — the contractor's required-paperwork screen (spec §4.5,
 * part 3/3, owner-directed 2026-08-12). Every active required doc type from
 * the org shows with its read-time status (missing / submitted-pending-review /
 * approved / rejected); uploads go to B2 (ld-docs) via camera or file picker
 * (JPG/PNG/WebP/PDF, ≤12 MB, images client-resized ≤1600px). Driver's license
 * with facial verification renders a second "Live selfie" slot — both halves of
 * the pair are required; the owner approves them together. White-label copy
 * only — no backend brand ever appears here.
 */
export const Route = createFileRoute("/driver/documents")({ component: DocumentsView });

type DocRow = ContractorDocumentRow;
type Compliance = MyCompliance;

/* ------------------------------ status helpers ------------------------------ */

const STATUS_META: Record<DocRow["status"], { label: string; cls: string; icon: typeof Clock3 }> = {
  missing: { label: "Not uploaded", cls: "bg-ink-100 text-ink-600", icon: Clock3 },
  uploaded: { label: "Submitted — awaiting review", cls: "bg-info-50 text-info-700", icon: Clock3 },
  verified: { label: "Approved ✓", cls: "bg-success-50 text-success-700", icon: CheckCircle2 },
  expired: { label: "Expired — reupload needed", cls: "bg-danger-50 text-danger-700", icon: Clock3 },
  rejected: { label: "Rejected — please reupload", cls: "bg-accent-100 text-accent-700", icon: Clock3 },
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

/* ------------------------------ main screen ------------------------------ */

function DocumentsView() {
  const nav = useNavigate();
  const toast = useToast();
  const [rows, setRows] = useState<DocRow[] | null>(null);
  const [compliance, setCompliance] = useState<Compliance | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<{ docTypeId: string; title: string; requiresExpiry: boolean; isSelfie: boolean } | null>(null);
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
                      <p className="truncate text-sm font-bold text-ink-900">{row.docTypeName}</p>
                      <p className="mt-1"><DocStatusBadge status={row.status} /></p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {row.status === "missing" || row.status === "expired" || row.status === "rejected" ? (
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
              <p className="truncate text-sm font-bold text-ink-900">{viewer.title}</p>
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
                  <span className="block truncate text-sm font-semibold text-ink-800">{selected.file.name}</span>
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
