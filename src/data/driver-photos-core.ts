/**
 * Photo workflow (milestone #4, owner-directed 2026-08-11) — SERVER-ONLY core.
 *
 * The 4+4+4 photo pipeline: pre_arrival / service / final, one photo per
 * vehicle side (front, driver_side, passenger_side, rear), each stored in
 * Backblaze B2 (storage_key in job_photos). Pre-arrival additionally requires
 * the driver's vehicle-match confirmation — together they gate geofence
 * auto-arrive (photosCompleteForJob in driver-gps-core.ts reads job_photos).
 *
 * Completion: all 12 photos are read back from B2 and uploaded to the Towbook
 * PO via POST /api/calls/{id}/photos?description=<label> (multipart field
 * `file`) using the DRIVER's session, one by one with per-photo verification;
 * then the job is completed on Towbook (PUT status 5, verified) and on the
 * platform. A failed upload is recorded + escalated (escalated_photo_upload_failed
 * in the decision ledger — the ops "Needs attention" banner surfaces it) and
 * the job NEVER reaches completed without its photos: photos are a hard gate.
 *
 * Testability (same split as driver-gps-core evaluateGeofence/pingHandler):
 * every handler is a thin auth wrapper over a `*Core` function that takes an
 * explicit user context — hermetic tests call the cores directly.
 *
 * Imported ONLY by the client-safe facade (src/data/driver-photos.ts, whose
 * createServerFn handlers dynamic-import this module) and by hermetic tests.
 * Static server imports are fine here — this module never enters the client
 * bundle graph (node:crypto lives in b2-client.ts).
 */
import { z } from "zod";
import { loadB2Config, authorizeAccount, putObject, getObject } from "./b2-client";
import { loadDriverSession, callHasDriver, tbFetch } from "./driver-gps-core";
import type { DriverSession } from "./driver-auth";

/* ----------------------------------- domain ----------------------------------- */

export const PHOTO_PHASES = ["pre_arrival", "service", "final"] as const;
export type PhotoPhase = (typeof PHOTO_PHASES)[number];
export const PHOTO_SIDES = ["front", "driver_side", "passenger_side", "rear"] as const;
export type PhotoSide = (typeof PHOTO_SIDES)[number];
export const PHOTO_SIDE_LABELS: Record<PhotoSide, string> = {
  front: "Front",
  driver_side: "Driver side",
  passenger_side: "Passenger side",
  rear: "Rear",
};
export const PHASE_LABELS: Record<PhotoPhase, string> = {
  pre_arrival: "Pre-arrival",
  service: "Service",
  final: "Final",
};

export type JobPhotoRow = {
  side: PhotoSide;
  storageKey: string;
  uploadedAt: string;
  uploadedByUserId: string;
  matchConfirmed: boolean;
};
export type JobPhotoStatus = {
  jobId: string;
  towbookJobId: string | null;
  jobStatus: string;
  phase: "pre_arrival" | "service" | "final" | "finalizing" | "completed" | "idle";
  matchConfirmed: boolean;
  counts: Record<PhotoPhase, number>;
  complete: Record<PhotoPhase, boolean>;
  photos: Record<PhotoPhase, Partial<Record<PhotoSide, JobPhotoRow>>>;
};
/** The user context handlers resolve from the LD session; cores take it
 *  explicitly so hermetic tests run without a request/session. */
export type PhotoUser = { orgId: string; id: string; role: string; towbookDriverId: string };

const configured = () => Boolean(process.env.DATABASE_URL);
let schemaInit: Promise<void> | undefined;
function ensure() {
  if (!configured()) return Promise.resolve();
  schemaInit ??= (async () => {
    const { ensureAuthSchema } = await import("./auth-server");
    await ensureAuthSchema();
    const { ensureSchema } = await import("./migrations");
    await ensureSchema();
  })();
  return schemaInit;
}
const db = () => import("~/db").then((m) => m.sql());

/** Resolve the acting driver user + their Towbook driver id (handler helper). */
async function resolvePhotoUser(): Promise<PhotoUser | null> {
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || u.role !== "contractor") return null;
  const q = await db();
  const rows = await q`SELECT towbook_driver_id FROM users WHERE id=${u.id}`;
  return {
    orgId: u.orgId,
    id: u.id,
    role: u.role,
    towbookDriverId: rows.length ? String(rows[0].towbook_driver_id ?? "") : "",
  };
}

/* --------------------------------- persistence --------------------------------- */

const isSide = (s: string): s is PhotoSide => (PHOTO_SIDES as readonly string[]).includes(s);
const isPhase = (p: string): p is PhotoPhase => (PHOTO_PHASES as readonly string[]).includes(p);

