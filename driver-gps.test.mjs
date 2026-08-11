// Hermetic driver-gps tests (2026-08-11, milestone #3): ping storage + pruning,
// geofence auto-arrive inside/outside radius, the on-platform + Towbook write +
// verification path (mocked fetch), escalation on Towbook write failure, and
// the no-fire rails (wrong status, no GPS fix, wrong driver, photos gate when
// enabled). Real Towbook calls never happen; every Towbook-facing function takes
// an injectable fetchImpl. DB-backed against throwaway QA orgs that are fully
// deleted at the end (zero rows left anywhere). Run:
//   DATABASE_URL=... bun driver-gps.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
// Test key for THIS process only (env-first resolution overrides the stable
// key file — same pattern as ai-dispatcher.test.mjs). The QA session rows are
// encrypted with it; the running server is a separate process and never sees it.
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const {
  haversineMeters,
  getGeofenceSettings,
  storePing,
  photosCompleteForJob,
  evaluateGeofence,
  latestDriverLocations,
} = await import("./src/data/driver-gps-core.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

// Three isolated orgs — each with its OWN Towbook driver id (the LD
// users_towbook_driver_id index is globally unique) and its own call id.
const ORG = `qa-gps-${randomUUID()}`;
const ORG2 = `qa-gps2-${randomUUID()}`; // photos-gate org
const ORG3 = `qa-gps3-${randomUUID()}`; // Towbook-write-failure org
const OWNER = `qa-gps-owner-${randomUUID()}`;
const OWNER2 = `qa-gps-owner2-${randomUUID()}`;
const OWNER3 = `qa-gps-owner3-${randomUUID()}`;
const DRIVER = `qa-gps-driver-${randomUUID()}`;
const DRIVER2 = `qa-gps-driver2-${randomUUID()}`;
const DRIVER3 = `qa-gps-driver3-${randomUUID()}`;
const CONF = {
  [ORG]: { userId: DRIVER, tbDriver: "7", tbUser: "42", job: "tb-321001", call: "321001" },
  [ORG2]: { userId: DRIVER2, tbDriver: "8", tbUser: "52", job: "tb-321002", call: "321002" },
  [ORG3]: { userId: DRIVER3, tbDriver: "9", tbUser: "62", job: "tb-321003", call: "321003" },
};
const PICKUP = { lat: 41.2, lng: -73.2 };
/** 0.001° lat ≈ 111.19 m — the standard approximation for asserting haversine. */
const northMeters = (m) => PICKUP.lat + m / 111190;
const eastMeters = (m) => PICKUP.lng + m / (111190 * Math.cos((PICKUP.lat * Math.PI) / 180));

const rawCall = (callId, driverId, statusId) => ({
  id: Number(callId),
  callNumber: Number(callId),
  status: { id: statusId },
  waypoints: [{ address: "70 Pitt Street", zip: "06606", latitude: PICKUP.lat, longitude: PICKUP.lng }],
  assets: [{ id: 603482, name: "QA Driver", driver: { id: driverId } }],
  account: { company: "QA Customer" },
});

const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() { return JSON.stringify(body); },
  async json() { return JSON.parse(JSON.stringify(body)); },
});

/** Mock Towbook fetch for the geofence write+verify path. Records every call.
 *  PUT /api/calls/{id} returns putStatus; the verification GET returns the call
 *  with status id getStatusId (default 4 = arrived). Throws on any URL outside
 *  the documented surface — a stray call fails the test. */
function makeFetch({ callId, putStatus = 200, getStatusId = 4 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u.endsWith(`/api/calls/${callId}`) && method === "PUT") {
      return putStatus >= 200 && putStatus < 300
        ? jsonResponse(putStatus, { id: Number(callId), status: { id: 4 } })
        : jsonResponse(putStatus, { message: "boom" });
    }
    if (u.endsWith(`/api/calls/${callId}`) && method === "GET") {
      return jsonResponse(200, { id: Number(callId), status: { id: getStatusId } });
    }
    throw new Error(`unexpected Towbook call: ${method} ${u}`);
  };
  return { fetchImpl, calls };
}

