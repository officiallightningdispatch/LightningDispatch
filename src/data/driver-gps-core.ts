/**
 * GPS tracking + geofence auto-arrive — SERVER-ONLY core (milestone #3).
 * Imported ONLY by the client-safe facade (src/data/driver-gps.ts, which
 * defines the createServerFn stubs whose handlers dynamic-import this module)
 * and by hermetic tests. Static server imports are fine here — this module
 * never enters the client bundle graph.
 */
import { z } from "zod";
import { driverCheckin, type DriverSession } from "./driver-auth";

/* ----------------- Towbook session/HTTP helpers (server-only) ----------------- */
/* These four helpers live HERE (server-only), NOT in driver-auth.ts: driver-auth
 * is client-reachable, and a plain export that dynamic-imports a server-only
 * module pulls auth-server/db/node:crypto into the client bundle (the
 * 'randomBytes is not exported by __vite-browser-external' client-build leak).
 * driver-auth keeps ONLY private tbFetch/isExpired (b15211c surface) for its
 * own exported plain functions identifyDriver/driverCheckin/driverCheckout,
 * which may not dynamic-import a server-only module; callHasDriver and
 * loadDriverSession have NO copy in driver-auth — its handlers and
 * handler-only private functions dynamic-import them from here. */

const TOWBOOK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const driverHeaders = (cookie: string) => ({
  "user-agent": TOWBOOK_UA,
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  cookie,
});
type TbRes = { ok: boolean; status: number | null; body: unknown };
export async function tbFetch(fetchImpl: typeof fetch, url: string, session: DriverSession, init?: { method?: string; body?: string }): Promise<TbRes> {
  try {
    const res = await fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: init?.method === "POST" || init?.method === "PUT"
        ? { ...driverHeaders(session.cookies), "content-type": "application/json" }
        : driverHeaders(session.cookies),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      ...(init?.body ? { body: init.body } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text) { try { body = JSON.parse(text); } catch { /* keep raw text */ } }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
  } catch (err) {
    return { ok: false, status: null, body: String(err).slice(0, 200) };
  }
}
/** True when a response means the session cookie is dead (401/403, or a 200
 *  that is actually the login page HTML — the MVC login form fingerprint). */
export const isExpired = (r: TbRes): boolean =>
  r.status === 401 || r.status === 403 ||
  (r.status === 200 && typeof r.body === "string" && /<form/i.test(r.body) && /RequestVerificationToken/i.test(r.body));
/** Mirrors ai-dispatcher.ts callHasDriver: true when the call's assets assign it
 *  to this driver (assets[].driver.id or assets[].drivers[].driver.id). */
