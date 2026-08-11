/**
 * Driver photo workflow UI (milestone #4) — mobile-first capture panels.
 *
 * Flow per the owner's spec: en route / arrived → 4 pre-arrival photos (one per
 * vehicle side) + vehicle-match confirmation (auto-arrive gate) → soft complete
 * → 4 service photos → final complete → 4 final photos → complete job (all 12
 * photos pushed to the Towbook PO, then Towbook status 5 + platform completed).
 *
 * Photo bytes are resized client-side (canvas → JPEG ≤1600px) so phone uploads
 * stay small; the server never fakes success — a missing B2 config or a failed
 * upload surfaces a clear error and the slot stays empty (photos are a hard
 * gate on completion).
 */
import { Camera, Check, Loader2, PenLine, ShieldCheck, Star, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, useToast } from "~/components/ui";
import { completeJobWithPhotos, getJobPhotoStatus, setVehicleMatch, softCompleteJob, finalCompleteJob, uploadJobPhoto } from "~/data/driver-photos";
import type { JobPhotoStatus, PhotoPhase, PhotoSide } from "~/data/driver-photos";
import { captureCompletion, createTipLink, getCompletionCapture, isSquareConfigured } from "~/data/completion";
import type { CompletionCaptureStatus } from "~/data/completion";

export const PHOTO_SIDES: PhotoSide[] = ["front", "driver_side", "passenger_side", "rear"];
export const SIDE_LABELS: Record<PhotoSide, string> = {
  front: "Front",
  driver_side: "Driver side",
  passenger_side: "Passenger side",
  rear: "Rear",
};
const SIDE_HINTS: Record<PhotoSide, string> = {
  front: "One clear shot of the front",
  driver_side: "One clear shot of the driver side",
  passenger_side: "One clear shot of the passenger side",
  rear: "One clear shot of the rear",
};
const PHASE_TITLES: Record<PhotoPhase, string> = {
  pre_arrival: "Arrival photos",
  service: "Service photos",
  final: "Final photos",
};
const PHASE_HINTS: Record<PhotoPhase, string> = {
  pre_arrival: "Take one clear photo of each side of the vehicle. Auto-arrival unlocks once all 4 are uploaded and the vehicle matches the job.",
  service: "Show the service in progress — cables attached, jack stand, one photo per side.",
  final: "One final photo of each side after the service is done.",
};

/** Downscale a captured photo to a JPEG data URL (≤1600px longest side, q0.82)
 *  so uploads are fast on mobile data. Pure client helper. */
export function resizeImageToJpeg(file: File, maxDim = 1600, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas unavailable");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not read image")); };
    img.src = url;
  });
}

type SlotState = {
  preview: string | null;
  busy: boolean;
  error: string | null;
};

function PhotoSlot({
  side,
  preview,
  busy,
  error,
  uploaded,
  onFile,
  onFileError,
}: {
  side: PhotoSide;
  preview: string | null;
  busy: boolean;
  error: string | null;
  uploaded: boolean;
  onFile: (dataUrl: string) => void;
  onFileError: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        aria-label={`${SIDE_LABELS[side]} photo${preview ? " — tap to retake" : ""}`}
        className={`relative aspect-[4/3] w-full overflow-hidden rounded-2xl border-2 border-dashed transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-60 ${
          uploaded ? "border-success-300 bg-success-50" : error ? "border-danger-300 bg-danger-50/50" : "border-ink-200 bg-ink-50"
        }`}
      >
        {preview ? (
          <>
            <img src={preview} alt={`${SIDE_LABELS[side]} photo`} className="absolute inset-0 size-full object-cover" />
            {uploaded && (
              <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-success-500 text-white shadow">
                <Check className="size-3.5" strokeWidth={3} />
              </span>
            )}
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1 pt-4 text-left text-[10px] font-bold uppercase tracking-wide text-white">
              Retake
            </span>
          </>
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center">
            {busy ? <Loader2 className="size-6 animate-spin text-brand-500" /> : <Camera className="size-6 text-ink-400" />}
            <span className="text-[11px] font-semibold leading-tight text-ink-500">{SIDE_HINTS[side]}</span>
          </span>
        )}
      </button>
      <p className={`text-center text-[11px] font-semibold ${uploaded ? "text-success-600" : "text-ink-500"}`}>
        {SIDE_LABELS[side]}
      </p>
      {error && (
        <p role="alert" className="flex items-start gap-1 text-[11px] leading-snug text-danger-600">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" /> {error}
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            const dataUrl = await resizeImageToJpeg(file);
            onFile(dataUrl);
          } catch {
            onFileError();
          }
        }}
      />
    </div>
  );
}

