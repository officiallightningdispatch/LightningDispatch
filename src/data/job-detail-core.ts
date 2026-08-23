/**
 * Job detail expansion (owner spec 2026-08-11, backlog #2) — SERVER-ONLY core.
 *
 * Every job card/tab in the app (ops queue, owner dashboard + job history,
 * driver portal) collapses to full details: customer, phone, service, area,
 * full address when available, lifecycle status, created/assigned/arrived/
 * completed timestamps, the assigned contractor (the bug-batch fix made
 * assigned_contractor_id resolvable — and for synced jobs assigned_driver_name
 * is the real AI-dispatcher/Towbook selection), the note, and the Towbook
 * call/PO ids + ETA fields when present. The 12-photo set (4 pre_arrival + 4
 * service + 4 final) attaches grouped by phase, in upload order, rendered
 * through the EXISTING B2 storage path (job_photos.storage_key → getObject) —
 * no new storage path is invented.
 *
 * Role gates: owner/admin/dispatcher see any org job; a contractor only sees
 * jobs assigned to them (contractor-id link, or the Towbook driver on the
 * call — the same rails as the photo workflow's isAssignedDriver).
 *
 * Testability (same split as driver-photos-core): handlers are thin auth
 * wrappers; these cores take an explicit user context so hermetic tests run
 * without a request/session. Imported ONLY by the client-safe facade
 * (src/data/job-detail.ts, whose createServerFn handlers dynamic-import this
 * module) and by hermetic tests — this module never enters the client bundle
 * (node:crypto lives in b2-client.ts).
 */
import { z } from "zod";
import { loadB2Config, authorizeAccount, getObject } from "./b2-client";
import { isAssignedDriver, jobPhotoRows } from "./driver-photos-core";
import type { PhotoPhase, PhotoSide } from "./driver-photos-core";

/* ----------------------------------- types ----------------------------------- */

export type JobDetailPhoto = {
  /** "pre_arrival" | "service" | "final" — the client groups by this label. */
  phase: PhotoPhase;
  side: PhotoSide;
  uploadedAt: string;
  /** Pre-arrival only: the driver's vehicle-match confirmation. */
  matchConfirmed: boolean;
};

/** Full detail payload for one job card. NULLABLE fields are OMITTED (seroval
 *  rule: never return objects with undefined-valued properties from server
 *  fns). */
export type JobDetail = {
  id: string;
  /** Towbook call id — the "Call #" the driver portal and Towbook use. */
  towbookJobId?: string;
  customerName: string;
  phone?: string;
  serviceType: string;
  area: string;
  pickup?: string;
  dropoff?: string;
  vehicleDesc?: string;
  status: string;
  createdAt: string;
  assignedAt?: string;
  arrivedAt?: string;
  completedAt?: string;
  /** Assigned contractor display name (assigned_driver_name — the real
   *  AI-dispatcher/Towbook selection — falling back to the roster name for
   *  legacy manual assigns). */
  assignedDriverName?: string;
  note?: string;
  /** Towbook purchase-order number when the stored call carried one. */
  purchaseOrderNumber?: string;
  /** Towbook's own arrival ETA timestamp on the call, when present. */
  arrivalETA?: string;
  /** The ETA (minutes) the AI dispatcher quoted for this call in its latest
   *  decision row, when one exists. */
  quotedEtaMinutes?: number;
  /** 12-photo set grouped in upload order; empty for older records with no
   *  photos (the client renders a "No photos" note — never a crash). */
  photos: JobDetailPhoto[];
};

export type JobDetailResult =
  | { ok: true; detail: JobDetail }
  | { ok: false; code: "not_found" | "unauthorized" | "invalid_state" | "database_unavailable"; message: string };

export type JobPhotoResult =
  | { ok: true; dataUrl: string }
  | { ok: false; code: "not_found" | "unauthorized" | "invalid_state" | "database_unavailable"; message: string };

/** The user context handlers resolve from the LD session; cores take it
 *  explicitly so hermetic tests run without a request/session. */
export type JobDetailUser = {
  orgId: string;
  id: string;
  role: string;
  contractorId?: string;
  towbookDriverId: string;
};

const configured = () => Boolean(process.env.DATABASE_URL);
const PHASES: readonly string[] = ["pre_arrival", "service", "final"];
const SIDES: readonly string[] = ["front", "driver_side", "passenger_side", "rear"];
const isPhase = (p: string): p is PhotoPhase => PHASES.includes(p);
const isSide = (s: string): s is PhotoSide => SIDES.includes(s);

const db = () => import("~/db").then((m) => m.sql());

/** Can this user see this job? owner/admin/dispatcher → any org job;
 *  contractor → only jobs assigned to them (contractor-id link, the Towbook
 *  driver on the call, or the bug-batch attribution column — a sync may have
 *  persisted assigned_driver_towbook_id while the trimmed raw_json lost the
 *  assets array). */
