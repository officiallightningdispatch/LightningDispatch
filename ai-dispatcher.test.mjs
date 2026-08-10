// Hermetic AI-dispatcher test suite (decisions 2026-08-10/11): the owner-directed
// auto-accept engine — zone math (haversine vs the 06606 centroid), driver
// selection, decision ledger + dedupe, every escalation path, and the settings
// toggle gate. The accept/nearestDrivers/callRequests fetches are ALL mocked —
// this suite can never POST to real Towbook.
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

const {
  runAutoDispatch,
  getOrgSettings,
  haversineMiles,
  chooseBestDriver,
  clampEtaMinutes,
  validateOfferShape,
  shapeKeyOf,
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
  headers: new Headers({ "content-type": "application/json" }),
});

/** Mock Towbook fetch. Records every call; routes GET /api/callRequests/,
 *  GET /api/nearestDrivers, POST /api/callRequests/{id}/accept. Throws on any
 *  URL outside the documented surface — a stray call fails the test. */
function makeFetch({ offers, drivers, acceptStatus = 200, acceptBody = null, acceptFails = 0, nearestDriversStatus = 200 }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    const parsedBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body: parsedBody });
    if (u.endsWith("/api/callRequests/") && method === "GET") return jsonResponse(200, offers);
    if (u.includes("/api/nearestDrivers")) {
      if (nearestDriversStatus !== 200) return jsonResponse(nearestDriversStatus, { error: "boom" });
      return jsonResponse(200, drivers);
    }
    if (u.includes("/api/callRequests/") && method === "POST") {
      if (acceptFails > 0) { acceptFails--; return jsonResponse(500, { error: "accept boom" }); }
      if (acceptStatus !== 200) return jsonResponse(acceptStatus, { error: "boom" });
      return jsonResponse(200, acceptBody ?? { id: 279999999, callNumber: 25000, status: { id: 2 }, version: 1 });
    }
    throw new Error(`mock fetch hit an unexpected URL: ${method} ${u}`);
  };
  return { fetchImpl, calls };
}

const makeDeps = (fetchImpl) => {
  const syncCalls = [];
  return {
    deps: {
      syncForOrg: async (orgId, trigger, actor) => { syncCalls.push({ orgId, trigger, actor }); return { ok: true }; },
      resolveOrgActor: async () => ({ id: USER, role: "owner" }),
      fetchImpl,
    },
    syncCalls,
  };
};

const decisions = () => q`SELECT call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG} ORDER BY created_at, call_request_id`;
const audits = () => q`SELECT count(*)::int n FROM audit_log WHERE org_id=${ORG} AND action='ai_dispatcher:accept'`;
const posts = (calls) => calls.filter((c) => c.method === "POST");