type ResolvedJob = { id: string; status: string | null; towbookJobId: string | null; raw: Record<string, unknown> | null; assignedContractorId: string | null };

/** Resolve the LD dispatch_jobs row for a job identifier that may be either the
 *  LD job id or the Towbook call id (the driver portal works with call ids). */
export async function resolveJob(orgId: string, jobId: string): Promise<ResolvedJob | null> {
  await ensure();
  const q = await db();
  const rows = await q`SELECT id, status, towbook_job_id, raw_json, assigned_contractor_id
    FROM dispatch_jobs WHERE org_id=${orgId} AND (id=${jobId} OR towbook_job_id=${jobId}) LIMIT 1`;
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id: String(r.id),
    status: r.status != null ? String(r.status) : null,
    towbookJobId: r.towbook_job_id != null ? String(r.towbook_job_id) : null,
    raw: r.raw_json && typeof r.raw_json === "object" ? (r.raw_json as Record<string, unknown>) : null,
    assignedContractorId: r.assigned_contractor_id != null ? String(r.assigned_contractor_id) : null,
  };
}

/** Is this LD user the contractor assigned to the job? (contractor-id link, or
 *  the Towbook driver on the call's assets). */
export async function isAssignedDriver(orgId: string, userId: string, towbookDriverId: string, job: ResolvedJob): Promise<boolean> {
  if (job.assignedContractorId) {
    const q = await db();
    const rows = await q`SELECT contractor_id FROM organization_memberships WHERE org_id=${orgId} AND user_id=${userId} LIMIT 1`;
    if (rows.length && rows[0].contractor_id != null && String(rows[0].contractor_id) === job.assignedContractorId) return true;
  }
  const driverIdNum = Number(towbookDriverId);
  if (job.raw && driverIdNum > 0 && Number.isFinite(driverIdNum)) return callHasDriver(job.raw, driverIdNum);
  return false;
}

/** All photo rows for a job, grouped by phase+side. */
export async function jobPhotoRows(orgId: string, jobId: string): Promise<JobPhotoStatus["photos"]> {
  const q = await db();
  const rows = await q`SELECT phase, side, storage_key, uploaded_at, uploaded_by_user_id, match_confirmed
    FROM job_photos WHERE org_id=${orgId} AND job_id=${jobId}`;
  const out: JobPhotoStatus["photos"] = { pre_arrival: {}, service: {}, final: {} };
  for (const r of rows as Record<string, unknown>[]) {
    const phase = String(r.phase);
    const side = String(r.side);
    if (!isPhase(phase) || !isSide(side)) continue;
    out[phase][side] = {
      side,
      storageKey: String(r.storage_key),
      uploadedAt: new Date(String(r.uploaded_at)).toISOString(),
      uploadedByUserId: String(r.uploaded_by_user_id),
      matchConfirmed: r.match_confirmed === true,
    };
  }
  return out;
}

/** Counts + completeness per phase; pre_arrival also requires the driver's
 *  vehicle-match confirmation (one confirmed row counts — retakes reset it). */
export function summarizePhotos(photos: JobPhotoStatus["photos"]): { counts: Record<PhotoPhase, number>; complete: Record<PhotoPhase, boolean>; matchConfirmed: boolean } {
  const counts: Record<PhotoPhase, number> = { pre_arrival: 0, service: 0, final: 0 };
  const complete = { pre_arrival: false, service: false, final: false };
  let matchConfirmed = false;
  for (const phase of PHOTO_PHASES) {
    const sides = photos[phase];
    let n = 0;
    for (const side of PHOTO_SIDES) {
      const row = sides[side];
      if (row) {
        n += 1;
        if (phase === "pre_arrival" && row.matchConfirmed) matchConfirmed = true;
      }
    }
    counts[phase] = n;
    complete[phase] = n >= 4;
  }
  return { counts, complete, matchConfirmed };
}

/** The on-platform phase derived from job status + photo presence. Keeps
 *  dispatch_jobs.status as the sync sees it ('arrived' through the whole
 *  service/final window) — the phase lives in job_photos, so the 30s Towbook
 *  sync can never regress it. */
export function derivePhase(status: string | null, complete: Record<PhotoPhase, boolean>, matchConfirmed: boolean): JobPhotoStatus["phase"] {
  if (status === "completed") return "completed";
  if (status === "arrived") {
    if (complete.final) return "finalizing";
    if (complete.service) return "final";
    if (complete.pre_arrival && matchConfirmed) return "service";
    return "pre_arrival";
  }
  if (status === "en_route") return "pre_arrival";
  return "idle";
}