export function callHasDriver(call: unknown, driverId: number): boolean {
  if (!call || typeof call !== "object") return false;
  const assets = (call as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return false;
  return assets.some((a) => {
    if (!a || typeof a !== "object") return false;
    const asset = a as Record<string, unknown>;
    const driver = asset.driver as Record<string, unknown> | undefined;
    if (driver && Number(driver.id) === driverId) return true;
    const drivers = asset.drivers;
    return Array.isArray(drivers) && drivers.some((d) => {
      if (!d || typeof d !== "object") return false;
      const sub = ((d as Record<string, unknown>).driver ?? null) as Record<string, unknown> | null;
      return sub != null && Number(sub.id) === driverId;
    });
  });
}
/** Load a driver's stored Towbook session (session_kind='driver'), decrypting
 *  with the same towbook-key path the driver portal uses. Returns null when no
 *  session row exists or the decrypt fails. */
export async function loadDriverSession(user: { orgId: string; towbookDriverId: string }): Promise<DriverSession | null> {
  await ensure();
  const q = await db();
  const rows = await q`SELECT encrypted_session FROM towbook_sessions WHERE org_id=${user.orgId} AND session_kind='driver' AND towbook_driver_id=${user.towbookDriverId} LIMIT 1`;
  if (!rows.length || !String(rows[0].encrypted_session || "").length) return null;
  try {
    const { decryptSession } = await import("./towbook-key");
    const plain = await decryptSession(String(rows[0].encrypted_session));
    const parsed = JSON.parse(plain) as { cookies?: string; baseUrl?: string };
    if (!parsed.cookies) return null;
    return { cookies: parsed.cookies, baseUrl: parsed.baseUrl || "https://app.towbook.com" };
  } catch {
    return null;
  }
}

/** Store (or refresh) the driver's encrypted Towbook session row:
 *  session_kind='driver', keyed by (org_id, towbook_driver_id). Server-only
 *  home (moved out of the client-reachable driver-auth.ts per the client-graph
 *  rule): driverLogin and driverReconnectCore persist sessions from here. */
export async function persistDriverSession(orgId: string, driverId: string, session: DriverSession): Promise<void> {
  await ensure();
  const q = await db();
  const { encryptSession } = await import("./towbook-key");
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id, error, updated_at)
    VALUES(${orgId}, ${await encryptSession(JSON.stringify({ cookies: session.cookies, baseUrl: session.baseUrl }))}, 'connected', 'driver', ${driverId}, NULL, NOW())
    ON CONFLICT (org_id, towbook_driver_id) WHERE session_kind='driver' AND towbook_driver_id IS NOT NULL
    DO UPDATE SET encrypted_session=EXCLUDED.encrypted_session, status='connected', error=NULL, updated_at=NOW()`;
}
/** True when the LD users row for a driver is soft-deactivated (removed by the
 *  owner — contractor edit/remove feature). driverLogin refuses deactivated
 *  drivers BEFORE persisting a session, so a removed contractor cannot sign in
 *  even with valid Towbook credentials.
 *  Keyed on BOTH the Towbook DRIVER id (the normal assignment key) and the
 *  Towbook USER id (harden 2026-08-12): the roster-fallback resolution writes
 *  towbook_driver_id = the Towbook user id, and a deactivated row whose
 *  towbook_driver_id changed between sign-ins still matches via the stable
 *  towbook_user_id — a removed contractor can never slip back in through an id
 *  shift. */
export async function isDriverDeactivated(orgId: string, towbookDriverId: string): Promise<boolean> {
  await ensure();
  const q = await db();
  const rows = await q`SELECT u.deactivated_at
    FROM users u
    JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${orgId} AND m.role = 'contractor'
    WHERE u.towbook_driver_id = ${towbookDriverId} OR u.towbook_user_id = ${towbookDriverId}
    LIMIT 1`;
  return rows.length > 0 && rows[0].deactivated_at != null;
}

/* --------------------------------- geometry --------------------------------- */

const EARTH_RADIUS_METERS = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance between two lat/lng pairs in METERS (the geofence
 *  radius unit). Pure + exported so tests assert exact values. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

/* --------------------------------- settings --------------------------------- */

export type GeofenceSettings = { geofenceRadiusMeters: number; photosRequired: boolean };

/** Load the org's geofence settings, lazily creating the org_settings row with
 *  the owner-directed defaults (150 m radius, photos gate ON — the owner's spec
 *  gates auto-arrive on the 4 pre-arrival photos + vehicle-match confirmation;
 *  the toggle stays owner-adjustable in settings). */
export async function getGeofenceSettings(orgId: string): Promise<GeofenceSettings> {
  const q = await db();
  await q`INSERT INTO org_settings(org_id) VALUES(${orgId}) ON CONFLICT(org_id) DO NOTHING`;
  const rows = await q`SELECT geofence_radius_meters, photos_required FROM org_settings WHERE org_id=${orgId}`;
  const r = rows[0] as Record<string, unknown> | undefined;
  const radius = Number(r?.geofence_radius_meters ?? 150);
  return {
    geofenceRadiusMeters: Number.isFinite(radius) && radius > 0 ? radius : 150,
    photosRequired: r ? r.photos_required !== false : true,
  };
}

/* ------------------------------- ping persistence ------------------------------- */

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

/** Append a ping row, then prune anything older than 24h (append-light: the
 *  table stays small and the owner map only ever needs the last ~60 min). */
export async function storePing(opts: {
  orgId: string;
  userId: string;
  towbookDriverId: string;
  jobId: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
}): Promise<void> {
  const q = await db();
  await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, job_id, latitude, longitude, accuracy)
    VALUES(gen_random_uuid()::text, ${opts.orgId}, ${opts.userId}, ${opts.towbookDriverId}, ${opts.jobId}, ${opts.latitude}, ${opts.longitude}, ${opts.accuracy})`;
  await q`DELETE FROM driver_locations WHERE org_id=${opts.orgId} AND captured_at < NOW() - INTERVAL '24 hours'`;
}