async function setup() {
  await ensureSchema();
  for (const [org, owner, driver, tbDriver, tbUser, job, callId] of [
    [ORG, OWNER, DRIVER, "7", "42", "tb-321001", "321001"],
    [ORG2, OWNER2, DRIVER2, "8", "52", "tb-321002", "321002"],
    [ORG3, OWNER3, DRIVER3, "9", "62", "tb-321003", "321003"],
  ]) {
    await q`INSERT INTO organizations(id, name) VALUES(${org}, 'qa driver-gps')`;
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${owner}, 'QA GPS Owner', ${`gps-owner-${randomUUID()}@qa.local`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${owner}, 'owner')`;
    await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id, towbook_user_id) VALUES(${driver}, 'QA Driver', ${`gps-driver-${randomUUID()}@qa.local`}, 'x', ${tbDriver}, ${tbUser})`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${driver}, 'contractor')`;
    await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id)
      VALUES(${org}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected', 'driver', ${tbDriver})`;
    await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, pickup, towbook_status, raw_json, pickup_lat, pickup_lng)
      VALUES(${job}, ${org}, 'QA Customer', '', 0, 0, 'Bridgeport', 'flatbed_tow', 'en_route', NOW(), '', ${callId}, '70 Pitt Street', '3', ${JSON.stringify(rawCall(callId, Number(tbDriver), 3))}::jsonb, ${PICKUP.lat}, ${PICKUP.lng})`;
    // Milestone #4: photos_required now defaults ON (migration v12). The main
    // gps flow (ORG) and the Towbook-write-failure flow (ORG3) are exercised
    // with the gate OFF (photos aren't their subject); ORG2 is the gate org.
    await q`INSERT INTO org_settings(org_id, geofence_radius_meters, photos_required) VALUES(${org}, 150, ${org === ORG2})`;
  }
}
await setup();

/* ------------------------------ pure geometry ------------------------------ */
{
  const m = haversineMeters(PICKUP.lat, PICKUP.lng, northMeters(100), PICKUP.lng);
  check("haversine ~100m per 0.0009° lat", Math.abs(m - 100) < 3, `got ${m}`);
  const m2 = haversineMeters(PICKUP.lat, PICKUP.lng, PICKUP.lat, eastMeters(100));
  check("haversine ~100m east", Math.abs(m2 - 100) < 3, `got ${m2}`);
  check("haversine zero at same point", haversineMeters(1, 2, 1, 2) === 0);
}

/* ------------------------- settings defaults + update ------------------------- */
{
  const s = await getGeofenceSettings(ORG);
  check("default radius 150m", s.geofenceRadiusMeters === 150, JSON.stringify(s));
  check("photos gate off for the main gps org (explicit)", s.photosRequired === false, JSON.stringify(s));
  // Migration v12 flips the org_settings default to TRUE (owner spec: auto-
  // arrive is gated on photos) — a brand-new org gets the gate ON.
  const freshOrg = `qa-gps-default-${randomUUID()}`;
  await q`INSERT INTO organizations(id, name) VALUES(${freshOrg}, 'qa driver-gps')`;
  const fresh = await getGeofenceSettings(freshOrg);
  check("photos gate default ON (milestone #4)", fresh.photosRequired === true, JSON.stringify(fresh));
  await q`DELETE FROM organizations WHERE id=${freshOrg}`;
}

/* ------------------------------- ping storage ------------------------------- */
{
  const c = CONF[ORG];
  await storePing({ orgId: ORG, userId: c.userId, towbookDriverId: c.tbDriver, jobId: c.job, latitude: northMeters(50), longitude: PICKUP.lng, accuracy: 8 });
  const rows = await latestDriverLocations(ORG);
  check("ping stored + joined with driver name", rows.length === 1 && rows[0].driverName === "QA Driver" && rows[0].jobStatus === "en_route" && rows[0].accuracy === 8 && Math.abs(rows[0].lat - northMeters(50)) < 1e-9, JSON.stringify(rows));
  // Append-light prune: an old ping (>24h) is deleted on the next write.
  await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, job_id, latitude, longitude, accuracy, captured_at)
    VALUES(gen_random_uuid()::text, ${ORG}, ${c.userId}, ${c.tbDriver}, ${c.job}, 41.1, -73.1, NULL, NOW() - INTERVAL '25 hours')`;
  await storePing({ orgId: ORG, userId: c.userId, towbookDriverId: c.tbDriver, jobId: c.job, latitude: northMeters(80), longitude: PICKUP.lng, accuracy: 12 });
  const pruned = await q`SELECT COUNT(*)::int AS n FROM driver_locations WHERE org_id=${ORG} AND captured_at < NOW() - INTERVAL '24 hours'`;
  const total = await q`SELECT COUNT(*)::int AS n FROM driver_locations WHERE org_id=${ORG}`;
  check("prune removed >24h rows", Number(pruned[0].n) === 0 && Number(total[0].n) === 2, JSON.stringify(total));
}