/** Full photo status for one job (already resolved). */
export async function photoStatusForJob(orgId: string, job: ResolvedJob): Promise<JobPhotoStatus> {
  const photos = await jobPhotoRows(orgId, job.id);
  const { counts, complete, matchConfirmed } = summarizePhotos(photos);
  return {
    jobId: job.id,
    towbookJobId: job.towbookJobId,
    jobStatus: job.status ?? "new",
    phase: derivePhase(job.status, complete, matchConfirmed),
    matchConfirmed,
    counts,
    complete,
    photos,
  };
}

/* ------------------------------ B2 storage layer ------------------------------ */

const storageKeyFor = (orgId: string, jobId: string, phase: PhotoPhase, side: PhotoSide) => `ld-photos/${orgId}/${jobId}/${phase}/${side}.jpg`;

/** Decode a data: URL into bytes + mime (client-side resize always sends
 *  image/jpeg; anything else is rejected by the size/mime guards below).
 *  Exported so the completion core (customer signature PNGs) reuses it. */
export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") return null;
  return { bytes: new Uint8Array(Buffer.from(m[2], "base64")), mime };
}

/* ------------------------------ upload + phases (cores) ------------------------------ */

export type PhotoUploadResult =
  | { ok: true; storageKey: string; side: PhotoSide; phase: PhotoPhase }
  | { ok: false; code: "invalid_input" | "b2_not_configured" | "b2_failed" | "not_found" | "unauthorized" | "phase_locked"; message: string };

/** Upload one photo for a phase+side slot: B2 put + job_photos upsert (a retake
 *  overwrites the same B2 object and row; pre_arrival retakes reset the match
 *  confirmation so the driver must re-confirm the current photo). Phase gates:
 *  pre_arrival needs the job en_route/arrived; service needs pre_arrival done;
 *  final needs service done. Injectable fetchImpl for hermetic tests. */
