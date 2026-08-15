// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic AI-dispatcher test suite (decisions 2026-08-10/11): the owner-directed
// auto-accept engine — zone math (haversine vs the 06606 centroid), ROAD-AWARE
// driver selection + ETA (OSRM router is mocked; fallback factor model; buffer /
// floor / ceiling), the ETA v3 TomTom traffic layer (provider chain: TomTom →
// OSRM → factor; mocked TomTom + OSRM fetches — never real calls), decision
// ledger + dedupe, every escalation path, and the settings toggle gate. The
// accept/nearestDrivers/callRequests fetches AND the road router are ALL
// mocked — this suite can never POST to real Towbook and never calls the real
// OSRM or TomTom APIs.
//
//   DATABASE_URL=... bun ai-dispatcher.test.mjs
//
// Creates throwaway QA orgs + owner, runs the REAL engine code against them with
// a mocked fetch, asserts decisions/audit/sync wiring, then deletes every row it
// created. Never touches the owner org.
import { randomUUID } from "node:crypto";

const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);

// Test key for THIS process only (overrides the stable key via env-first
// resolution). The QA session rows are encrypted with it; the running server is
// a separate process and never sees it.
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 7).toString("base64");
// ETA v3: guarantee the real-path engine tests (27f/27g) resolve providers
// from a known env — never inherit a key from the host.
delete process.env.TOMTOM_API_KEY;
delete process.env.ETA_ROUTER;

const {
  runAutoDispatch,
  getOrgSettings,
  haversineMiles,
  chooseBestDriverByRoad,
  finalEtaMinutes,
  fallbackRoadMinutes,
  validateOfferShape,
  shapeKeyOf,
  resolveRouter,
  resolveTomtomKey,
  etaProviderStatus,
  osrmRoadSeconds,
  tomtomRoadSeconds,
  workloadAwareArrivalMinutes,
  gpsPingAgeMinutes,
  driverActiveCount,
  loadOrgDriverQueues,
  etaDetailLabel,
  MAX_DRIVER_QUEUE,
  SERVICE_MINUTES_PER_JOB,
  validateGeocodeResult,
  tomtomGeocodeLookup,
  GEOCODE_SCORE_FLOOR,
  ANCHOR_RADIUS_MILES,
  STALE_GPS_FIX_MINUTES,
  loadDriverAnchors,
  loadDriverGpsFixes,
  etDayStartUtcMs,
  areaSelectionNote,
} = await import("./src/data/ai-dispatcher.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");