export function JobPhotoFlow({ callId, jobStatus, onCompleted }: { callId: string; jobStatus: "en_route" | "arrived" | "completed" | string; onCompleted: () => void }) {
  const [status, setStatus] = useState<JobPhotoStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [slots, setSlots] = useState<Record<string, SlotState>>({});
  const [matchChecked, setMatchChecked] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState("");
  const [completionDetail, setCompletionDetail] = useState("");
  const [capture, setCapture] = useState<CompletionCaptureStatus | null>(null);
  const [squareConfigured, setSquareConfigured] = useState(false);
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const r = await getJobPhotoStatus({ data: { jobId: callId } });
      if (r.ok) {
        setStatus(r.status);
        setLoadError("");
      } else if (r.ok === false) {
        setLoadError(r.message);
      }
    } catch {
      setLoadError("Couldn't load photo status.");
    }
    try {
      const c = await getCompletionCapture({ data: { jobId: callId } });
      if (c.ok) setCapture(c.completion);
    } catch {
      // completion capture unknown — the panel will retry on save
    }
  }, [callId]);

  useEffect(() => {
    void refresh();
    void isSquareConfigured().then((r) => setSquareConfigured(r.configured)).catch(() => { /* tips stay hidden */ });
  }, [refresh]);

  const upload = async (phase: PhotoPhase, side: PhotoSide, dataUrl: string) => {
    const key = `${phase}:${side}`;
    setSlots((s) => ({ ...s, [key]: { ...s[key], preview: dataUrl, busy: true, error: null } }));
    setCompletionError("");
    try {
      const r = await uploadJobPhoto({ data: { jobId: callId, phase, side, dataUrl } });
      if (r.ok) {
        setSlots((s) => ({ ...s, [key]: { preview: dataUrl, busy: false, error: null } }));
        await refresh();
      } else {
        setSlots((s) => ({ ...s, [key]: { preview: null, busy: false, error: r.message } }));
      }
    } catch {
      setSlots((s) => ({ ...s, [key]: { preview: null, busy: false, error: "Upload failed — check your connection and retry." } }));
    }
  };

  const confirmMatch = async () => {
    setActionBusy("match");
    try {
      const r = await setVehicleMatch({ data: { jobId: callId, confirmed: true } });
      if (r.ok) { setMatchChecked(true); await refresh(); }
      else setCompletionError(r.message);
    } catch {
      setCompletionError("Couldn't save the confirmation. Try again.");
    }
    setActionBusy(null);
  };

  const softComplete = async () => {
    setActionBusy("soft");
    setCompletionError("");
    try {
      const r = await softCompleteJob({ data: { jobId: callId } });
      if (!r.ok) setCompletionError(r.message);
      await refresh();
    } catch {
      setCompletionError("Couldn't mark service started. Try again.");
    }
    setActionBusy(null);
  };

  const finalComplete = async () => {
    setActionBusy("final");
    setCompletionError("");
    try {
      const r = await finalCompleteJob({ data: { jobId: callId } });
      if (!r.ok) setCompletionError(r.message);
      await refresh();
    } catch {
      setCompletionError("Couldn't mark final complete. Try again.");
    }
    setActionBusy(null);
  };

  const complete = async () => {
    setActionBusy("complete");
    setCompletionError("");
    setCompletionDetail("Pushing all 12 photos to the Towbook PO…");
    try {
      const r = await completeJobWithPhotos({ data: { jobId: callId } });
      if (r.ok) {
        setCompletionDetail("Done — job completed and photos attached to the PO.");
        await refresh();
        onCompleted();
      } else {
        setCompletionError(r.message);
        setCompletionDetail(r.code === "photo_upload_failed" ? "Photos stay saved — retry when you have a connection." : "");
      }
    } catch {
      setCompletionError("Completion failed — check your connection and retry.");
      setCompletionDetail("");
    }
    setActionBusy(null);
  };

  if (loadError && !status) {
    return <p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-600">{loadError}</p>;
  }
  if (!status) {
    return <div className="h-40 animate-pulse rounded-2xl bg-ink-100/70" aria-busy="true" />;
  }

  const showPreArrival = status.phase === "pre_arrival" && (jobStatus === "en_route" || jobStatus === "arrived");
  const showService = status.phase === "service";
  const showFinal = status.phase === "final";
  const canComplete = status.phase === "finalizing";

  const slot = (phase: PhotoPhase, side: PhotoSide) => {
    const key = `${phase}:${side}`;
    const row = status.photos[phase]?.[side];
    const s = slots[key];
    return {
      key,
      uploaded: Boolean(row),
      preview: s?.preview ?? null,
      busy: Boolean(s?.busy),
      error: s?.error ?? null,
    };
  };
  const readError = (phase: PhotoPhase, side: PhotoSide) => {
    const key = `${phase}:${side}`;
    setSlots((s) => ({ ...s, [key]: { preview: null, busy: false, error: "Couldn't read that photo — take it again." } }));
  };

  return (
    <div className="mt-4 space-y-4 border-t border-ink-100 pt-4">
      {showPreArrival && (
        <PhasePanel
          phase="pre_arrival"
          status={status}
          slot={slot}
          matchChecked={matchChecked || status.matchConfirmed}
          onUpload={(side, d) => void upload("pre_arrival", side, d)}
          onFileError={(side) => readError("pre_arrival", side)}
          busy={actionBusy === "match"}
          onMatchConfirm={() => void confirmMatch()}
          actionLabel={null}
          actionBusy={false}
          onAction={() => {}}
        />
      )}
      {showService && (
        <PhasePanel
          phase="service"
          status={status}
          slot={slot}
          onUpload={(side, d) => void upload("service", side, d)}
          onFileError={(side) => readError("service", side)}
          actionLabel="Soft complete — service done"
          actionBusy={actionBusy === "soft"}
          onAction={() => void softComplete()}
        />
      )}
      {showFinal && (
        <PhasePanel
          phase="final"
          status={status}
          slot={slot}
          onUpload={(side, d) => void upload("final", side, d)}
          onFileError={(side) => readError("final", side)}
          actionLabel="Final complete — job finished"
          actionBusy={actionBusy === "final"}
          onAction={() => void finalComplete()}
        />
      )}
      {canComplete && (
        <div className="rounded-2xl border border-brand-200 bg-brand-50/60 p-4">
          {capture && capture.signatureCaptured && capture.survey ? (
            <>
              <p className="flex items-center gap-1.5 text-sm font-bold text-ink-800">
                <Check className="size-4 text-success-600" strokeWidth={3} /> Customer completion saved
              </p>
              <p className="mt-0.5 text-xs text-ink-500">
                Signature on file · {capture.survey.rating}-star rating
                {capture.tip ? ` · tip ${(capture.tip.amountCents / 100).toFixed(0)}` : ""}.
              </p>
              {squareConfigured && (
                <TipOptionBlock callId={callId} squareConfigured={squareConfigured} linkSent={Boolean(capture.tip)} />
              )}
              <Button className="mt-3 w-full" loading={actionBusy === "complete"} onClick={() => void complete()}>
                <ShieldCheck className="size-5" /> Complete job — push to Towbook
              </Button>
              {completionDetail && !completionError && <p className="mt-2 text-xs text-ink-500">{completionDetail}</p>}
            </>
          ) : (
            <CustomerCompletionPanel
              callId={callId}
              squareConfigured={squareConfigured}
              onSaved={(completion) => {
                setCapture(completion);
                toast("Customer completion saved — signature and rating on file.");
                void refresh();
              }}
            />
          )}
        </div>
      )}
      {completionError && (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-50 p-3 text-sm text-danger-600">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {completionError}
        </p>
      )}
    </div>
  );
}