export async function uploadJobPhotoCore(user: PhotoUser, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<PhotoUploadResult> {
  const v = z.object({
    jobId: z.string().min(1).max(128),
    phase: z.enum(PHOTO_PHASES),
    side: z.enum(PHOTO_SIDES),
    dataUrl: z.string().min(20).max(20_000_000),
  }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_input", message: "Invalid photo upload." };
  const decoded = decodeDataUrl(v.data.dataUrl);
  if (!decoded) return { ok: false, code: "invalid_input", message: "The photo couldn't be read — take it again." };
  if (decoded.bytes.length < 1024) return { ok: false, code: "invalid_input", message: "The photo looks empty — take it again." };
  if (decoded.bytes.length > 12 * 1024 * 1024) return { ok: false, code: "invalid_input", message: "The photo is too large (max 12 MB)." };
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    const q = await db();
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };

    const photos = await jobPhotoRows(user.orgId, job.id);
    const { complete } = summarizePhotos(photos);
    if (v.data.phase === "pre_arrival") {
      if (job.status !== "en_route" && job.status !== "arrived") return { ok: false, code: "phase_locked", message: "Arrival photos unlock once you're en route." };
    } else if (v.data.phase === "service") {
      if (job.status !== "arrived" || !complete.pre_arrival) return { ok: false, code: "phase_locked", message: "Service photos unlock after arrival photos are complete." };
    } else {
      if (job.status !== "arrived" || !complete.service) return { ok: false, code: "phase_locked", message: "Final photos unlock after the service photos are complete." };
    }

    const key = storageKeyFor(user.orgId, job.id, v.data.phase, v.data.side);
    let b2;
    try {
      const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
      const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
      b2 = { config, s3ApiUrl: auth.s3ApiUrl };
    } catch (err) {
      return { ok: false, code: "b2_not_configured", message: err instanceof Error ? err.message : "Photo storage isn't connected." };
    }
    const put = await putObject({ config: b2.config, s3ApiUrl: b2.s3ApiUrl, key, bytes: decoded.bytes, contentType: decoded.mime, fetchImpl: opts.fetchImpl });
    if (!put.ok) return { ok: false, code: "b2_failed", message: `Photo storage rejected the upload (HTTP ${put.status ?? "error"}). Try again.` };

    // Upsert the slot (retake overwrites). Pre-arrival retakes reset the match
    // flag — the confirmation applies to the current photo set.
    await q`INSERT INTO job_photos(id, org_id, job_id, phase, side, storage_key, uploaded_by_user_id, match_confirmed)
      VALUES(gen_random_uuid()::text, ${user.orgId}, ${job.id}, ${v.data.phase}, ${v.data.side}, ${key}, ${user.id}, FALSE)
      ON CONFLICT (org_id, job_id, phase, side) DO UPDATE
        SET storage_key=EXCLUDED.storage_key, uploaded_by_user_id=EXCLUDED.uploaded_by_user_id,
            match_confirmed=FALSE, uploaded_at=NOW()`;
    // The vehicle-match confirmation applies to the whole pre-arrival SET — any
    // retake invalidates it for every side (the new photo set needs re-confirming).
    if (v.data.phase === "pre_arrival") {
      await q`UPDATE job_photos SET match_confirmed=FALSE
        WHERE org_id=${user.orgId} AND job_id=${job.id} AND phase='pre_arrival'`;
    }
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'photo_uploaded', 'job', ${job.id},
          jsonb_build_object('phase', ${v.data.phase}::text, 'side', ${v.data.side}::text, 'storageKey', ${key}::text, 'bytes', ${decoded.bytes.length}::int), 'driver-photos'`;
    } catch { /* best-effort audit */ }
    return { ok: true, storageKey: key, side: v.data.side, phase: v.data.phase };
  } catch (err) {
    return { ok: false, code: "b2_failed", message: err instanceof Error ? err.message : "Photo upload failed. Try again." };
  }
}

export type ConfirmMatchResult = { ok: true; matchConfirmed: boolean } | { ok: false; code: "not_found" | "unauthorized" | "invalid_state"; message: string };

/** Driver's vehicle-match confirmation (pre_arrival). Marks every pre_arrival
 *  row of the job confirmed (idempotent, audited). */
export async function setVehicleMatchCore(user: PhotoUser, data: unknown): Promise<ConfirmMatchResult> {
  const v = z.object({ jobId: z.string().min(1).max(128), confirmed: z.boolean() }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid confirmation." };
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    const q = await db();
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
    const pre = await q`SELECT COUNT(*)::int AS n FROM job_photos WHERE org_id=${user.orgId} AND job_id=${job.id} AND phase='pre_arrival'`;
    if (Number(pre[0]?.n ?? 0) === 0) return { ok: false, code: "invalid_state", message: "Upload the arrival photos first." };
    await q`UPDATE job_photos SET match_confirmed=${v.data.confirmed} WHERE org_id=${user.orgId} AND job_id=${job.id} AND phase='pre_arrival'`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'vehicle_match_confirmed', 'job', ${job.id}, jsonb_build_object('confirmed', ${v.data.confirmed}::boolean)`;
    } catch { /* best-effort audit */ }
    return { ok: true, matchConfirmed: v.data.confirmed };
  } catch {
    return { ok: false, code: "invalid_state", message: "Unable to save the confirmation. Try again." };
  }
}

export type PhaseCompleteResult = { ok: true; phase: "service" | "finalizing" } | { ok: false; code: "not_found" | "unauthorized" | "photos_incomplete" | "invalid_state"; message: string };

/** Soft complete (arrived → service): requires all 4 pre-arrival photos AND the
 *  vehicle-match confirmation (owner spec). Audited; dispatch_jobs.status stays
 *  'arrived' (the phase lives in job_photos — the 30s sync can't regress it). */
export async function softCompleteCore(user: PhotoUser, data: unknown): Promise<PhaseCompleteResult> {
  const v = z.object({ jobId: z.string().min(1).max(128) }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid request." };
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    if (job.status !== "arrived") return { ok: false, code: "invalid_state", message: "Soft complete is available after arrival." };
    const photos = await jobPhotoRows(user.orgId, job.id);
    const { counts, complete, matchConfirmed } = summarizePhotos(photos);
    if (!complete.pre_arrival || !matchConfirmed) {
      return { ok: false, code: "photos_incomplete", message: `Arrival photos incomplete — ${counts.pre_arrival}/4 sides plus vehicle-match confirmation required.` };
    }
    const q = await db();
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail)
      SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'job_soft_complete', 'job', ${job.id}, jsonb_build_object('from', 'arrived'::text, 'to', 'service'::text, 'photos', ${JSON.stringify(counts)}::jsonb)`;
    return { ok: true, phase: "service" };
  } catch {
    return { ok: false, code: "invalid_state", message: "Unable to mark service complete. Try again." };
  }
}

/** Final complete (service → finalizing): requires all 4 service photos.
 *  Audited; the job is then ready for the completion push (all 12 photos →
 *  Towbook PO → status 5). */
export async function finalCompleteCore(user: PhotoUser, data: unknown): Promise<PhaseCompleteResult> {
  const v = z.object({ jobId: z.string().min(1).max(128) }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid request." };
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    if (job.status !== "arrived") return { ok: false, code: "invalid_state", message: "Final complete is available after arrival." };
    const photos = await jobPhotoRows(user.orgId, job.id);
    const { counts, complete } = summarizePhotos(photos);
    if (!complete.service) {
      return { ok: false, code: "photos_incomplete", message: `Service photos incomplete — ${counts.service}/4 sides required.` };
    }
    const q = await db();
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail)
      SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'job_final_complete', 'job', ${job.id}, jsonb_build_object('from', 'service'::text, 'to', 'finalizing'::text, 'photos', ${JSON.stringify(counts)}::jsonb)`;
    return { ok: true, phase: "finalizing" };
  } catch {
    return { ok: false, code: "invalid_state", message: "Unable to mark final complete. Try again." };
  }
}