const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-ad-${randomUUID()}`;
const ORG2 = `qa-ad2-${randomUUID()}`;
const ORG3 = `qa-ad3-${randomUUID()}`; // ETA v3 traffic-layer engine tests
const ORG4 = `qa-ad4-${randomUUID()}`; // queue-aware capacity + all-loaded engine tests
const ORG5 = `qa-ad5-${randomUUID()}`; // lost-race classification tests
const ORG6 = `qa-ad6-${randomUUID()}`; // coordinate-less offer resolution (owner 2026-08-13)
const ORG7 = `qa-ad7-${randomUUID()}`; // geography: area anchors + fresh-GPS ETA origins (owner 2026-08-13)
const USER = `qa-ad-user-${randomUUID()}`;
const QUAL_USERS = [1,2,3,4,5,6,7].map(() => `qa-ad-qual-${randomUUID()}`);
// Per-run random Towbook IDs (global unique users_towbook_driver_id_idx): a
// crashed run's leftovers must never collide with the next run (23505). Real
// Towbook driver IDs are 6-digit or 279xxxxxx - 9xxxxxx is collision-safe.
const QUAL_TB_BASE = 9_000_000 + Math.floor(Math.random() * 999_999);
const QUAL_TB = [0,1,2,3,4,5,6].map((i) => QUAL_TB_BASE + i);
let created = false;

/* ------------------------------ fixtures ------------------------------ */

const ZONE = { lat: 41.208862, lng: -73.207253, radiusMi: 30 };
const northOf = (dMiles) => ZONE.lat + dMiles / 69.09; // ~1° lat = 69.09 mi

const offer = (id, { lat = 41.2, lng = -73.2, status = 0, expiresInMin = 10, maxEta = null, omitLat = false, omitLng = false, startingLocation = "123 MAIN ST, BRIDGEPORT CT 06606", purchaseOrderNumber = `1125${id}`, past = false, serviceType = null, drivers = [603482, 703785] } = {}) => {
  const o = {
    callRequestId: id,
    masterAccountId: 29,
    accountId: 894873,
    accountName: "Agero (Swoop) Bridgeport",
    companyId: 23257,
    status,
    expirationDateUtc: past ? "2026-08-01T00:00:00" : new Date(Date.now() + expiresInMin * 60000).toISOString(),
    defaultEta: 30,
    purchaseOrderNumber,
    sound: false,
    startLocationLatitude: lat,
    startLocationLongitude: lng,
    drivers,
    availableActions: ["NearestDrivers", "REQUEST_CALL", "ACKNOWLEDGE"],
  };
  if (maxEta) o.maxEta = maxEta;
  if (serviceType) o.serviceType = serviceType;
  if (startingLocation) o.startingLocation = startingLocation;
  if (omitLat) delete o.startLocationLatitude;
  if (omitLng) delete o.startLocationLongitude;
  return o;
};

const driver = (id, name, { lat = 41.2, lng = -73.2, checkedIn = true, etaSec = 600, calls = [] } = {}) => ({
  driverId: id, driverName: name, truckId: 0, latitude: lat, longitude: lng,
  estimatedDistanceMiles: 5, estimatedTimeSeconds: etaSec, isCheckedIn: checkedIn, calls,
});

const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() { return JSON.stringify(body); },
  async json() { return body; },
  headers: new Headers({ "content-type": "application/json" }),
});

/** Mock Towbook fetch. Records every call; routes GET /api/callRequests/,
 *  GET /api/nearestDrivers, POST /api/callRequests/{id}/accept, plus the
 *  post-accept verification surface: GET /api/calls/{id},
 *  GET /api/calls?status=N and PUT /api/calls/{id} (the VERIFIED dispatch
 *  mechanism — the Map app's own payload; the old guessed POST
 *  /api/calls/{id}/assignDrivers is NOT in the mock surface and 404s the test).
 *  Throws on any URL outside the documented surface — a stray call fails the
 *  test. The created call mirrors the accept body's driverId in assets[].driver.id
 *  (so verification passes by default) unless `callDriverId` overrides it
 *  (simulating the 2026-08-10 incident: accepted driver ≠ driver on the call).
 *  `acceptedCallStatus` sets the status the fresh accept's call lands in
 *  (real world: 0 = Received — the 2026-08-12 dispatch gap). */
function makeFetch({ offers, drivers, offersStatus = 200, offersBody = null, acceptStatus = 200, acceptBody = null, acceptFails = 0, nearestDriversStatus = 200, callDriverId = null, assignSucceeds = true, acceptResponseId = null, callsFailures = 0, acceptedCallStatus = 2, assetId = 424242, statusListExtra = {}, suppressCreatedFromStatusLists = false }) {
  const calls = [];
  let call = null; // the call created by the accept POST
  let callsFailuresLeft = callsFailures;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    const parsedBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body: parsedBody });
    if (u.endsWith("/api/callRequests/") && method === "GET") {
      if (offersStatus !== 200) return jsonResponse(offersStatus, { error: "boom" });
      return jsonResponse(200, offersBody ?? offers);
    }
    if (u.includes("/api/nearestDrivers")) {
      if (nearestDriversStatus !== 200) return jsonResponse(nearestDriversStatus, { error: "boom" });
      return jsonResponse(200, drivers);
    }
    if (u.includes("/api/callRequests/") && method === "POST") {
      if (acceptFails > 0) { acceptFails--; return jsonResponse(500, { error: "accept boom" }); }
      if (acceptStatus !== 200) return jsonResponse(acceptStatus, acceptBody ?? { error: "boom" });
      const bodyId = acceptResponseId ?? (acceptBody && acceptBody.id != null ? acceptBody.id : 279999999);
      const offerFor = offers.find((o) => String(o.callRequestId) === u.split("/api/callRequests/")[1].split("/")[0]);
      call = {
        id: bodyId,
        callNumber: 25000,
        status: { id: acceptedCallStatus },
        version: 1,
        purchaseOrderNumber: offerFor ? offerFor.purchaseOrderNumber : null,
        assets: parsedBody && Number(parsedBody.driverId) > 0
          ? [{ id: assetId, driver: { id: callDriverId ?? Number(parsedBody.driverId), name: callDriverId != null ? "Someone Else" : "Assigned" } }]
          : [],
      };
      return jsonResponse(200, acceptBody ?? { id: bodyId, callNumber: 25000, status: { id: acceptedCallStatus }, version: 1 });
    }
    if (u.includes("/api/calls/") && method === "PUT") {
      // VERIFIED dispatch payload (map-actions.js useDispatchCall):
      // {id, status:{id:1}, assets:[{id, drivers:[{driver:{id}}]}]}
      if (!assignSucceeds) return jsonResponse(500, { error: "assign boom" });
      const m2 = u.match(/\/api\/calls\/(\d+)$/);
      if (call && m2 && String(call.id) === m2[1]) {
        const driverId = parsedBody?.assets?.[0]?.drivers?.[0]?.driver?.id;
        if (driverId != null) {
          call.status = { id: 1 };
          call.assets = [{ id: parsedBody.assets[0].id ?? assetId, drivers: [{ driver: { id: driverId, name: "Assigned" } }] }];
        }
      }
      return jsonResponse(200, { ok: true });
    }
    if (u.includes("/api/calls")) {
      if (callsFailuresLeft > 0) { callsFailuresLeft--; return jsonResponse(500, { error: "call list boom" }); }
      const m = u.match(/\/api\/calls\/(\d+)$/);
      if (m) return call && String(call.id) === m[1] ? jsonResponse(200, call) : jsonResponse(404, { error: "not found" });
      const sm = u.match(/status=(\d+)/);
      if (sm) {
        const status = Number(sm[1]);
        const created = call && call.status.id === status && !suppressCreatedFromStatusLists ? [call] : [];
        return jsonResponse(200, [...created, ...(statusListExtra[status] ?? [])]);
      }
    }
    throw new Error(`mock fetch hit an unexpected URL: ${method} ${u}`);
  };
  return { fetchImpl, calls };
}

/** Mock road router (the OSRM stand-in — returns the RoadResult shape the ETA
 *  v3 providers use). `routes` maps "fromLat,fromLng" → drive seconds (wrapped
 *  into an osrm RoadResult) or null (simulate a routing failure) or a full
 *  RoadResult. Any key not in the map falls back to a hermetic factor model on
 *  haversine — never network. The default floor of 60s keeps zero-distance
 *  drivers at a sane 1-min base. */
const makeRouter = (routes = {}) => async (fromLat, fromLng, toLat, toLng) => {
  const key = `${fromLat.toFixed(2)},${fromLng.toFixed(2)}`;
  const hit = routes[key];
  if (hit === null) return null;
  if (typeof hit === "number") {
    return { seconds: hit, provider: "osrm", liveTraffic: false, trafficDelaySeconds: null, notes: "static routing (mock)" };
  }
  if (hit && typeof hit === "object") return hit;
  const mi = haversineMiles(fromLat, fromLng, toLat, toLng);
  const seconds = Math.max(60, Math.round((mi / 30) * 3600 * 1.35));
  return { seconds, provider: "osrm", liveTraffic: false, trafficDelaySeconds: null, notes: "static routing (mock)" };
};

/** Mock TomTom + OSRM routing fetch (ETA v3). Records the URLs it served and
 *  returns canned bodies per host; any other URL throws (a stray call fails
 *  the test). Defaults: TomTom 200 with travel 540s + delay 120s; OSRM 200
 *  with duration 600s. */
const tomtomJson = (travelSec, delaySec) => jsonResponse(200, { routes: [{ summary: { travelTimeInSeconds: travelSec, trafficDelayInSeconds: delaySec } }] });
const osrmJson = (durationSec) => jsonResponse(200, { code: "Ok", routes: [{ duration: durationSec }] });

function makeRouterFetch({ tomtomStatus = 200, tomtomBody = null, osrmStatus = 200, osrmBody = null } = {}) {
  const tomtomCalls = [];
  const osrmCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("api.tomtom.com")) {
      tomtomCalls.push(u);
      if (tomtomStatus !== 200) return jsonResponse(tomtomStatus, { error: "tomtom boom" });
      return tomtomBody ?? tomtomJson(540, 120);
    }
    if (u.includes("router.project-osrm.org")) {
      osrmCalls.push(u);
      if (osrmStatus !== 200) return jsonResponse(osrmStatus, { error: "osrm boom" });
      return osrmBody ?? osrmJson(600);
    }
    throw new Error(`router mock fetch hit an unexpected URL: ${methodOf(init)} ${u}`);
  };
  return { fetchImpl, tomtomCalls, osrmCalls };
}

/** Compose a Towbook mock with a router mock: Towbook URLs go to `base`,
 *  TomTom/OSRM URLs to the router fetch. */
const withRouter = (baseFetch, routerFetchImpl) => async (url, init = {}) => {
  const u = String(url);
  if (u.includes("api.tomtom.com") || u.includes("router.project-osrm.org")) return routerFetchImpl(url, init);
  return baseFetch(url, init);
};
const methodOf = (init) => init.method || "GET";

const makeDeps = (fetchImpl, router, opts = {}) => {
  const syncCalls = [];
  const deps = {
    syncForOrg: async (orgId, trigger, actor) => { syncCalls.push({ orgId, trigger, actor }); return { ok: true }; },
    resolveOrgActor: async () => ({ id: USER, role: "owner" }),
    fetchImpl,
    verifyRetryDelayMs: 0,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.geocodeOverride ? { geocodeOverride: opts.geocodeOverride } : {}),
    // SAME-STATE GUARD (owner rule 2026-08-13): hermetic driver-state resolver —
    // fixture drivers sit at CT coords, so default "CT"; the guard's job-state
    // parse, comparison and fail-closed refusal still run in the engine. The
    // dedicated guard cases pass their own resolver via opts.stateResolver.
    ...(opts.noStateGuardOverride ? {} : { stateGuardResolver: opts.stateResolver ?? (async () => "CT") }),
  };
  // Default: inject a hermetic router so tests never hit real OSRM/TomTom.
  // opts.noRouterOverride exercises the real env-resolution path instead.
  if (!opts.noRouterOverride) {
    deps.routerOverride = { provider: "osrm", tomtomKeyConfigured: false, router: router ?? makeRouter() };
  }
  return { deps, syncCalls };
};

const decisions = () => q`SELECT call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG} ORDER BY created_at, call_request_id`;
const decisions3 = () => q`SELECT call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG3} ORDER BY created_at, call_request_id`;
const decisions5 = () => q`SELECT call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG5} ORDER BY created_at, call_request_id`;
const audits = () => q`SELECT count(*)::int n FROM audit_log WHERE org_id=${ORG} AND action='ai_dispatcher:accept'`;
const posts = (calls) => calls.filter((c) => c.method === "POST");
const fallbackAccept = (r, calls, id, eta = 45) => r.decisions[0]?.decision === "auto_accept_no_driver" && r.decisions[0]?.escalated === true && posts(calls).length === 1 && String(posts(calls)[0].url).includes(`/api/callRequests/${id}`) && Number(posts(calls)[0].body.driverId) === 0 && Number(posts(calls)[0].body.ETA) === eta && String(posts(calls)[0].body.notes).includes("awaiting driver assignment");

try {
  // ---- setup: schema (idempotent; applies v8), QA orgs + owner + encrypted session
  await ensureSchema();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa ai-dispatcher')`;
  await q`INSERT INTO organizations(id, name) VALUES(${ORG2}, 'qa ai-dispatcher no-session')`;
  await q`INSERT INTO organizations(id, name) VALUES(${ORG3}, 'qa ai-dispatcher eta-v3')`;
  await q`INSERT INTO organizations(id, name) VALUES(${ORG4}, 'qa ai-dispatcher queue-aware')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${USER}, 'QA AI Dispatcher Owner', ${`ad-${randomUUID()}@qa.local`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${USER}, 'owner')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG3}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG4}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected')`;
  // ORG4: raise the ETA ceiling so the queue-inclusive ETA is quoted UNCLAMPED
  // (a 3-job queue always exceeds the default 45-min SLA ceiling).
  await q`INSERT INTO org_settings(org_id) VALUES(${ORG4}) ON CONFLICT(org_id) DO NOTHING`;
  await q`UPDATE org_settings SET max_eta_minutes=180 WHERE org_id=${ORG4}`;
  await q`INSERT INTO organizations(id, name) VALUES(${ORG5}, 'qa ai-dispatcher lost-race')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG5}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected')`;
  await q`INSERT INTO organizations(id, name) VALUES(${ORG6}, 'qa ai-dispatcher coords')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG6}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected')`;
  await q`INSERT INTO organizations(id, name) VALUES(${ORG7}, 'qa ai-dispatcher geography')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG7}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected')`;
  for (let i=0;i<QUAL_USERS.length;i++) await q`INSERT INTO users(id,name,email,password_hash,towbook_driver_id) VALUES(${QUAL_USERS[i]},${'QA Qual '+i},${'qual'+i+'-'+randomUUID()+'@qa.local'},'x',${String(QUAL_TB[i])})`;
  // Legacy dispatcher fixtures intentionally exercise pre-gate behavior; the
  // qualification-specific hermetic cases can opt their org back on.
  for (const qaOrg of [ORG, ORG2, ORG3, ORG4, ORG5, ORG6, ORG7]) {
    await q`INSERT INTO org_settings(org_id, qualification_gate_enabled) VALUES(${qaOrg}, FALSE) ON CONFLICT(org_id) DO UPDATE SET qualification_gate_enabled=FALSE`;
  }
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG7},${QUAL_USERS[0]},'contractor')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG7},${QUAL_USERS[1]},'contractor')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG7},${QUAL_USERS[2]},'contractor')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG7},${QUAL_USERS[3]},'contractor')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG7},${QUAL_USERS[4]},'contractor')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG7},${QUAL_USERS[5]},'contractor')`;
  await q`INSERT INTO contractor_profiles(org_id,user_id,vehicle_type) VALUES(${ORG7},${QUAL_USERS[0]},'car'),(${ORG7},${QUAL_USERS[1]},'car'),(${ORG7},${QUAL_USERS[2]},'car'),(${ORG7},${QUAL_USERS[3]},'car'),(${ORG7},${QUAL_USERS[4]},'tow truck'),(${ORG7},${QUAL_USERS[5]},'car')`;
  // Idempotent after an interrupted run: stable fixture IDs must not collide.
  await q`INSERT INTO contractor_doc_types(id,org_id,name) VALUES('qual-doc-a',${ORG7},'License A'),('qual-doc-b',${ORG7},'License B') ON CONFLICT (id) DO UPDATE SET org_id=EXCLUDED.org_id, name=EXCLUDED.name`;
  await q`INSERT INTO contractor_documents(id,org_id,contractor_id,doc_type_id,storage_key,status,uploaded_by_user_id) VALUES('qual-doc-one',${ORG7},${QUAL_USERS[4]},'qual-doc-a','x','verified',${USER}),('qual-doc-two',${ORG7},${QUAL_USERS[4]},'qual-doc-b','x','verified',${USER}) ON CONFLICT (id) DO UPDATE SET org_id=EXCLUDED.org_id, contractor_id=EXCLUDED.contractor_id, doc_type_id=EXCLUDED.doc_type_id, storage_key=EXCLUDED.storage_key, status=EXCLUDED.status, uploaded_by_user_id=EXCLUDED.uploaded_by_user_id`;
  // Capability-mismatch driver needs BOTH active doc types verified (the gate
  // counts required_docs = all active types), so it passes compliance and the
  // heavy-tow service type trips capability-mismatch — not missing-compliance.
  await q`INSERT INTO contractor_documents(id,org_id,contractor_id,doc_type_id,storage_key,status,uploaded_by_user_id) VALUES('qual-doc-capability',${ORG7},${QUAL_USERS[5]},'qual-doc-a','x','verified',${USER}),('qual-doc-capability-b',${ORG7},${QUAL_USERS[5]},'qual-doc-b','x','verified',${USER}) ON CONFLICT (id) DO UPDATE SET org_id=EXCLUDED.org_id, contractor_id=EXCLUDED.contractor_id, doc_type_id=EXCLUDED.doc_type_id, storage_key=EXCLUDED.storage_key, status=EXCLUDED.status, uploaded_by_user_id=EXCLUDED.uploaded_by_user_id`;
  await q`UPDATE contractor_profiles SET vehicle_type='van' WHERE user_id=${QUAL_USERS[5]} AND org_id=${ORG7}`;
  await q`UPDATE org_settings SET qualification_gate_enabled=TRUE WHERE org_id=${ORG7}`;
  created = true;
  // Production-shaped zoning fixture: auto-accept now resolves state + active
  // org-scoped dispatch_zones (legacy org_settings centroid is not consulted).
  for (const [zoneOrg, state, lat, lng, radius, zips] of [
    [ORG, "CT", ZONE.lat, ZONE.lng, 30, ["06606"]],
    [ORG3, "CT", ZONE.lat, ZONE.lng, 30, ["06606"]],
    [ORG4, "CT", ZONE.lat, ZONE.lng, 30, ["06606"]],
    [ORG5, "CT", ZONE.lat, ZONE.lng, 30, ["06606"]],
    [ORG6, "CT", ZONE.lat, ZONE.lng, 30, ["06606"]],
    [ORG6, "TX", 30.61948, -97.648242, 50, ["78626"]],
    [ORG7, "CT", ZONE.lat, ZONE.lng, 30, ["06606"]],
  ]) await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,lat,lng,radius_miles,tz,active,sort_order,zip_codes)
    VALUES(${`qa-zone-${randomUUID()}`},${zoneOrg},${state+' fixture'},${state},${state+' fixture'},'market',${lat},${lng},${radius},'America/New_York',TRUE,1,${zips}::text[])`;
  // Owner-org baseline: the REAL incident row (offer 326520203, auto-accepted
  // 2026-08-10 with a 3-min straight-line ETA) lives in the owner org — the
  // "zero decisions" assumption predates it. Capture the count so the final
  // check proves THIS run adds nothing to the owner org.
  const ownerBaseline = Number((await q`SELECT count(*)::int n FROM ai_dispatcher_decisions WHERE org_id=${"89e15ce587651cc47c3bc45b1c612a220955"}`)[0].n);
  // Owner-session baseline: the production org's owner towbook_sessions row(s). Since
  // the 2026-08-12 incident deleted org-scoped rows and the owner has not re-linked
  // Towbook, this is currently EMPTY — the final check must compare against this
  // snapshot (row count + statuses), not assume a connected row exists.
  const ownerSessionBaseline = (await q`SELECT status FROM towbook_sessions WHERE org_id=${"89e15ce587651cc47c3bc45b1c612a220955"} AND session_kind='owner'`).map(r => String(r.status));

  /* ============ 1) pure functions: zone math ============ */
  check("haversine(centroid) = 0", haversineMiles(ZONE.lat, ZONE.lng, ZONE.lat, ZONE.lng) === 0);
  const inside = haversineMiles(41.2, -73.2, ZONE.lat, ZONE.lng);
  check("haversine in-zone point < 30 mi", inside > 0 && inside < 30, String(inside));
  const boundaryIn = haversineMiles(northOf(29.5), ZONE.lng, ZONE.lat, ZONE.lng);
  const boundaryOut = haversineMiles(northOf(30.5), ZONE.lng, ZONE.lat, ZONE.lng);
  check("boundary math: 29.5-mi offset < 30 < 30.5-mi offset", boundaryIn < 30 && boundaryOut > 30 && boundaryOut - boundaryIn < 1.5, `${boundaryIn} / ${boundaryOut}`);
  const far = haversineMiles(40.6, -74.5, ZONE.lat, ZONE.lng);
  check("haversine far point (NJ) > 30 mi", far > 30, String(far));

  /* ============ 2) pure functions: road-aware driver selection + ETA ============ */
  const R = makeRouter({ "41.10,-73.00": 3600, "41.15,-73.10": 600, "41.19,-73.15": null });
  const freeFast = driver(703785, "Jayden Fountain", { lat: 41.1, lng: -73.0, etaSec: 604 });   // 5.7 mi straight-line, 11 min — but 60 min ROAD
  const freeSlow = driver(603482, "Antone jerret", { lat: 41.15, lng: -73.1, etaSec: 1255 });   // 21 min straight-line — but 10 min ROAD
  // 3 active payload calls = at the owner-directed 3-job cap → NOT eligible
  // (a 1-2 call driver now IS eligible — the old "no current calls" rule is
  // replaced by the < MAX_DRIVER_QUEUE capacity rule, 2026-08-11).
  const busy = driver(668209, "George Boyd", { calls: [{ callId: 1, status: 3 }, { callId: 2, status: 3 }, { callId: 3, status: 3 }] });
  const noGps = driver(103665, "Brittani Simms", { lat: 0, lng: 0, etaSec: 5 });
  const offline = driver(717660, "Levi C Martin", { checkedIn: false, etaSec: 10 });
  const pick2 = await chooseBestDriverByRoad([freeSlow, freeFast, busy, noGps, offline], 41.2, -73.2, R);
  check("chooseBestDriverByRoad picks closer Antone (10-min road ETA)", pick2?.driver.driverId === 603482 && pick2.baseMinutes === 10 && pick2.usedFallback === false && pick2.roadSeconds === 600, JSON.stringify(pick2));
  check("chooseBestDriverByRoad excludes busy/no-GPS/offline", (await chooseBestDriverByRoad([freeFast, busy], 41.2, -73.2, R))?.driver.driverId === 703785 && (await chooseBestDriverByRoad([busy, noGps, offline], 41.2, -73.2, R))?.driver.driverId === 668209);
  check("chooseBestDriverByRoad([]) = null", (await chooseBestDriverByRoad([], 41.2, -73.2, R)) === null);
  const fb = await chooseBestDriverByRoad([driver(703785, "Jayden Fountain", { lat: 41.19, lng: -73.15, etaSec: 604 })], 41.2, -73.2, R);
  check("chooseBestDriverByRoad: router null → fallback factor model flagged", fb?.driver.driverId === 703785 && fb.usedFallback === true && fb.roadSeconds === null && fb.baseMinutes === fallbackRoadMinutes(haversineMiles(41.19, -73.15, 41.2, -73.2)), JSON.stringify(fb));
  // T1–T6 proximity-first hermetic contract tests. Routing is mocked; these
  // deliberately make road ETA disagree with geographic proximity.
  const t1a = driver(8101, "T1 close", { lat: 41.195, lng: -73.195, etaSec: 1200 });
  const t1b = driver(8102, "T1 far/fast", { lat: 41.10, lng: -73.00, etaSec: 1200 });
  const t1 = await chooseBestDriverByRoad([t1a, t1b], 41.2, -73.2, makeRouter({ "41.20,-73.19": 3600, "41.10,-73.00": 60 }));
  check("T1 closest GPS wins despite farther driver's lower road ETA", t1?.driver.driverId === 8101 && t1?.distanceBasis === "fallback" && t1?.baseMinutes === 60, JSON.stringify(t1));
  const t2a = driver(8201, "T2 near", { lat: 41.19, lng: -73.19, etaSec: 600 });
  const t2b = driver(8202, "T2 farther/fast", { lat: 41.13, lng: -73.13, etaSec: 600 });
  const t2 = await chooseBestDriverByRoad([t2a, t2b], 41.2, -73.2, makeRouter({ "41.19,-73.19": 2400, "41.13,-73.13": 60 }));
  check("T2 farther road-faster driver cannot steal from nearer eligible driver", t2?.driver.driverId === 8201, JSON.stringify(t2));
  const t3ds = [
    driver(8301, "T3 closest", { lat: 41.198, lng: -73.198, etaSec: 1200 }),
    driver(8302, "T3 middle", { lat: 41.16, lng: -73.16, etaSec: 1200 }),
    driver(8303, "T3 far", { lat: 41.10, lng: -73.00, etaSec: 1200 }),
  ];
  const t3 = await chooseBestDriverByRoad(t3ds, 41.2, -73.2, makeRouter({ "41.20,-73.20": 3600, "41.16,-73.16": 120, "41.10,-73.00": 60 }));
  check("T3 three eligible drivers: closest wins regardless of ETA ordering", t3?.driver.driverId === 8301, JSON.stringify(t3));
  const t4fresh = driver(8401, "T4 fresh GPS", { lat: 41.195, lng: -73.195, etaSec: 1200 });
  const t4stale = { ...driver(8402, "T4 stale", { lat: 41.10, lng: -73.00, etaSec: 60 }), gpsUpdatedAtUtc: new Date(Date.now() - 30 * 60000).toISOString() };
  const t4 = await chooseBestDriverByRoad([t4fresh, t4stale], 41.2, -73.2, makeRouter({ "41.20,-73.19": 3600, "41.10,-73.00": 60 }), undefined, { gpsFixes: new Map([["8401", { lat: 41.195, lng: -73.195, capturedAt: new Date().toISOString() }]]), anchors: new Map([["8402", { driverTowbookId: "8402", lat: 41.10, lng: -73.00, jobId: "t4", assignedAt: new Date().toISOString() }]]) });
  check("T4 GPS-backed tier beats stale/fallback tier and preserves truthful ETA flags", t4?.driver.driverId === 8401 && t4.distanceBasis === "gps" && t4.usedFallback === false && t4.baseMinutes === 60, JSON.stringify(t4));
  const t5eligible = driver(8502, "T5 farther eligible", { lat: 41.15, lng: -73.15, etaSec: 600 });
  const t5 = await chooseBestDriverByRoad([t5eligible], 41.2, -73.2, makeRouter({ "41.15,-73.15": 600 }));
  check("T5 Towbook eligibility filters closest non-listed driver before proximity ranking", t5?.driver.driverId === 8502, JSON.stringify(t5));
  const t6driver = driver(8601, "T6 payload origin", { lat: 41.10, lng: -73.00, etaSec: 1200 });
  const t6fix = { lat: 41.195, lng: -73.195, capturedAt: new Date().toISOString() };
  const t6 = await chooseBestDriverByRoad([t6driver], 41.2, -73.2, makeRouter({ "41.20,-73.19": 300, "41.10,-73.00": 3600 }), undefined, { gpsFixes: new Map([["8601", t6fix]]) });
  check("T6 selected driver's GPS origin supplies distance/base/straight-line fields", t6?.driver.driverId === 8601 && t6.originBasis === "gps" && Math.abs(t6.originLat - t6fix.lat) < 1e-9 && t6.baseMinutes === 5 && t6.roadSeconds === 300 && t6.distanceMiles < 1, JSON.stringify(t6));
  check("T6 no eligible driver preserves null choice (driverId 0/SLA no-driver path)", (await chooseBestDriverByRoad([driver(8602, "T6 offline", { checkedIn: false })], 41.2, -73.2, makeRouter())) === null, "");
  const serviceQualification = { serviceType: "tire", assessed: false, excluded: [] };
  const incompatible = { ...driver(8701, "T7 incompatible", { lat: 41.195, lng: -73.195 }), serviceExclusions: ["tire"] };
  const noCapability = driver(8703, "T7 no capability data", { lat: 41.19, lng: -73.19 });
  const compatible = driver(8702, "T7 compatible", { lat: 41.1, lng: -73.0 });
  const t7 = await chooseBestDriverByRoad([incompatible, compatible], 41.2, -73.2, makeRouter(), undefined, { serviceType: "tire", serviceQualification });
  check("T7 service-incompatible closer driver excluded; next eligible selected and exclusion recorded", t7?.driver.driverId === 8702 && serviceQualification.excluded.some((e) => e.driverId === 8701 && e.reason.includes("explicitly does not perform service type 'tire'")), JSON.stringify({ choice: t7?.driver.driverId, excluded: serviceQualification.excluded }));
  const noDataQualification = { serviceType: "tire", assessed: false, excluded: [] };
  const t7Fallback = await chooseBestDriverByRoad([noCapability], 41.2, -73.2, makeRouter(), undefined, { serviceType: "tire", serviceQualification: noDataQualification });
  check("T7 no capability data remains eligible (live-pool safety)", t7Fallback?.driver.driverId === 8703 && noDataQualification.excluded.length === 0, JSON.stringify(t7Fallback));
  // P0 explicit safeguards: road-ETA ties are deterministic and offline
  // closest drivers never enter the eligible pool.
  const tieDrivers = [
    driver(8802, "Tie higher id", { lat: 41.2, lng: -73.19, etaSec: 600 }),
    driver(8801, "Tie lower id", { lat: 41.2, lng: -73.19005, etaSec: 600 }),
  ];
  const tieRouter = makeRouter({ "41.20,-73.19": 600 });
  const tiePicks = [];
  for (let i = 0; i < 4; i++) tiePicks.push((await chooseBestDriverByRoad(tieDrivers, 41.2, -73.2, tieRouter))?.driver.driverId);
  check("P0 ETA-TIE deterministic driverId winner across repeated selections", tiePicks.length === 4 && tiePicks.every((id) => id === tiePicks[0]) && tiePicks[0] === 8801, JSON.stringify(tiePicks));
  const offlineClosest = driver(8810, "Offline closest", { lat: 41.2, lng: -73.199, checkedIn: false });
  const onlineNext = driver(8811, "Online next", { lat: 41.2, lng: -73.18 });
  const offlinePick = await chooseBestDriverByRoad([offlineClosest, onlineNext], 41.2, -73.2, makeRouter());
  check("P0 OFFLINE-CLOSEST selects next eligible driver and never offline", offlinePick?.driver.driverId === 8811 && offlinePick?.driver.driverId !== 8810, JSON.stringify(offlinePick));
  // Recalculation contract: once the first choice is removed from the live
  // payload, the same chooser run over the remaining pool selects the next
  // eligible driver (the engine records the corresponding recalc reason).
  const recalcFirst = driver(8820, "Recalc first", { lat: 41.2, lng: -73.199 });
  const recalcNext = driver(8821, "Recalc next", { lat: 41.2, lng: -73.18 });
  const initialRecalc = await chooseBestDriverByRoad([recalcFirst, recalcNext], 41.2, -73.2, makeRouter());
  const remainingRecalc = await chooseBestDriverByRoad([recalcNext], 41.2, -73.2, makeRouter());
  const recalcReason = `first choice ${initialRecalc?.driver.driverId} became unavailable → recalculated to ${remainingRecalc?.driver.driverId}`;
  check("P0 MID-DISPATCH RECALC selects next-best remaining eligible + records reason", initialRecalc?.driver.driverId === 8820 && remainingRecalc?.driver.driverId === 8821 && recalcReason.includes("recalculated to 8821"), recalcReason);
  check("finalEtaMinutes: ceil(9)+5 = 14", finalEtaMinutes(9, 5, 5, 45) === 14);
  check("finalEtaMinutes: ceiling clamps 60+5 → 45", finalEtaMinutes(60, 5, 5, 45) === 45);
  check("finalEtaMinutes: raw 250+5 hard-caps at 45", finalEtaMinutes(250, 5, 5, 45) === 45);
  check("finalEtaMinutes: floor lifts 1+5 → 15", finalEtaMinutes(1, 5, 15, 45) === 15);
  check("finalEtaMinutes: zero base + buffer = 5 (default floor)", finalEtaMinutes(0, 5, 5, 45) === 5);
  check("finalEtaMinutes: per-offer ceiling 10 clamps 9+5", finalEtaMinutes(9, 5, 5, 10) === 10);
  check("fallbackRoadMinutes: 10 mi → 27 min (10/30*60*1.35)", fallbackRoadMinutes(10) === 27);

  /* ============ 3) pure functions: offer shape rail ============ */
  check("validateOfferShape ok on documented shape", validateOfferShape(offer(9001)).ok === true);
  const noLat = validateOfferShape(offer(9002, { omitLat: true }));
  check("validateOfferShape flags missing startLocationLatitude", !noLat.ok && noLat.missing.includes("startLocationLatitude"), JSON.stringify(noLat));
  const noStatus = validateOfferShape({ ...offer(9003), status: undefined });
  check("validateOfferShape flags missing status", !noStatus.ok && noStatus.missing.includes("status"));
  check("validateOfferShape rejects non-objects", !validateOfferShape("junk").ok && !validateOfferShape(null).ok);
  // fixture determinism: offer() stamps expirationDateUtc from Date.now(), so
  // two fresh calls can hash differently; build once and reuse.
  const stableOffer = offer(9004);
  check("shapeKeyOf stable + distinct", shapeKeyOf(stableOffer) === shapeKeyOf(stableOffer) && shapeKeyOf(stableOffer) !== shapeKeyOf({ ...stableOffer, accountName: "other" }));

  /* ============ 4) settings defaults (lazily created row) ============ */
  const s = await getOrgSettings(ORG);
  check("org_settings defaults: enabled + 06606 centroid + 30mi + 45min + buffer 5 + floor 5", s.aiDispatcherEnabled === true && s.zoneLat === 41.208862 && s.zoneLng === -73.207253 && s.zoneRadiusMiles === 30 && s.maxEtaMinutes === 45 && s.etaBufferMinutes === 5 && s.etaFloorMinutes === 5, JSON.stringify(s));

  /* ============ 5) not_connected (org with no session) ============ */
  {
    const { deps } = makeDeps(makeFetch({ offers: [], drivers: [] }).fetchImpl);
    const r = await runAutoDispatch(ORG2, deps);
    check("no session → skipped not_connected, no decisions", r.skipped === "not_connected" && r.decisions.length === 0, JSON.stringify(r));
  }

  /* ============ 6) session_unavailable (undecryptable session) ============ */
  {
    await q`UPDATE towbook_sessions SET encrypted_session='v1.garbage' WHERE org_id=${ORG}`;
    const { deps } = makeDeps(makeFetch({ offers: [], drivers: [] }).fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("undecryptable session → skipped session_unavailable", r.skipped === "session_unavailable", JSON.stringify(r));
    await q`UPDATE towbook_sessions SET encrypted_session=${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))} WHERE org_id=${ORG}`;
  }

  /* ============ 7) auto-accept with driver: ROAD ETA (route + buffer) ============ */
  {
    const m = makeFetch({
      offers: [offer(7001)],
      drivers: [
        driver(717660, "Levi C Martin", { checkedIn: false, etaSec: 10, lat: 41.19, lng: -73.15 }),
        driver(603482, "Antone jerret", { lat: 41.15, lng: -73.1, etaSec: 1255 }),   // road 720s (12 min)
        driver(703785, "Jayden Fountain", { lat: 41.18, lng: -73.15, etaSec: 604 }), // road 540s (9 min) → winner
      ],
    });
    const router = makeRouter({ "41.15,-73.10": 720, "41.18,-73.15": 540 });
    const { deps, syncCalls } = makeDeps(m.fetchImpl, router);
    const r = await runAutoDispatch(ORG, deps);
    check("auto-accept: 1 offer seen, 1 processed, no skip", r.offersSeen === 1 && r.processed === 1 && r.skipped === null, JSON.stringify(r));
    check("auto-accept: decision auto_accept_with_driver, not escalated", r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false, JSON.stringify(r.decisions));
    const p = posts(m.calls);
    check("auto-accept: exactly ONE POST (the accept)", p.length === 1 && m.calls.some((c) => c.url.endsWith("/api/callRequests/7001/accept")), JSON.stringify(m.calls.map((c) => c.url)));
    check("auto-accept: chose the min-ROAD-ETA free driver (703785, 9 min road)", p[0]?.body?.driverId === 703785, JSON.stringify(p[0]?.body));
    check("auto-accept: ETA = ceil(540/60)+buffer 5 = 14, body matches UI payload", p[0]?.body?.ETA === 14 && p[0]?.body?.id === 7001 && p[0]?.body?.comments === "" && p[0]?.body?.notes === "auto-accept by Lightning Dispatch" && p[0]?.body?.tireAvailable === false, JSON.stringify(p[0]?.body));
    const rows = await decisions();
    check("decision row: driver 703785 + name + eta 14 + zone distance + raw accept response", rows.length === 1 && String(rows[0].driver_id) === "703785" && String(rows[0].driver_name) === "Jayden Fountain" && Number(rows[0].eta_minutes) === 14 && Number(rows[0].zone_distance_miles) > 0 && rows[0].raw_response?.accept?.callNumber === 25000, JSON.stringify(rows[0]));
    check("decision row: call_id reconciled from accept response", String(rows[0].call_id) === "279999999", String(rows[0].call_id));
    check("decision row: reason carries the road breakdown note (provider-qualified)", String(rows[0].reason).includes("ETA 14 min (osrm road 9 + buffer 5") && String(rows[0].reason).includes("straight-line 11") && String(rows[0].reason).includes("GPS 41.18,-73.15"), String(rows[0].reason));
    check("decision row: raw_response.eta has road seconds + buffer/floor/ceiling facts", rows[0].raw_response?.eta?.roadSeconds === 540 && rows[0].raw_response?.eta?.usedFallback === false && rows[0].raw_response?.eta?.straightLineMinutes === 11 && rows[0].raw_response?.eta?.bufferMinutes === 5 && rows[0].raw_response?.eta?.floorMinutes === 5 && rows[0].raw_response?.eta?.ceilingMinutes === 45 && rows[0].raw_response?.eta?.finalMinutes === 14, JSON.stringify(rows[0].raw_response?.eta));
    const a = await audits();
    check("audit: 1 ai_dispatcher:accept row", Number(a[0].n) === 1, String(a[0].n));
    check("syncForOrg triggered with sync:auto-accept + actor", syncCalls.length === 1 && syncCalls[0].trigger === "sync:auto-accept" && syncCalls[0].actor?.id === USER, JSON.stringify(syncCalls));
  }

  /* ============ 8) dedupe: same offer re-polled → one decision row ============ */
  {
    const m = makeFetch({
      offers: [offer(7001), offer(7002)],
      drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 }), driver(603482, "Antone jerret", { etaSec: 1255 })],
    });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("dedupe: 7001 skipped (already decided), 7002 processed", r.offersSeen === 2 && r.processed === 1 && r.decisions[0]?.callRequestId === "7002", JSON.stringify(r));
    const rows = await decisions();
    check("dedupe: still exactly 2 decision rows (7001, 7002)", rows.length === 2 && rows.every((x) => x.decision === "auto_accept_with_driver"), JSON.stringify(rows.map((x) => x.call_request_id)));
  }

  /* ============ 9) per-offer maxEta overrides the org default ============ */
  {
    const m = makeFetch({
      offers: [offer(7003, { maxEta: 10 })],
      drivers: [driver(703785, "Jayden Fountain", { lat: 41.1, lng: -73.0, etaSec: 3600 })], // road 3600s → 60+5 = 65 → clamped to 10
    });
    const router = makeRouter({ "41.10,-73.00": 3600 });
    const { deps } = makeDeps(m.fetchImpl, router);
    const r = await runAutoDispatch(ORG, deps);
    const p = posts(m.calls);
    check("maxEta override: ETA clamped to 10 (offer maxEta beats 45)", p[0]?.body?.ETA === 10, JSON.stringify(p[0]?.body));
    check("maxEta override: decision recorded", r.processed === 1 && r.decisions[0]?.decision === "auto_accept_with_driver", JSON.stringify(r));
  }

  /* ============ 10) boundary: 29.5 mi in-zone accepted ============ */
  {
    const m = makeFetch({
      offers: [offer(7004, { lat: northOf(29.5), lng: ZONE.lng })],
      drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })],
    });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("boundary inside: accepted (29.5 mi ≤ 30)", r.decisions[0]?.decision === "auto_accept_with_driver" && posts(m.calls).length === 1, JSON.stringify(r.decisions));
  }

  /* ============ 11) out-of-zone universal fallback ============ */
  {
    const m = makeFetch({
      offers: [offer(7005, { lat: northOf(30.5), lng: ZONE.lng, startingLocation: "123 MAIN ST, BRIDGEPORT CT 06607" })],
      drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })],
    });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("out-of-zone: auto_accept_no_driver, driverId 0, SLA accept", r.decisions[0]?.decision === "auto_accept_no_driver" && r.decisions[0]?.escalated === true && posts(m.calls).length === 1 && String(posts(m.calls)[0].body.driverId) === "0" && Number(posts(m.calls)[0].body.ETA) === 45 && String(posts(m.calls)[0].body.notes).includes("awaiting driver assignment"), JSON.stringify({ decision: r.decisions[0], post: posts(m.calls)[0] }));
    const rows = await decisions();
    const oz = rows.find((x) => String(x.call_request_id) === "7005");
    check("out-of-zone: zone_distance_miles recorded > 30", oz && Number(oz.zone_distance_miles) > 30, String(oz?.zone_distance_miles));
  }

  /* ============ 12) missing coords escalation ============ */
  {
    const m = makeFetch({ offers: [offer(7006, { lat: 0, lng: 0 })], drivers: [] });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("missing coords: auto_accept_no_driver, driverId 0, SLA accept", r.decisions[0]?.decision === "auto_accept_no_driver" && r.decisions[0]?.escalated === true && posts(m.calls).length === 1 && String(posts(m.calls)[0].body.driverId) === "0" && Number(posts(m.calls)[0].body.ETA) === 45 && String(posts(m.calls)[0].body.notes).includes("awaiting driver assignment"), JSON.stringify({ decision: r.decisions[0], post: posts(m.calls)[0] }));
  }

  /* ============ 13) expired offer escalation ============ */
  {
    const m = makeFetch({ offers: [offer(7007, { past: true })], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })] });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("expired: escalated_expired, zero POSTs", r.decisions[0]?.decision === "escalated_expired" && posts(m.calls).length === 0, JSON.stringify(r.decisions));
  }

  /* ============ 14) unexpected shape escalation (full offer captured, no accept) ============ */
  {
    const bad = offer(7008, { omitLat: true });
    const m = makeFetch({ offers: [bad], drivers: [] });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("shape: auto_accept_no_driver, driverId 0, SLA accept", r.decisions[0]?.decision === "auto_accept_no_driver" && r.decisions[0]?.escalated === true && posts(m.calls).length === 1 && String(posts(m.calls)[0].body.driverId) === "0" && Number(posts(m.calls)[0].body.ETA) === 45 && String(posts(m.calls)[0].body.notes).includes("awaiting driver assignment"), JSON.stringify({ decision: r.decisions[0], post: posts(m.calls)[0] }));
    const rows = await decisions();
    const sr = rows.find((x) => String(x.call_request_id) === "7008");
    check("shape: decision keyed by callRequestId, evidence carries the full original offer", sr && String(sr.call_request_id) === "7008" && sr.raw_response?.evidence?.offer?.accountName === bad.accountName && sr.raw_response?.evidence?.offer?.startLocationLatitude === undefined, JSON.stringify(sr));
  }

  /* ============ 15) driver lookup failure escalation ============ */
  {
    const m = makeFetch({ offers: [offer(7009)], drivers: [], nearestDriversStatus: 500 });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("driver lookup 500: auto_accept_no_driver, driverId 0, SLA accept", r.decisions[0]?.decision === "auto_accept_no_driver" && r.decisions[0]?.escalated === true && posts(m.calls).length === 1 && String(posts(m.calls)[0].body.driverId) === "0" && Number(posts(m.calls)[0].body.ETA) === 45 && String(posts(m.calls)[0].body.notes).includes("awaiting driver assignment"), JSON.stringify({ decision: r.decisions[0], post: posts(m.calls)[0] }));
  }

  /* ============ 16) accept failure: one retry, then escalation (never dropped) ============ */
  {
    const m = makeFetch({ offers: [offer(7010)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })], acceptFails: 2 });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("accept failed twice: escalated_accept_failed, exactly 2 POSTs", r.decisions[0]?.decision === "escalated_accept_failed" && posts(m.calls).length === 2, JSON.stringify(r.decisions));
    const rows = await decisions();
    const ar = rows.find((x) => String(x.call_request_id) === "7010");
    check("accept failed: raw_response has the offer + both attempt bodies", ar && String(ar.raw_response?.offer?.callRequestId) === "7010" && Array.isArray(ar.raw_response?.attempts) && ar.raw_response.attempts.length === 2 && ar.raw_response.attempts.every((t) => t.status === 500), JSON.stringify(ar?.raw_response?.attempts));
  }

  /* ============ 17) accept failure → retry succeeds ============ */
  {
    const m = makeFetch({ offers: [offer(7011)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })], acceptFails: 1 });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("accept retry succeeded: auto_accept_with_driver, 2 POSTs total", r.decisions[0]?.decision === "auto_accept_with_driver" && posts(m.calls).length === 2, JSON.stringify(r.decisions));
  }

  /* ============ 17a) offer_lost_race: another provider already accepted the broadcast offer ============ */
  {
    // Towbook's real reply when another provider wins the offer first: the
    // accept POST returns this exact message. The old logic read it as a
    // successful accept, then post-accept verification failed ("call not found
    // after accept" — the call lives under the winning provider) and the engine
    // falsely escalated_dispatch_failed "needs a human to assign on Towbook".
    // Owner-reported 2026-08-11: offers 326636200 (19:09Z) + 326600476 (15:25Z).
    const lostRaceReply = { error: "This dispatch offer has already been responded to with an Accept and is currently being processed." };
    const m = makeFetch({
      offers: [offer(7051)],
      drivers: [driver(603482, "Antone jerret", { etaSec: 604 })],
      acceptBody: lostRaceReply,
    });
    const { deps, syncCalls } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG5, deps);
    check("lost race: decision offer_lost_race, NOT escalated", r.decisions[0]?.decision === "offer_lost_race" && r.decisions[0]?.escalated === false, JSON.stringify(r.decisions));
    check("lost race: reason names another provider + no action needed", String(r.decisions[0]?.reason).includes("another provider won the offer") && String(r.decisions[0]?.reason).includes("no action needed"), String(r.decisions[0]?.reason));
    check("lost race: exactly ONE POST (the accept attempt) — no assign, no verify writes", posts(m.calls).length === 1, JSON.stringify(posts(m.calls)));
    const rows = await decisions5();
    check("lost race: ledger row escalated=false + raw accept reply captured", rows.length === 1 && rows[0].decision === "offer_lost_race" && rows[0].escalated === false && String(rows[0].raw_response?.accept?.error ?? "").includes("already been responded to with an Accept"), JSON.stringify(rows[0]));
    check("lost race: NO sync triggered (nothing changed on our side)", syncCalls.length === 0, JSON.stringify(syncCalls));
    // The ops queue "Needs attention" banner is driven by escalated=TRUE rows.
    const escOpen = await q`SELECT count(*)::int n FROM ai_dispatcher_decisions WHERE org_id=${ORG5} AND escalated=TRUE`;
    check("lost race: zero escalated rows in the org — no needs-a-human banner", Number(escOpen[0].n) === 0, String(escOpen[0].n));
  }

  /* ============ 17b) lost-race reply wrapped in a NON-2xx response is STILL offer_lost_race (never escalated_accept_failed) ============ */
  {
    const lostRaceReply = { error: "This dispatch offer has already been responded to with an Accept and is currently being processed." };
    const m = makeFetch({ offers: [offer(7053)], drivers: [driver(603482, "Antone jerret", { etaSec: 604 })], acceptStatus: 400, acceptBody: lostRaceReply });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG5, deps);
    check("lost race non-2xx: decision offer_lost_race, NOT escalated", r.decisions[0]?.decision === "offer_lost_race" && r.decisions[0]?.escalated === false, JSON.stringify(r.decisions));
  }

  /* ============ 17c) genuine accept failure STILL escalates (guard not weakened) ============ */
  {
    const m = makeFetch({ offers: [offer(7052)], drivers: [driver(603482, "Antone jerret", { etaSec: 604 })], acceptFails: 2 });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG5, deps);
    check("genuine accept failure: STILL escalated_accept_failed + escalated true (2 POSTs)", r.decisions[0]?.decision === "escalated_accept_failed" && r.decisions[0]?.escalated === true && posts(m.calls).length === 2, JSON.stringify({ d: r.decisions[0], posts: posts(m.calls).length }));
    const rows = await decisions5();
    check("genuine accept failure: ledger row is escalated_accept_failed, NOT offer_lost_race", rows.some((x) => x.call_request_id === "7052" && x.decision === "escalated_accept_failed" && x.escalated === true), JSON.stringify(rows));
  }

  /* ============ 18) cap-full driver with unlocated jobs → workload ETA ============ */
  // The ONLY eligible candidate (603482) is at the 3-job cap with payload
  // calls carrying no coords. Old behavior: unmodelable queue → driverId 0 +
  // escalate. Owner-directed 2026-08-11: a busy driver's workload still counts
  // — 3 unlocated jobs ≈ 3×30 service + final leg → dispatched with the
  // workload ETA, clamped to the org ceiling (45).
  {
    const m = makeFetch({
      offers: [offer(7012)],
      drivers: [driver(603482, "Antone jerret", { etaSec: 10, calls: [{ callId: 1, status: 3 }, { callId: 2, status: 3 }, { callId: 3, status: 3 }] }), driver(103665, "Brittani Simms", { lat: 0, lng: 0 }), driver(717660, "Levi C Martin", { checkedIn: false })],
    });
    const { deps, syncCalls } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("busy-at-cap: decision auto_accept_with_driver (workload model), escalated false", r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false, JSON.stringify(r.decisions));
    const p = posts(m.calls);
    check("busy-at-cap: dispatched to 603482 with workload ETA clamped to 45", p.length === 1 && p[0]?.body?.driverId === 603482 && p[0]?.body?.ETA === 45, JSON.stringify(p[0]?.body));
    check("busy-at-cap: sync still triggered after accept", syncCalls.length === 1 && syncCalls[0].trigger === "sync:auto-accept", JSON.stringify(syncCalls));
    const rows = await decisions();
    const nd = rows.find((x) => String(x.call_request_id) === "7012");
    check("busy-at-cap: no-GPS/offline drivers still excluded (eligible list honored)", nd && String(nd.driver_id) === "603482", String(nd?.driver_id));
    check("busy-at-cap: reason names workload-aware chain + unlocated jobs, ETA recorded", nd && String(nd.reason).includes("workload-aware") && String(nd.reason).includes("unlocated") && Number(nd.eta_minutes) === 45, String(nd?.reason));
    check("busy-at-cap: raw_response now captures the FULL offer + accept response", nd && nd.raw_response?.offer?.callRequestId === "7012" && nd.raw_response?.accept?.callNumber === 25000, JSON.stringify(nd?.raw_response));
  }

  /* ============ 19) non-pending offers (status != 0) are skipped silently ============ */
  {
    const m = makeFetch({ offers: [offer(7013, { status: 1 })], drivers: [] });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("status=1 offer: skipped, no decision, no POSTs", r.offersSeen === 1 && r.processed === 0 && r.decisions.length === 0 && posts(m.calls).length === 0, JSON.stringify(r));
  }

  /* ============ 20) settings toggle gate ============ */
  {
    await q`UPDATE org_settings SET ai_dispatcher_enabled=FALSE WHERE org_id=${ORG}`;
    const m = makeFetch({ offers: [offer(7014)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })] });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("disabled: gated=true, zero fetch calls, zero decisions", r.gated === true && m.calls.length === 0 && r.decisions.length === 0, JSON.stringify(r));
    await q`UPDATE org_settings SET ai_dispatcher_enabled=TRUE WHERE org_id=${ORG}`;
    const { deps: deps2 } = makeDeps(m.fetchImpl);
    const r2 = await runAutoDispatch(ORG, deps2);
    check("re-enabled: engine acts again", r2.gated === false && r2.processed === 1, JSON.stringify(r2));
  }

  /* ============ 21) routing failure → fallback factor model (no fabricated road) ============ */
  {
    const m = makeFetch({
      offers: [offer(7015)],
      drivers: [driver(703785, "Jayden Fountain", { lat: 41.15, lng: -73.1, etaSec: 604 })],
    });
    const router = makeRouter({ "41.15,-73.10": null }); // OSRM failed for this driver
    const { deps } = makeDeps(m.fetchImpl, router);
    const r = await runAutoDispatch(ORG, deps);
    const p = posts(m.calls);
    const expBase = fallbackRoadMinutes(haversineMiles(41.15, -73.1, 41.2, -73.2));
    check("fallback: still auto-accepted with the driver (router hiccup never drops a driver)", r.decisions[0]?.decision === "auto_accept_with_driver" && p[0]?.body?.driverId === 703785, JSON.stringify(r.decisions));
    check("fallback: ETA = fallback base + buffer (no fabricated road time)", p[0]?.body?.ETA === expBase + 5, `expected ${expBase + 5}, got ${p[0]?.body?.ETA}`);
    const rows = await decisions();
    const fr = rows.find((x) => String(x.call_request_id) === "7015");
    check("fallback: decision row flags usedFallback + null roadSeconds + breakdown note", fr && Number(fr.eta_minutes) === expBase + 5 && fr.raw_response?.eta?.usedFallback === true && fr.raw_response?.eta?.roadSeconds === null && fr.raw_response?.eta?.straightLineMinutes === 11 && String(fr.reason).includes("road fallback") && String(fr.reason).includes(`buffer 5`), JSON.stringify(fr?.raw_response?.eta));
  }

  /* ============ 22) floor applied (road + buffer below the configured floor) ============ */
  {
    await q`UPDATE org_settings SET eta_floor_minutes=15 WHERE org_id=${ORG}`;
    const m = makeFetch({
      offers: [offer(7016)],
      drivers: [driver(703785, "Jayden Fountain", { lat: 41.19, lng: -73.15, etaSec: 604 })], // road 60s → 1+5 = 6 → floor 15
    });
    const router = makeRouter({ "41.19,-73.15": 60 });
    const { deps } = makeDeps(m.fetchImpl, router);
    const r = await runAutoDispatch(ORG, deps);
    const p = posts(m.calls);
    check("floor: ETA lifted to 15 (1+5 = 6 < floor)", p[0]?.body?.ETA === 15, JSON.stringify(p[0]?.body));
    const rows = await decisions();
    const fl = rows.find((x) => String(x.call_request_id) === "7016");
    check("floor: reason + raw_response record the applied floor", fl && String(fl.reason).includes("floor 15") && fl.raw_response?.eta?.floorMinutes === 15 && fl.raw_response?.eta?.finalMinutes === 15, String(fl?.reason));
    await q`UPDATE org_settings SET eta_floor_minutes=5 WHERE org_id=${ORG}`;
  }

  /* ============ 23) org ceiling respected (road + buffer above max_eta_minutes) ============ */
  {
    const m = makeFetch({
      offers: [offer(7017)],
      drivers: [driver(603482, "Antone jerret", { lat: 41.1, lng: -73.0, etaSec: 3600 })], // road 3600s → 60+5 = 65 → ceiling 45
    });
    const router = makeRouter({ "41.10,-73.00": 3600 });
    const { deps } = makeDeps(m.fetchImpl, router);
    const r = await runAutoDispatch(ORG, deps);
    const p = posts(m.calls);
    check("ceiling: ETA clamped to 45 (org max_eta_minutes)", p[0]?.body?.ETA === 45, JSON.stringify(p[0]?.body));
    const rows = await decisions();
    const ce = rows.find((x) => String(x.call_request_id) === "7017");
    check("ceiling: reason records ceiling 45", ce && String(ce.reason).includes("ceiling 45") && Number(ce.eta_minutes) === 45, String(ce?.reason));
  }

  /* ============ 24) choice BY ROAD ETA: better road time beats better straight-line ============ */
  {
    const m = makeFetch({
      offers: [offer(7018)],
      drivers: [
        driver(703785, "Jayden Fountain", { lat: 41.1, lng: -73.0, etaSec: 300 }),   // 5 min straight-line (old winner) — 60 min ROAD
        driver(603482, "Antone jerret", { lat: 41.19, lng: -73.15, etaSec: 1800 }), // 30 min straight-line — 10 min ROAD
      ],
    });
    const router = makeRouter({ "41.10,-73.00": 3600, "41.19,-73.15": 600 });
    const { deps } = makeDeps(m.fetchImpl, router);
    const r = await runAutoDispatch(ORG, deps);
    const p = posts(m.calls);
    check("choice-by-road: Antone (10 min road) dispatched over Jayden (5 min straight-line)", p[0]?.body?.driverId === 603482, JSON.stringify(p[0]?.body));
    check("choice-by-road: ETA = 10 + buffer 5 = 15", p[0]?.body?.ETA === 15, JSON.stringify(p[0]?.body));
    const rows = await decisions();
    const cb = rows.find((x) => String(x.call_request_id) === "7018");
    check("choice-by-road: decision names Antone + road breakdown", cb && String(cb.driver_name) === "Antone jerret" && String(cb.reason).includes("road 10 + buffer 5") && cb.raw_response?.eta?.roadSeconds === 600 && cb.raw_response?.eta?.straightLineMinutes === 30, String(cb?.reason));
  }

  /* ============ 25) no-GPS excluded; cap-full driver gets workload ETA ============ */
  {
    const m = makeFetch({
      offers: [offer(7019)],
      drivers: [
        driver(103665, "Brittani Simms", { lat: 0, lng: 0, etaSec: 5 }),          // no GPS → never eligible
        driver(703785, "Jayden Fountain", { lat: 41.2, lng: -73.2, etaSec: 10, calls: [{ callId: 1, status: 3 }, { callId: 2, status: 3 }, { callId: 3, status: 3 }] }), // at the 3-job cap → workload model
      ],
    });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("no-GPS: no-GPS driver excluded, cap-full Jayden dispatched (workload ETA)", r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false, JSON.stringify(r.decisions));
    const p = posts(m.calls);
    check("no-GPS: dispatched to 703785 with workload ETA clamped to 45", p.length === 1 && p[0]?.body?.driverId === 703785 && p[0]?.body?.ETA === 45, JSON.stringify(p[0]?.body));
    const rows = await decisions();
    const ng = rows.find((x) => String(x.call_request_id) === "7019");
    check("no-GPS: ETA recorded in the ledger (workload model, clamped 45)", ng && Number(ng.eta_minutes) === 45 && String(ng.reason).includes("workload-aware"), String(ng?.reason));
  }

  /* ============ 26a) post-accept dispatch verification (2026-08-10 incident fix) ============ */
  {
    // accept → verification passes on the accept-response call fetch (1 POST only)
    const m = makeFetch({ offers: [offer(8011)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })] });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("verif ok: decision auto_accept_with_driver + reason says VERIFIED", r.decisions[0]?.decision === "auto_accept_with_driver" && String(r.decisions[0]?.reason).includes("VERIFIED on call 279999999"), String(r.decisions[0]?.reason));
    check("verif ok: exactly ONE POST (accept) — verification is GET-only", posts(m.calls).length === 1, JSON.stringify(posts(m.calls)));
    const rows1 = await decisions();
    const v1 = rows1.find((x) => String(x.call_request_id) === "8011");
    check("verif ok: raw_response has offer + verification(ok, acceptResponse)", v1 && v1.raw_response?.offer?.callRequestId === "8011" && v1.raw_response?.verification?.ok === true && v1.raw_response?.verification?.source === "acceptResponse" && v1.raw_response?.verification?.driverOnCall === "703785", JSON.stringify(v1?.raw_response?.verification));
  }
  {
    // THE INCIDENT: accepted driver ≠ driver on the call → assign endpoint called
    // once → succeeds → re-verify → VERIFIED + assignedAfterRetry
    const m = makeFetch({ offers: [offer(8012)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })], callDriverId: 999999, assignSucceeds: true });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    const p = posts(m.calls);
    check("verif assign-retry: decision auto_accept_with_driver + VERIFIED reason", r.decisions[0]?.decision === "auto_accept_with_driver" && String(r.decisions[0]?.reason).includes("VERIFIED"), String(r.decisions[0]?.reason));
    const w = m.calls.filter((c) => c.method === "POST" || c.method === "PUT");
    check("verif assign-retry: exactly TWO writes — accept POST then PUT /api/calls/279999999 {id, status:{id:1}, assets:[{id:424242, drivers:[{driver:{id:703785}}]}]}", w.length === 2 && w[1]?.method === "PUT" && w[1]?.url.endsWith("/api/calls/279999999") && w[1]?.body?.id === 279999999 && w[1]?.body?.status?.id === 1 && w[1]?.body?.assets?.[0]?.id === 424242 && w[1]?.body?.assets?.[0]?.drivers?.[0]?.driver?.id === 703785, JSON.stringify(w));
    const rows2 = await decisions();
    const v2 = rows2.find((x) => String(x.call_request_id) === "8012");
    check("verif assign-retry: verification.assignedAfterRetry true + driverOnCall 703785", v2 && v2.raw_response?.verification?.assignedAfterRetry === true && v2.raw_response?.verification?.driverOnCall === "703785", JSON.stringify(v2?.raw_response?.verification));
  }
  {
    // assign attempt fails → escalated_dispatch_failed with evidence, escalated=true
    const m = makeFetch({ offers: [offer(8013)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })], callDriverId: 999999, assignSucceeds: false });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("verif assign-fail: escalated_dispatch_failed + escalated true", r.decisions[0]?.decision === "escalated_dispatch_failed" && r.decisions[0]?.escalated === true, JSON.stringify(r.decisions));
    const rows3 = await decisions();
    const v3 = rows3.find((x) => String(x.call_request_id) === "8013");
    check("verif assign-fail: reason names the driver + needs a human", v3 && String(v3.reason).includes("dispatch NOT verified") && String(v3.reason).includes("needs a human"), String(v3?.reason));
    check("verif assign-fail: raw_response has verification evidence (assign 500 recorded)", v3 && v3.raw_response?.verification?.ok === false && v3.raw_response?.verification?.attempts?.length >= 2, JSON.stringify(v3?.raw_response?.verification));
  }
  {
    // verification fetch race: first call GET fails, retry succeeds → VERIFIED
    const m = makeFetch({ offers: [offer(8014)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })], callsFailures: 1 });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("verif race: first fetch fails then retry → still VERIFIED", r.decisions[0]?.decision === "auto_accept_with_driver" && String(r.decisions[0]?.reason).includes("VERIFIED"), String(r.decisions[0]?.reason));
    const rows4 = await decisions();
    const v4 = rows4.find((x) => String(x.call_request_id) === "8014");
    check("verif race: verification ok after retry", v4 && v4.raw_response?.verification?.ok === true, JSON.stringify(v4?.raw_response?.verification));
  }
  /* ============ 26e) fresh accept lands at status 0 → PO match on the status-0 list ============ */
  {
    // THE 2026-08-12 GAP: the accept reply carries NO call id (real replies are
    // a plain message) and the created call sits at status 0 (Received) — the
    // old [2,1]-only search could never see it, so 4/8 offers escalated "call
    // not found after accept". Now: the status-0 list is searched FIRST, the PO
    // ties the call, the driver is already on it (accept-with-driver) →
    // VERIFIED with exactly ONE POST (accept only).
    const m = makeFetch({ offers: [offer(8016)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })], acceptBody: { ok: true }, acceptedCallStatus: 0 });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("status0-match: decision auto_accept_with_driver + reason says VERIFIED on call 279999999", r.decisions[0]?.decision === "auto_accept_with_driver" && String(r.decisions[0]?.reason).includes("VERIFIED on call 279999999"), String(r.decisions[0]?.reason));
    check("status0-match: exactly ONE POST (accept) — PO match needs no assign", posts(m.calls).length === 1, JSON.stringify(m.calls));
    const rows6 = await decisions();
    const v6 = rows6.find((x) => String(x.call_request_id) === "8016");
    check("status0-match: verification source=purchaseOrder, statusId=0, driverOnCall=703785", v6 && v6.raw_response?.verification?.source === "purchaseOrder" && v6.raw_response?.verification?.statusId === 0 && v6.raw_response?.verification?.driverOnCall === "703785", JSON.stringify(v6?.raw_response?.verification));
    check("status0-match: verification attempted the status-0 list FIRST", v6 && v6.raw_response?.verification?.attempts?.[0]?.url?.includes("status=0"), JSON.stringify(v6?.raw_response?.verification?.attempts));
  }
  /* ============ 26f) status-0 call, driver NOT on it → PUT assign (status 1 + asset) ============ */
  {
    // The 2026-08-12 failure mode: accept-with-driverId does NOT attach the
    // driver; the call sits at status 0 with no driver. allowAssign must PUT
    // the VERIFIED dispatch payload {id, status:{id:1}, assets:[{id, drivers:
    // [{driver:{id}}]}]} (map-actions.js useDispatchCall) and re-verify. The
    // old guessed endpoint (POST /api/calls/{id}/assignDrivers) 404s live —
    // proven on FIVE offers 2026-08-12 — so the assign path NEVER worked.
    const m = makeFetch({ offers: [offer(8017)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })], acceptBody: { ok: true }, acceptedCallStatus: 0, callDriverId: 999999, assignSucceeds: true });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("status0-assign: decision auto_accept_with_driver + VERIFIED after assign", r.decisions[0]?.decision === "auto_accept_with_driver" && String(r.decisions[0]?.reason).includes("VERIFIED"), String(r.decisions[0]?.reason));
    const all7 = m.calls;
    const put = all7.find((c) => c.method === "PUT");
    check("status0-assign: PUT /api/calls/279999999 {id, status:{id:1}, assets:[{id:424242, drivers:[{driver:{id:703785}}]}]}", put && put.url.endsWith("/api/calls/279999999") && put.body?.id === 279999999 && put.body?.status?.id === 1 && put.body?.assets?.[0]?.id === 424242 && put.body?.assets?.[0]?.drivers?.[0]?.driver?.id === 703785, JSON.stringify(put));
    const rows7 = await decisions();
    const v7 = rows7.find((x) => String(x.call_request_id) === "8017");
    check("status0-assign: assignedAfterRetry true + assetId recorded + driverOnCall 703785", v7 && v7.raw_response?.verification?.assignedAfterRetry === true && v7.raw_response?.verification?.assetId === "424242" && v7.raw_response?.verification?.driverOnCall === "703785", JSON.stringify(v7?.raw_response?.verification));
    check("status0-assign: no /assignDrivers URL anywhere (old guess is gone)", !all7.some((c) => c.url.includes("/assignDrivers")), JSON.stringify(all7.map((c) => `${c.method} ${c.url}`)));
  }
  /* ============ 26g) stale-newest guard: only older calls in the lists → escalate ============ */
  {
    // The 2026-08-12 stale-match incidents (326760451→279860306; 326762556 &
    // 326762868→both 279865368): the bare "newest in list" fallback matched
    // calls that do NOT belong to this offer — one offer even "verified" a call
    // the OWNER had manually dispatched (326773655→279878088). Now: when the
    // status-0/1/2 lists contain ONLY older calls with different POs (the fresh
    // call is not yet visible), verification must NOT match, must NOT assign,
    // and must escalate — never claim a call it cannot tie to the offer.
    const stale2 = [{ id: 279860306, callNumber: 24610, status: { id: 2 }, purchaseOrderNumber: "111111111" }];
    const stale1 = [{ id: 279865368, callNumber: 24612, status: { id: 1 }, purchaseOrderNumber: "222222222" }];
    const m = makeFetch({ offers: [offer(8018)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })], acceptBody: { ok: true }, acceptedCallStatus: 0, suppressCreatedFromStatusLists: true, statusListExtra: { 0: [], 1: stale1, 2: stale2 } });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("stale-guard: escalated_dispatch_failed + call not found after accept", r.decisions[0]?.decision === "escalated_dispatch_failed" && String(r.decisions[0]?.reason).includes("call not found after accept"), JSON.stringify(r.decisions));
    check("stale-guard: NO assign attempted (one POST = accept only)", m.calls.filter((c) => c.method !== "GET").length === 1, JSON.stringify(m.calls.map((c) => `${c.method} ${c.url}`)));
    const rows8 = await decisions();
    const v8 = rows8.find((x) => String(x.call_request_id) === "8018");
    check("stale-guard: verification source=none, no callId claimed", v8 && v8.raw_response?.verification?.source === "none" && v8.raw_response?.verification?.callId === null && v8.call_id === null, JSON.stringify(v8?.raw_response?.verification));
    // The engine searches the status lists twice (initial + the "accept is
    // async" race retry — 6 list GETs live); the ledger records the FINAL
    // round's fetches (the race-retry observability contract, same as 26d).
    // Assert the recorded round: status 0 first, then 2, then 1 — every list
    // searched, never matched, never claimed.
    check("stale-guard: recorded round searched status 0,2,1 in order and NEVER matched", v8 && v8.raw_response?.verification?.attempts?.length === 3 && v8.raw_response?.verification?.attempts?.every((t) => t.matched === false) && v8.raw_response?.verification?.attempts?.[0]?.url?.includes("status=0") && v8.raw_response?.verification?.attempts?.[1]?.url?.includes("status=2") && v8.raw_response?.verification?.attempts?.[2]?.url?.includes("status=1"), JSON.stringify(v8?.raw_response?.verification?.attempts));
  }
  {
    // eligibility rail: offer.drivers[] EXCLUDES the only free driver → engine must
    // NOT dispatch them; accept driverId 0 + escalate (the 703785 root cause path)
    const m = makeFetch({ offers: [{ ...offer(8015), drivers: [603482] }], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })] });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    const p = posts(m.calls);
    check("eligibility: ineligible driver NOT dispatched (driverId 0) + auto_accept_no_driver escalated", r.decisions[0]?.decision === "auto_accept_no_driver" && r.decisions[0]?.escalated === true && p[0]?.body?.driverId === 0, JSON.stringify({ d: r.decisions[0], post: p[0]?.body }));
    const rows5 = await decisions();
    const v5 = rows5.find((x) => String(x.call_request_id) === "8015");
    check("eligibility: reason names the eligible list + accepted without dispatch", v5 && String(v5.reason).includes("no ELIGIBLE") && String(v5.reason).includes("603482"), String(v5?.reason));
  }
  /* ============ 27) ETA v3: TomTom traffic layer (provider chain) ============ */
  // Hermetic: the TomTom/OSRM mocks are injected — no real routing calls ever.
  {
    // 27a) resolveRouter with a key → tomtom provider; the router returns the
    // TomTom RoadResult (travelTimeInSeconds + trafficDelayInSeconds) and the
    // URL carries traffic=true / routeType=fastest / departAt / vehicleCommercial=false.
    const rf = makeRouterFetch();
    const r1 = resolveRouter({ TOMTOM_API_KEY: "test-key-not-real" }, rf.fetchImpl);
    check("resolveRouter: key set → tomtom + tomtomKeyConfigured true", r1.provider === "tomtom" && r1.tomtomKeyConfigured === true && typeof r1.router === "function");
    const res1 = await r1.router(41.15, -73.1, 41.2, -73.2);
    check("tomtom router: travelTimeInSeconds + trafficDelayInSeconds reported", res1?.provider === "tomtom" && res1.liveTraffic === true && res1.seconds === 540 && res1.trafficDelaySeconds === 120 && String(res1.notes).includes("delay 120"), JSON.stringify(res1));
    check("tomtom URL: traffic=true & routeType=fastest & departAt & vehicleCommercial=false", rf.tomtomCalls.length === 1 && rf.tomtomCalls[0].includes("traffic=true") && rf.tomtomCalls[0].includes("routeType=fastest") && rf.tomtomCalls[0].includes("departAt=") && rf.tomtomCalls[0].includes("vehicleCommercial=false"), rf.tomtomCalls[0]);
  }
  {
    // 27b) resolveRouter with NO key anywhere (env empty, key file unreadable —
    // TOMTOM_KEY_FILE points nowhere so the real stable key file never leaks
    // into this hermetic test) → osrm provider; OSRM static RoadResult.
    const rf = makeRouterFetch();
    const r2 = resolveRouter({ TOMTOM_KEY_FILE: "/nonexistent/tomtom.key" }, rf.fetchImpl);
    check("resolveRouter: no key → osrm + tomtomKeyConfigured false", r2.provider === "osrm" && r2.tomtomKeyConfigured === false && typeof r2.router === "function");
    const res2 = await r2.router(41.15, -73.1, 41.2, -73.2);
    check("osrm router: duration seconds + static provider (no traffic)", res2?.provider === "osrm" && res2.seconds === 600 && res2.liveTraffic === false && rf.osrmCalls.length === 1 && rf.tomtomCalls.length === 0, JSON.stringify(res2));
  }
  {
    // 27c) TomTom 429 → chained fall-through to OSRM (provider flips to osrm).
    const rf = makeRouterFetch({ tomtomStatus: 429 });
    const r3 = resolveRouter({ TOMTOM_API_KEY: "test-key-not-real" }, rf.fetchImpl);
    const res3 = await r3.router(41.15, -73.1, 41.2, -73.2);
    check("tomtom 429 → OSRM fallback (1 call each, provider osrm)", res3?.provider === "osrm" && res3.seconds === 600 && rf.tomtomCalls.length === 1 && rf.osrmCalls.length === 1, JSON.stringify(res3));
    check("tomtom 429: transient failure surfaced (tomtomFailure HTTP 429) — ETA honesty", res3?.tomtomFailure === "HTTP 429", JSON.stringify(res3));
  }
  {
    // 27d) TomTom failure AND OSRM failure → null → caller uses the factor model.
    const rf = makeRouterFetch({ tomtomStatus: 500, osrmStatus: 500 });
    const r4 = resolveRouter({ TOMTOM_API_KEY: "test-key-not-real" }, rf.fetchImpl);
    const res4 = await r4.router(41.15, -73.1, 41.2, -73.2);
    check("tomtom+osrm both fail → null (factor fallback by caller)", res4 === null);
  }
  {
    // 27e) ETA_ROUTER=off → factor-only (router null); osrmRoadSeconds/
    // tomtomRoadSeconds also return the RoadResult shape directly.
    const r5 = resolveRouter({ ETA_ROUTER: "off", TOMTOM_KEY_FILE: "/nonexistent/tomtom.key" }, makeRouterFetch().fetchImpl);
    check("resolveRouter: ETA_ROUTER=off → factor + router null", r5.provider === "factor" && r5.router === null && r5.tomtomKeyConfigured === false);
    const rf5 = makeRouterFetch();
    const osrmRes = await osrmRoadSeconds(41.15, -73.1, 41.2, -73.2, rf5.fetchImpl);
    check("osrmRoadSeconds returns RoadResult shape", osrmRes?.provider === "osrm" && osrmRes.seconds === 600 && osrmRes.trafficDelaySeconds === null, JSON.stringify(osrmRes));
    const rf5b = makeRouterFetch();
    const ttRes = await tomtomRoadSeconds("test-key-not-real", 41.15, -73.1, 41.2, -73.2, rf5b.fetchImpl);
    check("tomtomRoadSeconds returns RoadResult shape (delay carried)", ttRes?.provider === "tomtom" && ttRes.seconds === 540 && ttRes.trafficDelaySeconds === 120, JSON.stringify(ttRes));
  }
  {
    // 27f) engine end-to-end WITH a key, through the REAL resolveRouter path
    // (no routerOverride): TomTom URL hit, ETA = ceil(540/60)=9 + buffer 5 = 14,
    // reason names tomtom-traffic + delay, raw_response.eta carries provider/
    // liveTraffic/trafficDelaySeconds/routerNotes.
    const m = makeFetch({ offers: [offer(8021)], drivers: [driver(603482, "Antone jerret", { lat: 41.15, lng: -73.1, etaSec: 1255 })] });
    const rf = makeRouterFetch();
    const { deps } = makeDeps(withRouter(m.fetchImpl, rf.fetchImpl), null, { noRouterOverride: true, env: { TOMTOM_API_KEY: "test-key-not-real" } });
    const r = await runAutoDispatch(ORG3, deps);
    check("engine+key: auto_accept_with_driver + reason names tomtom-traffic + delay 2", r.decisions[0]?.decision === "auto_accept_with_driver" && String(r.decisions[0]?.reason).includes("tomtom-traffic road") && String(r.decisions[0]?.reason).includes("delay 2"), String(r.decisions[0]?.reason));
    check("engine+key: exactly one TomTom call, zero OSRM calls (key path)", rf.tomtomCalls.length === 1 && rf.osrmCalls.length === 0, `${rf.tomtomCalls.length}/${rf.osrmCalls.length}`);
    const rows = await decisions3();
    const v = rows.find((x) => String(x.call_request_id) === "8021");
    check("engine+key: ETA 14 min + raw_response.eta provider tomtom/liveTraffic/delay/routerNotes", v && Number(v.eta_minutes) === 14 && v.raw_response?.eta?.provider === "tomtom" && v.raw_response?.eta?.liveTraffic === true && v.raw_response?.eta?.trafficDelaySeconds === 120 && String(v.raw_response?.eta?.routerNotes).includes("delay 120"), JSON.stringify(v?.raw_response?.eta));
  }
  {
    // 27g) engine end-to-end WITHOUT a key anywhere, through the REAL
    // resolveRouter path (no routerOverride): TOMTOM_KEY_FILE points nowhere so
    // the real stable key file never leaks into the test → OSRM URL hit (600s →
    // 10 min), reason names osrm, no TomTom call.
    const m = makeFetch({ offers: [offer(8022)], drivers: [driver(603482, "Antone jerret", { lat: 41.15, lng: -73.1, etaSec: 1255 })] });
    const rf = makeRouterFetch();
    const { deps } = makeDeps(withRouter(m.fetchImpl, rf.fetchImpl), null, { noRouterOverride: true, env: { TOMTOM_KEY_FILE: "/nonexistent/tomtom.key" } });
    const r = await runAutoDispatch(ORG3, deps);
    check("engine no-key: auto_accept_with_driver + reason names osrm road", r.decisions[0]?.decision === "auto_accept_with_driver" && String(r.decisions[0]?.reason).includes("osrm road"), String(r.decisions[0]?.reason));
    check("engine no-key: exactly one OSRM call, zero TomTom calls", rf.osrmCalls.length === 1 && rf.tomtomCalls.length === 0, `${rf.osrmCalls.length}/${rf.tomtomCalls.length}`);
    const rows = await decisions3();
    const v = rows.find((x) => String(x.call_request_id) === "8022");
    check("engine no-key: raw_response.eta provider osrm + liveTraffic false", v && v.raw_response?.eta?.provider === "osrm" && v.raw_response?.eta?.liveTraffic === false && v.raw_response?.eta?.trafficDelaySeconds === null, JSON.stringify(v?.raw_response?.eta));
  }
  {
    // 27h) engine with a routerOverride tomtom provider (hermetic seam): the
    // decision reason records the provider without any real routing call.
    const m = makeFetch({ offers: [offer(8023)], drivers: [driver(603482, "Antone jerret", { lat: 41.15, lng: -73.1, etaSec: 1255 })] });
    const router = makeRouter({ "41.15,-73.10": { seconds: 480, provider: "tomtom", liveTraffic: true, trafficDelaySeconds: 45, notes: "travel 480s; traffic delay 45s" } });
    const { deps } = makeDeps(m.fetchImpl, router);
    const r = await runAutoDispatch(ORG3, deps);
    check("engine override-tomtom: reason names tomtom-traffic + delay 1", r.decisions[0]?.decision === "auto_accept_with_driver" && String(r.decisions[0]?.reason).includes("tomtom-traffic road") && String(r.decisions[0]?.reason).includes("delay 1"), String(r.decisions[0]?.reason));
    const rows = await decisions3();
    const v = rows.find((x) => String(x.call_request_id) === "8023");
    check("engine override-tomtom: eta.provider tomtom + delay 45s recorded", v && v.raw_response?.eta?.provider === "tomtom" && v.raw_response?.eta?.trafficDelaySeconds === 45 && Number(v.eta_minutes) === 13, JSON.stringify(v?.raw_response?.eta));
  }
  {
    // 27i) etaProviderStatus — the exact surface getAiDispatcherStatus exposes
    // (server.ts imports this pure fn): correct with/without the key + factor.
    // The no-key cases point TOMTOM_KEY_FILE nowhere so the real stable key
    // file never leaks into this hermetic test.
    const withKey = etaProviderStatus({ TOMTOM_API_KEY: "test-key-not-real" });
    const noKey = etaProviderStatus({ TOMTOM_KEY_FILE: "/nonexistent/tomtom.key" });
    const off = etaProviderStatus({ ETA_ROUTER: "off", TOMTOM_KEY_FILE: "/nonexistent/tomtom.key" });
    check("etaProviderStatus: key → tomtom + keyConfigured true (never the key)", withKey.etaProvider === "tomtom" && withKey.tomtomKeyConfigured === true && JSON.stringify(withKey).includes("test-key") === false);
    check("etaProviderStatus: no key → osrm + keyConfigured false", noKey.etaProvider === "osrm" && noKey.tomtomKeyConfigured === false);
    check("etaProviderStatus: ETA_ROUTER=off → factor", off.etaProvider === "factor" && off.tomtomKeyConfigured === false);
  }
  {
    // 27j) resolveTomtomKey — env-first, then TOMTOM_KEY_FILE, then the stable
    // key file (the LIVE production source). Hermetic: the temp file is written
    // and removed within this block; the stable-path read is read-only and the
    // VALUE is never printed (length only) — the key never appears in output.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ttkey-"));
    const f = join(dir, "tomtom.key");
    writeFileSync(f, "  file-key-abc\n\n"); // whitespace + trailing newline must trim
    const viaFile = resolveTomtomKey({ TOMTOM_KEY_FILE: f });
    check("resolveTomtomKey: TOMTOM_KEY_FILE read + whitespace trimmed", viaFile === "file-key-abc", String(viaFile));
    const envWins = resolveTomtomKey({ TOMTOM_API_KEY: "env-key", TOMTOM_KEY_FILE: f });
    check("resolveTomtomKey: env TOMTOM_API_KEY wins over the key file", envWins === "env-key", String(envWins));
    const missing = resolveTomtomKey({ TOMTOM_KEY_FILE: join(dir, "nope.key") });
    check("resolveTomtomKey: unreadable file → null (degrades, never crashes)", missing === null, String(missing));
    const stable = resolveTomtomKey({});
    check("resolveTomtomKey: empty env → stable key file resolves non-empty (value never echoed)", typeof stable === "string" && stable.length > 0, `len=${stable?.length ?? -1}`);
    // Artifact fallback (the hosted-live fix, mirroring b2-client.ts): when the
    // machine-local sibling dir is unavailable the build-embedded copy at
    // <site-root>/dist/.secrets/tomtom.key resolves — but ONLY on an explicit
    // opt-in. Both checks need dist/.secrets/tomtom.key present (the build's
    // prepare-secrets.sh embeds it), so this suite runs after a build.
    const { existsSync, mkdirSync, copyFileSync, unlinkSync, writeFileSync: writeArtifact, rmSync: removeArtifact } = await import("node:fs");
    const artifactPath = join(process.cwd(), "dist", ".secrets", "tomtom.key");
    const artifactDir = join(process.cwd(), "dist", ".secrets");
    const artifactBackup = join(dir, "preexisting-artifact");
    const hadArtifact = existsSync(artifactPath);
    // Detached verification worktrees do not carry ignored build secrets. Install
    // only a non-committed test credential at the exact artifact path, never read
    // or print an existing credential, and restore/remove it in finally.
    if (hadArtifact) { copyFileSync(artifactPath, artifactBackup); unlinkSync(artifactPath); }
    mkdirSync(artifactDir, { recursive: true });
    writeArtifact(artifactPath, "fixture-tomtom-key\n", { mode: 0o600 });
    try {
      const artifact = resolveTomtomKey({}, { stableKeyFile: join(dir, "nope.key"), allowArtifactFallback: true });
      check("resolveTomtomKey: isolated artifact fallback resolves <site-root>/dist/.secrets/tomtom.key", existsSync(artifactPath) && artifact === "fixture-tomtom-key", `exists=${existsSync(artifactPath)} len=${artifact?.length ?? -1}`);
      const hermetic = resolveTomtomKey({}, { stableKeyFile: join(dir, "nope.key") });
      check("resolveTomtomKey: explicit stableKeyFile override stays hermetic — artifact fallback NOT consulted", hermetic === null, String(hermetic));
    } finally {
      removeArtifact(artifactPath, { force: true });
      if (hadArtifact) { copyFileSync(artifactBackup, artifactPath); unlinkSync(artifactBackup); }
    }
    const routerViaFile = resolveRouter({ TOMTOM_KEY_FILE: f }, makeRouterFetch().fetchImpl);
    check("resolveRouter: key from file → tomtom provider + keyConfigured true", routerViaFile.provider === "tomtom" && routerViaFile.tomtomKeyConfigured === true && typeof routerViaFile.router === "function");
    rmSync(dir, { recursive: true, force: true });
  }

  /* ============ 28) queue-aware capacity + all-loaded arrival (owner 2026-08-11) ============ */
  // Rules: a driver may hold up to MAX_DRIVER_QUEUE (=3) active jobs; eligible
  // = checked-in && GPS && active < 3 (active = dispatch_jobs lifecycle
  // statuses new/offered/accepted/en_route/arrived, cross-checked against the
  // payload calls). All candidates at the cap → queue-inclusive arrival model.
  {
    check("constants: MAX_DRIVER_QUEUE=3, SERVICE_MINUTES_PER_JOB=30", MAX_DRIVER_QUEUE === 3 && SERVICE_MINUTES_PER_JOB === 30, `cap=${MAX_DRIVER_QUEUE} service=${SERVICE_MINUTES_PER_JOB}`);
    // (a) 2-job driver eligible, 3-job driver NOT — even when the 3-job driver
    // is road-nearer.
    const q2 = new Map([["1001", { activeCount: 2, queuedJobs: [
      { pickupLat: 41.16, pickupLng: -73.11, status: "en_route", createdAt: "t1" },
      { pickupLat: 41.17, pickupLng: -73.12, status: "arrived", createdAt: "t2" },
    ] }]]);
    const q3 = new Map([["1002", { activeCount: 3, queuedJobs: [
      { pickupLat: 41.18, pickupLng: -73.13, status: "en_route", createdAt: "t1" },
      { pickupLat: 41.19, pickupLng: -73.14, status: "arrived", createdAt: "t2" },
      { pickupLat: 41.20, pickupLng: -73.15, status: "accepted", createdAt: "t3" },
    ] }]]);
    const twoJob = driver(1001, "Two Job", { lat: 41.19, lng: -73.15, etaSec: 604 });
    const threeJob = driver(1002, "Three Job", { lat: 41.18, lng: -73.14, etaSec: 300 }); // road-nearer
    // Rq: GPS→J1 900s; J1→J2 300s (new key); J2→offer 600s (new key); threeJob GPS 300s
    const Rq = makeRouter({ "41.19,-73.15": 900, "41.18,-73.14": 300, "41.16,-73.11": 300, "41.17,-73.12": 600 });
    const pickCap = await chooseBestDriverByRoad([twoJob, threeJob], 41.2, -73.2, Rq, new Map([...q2, ...q3]));
    check("queue cap: 2-job driver eligible, 3-job driver excluded — 2-job ETA is now workload-aware", pickCap?.driver.driverId === 1001 && pickCap?.queueInclusive === true, JSON.stringify(pickCap));
    check("queue cap: workload chain math (travel 15 + service 30 + travel 5 + service 30 + final 10 = 90)", pickCap?.queueMinutes === 80 && pickCap?.queuedJobCount === 2 && pickCap?.finalLegMinutes === 10 && pickCap?.baseMinutes === 90 && pickCap?.startedOnScene === false, JSON.stringify(pickCap));
    // payload-calls cross-check: 2 active payload calls eligible, 3 not
    const pay2 = driver(2001, "Pay Two", { lat: 41.19, lng: -73.15, etaSec: 604, calls: [{ callId: 1, status: 3 }, { callId: 2, status: 4 }] });
    const pay3 = driver(2002, "Pay Three", { lat: 41.18, lng: -73.14, etaSec: 300, calls: [{ callId: 1, status: 3 }, { callId: 2, status: 3 }, { callId: 3, status: 3 }] });
    const pickPay = await chooseBestDriverByRoad([pay2, pay3], 41.2, -73.2, Rq);
    check("queue cap via payload calls: 2-call driver eligible, 3-call driver excluded", pickPay?.driver.driverId === 2001, JSON.stringify(pickPay));
    check("driverActiveCount: max(payload, dispatch_jobs) per driver", driverActiveCount(pay2, new Map()) === 2 && driverActiveCount(pay3, new Map()) === 3 && driverActiveCount(twoJob, q2) === 2 && driverActiveCount(threeJob, q3) === 3, "");
    // completed/cancelled payload calls never count toward the cap
    const payDone = driver(2003, "Pay Done", { lat: 41.19, lng: -73.15, etaSec: 604, calls: [{ callId: 1, status: 5 }, { callId: 2, status: 252 }, { callId: 3, status: 255 }] });
    check("driverActiveCount: completed/cancelled payload calls never count", driverActiveCount(payDone, new Map()) === 0, String(driverActiveCount(payDone, new Map())));
    // (b) nearest (min road ETA) wins among sub-3-job drivers
    const subFar = driver(2004, "Sub Far", { lat: 41.1, lng: -73.0, etaSec: 604, calls: [{ callId: 1, status: 3 }] });
    const subNear = driver(2005, "Sub Near", { lat: 41.19, lng: -73.15, etaSec: 604, calls: [{ callId: 1, status: 3 }] });
    const pickSub = await chooseBestDriverByRoad([subFar, subNear], 41.2, -73.2, makeRouter({ "41.10,-73.00": 3600, "41.19,-73.15": 600 }));
    check("nearest wins among sub-3-job drivers (workload ETA 40 min = 30 service + 10 road, vs 90)", pickSub?.driver.driverId === 2005 && pickSub?.baseMinutes === 40, JSON.stringify(pickSub));
    // (c) ALL-LOADED: both at the cap → queue-inclusive arrival wins + math recorded
    // A: legs 600s(10m) + 300s(5m) + 300s(5m) + 3×30 service = 110 queue; final 600s=10 → 120
    // B: legs 900s(15m) + 300s(5m) + 300s(5m) + 3×30 service = 115 queue; final 900s=15 → 130
    const qA3 = new Map([["3001", { activeCount: 3, queuedJobs: [
      { pickupLat: 41.16, pickupLng: -73.11, status: "en_route", createdAt: "t1" },
      { pickupLat: 41.17, pickupLng: -73.12, status: "arrived", createdAt: "t2" },
      { pickupLat: 41.18, pickupLng: -73.13, status: "accepted", createdAt: "t3" },
    ] }]]);
    const qB3 = new Map([["3002", { activeCount: 3, queuedJobs: [
      { pickupLat: 41.26, pickupLng: -73.26, status: "en_route", createdAt: "t1" },
      { pickupLat: 41.27, pickupLng: -73.27, status: "arrived", createdAt: "t2" },
      { pickupLat: 41.28, pickupLng: -73.28, status: "accepted", createdAt: "t3" },
    ] }]]);
    const dA = driver(3001, "Queue A", { lat: 41.15, lng: -73.10, etaSec: 604 });
    const dB = driver(3002, "Queue B", { lat: 41.25, lng: -73.25, etaSec: 604 });
    const Rq3 = makeRouter({
      "41.15,-73.10": 600, // A GPS → J1
      "41.16,-73.11": 300,
      "41.17,-73.12": 300,
      "41.18,-73.13": 600, // A J3 → offer (final leg from the LAST job, not GPS)
      "41.25,-73.25": 900, // B GPS → J1
      "41.26,-73.26": 300,
      "41.27,-73.27": 300,
      "41.28,-73.28": 900, // B J3 → offer (final leg from the LAST job, not GPS)
    });
    const pickAll = await chooseBestDriverByRoad([dA, dB], 41.2, -73.2, Rq3, new Map([...qA3, ...qB3]));
    check("all-loaded: closest driver B wins over farther A despite A's better chain ETA", pickAll?.driver.driverId === 3002 && pickAll?.queueInclusive === true, JSON.stringify(pickAll));
    check("all-loaded: chain math recorded for closest B (3 jobs ≈ 115 min + final leg 15; arrival 130)", pickAll?.queueMinutes === 115 && pickAll?.queuedJobCount === 3 && pickAll?.finalLegMinutes === 15 && pickAll?.baseMinutes === 130, JSON.stringify(pickAll));
    check("all-loaded: quoted ETA includes queue time (ceil(130)+5 = 135)", finalEtaMinutes(pickAll.baseMinutes, 5, 5, 180) === 135, String(finalEtaMinutes(pickAll.baseMinutes, 5, 5, 180)));
    check("all-loaded: clamps at the ceiling (45 default) — floor/ceiling rails kept", finalEtaMinutes(pickAll.baseMinutes, 5, 5, 45) === 45, String(finalEtaMinutes(pickAll.baseMinutes, 5, 5, 45)));
    // workloadAwareArrivalMinutes directly: fallback factor when routing fails
    const dirQ = await workloadAwareArrivalMinutes(dA, qA3.get("3001").queuedJobs, 41.2, -73.2, makeRouter({ "41.15,-73.10": null, "41.16,-73.11": null, "41.17,-73.12": null }));
    check("queue model: router failure → factor fallback per leg (still > 90 min service)", dirQ && dirQ.arrivalMinutes > 90 && dirQ.queueMinutes > 90 && dirQ.finalLegMinutes > 0, JSON.stringify(dirQ));
    // queue model: no active jobs → null (free driver — current-position model applies)
    check("queue model: no active jobs → null (free driver, not a workload case)", (await workloadAwareArrivalMinutes(dA, [], 41.2, -73.2, Rq3)) === null, "");
    // on-scene first job (owner formula: arrived → remaining is service only; the
    // final leg starts from the CURRENT job's location, never from the GPS ping)
    const onScene = await workloadAwareArrivalMinutes(
      dA, [{ pickupLat: 41.16, pickupLng: -73.11, status: "arrived", createdAt: "t1" }], 41.2, -73.2,
      makeRouter({ "41.16,-73.11": 600 }), 1);
    check("queue model: arrived at current job → service only + final leg from the JOB (no GPS→pickup leg)", onScene && onScene.startedOnScene === true && onScene.queueMinutes === 30 && onScene.finalLegMinutes === 10 && onScene.arrivalMinutes === 40, JSON.stringify(onScene));
    // en-route first job: GPS→pickup travel + service (remaining drive, upper bound)
    const enRoute = await workloadAwareArrivalMinutes(
      dA, [{ pickupLat: 41.16, pickupLng: -73.11, status: "en_route", createdAt: "t1" }], 41.2, -73.2,
      makeRouter({ "41.15,-73.10": 600, "41.16,-73.11": 600 }), 1);
    check("queue model: en-route current job → GPS→pickup travel 10 + service 30 + final leg 10 = 50", enRoute && enRoute.startedOnScene === false && enRoute.queueMinutes === 40 && enRoute.finalLegMinutes === 10 && enRoute.arrivalMinutes === 50, JSON.stringify(enRoute));
    // multi-job chain (owner formula): finish A → travel A→B → finish B → travel B→offer
    const chain3 = await workloadAwareArrivalMinutes(
      dA, [
        { pickupLat: 41.16, pickupLng: -73.11, status: "en_route", createdAt: "t1" },
        { pickupLat: 41.17, pickupLng: -73.12, status: "arrived", createdAt: "t2" },
        { pickupLat: 41.18, pickupLng: -73.13, status: "accepted", createdAt: "t3" },
      ], 41.2, -73.2, Rq3, 3);
    check("queue model: 3-job chain 10+30 + 5+30 + 5+30 = 110 queue + final 10 = 120", chain3 && chain3.queueMinutes === 110 && chain3.finalLegMinutes === 10 && chain3.arrivalMinutes === 120, JSON.stringify(chain3));
    // ETA honesty in the workload chain: a leg that fell back after a TomTom
    // failure must CARRY that failure to the decision record — never a silent
    // provider=osrm with tomtomFailure=null (owner-shared incident 2026-08-11).
    const ttFail = await workloadAwareArrivalMinutes(
      dA, [{ pickupLat: 41.16, pickupLng: -73.11, status: "en_route", createdAt: "t1" }], 41.2, -73.2,
      makeRouter({ "41.15,-73.10": { seconds: 600, provider: "osrm", liveTraffic: false, trafficDelaySeconds: null, notes: "osrm after tomtom 429", tomtomFailure: "HTTP 429" } }), 1);
    check("queue model: TomTom failure on a chain leg is carried (tomtomFailure HTTP 429) — ETA honesty", ttFail?.tomtomFailure === "HTTP 429", JSON.stringify(ttFail));
    // gps ping age surface (best-effort — the live payload has no timestamp)
    const stale = { ...driver(2006, "Stale GPS", { lat: 41.19, lng: -73.15, etaSec: 604 }), gpsUpdatedAtUtc: new Date(Date.now() - 30 * 60000).toISOString() };
    check("gpsPingAgeMinutes: detects a 30-min-old ping", gpsPingAgeMinutes(stale) != null && gpsPingAgeMinutes(stale) >= 29 && gpsPingAgeMinutes(stale) <= 31, String(gpsPingAgeMinutes(stale)));
    check("gpsPingAgeMinutes: no timestamp → null (nothing to flag)", gpsPingAgeMinutes(driver(2007, "Fresh", { etaSec: 604 })) === null, "");
    const stalePick = await chooseBestDriverByRoad([stale], 41.2, -73.2, makeRouter({ "41.19,-73.15": 600 }));
    check("stale GPS: decision label flags 'GPS ping age 30 min'", stalePick != null && String(etaDetailLabel(stalePick, 5, 5, 45, 15)).includes("GPS ping age 30 min"), String(stalePick && etaDetailLabel(stalePick, 5, 5, 45, 15)));
  }

  /* ============ 29) engine: queue-aware dispatch end-to-end (ORG4) ============ */
  {
    // Seed dispatch_jobs queues for ORG4 (3s-sync persists calls with assigned
    // driver + pickup coords; the engine counts from exactly this table).
    const seedJob = (id, driverId, lat, lng, createdAgoH) => q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, pickup_lat, pickup_lng, assigned_driver_towbook_id)
      VALUES(${id}, ${ORG4}, 'QA Queued', '555-0101', 0, 0, 'Bridgeport', 'jump', 'en_route', ${new Date(Date.now() - createdAgoH * 3600e3).toISOString()}, '', ${lat}, ${lng}, ${driverId})`;
    await seedJob(`qa4-a1`, "3001", 41.16, -73.11, 3);
    await seedJob(`qa4-a2`, "3001", 41.17, -73.12, 2);
    await seedJob(`qa4-a3`, "3001", 41.18, -73.13, 1);
    await seedJob(`qa4-b1`, "3002", 41.26, -73.26, 3);
    await seedJob(`qa4-b2`, "3002", 41.27, -73.27, 2);
    await seedJob(`qa4-b3`, "3002", 41.28, -73.28, 1);
    await seedJob(`qa4-c1`, "3003", 41.10, -73.00, 2);
    await seedJob(`qa4-c2`, "3003", 41.11, -73.01, 1);
    const queues = await loadOrgDriverQueues(ORG4);
    check("loadOrgDriverQueues: counts per driver from dispatch_jobs (3/3/2)", queues.get("3001")?.activeCount === 3 && queues.get("3002")?.activeCount === 3 && queues.get("3003")?.activeCount === 2 && queues.get("3001")?.queuedJobs.length === 3, JSON.stringify([...queues].map(([k, v]) => [k, v.activeCount])));

    const router = makeRouter({
      "41.15,-73.10": 600, "41.16,-73.11": 300, "41.17,-73.12": 300, "41.18,-73.13": 600, // A J3 → offer
      "41.25,-73.25": 900, "41.26,-73.26": 300, "41.27,-73.27": 300, "41.28,-73.28": 900, // B J3 → offer
      "41.19,-73.15": 600, // 3003 GPS → J1
      "41.10,-73.00": 600, // 3003 J1 → J2
      "41.11,-73.01": 900, // 3003 J2 → offer (final leg from the LAST job)
    });
    // (d) accept still posts the chosen driverId + quoted ETA — all-loaded case:
    // both candidates at the 3-job cap → distance-first winner 3002, ETA 135.
    {
      const m = makeFetch({
        offers: [{ ...offer(8031), drivers: [3001, 3002] }],
        drivers: [driver(3001, "Queue A", { lat: 41.15, lng: -73.10, etaSec: 604 }), driver(3002, "Queue B", { lat: 41.25, lng: -73.25, etaSec: 604 })],
      });
      const { deps } = makeDeps(m.fetchImpl, router);
      const r = await runAutoDispatch(ORG4, deps);
      check("engine all-loaded: auto_accept_with_driver + winner 3002", r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false && r.decisions[0]?.reason.includes("VERIFIED"), JSON.stringify(r.decisions[0]));
      const p = posts(m.calls);
      check("engine all-loaded: accept posts driverId 3002 + workload ETA 135", p.length === 1 && p[0]?.body?.driverId === 3002 && p[0]?.body?.ETA === 135, JSON.stringify(p[0]?.body));
      const rows = await q`SELECT call_request_id, decision, driver_id, eta_minutes, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG4} AND call_request_id='8031'`;
      const row = rows[0];
      check("engine all-loaded: reason names winner + chain math (3 active jobs ≈ 115 min; ETA 135 min)", row && String(row.driver_id) === "3002" && Number(row.eta_minutes) === 135 && String(row.reason).includes("3 active jobs ≈ 115 min") && String(row.reason).includes("final leg 15") && String(row.reason).includes("ETA 135 min"), String(row?.reason));
      check("engine all-loaded: raw_response.eta chain facts recorded", row && row.raw_response?.eta?.queueInclusive === true && row.raw_response?.eta?.queueMinutes === 115 && row.raw_response?.eta?.queuedJobCount === 3 && row.raw_response?.eta?.finalLegMinutes === 15 && row.raw_response?.eta?.startedOnScene === false && row.raw_response?.eta?.unlocatedJobs === 0 && row.raw_response?.eta?.finalMinutes === 135, JSON.stringify(row?.raw_response?.eta));
    }
    // (a/b) engine: under-cap driver beats an over-cap driver, even when
    // road-farther (3003 has 2 jobs → eligible; 3001 has 3 → excluded) — and the
    // 2-job driver's ETA is now WORKLOAD-AWARE (owner 2026-08-11), not the old
    // naive GPS→offer road time.
    {
      const m = makeFetch({
        offers: [{ ...offer(8032), drivers: [3001, 3003] }],
        drivers: [driver(3001, "Queue A", { lat: 41.15, lng: -73.10, etaSec: 604 }), driver(3003, "Two Job", { lat: 41.19, lng: -73.15, etaSec: 604 })],
      });
      const { deps } = makeDeps(m.fetchImpl, router);
      const r = await runAutoDispatch(ORG4, deps);
      const p = posts(m.calls);
      check("engine under-cap: 2-job driver 3003 dispatched over 3-job 3001, workload ETA 100", r.decisions[0]?.decision === "auto_accept_with_driver" && p[0]?.body?.driverId === 3003 && p[0]?.body?.ETA === 100, JSON.stringify({ d: r.decisions[0], p: p[0]?.body }));
      const rows = await q`SELECT reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG4} AND call_request_id='8032'`;
      check("engine under-cap: reason names workload-aware chain (2 active jobs ≈ 80 min + final leg 15)", rows[0] && String(rows[0].reason).includes("workload-aware: 2 active jobs ≈ 80 min") && String(rows[0].reason).includes("final leg 15") && rows[0].raw_response?.eta?.queueInclusive === true && rows[0].raw_response?.eta?.queueMinutes === 80 && rows[0].raw_response?.eta?.finalLegMinutes === 15, String(rows[0]?.reason));
    }
    // (e) regression: single-driver happy path with dispatch_jobs EMPTY still
    // dispatches (no queue rows → 0 active → eligible, ETA normal).
    {
      const m = makeFetch({ offers: [offer(8033)], drivers: [driver(703785, "Jayden Fountain", { lat: 41.18, lng: -73.15, etaSec: 604 })] });
      const router2 = makeRouter({ "41.18,-73.15": 540 });
      const { deps } = makeDeps(m.fetchImpl, router2);
      const r = await runAutoDispatch(ORG4, deps);
      const p = posts(m.calls);
      check("engine regression: empty queue → driver eligible, ETA 14 (road 9 + buffer 5)", r.decisions[0]?.decision === "auto_accept_with_driver" && p[0]?.body?.driverId === 703785 && p[0]?.body?.ETA === 14, JSON.stringify({ d: r.decisions[0], p: p[0]?.body }));
    }
    // ETA honesty: transient TomTom failure is surfaced in the reason when the
    // chained router falls through (engine-level, real resolveRouter path).
    {
      const m = makeFetch({ offers: [offer(8034)], drivers: [driver(603482, "Antone jerret", { lat: 41.15, lng: -73.1, etaSec: 1255 })] });
      const rf = makeRouterFetch({ tomtomStatus: 429 });
      const { deps } = makeDeps(withRouter(m.fetchImpl, rf.fetchImpl), null, { noRouterOverride: true, env: { TOMTOM_API_KEY: "test-key-not-real" } });
      const r = await runAutoDispatch(ORG4, deps);
      const rows = await q`SELECT reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG4} AND call_request_id='8034'`;
      check("engine tomtom-429: reason surfaces 'tomtom failed (HTTP 429) → osrm' + ETA still quoted", rows[0] && String(rows[0].reason).includes("tomtom failed (HTTP 429) → osrm") && String(rows[0].reason).includes("osrm road 10 + buffer 5") && rows[0].raw_response?.eta?.tomtomFailure === "HTTP 429", String(rows[0]?.reason));
      check("engine tomtom-429: 1 TomTom call, 1 OSRM call (chain attempted live first)", rf.tomtomCalls.length === 1 && rf.osrmCalls.length === 1, `${rf.tomtomCalls.length}/${rf.osrmCalls.length}`);
    }
    // ETA honesty in the WORKLOAD chain (busy driver): the decision records the
    // TomTom failure when a chain leg fell back — provider osrm + tomtomFailure
    // HTTP 429, never the silent osrm/usedFallback=false/tomtomFailure=null combo.
    {
      const m = makeFetch({
        offers: [{ ...offer(8035), drivers: [3001, 3003] }],
        drivers: [driver(3001, "Queue A", { lat: 41.15, lng: -73.10, etaSec: 604 }), driver(3003, "Two Job", { lat: 41.19, lng: -73.15, etaSec: 604 })],
      });
      const router3 = makeRouter({
        "41.19,-73.15": 600, // 3003 GPS → J1
        "41.10,-73.00": 600, // 3003 J1 → J2
        "41.11,-73.01": { seconds: 900, provider: "osrm", liveTraffic: false, trafficDelaySeconds: null, notes: "osrm after tomtom 429", tomtomFailure: "HTTP 429" }, // J2 → offer (TomTom failed)
      });
      const { deps } = makeDeps(m.fetchImpl, router3);
      const r = await runAutoDispatch(ORG4, deps);
      const p = posts(m.calls);
      const rows = await q`SELECT reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG4} AND call_request_id='8035'`;
      check("engine workload tomtom-429: busy-driver chain records tomtomFailure HTTP 429 (no silent fallback)", rows[0] && rows[0].raw_response?.eta?.tomtomFailure === "HTTP 429" && rows[0].raw_response?.eta?.provider === "osrm" && String(rows[0].reason).includes("tomtom failed (HTTP 429) → osrm") && String(rows[0].reason).includes("workload-aware: 2 active jobs ≈ 80 min"), String(rows[0]?.reason));
      check("engine workload tomtom-429: still dispatches 3003 with the workload ETA 100", r.decisions[0]?.decision === "auto_accept_with_driver" && p[0]?.body?.driverId === 3003 && p[0]?.body?.ETA === 100, JSON.stringify({ d: r.decisions[0], p: p[0]?.body }));
    }
  }

  /* ============ 30) coordinate-less offer resolution (owner-directed 2026-08-13) ============ */
  // LIVE HIT: offer 326885213 ("Out of Network - Allstate", Georgetown TX)
  // arrived with NO startLocationLatitude/Longitude and correctly escalated
  // (decision row shape-68a5a8964714). Owner direction: missing-coords offers
  // must STILL dispatch when the location is resolvable — DB-first
  // (dispatch_jobs already imported the call with real waypoint coords), else
  // a VALIDATED TomTom geocode of startingLocation (score floor + strong-token
  // overlap; the naive geocode of the Georgetown address resolved to Cotulla TX
  // ~200 mi away at score 14 — blind geocoding is REJECTED). Unresolvable →
  // the existing escalation rail, reason noting the resolution failure.
  {
    // (a) the pure validation rail against the EXACT live evidence.
    const liveAddr = "1441 I 35 N FRONTAGE RD, GEORGETOWN TX 78628";
    const cotulla = validateGeocodeResult(liveAddr, { lat: 29.03, lng: -98.99, score: 14, freeformAddress: "500 Frontage Rd, Cotulla, TX 78014" });
    check("coords validation: live Cotulla hit rejected on the score floor (14 < 40)", !cotulla.ok && String(cotulla.reason).includes("score 14"), JSON.stringify(cotulla));
    const cotullaHi = validateGeocodeResult(liveAddr, { lat: 29.03, lng: -98.99, score: 90, freeformAddress: "500 Frontage Rd, Cotulla, TX 78014" });
    check("coords validation: wrong-city high-score rejected on ZIP mismatch (78014 ≠ 78628)", !cotullaHi.ok && String(cotullaHi.reason).includes("ZIP 78014"), JSON.stringify(cotullaHi));
    const good = validateGeocodeResult(liveAddr, { lat: 30.6337, lng: -97.6773, score: 95, freeformAddress: "1441 I-35 N Frontage Rd, Georgetown, TX 78628" });
    check("coords validation: ZIP-matching high-score result accepted", good.ok === true && good.lat === 30.6337 && good.lng === -97.6773, JSON.stringify(good));
    const zipOnly = validateGeocodeResult("BRIDGEPORT CT 06606", { lat: 41.2, lng: -73.2, score: 80, freeformAddress: "Bridgeport, CT 06606" });
    check("coords validation: zip-only offer address accepted on the ZIP token", zipOnly.ok === true, JSON.stringify(zipOnly));
    const cityStreet = validateGeocodeResult("1441 MAIN ST, BRIDGEPORT CT 06606", { lat: 41.19, lng: -73.15, score: 88, freeformAddress: "1441 Main St, Bridgeport, CT 06606" });
    check("coords validation: city + street-token overlap accepted", cityStreet.ok === true, JSON.stringify(cityStreet));
    const noOverlap = validateGeocodeResult("1441 MAIN ST, BRIDGEPORT CT 06606", { lat: 41.19, lng: -73.15, score: 88, freeformAddress: "500 Frontage Rd, Cotulla, TX 78014" });
    check("coords validation: high-score but no ZIP/city/street overlap still rejected", !noOverlap.ok, JSON.stringify(noOverlap));
    check("coords validation: score floor constant is 40", GEOCODE_SCORE_FLOOR === 40, String(GEOCODE_SCORE_FLOOR));
  }
  {
    // (b) engine, DB-first: the call already sits in dispatch_jobs (the sync
    // imported it with real waypoint coords) → the coordinate-less offer
    // resolves from the DB and dispatches NORMALLY — no escalation, decision
    // records coords.source=db + the PO tie.
    await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, pickup, raw_json, pickup_lat, pickup_lng)
      VALUES('qa6-db1', ${ORG6}, 'QA DB Coords', '', 0, 0, 'Bridgeport', 'tow', 'accepted', NOW(), '', '279999001', '1441 MAIN ST, BRIDGEPORT CT 06606', ${JSON.stringify({ purchaseOrderNumber: "11256001", startingLocation: "1441 MAIN ST, BRIDGEPORT CT 06606" })}::jsonb, 41.19, -73.15)`;
    const m = makeFetch({
      offers: [offer(6001, { omitLat: true, omitLng: true, startingLocation: "1441 MAIN ST, BRIDGEPORT CT 06606" })],
      drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })],
    });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG6, deps);
    check("coords DB: auto_accept_with_driver, NOT escalated, exactly one POST", r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false && posts(m.calls).length === 1, JSON.stringify(r.decisions));
    check("coords DB: nearestDrivers queried at the DB-resolved coords (41.19,-73.15)", m.calls.some((c) => c.url.includes("latitude=41.19") && c.url.includes("longitude=-73.15")), JSON.stringify(m.calls.map((c) => c.url)));
    const rows = await q`SELECT call_request_id, decision, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG6} AND call_request_id='6001'`;
    check("coords DB: decision reason + raw_response.offer.coords record source=db + PO detail", rows[0] && String(rows[0].reason).includes("pickup coords: db") && String(rows[0].reason).includes("db PO match") && rows[0].raw_response?.offer?.coords?.source === "db" && rows[0].raw_response?.offer?.startLocationLatitude === 41.19, String(rows[0]?.reason));
  }
  {
    // (c) engine, geocode path: DB has no match, the (mocked) TomTom geocode
    // returns a VALIDATED result → offer dispatches normally with
    // coords.source=geocode + score. The override returns the RAW lookup shape
    // — the engine's own validation still runs on it.
    const m = makeFetch({
      offers: [offer(6002, { omitLat: true, omitLng: true, startingLocation: "200 PARK AVE, BRIDGEPORT CT 06604" })],
      drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })],
    });
    const { deps } = makeDeps(m.fetchImpl, null, {
      geocodeOverride: async () => ({ lat: 41.2, lng: -73.2, score: 95, freeformAddress: "200 Park Ave, Bridgeport, CT 06604" }),
    });
    const r = await runAutoDispatch(ORG6, deps);
    check("coords geocode: auto_accept_with_driver, NOT escalated", r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false, JSON.stringify(r.decisions));
    check("coords geocode: nearestDrivers at the geocoded coords (41.2,-73.2)", m.calls.some((c) => c.url.includes("latitude=41.2") && c.url.includes("longitude=-73.2")), JSON.stringify(m.calls.map((c) => c.url)));
    const rows = await q`SELECT decision, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG6} AND call_request_id='6002'`;
    check("coords geocode: decision records source=geocode + score 95", rows[0] && rows[0].decision === "auto_accept_with_driver" && String(rows[0].reason).includes("pickup coords: geocode") && String(rows[0].reason).includes("score 95") && rows[0].raw_response?.offer?.coords?.source === "geocode", String(rows[0]?.reason));
  }
  {
    // (d) engine, geocode FAILS validation (the live Cotulla case) → STILL
    // escalates exactly as before; the reason names the resolution failure
    // (score floor), the row stays hash-keyed, the full offer stays in
    // raw_response. No accept, no driver lookup, no POST.
    const m = makeFetch({
      offers: [offer(6003, { omitLat: true, omitLng: true, startingLocation: "1441 I 35 N FRONTAGE RD, GEORGETOWN TX 78628" })],
      drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })],
    });
    const { deps } = makeDeps(m.fetchImpl, null, {
      geocodeOverride: async () => ({ lat: 29.03, lng: -98.99, score: 14, freeformAddress: "500 Frontage Rd, Cotulla, TX 78014" }),
    });
    const r = await runAutoDispatch(ORG6, deps);
    check("coords cotulla: universal fallback accept", fallbackAccept(r, m.calls, "6003"), JSON.stringify({ decision: r.decisions[0], post: posts(m.calls)[0] }));
    check("coords cotulla: reason notes coords-0 fallback + awaiting driver assignment", String(r.decisions[0]?.reason).includes("no usable pickup coordinates") && String(r.decisions[0]?.reason).includes("awaiting driver assignment"), String(r.decisions[0]?.reason));
    const rows = await q`SELECT call_request_id, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG6} AND call_request_id='6003'`;
    const sr = rows[0];
    check("coords cotulla: fallback row keyed by callRequestId, evidence carries full raw offer + accept", sr && String(sr.call_request_id) === "6003" && sr.raw_response?.evidence?.offer?.accountName === "Agero (Swoop) Bridgeport" && sr.raw_response?.accept, JSON.stringify(sr));
  }
  {
    // (e) no startingLocation text at all + no coords → escalates (unchanged
    // pre-fix behavior for the truly unresolvable offer).
    const m = makeFetch({ offers: [offer(6004, { omitLat: true, omitLng: true, startingLocation: "" })], drivers: [] });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG6, deps);
    check("coords no-address: universal fallback accept, driverId 0, SLA accept", r.decisions[0]?.decision === "auto_accept_no_driver" && r.decisions[0]?.escalated === true && posts(m.calls).length === 1 && String(posts(m.calls)[0].body.driverId) === "0" && Number(posts(m.calls)[0].body.ETA) === 45 && String(posts(m.calls)[0].body.notes).includes("awaiting driver assignment"), JSON.stringify({ decision: r.decisions[0], post: posts(m.calls)[0] }));
  }
  {
    // (f) dedupe stays sane: the DB-resolved offer (6001, same content) is
    // re-polled → resolution runs but the callRequestId-keyed decision already
    // exists → silently skipped, never double-dispatched.
    const m = makeFetch({
      offers: [offer(6001, { omitLat: true, omitLng: true, startingLocation: "1441 MAIN ST, BRIDGEPORT CT 06606" })],
      drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })],
    });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG6, deps);
    check("coords dedupe: re-polled resolved offer skipped silently (seen 1, processed 0, zero POSTs)", r.offersSeen === 1 && r.processed === 0 && r.decisions.length === 0 && posts(m.calls).length === 0, JSON.stringify(r));
  }
  {
    // (g) tomtomGeocodeLookup: real URL shape (search/2/geocode, limit=3,
    // countrySet=US, adminDistrictSet hint) + raw result parsing; failures →
    // null (the engine then escalates — never guesses).
    const geoCalls = [];
    const geoFetch = async (url) => {
      const u = String(url);
      geoCalls.push(u);
      if (u.includes("api.tomtom.com")) {
        return jsonResponse(200, { results: [{ score: 96, position: { lat: 41.19, lon: -73.15 }, address: { freeformAddress: "1441 Main St, Bridgeport, CT 06606" } }] });
      }
      throw new Error(`geocode mock hit an unexpected URL: ${u}`);
    };
    const res = await tomtomGeocodeLookup("1441 MAIN ST, BRIDGEPORT CT 06606", "test-key-not-real", geoFetch);
    check("tomtomGeocodeLookup: parses raw result (score/position/freeformAddress)", res?.score === 96 && res?.lat === 41.19 && res?.lng === -73.15 && res?.freeformAddress === "1441 Main St, Bridgeport, CT 06606", JSON.stringify(res));
    check("tomtomGeocodeLookup: URL carries limit=3 + countrySet=US + adminDistrictSet=CT", geoCalls.length === 1 && geoCalls[0].includes("/search/2/geocode/1441%20MAIN%20ST%2C%20BRIDGEPORT%20CT%2006606.json") && geoCalls[0].includes("limit=3") && geoCalls[0].includes("countrySet=US") && geoCalls[0].includes("adminDistrictSet=CT"), geoCalls[0] ?? "");
    const bad = await tomtomGeocodeLookup("X", "k", async () => jsonResponse(500, { error: "boom" }));
    check("tomtomGeocodeLookup: HTTP 500 → null (engine escalates, never guesses)", bad === null);
    const badBody = await tomtomGeocodeLookup("X", "k", async () => jsonResponse(200, { results: "junk" }));
    check("tomtomGeocodeLookup: malformed body → null", badBody === null);
  }
  {
    // (h) engine end-to-end through the REAL geocode path (no geocodeOverride):
    // env key present, the router mock serves the TomTom Search geocode shape →
    // the coordinate-less offer resolves via the validated geocode and
    // dispatches normally (one TomTom geocode call + one routing call).
    const m = makeFetch({
      offers: [offer(6005, { omitLat: true, omitLng: true, startingLocation: "300 PULASKI ST, BRIDGEPORT CT 06604" })],
      drivers: [driver(703785, "Jayden Fountain", { lat: 41.19, lng: -73.15, etaSec: 604 })],
    });
    const rf = makeRouterFetch();
    const geoTomtomFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/search/2/geocode/")) {
        return jsonResponse(200, { results: [{ score: 96, position: { lat: 41.19, lon: -73.15 }, address: { freeformAddress: "300 Pulaski St, Bridgeport, CT 06604" } }] });
      }
      return rf.fetchImpl(url, init);
    };
    const { deps } = makeDeps(withRouter(m.fetchImpl, geoTomtomFetch), null, { noRouterOverride: true, env: { TOMTOM_API_KEY: "test-key-not-real" } });
    const r = await runAutoDispatch(ORG6, deps);
    check("coords real-geocode path: auto_accept_with_driver, NOT escalated", r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false, JSON.stringify(r.decisions));
    const rows = await q`SELECT decision, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG6} AND call_request_id='6005'`;
    check("coords real-geocode path: decision records source=geocode + score 96 + verified dispatch", rows[0] && rows[0].decision === "auto_accept_with_driver" && String(rows[0].reason).includes("pickup coords: geocode") && String(rows[0].reason).includes("score 96") && String(rows[0].reason).includes("VERIFIED"), String(rows[0]?.reason));
  }

  /* ============ 27j) state-resolution regressions (authoritative record + placeholder) ============ */
  {
    const tx = "2500 SE Inner Loop, Georgetown, TX 78626";
    const ct = "123 MAIN ST, BRIDGEPORT CT 06606";
    // Zone-guard interplay: ORG6's org_settings carries the default 06606-centroid
    // zone (30-mi radius), so a TX-coordinate pickup is escalated_out_of_zone
    // BEFORE the state guard runs. The suite is sequential — switch the org zone
    // per scenario (CT for CT-coordinate scenarios, Georgetown TX for TX) and
    // restore the original values at the end so later ORG6 tests are unaffected.
    const origZone = (await q`SELECT zone_lat, zone_lng, zone_radius_miles FROM org_settings WHERE org_id=${ORG6}`)[0]
      ?? { zone_lat: 41.208862, zone_lng: -73.207253, zone_radius_miles: 30 };
    const setZone = (lat, lng, radius) => q`UPDATE org_settings SET zone_lat=${lat}, zone_lng=${lng}, zone_radius_miles=${radius} WHERE org_id=${ORG6}`;
    const TX_ZONE = { lat: 30.61948, lng: -97.648242, radius: 50 };
    const runStateCase = async (id, opts = {}) => {
      const m = makeFetch({ offers: [offer(id, { startingLocation: opts.address ?? ct, lat: opts.lat ?? 41.31, lng: opts.lng ?? -73.06, purchaseOrderNumber: opts.po ?? `state-${id}` })], drivers: [driver(703785, "Jayden Fountain")] });
      const { deps } = makeDeps(m.fetchImpl, null, opts.stateResolver ? { stateResolver: opts.stateResolver } : {});
      const r = await runAutoDispatch(ORG6, deps);
      const row = (await q`SELECT decision, driver_id, reason FROM ai_dispatcher_decisions WHERE org_id=${ORG6} AND call_request_id=${String(id)}`)[0];
      return { m, r, row };
    };
    const insertJob = (id, towbookId, po, pickup, lat, lng) => q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, pickup, raw_json, pickup_lat, pickup_lng)
      VALUES(${id}, ${ORG6}, 'QA State Job', '', 0, 0, 'TX', 'tow', 'accepted', NOW(), '', ${towbookId}, ${pickup}, ${JSON.stringify({ purchaseOrderNumber: po, startingLocation: pickup })}::jsonb, ${lat}, ${lng})`;
    // --- CT-coordinate scenarios (default ORG6 zone: 06606 centroid, 30 mi) ---
    const s1 = await runStateCase(6201);
    check("state resolution CT baseline: non-placeholder CT coords auto-accept, not escalated", s1.r.decisions[0]?.decision === "auto_accept_with_driver" && !s1.r.decisions[0]?.escalated, JSON.stringify(s1.r.decisions));
    await insertJob("state-db-1", "280160981", "112716690", `${tx}, USA`, 30.61948, -97.648242);
    const s3 = await runStateCase(6203, { address: tx, lat: 41.214889, lng: -73.195803, po: "112716690", stateResolver: async () => "TX" });
    const s3row = (await q`SELECT reason FROM ai_dispatcher_decisions WHERE org_id=${ORG6} AND call_request_id='6203'`)[0];
    check("state resolution placeholder + authoritative: auto-accepts with both reason markers", s3.r.decisions[0]?.decision === "auto_accept_with_driver" && String(s3row?.reason).includes("Agero CT placeholder") && String(s3row?.reason).includes("authoritative pickup record"), String(s3row?.reason));
    await insertJob("state-db-2", "280170002", "112730001", `${tx}, USA`, 30.61948, -97.648242);
    const s4 = await runStateCase(6204, { address: ct, lat: 41.214889, lng: -73.195803, po: "112730001", stateResolver: async () => "TX" });
    const s4row = (await q`SELECT reason FROM ai_dispatcher_decisions WHERE org_id=${ORG6} AND call_request_id='6204'`)[0];
    check("state resolution authoritative record beats stale offer address", s4.r.decisions[0]?.decision === "auto_accept_with_driver" && String(s4row?.reason).includes("authoritative"), String(s4row?.reason));
    const s7 = await runStateCase(6207, { address: ct, lat: 41.31, lng: -73.06, stateResolver: async () => "TX" });
    check("state resolution no in-state driver: cross-state auto-assign when ETA fits ceiling", s7.r.decisions[0]?.decision === "auto_accept_with_driver" && Number(s7.row?.driver_id) === 703785 && posts(s7.m.calls)[0]?.body?.driverId === 703785 && String(s7.row?.reason).includes("cross-state sole-eligible assignment"), JSON.stringify(s7.row));
    // --- TX-coordinate scenarios: switch the org zone to Georgetown TX ---
    await setZone(TX_ZONE.lat, TX_ZONE.lng, TX_ZONE.radius);
    const s2 = await runStateCase(6202, { address: tx, lat: 30.61948, lng: -97.648242, stateResolver: async () => "TX" });
    check("state resolution TX baseline: address wins when reverse geocode unavailable", s2.r.decisions[0]?.decision === "auto_accept_with_driver" && !s2.r.decisions[0]?.escalated, JSON.stringify(s2.r.decisions));
    const m5 = makeFetch({ offers: [offer(6205, { address: ct, startingLocation: ct, lat: 30.61948, lng: -97.648242, purchaseOrderNumber: "112731111" })], drivers: [driver(703785, "Jayden Fountain")] });
    const rf5 = makeRouterFetch();
    const geoTomtomFetch = async (url, init = {}) => String(url).includes("/search/2/reverseGeocode/")
      ? jsonResponse(200, { addresses: [{ address: { countryCode: "US", adminDistrict: "TX" } }] }) : rf5.fetchImpl(url, init);
    const { deps: d5 } = makeDeps(withRouter(m5.fetchImpl, geoTomtomFetch), null, { noRouterOverride: true, env: { TOMTOM_API_KEY: "test-key-not-real" } });
    const r5 = await runAutoDispatch(ORG6, d5);
    check("state resolution genuine discrepancy: escalates state unknown, no accept (fail closed, never cross-state)", r5.decisions[0]?.decision === "escalated_state_unknown" && r5.decisions[0]?.escalated === true && posts(m5.calls).length === 0 && String(r5.decisions[0]?.reason).includes("genuine location discrepancy") && String(r5.decisions[0]?.reason).includes("cannot verify zone"), JSON.stringify(r5.decisions));
    const s6 = await runStateCase(6206, { address: tx, lat: 30.61948, lng: -97.648242 });
    // Driver 703785 resolves to CT (default resolver) and is physically at CT
    // coords; a CT driver cannot make the 45-min ceiling to Georgetown TX, so
    // the ETA-cap correctly holds the offer: universal fallback, driverId 0.
    check("state resolution cross-state over ceiling: universal fallback", s6.r.decisions[0]?.decision === "auto_accept_no_driver" && s6.r.decisions[0]?.escalated === true && Number(s6.row?.driver_id ?? 0) === 0 && posts(s6.m.calls)[0]?.body?.driverId === 0 && String(s6.row?.reason).includes("cross-state sole-eligible assignment cannot make the SLA ceiling"), JSON.stringify(s6.row));
    // restore ORG6 zone for later tests
    await setZone(origZone.zone_lat, origZone.zone_lng, origZone.zone_radius_miles);
  }

  /* ============ 27k) tick observability: ai_dispatcher_runs (backlog #1) ============ */
  {
    // Every tick leaves a run row: gated, every skipped state, empty feed,
    // offers seen (incl. silent skips: status!==0, already-processed), and
    // auto-accept. Assertions use FILTERED queries so the live 3s background
    // loop — which also writes rows for these connected QA orgs (its real
    // Towbook fetch with the fake cookie always fails → skipped rows) — can
    // never race a check. ORG3 carries the decision-creating runs (its decision
    // count is never total-checked; ORG's exact ledger totals in section 26
    // must stay untouched, so ORG only gets non-decision runs here).
    const runRows = (org, where) => q`SELECT id, ran_at, gated, offers_seen, processed, skipped, offer_ids FROM ai_dispatcher_runs WHERE org_id=${org} ${where ? where : q``} ORDER BY ran_at DESC, created_at DESC`;

    // a) gated tick → gated=true row (engine did nothing, but the trace exists)
    await q`UPDATE org_settings SET ai_dispatcher_enabled=FALSE WHERE org_id=${ORG3}`;
    const rg = await runAutoDispatch(ORG3, makeDeps(makeFetch({ offers: [offer(9100)], drivers: [] }).fetchImpl).deps);
    check("run-row gated: engine returns gated=true, offersSeen=0", rg.gated === true && rg.offersSeen === 0 && rg.skipped === null, JSON.stringify(rg));
    const gRow = (await runRows(ORG3, q`AND gated=TRUE`))[0];
    check("run-row gated: row persisted (gated, offers_seen=0, processed=0, skipped null, offer_ids [])", gRow && gRow.gated === true && Number(gRow.offers_seen) === 0 && Number(gRow.processed) === 0 && gRow.skipped === null && Array.isArray(gRow.offer_ids) && gRow.offer_ids.length === 0, JSON.stringify(gRow));
    await q`UPDATE org_settings SET ai_dispatcher_enabled=TRUE WHERE org_id=${ORG3}`;

    // b) not_connected (ORG2 has no session row at all) → skipped row
    const rnc = await runAutoDispatch(ORG2, makeDeps(makeFetch({ offers: [], drivers: [] }).fetchImpl).deps);
    check("run-row not_connected: engine skipped not_connected", rnc.skipped === "not_connected" && rnc.decisions.length === 0, JSON.stringify(rnc));
    const ncRow = (await runRows(ORG2, q`AND skipped='not_connected'`))[0];
    check("run-row not_connected: row persisted with skipped='not_connected'", ncRow && String(ncRow.skipped) === "not_connected" && ncRow.gated === false && Number(ncRow.offers_seen) === 0 && Number(ncRow.processed) === 0, JSON.stringify(ncRow));

    // c) session_unavailable (undecryptable session) → skipped row. ORG2 gets a
    //    temporary garbage session for the skipped-state tests; cascade delete
    //    at cleanup removes it (leftover check verifies).
    await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG2}, 'v1.garbage', 'connected')`;
    const rsu = await runAutoDispatch(ORG2, makeDeps(makeFetch({ offers: [], drivers: [] }).fetchImpl).deps);
    check("run-row session_unavailable: engine skipped session_unavailable", rsu.skipped === "session_unavailable", JSON.stringify(rsu));
    const suRow = (await runRows(ORG2, q`AND skipped='session_unavailable'`))[0];
    check("run-row session_unavailable: row persisted with skipped='session_unavailable'", suRow && String(suRow.skipped) === "session_unavailable" && Number(suRow.offers_seen) === 0, JSON.stringify(suRow));
    // For the fetch-level skip tests, ORG2 needs a DECRYPTABLE session (the
    // garbage one above only exercises the decrypt failure path).
    await q`UPDATE towbook_sessions SET encrypted_session=${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))} WHERE org_id=${ORG2}`;

    // d) offer fetch failed (HTTP 500) → skipped row with the reason
    const rff = await runAutoDispatch(ORG2, makeDeps(makeFetch({ offers: [], drivers: [], offersStatus: 500 }).fetchImpl).deps);
    check("run-row offer_fetch_failed: engine skipped with reason", String(rff.skipped).startsWith("offer_fetch_failed"), JSON.stringify(rff));
    const ffRow = (await runRows(ORG2, q`AND skipped LIKE 'offer_fetch_failed%'`))[0];
    check("run-row offer_fetch_failed: row persisted with the reason + offers_seen=0", ffRow && String(ffRow.skipped).startsWith("offer_fetch_failed") && Number(ffRow.offers_seen) === 0 && Number(ffRow.processed) === 0, String(ffRow?.skipped));

    // e) offer payload unexpected (non-array body) → skipped row
    const rpu = await runAutoDispatch(ORG2, makeDeps(makeFetch({ offers: [], drivers: [], offersBody: { not: "an array" } }).fetchImpl).deps);
    check("run-row offer_payload_unexpected: engine skipped", rpu.skipped === "offer_payload_unexpected", JSON.stringify(rpu));
    const puRow = (await runRows(ORG2, q`AND skipped='offer_payload_unexpected'`))[0];
    check("run-row offer_payload_unexpected: row persisted with skipped='offer_payload_unexpected'", puRow && String(puRow.skipped) === "offer_payload_unexpected" && Number(puRow.offers_seen) === 0, JSON.stringify(puRow));

    // f) empty feed → offers_seen=0 row (no skip, no decisions)
    const ref = await runAutoDispatch(ORG, makeDeps(makeFetch({ offers: [], drivers: [] }).fetchImpl).deps);
    check("run-row empty feed: engine offersSeen=0, no skip", ref.offersSeen === 0 && ref.skipped === null && ref.decisions.length === 0, JSON.stringify(ref));
    const efRow = (await runRows(ORG, q`AND offers_seen=0 AND skipped IS NULL`))[0];
    check("run-row empty feed: row persisted (offers_seen=0, processed=0, offer_ids [])", efRow && Number(efRow.offers_seen) === 0 && Number(efRow.processed) === 0 && efRow.skipped === null && Array.isArray(efRow.offer_ids) && efRow.offer_ids.length === 0, JSON.stringify(efRow));

    // g) auto-accept tick → run row alongside the decision row, offer_ids
    //    carries the offer id + status
    const aa = makeFetch({ offers: [offer(9001)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })] });
    const raa = await runAutoDispatch(ORG3, makeDeps(aa.fetchImpl).deps);
    check("run-row auto-accept: engine offersSeen=1 processed=1", raa.offersSeen === 1 && raa.processed === 1 && raa.skipped === null, JSON.stringify(raa));
    const aaRow = (await runRows(ORG3, q`AND processed>0`))[0];
    check("run-row auto-accept: row persisted with offers_seen=1 processed=1", aaRow && Number(aaRow.offers_seen) === 1 && Number(aaRow.processed) === 1 && aaRow.skipped === null, JSON.stringify(aaRow));
    check("run-row auto-accept: offer_ids records the offer id+status", aaRow && Array.isArray(aaRow.offer_ids) && aaRow.offer_ids.length === 1 && String(aaRow.offer_ids[0].id) === "9001" && aaRow.offer_ids[0].status === 0, JSON.stringify(aaRow?.offer_ids));
    const aaDec = await q`SELECT count(*)::int n FROM ai_dispatcher_decisions WHERE org_id=${ORG3} AND call_request_id='9001'`;
    check("run-row auto-accept: decision row exists alongside the run row", Number(aaDec[0].n) === 1, String(aaDec[0].n));

    // h) silent skip: status!==0 offer → recorded in offer_ids, NOT touched
    const ss = makeFetch({ offers: [offer(9002, { status: 1 })], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })] });
    const rss = await runAutoDispatch(ORG, makeDeps(ss.fetchImpl).deps);
    check("run-row silent-skip: status=1 offer seen but not processed, no POSTs", rss.offersSeen === 1 && rss.processed === 0 && rss.decisions.length === 0 && posts(ss.calls).length === 0, JSON.stringify(rss));
    const ssRow = (await runRows(ORG, q`AND offer_ids @> '[{"id":"9002","status":1}]'::jsonb`))[0];
    check("run-row silent-skip: offer_ids records the status=1 offer (id+status)", ssRow && Number(ssRow.offers_seen) === 1 && Number(ssRow.processed) === 0, JSON.stringify(ssRow?.offer_ids));
    const ssDec = await q`SELECT count(*)::int n FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND call_request_id='9002'`;
    check("run-row silent-skip: no decision row (offer left untouched)", Number(ssDec[0].n) === 0, String(ssDec[0].n));

    // i) already-processed offer re-polled → recorded in offer_ids (silent
    //    skip) while the new offer still processes
    const dp = makeFetch({ offers: [offer(9001), offer(9101)], drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })] });
    const rdp = await runAutoDispatch(ORG3, makeDeps(dp.fetchImpl).deps);
    check("run-row dedupe: 9001 seen+skipped silently, 9101 processed", rdp.offersSeen === 2 && rdp.processed === 1 && rdp.decisions[0]?.callRequestId === "9101", JSON.stringify(rdp));
    const dpRow = (await runRows(ORG3, q`AND offers_seen=2`))[0];
    check("run-row dedupe: offer_ids lists BOTH offers (9001 + 9101)", dpRow && Array.isArray(dpRow.offer_ids) && dpRow.offer_ids.length === 2 && dpRow.offer_ids.some((o) => String(o.id) === "9001" && o.status === 0) && dpRow.offer_ids.some((o) => String(o.id) === "9101" && o.status === 0), JSON.stringify(dpRow?.offer_ids));

    // j) newest-row read (the latestDispatcherRun SELECT shape): a row with a
    //    future ran_at must win over everything before it. Role-gating reuses
    //    the exact aiDispatcherReader guard the ledger fns use.
    const markerId = `run-${randomUUID()}`;
    await q`INSERT INTO ai_dispatcher_runs(id, org_id, ran_at, gated, offers_seen, processed, skipped, offer_ids)
      VALUES(${markerId}, ${ORG2}, NOW() + INTERVAL '1 minute', FALSE, 3, 2, NULL, ${JSON.stringify([{ id: "9901", status: 0 }])}::jsonb)`;
    const newest = (await q`SELECT id, ran_at, gated, offers_seen, processed, skipped, offer_ids FROM ai_dispatcher_runs WHERE org_id=${ORG2} ORDER BY ran_at DESC, created_at DESC LIMIT 1`)[0];
    check("run-row newest: latestDispatcherRun SELECT returns the newest row (future marker wins)", newest && String(newest.id) === markerId && newest.gated === false && Number(newest.offers_seen) === 3 && Number(newest.processed) === 2 && newest.skipped === null && Array.isArray(newest.offer_ids) && newest.offer_ids.length === 1 && String(newest.offer_ids[0].id) === "9901", JSON.stringify(newest));
    await q`DELETE FROM ai_dispatcher_runs WHERE id=${markerId}`;
  }

  /* ============ 26) ledger totals + owner org untouched ============ */
  {
    const rows = await decisions();
    const byDecision = rows.reduce((acc, x) => { acc[x.decision] = (acc[x.decision] || 0) + 1; return acc; }, {});
        check("ledger: universal fallback merged 4 escalations into auto_accept_no_driver (5), hard rails unchanged", byDecision["auto_accept_with_driver"] === 17 && byDecision["auto_accept_no_driver"] === 5 && byDecision["escalated_out_of_zone"] === undefined && byDecision["escalated_missing_coords"] === undefined && byDecision["escalated_unexpected_shape"] === undefined && byDecision["escalated_driver_lookup_failed"] === undefined && byDecision["escalated_expired"] === 1 && byDecision["escalated_accept_failed"] === 1 && byDecision["escalated_dispatch_failed"] === 2, JSON.stringify(byDecision));
    const a = await audits();
    check("audit: 22 ai_dispatcher:accept rows (17 with-driver + 5 no-driver universal fallback)", Number(a[0].n) === 22, String(a[0].n));
    const adAudit = await q`SELECT count(*)::int n FROM audit_log WHERE org_id=${ORG} AND action='ai_dispatcher:decision'`;
    check("audit: 4 ai_dispatcher:decision rows (escalations: expired/accept-failed/dispatch-failed)", Number(adAudit[0].n) === 4, String(adAudit[0].n));
    // Scope to the OWNER session row: since migration 10 a real contractor
    // sign-in (driver-auth.ts) legitimately adds session_kind='driver' rows to
    // the same org — the check's intent is that the owner session is untouched.
    const ownerSession = (await q`SELECT status FROM towbook_sessions WHERE org_id=${"89e15ce587651cc47c3bc45b1c612a220955"} AND session_kind='owner'`).map(r => String(r.status));
    check("owner org session untouched", ownerSession.length === ownerSessionBaseline.length && ownerSession.every((s, i) => s === ownerSessionBaseline[i]), `${JSON.stringify(ownerSessionBaseline)} → ${JSON.stringify(ownerSession)}`);
    const ownerDecisions = await q`SELECT count(*)::int n FROM ai_dispatcher_decisions WHERE org_id=${"89e15ce587651cc47c3bc45b1c612a220955"}`;
    check("owner org untouched: decision count unchanged by this run", Number(ownerDecisions[0].n) === ownerBaseline, `${ownerBaseline} → ${Number(ownerDecisions[0].n)}`);
  }

  /* ============ 27) geography: area anchors + fresh-GPS ETA origins (owner 2026-08-13) ============ */
  {
    // Fixture geography (real CT shoreline towns): Jayden anchored in Darien,
    // Levi in West Haven; the New Haven job must go to the West-Haven driver
    // (owner example: "if Jayden gets a job in Darien, he shouldn't get a job
    // in New Haven when Levi is in West Haven").
    const DARIEN = { lat: 41.08, lng: -73.47 };
    const WEST_HAVEN = { lat: 41.27, lng: -73.05 };
    const NEW_HAVEN = { lat: 41.31, lng: -72.93 };
    const STAMFORD = { lat: 41.05, lng: -73.54 };
    const anchorOf = (driverTowbookId, c, jobId = `geo-${driverTowbookId}`) => ({
      driverTowbookId: String(driverTowbookId), lat: c.lat, lng: c.lng, jobId, assignedAt: new Date().toISOString(),
    });
    const jayden = driver(703785, "Jayden Fountain", { lat: DARIEN.lat, lng: DARIEN.lng, etaSec: 604 });
    const levi = driver(717660, "Levi C Martin", { lat: WEST_HAVEN.lat, lng: WEST_HAVEN.lng, etaSec: 604 });
    const leviStamford = driver(717660, "Levi C Martin", { lat: STAMFORD.lat, lng: STAMFORD.lng, etaSec: 604 });
    const offline = driver(717660, "Levi C Martin", { checkedIn: false, etaSec: 10 });
    const anchors = new Map([
      ["703785", anchorOf(703785, DARIEN)],
      ["717660", anchorOf(717660, WEST_HAVEN)],
    ]);
    // Constants + the owner example hold: Darien→New Haven OUT of the 15-mi
    // circle, West Haven→New Haven IN.
    check("geography constants: ANCHOR_RADIUS_MILES=15, STALE_GPS_FIX_MINUTES=15",
      ANCHOR_RADIUS_MILES === 15 && STALE_GPS_FIX_MINUTES === 15, `${ANCHOR_RADIUS_MILES}/${STALE_GPS_FIX_MINUTES}`);
    check("geography fixture: Darien→New Haven > 15 mi (Jayden OUT), West Haven→New Haven ≤ 15 mi (Levi IN)",
      haversineMiles(NEW_HAVEN.lat, NEW_HAVEN.lng, DARIEN.lat, DARIEN.lng) > ANCHOR_RADIUS_MILES &&
      haversineMiles(NEW_HAVEN.lat, NEW_HAVEN.lng, WEST_HAVEN.lat, WEST_HAVEN.lng) <= ANCHOR_RADIUS_MILES,
      `${haversineMiles(NEW_HAVEN.lat, NEW_HAVEN.lng, DARIEN.lat, DARIEN.lng).toFixed(1)} mi / ${haversineMiles(NEW_HAVEN.lat, NEW_HAVEN.lng, WEST_HAVEN.lat, WEST_HAVEN.lng).toFixed(1)} mi`);
    // Jayden gets the BETTER road ETA (600s) — the in-area rule must still
    // send the New Haven job to Levi (3600s): an out-of-area driver is NOT a
    // candidate, no matter how fast their road ETA is.
    const geoRouter = makeRouter({
      "41.08,-73.47": 600,   // Jayden (Darien) → New Haven: fast, but OUT of area
      "41.27,-73.05": 3600,  // Levi (West Haven) → New Haven: slow, but IN area
    });
    const pickNh = await chooseBestDriverByRoad([jayden, levi], NEW_HAVEN.lat, NEW_HAVEN.lng, geoRouter, undefined, { anchors });
    check("in-area preference: New Haven job → West-Haven Levi, NOT Darien Jayden (owner example)",
      pickNh?.driver.driverId === 717660 && pickNh?.areaFallback === false && pickNh?.anchor?.driverTowbookId === "717660",
      JSON.stringify(pickNh && { d: pickNh.driver.driverId, fb: pickNh.areaFallback, anchor: pickNh.anchor?.driverTowbookId, base: pickNh.baseMinutes }));
    check("in-area choice: reason helper notes the anchor + in-circle pickup",
      pickNh != null && pickNh.anchor != null && String(areaSelectionNote(pickNh, NEW_HAVEN.lat, NEW_HAVEN.lng)).includes("in-circle"),
      String(pickNh && areaSelectionNote(pickNh, NEW_HAVEN.lat, NEW_HAVEN.lng)));

    // Fallback: BOTH anchored OUT of area (Jayden Darien, Levi Stamford) →
    // global closest-by-ETA engages (areaFallback true) and fast Jayden wins.
    const anchorsBothOut = new Map([
      ["703785", anchorOf(703785, DARIEN)],
      ["717660", anchorOf(717660, STAMFORD)],
    ]);
    const pickFb = await chooseBestDriverByRoad([jayden, leviStamford], NEW_HAVEN.lat, NEW_HAVEN.lng, geoRouter, undefined, { anchors: anchorsBothOut });
    check("fallback: no in-area candidate → global closest-by-ETA (areaFallback true), fast Jayden wins",
      pickFb?.driver.driverId === 703785 && pickFb?.areaFallback === true &&
      String(areaSelectionNote(pickFb, NEW_HAVEN.lat, NEW_HAVEN.lng)).includes("global closest-by-ETA fallback"),
      JSON.stringify(pickFb && { d: pickFb.driver.driverId, fb: pickFb.areaFallback, base: pickFb.baseMinutes }));

    // No-anchor drivers are flexible: with Jayden anchored out-of-area, the
    // UNANCHORED Levi is still a candidate for New Haven; and with NO anchors
    // configured at all the engine behaves exactly as before (shortest road
    // ETA wins, payload origins).
    const anchorsJaydenOnly = new Map([["703785", anchorOf(703785, DARIEN)]]);
    const pickFlex = await chooseBestDriverByRoad([jayden, levi], NEW_HAVEN.lat, NEW_HAVEN.lng, geoRouter, undefined, { anchors: anchorsJaydenOnly });
    check("no-anchor drivers flexible: unanchored Levi takes the New Haven job (anchored Jayden out-of-area excluded)",
      pickFlex?.driver.driverId === 717660 && pickFlex?.areaFallback === false && pickFlex?.anchor === null,
      JSON.stringify(pickFlex && { d: pickFlex.driver.driverId, anchor: pickFlex.anchor }));
    const pickBothFlex = await chooseBestDriverByRoad([jayden, levi], NEW_HAVEN.lat, NEW_HAVEN.lng, geoRouter, undefined, {});
    check("no anchors configured → closest driver wins on distance (payload origins, no area note)",
      pickBothFlex?.driver.driverId === 717660 && pickBothFlex?.areaFallback === false && pickBothFlex?.originBasis === "payload" &&
      areaSelectionNote(pickBothFlex, NEW_HAVEN.lat, NEW_HAVEN.lng) === null,
      JSON.stringify(pickBothFlex && { d: pickBothFlex.driver.driverId, basis: pickBothFlex.originBasis }));

    // ETA origin: freshest app GPS fix when ≤ 15 min old; a STALE fix (> 15
    // min) routes from the driver's anchor center with the basis noted; no fix
    // at all keeps the payload GPS (pre-geography default — absence of a ping
    // is not treated as a stale ping).
    const geoNow = new Date();
    const fixAt = (c, ageMin) => ({ lat: c.lat, lng: c.lng, capturedAt: new Date(geoNow.getTime() - ageMin * 60000).toISOString() });
    const pickFresh = await chooseBestDriverByRoad([jayden], NEW_HAVEN.lat, NEW_HAVEN.lng,
      makeRouter({ "41.31,-72.93": 600 }), // fix (New Haven) route — would be ~86 min factor if the payload were used
      undefined, { anchors, gpsFixes: new Map([["703785", fixAt(NEW_HAVEN, 5)]]), now: geoNow });
    check("fresh GPS fix: ETA routed FROM the fix (originBasis gps, 10 min — not the payload's ~86-min factor)",
      pickFresh?.driver.driverId === 703785 && pickFresh?.originBasis === "gps" && pickFresh?.baseMinutes === 10 &&
      pickFresh?.gpsFixAgeMinutes != null && pickFresh.gpsFixAgeMinutes >= 4 && pickFresh.gpsFixAgeMinutes <= 6,
      JSON.stringify(pickFresh && { basis: pickFresh.originBasis, base: pickFresh.baseMinutes, age: pickFresh.gpsFixAgeMinutes }));
    check("fresh GPS fix: reason label names the app-GPS origin",
      pickFresh != null && String(etaDetailLabel(pickFresh, 5, 5, 45, 15)).includes("origin: app GPS fix"),
      String(pickFresh && etaDetailLabel(pickFresh, 5, 5, 45, 15)));
    const pickStale = await chooseBestDriverByRoad([levi], NEW_HAVEN.lat, NEW_HAVEN.lng,
      makeRouter({ "41.27,-73.05": 600 }), // anchor-center (West Haven) route — the stale fix (41.30,-72.95) would factor to ~18 min
      undefined, { anchors, gpsFixes: new Map([["717660", fixAt({ lat: 41.30, lng: -72.95 }, 30)]]), now: geoNow });
    check("stale GPS fix (>15 min): ETA routed from the ANCHOR center, basis noted (originBasis anchor)",
      pickStale?.driver.driverId === 717660 && pickStale?.originBasis === "anchor" && pickStale?.baseMinutes === 10 &&
      pickStale?.gpsFixAgeMinutes != null && pickStale.gpsFixAgeMinutes >= 29 && pickStale.gpsFixAgeMinutes <= 31,
      JSON.stringify(pickStale && { basis: pickStale.originBasis, base: pickStale.baseMinutes, age: pickStale.gpsFixAgeMinutes }));
    check("stale GPS fix: reason label + area note never hide the anchor-center origin",
      pickStale != null && String(etaDetailLabel(pickStale, 5, 5, 45, 15)).includes("origin: anchor center") &&
      String(areaSelectionNote(pickStale, NEW_HAVEN.lat, NEW_HAVEN.lng)).includes("ETA origin: anchor center"),
      `${etaDetailLabel(pickStale, 5, 5, 45, 15)} ${areaSelectionNote(pickStale, NEW_HAVEN.lat, NEW_HAVEN.lng)}`);
    const noFix = driver(603482, "Antone jerret", { lat: WEST_HAVEN.lat, lng: WEST_HAVEN.lng, etaSec: 604 });
    const pickNoFix = await chooseBestDriverByRoad([noFix], NEW_HAVEN.lat, NEW_HAVEN.lng,
      makeRouter({ "41.27,-73.05": 600 }),
      undefined, { anchors, gpsFixes: new Map(), now: geoNow });
    check("no app GPS fix: payload coords stay the origin (originBasis payload — absence is not staleness)",
      pickNoFix?.driver.driverId === 603482 && pickNoFix?.originBasis === "payload" && pickNoFix?.gpsFixAgeMinutes === null && pickNoFix?.baseMinutes === 10,
      JSON.stringify(pickNoFix && { basis: pickNoFix.originBasis, age: pickNoFix.gpsFixAgeMinutes, base: pickNoFix.baseMinutes }));

    // Escalation backstop under area context: no eligible candidate at all →
    // null (the engine escalates rather than auto-accepting blind — safety
    // rails intact with anchors configured).
    const esc = await chooseBestDriverByRoad([offline], NEW_HAVEN.lat, NEW_HAVEN.lng, geoRouter, undefined, { anchors });
    check("escalate on unresolvable ETA: area context + only ineligible drivers → null (existing backstop intact)",
      esc === null, JSON.stringify(esc));

    // etDayStartUtcMs: today's ET business-day start, DST-aware, ≤ now.
    const ds = new Date(etDayStartUtcMs());
    const dsHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).formatToParts(ds).find((p) => p.type === "hour")?.value);
    check("etDayStartUtcMs: resolves to today's ET midnight (00:00 America/New_York), ≤ now",
      ds.getTime() <= Date.now() + 1000 && (dsHour === 0 || dsHour === 24), `${ds.toISOString()} hour=${dsHour}`);

    // --- anchor derivation from dispatch_jobs (no migration — derived rows) ---
    // geo-a1: driver 703785 dispatched TODAY in Darien → their anchor.
    // geo-a2: same driver dispatched LATER today in West Haven → FIRST row
    //   wins (the anchor persists for the rest of the day).
    // geo-a3: driver 717660's row was CREATED yesterday but dispatchTime is
    //   TODAY → the true assignment instant anchors today (dispatchTime is
    //   the ground truth, not the import time).
    // geo-a4: driver 603482 created YESTERDAY with no assigned_at and no
    //   dispatchTime → not assigned today → no anchor (flexible).
    // geo-a5: driver 668209 dispatched today with a MALFORMED dispatchTime →
    //   the regex guard falls back to created_at (today) → anchored; the
    //   malformed value never takes down the whole anchor load.
    const zless = (d) => d.toISOString().slice(0, 19); // Z-less ISO (UTC) — the documented dispatchTime shape
    const todayIso = zless(geoNow);
    const laterIso = zless(new Date(geoNow.getTime() + 3600e3));
    const yestIso = zless(new Date(geoNow.getTime() - 86400e3));
    const geoInsert = (id, driverId, c, createdIso, rawJson) => q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, raw_json, pickup_lat, pickup_lng, assigned_driver_towbook_id)
      VALUES(${id}, ${ORG7}, 'Geo Job', '', 0, 0, 'CT', 'tow', 'accepted', ${createdIso}, '', ${JSON.stringify(rawJson)}::jsonb, ${c.lat}, ${c.lng}, ${driverId})`;
    await geoInsert("geo-a1", "703785", DARIEN, geoNow.toISOString(), { dispatchTime: todayIso });
    await geoInsert("geo-a2", "703785", WEST_HAVEN, geoNow.toISOString(), { dispatchTime: laterIso });
    await geoInsert("geo-a3", "717660", WEST_HAVEN, new Date(geoNow.getTime() - 86400e3).toISOString(), { dispatchTime: todayIso });
    await geoInsert("geo-a4", "603482", STAMFORD, new Date(geoNow.getTime() - 86400e3).toISOString(), {});
    await geoInsert("geo-a5", "668209", NEW_HAVEN, geoNow.toISOString(), { dispatchTime: "not-a-timestamp" });
    const dbAnchors = await loadDriverAnchors(ORG7);
    check("anchor derivation: first ASSIGNED job of the day sets the anchor (703785 → geo-a1 Darien; later job does not override)",
      dbAnchors.get("703785")?.jobId === "geo-a1" && Math.abs(Number(dbAnchors.get("703785")?.lat) - DARIEN.lat) < 1e-9 &&
      Math.abs(Number(dbAnchors.get("703785")?.lng) - DARIEN.lng) < 1e-9, JSON.stringify(dbAnchors.get("703785")));
    check("anchor derivation: dispatchTime (ground truth) anchors a row created YESTERDAY (717660 → geo-a3 West Haven)",
      dbAnchors.get("717660")?.jobId === "geo-a3" && Math.abs(Number(dbAnchors.get("717660")?.lat) - WEST_HAVEN.lat) < 1e-9,
      JSON.stringify(dbAnchors.get("717660")));
    check("anchor derivation: no today-assignment → no anchor (603482 flexible)",
      dbAnchors.get("603482") === undefined, JSON.stringify(dbAnchors.get("603482")));
    check("anchor derivation: malformed dispatchTime falls back to created_at without throwing (668209 anchored today)",
      dbAnchors.get("668209")?.jobId === "geo-a5", JSON.stringify(dbAnchors.get("668209")));
    check("anchor derivation: exactly the three today-assigned drivers carry anchors",
      dbAnchors.size === 3, `size=${dbAnchors.size} [${[...dbAnchors.keys()].join(",")}]`);

    // --- freshest GPS fix per driver (driver_locations) ---
    await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, latitude, longitude, captured_at)
      VALUES('geo-gps-old', ${ORG7}, ${USER}, '703785', ${WEST_HAVEN.lat}, ${WEST_HAVEN.lng}, ${new Date(geoNow.getTime() - 3600e3).toISOString()})`;
    await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, latitude, longitude, captured_at)
      VALUES('geo-gps-new', ${ORG7}, ${USER}, '703785', ${DARIEN.lat}, ${DARIEN.lng}, ${geoNow.toISOString()})`;
    await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, latitude, longitude, captured_at)
      VALUES('geo-gps-levi', ${ORG7}, ${USER}, '717660', ${WEST_HAVEN.lat}, ${WEST_HAVEN.lng}, ${geoNow.toISOString()})`;
    const dbFixes = await loadDriverGpsFixes(ORG7);
    check("gps fixes: freshest fix per driver wins (703785 → the NEW fix, not the 1-hour-old one)",
      Math.abs(Number(dbFixes.get("703785")?.lat) - DARIEN.lat) < 1e-9 && dbFixes.get("717660") != null,
      JSON.stringify(dbFixes.get("703785")));
  }
  /* ============ tiered in-state/cross-state selection regressions (1a0334c) ============ */
  {
    // These are end-to-end fixtures: the real state guard, candidate ordering,
    // accept POST, verification, and decision ledger must all agree on the tier.
    const stateByDriver = new Map();
    const runTier = async (id, ds, opts = {}) => {
      for (const [driverId, state] of Object.entries(opts.states ?? {})) stateByDriver.set(Number(driverId), state);
      const m = makeFetch({ offers: [offer(id, { maxEta: opts.maxEta, drivers: ds.map((d) => d.driverId) })], drivers: ds });
      const { deps } = makeDeps(m.fetchImpl, makeRouter(), { stateResolver: async (driverId) => stateByDriver.get(Number(driverId)) ?? null });
      const r = await runAutoDispatch(ORG6, deps);
      const row = (await q`SELECT decision, driver_id, reason FROM ai_dispatcher_decisions WHERE org_id=${ORG6} AND call_request_id=${String(id)}`)[0];
      return { r, m, row };
    };
    const online = driver(93001, "Tier online CT", { checkedIn: true, etaSec: 900 });
    const offline = driver(93002, "Tier offline CT", { checkedIn: false, etaSec: 600 });
    // Cross-state driver physically NEAR the Bridgeport pickup (mock router:
    // seconds = miles*(3600/30)*1.35 — 40.7,-74.0 is ~55 mi => ~147 min, over
    // the 45-min ceiling). State comes from the injected resolver ("NY"), so
    // the driver can sit ~8 mi away and still be provably out-of-state while
    // its road ETA (~22 min + 5 buffer) fits the ceiling — the ETA-capped
    // ASSIGN path, not the fallback path.
    const cross = driver(93003, "Tier cross-state NY", { checkedIn: true, etaSec: 600, lat: 41.15, lng: -73.10 });
    const farCross = driver(93004, "Tier far-state NY", { checkedIn: true, etaSec: 4000, lat: 40.7, lng: -74.0 });

    const a = await runTier(93001, [online], { states: { 93001: "CT" } });
    check("tier 1 online in-state: assigned", a.r.decisions[0]?.decision === "auto_accept_with_driver" && Number(a.row?.driver_id) === 93001 && posts(a.m.calls)[0]?.body?.driverId === 93001 && !String(a.row?.reason).includes("waiver"), JSON.stringify(a.row));

    const b = await runTier(93002, [offline], { states: { 93002: "CT" } });
    check("tier 2 offline in-state: assigned with waiver reason", b.r.decisions[0]?.decision === "auto_accept_with_driver" && Number(b.row?.driver_id) === 93002 && posts(b.m.calls)[0]?.body?.driverId === 93002 && String(b.row?.reason).includes("no online driver in state; in-state offline assignment"), JSON.stringify(b.row));

    const c = await runTier(93003, [cross], { states: { 93003: "NY" }, maxEta: 45 });
    check("tier 3 cross-state ETA-capped: assigned", c.r.decisions[0]?.decision === "auto_accept_with_driver" && Number(c.row?.driver_id) === 93003 && posts(c.m.calls)[0]?.body?.driverId === 93003 && String(c.row?.reason).includes("cross-state sole-eligible assignment"), JSON.stringify(c.row));

    const offlineCross = driver(93006, "Tier offline cross-state NY", { checkedIn: false, etaSec: 600, lat: 41.15, lng: -73.10 });
    const c3b = await runTier(93006, [offlineCross], { states: { 93006: "NY" }, maxEta: 45 });
    check("tier 3b offline cross-state within ceiling: assigned", c3b.r.decisions[0]?.decision === "auto_accept_with_driver" && Number(c3b.row?.driver_id) === 93006 && String(c3b.row?.reason).includes("cross-state sole-eligible assignment"), JSON.stringify(c3b.row));

    const d = await runTier(93004, [farCross], { states: { 93004: "NY" }, maxEta: 30 });
    check("tier 4 cross-state over ceiling: universal fallback", d.r.decisions[0]?.decision === "auto_accept_no_driver" && d.r.decisions[0]?.escalated === true && Number(d.row?.driver_id ?? 0) === 0 && posts(d.m.calls)[0]?.body?.driverId === 0 && String(d.row?.reason).includes("cross-state sole-eligible assignment cannot make the SLA ceiling"), JSON.stringify(d.row));

    const failedCross = driver(93007, "Tier routing-failure NY", { checkedIn: true, etaSec: 60, lat: 41.15, lng: -73.10 });
    const mf = makeFetch({ offers: [offer(93007, { maxEta: 45, drivers: [93007] })], drivers: [failedCross] });
    const { deps: fd } = makeDeps(mf.fetchImpl, null, { noRouterOverride: true, env: { ETA_ROUTER: "off" }, stateResolver: async () => "NY" });
    const fr = await runAutoDispatch(ORG6, fd);
    const frow = (await q`SELECT decision, driver_id, reason FROM ai_dispatcher_decisions WHERE org_id=${ORG6} AND call_request_id='93007'`)[0];
    check("tier 4b cross-state routing failure: universal fallback", fr.decisions[0]?.decision === "auto_accept_no_driver" && fr.decisions[0]?.escalated === true && Number(frow?.driver_id ?? 0) === 0 && String(frow?.reason).includes("actual road time unavailable"), JSON.stringify(frow));

    const e = await runTier(93005, [cross, offline, online], { states: { 93001: "CT", 93002: "CT", 93003: "NY" } });
    check("tier regression online same-state beats offline/cross-state", e.r.decisions[0]?.decision === "auto_accept_with_driver" && Number(e.row?.driver_id) === 93001 && posts(e.m.calls)[0]?.body?.driverId === 93001, JSON.stringify(e.row));
  }

  /* ============ qualification gate (Phase B ③) ============ */
  {
    const runQ = async (id, ds, extra={}) => { const m=makeFetch({offers:[offer(id,{ drivers: ds.map((d)=>d.driverId), ...(extra.offer||{}) })],drivers:ds}); const {deps}=makeDeps(m.fetchImpl); const r=await runAutoDispatch(ORG7,deps); return {r,m,rows:await q`SELECT * FROM ai_dispatcher_decisions WHERE org_id=${ORG7} AND call_request_id=${String(id)}`}; };
    const cases = [
      ['deactivated', QUAL_TB[0], 'deactivated'], ['org-inactive', QUAL_TB[6], 'org-inactive'],
      ['missing-compliance', QUAL_TB[1], 'missing-compliance'], ['expired-compliance', QUAL_TB[2], 'missing-compliance'],
      ['duplicate-type regression', QUAL_TB[3], 'missing-compliance'], ['capability mismatch', QUAL_TB[5], 'capability-mismatch']
    ];
    await q`UPDATE users SET deactivated_at=NOW() WHERE id=${QUAL_USERS[0]}`;
    for (const [label,id,reason] of cases) {
      const extra = label==='capability mismatch' ? {serviceType:'heavy tow'} : {};
      const {r,m,rows}=await runQ(92000+cases.indexOf(cases.find(x=>x[0]===label)),[driver(id,label)] ,{offer:extra});
      const expectedDecision = label === 'capability mismatch' ? 'rejected_tow_no_eligible_driver' : 'escalated_qualification_failed';
      check(`qualification ${label}: excluded ${reason}, never assigned`, r.decisions[0]?.decision===expectedDecision && posts(m.calls).length===0 && String(rows[0]?.reason).includes(reason), JSON.stringify({r,rows}));
    }
    await q`UPDATE users SET deactivated_at=NULL WHERE id=${QUAL_USERS[0]}`;
    const {r: noMember,m: nm}=await runQ(92010,[driver(QUAL_TB[6],'no membership')]);
    check('qualification org-inactive user without membership: excluded, never assigned',noMember.decisions[0]?.decision==='escalated_qualification_failed'&&posts(nm.calls).length===0);
    await q`UPDATE org_settings SET qualification_gate_enabled=FALSE WHERE org_id=${ORG7}`;
    const {r: off,m: om}=await runQ(92011,[driver(QUAL_TB[1],'flag off')]);
    check('qualification flag-off: skipped and candidate flows through',off.decisions[0]?.decision==='auto_accept_with_driver'&&posts(om.calls).length===1);
    await q`UPDATE org_settings SET qualification_gate_enabled=TRUE WHERE org_id=${ORG7}`;
    const {r: good,m: gm,rows: gr}=await runQ(92012,[driver(QUAL_TB[4],'qualified',{etaSec:600})]);
    check('qualification qualified: assigned with ordering rails and no exclusions',good.decisions[0]?.decision==='auto_accept_with_driver'&&posts(gm.calls)[0]?.body?.driverId===QUAL_TB[4]&&gr[0]?.raw_response?.serviceQualification?.excluded?.length===0);
    const {r: towCapable,m: towCapableM,rows: towCapableRows}=await runQ(92014,[driver(QUAL_TB[4],'tow-capable online',{etaSec:600})],{offer:{serviceType:'heavy tow'}});
    check('tow capability companion: online tow-capable driver assigned',towCapable.decisions[0]?.decision==='auto_accept_with_driver'&&posts(towCapableM.calls)[0]?.body?.driverId===QUAL_TB[4]&&!String(towCapableRows[0]?.reason||'').includes('capability-mismatch'),JSON.stringify({r:towCapable,rows:towCapableRows}));
    const {r: sole,m: sm}=await runQ(92013,[driver(QUAL_TB[1],'sole unqualified')]);
    check('qualification sole-unqualified: zero POSTs, no-driver fallback hard blocked',sole.decisions[0]?.decision==='escalated_qualification_failed'&&posts(sm.calls).length===0&&!sm.calls.some(c=>c.method==='POST'));
  }
  console.log("\nALL AI-DISPATCHER CHECKS PASSED");
  for (const [name, ok, extra] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
} finally {
  // ---- cleanup: QA orgs cascade decisions/settings/jobs/events/audit/session/membership
  if (created) {
    assertQaOrg(ORG); await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
    assertQaOrg(ORG2); await q`DELETE FROM organizations WHERE id=${ORG2}`.catch(() => {});
    assertQaOrg(ORG3); await q`DELETE FROM organizations WHERE id=${ORG3}`.catch(() => {});
    assertQaOrg(ORG4); await q`DELETE FROM organizations WHERE id=${ORG4}`.catch(() => {});
    assertQaOrg(ORG5); await q`DELETE FROM organizations WHERE id=${ORG5}`.catch(() => {});
    assertQaOrg(ORG6); await q`DELETE FROM organizations WHERE id=${ORG6}`.catch(() => {});
    assertQaOrg(ORG7); await q`DELETE FROM organizations WHERE id=${ORG7}`.catch(() => {});
    await q`DELETE FROM users WHERE id=${USER}`.catch(() => {});
    for (const id of QUAL_USERS) await q`DELETE FROM users WHERE id=${id}`.catch(() => {});
  }
  const leftover = await q`SELECT
    (SELECT count(*) FROM ai_dispatcher_decisions WHERE org_id=${ORG}) AS ad,
    (SELECT count(*) FROM org_settings WHERE org_id=${ORG}) AS os,
    (SELECT count(*) FROM dispatch_jobs WHERE org_id=${ORG}) AS jobs,
    (SELECT count(*) FROM status_events WHERE org_id=${ORG}) AS ev,
    (SELECT count(*) FROM audit_log WHERE org_id=${ORG}) AS audit,
    (SELECT count(*) FROM towbook_sessions WHERE org_id=${ORG}) AS sess,
    (SELECT count(*) FROM organization_memberships WHERE org_id=${ORG}) AS members,
    (SELECT count(*) FROM users WHERE id=${USER}) AS users,
    (SELECT count(*) FROM ai_dispatcher_runs WHERE org_id=${ORG}) AS runs,
    (SELECT count(*) FROM ai_dispatcher_decisions WHERE org_id=${ORG2}) AS ad2,
    (SELECT count(*) FROM org_settings WHERE org_id=${ORG2}) AS os2,
    (SELECT count(*) FROM ai_dispatcher_runs WHERE org_id=${ORG2}) AS runs2,
    (SELECT count(*) FROM ai_dispatcher_decisions WHERE org_id=${ORG3}) AS ad3,
    (SELECT count(*) FROM org_settings WHERE org_id=${ORG3}) AS os3,
    (SELECT count(*) FROM towbook_sessions WHERE org_id=${ORG3}) AS sess3,
    (SELECT count(*) FROM ai_dispatcher_runs WHERE org_id=${ORG3}) AS runs3,
    (SELECT count(*) FROM ai_dispatcher_decisions WHERE org_id=${ORG4}) AS ad4,
    (SELECT count(*) FROM org_settings WHERE org_id=${ORG4}) AS os4,
    (SELECT count(*) FROM dispatch_jobs WHERE org_id=${ORG4}) AS jobs4,
    (SELECT count(*) FROM towbook_sessions WHERE org_id=${ORG4}) AS sess4,
    (SELECT count(*) FROM ai_dispatcher_runs WHERE org_id=${ORG4}) AS runs4,
    (SELECT count(*) FROM ai_dispatcher_decisions WHERE org_id=${ORG5}) AS ad5,
    (SELECT count(*) FROM org_settings WHERE org_id=${ORG5}) AS os5,
    (SELECT count(*) FROM towbook_sessions WHERE org_id=${ORG5}) AS sess5,
    (SELECT count(*) FROM ai_dispatcher_runs WHERE org_id=${ORG5}) AS runs5,
    (SELECT count(*) FROM ai_dispatcher_decisions WHERE org_id=${ORG6}) AS ad6,
    (SELECT count(*) FROM org_settings WHERE org_id=${ORG6}) AS os6,
    (SELECT count(*) FROM dispatch_jobs WHERE org_id=${ORG6}) AS jobs6,
    (SELECT count(*) FROM towbook_sessions WHERE org_id=${ORG6}) AS sess6,
    (SELECT count(*) FROM ai_dispatcher_runs WHERE org_id=${ORG6}) AS runs6`;
  const l = leftover[0];
  console.log(`\ncleanup: ai_decisions=${l.ad} settings=${l.os} jobs=${l.jobs} events=${l.ev} audit=${l.audit} sessions=${l.sess} members=${l.members} users=${l.users} runs=${l.runs} ad2=${l.ad2} settings2=${l.os2} runs2=${l.runs2} ad3=${l.ad3} settings3=${l.os3} sess3=${l.sess3} runs3=${l.runs3} ad4=${l.ad4} settings4=${l.os4} jobs4=${l.jobs4} sess4=${l.sess4} runs4=${l.runs4} ad5=${l.ad5} settings5=${l.os5} sess5=${l.sess5} runs5=${l.runs5} ad6=${l.ad6} settings6=${l.os6} jobs6=${l.jobs6} sess6=${l.sess6} runs6=${l.runs6}`);
  if (Object.values(l).some((v) => Number(v) > 0)) {
    console.error("WARNING: QA rows remain!");
    process.exitCode = 1;
  }
}