/* --------------------------- geofence: inside radius --------------------------- */
{
  const c = CONF[ORG];
  const { fetchImpl, calls } = makeFetch({ callId: c.call });
  const out = await evaluateGeofence({ orgId: ORG, userId: c.userId, towbookDriverId: c.tbDriver, lat: northMeters(100), lng: PICKUP.lng, fetchImpl });
  check("inside radius → arrived", out.action === "arrived" && out.jobId === c.job && out.towbookJobId === c.call && out.towbookOk && out.verified, JSON.stringify(out));
  check("Towbook PUT + verify GET happened (driver session)", calls.length === 2 && calls[0].method === "PUT" && calls[1].method === "GET" && calls[0].body.status.id === 4, JSON.stringify(calls));
  const job = await q`SELECT status, arrived_at FROM dispatch_jobs WHERE id=${c.job}`;
  check("platform status arrived + arrived_at set", String(job[0].status) === "arrived" && job[0].arrived_at != null, JSON.stringify(job));
  const ev = await q`SELECT from_status, to_status, actor_user_id, actor_role FROM status_events WHERE org_id=${ORG} AND job_id=${c.job} ORDER BY occurred_at DESC LIMIT 1`;
  check("status_event en_route→arrived attributed to driver", ev.length === 1 && String(ev[0].from_status) === "en_route" && String(ev[0].to_status) === "arrived" && String(ev[0].actor_user_id) === c.userId && String(ev[0].actor_role) === "contractor", JSON.stringify(ev));
  const aud = await q`SELECT action, detail FROM audit_log WHERE org_id=${ORG} AND action='geofence_auto_arrive' ORDER BY occurred_at DESC LIMIT 1`;
  check("audit geofence_auto_arrive with outcome", aud.length === 1 && String(aud[0].detail.towbookOk) === "true" && String(aud[0].detail.verified) === "true", JSON.stringify(aud));
  // Idempotency: the job is no longer en_route → a re-evaluation is a no-op.
  const again = await evaluateGeofence({ orgId: ORG, userId: c.userId, towbookDriverId: c.tbDriver, lat: northMeters(100), lng: PICKUP.lng, fetchImpl });
  check("re-fire after arrival is a no-op", again.action === "none", JSON.stringify(again));
}

/* ------------------------- geofence: outside radius ------------------------- */
{
  const c = CONF[ORG2];
  const { fetchImpl, calls } = makeFetch({ callId: c.call });
  const out = await evaluateGeofence({ orgId: ORG2, userId: c.userId, towbookDriverId: c.tbDriver, lat: northMeters(400), lng: PICKUP.lng, fetchImpl });
  check("outside radius → no fire", out.action === "none" && out.reason.includes("geofence"), JSON.stringify(out));
  check("no Towbook calls when outside", calls.length === 0);
  const job = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("job still en_route", String(job[0].status) === "en_route");
}

/* ------------------------------ no-fire rails ------------------------------ */
{
  const c = CONF[ORG2];
  // Wrong status: job accepted (not en_route) — no fire even inside the radius.
  await q`UPDATE dispatch_jobs SET status='accepted' WHERE id=${c.job}`;
  const { fetchImpl, calls } = makeFetch({ callId: c.call });
  const out = await evaluateGeofence({ orgId: ORG2, userId: c.userId, towbookDriverId: c.tbDriver, lat: PICKUP.lat, lng: PICKUP.lng, fetchImpl });
  check("wrong status (accepted) → no fire", out.action === "none" && calls.length === 0, JSON.stringify(out));
  await q`UPDATE dispatch_jobs SET status='en_route' WHERE id=${c.job}`;

  // No valid GPS fix (0,0 = geolocation denied).
  const out0 = await evaluateGeofence({ orgId: ORG2, userId: c.userId, towbookDriverId: c.tbDriver, lat: 0, lng: 0, fetchImpl });
  check("no GPS fix (0,0) → no fire", out0.action === "none" && out0.reason.includes("no valid GPS fix"), JSON.stringify(out0));

  // Wrong driver: reassign the call to another driver in raw_json.
  await q`UPDATE dispatch_jobs SET raw_json=${JSON.stringify(rawCall(c.call, 999, 3))}::jsonb WHERE id=${c.job}`;
  const outW = await evaluateGeofence({ orgId: ORG2, userId: c.userId, towbookDriverId: c.tbDriver, lat: PICKUP.lat, lng: PICKUP.lng, fetchImpl });
  check("wrong driver → no fire", outW.action === "none" && outW.reason.includes("geofence"), JSON.stringify(outW));
  const jobW = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("job untouched by wrong driver", String(jobW[0].status) === "en_route");
  await q`UPDATE dispatch_jobs SET raw_json=${JSON.stringify(rawCall(c.call, Number(c.tbDriver), 3))}::jsonb WHERE id=${c.job}`;
}