async function canSeeJob(
  user: JobDetailUser,
  job: { id: string; status: string | null; towbookJobId: string | null; raw: Record<string, unknown> | null; assignedContractorId: string | null; assignedDriverTowbookId: string | null },
): Promise<boolean> {
  if (user.role === "owner" || user.role === "admin" || user.role === "dispatcher") return true;
  if (user.role !== "contractor") return false;
  if (job.assignedDriverTowbookId && user.towbookDriverId && job.assignedDriverTowbookId === user.towbookDriverId) return true;
  return isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
}

/** Resolve the dispatch_jobs row (LD id OR Towbook call id — the driver portal
 *  works with call ids) with every detail column. */
async function loadJobRow(user: JobDetailUser, jobId: string): Promise<Record<string, unknown> | null> {
  const q = await db();
  const rows = await q`SELECT id, customer_name, phone, lat, lng, area, service_type, status,
      created_at, assigned_at, arrived_at, completed_at, assigned_contractor_id,
      assigned_driver_name, assigned_driver_towbook_id, note,
      customer_phone, vehicle_desc, pickup, dropoff, towbook_job_id, towbook_status,
      raw_json, raw_json#>>'{purchaseOrderNumber}' AS purchase_order_number,
      raw_json#>>'{arrivalETA}' AS arrival_eta,
      quoted_eta_minutes
    FROM dispatch_jobs WHERE org_id=${user.orgId} AND (id=${jobId} OR towbook_job_id=${jobId}) LIMIT 1`;
  return rows.length ? (rows[0] as Record<string, unknown>) : null;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());

/** Fetch a detail photo's bytes from B2 as a data URL. Exported so the
 *  getJobPhoto core reuses it; injectable fetchImpl + stableDir for tests. */
async function photoDataUrl(storageKey: string, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<string | null> {
  const config = await loadB2Config(process.env, { stableDir: opts.b2StableDir });
  const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
  const got = await getObject({ config, s3ApiUrl: auth.s3ApiUrl, key: storageKey, fetchImpl: opts.fetchImpl });
  if (!got.ok || !got.bytes || !got.bytes.length) return null;
  return `data:image/jpeg;base64,${Buffer.from(got.bytes).toString("base64")}`;
}

/* --------------------------------- detail core --------------------------------- */

export async function getJobDetailCore(user: JobDetailUser, data: unknown): Promise<JobDetailResult> {
  const v = z.object({ jobId: z.string().min(1).max(128) }).strict().safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid request." };
  if (!configured()) return { ok: false, code: "database_unavailable", message: "Requires database mode." };
  try {
    const row = await loadJobRow(user, v.data.jobId);
    if (!row) return { ok: false, code: "not_found", message: "Job not found." };
    const job = {
      id: String(row.id),
      status: row.status != null ? String(row.status) : null,
      towbookJobId: row.towbook_job_id != null ? String(row.towbook_job_id) : null,
      raw: row.raw_json && typeof row.raw_json === "object" ? (row.raw_json as Record<string, unknown>) : null,
      assignedContractorId: row.assigned_contractor_id != null ? String(row.assigned_contractor_id) : null,
      assignedDriverTowbookId: row.assigned_driver_towbook_id != null ? String(row.assigned_driver_towbook_id) : null,
    };
    if (!(await canSeeJob(user, job))) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };

    // Assigned contractor name: the bug-batch columns first (real
    // AI-dispatcher/Towbook selection), then a users-row lookup for the REAL
    // roster (manual console assigns write users.id — the legacy
    // dispatch_contractors FK column is empty for real orgs, BUG 1 root cause
    // 2026-08-11), and finally the legacy dispatch_contractors fallback for
    // dev-only fixtures.
    let driverName: string | null = row.assigned_driver_name != null && String(row.assigned_driver_name) !== "" ? String(row.assigned_driver_name) : null;
    if (!driverName && row.assigned_contractor_id != null) {
      const q = await db();
      const usr = await q`SELECT u.name FROM users u JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${user.orgId} AND m.role = 'contractor' WHERE u.id = ${String(row.assigned_contractor_id)} LIMIT 1`;
      if (usr.length && usr[0].name != null) {
        driverName = String(usr[0].name);
      } else {
        const dc = await q`SELECT name FROM dispatch_contractors WHERE id=${String(row.assigned_contractor_id)} AND org_id=${user.orgId} LIMIT 1`;
        if (dc.length && dc[0].name != null) driverName = String(dc[0].name);
      }
    }

    // The AI dispatcher's quoted ETA (SUB B defect 1): prefer the persisted
    // dispatch_jobs.quoted_eta_minutes (written at verified dispatch), then fall
    // back to the latest decision row for legacy rows that predate the column.
    let quotedEtaMinutes: number | null = null;
    if (row.quoted_eta_minutes != null) {
      const persisted = Number(row.quoted_eta_minutes);
      if (Number.isFinite(persisted)) quotedEtaMinutes = persisted;
    }
    if (quotedEtaMinutes == null && job.towbookJobId) {
      const q = await db();
      const dec = await q`SELECT eta_minutes FROM ai_dispatcher_decisions
        WHERE org_id=${user.orgId} AND call_id=${job.towbookJobId} AND eta_minutes IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`;
      if (dec.length && dec[0].eta_minutes != null) quotedEtaMinutes = Number(dec[0].eta_minutes);
    }

    const photoRows = await jobPhotoRows(user.orgId, job.id);
    const photos: JobDetailPhoto[] = [];
    for (const phase of PHASES as PhotoPhase[]) {
      const bySide = photoRows[phase];
      if (!bySide) continue;
      // Upload order per phase: jobPhotoRows groups by phase+side; the row has
      // uploadedAt — sort ascending so the earliest upload renders first.
      const rows = (Object.values(bySide) as Array<{ side: PhotoSide; uploadedAt: string; matchConfirmed: boolean }>)
        .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
      for (const p of rows) {
        photos.push({
          phase,
          side: p.side,
          uploadedAt: p.uploadedAt,
          matchConfirmed: p.matchConfirmed,
        });
      }
    }

    const detail: JobDetail = {
      id: String(row.id),
      customerName: String(row.customer_name),
      serviceType: String(row.service_type),
      area: String(row.area ?? ""),
      status: String(row.status),
      createdAt: iso(row.created_at) ?? new Date().toISOString(),
      photos,
    };
    if (row.towbook_job_id != null && String(row.towbook_job_id) !== "") detail.towbookJobId = String(row.towbook_job_id);
    const phoneVal = row.customer_phone != null && String(row.customer_phone) !== "" ? String(row.customer_phone) : row.phone != null && String(row.phone) !== "" ? String(row.phone) : null;
    if (phoneVal) detail.phone = phoneVal;
    if (row.pickup != null && String(row.pickup) !== "") detail.pickup = String(row.pickup);
    if (row.dropoff != null && String(row.dropoff) !== "") detail.dropoff = String(row.dropoff);
    if (row.vehicle_desc != null && String(row.vehicle_desc) !== "") detail.vehicleDesc = String(row.vehicle_desc);
    const a = iso(row.assigned_at); if (a) detail.assignedAt = a;
    const ar = iso(row.arrived_at); if (ar) detail.arrivedAt = ar;
    const c = iso(row.completed_at); if (c) detail.completedAt = c;
    if (driverName) detail.assignedDriverName = driverName;
    if (row.note != null && String(row.note) !== "") detail.note = String(row.note);
    if (row.purchase_order_number != null && String(row.purchase_order_number) !== "") detail.purchaseOrderNumber = String(row.purchase_order_number);
    if (row.arrival_eta != null && String(row.arrival_eta) !== "") detail.arrivalETA = String(row.arrival_eta);
    if (quotedEtaMinutes != null) detail.quotedEtaMinutes = quotedEtaMinutes;
    return { ok: true, detail };
  } catch {
    return { ok: false, code: "database_unavailable", message: "Unable to load job details." };
  }
}