/* --------------------------------- photos gate --------------------------------- */

/** The auto-arrive photos gate (owner spec): pre_arrival is complete when the
 *  job has all 4 vehicle-side photos in job_photos AND at least one row carries
 *  the driver's vehicle-match confirmation (retakes reset the flag, so the
 *  confirmation always applies to the current photo set). The photo workflow
 *  (#4) writes job_photos; this gate only READS it, and only when the org's
 *  photos_required is on. */
export async function photosCompleteForJob(orgId: string, jobId: string): Promise<boolean> {
  const q = await db();
  const rows = await q`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE match_confirmed)::int AS confirmed
    FROM job_photos WHERE org_id=${orgId} AND job_id=${jobId} AND phase='pre_arrival'`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return Number(r?.n ?? 0) >= 4 && Number(r?.confirmed ?? 0) >= 1;
}

/* ------------------------------ geofence engine ------------------------------ */

type GeofenceJob = {
  id: string;
  towbookJobId: string | null;
  lat: number;
  lng: number;
  raw: Record<string, unknown> | null;
  assignedContractorId: string | null;
};

/** The org's en_route jobs that HAVE a pickup waypoint (pickup_lat/lng is
 *  populated by the sync/import; NULL means no coords → cannot geofence). */
async function findEnRouteJobs(orgId: string): Promise<GeofenceJob[]> {
  const q = await db();
  const rows = await q`SELECT id, towbook_job_id, pickup_lat, pickup_lng, raw_json, assigned_contractor_id
    FROM dispatch_jobs
    WHERE org_id=${orgId} AND status='en_route' AND pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL`;
  return rows.map((r: Record<string, unknown>) => ({
    id: String(r.id),
    towbookJobId: r.towbook_job_id != null ? String(r.towbook_job_id) : null,
    lat: Number(r.pickup_lat),
    lng: Number(r.pickup_lng),
    raw: r.raw_json && typeof r.raw_json === "object" ? (r.raw_json as Record<string, unknown>) : null,
    assignedContractorId: r.assigned_contractor_id != null ? String(r.assigned_contractor_id) : null,
  }));
}

/** The pinging LD user's dispatch_contractors id (legacy manual jobs assign by
 *  contractor id; Towbook jobs carry the driver on the call's assets instead). */
async function driverContractorId(orgId: string, userId: string): Promise<string | null> {
  const q = await db();
  const rows = await q`SELECT contractor_id FROM organization_memberships WHERE org_id=${orgId} AND user_id=${userId} LIMIT 1`;
  return rows.length && rows[0].contractor_id != null ? String(rows[0].contractor_id) : null;
}

/** Mirrors server.ts extractTowbookStatusId — reads the status id off a raw
 *  Towbook call ({id}, {id,next:{statusId}}, string, number, arrays). */
