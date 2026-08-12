/**
 * Live map — SERVER-ONLY core (2026-08-11, owner's #1 priority: a real map on
 * the owner portal AND the contractor portal). Imported ONLY by the thin
 * createServerFn facade in src/data/server.ts (whose handler dynamic-imports
 * this module) and by hermetic tests. Reads the LOCAL database only —
 * driver_locations (fresh GPS pings; same source as
 * driver-gps-core.latestDriverLocations) + dispatch_jobs (active jobs with
 * pickup waypoints). NEVER calls Towbook.
 *
 * Role gating:
 *  - owner/admin/dispatcher → ALL drivers with recent pings + ALL active job
 *    pickup pins (with customer + driver attribution).
 *  - contractor → their own position (self) + their own active jobs (full
 *    customer detail) + anonymized "nearby job" pins for other active jobs
 *    (no customer/driver names leaked).
 *
 * Seroval note: every returned object carries explicit nulls (never
 * undefined-valued props) so the client deserializer stays happy.
 */
import { latestDriverLocations } from "./driver-gps-core";

export type LiveMapDriverPin = {
  driverId: string;
  driverName: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  capturedAt: string;
  fresh: boolean;
  jobStatus: string | null;
  jobCustomer: string | null;
};

export type LiveMapJobPin = {
  jobId: string;
  towbookJobId: string | null;
  customerName: string | null;
  serviceType: string | null;
  status: string;
  lat: number;
  lng: number;
  area: string | null;
  driverName: string | null;
  mine: boolean;
  etaMinutes: number | null;
};

export type LiveMapSelfPin = { lat: number; lng: number; capturedAt: string };

export type LiveMapData = {
  generatedAt: string;
  drivers: LiveMapDriverPin[];
  jobs: LiveMapJobPin[];
  self: LiveMapSelfPin | null;
};

/** Jobs shown on the map: everything in flight, offered → arrived. */
const ACTIVE_STATUSES = ["offered", "accepted", "en_route", "arrived"];
/** Mirrors live-driver-map.tsx — a ping older than 2 minutes is stale. */
const STALE_MS = 2 * 60 * 1000;

const configured = () => Boolean(process.env.DATABASE_URL);
const db = () => import("~/db").then((m) => m.sql());

/** A usable waypoint: finite, in range, and not the (0,0) geolocation-denied
 *  sentinel. Towbook jobs carry lat/lng as 0 until the waypoint is populated,
 *  so pickup_lat/lng wins and 0,0 is dropped. */
function validLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    (lat !== 0 || lng !== 0) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

/** The live-map feed for the current session (auth-gated; see header).
 *  Returns null when database mode is off or the user is not signed in.
 *  driverScope=true (driver-portal pages): treat the session as contractor-
 *  scoped even when the role is staff — an owner/admin in driver view
 *  (owner↔contractor view toggle) sees their OWN position (self pin), their
 *  own active jobs with full customer detail, and anonymized nearby pins —
 *  exactly what a contractor sees, keyed to the EFFECTIVE driver identity. */
export async function liveMapDataHandler(driverScope = false): Promise<LiveMapData | null> {
  if (!configured()) return null;
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const isStaff = u.role === "owner" || u.role === "admin" || u.role === "dispatcher";
  const q = await db();
  const nowMs = Date.now();

  // Contractor identity for own-job matching (users carry towbook_driver_id;
  // membership contractor_id is legacy and empty for real orgs). In driver
  // scope the identity is the EFFECTIVE driver (own row or linked row).
  let scoped = !isStaff;
  let effectiveUserRowId = u.id;
  let towbookDriverId: string | null = null;
  if (driverScope && isStaff) {
    const identity = await effectiveDriverIdentity(u);
    if (identity && !identity.deactivated) {
      scoped = true;
      effectiveUserRowId = identity.userRowId;
      towbookDriverId = identity.towbookDriverId;
    } else {
      return null; // staff requested driver scope without a usable identity
    }
  }
  if (!scoped) towbookDriverId = null;

  // Driver positions — latest ping per driver (last 60 min). Staff see
  // everyone; a contractor sees only their own.
  const locations = await latestDriverLocations(u.orgId);
  const drivers: LiveMapDriverPin[] = [];
  let self: LiveMapSelfPin | null = null;
  for (const r of locations) {
    if (scoped && r.driverId !== effectiveUserRowId) continue;
    drivers.push({
      driverId: r.driverId,
      driverName: r.driverName,
      lat: r.lat,
      lng: r.lng,
      accuracy: r.accuracy != null ? r.accuracy : null,
      capturedAt: r.capturedAt,
      fresh: nowMs - new Date(r.capturedAt).getTime() <= STALE_MS,
      jobStatus: r.jobStatus != null ? r.jobStatus : null,
      jobCustomer: r.jobCustomer != null ? r.jobCustomer : null,
    });
    if (scoped && r.driverId === effectiveUserRowId && !self) {
      self = { lat: r.lat, lng: r.lng, capturedAt: r.capturedAt };
    }
  }

  // Job pins — active jobs with a usable pickup waypoint (pickup_lat/lng from
  // the Towbook waypoints, falling back to the legacy lat/lng columns), plus
  // the latest AI-dispatcher quoted ETA for the call when one exists.
  const rows = await q`
    SELECT j.id, j.towbook_job_id, j.customer_name, j.service_type, j.status, j.area,
           j.pickup_lat, j.pickup_lng, j.lat, j.lng,
           j.assigned_driver_name, j.assigned_driver_towbook_id, j.assigned_contractor_id,
           d.eta_minutes
    FROM dispatch_jobs j
    LEFT JOIN LATERAL (
      SELECT a.eta_minutes FROM ai_dispatcher_decisions a
      WHERE a.org_id = j.org_id AND a.call_id = j.towbook_job_id AND a.eta_minutes IS NOT NULL
      ORDER BY a.created_at DESC LIMIT 1
    ) d ON TRUE
    WHERE j.org_id = ${u.orgId} AND j.status IN (${ACTIVE_STATUSES.join(",")})`;
  const jobs: LiveMapJobPin[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const lat = r.pickup_lat != null ? Number(r.pickup_lat) : Number(r.lat ?? 0);
    const lng = r.pickup_lng != null ? Number(r.pickup_lng) : Number(r.lng ?? 0);
    if (!validLatLng(lat, lng)) continue;
    let mine = false;
    if (scoped) {
      mine =
        (r.assigned_contractor_id != null && u.contractorId != null && String(r.assigned_contractor_id) === u.contractorId) ||
        (towbookDriverId != null && r.assigned_driver_towbook_id != null && String(r.assigned_driver_towbook_id) === towbookDriverId);
    }
    jobs.push({
      jobId: String(r.id),
      towbookJobId: r.towbook_job_id != null ? String(r.towbook_job_id) : null,
      customerName: scoped && !mine ? null : String(r.customer_name ?? ""),
      serviceType: r.service_type != null ? String(r.service_type) : null,
      status: String(r.status),
      lat,
      lng,
      area: r.area != null ? String(r.area) : null,
      driverName: scoped && !mine ? null : (r.assigned_driver_name != null ? String(r.assigned_driver_name) : null),
      mine: scoped ? mine : false,
      etaMinutes: r.eta_minutes != null ? Number(r.eta_minutes) : null,
    });
  }

  return { generatedAt: new Date().toISOString(), drivers, jobs, self };
}