/* ------------------------------ Towbook PO upload ------------------------------ */

const TOWBOOK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const driverHeaders = (cookie: string) => ({
  "user-agent": TOWBOOK_UA,
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  cookie,
});
const isExpiredRes = (r: { ok: boolean; status: number | null; body: unknown }): boolean =>
  r.status === 401 || r.status === 403 ||
  (r.status === 200 && typeof r.body === "string" && /<form/i.test(r.body) && /RequestVerificationToken/i.test(r.body));

const buildMultipart = (fieldName: string, fileName: string, contentType: string, bytes: Uint8Array, boundary: string): Buffer =>
  Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

type TbPhotoRes = { ok: boolean; status: number | null; body: unknown };
/** POST /api/calls/{id}/photos?description=<label> — multipart field `file`
 *  (recon-verified 2026-08-11: the Map SPA uploads exactly this shape and
 *  expects HTTP 201). Injectable fetchImpl for hermetic tests. */
async function tbPhotoUpload(fetchImpl: typeof fetch, session: DriverSession, callId: string, description: string, bytes: Uint8Array): Promise<TbPhotoRes> {
  const boundary = `----ld${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const body = buildMultipart("file", "photo.jpg", "image/jpeg", bytes, boundary);
  try {
    const res = await fetchImpl(`${session.baseUrl}/api/calls/${callId}/photos?description=${encodeURIComponent(description)}`, {
      method: "POST",
      headers: { ...driverHeaders(session.cookies), "content-type": `multipart/form-data; boundary=${boundary}` },
      // Buffer/Uint8Array bodies are valid at runtime (Bun + Node fetch); the
      // DOM BodyInit type is narrower than runtime here.
      body: body as unknown as BodyInit,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text) { try { parsed = JSON.parse(text); } catch { /* keep raw */ } }
    return { ok: res.status === 201 || (res.status >= 200 && res.status < 300), status: res.status, body: parsed };
  } catch (err) {
    return { ok: false, status: null, body: String(err).slice(0, 200) };
  }
}

export type CompleteJobResult =
  | { ok: true; photosUploaded: number; towbookCompleted: boolean; changed: boolean }
  | { ok: false; code: "not_found" | "unauthorized" | "photos_incomplete" | "photo_upload_failed" | "towbook_failed" | "no_session" | "invalid_state" | "completion_capture_required"; message: string; failures?: Array<{ label: string; status: number | null }> };

/** THE completion push (owner spec): the customer completion capture (signature
 *  + survey from the v13 job_completions table) must already be stored, then
 *  all 12 photos (4 pre-arrival + 4 service + 4 final) are read back from B2
 *  and uploaded to the Towbook PO via the DRIVER's session, one by one
 *  (verified per photo, one retry each). Only when every photo landed does the
 *  job complete on Towbook (PUT status 5, verified) and on the platform. Any
 *  failure is recorded + escalated (escalated_photo_upload_failed) and the job
 *  STAYS arrived — a job never reaches completed without its photos on the PO
 *  or its customer capture. Injectable fetchImpl. */
export async function completeJobCore(user: PhotoUser, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<CompleteJobResult> {
  const v = z.object({ jobId: z.string().min(1).max(128) }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid request." };
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    if (job.status !== "arrived") return { ok: false, code: "invalid_state", message: "Complete the job after arrival." };
    const q = await db();
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };

    // Gate (completion flow): the customer completion capture — signature + survey —
    // must be on file BEFORE complete. The tip is OPTIONAL and never blocks.
    const comp = await import("./completion-core").then((m) => m.completionCaptureForJob(user.orgId, job.id));
    if (!comp.signatureCaptured || !comp.survey) {
      return { ok: false, code: "completion_capture_required", message: "Get the customer's signature and rating before completing the job." };
    }

    // Gate: all three phases complete.
    const photos = await jobPhotoRows(user.orgId, job.id);
    const { counts, complete } = summarizePhotos(photos);
    if (!complete.pre_arrival || !complete.service || !complete.final) {
      return { ok: false, code: "photos_incomplete", message: `Photos incomplete — ${counts.pre_arrival}/4 arrival, ${counts.service}/4 service, ${counts.final}/4 final required.` };
    }

    // No Towbook id → nothing to attach to; complete on-platform only (audited).
    if (!job.towbookJobId) {
      await markPlatformCompleted(user, job, { towbook: "skipped (no Towbook id)", photosUploaded: 12 });
      return { ok: true, photosUploaded: 12, towbookCompleted: false, changed: true };
    }

    const session = await loadDriverSession({ orgId: user.orgId, towbookDriverId: user.towbookDriverId });
    if (!session) return { ok: false, code: "no_session", message: "No active session — reconnect to keep working." };

    // (1) Push all 12 photos to the Towbook PO, one by one, verified.
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const failures: Array<{ label: string; status: number | null }> = [];
    const attempts: string[] = [];
    let uploaded = 0;
    let b2: { config: Awaited<ReturnType<typeof loadB2Config>>; s3ApiUrl: string } | null = null;
    try {
      const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
      const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl });
      b2 = { config, s3ApiUrl: auth.s3ApiUrl };
    } catch { /* per-photo failures below will surface the B2 problem */ }
    if (!b2) {
      // The photos themselves live in B2 — without it nothing can be forwarded
      // to the PO. Fail loud + escalate; the job stays arrived.
      await recordUploadFailure(user, job, [], attempts, { storage: "b2_not_configured" });
      return { ok: false, code: "photo_upload_failed", message: "Photo storage isn't connected, so the photos can't be attached — ops has been notified." };
    }
    for (const phase of PHOTO_PHASES) {
      for (const side of PHOTO_SIDES) {
        const row = photos[phase][side];
        const label = `${PHASE_LABELS[phase]} ${PHOTO_SIDE_LABELS[side]}`;
        if (!row) { failures.push({ label, status: null }); continue; }
        const got = await getObject({ config: b2.config, s3ApiUrl: b2.s3ApiUrl, key: row.storageKey, fetchImpl });
        if (!got.ok || !got.bytes) { failures.push({ label, status: got.status }); continue; }
        const post = await tbPhotoUpload(fetchImpl, session, job.towbookJobId, label, got.bytes);
        attempts.push(`POST ${label} → ${post.status ?? "network error"} (${post.ok ? "ok" : "failed"})`);
        if (!post.ok && !isExpiredRes(post)) {
          // One retry per photo — transient network/5xx blips shouldn't fail the job.
          const retry = await tbPhotoUpload(fetchImpl, session, job.towbookJobId, label, got.bytes);
          attempts.push(`POST retry ${label} → ${retry.status ?? "network error"} (${retry.ok ? "ok" : "failed"})`);
          if (retry.ok && !isExpiredRes(retry)) { uploaded += 1; continue; }
          failures.push({ label, status: retry.status });
        } else if (post.ok && !isExpiredRes(post)) {
          uploaded += 1;
        } else {
          failures.push({ label, status: post.status });
        }
      }
    }

    // (2) Any failure → escalate + stay arrived. NEVER complete without photos.
    if (failures.length > 0) {
      await recordUploadFailure(user, job, failures, attempts, { sessionExpired: attempts.some((a) => a.includes("session")) });
      try {
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'job_photo_upload_failed', 'job', ${job.id}, ${JSON.stringify({ towbookJobId: job.towbookJobId, uploaded, failed: failures, attempts })}::jsonb, 'driver-photos'`;
      } catch { /* best-effort */ }
      return { ok: false, code: "photo_upload_failed", message: `${failures.length} photo${failures.length === 1 ? "" : "s"} couldn't be attached — ops has been notified.`, failures };
    }

    // (3) All photos on the PO → complete on Towbook (PUT status 5, verified).
    const numericId = Number(job.towbookJobId);
    const idForBody = Number.isInteger(numericId) && numericId > 0 ? numericId : job.towbookJobId;
    const put = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls/${job.towbookJobId}`, session, {
      method: "PUT",
      body: JSON.stringify({ id: idForBody, status: { id: 5 } }),
    });
    attempts.push(`PUT /api/calls/${job.towbookJobId} → ${put.status ?? "network error"} (${put.ok ? "ok" : "failed"})`);
    let towbookCompleted = false;
    if (put.ok && !isExpiredRes(put)) {
      const getRes = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls/${job.towbookJobId}`, session);
      attempts.push(`GET verify → ${getRes.status ?? "network error"}`);
      const call = getRes.ok && getRes.body && typeof getRes.body === "object" ? (getRes.body as Record<string, unknown>) : null;
      const statusId = call ? extractStatusId(call.status) : null;
      towbookCompleted = statusId === 5;
      if (!towbookCompleted) attempts.push(`verification shows status ${statusId ?? "unknown"} — NOT completed on Towbook`);
    }
    if (!towbookCompleted) {
      await recordUploadFailure(user, job, [], attempts, { sessionExpired: isExpiredRes(put) });
      try {
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'job_completion_failed', 'job', ${job.id}, ${JSON.stringify({ towbookJobId: job.towbookJobId, photosUploaded: uploaded, attempts })}::jsonb, 'driver-photos'`;
      } catch { /* best-effort */ }
      return { ok: false, code: "towbook_failed", message: "Photos are attached but completion wasn't confirmed — ops has been notified.", failures };
    }

    await markPlatformCompleted(user, job, { towbook: "verified status 5", photosUploaded: uploaded, attempts });
    return { ok: true, photosUploaded: uploaded, towbookCompleted: true, changed: true };
  } catch (err) {
    return { ok: false, code: "invalid_state", message: err instanceof Error ? err.message : "Unable to complete the job. Try again." };
  }
}

function extractStatusId(status: unknown): number | null {
  if (status == null) return null;
  if (typeof status === "number") return Number.isFinite(status) ? status : null;
  if (typeof status === "string" && status.trim() !== "") { const n = Number(status); return Number.isFinite(n) ? n : null; }
  if (Array.isArray(status)) return status.length === 1 ? extractStatusId(status[0]) : null;
  if (typeof status === "object") {
    const o = status as Record<string, unknown>;
    if (typeof o.id === "number") return o.id;
    if (typeof o.id === "string" && o.id.trim() !== "") { const n = Number(o.id); return Number.isFinite(n) ? n : null; }
    const next = o.next && typeof o.next === "object" && !Array.isArray(o.next) ? (o.next as Record<string, unknown>) : null;
    if (next && next.statusId != null) return extractStatusId(next.statusId);
  }
  return null;
}

/** Platform write-through: dispatch_jobs → completed (guarded from 'arrived'
 *  only — a racing transition can never be overwritten) + status_events +
 *  audit. Mirrors the driver-portal writeThrough pattern. */
async function markPlatformCompleted(user: PhotoUser, job: { id: string; towbookJobId: string | null }, detail: Record<string, unknown>): Promise<void> {
  const q = await db();
  await q.transaction([
    q`WITH changed AS (
        UPDATE dispatch_jobs SET status='completed', completed_at=NOW(), towbook_status='5'
        WHERE id=${job.id} AND org_id=${user.orgId} AND status='arrived'
        RETURNING id, org_id, 'arrived'::text AS old_status
      )
      INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
      SELECT gen_random_uuid()::text, org_id, id, old_status, 'completed', ${user.id}, 'contractor', 'driver completed job (Lightning Dispatch)'
      FROM changed RETURNING job_id`,
    q`SELECT 1`,
  ]);
  try {
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'driver_job_complete', 'job', ${job.id}, ${JSON.stringify({ towbookJobId: job.towbookJobId, ...detail })}::jsonb, 'driver-photos'`;
  } catch { /* best-effort audit */ }
}