function extractTowbookStatusId(status: unknown): number | null {
  if (status == null) return null;
  if (typeof status === "number" || typeof status === "string") {
    const n = Number(status);
    return Number.isFinite(n) && String(status).trim() !== "" ? n : null;
  }
  if (Array.isArray(status)) return status.length === 1 ? extractTowbookStatusId(status[0]) : null;
  if (typeof status === "object") {
    const o = status as Record<string, unknown>;
    const byId = typeof o.id === "number" ? o.id : typeof o.id === "string" && o.id.trim() !== "" ? Number(o.id) : null;
    if (byId != null && Number.isFinite(byId)) return byId;
    const next = o.next && typeof o.next === "object" && !Array.isArray(o.next) ? (o.next as Record<string, unknown>) : null;
    if (next) {
      const byNext = typeof next.statusId === "number" ? next.statusId : typeof next.statusId === "string" && next.statusId.trim() !== "" ? Number(next.statusId) : null;
      if (byNext != null && Number.isFinite(byNext)) return byNext;
    }
  }
  return null;
}

export type GeofenceOutcome =
  | { action: "none"; reason: string }
  | { action: "arrived"; jobId: string; towbookJobId: string | null; towbookOk: boolean; verified: boolean; detail: string };

/** The geofence check, run after every stored ping. Finds the driver's en_route
 *  job(s), computes haversine meters from the ping to the pickup waypoint, and
 *  auto-arrives the first job inside the radius whose photos gate passes.
 *  Never throws (every failure mode is a "none" outcome or a recorded
 *  escalation). Injectable fetchImpl for hermetic tests. */
export async function evaluateGeofence(opts: {
  orgId: string;
  userId: string;
  towbookDriverId: string;
  lat: number;
  lng: number;
  fetchImpl?: typeof fetch;
}): Promise<GeofenceOutcome> {
  if (!Number.isFinite(opts.lat) || !Number.isFinite(opts.lng)) return { action: "none", reason: "no valid GPS fix" };
  // Geolocation-denied sentinel — never auto-arrive on a 0,0 fix.
  if (opts.lat === 0 && opts.lng === 0) return { action: "none", reason: "no valid GPS fix (0,0)" };
  const settings = await getGeofenceSettings(opts.orgId);
  const jobs = await findEnRouteJobs(opts.orgId);
  if (!jobs.length) return { action: "none", reason: "no en-route job with pickup coords" };
  const contractorId = await driverContractorId(opts.orgId, opts.userId);
  const driverIdNum = Number(opts.towbookDriverId);
  for (const job of jobs) {
    // Wrong-driver rail: the ping may only auto-arrive the driver's OWN job.
    let assigned = false;
    if (job.assignedContractorId && contractorId && job.assignedContractorId === contractorId) assigned = true;
    if (!assigned && job.raw && driverIdNum > 0 && Number.isFinite(driverIdNum)) assigned = callHasDriver(job.raw, driverIdNum);
    if (!assigned) continue;
    const meters = haversineMeters(opts.lat, opts.lng, job.lat, job.lng);
    if (meters > settings.geofenceRadiusMeters) continue;
    // Photos gate (owner spec) — only when the org requires it.
    if (settings.photosRequired) {
      const ok = await photosCompleteForJob(opts.orgId, job.id);
      if (!ok) return { action: "none", reason: "photos gate not satisfied (photos_required=true)" };
    }
    return await autoArrive({ orgId: opts.orgId, userId: opts.userId, towbookDriverId: opts.towbookDriverId, job, fetchImpl: opts.fetchImpl });
  }
  return { action: "none", reason: "driver not inside an assigned job geofence" };
}

/** Auto-arrive one job (already inside the radius + gates passed):
 *  (a) on-platform transition (guarded re-check that the job is STILL
 *      en_route — a racing transition can never be overwritten) + status_events,
 *  (b) Towbook PUT status 4 via the DRIVER's session,
 *  (c) verify via GET + record the outcome. A failed Towbook write is recorded
 *      (audit) and escalated into the decision ledger — never swallowed. */