/* ------------------------- customer completion capture ------------------------- */

const TIP_PRESETS = [200, 500, 1000]; // $2 / $5 / $10

/** Mobile-friendly signature pad (canvas + pointer events — works by touch and
 *  mouse). Produces a PNG data URL once there is ink; "Clear" resets it. */
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const inkRef = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const p = point(e);
    if (!canvas || !p) return;
    drawingRef.current = true;
    inkRef.current = true;
    setHasInk(true);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const c = canvas.getContext("2d");
    if (!c) return;
    c.lineWidth = 3;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = "#111827";
    c.beginPath();
    c.moveTo(p.x, p.y);
    c.lineTo(p.x + 0.1, p.y + 0.1);
    c.stroke();
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const p = point(e);
    const c = canvas?.getContext("2d");
    if (!canvas || !c || !p) return;
    c.lineTo(p.x, p.y);
    c.stroke();
  };

  const end = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const canvas = canvasRef.current;
    if (canvas && inkRef.current) onChange(canvas.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const c = canvas?.getContext("2d");
    if (canvas && c) c.clearRect(0, 0, canvas.width, canvas.height);
    drawingRef.current = false;
    inkRef.current = false;
    setHasInk(false);
    onChange(null);
  };

  return (
    <div>
      <div className="relative overflow-hidden rounded-xl border border-ink-200 bg-white">
        <canvas
          ref={canvasRef}
          width={640}
          height={200}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          className="block h-40 w-full cursor-crosshair touch-none"
          aria-label="Signature pad — have the customer sign here"
        />
        {!hasInk && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 text-xs font-medium text-ink-400">
            <PenLine className="size-3.5" /> Have the customer sign here
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={clear}
        className="mt-1.5 text-[11px] font-semibold text-ink-500 underline decoration-ink-200 underline-offset-2 hover:text-danger-600"
      >
        Clear signature
      </button>
    </div>
  );
}

