/**
 * Job detail expansion (owner spec 2026-08-11, backlog #2) — shared collapsible
 * for EVERY job card/tab: the ops queue (ops-views), owner dashboard + job
 * history (owner/index), and the driver portal's job list (driver-portal).
 *
 * The card's list payload stays small: tapping the disclosure fetches the full
 * detail + photo metadata lazily via getJobDetail, and each photo's bytes load
 * progressively via getJobPhoto (role-checked server-side, keyed by
 * jobId+phase+side — never a client-supplied B2 key). Jobs with no photos
 * render a "No photos" note; a failed photo renders a labeled placeholder —
 * never a broken image, never a crash.
 *
 * Client-safe: imports only the facade (src/data/job-detail.ts) + job-ui.
 */
import { Camera, CameraOff, ChevronDown, Phone, RefreshCw, Truck, User } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getJobDetail, getJobPhoto, type JobDetail, type JobDetailPhoto } from "~/data/job-detail";
import { JOB_STATUS_META, SERVICE_LABELS } from "~/lib/job-ui";
import { InlineError } from "~/components/mutation-status";

/** Phase → display label (matches the driver photo workflow's PHASE_LABELS). */
export const DETAIL_PHASE_LABELS: Record<string, string> = {
  pre_arrival: "Pre-arrival",
  service: "Service",
  final: "Final",
};
/** Side → display label (matches PHOTO_SIDE_LABELS in driver-photos-core). */
const SIDE_LABELS: Record<string, string> = {
  front: "Front",
  driver_side: "Driver side",
  passenger_side: "Passenger side",
  rear: "Rear",
};

/* ------------------------------ fetch caches ------------------------------ */

/** Module-wide detail cache so re-expanding a card never refetches. */
const detailCache = new Map<string, JobDetail>();
const detailInflight = new Map<string, Promise<JobDetail | null>>();
function loadDetail(jobId: string): Promise<JobDetail | null> {
  const cached = detailCache.get(jobId);
  if (cached) return Promise.resolve(cached);
  const inflight = detailInflight.get(jobId);
  if (inflight) return inflight;
  const p = getJobDetail({ data: { jobId } })
    .then((r) => {
      const detail = r.ok ? r.detail : null;
      if (detail) detailCache.set(jobId, detail);
      return detail;
    })
    .catch(() => null)
    .finally(() => detailInflight.delete(jobId));
  detailInflight.set(jobId, p);
  return p;
}

/** Per-photo bytes cache (data URL) + failure marker so retries are explicit. */
const photoCache = new Map<string, string | null>();
const photoInflight = new Map<string, Promise<string | null>>();
function loadPhoto(jobId: string, phase: string, side: string): Promise<string | null> {
  const key = `${jobId}/${phase}/${side}`;
  const cached = photoCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = photoInflight.get(key);
  if (inflight) return inflight;
  const p = getJobPhoto({ data: { jobId, phase, side } })
    .then((r) => {
      const url = r.ok ? r.dataUrl : null;
      photoCache.set(key, url);
      return url;
    })
    .catch(() => {
      photoCache.set(key, null);
      return null;
    })
    .finally(() => photoInflight.delete(key));
  photoInflight.set(key, p);
  return p;
}

/* --------------------------------- helpers --------------------------------- */

function statusMeta(status: string): { label: string; badge: string } {
  const meta = JOB_STATUS_META[status as keyof typeof JOB_STATUS_META];
  if (meta) return { label: meta.label, badge: meta.badge };
  return { label: status, badge: "bg-ink-100 text-ink-600" };
}

const fmtStamp = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const fmtEtaClock = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

/* --------------------------------- disclosure --------------------------------- */

/** The mobile-first tap target + smooth expand region. `jobId` is the LD job
 *  id or the Towbook call id (the driver portal works with call ids). */