export async function autoArrive(opts: {
  orgId: string;
  userId: string;
  towbookDriverId: string;
  job: GeofenceJob;
  fetchImpl?: typeof fetch;
}): Promise<GeofenceOutcome> {
  const { orgId, userId, job } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const attempts: string[] = [];
  // (a) Platform transition — ONLY from en_route.
  const q = await db();
  const trows = await q.transaction([
    q`WITH changed AS (
        UPDATE dispatch_jobs SET status='arrived', arrived_at=NOW()
        WHERE id=${job.id} AND org_id=${orgId} AND status='en_route'
        RETURNING id, org_id, 'en_route'::text AS old_status, 'arrived'::text AS new_status
      )
      INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
      SELECT gen_random_uuid()::text, org_id, id, old_status, new_status, ${userId}, 'contractor', ${"geofence auto-arrive (Lightning Dispatch)"}
      FROM changed RETURNING job_id`,
    q`SELECT 1`,
  ]);
  if (!trows[0]?.length) return { action: "none", reason: "job no longer en_route (racing transition)" };

  // (b) Towbook PUT via the driver's session — attribution to the real driver.
  let towbookOk = false;
  let detail = "no Towbook session";
  let session: DriverSession | null = null;
  if (job.towbookJobId) {
    try {
      session = await loadDriverSession({ orgId, towbookDriverId: opts.towbookDriverId });
    } catch { session = null; }
  } else {
    detail = "job has no Towbook id";
  }
  if (session && job.towbookJobId) {
    const numericId = Number(job.towbookJobId);
    const idForBody = Number.isInteger(numericId) && numericId > 0 ? numericId : job.towbookJobId;
    const put = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls/${job.towbookJobId}`, session, {
      method: "PUT",
      body: JSON.stringify({ id: idForBody, status: { id: 3 } }), // 3 = On Scene (corrected 2026-08-12; 4 is Towing)
    });
    attempts.push(`PUT /api/calls/${job.towbookJobId} → ${put.status ?? "network error"} (${put.ok ? "ok" : "failed"})`);
    towbookOk = put.ok && !isExpired(put);
    detail = towbookOk ? "PUT ok" : put.ok ? "session expired on PUT" : `PUT failed (HTTP ${put.status ?? "error"})`;
    // (c) Verify the Towbook status actually changed — GET the call.
    if (towbookOk) {
      const getRes = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls/${job.towbookJobId}`, session);
      attempts.push(`GET /api/calls/${job.towbookJobId} → ${getRes.status ?? "network error"}`);
      const call = getRes.ok && getRes.body && typeof getRes.body === "object" ? (getRes.body as Record<string, unknown>) : null;
      const statusId = call ? extractTowbookStatusId(call.status) : null;
      if (statusId === 3) {
        detail = "PUT ok; verified status 3 (On Scene) on Towbook";
      } else {
        towbookOk = false;
        detail = `PUT returned ok but verification shows status ${statusId ?? "unknown"} — NOT arrived on Towbook`;
      }
    }
  }

  // Outcome audit — always written, success or failure (never swallowed).
  const outcomeDetail = JSON.stringify({
    towbookJobId: job.towbookJobId,
    from: "en_route", to: "arrived",
    towbookOk, verified: towbookOk, attempts,
    photosGate: "passed",
  });
  try {
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${orgId}, ${userId}, 'contractor', 'geofence_auto_arrive', 'job', ${job.id}, ${outcomeDetail}::jsonb, 'driver-gps'`;
  } catch { /* audit-log writes are best-effort — status_events already records the transition */ }

  // Failed Towbook write → escalate into the decision ledger so the ops
  // "Needs attention" banner surfaces it. Fixed key per call: the SAME failure
  // never spams (ON CONFLICT DO NOTHING); the sync reconciles the DB status and
  // the next in-radius ping retries.
  if (!towbookOk && job.towbookJobId) {
    try {
      const names = await q`SELECT name FROM users WHERE id=${userId} LIMIT 1`;
      const driverName = names.length ? String(names[0].name ?? "") : "";
      await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response)
        VALUES(gen_random_uuid()::text, ${orgId}, ${`autoarrive-${job.towbookJobId}`}, ${job.towbookJobId}, 'escalated_auto_arrive_failed', TRUE, ${opts.towbookDriverId}, ${driverName}, NULL, NULL, ${`geofence auto-arrive for ${job.id} did not land on Towbook: ${detail}`}, ${JSON.stringify({ attempts })}::jsonb)
        ON CONFLICT DO NOTHING`;
    } catch { /* never mask the outcome */ }
  }

  return { action: "arrived", jobId: job.id, towbookJobId: job.towbookJobId, towbookOk, verified: towbookOk, detail };
}