/* ---------------------------- photos gate (ORG2) ---------------------------- */
{
  const c = CONF[ORG2];
  const { fetchImpl, calls } = makeFetch({ callId: c.call });
  // photos_required=true with no photos → blocked. (ORG2's org_settings row was
  // created in setup with the gate ON — re-assert and keep it on.)
  const s = await getGeofenceSettings(ORG2);
  check("photos flag on for gate org", s.photosRequired === true);
  const blocked = await evaluateGeofence({ orgId: ORG2, userId: c.userId, towbookDriverId: c.tbDriver, lat: PICKUP.lat, lng: PICKUP.lng, fetchImpl });
  check("photos gate enabled + no photos → no fire", blocked.action === "none" && blocked.reason.includes("photos gate"), JSON.stringify(blocked));
  check("no Towbook calls when gated", calls.length === 0);
  const jobB = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("job still en_route when gated", String(jobB[0].status) === "en_route");

  // 3 photos + match confirmed → still blocked (needs 4).
  const SIDES = ["front", "driver_side", "passenger_side", "rear"];
  for (let i = 0; i < 3; i++) {
    await q`INSERT INTO job_photos(id, org_id, job_id, phase, side, storage_key, uploaded_by_user_id, match_confirmed)
      VALUES(gen_random_uuid()::text, ${ORG2}, ${c.job}, 'pre_arrival', ${SIDES[i]}, ${`photo-${i}`}, ${c.userId}, ${i === 0})`;
  }
  check("photosComplete 3/4 → false", (await photosCompleteForJob(ORG2, c.job)) === false);
  const blocked3 = await evaluateGeofence({ orgId: ORG2, userId: c.userId, towbookDriverId: c.tbDriver, lat: PICKUP.lat, lng: PICKUP.lng, fetchImpl });
  check("3 photos → still gated", blocked3.action === "none");

  // 4th photo + match confirmed → gate passes → auto-arrive fires.
  await q`INSERT INTO job_photos(id, org_id, job_id, phase, side, storage_key, uploaded_by_user_id, match_confirmed)
    VALUES(gen_random_uuid()::text, ${ORG2}, ${c.job}, 'pre_arrival', ${SIDES[3]}, 'photo-3', ${c.userId}, TRUE)`;
  check("photosComplete 4/4 + confirmed → true", (await photosCompleteForJob(ORG2, c.job)) === true);
  const passed = await evaluateGeofence({ orgId: ORG2, userId: c.userId, towbookDriverId: c.tbDriver, lat: PICKUP.lat, lng: PICKUP.lng, fetchImpl });
  check("4 photos + match → auto-arrive fires", passed.action === "arrived" && passed.towbookOk && passed.verified, JSON.stringify(passed));
  const jobP = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("gated job arrived after photos", String(jobP[0].status) === "arrived");
}

/* -------------------- Towbook write failure → escalation -------------------- */
{
  const c = CONF[ORG3];
  // PUT fails (500): the platform transition still records (audit + event), the
  // outcome is recorded as NOT verified, and an escalation lands in the ledger.
  const { fetchImpl, calls } = makeFetch({ callId: c.call, putStatus: 500 });
  const out = await evaluateGeofence({ orgId: ORG3, userId: c.userId, towbookDriverId: c.tbDriver, lat: PICKUP.lat, lng: PICKUP.lng, fetchImpl });
  check("PUT failure → arrived outcome with towbookOk=false verified=false", out.action === "arrived" && out.towbookOk === false && out.verified === false && out.detail.includes("failed"), JSON.stringify(out));
  check("PUT attempted once, no verify GET", calls.length === 1 && calls[0].method === "PUT" && calls[0].body.status.id === 4, JSON.stringify(calls));
  const esc = await q`SELECT decision, escalated, reason FROM ai_dispatcher_decisions WHERE org_id=${ORG3}`;
  check("escalation row recorded", esc.length === 1 && String(esc[0].decision) === "escalated_auto_arrive_failed" && esc[0].escalated === true && String(esc[0].reason).includes("did not land on Towbook"), JSON.stringify(esc));
  const aud = await q`SELECT detail FROM audit_log WHERE org_id=${ORG3} AND action='geofence_auto_arrive' LIMIT 1`;
  check("failure outcome audited (never swallowed)", aud.length === 1 && String(aud[0].detail.towbookOk) === "false", JSON.stringify(aud));
  // Same call re-failing dedupes on the ledger key (ON CONFLICT DO NOTHING).
  await q`UPDATE dispatch_jobs SET status='en_route' WHERE id=${c.job}`;
  await evaluateGeofence({ orgId: ORG3, userId: c.userId, towbookDriverId: c.tbDriver, lat: PICKUP.lat, lng: PICKUP.lng, fetchImpl });
  const esc2 = await q`SELECT COUNT(*)::int AS n FROM ai_dispatcher_decisions WHERE org_id=${ORG3}`;
  check("repeated failure dedupes escalation", Number(esc2[0].n) === 1);
}