/** Optional tip block — ONLY rendered when the owner's Square account is
 *  configured (square_not_configured never blocks completion). Calls
 *  createTipLink and opens the Square-hosted payment page in a new tab. */
function TipOptionBlock({ callId, squareConfigured, linkSent }: { callId: string; squareConfigured: boolean; linkSent?: boolean }) {
  const [preset, setPreset] = useState<number | null>(500);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  if (!squareConfigured) return null;

  const amountCents = custom.trim() !== "" ? Math.round(Number(custom) * 100) : preset ?? 0;

  const send = async () => {
    if (!Number.isFinite(amountCents) || amountCents < 100 || amountCents > 1_000_000) {
      setError("Enter a tip of $1 – $10,000.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await createTipLink({ data: { jobId: callId, amountCents } });
      if (r.ok) {
        setSent(true);
        if (typeof window !== "undefined") window.open(r.paymentLinkUrl, "_blank", "noopener,noreferrer");
      } else {
        setError(r.message);
      }
    } catch {
      setError("Couldn't create the tip link — try again.");
    }
    setBusy(false);
  };

  return (
    <div className="mt-3 rounded-xl border border-ink-200 bg-surface p-3">
      <p className="text-xs font-bold text-ink-800">Optional customer tip</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">
        Opens a secure Square payment page the customer pays on — the tip is attributed to you.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {TIP_PRESETS.map((cents) => (
          <button
            key={cents}
            type="button"
            onClick={() => { setPreset(cents); setCustom(""); }}
            className={`h-9 rounded-lg px-3 text-sm font-bold transition-colors ${
              preset === cents && custom.trim() === ""
                ? "bg-brand-500 text-white"
                : "border border-ink-200 bg-surface text-ink-700 hover:bg-hover"
            }`}
          >
            ${cents / 100}
          </button>
        ))}
        <label className="flex h-9 items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2">
          <span className="text-xs font-semibold text-ink-400">$</span>
          <input
            type="number"
            min="1"
            max="10000"
            inputMode="decimal"
            placeholder="Custom"
            value={custom}
            onChange={(e) => { setCustom(e.target.value); setPreset(null); }}
            className="w-20 bg-transparent text-sm font-bold text-ink-900 outline-none placeholder:font-medium placeholder:text-ink-300"
          />
        </label>
      </div>
      {(sent || linkSent) && (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold text-success-600">
          <Check className="size-3" strokeWidth={3} /> Tip link sent — the customer can pay on Square now.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-[11px] leading-snug text-danger-600">{error}</p>
      )}
      <Button className="mt-2 w-full" size="sm" variant="secondary" loading={busy} onClick={() => void send()}>
        {busy ? "Creating link…" : "Send tip link"}
      </Button>
    </div>
  );
}

/** The "Customer completion" step (owner spec): signature pad + 5-star rating
 *  + optional one-line comment + optional tip. Submit is enabled once a
 *  signature AND a rating exist; the tip is never required. */
function CustomerCompletionPanel({
  callId,
  squareConfigured,
  onSaved,
}: {
  callId: string;
  squareConfigured: boolean;
  onSaved: (completion: CompletionCaptureStatus) => void;
}) {
  const [signature, setSignature] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!signature || !rating) return;
    setSaving(true);
    setError("");
    try {
      const r = await captureCompletion({ data: { jobId: callId, signatureDataUrl: signature, survey: { rating, comment: comment.trim() } } });
      if (r.ok) onSaved(r.completion);
      else setError(r.message);
    } catch {
      setError("Couldn't save the customer completion — check your connection and retry.");
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-bold text-ink-800">
          <PenLine className="size-4 text-brand-600" /> Customer completion
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
          All 12 photos are captured. Before completing, get the customer&apos;s signature and a quick rating.
        </p>
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold text-ink-700">Customer signature <span className="text-danger-500">*</span></p>
        <SignaturePad onChange={setSignature} />
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold text-ink-700">How was the service? <span className="text-danger-500">*</span></p>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Rate the service 1 to 5 stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              onClick={() => setRating(n)}
              className="grid size-11 place-items-center rounded-xl border border-ink-200 bg-surface transition-colors active:scale-95"
            >
              <Star
                className={`size-6 ${n <= (rating ?? 0) ? "fill-accent-400 text-accent-400" : "text-ink-300"}`}
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
        <label className="mt-2 block">
          <span className="sr-only">Comment (optional)</span>
          <input
            type="text"
            maxLength={200}
            placeholder="Comment (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="h-10 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm text-ink-900 outline-none transition-colors focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40"
          />
        </label>
      </div>

      {squareConfigured && <TipOptionBlock callId={callId} squareConfigured={squareConfigured} />}

      <Button className="w-full" loading={saving} disabled={!signature || !rating} onClick={() => void save()}>
        <Check className="size-5" /> Save customer completion
      </Button>
      {(!signature || !rating) && (
        <p className="text-center text-[11px] text-ink-400">Needs a signature and a star rating.</p>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-50 p-3 text-sm text-danger-600">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

function PhasePanel({
  phase,
  status,
  slot,
  onUpload,
  onFileError,
  matchChecked,
  onMatchConfirm,
  busy,
  actionLabel,
  actionBusy,
  onAction,
}: {
  phase: PhotoPhase;
  status: JobPhotoStatus;
  slot: (phase: PhotoPhase, side: PhotoSide) => { key: string; uploaded: boolean; preview: string | null; busy: boolean; error: string | null };
  onUpload: (side: PhotoSide, dataUrl: string) => void;
  onFileError: (side: PhotoSide) => void;
  matchChecked?: boolean;
  onMatchConfirm?: () => void;
  busy?: boolean;
  actionLabel: string | null;
  actionBusy: boolean;
  onAction: () => void;
}) {
  const done = status.complete[phase];
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-ink-800">{PHASE_TITLES[phase]}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{PHASE_HINTS[phase]}</p>
        </div>
        {done && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-100 px-2.5 py-1 text-[11px] font-bold text-success-700">
            <Check className="size-3" strokeWidth={3} /> {status.counts[phase]}/4
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {PHOTO_SIDES.map((side) => {
          const s = slot(phase, side);
          return (
            <PhotoSlot
              key={s.key}
              side={side}
              preview={s.preview}
              busy={s.busy}
              error={s.error}
              uploaded={s.uploaded}
              onFile={(d) => onUpload(side, d)}
              onFileError={() => onFileError(side)}
            />
          );
        })}
      </div>
      {phase === "pre_arrival" && onMatchConfirm && (
        <label className="mt-3 flex items-start gap-2.5 rounded-xl border border-ink-200 bg-surface p-3">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-brand-500"
            checked={matchChecked === true}
            onChange={(e) => { if (e.target.checked) onMatchConfirm(); }}
            disabled={busy || matchChecked === true}
          />
          <span className="text-xs leading-relaxed text-ink-600">
            <strong className="font-semibold text-ink-800">I confirm the vehicle matches the job details.</strong>{" "}
            {matchChecked ? "Confirmation saved." : "Required before arrival is marked and service starts."}
          </span>
        </label>
      )}
      {actionLabel && (
        <Button className="mt-3 w-full" loading={actionBusy} disabled={!done} onClick={onAction}>
          {done ? <Check className="size-5" /> : <Camera className="size-5" />} {actionLabel}
        </Button>
      )}
      {actionLabel && !done && (
        <p className="mt-1.5 text-center text-[11px] text-ink-400">Needs all 4 photos ({status.counts[phase]}/4).</p>
      )}
    </div>
  );
}

/** Compact per-phase chips for the driver card header (progress at a glance). */
export function PhotoProgressChips({ status }: { status: JobPhotoStatus }) {
  if (!status || status.phase === "idle" || status.phase === "completed") return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {(["pre_arrival", "service", "final"] as const).map((phase) => {
        const done = status.complete[phase];
        return (
          <span
            key={phase}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
              done ? "bg-success-100 text-success-700" : "bg-ink-100 text-ink-500"
            }`}
          >
            {phase === "pre_arrival" ? "arrival" : phase} {status.counts[phase]}/4
          </span>
        );
      })}
      {status.matchConfirmed && (
        <span className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700">
          <Check className="size-3" strokeWidth={3} /> match ✓
        </span>
      )}
    </div>
  );
}