/* --------------------------------- server fns --------------------------------- */


export type PingResult =
  | { ok: true; towbookCheckin: "ok" | "warning" | "failed" | "skipped" | "no-session"; geofence: GeofenceOutcome }
  | { ok: false; reason: string };

/** Driver portal location ping (every ~20s while en route/arrived): store +
 *  prune, best-effort Towbook checkin, geofence evaluation. A Towbook checkin
 *  failure or a geofence hiccup NEVER fails the ping. */
export async function pingHandler(data: unknown): Promise<PingResult> {
  const v = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100000).nullable().optional(),
    jobTowbookId: z.string().min(1).max(64).nullable().optional(),
  }).safeParse(data);
  if (!v.success) return { ok: false, reason: "Invalid location ping." };
  if (!configured()) return { ok: false, reason: "GPS pings require database mode." };
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false, reason: "Sign in as a driver first." };
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return { ok: false, reason: "Sign in as a driver first." };
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT towbook_user_id FROM users WHERE id=${identity.userRowId}`;
    const towbookDriverId = identity.towbookDriverId;
    if (!towbookDriverId) return { ok: false, reason: "Your account is not linked to a Towbook driver yet — reconnect." };
    const d = v.data;
    const towbookUserId = rows.length ? String(rows[0].towbook_user_id ?? "") : "";
    const jobRow = d.jobTowbookId
      ? await q`SELECT id FROM dispatch_jobs WHERE org_id=${u.orgId} AND towbook_job_id=${d.jobTowbookId} LIMIT 1`
      : [];
    const jobId = jobRow.length ? String(jobRow[0].id) : null;
    await storePing({ orgId: u.orgId, userId: identity.userRowId, towbookDriverId, jobId, latitude: d.latitude, longitude: d.longitude, accuracy: d.accuracy ?? null });
    // Best-effort Towbook checkin so Towbook has live GPS. Failure must never
    // break the ping loop.
    let towbookCheckin: PingResult extends infer _ ? "ok" | "warning" | "failed" | "skipped" | "no-session" : never = "skipped";
    if (towbookUserId) {
      try {
        const session = await loadDriverSession({ orgId: u.orgId, towbookDriverId });
        if (session) {
          const r = await driverCheckin(session, towbookUserId, d.latitude, d.longitude);
          towbookCheckin = r.ok ? (r.warning ? "warning" : "ok") : "failed";
        } else towbookCheckin = "no-session";
      } catch { towbookCheckin = "failed"; }
    }
    let geofence: GeofenceOutcome = { action: "none", reason: "geofence check unavailable" };
    try {
      geofence = await evaluateGeofence({ orgId: u.orgId, userId: identity.userRowId, towbookDriverId, lat: d.latitude, lng: d.longitude });
    } catch { /* a geofence hiccup never fails the ping */ }
    return { ok: true, towbookCheckin, geofence };
  } catch {
    return { ok: false, reason: "Unable to store your location. Try again." };
  }
};

export type DriverLocationRow = {
  driverId: string;
  driverName: string;
  towbookDriverId: string | null;
  lat: number;
  lng: number;
  accuracy: number | null;
  jobId: string | null;
  jobStatus: string | null;
  towbookJobId: string | null;
  jobCustomer: string | null;
  capturedAt: string;
};

/** Latest ping per driver (last 60 min) for the owner/ops live map. Stale is
 *  computed client-side from capturedAt (>2 min). Exported as a plain function
 *  so the server fn below is a thin session/role wrapper (tests call this). */
export async function latestDriverLocations(orgId: string): Promise<DriverLocationRow[]> {
  const q = await db();
  const rows = await q`SELECT DISTINCT ON (dl.driver_id)
      dl.driver_id, u.name AS driver_name, dl.towbook_driver_id, dl.latitude, dl.longitude, dl.accuracy, dl.job_id, dl.captured_at,
      j.status AS job_status, j.towbook_job_id, j.customer_name AS job_customer
    FROM driver_locations dl
    JOIN users u ON u.id = dl.driver_id
    LEFT JOIN dispatch_jobs j ON j.id = dl.job_id AND j.org_id = dl.org_id
    WHERE dl.org_id=${orgId} AND dl.captured_at > NOW() - INTERVAL '60 minutes'
    ORDER BY dl.driver_id, dl.captured_at DESC`;
  return rows.map((r: Record<string, unknown>) => ({
    driverId: String(r.driver_id),
    driverName: String(r.driver_name ?? "Driver"),
    towbookDriverId: r.towbook_driver_id != null ? String(r.towbook_driver_id) : null,
    lat: Number(r.latitude),
    lng: Number(r.longitude),
    accuracy: r.accuracy != null ? Number(r.accuracy) : null,
    jobId: r.job_id != null ? String(r.job_id) : null,
    jobStatus: r.job_status != null ? String(r.job_status) : null,
    towbookJobId: r.towbook_job_id != null ? String(r.towbook_job_id) : null,
    jobCustomer: r.job_customer != null ? String(r.job_customer) : null,
    capturedAt: new Date(String(r.captured_at)).toISOString(),
  }));
}

/** Latest ping per driver (last 60 min) for the owner/ops live map. Stale is
 *  computed client-side from capturedAt (>2 min). Owner/admin/dispatcher. */
export async function getDriverLocationsHandler(): Promise<DriverLocationRow[]> {
  if (!configured()) return [];
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return [];
  if (u.role !== "owner" && u.role !== "admin" && u.role !== "dispatcher") return [];
  try {
    await ensure();
    return await latestDriverLocations(u.orgId);
  } catch {
    return [];
  }

}

/** Geofence settings for the owner settings card (owner/admin read). */
export async function getGeofenceSettingsHandler(): Promise<GeofenceSettings | null> {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || (u.role !== "owner" && u.role !== "admin")) return null;
  try {
    await ensure();
    return await getGeofenceSettings(u.orgId);
  } catch {
    return null;
  }
}
/** Owner/admin update of the geofence radius + photos gate flag. Every change
 *  is audited (who/what/when). */
export async function updateGeofenceSettingsHandler(data: unknown) {
  const v = z.object({
    geofenceRadiusMeters: z.number().min(0).max(5000),
    photosRequired: z.boolean(),
  }).strict().safeParse(data);
  if (!v.success) return { ok: false as const, error: "Invalid geofence settings." };
  if (!configured()) return { ok: false as const, error: "Geofence settings require database mode." };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: "Sign in required." };
  if (u.role !== "owner" && u.role !== "admin") return { ok: false as const, error: "Only owners and admins can change geofence settings." };
  try {
    await ensure();
    const q = await db();
    const { geofenceRadiusMeters, photosRequired } = v.data;
    await q`INSERT INTO org_settings(org_id, geofence_radius_meters, photos_required) VALUES(${u.orgId}, ${geofenceRadiusMeters}, ${photosRequired})
      ON CONFLICT(org_id) DO UPDATE SET geofence_radius_meters=${geofenceRadiusMeters}, photos_required=${photosRequired}, updated_at=NOW()`;
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail)
      SELECT gen_random_uuid()::text, ${u.orgId}, ${u.id}, ${u.role}, 'geofence_settings', 'org_settings', ${u.orgId}, jsonb_build_object('geofenceRadiusMeters', ${geofenceRadiusMeters}::int, 'photosRequired', ${photosRequired}::boolean)`;
    return { ok: true as const, geofenceRadiusMeters, photosRequired };
  } catch {
    return { ok: false as const, error: "Unable to update geofence settings." };
  }
}