/** Escalation into the decision ledger (the ops "Needs attention" banner reads
 *  it). Fixed dedupe key per call — the same failure never spams. */
async function recordUploadFailure(
  user: PhotoUser,
  job: { id: string; towbookJobId: string | null },
  failures: Array<{ label: string; status: number | null }>,
  attempts: string[],
  extra: Record<string, unknown>,
): Promise<void> {
  try {
    const q = await db();
    const names = await q`SELECT name FROM users WHERE id=${user.id} LIMIT 1`;
    const driverName = names.length ? String(names[0].name ?? "") : "";
    const reason = failures.length
      ? `Completion for ${job.id} could not attach ${failures.length} photo${failures.length === 1 ? "" : "s"} to the Towbook PO: ${failures.map((f) => `${f.label} (HTTP ${f.status ?? "error"})`).join(", ")}`
      : `Completion for ${job.id} could not be confirmed on Towbook: ${attempts.at(-1) ?? "unknown"}`;
    await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response)
      VALUES(gen_random_uuid()::text, ${user.orgId}, ${`photo-upload-${job.towbookJobId ?? job.id}`}, ${job.towbookJobId}, 'escalated_photo_upload_failed', TRUE, ${user.towbookDriverId}, ${driverName}, NULL, NULL, ${reason}, ${JSON.stringify({ failures, attempts, ...extra })}::jsonb)
      ON CONFLICT DO NOTHING`;
  } catch { /* never mask the outcome */ }
}

/* ----------------------------------- reads ----------------------------------- */

export type PhotoReadResult =
  | { ok: true; status: JobPhotoStatus }
  | { ok: false; code: "not_found" | "unauthorized" | "invalid_state"; message: string };

/** Driver / owner / ops read of one job's photo status. */
export async function getJobPhotoStatusCore(user: { orgId: string; role: string; id: string; towbookDriverId: string }, data: unknown): Promise<PhotoReadResult> {
  const v = z.object({ jobId: z.string().min(1).max(128) }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid request." };
  try {
    await ensure();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found." };
    if (user.role === "contractor") {
      const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
      if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
    }
    return { ok: true, status: await photoStatusForJob(user.orgId, job) };
  } catch {
    return { ok: false, code: "invalid_state", message: "Unable to load photo status." };
  }
}

/** Owner/ops: photo status for every job in the org (lightweight — one query,
 *  used by the dispatch queue cards). */
export async function allJobPhotoStatusesCore(orgId: string): Promise<JobPhotoStatus[]> {
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, status, towbook_job_id, raw_json, assigned_contractor_id FROM dispatch_jobs WHERE org_id=${orgId}`;
    const out: JobPhotoStatus[] = [];
    for (const r of rows as Record<string, unknown>[]) {
      const job: ResolvedJob = {
        id: String(r.id),
        status: r.status != null ? String(r.status) : null,
        towbookJobId: r.towbook_job_id != null ? String(r.towbook_job_id) : null,
        raw: r.raw_json && typeof r.raw_json === "object" ? (r.raw_json as Record<string, unknown>) : null,
        assignedContractorId: r.assigned_contractor_id != null ? String(r.assigned_contractor_id) : null,
      };
      out.push(await photoStatusForJob(orgId, job));
    }
    return out;
  } catch {
    return [];
  }
}