export function JobDetailDisclosure({ jobId, label = "Details" }: { jobId: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchDetail = useCallback(() => {
    if (detail) return;
    setLoading(true);
    setError("");
    void loadDetail(jobId).then((d) => {
      setLoading(false);
      if (d) setDetail(d);
      else setError("Couldn't load the job details — try again.");
    });
  }, [jobId, detail]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !detail && !error) fetchDetail();
  };

  return (
    <div className="border-t border-ink-100">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-hover active:bg-ink-100/70"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-500">
          <Camera className="size-3.5" aria-hidden="true" />
          {label}
        </span>
        <ChevronDown
          className={`size-4 text-ink-400 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          {open && (
            <div className="px-3 pb-3">
              {loading && (
                <div className="space-y-2" aria-busy="true">
                  <div className="h-3 w-2/3 animate-pulse rounded-full bg-ink-100" />
                  <div className="h-3 w-1/2 animate-pulse rounded-full bg-ink-100" />
                  <div className="mt-3 h-20 animate-pulse rounded-xl bg-ink-100/70" />
                </div>
              )}
              {error && (
                <div>
                  <InlineError message={error} />
                  <button
                    type="button"
                    onClick={fetchDetail}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-semibold text-ink-600 transition-colors hover:bg-ink-50"
                  >
                    <RefreshCw className="size-3.5" /> Retry
                  </button>
                </div>
              )}
              {detail && <JobDetailBody detail={detail} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- detail body ---------------------------------- */

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{label}</span>
      <span className="min-w-0 text-right text-sm font-medium text-ink-800">{value}</span>
    </div>
  );
}

function JobDetailBody({ detail }: { detail: JobDetail }) {
  const meta = statusMeta(detail.status);
  const serviceLabel = SERVICE_LABELS[detail.serviceType as keyof typeof SERVICE_LABELS] ?? detail.serviceType;
  return (
    <div className="rounded-xl border border-ink-100 bg-ink-50/40">
      {/* Summary line: status + service + area */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-3 py-2.5">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${meta.badge}`}>{meta.label}</span>
        <span className="text-sm font-semibold text-ink-700">{serviceLabel}</span>
        <span className="text-xs text-ink-400">· {detail.area}</span>
      </div>

      {/* Contact + location */}
      <dl className="divide-y divide-ink-100/70 px-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
          <dt className="flex shrink-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
            <User className="size-3" aria-hidden="true" /> Customer
          </dt>
          <dd className="min-w-0 text-right text-sm font-semibold text-ink-800">{detail.customerName}</dd>
        </div>
        {detail.phone && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
            <dt className="flex shrink-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
              <Phone className="size-3" aria-hidden="true" /> Phone
            </dt>
            <dd className="min-w-0 text-right text-sm tabular-nums text-ink-700">
              <a href={`tel:${detail.phone.replace(/[^+\d]/g, "")}`} className="text-brand-700 hover:underline">
                {detail.phone}
              </a>
            </dd>
          </div>
        )}
        {detail.pickup && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
            <dt className="flex shrink-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
              <Truck className="size-3" aria-hidden="true" /> Pickup
            </dt>
            <dd className="min-w-0 text-right text-sm text-ink-700">{detail.pickup}</dd>
          </div>
        )}
        {detail.dropoff && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
            <dt className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Drop-off</dt>
            <dd className="min-w-0 text-right text-sm text-ink-700">{detail.dropoff}</dd>
          </div>
        )}
        {detail.vehicleDesc && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
            <dt className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Vehicle</dt>
            <dd className="min-w-0 text-right text-sm text-ink-700">{detail.vehicleDesc}</dd>
          </div>
        )}
        {detail.assignedDriverName && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
            <dt className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Assigned to</dt>
            <dd className="min-w-0 text-right text-sm font-semibold text-ink-800">{detail.assignedDriverName}</dd>
          </div>
        )}
      </dl>

      {/* Timeline */}
      <div className="border-t border-ink-100 px-3 py-1.5">
        <p className="pt-1 text-[11px] font-bold uppercase tracking-wider text-ink-400">Timeline</p>
        <DetailRow label="Created" value={fmtStamp(detail.createdAt)} />
        {detail.assignedAt && <DetailRow label="Assigned" value={fmtStamp(detail.assignedAt)} />}
        {detail.arrivedAt && <DetailRow label="Arrived" value={fmtStamp(detail.arrivedAt)} />}
        {detail.completedAt && <DetailRow label="Completed" value={fmtStamp(detail.completedAt)} />}
      </div>

      {/* Towbook + ETA */}
      {(detail.towbookJobId || detail.purchaseOrderNumber || detail.arrivalETA || detail.quotedEtaMinutes != null) && (
        <div className="border-t border-ink-100 px-3 py-1.5">
          <p className="pt-1 text-[11px] font-bold uppercase tracking-wider text-ink-400">Towbook</p>
          {detail.towbookJobId && <DetailRow label="Call #" value={<span className="font-mono">{detail.towbookJobId}</span>} />}
          {detail.purchaseOrderNumber && <DetailRow label="PO #" value={<span className="font-mono">{detail.purchaseOrderNumber}</span>} />}
          {detail.arrivalETA && <DetailRow label="ETA" value={fmtEtaClock(detail.arrivalETA)} />}
          {detail.quotedEtaMinutes != null && <DetailRow label="Quoted ETA" value={`${detail.quotedEtaMinutes} min`} />}
        </div>
      )}

      {/* Note */}
      {detail.note && (
        <div className="border-t border-ink-100 px-3 py-2.5">
          <p className="text-[11px] font-bold uppercase tracking-wider text-ink-400">Note</p>
          <p className="mt-0.5 text-sm leading-snug text-ink-700">{detail.note}</p>
        </div>
      )}

      {/* Photos — 12-photo set grouped by phase, in upload order */}
      <div className="border-t border-ink-100 px-3 py-2.5">
        <p className="text-[11px] font-bold uppercase tracking-wider text-ink-400">Photos</p>
        <JobPhotoGallery jobId={detail.id} photos={detail.photos} />
      </div>
    </div>
  );
}