/* --------------------------------- photo core --------------------------------- */

/** One job photo's bytes as a data URL. The client never supplies a storage
 *  key — it asks by (jobId, phase, side) and the server resolves the row, so
 *  an arbitrary B2 object can never be read through this surface. */
export async function getJobPhotoCore(
  user: JobDetailUser,
  data: unknown,
  opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {},
): Promise<JobPhotoResult> {
  const v = z.object({ jobId: z.string().min(1).max(128), phase: z.string().min(1).max(32), side: z.string().min(1).max(32) }).strict().safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid request." };
  if (!configured()) return { ok: false, code: "database_unavailable", message: "Requires database mode." };
  const { jobId, phase, side } = v.data;
  if (!isPhase(phase) || !isSide(side)) return { ok: false, code: "invalid_state", message: "Invalid photo slot." };
  try {
    const row = await loadJobRow(user, jobId);
    if (!row) return { ok: false, code: "not_found", message: "Job not found." };
    const job = {
      id: String(row.id),
      status: row.status != null ? String(row.status) : null,
      towbookJobId: row.towbook_job_id != null ? String(row.towbook_job_id) : null,
      raw: row.raw_json && typeof row.raw_json === "object" ? (row.raw_json as Record<string, unknown>) : null,
      assignedContractorId: row.assigned_contractor_id != null ? String(row.assigned_contractor_id) : null,
      assignedDriverTowbookId: row.assigned_driver_towbook_id != null ? String(row.assigned_driver_towbook_id) : null,
    };
    if (!(await canSeeJob(user, job))) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
    const q = await db();
    const rows = await q`SELECT storage_key FROM job_photos WHERE org_id=${user.orgId} AND job_id=${job.id} AND phase=${phase} AND side=${side} LIMIT 1`;
    if (!rows.length) return { ok: false, code: "not_found", message: "Photo not found." };
    const key = String(rows[0].storage_key);
    const dataUrl = await photoDataUrl(key, opts);
    if (!dataUrl) return { ok: false, code: "database_unavailable", message: "Photo could not be loaded from storage." };
    return { ok: true, dataUrl };
  } catch {
    return { ok: false, code: "database_unavailable", message: "Unable to load the photo." };
  }
}