/* --------------------------------- server fn handlers --------------------------------- */

export async function uploadJobPhotoHandler(data: unknown, opts?: { fetchImpl?: typeof fetch }): Promise<PhotoUploadResult> {
  if (!configured()) return { ok: false, code: "b2_not_configured", message: "Photo uploads require database mode." };
  const u = await resolvePhotoUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in as a driver first." };
  return uploadJobPhotoCore(u, data, opts);
}

export async function setVehicleMatchHandler(data: unknown): Promise<ConfirmMatchResult> {
  if (!configured()) return { ok: false, code: "invalid_state", message: "Requires database mode." };
  const u = await resolvePhotoUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in as a driver first." };
  return setVehicleMatchCore(u, data);
}

export async function softCompleteHandler(data: unknown): Promise<PhaseCompleteResult> {
  if (!configured()) return { ok: false, code: "invalid_state", message: "Requires database mode." };
  const u = await resolvePhotoUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in as a driver first." };
  return softCompleteCore(u, data);
}

export async function finalCompleteHandler(data: unknown): Promise<PhaseCompleteResult> {
  if (!configured()) return { ok: false, code: "invalid_state", message: "Requires database mode." };
  const u = await resolvePhotoUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in as a driver first." };
  return finalCompleteCore(u, data);
}

export async function completeJobHandler(data: unknown, opts?: { fetchImpl?: typeof fetch }): Promise<CompleteJobResult> {
  if (!configured()) return { ok: false, code: "invalid_state", message: "Requires database mode." };
  const u = await resolvePhotoUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in as a driver first." };
  return completeJobCore(u, data, opts);
}

export async function getJobPhotoStatusHandler(data: unknown): Promise<PhotoReadResult> {
  if (!configured()) return { ok: false, code: "invalid_state", message: "Requires database mode." };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in first." };
  const q = await db();
  const rows = await q`SELECT towbook_driver_id FROM users WHERE id=${u.id}`;
  return getJobPhotoStatusCore(
    { orgId: u.orgId, role: u.role, id: u.id, towbookDriverId: rows.length ? String(rows[0].towbook_driver_id ?? "") : "" },
    data,
  );
}

export async function allJobPhotoStatusesHandler(): Promise<JobPhotoStatus[]> {
  if (!configured()) return [];
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || (u.role !== "owner" && u.role !== "admin" && u.role !== "dispatcher")) return [];
  return allJobPhotoStatusesCore(u.orgId);
}