/* ---------------------------------- photo gallery ---------------------------------- */

/** One photo cell: lazy bytes fetch + progressive states. Never renders a
 *  broken image — a failed fetch shows a labeled placeholder with a retry. */
function JobPhotoCell({ jobId, photo }: { jobId: string; photo: JobDetailPhoto }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const sideLabel = SIDE_LABELS[photo.side] ?? photo.side;

  useEffect(() => {
    let live = true;
    setFailed(false);
    void loadPhoto(jobId, photo.phase, photo.side).then((u) => {
      if (!live) return;
      setUrl(u);
      if (!u) setFailed(true);
    });
    return () => { live = false; };
  }, [jobId, photo.phase, photo.side]);

  const retry = () => {
    setUrl(undefined);
    setFailed(false);
    void getJobPhoto({ data: { jobId, phase: photo.phase, side: photo.side } }).then((r) => {
      setUrl(r.ok ? r.dataUrl : null);
      if (!r.ok) setFailed(true);
    });
  };

  return (
    <figure className="min-w-0">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-ink-100 bg-ink-100/60">
        {url ? (
          <img src={url} alt={`${sideLabel} photo`} className="absolute inset-0 size-full object-cover" loading="lazy" />
        ) : failed ? (
          <button type="button" onClick={retry} className="absolute inset-0 grid w-full place-items-center text-ink-400 transition-colors hover:bg-ink-100/60" title="Retry photo">
            <span className="flex flex-col items-center gap-1">
              <CameraOff className="size-5" aria-hidden="true" />
              <span className="text-[10px] font-semibold">Not available</span>
            </span>
          </button>
        ) : (
          <div className="absolute inset-0 animate-pulse bg-ink-100" aria-busy="true" />
        )}
        {photo.matchConfirmed && (
          <span className="absolute right-1 top-1 rounded-full bg-success-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
            match ✓
          </span>
        )}
      </div>
      <figcaption className="mt-1 truncate text-[11px] font-medium text-ink-500">
        {sideLabel}
        <span className="text-ink-300"> · {fmtStamp(photo.uploadedAt)}</span>
      </figcaption>
    </figure>
  );
}

function JobPhotoGallery({ jobId, photos }: { jobId: string; photos: JobDetailPhoto[] }) {
  if (!photos.length) {
    return <p className="mt-1 text-sm text-ink-400">No photos on file for this job.</p>;
  }
  const phases = ["pre_arrival", "service", "final"];
  return (
    <div className="mt-1 space-y-3">
      {phases.map((phase) => {
        const group = photos.filter((p) => p.phase === phase);
        if (!group.length) return null;
        return (
          <div key={phase}>
            <p className="mb-1.5 text-xs font-semibold text-ink-600">
              {DETAIL_PHASE_LABELS[phase] ?? phase}
              <span className="ml-1.5 font-medium tabular-nums text-ink-400">{group.length}/4</span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              {group.map((photo) => (
                <JobPhotoCell key={`${phase}/${photo.side}`} jobId={jobId} photo={photo} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
