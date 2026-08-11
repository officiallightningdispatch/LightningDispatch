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
} = await import("./src/data/ai-dispatcher.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-ad-${randomUUID()}`;
const ORG2 = `qa-ad2-${randomUUID()}`;
const ORG3 = `qa-ad3-${randomUUID()}`; // ETA v3 traffic-layer engine tests
const ORG4 = `qa-ad4-${randomUUID()}`; // queue-aware capacity + all-loaded engine tests
const USER = `qa-ad-user-${randomUUID()}`;
let created = false;

/* ------------------------------ fixtures ------------------------------ */

const ZONE = { lat: 41.208862, lng: -73.207253, radiusMi: 30 };
const northOf = (dMiles) => ZONE.lat + dMiles / 69.09; // ~1° lat = 69.09 mi

const offer = (id, { lat = 41.2, lng = -73.2, status = 0, expiresInMin = 10, maxEta = null, omitLat = false, past = false } = {}) => {
  const o = {
    callRequestId: id,
    masterAccountId: 29,
    accountId: 894873,
    accountName: "Agero (Swoop) Bridgeport",
    companyId: 23257,
    status,
    expirationDateUtc: past ? "2026-08-01T00:00:00" : new Date(Date.now() + expiresInMin * 60000).toISOString(),
    defaultEta: 30,
    purchaseOrderNumber: `1125${id}`,
    sound: false,
    startLocationLatitude: lat,
    startLocationLongitude: lng,
    drivers: [603482, 703785],
    availableActions: ["NearestDrivers", "REQUEST_CALL", "ACKNOWLEDGE"],
  };
  if (maxEta) o.maxEta = maxEta;
  if (omitLat) delete o.startLocationLatitude;
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
 *  GET /api/calls?status=N and POST /api/calls/{id}/assignDrivers. Throws on
 *  any URL outside the documented surface — a stray call fails the test.
 *  The created call mirrors the accept body's driverId in assets[].driver.id
 *  (so verification passes by default) unless `callDriverId` overrides it
 *  (simulating the 2026-08-10 incident: accepted driver ≠ driver on the call). */
function makeFetch({ offers, drivers, offersStatus = 200, offersBody = null, acceptStatus = 200, acceptBody = null, acceptFails = 0, nearestDriversStatus = 200, callDriverId = null, assignSucceeds = true, acceptResponseId = null, callsFailures = 0 }) {
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
      if (acceptStatus !== 200) return jsonResponse(acceptStatus, { error: "boom" });
      const bodyId = acceptResponseId ?? (acceptBody && acceptBody.id != null ? acceptBody.id : 279999999);
      const offerFor = offers.find((o) => String(o.callRequestId) === u.split("/api/callRequests/")[1].split("/")[0]);
      call = {
        id: bodyId,
        callNumber: 25000,
        status: { id: 2 },
        version: 1,
        purchaseOrderNumber: offerFor ? offerFor.purchaseOrderNumber : null,
        assets: parsedBody && Number(parsedBody.driverId) > 0
          ? [{ driver: { id: callDriverId ?? Number(parsedBody.driverId), name: callDriverId != null ? "Someone Else" : "Assigned" } }]
          : [],
      };
      return jsonResponse(200, acceptBody ?? { id: bodyId, callNumber: 25000, status: { id: 2 }, version: 1 });
    }
    if (u.includes("/api/calls/") && u.endsWith("/assignDrivers") && method === "POST") {
      if (!assignSucceeds) return jsonResponse(500, { error: "assign boom" });
      if (call && parsedBody && Number(parsedBody.driverId) > 0) {
        call.assets = [{ driver: { id: Number(parsedBody.driverId), name: "Assigned" } }];
      }
      return jsonResponse(200, { ok: true });
    }
    if (u.includes("/api/calls/")) {
      if (callsFailuresLeft > 0) { callsFailuresLeft--; return jsonResponse(500, { error: "call list boom" }); }
      const m = u.match(/\/api\/calls\/(\d+)$/);
      if (m) return call && String(call.id) === m[1] ? jsonResponse(200, call) : jsonResponse(404, { error: "not found" });
      const sm = u.match(/status=(\d+)/);
      if (sm) {
        const status = Number(sm[1]);
        return jsonResponse(200, call && call.status.id === status ? [call] : []);
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
const audits = () => q`SELECT count(*)::int n FROM audit_log WHERE org_id=${ORG} AND action='ai_dispatcher:accept'`;
const posts = (calls) => calls.filter((c) => c.method === "POST");

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
  created = true;
  // Owner-org baseline: the REAL incident row (offer 326520203, auto-accepted
  // 2026-08-10 with a 3-min straight-line ETA) lives in the owner org — the
  // "zero decisions" assumption predates it. Capture the count so the final
  // check proves THIS run adds nothing to the owner org.
  const ownerBaseline = Number((await q`SELECT count(*)::int n FROM ai_dispatcher_decisions WHERE org_id=${"89e15ce587651cc47c3bc45b1c612a220955"}`)[0].n);

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
  check("chooseBestDriverByRoad picks min ROAD ETA (Antone 600s road beats Jayden 3600s road)", pick2?.driver.driverId === 603482 && pick2.baseMinutes === 10 && pick2.usedFallback === false && pick2.roadSeconds === 600, JSON.stringify(pick2));
  check("chooseBestDriverByRoad excludes busy/no-GPS/offline", (await chooseBestDriverByRoad([freeFast, busy], 41.2, -73.2, R))?.driver.driverId === 703785 && (await chooseBestDriverByRoad([busy, noGps, offline], 41.2, -73.2, R))?.driver.driverId === 668209);
  check("chooseBestDriverByRoad([]) = null", (await chooseBestDriverByRoad([], 41.2, -73.2, R)) === null);
  const fb = await chooseBestDriverByRoad([driver(703785, "Jayden Fountain", { lat: 41.19, lng: -73.15, etaSec: 604 })], 41.2, -73.2, R);
  check("chooseBestDriverByRoad: router null → fallback factor model flagged", fb?.driver.driverId === 703785 && fb.usedFallback === true && fb.roadSeconds === null && fb.baseMinutes === fallbackRoadMinutes(haversineMiles(41.19, -73.15, 41.2, -73.2)), JSON.stringify(fb));
  check("finalEtaMinutes: ceil(9)+5 = 14", finalEtaMinutes(9, 5, 5, 45) === 14);
  check("finalEtaMinutes: ceiling clamps 60+5 → 45", finalEtaMinutes(60, 5, 5, 45) === 45);
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

  /* ============ 11) out-of-zone escalation (30.5 mi) — never accept ============ */
  {
    const m = makeFetch({
      offers: [offer(7005, { lat: northOf(30.5), lng: ZONE.lng })],
      drivers: [driver(703785, "Jayden Fountain", { etaSec: 604 })],
    });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("out-of-zone: escalated_out_of_zone, zero POSTs", r.decisions[0]?.decision === "escalated_out_of_zone" && r.decisions[0]?.escalated === true && posts(m.calls).length === 0, JSON.stringify(r.decisions));
    const rows = await decisions();
    const oz = rows.find((x) => String(x.call_request_id) === "7005");
    check("out-of-zone: zone_distance_miles recorded > 30", oz && Number(oz.zone_distance_miles) > 30, String(oz?.zone_distance_miles));
  }

  /* ============ 12) missing coords escalation ============ */
  {
    const m = makeFetch({ offers: [offer(7006, { lat: 0, lng: 0 })], drivers: [] });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("missing coords: escalated_missing_coords, zero POSTs", r.decisions[0]?.decision === "escalated_missing_coords" && posts(m.calls).length === 0, JSON.stringify(r.decisions));
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
    check("shape: escalated_unexpected_shape, zero POSTs", r.decisions[0]?.decision === "escalated_unexpected_shape" && r.decisions[0]?.escalated === true && posts(m.calls).length === 0, JSON.stringify(r.decisions));
    const rows = await decisions();
    const sr = rows.find((x) => String(x.call_request_id).startsWith("shape-"));
    check("shape: decision keyed by content hash, raw_response carries the full offer JSON", sr && String(sr.call_request_id).startsWith("shape-") && sr.raw_response?.offer?.accountName === bad.accountName && sr.raw_response?.offer?.startLocationLatitude === undefined, JSON.stringify(sr));
  }

  /* ============ 15) driver lookup failure escalation ============ */
  {
    const m = makeFetch({ offers: [offer(7009)], drivers: [], nearestDriversStatus: 500 });
    const { deps } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("driver lookup 500: escalated_driver_lookup_failed, zero POSTs", r.decisions[0]?.decision === "escalated_driver_lookup_failed" && posts(m.calls).length === 0, JSON.stringify(r.decisions));
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
    check("verif assign-retry: exactly TWO POSTs — accept THEN /assignDrivers {driverId, callId}", p.length === 2 && p[1]?.url.endsWith("/assignDrivers") && p[1]?.body?.driverId === 703785 && p[1]?.body?.callId === "279999999", JSON.stringify(p));
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
    check("all-loaded: chain-aware arrival picks A (120 min < 130 min)", pickAll?.driver.driverId === 3001 && pickAll?.queueInclusive === true, JSON.stringify(pickAll));
    check("all-loaded: chain math recorded (3 jobs ≈ 110 min + final leg 10; arrival 120)", pickAll?.queueMinutes === 110 && pickAll?.queuedJobCount === 3 && pickAll?.finalLegMinutes === 10 && pickAll?.baseMinutes === 120, JSON.stringify(pickAll));
    check("all-loaded: quoted ETA includes queue time (ceil(120)+5 = 125)", finalEtaMinutes(pickAll.baseMinutes, 5, 5, 180) === 125, String(finalEtaMinutes(pickAll.baseMinutes, 5, 5, 180)));
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
    // both candidates at the 3-job cap → workload-chain winner 3001, ETA 125.
    {
      const m = makeFetch({
        offers: [{ ...offer(8031), drivers: [3001, 3002] }],
        drivers: [driver(3001, "Queue A", { lat: 41.15, lng: -73.10, etaSec: 604 }), driver(3002, "Queue B", { lat: 41.25, lng: -73.25, etaSec: 604 })],
      });
      const { deps } = makeDeps(m.fetchImpl, router);
      const r = await runAutoDispatch(ORG4, deps);
      check("engine all-loaded: auto_accept_with_driver + winner 3001", r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false && r.decisions[0]?.reason.includes("VERIFIED"), JSON.stringify(r.decisions[0]));
      const p = posts(m.calls);
      check("engine all-loaded: accept posts driverId 3001 + workload ETA 125", p.length === 1 && p[0]?.body?.driverId === 3001 && p[0]?.body?.ETA === 125, JSON.stringify(p[0]?.body));
      const rows = await q`SELECT call_request_id, decision, driver_id, eta_minutes, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG4} AND call_request_id='8031'`;
      const row = rows[0];
      check("engine all-loaded: reason names winner + chain math (3 active jobs ≈ 110 min; ETA 125 min)", row && String(row.driver_id) === "3001" && Number(row.eta_minutes) === 125 && String(row.reason).includes("3 active jobs ≈ 110 min") && String(row.reason).includes("final leg 10") && String(row.reason).includes("ETA 125 min"), String(row?.reason));
      check("engine all-loaded: raw_response.eta chain facts recorded", row && row.raw_response?.eta?.queueInclusive === true && row.raw_response?.eta?.queueMinutes === 110 && row.raw_response?.eta?.queuedJobCount === 3 && row.raw_response?.eta?.finalLegMinutes === 10 && row.raw_response?.eta?.startedOnScene === false && row.raw_response?.eta?.unlocatedJobs === 0 && row.raw_response?.eta?.finalMinutes === 125, JSON.stringify(row?.raw_response?.eta));
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
    check("ledger: every auto_accept + escalation path present exactly once", byDecision["auto_accept_with_driver"] === 15 && byDecision["auto_accept_no_driver"] === 1 && byDecision["escalated_out_of_zone"] === 1 && byDecision["escalated_missing_coords"] === 1 && byDecision["escalated_expired"] === 1 && byDecision["escalated_unexpected_shape"] === 1 && byDecision["escalated_driver_lookup_failed"] === 1 && byDecision["escalated_accept_failed"] === 1 && byDecision["escalated_dispatch_failed"] === 1, JSON.stringify(byDecision));
    const a = await audits();
    check("audit: 16 ai_dispatcher:accept rows (every accept incl. no-driver)", Number(a[0].n) === 16, String(a[0].n));
    const adAudit = await q`SELECT count(*)::int n FROM audit_log WHERE org_id=${ORG} AND action='ai_dispatcher:decision'`;
    check("audit: 7 ai_dispatcher:decision rows (escalations)", Number(adAudit[0].n) === 7, String(adAudit[0].n));
    // Scope to the OWNER session row: since migration 10 a real contractor
    // sign-in (driver-auth.ts) legitimately adds session_kind='driver' rows to
    // the same org — the check's intent is that the owner session is untouched.
    const ownerSession = await q`SELECT status FROM towbook_sessions WHERE org_id=${"89e15ce587651cc47c3bc45b1c612a220955"} AND session_kind='owner'`;
    check("owner org session untouched", ownerSession.length === 1 && String(ownerSession[0].status) === "connected", JSON.stringify(ownerSession));
    const ownerDecisions = await q`SELECT count(*)::int n FROM ai_dispatcher_decisions WHERE org_id=${"89e15ce587651cc47c3bc45b1c612a220955"}`;
    check("owner org untouched: decision count unchanged by this run", Number(ownerDecisions[0].n) === ownerBaseline, `${ownerBaseline} → ${Number(ownerDecisions[0].n)}`);
  }

  console.log("\nALL AI-DISPATCHER CHECKS PASSED");
  for (const [name, ok, extra] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
} finally {
  // ---- cleanup: QA orgs cascade decisions/settings/jobs/events/audit/session/membership
  if (created) {
    await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
    await q`DELETE FROM organizations WHERE id=${ORG2}`.catch(() => {});
    await q`DELETE FROM organizations WHERE id=${ORG3}`.catch(() => {});
    await q`DELETE FROM organizations WHERE id=${ORG4}`.catch(() => {});
    await q`DELETE FROM users WHERE id=${USER}`.catch(() => {});
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
    (SELECT count(*) FROM ai_dispatcher_runs WHERE org_id=${ORG4}) AS runs4`;
  const l = leftover[0];
  console.log(`\ncleanup: ai_decisions=${l.ad} settings=${l.os} jobs=${l.jobs} events=${l.ev} audit=${l.audit} sessions=${l.sess} members=${l.members} users=${l.users} runs=${l.runs} ad2=${l.ad2} settings2=${l.os2} runs2=${l.runs2} ad3=${l.ad3} settings3=${l.os3} sess3=${l.sess3} runs3=${l.runs3} ad4=${l.ad4} settings4=${l.os4} jobs4=${l.jobs4} sess4=${l.sess4} runs4=${l.runs4}`);
  if (Object.values(l).some((v) => Number(v) > 0)) {
    console.error("WARNING: QA rows remain!");
    process.exitCode = 1;
  }
}