try {
  // ---- setup: schema (idempotent; applies v8), QA orgs + owner + encrypted session
  await ensureSchema();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa ai-dispatcher')`;
  await q`INSERT INTO organizations(id, name) VALUES(${ORG2}, 'qa ai-dispatcher no-session')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${USER}, 'QA AI Dispatcher Owner', ${`ad-${randomUUID()}@qa.local`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${USER}, 'owner')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected')`;
  created = true;

  /* ============ 1) pure functions: zone math ============ */
  check("haversine(centroid) = 0", haversineMiles(ZONE.lat, ZONE.lng, ZONE.lat, ZONE.lng) === 0);
  const inside = haversineMiles(41.2, -73.2, ZONE.lat, ZONE.lng);
  check("haversine in-zone point < 30 mi", inside > 0 && inside < 30, String(inside));
  const boundaryIn = haversineMiles(northOf(29.5), ZONE.lng, ZONE.lat, ZONE.lng);
  const boundaryOut = haversineMiles(northOf(30.5), ZONE.lng, ZONE.lat, ZONE.lng);
  check("boundary math: 29.5-mi offset < 30 < 30.5-mi offset", boundaryIn < 30 && boundaryOut > 30 && boundaryOut - boundaryIn < 1.5, `${boundaryIn} / ${boundaryOut}`);
  const far = haversineMiles(40.6, -74.5, ZONE.lat, ZONE.lng);
  check("haversine far point (NJ) > 30 mi", far > 30, String(far));

  /* ============ 2) pure functions: driver selection ============ */
  const freeFast = driver(703785, "Jayden Fountain", { etaSec: 604 });
  const freeSlow = driver(603482, "Antone jerret", { etaSec: 1255 });
  const busy = driver(668209, "George Boyd", { calls: [{ callId: 1, status: 3 }] });
  const noGps = driver(103665, "Brittani Simms", { lat: 0, lng: 0, etaSec: 5 });
  const offline = driver(717660, "Levi C Martin", { checkedIn: false, etaSec: 10 });
  check("chooseBestDriver picks the free+GPS+checked-in min-ETA driver", chooseBestDriver([freeSlow, freeFast, busy, noGps, offline])?.driverId === 703785);
  check("chooseBestDriver excludes busy/no-GPS/offline", chooseBestDriver([freeFast, busy])?.driverId === 703785 && chooseBestDriver([busy, noGps, offline]) === null);
  check("chooseBestDriver([]) = null", chooseBestDriver([]) === null);
  check("clampEtaMinutes: ceil(604/60)=11", clampEtaMinutes(604, 45) === 11);
  check("clampEtaMinutes: 3600s clamps to maxEta 10", clampEtaMinutes(3600, 10) === 10);
  check("clampEtaMinutes: 30s → 1 (floor)", clampEtaMinutes(30, 45) === 1);
  check("clampEtaMinutes: NaN → 1", clampEtaMinutes(NaN, 45) === 1);

  /* ============ 3) pure functions: offer shape rail ============ */
  check("validateOfferShape ok on documented shape", validateOfferShape(offer(9001)).ok === true);
  const noLat = validateOfferShape(offer(9002, { omitLat: true }));
  check("validateOfferShape flags missing startLocationLatitude", !noLat.ok && noLat.missing.includes("startLocationLatitude"), JSON.stringify(noLat));
  const noStatus = validateOfferShape({ ...offer(9003), status: undefined });
  check("validateOfferShape flags missing status", !noStatus.ok && noStatus.missing.includes("status"));
  check("validateOfferShape rejects non-objects", !validateOfferShape("junk").ok && !validateOfferShape(null).ok);
  check("shapeKeyOf stable + distinct", shapeKeyOf(offer(9004)) === shapeKeyOf(offer(9004)) && shapeKeyOf(offer(9004)) !== shapeKeyOf({ ...offer(9004), accountName: "other" }));

  /* ============ 4) settings defaults (lazily created row) ============ */
  const s = await getOrgSettings(ORG);
  check("org_settings defaults: enabled + 06606 centroid + 30mi + 45min", s.aiDispatcherEnabled === true && s.zoneLat === 41.208862 && s.zoneLng === -73.207253 && s.zoneRadiusMiles === 30 && s.maxEtaMinutes === 45, JSON.stringify(s));

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

  /* ============ 7) auto-accept with driver (in zone, best driver, ETA clamp) ============ */
  {
    const m = makeFetch({
      offers: [offer(7001)],
      drivers: [driver(717660, "Levi C Martin", { checkedIn: false, etaSec: 10 }), driver(603482, "Antone jerret", { etaSec: 1255 }), driver(703785, "Jayden Fountain", { etaSec: 604 })],
    });
    const { deps, syncCalls } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("auto-accept: 1 offer seen, 1 processed, no skip", r.offersSeen === 1 && r.processed === 1 && r.skipped === null, JSON.stringify(r));
    check("auto-accept: decision auto_accept_with_driver, not escalated", r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false, JSON.stringify(r.decisions));
    const p = posts(m.calls);
    check("auto-accept: exactly ONE POST (the accept)", p.length === 1 && m.calls.some((c) => c.url.endsWith("/api/callRequests/7001/accept")), JSON.stringify(m.calls.map((c) => c.url)));
    check("auto-accept: chose the min-ETA free driver (703785)", p[0]?.body?.driverId === 703785, JSON.stringify(p[0]?.body));
    check("auto-accept: ETA = ceil(604/60) = 11, body matches UI payload", p[0]?.body?.ETA === 11 && p[0]?.body?.id === 7001 && p[0]?.body?.comments === "" && p[0]?.body?.notes === "auto-accept by Lightning Dispatch" && p[0]?.body?.tireAvailable === false, JSON.stringify(p[0]?.body));
    const rows = await decisions();
    check("decision row: driver 703785 + name + eta 11 + zone distance + raw accept response", rows.length === 1 && String(rows[0].driver_id) === "703785" && String(rows[0].driver_name) === "Jayden Fountain" && Number(rows[0].eta_minutes) === 11 && Number(rows[0].zone_distance_miles) > 0 && rows[0].raw_response?.callNumber === 25000, JSON.stringify(rows[0]));
    check("decision row: call_id reconciled from accept response", String(rows[0].call_id) === "279999999", String(rows[0].call_id));
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
      drivers: [driver(703785, "Jayden Fountain", { etaSec: 3600 })], // 60 min raw → clamped to 10
    });
    const { deps } = makeDeps(m.fetchImpl);
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

  /* ============ 18) no acceptable driver → accept with driverId 0 + escalate ============ */
  {
    const m = makeFetch({
      offers: [offer(7012)],
      drivers: [driver(603482, "Antone jerret", { etaSec: 10, calls: [{ callId: 1, status: 3 }] }), driver(103665, "Brittani Simms", { lat: 0, lng: 0 }), driver(717660, "Levi C Martin", { checkedIn: false })],
    });
    const { deps, syncCalls } = makeDeps(m.fetchImpl);
    const r = await runAutoDispatch(ORG, deps);
    check("no driver: decision auto_accept_no_driver, escalated for the ops queue", r.decisions[0]?.decision === "auto_accept_no_driver" && r.decisions[0]?.escalated === true, JSON.stringify(r.decisions));
    const p = posts(m.calls);
    check("no driver: accepted with driverId 0 (offer must not expire)", p.length === 1 && p[0]?.body?.driverId === 0, JSON.stringify(p[0]?.body));
    check("no driver: sync still triggered after accept", syncCalls.length === 1 && syncCalls[0].trigger === "sync:auto-accept", JSON.stringify(syncCalls));
    const rows = await decisions();
    const nd = rows.find((x) => String(x.call_request_id) === "7012");
    check("no driver: reason explains the escalation", nd && String(nd.reason).includes("no checked-in free driver with GPS") && nd.raw_response?.callNumber === 25000, String(nd?.reason));
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

  /* ============ 21) ledger totals + owner org untouched ============ */
  {
    const rows = await decisions();
    const byDecision = rows.reduce((acc, x) => { acc[x.decision] = (acc[x.decision] || 0) + 1; return acc; }, {});
    check("ledger: every auto_accept + escalation path present exactly once", byDecision["auto_accept_with_driver"] === 6 && byDecision["auto_accept_no_driver"] === 1 && byDecision["escalated_out_of_zone"] === 1 && byDecision["escalated_missing_coords"] === 1 && byDecision["escalated_expired"] === 1 && byDecision["escalated_unexpected_shape"] === 1 && byDecision["escalated_driver_lookup_failed"] === 1 && byDecision["escalated_accept_failed"] === 1, JSON.stringify(byDecision));
    const a = await audits();
    check("audit: 7 ai_dispatcher:accept rows (every accept incl. no-driver)", Number(a[0].n) === 7, String(a[0].n));
    const adAudit = await q`SELECT count(*)::int n FROM audit_log WHERE org_id=${ORG} AND action='ai_dispatcher:decision'`;
    check("audit: 6 ai_dispatcher:decision rows (escalations)", Number(adAudit[0].n) === 6, String(adAudit[0].n));
    const ownerSession = await q`SELECT status FROM towbook_sessions WHERE org_id=${"89e15ce587651cc47c3bc45b1c612a220955"}`;
    check("owner org session untouched", ownerSession.length === 1 && String(ownerSession[0].status) === "connected", JSON.stringify(ownerSession));
    const ownerDecisions = await q`SELECT count(*)::int n FROM ai_dispatcher_decisions WHERE org_id=${"89e15ce587651cc47c3bc45b1c612a220955"}`;
    check("owner org has zero AI-dispatcher decisions", Number(ownerDecisions[0].n) === 0, String(ownerDecisions[0].n));
  }

  console.log("\nALL AI-DISPATCHER CHECKS PASSED");
  for (const [name, ok, extra] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
} finally {
  // ---- cleanup: QA orgs cascade decisions/settings/jobs/events/audit/session/membership
  if (created) {
    await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
    await q`DELETE FROM organizations WHERE id=${ORG2}`.catch(() => {});
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
    (SELECT count(*) FROM ai_dispatcher_decisions WHERE org_id=${ORG2}) AS ad2,
    (SELECT count(*) FROM org_settings WHERE org_id=${ORG2}) AS os2`;
  const l = leftover[0];
  console.log(`\ncleanup: ai_decisions=${l.ad} settings=${l.os} jobs=${l.jobs} events=${l.ev} audit=${l.audit} sessions=${l.sess} members=${l.members} users=${l.users} ad2=${l.ad2} settings2=${l.os2}`);
  if (Object.values(l).some((v) => Number(v) > 0)) {
    console.error("WARNING: QA rows remain!");
    process.exitCode = 1;
  }
}