/* ---------------------- verification failure → escalation ---------------------- */
{
  const c = CONF[ORG3];
  // PUT ok (200) but the verification GET shows status 3 (not arrived) — the
  // engine must NOT claim arrival. Reset ORG3 job to en_route first.
  await q`UPDATE dispatch_jobs SET status='en_route' WHERE id=${c.job}`;
  const { fetchImpl, calls } = makeFetch({ callId: c.call, putStatus: 200, getStatusId: 3 });
  const out = await evaluateGeofence({ orgId: ORG3, userId: c.userId, towbookDriverId: c.tbDriver, lat: PICKUP.lat, lng: PICKUP.lng, fetchImpl });
  check("verify failure → not verified", out.action === "arrived" && out.towbookOk === false && out.verified === false && out.detail.includes("verification"), JSON.stringify(out));
  check("PUT + GET both happened", calls.length === 2 && calls[0].method === "PUT" && calls[1].method === "GET", JSON.stringify(calls));
  const esc = await q`SELECT COUNT(*)::int AS n FROM ai_dispatcher_decisions WHERE org_id=${ORG3} AND decision='escalated_auto_arrive_failed'`;
  check("verification failure escalated", Number(esc[0].n) >= 1);
}

/* ------------------------------- no en-route job ------------------------------- */
{
  const c = CONF[ORG3];
  await q`UPDATE dispatch_jobs SET status='completed' WHERE id=${c.job}`;
  const { fetchImpl, calls } = makeFetch({ callId: c.call });
  const out = await evaluateGeofence({ orgId: ORG3, userId: c.userId, towbookDriverId: c.tbDriver, lat: PICKUP.lat, lng: PICKUP.lng, fetchImpl });
  check("no en-route job → no fire", out.action === "none" && calls.length === 0, JSON.stringify(out));
}

/* ------------------------------- summary + cleanup ------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-gps.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
// Prove cleanup: deleting the QA orgs cascades every row they created.
await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
await q`DELETE FROM organizations WHERE id=${ORG2}`.catch(() => {});
await q`DELETE FROM organizations WHERE id=${ORG3}`.catch(() => {});
await q`DELETE FROM users WHERE id=${OWNER}`.catch(() => {});
await q`DELETE FROM users WHERE id=${OWNER2}`.catch(() => {});
await q`DELETE FROM users WHERE id=${OWNER3}`.catch(() => {});
await q`DELETE FROM users WHERE id=${DRIVER}`.catch(() => {});
await q`DELETE FROM users WHERE id=${DRIVER2}`.catch(() => {});
await q`DELETE FROM users WHERE id=${DRIVER3}`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM driver_locations dl JOIN organizations o ON o.id=dl.org_id WHERE o.name='qa driver-gps') AS locs,
  (SELECT COUNT(*)::int FROM dispatch_jobs j JOIN organizations o ON o.id=j.org_id WHERE o.name='qa driver-gps') AS jobs,
  (SELECT COUNT(*)::int FROM status_events e JOIN organizations o ON o.id=e.org_id WHERE o.name='qa driver-gps') AS events,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name='qa driver-gps') AS audit,
  (SELECT COUNT(*)::int FROM towbook_sessions s JOIN organizations o ON o.id=s.org_id WHERE o.name='qa driver-gps') AS sessions,
  (SELECT COUNT(*)::int FROM ai_dispatcher_decisions d JOIN organizations o ON o.id=d.org_id WHERE o.name='qa driver-gps') AS decisions,
  (SELECT COUNT(*)::int FROM job_photos p JOIN organizations o ON o.id=p.org_id WHERE o.name='qa driver-gps') AS photos,
  (SELECT COUNT(*)::int FROM org_settings s JOIN organizations o ON o.id=s.org_id WHERE o.name='qa driver-gps') AS settings,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name='qa driver-gps') AS members,
  (SELECT COUNT(*)::int FROM users u WHERE u.id IN (${OWNER}, ${OWNER2}, ${OWNER3}, ${DRIVER}, ${DRIVER2}, ${DRIVER3})) AS users`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("driver-gps.test.mjs: cleanup verified — zero QA rows left");
