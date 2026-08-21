// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// OWNER-EDITABLE ASSIGNED DRIVER (owner-directed 2026-08-13): change which
// contractor is on a call from the owner/ops portal. The suite proves:
//   1. role gating — contractor AND dispatcher actors are refused; owner/admin
//      proceed (the UI hides the control for non-owner kinds; the server
//      refuses anyway)
//   2. Towbook persistence uses the PROVEN assign path — PUT /api/calls/{id}
//      with {id, status:{id:<CURRENT status, preserved>},
//      assets:[{id:<assetId>, drivers:[{driver:{id:<newDriverId>}}]}]} and
//      read-back verification (never claim "changed" without seeing the driver
//      on the call)
//   3. DB persistence — dispatch_jobs assignment updated + the
//      manual-reassign marker (manually_reassigned_at/by, migration 44) so the
//      3s sync and the AI dispatcher see it immediately
//   4. audit — audit_log row action='reassign_driver' (occurred_at timestamp,
//      NOT created_at — migration 3) with old driver → new driver
//   5. push — the unified notifyAssignedDriver trigger fires for the NEW driver
//      (pushImpl injected; the real trigger is the same one the AI dispatcher +
//      manual assign use, committed 9999c01)
//   6. platform-only jobs (no towbook_job_id) skip Towbook but still update
//      DB + audit + push; same-driver no-op and terminal jobs are refused
//   7. AI-DISPATCHER GUARD — when an offer lands for a call a HUMAN
//      reassigned (marker set + PO match), the engine treats the human's
//      latest assignment as AUTHORITATIVE: the accept carries the human-chosen
//      driver id (NOT the road-best driver) and the decision ledger records
//      the respect; no marker → the normal road-aware path is untouched.
//
//   DATABASE_URL=... bun reassign-driver.test.mjs
// Hermetic: Towbook HTTP is a mocked fetchImpl; the DB client passes through
// to the real network. QA orgs qa-rd-<uuid> only; never touches the owner org.
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
// Test key for THIS process only (env-first resolution overrides the stable
// key). The QA session rows are encrypted with it; the running server is a
// separate process and never sees it.
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 6).toString("base64");
const { reassignDriverCore } = await import("./src/data/reassign-core.ts");
const { runAutoDispatch } = await import("./src/data/ai-dispatcher.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ORG = `qa-rd-${randomUUID()}`;
const ORG2 = `qa-rd2-${randomUUID()}`; // AI-dispatcher guard org
const USER = `qa-rd-user-${randomUUID()}`;
const DRIVER_A = `qa-rd-driver-a-${randomUUID()}`; // old driver (LD user id)
const DRIVER_B = `qa-rd-driver-b-${randomUUID()}`; // new driver (LD user id)
const DRIVER_C = `qa-rd-driver-c-${randomUUID()}`; // out-of-state driver (LD user id)
const DRIVER_D = `qa-rd-driver-d-${randomUUID()}`; // no-location driver (LD user id)
const TB_A = "777101"; // old driver Towbook id
const TB_B = "777102"; // new driver Towbook id
const TB_C = "777103"; // out-of-state driver Towbook id
const TB_D = "777104"; // no-location driver Towbook id
const JOB = `qa-rd-job-${randomUUID()}`;
const JOB_NO_TB = `qa-rd-job-nodb-${randomUUID()}`;
const JOB2 = `qa-rd-job2-${randomUUID()}`; // same-state-guard job (CT, fresh)
const JOB_UNKNOWN = `qa-rd-job-unk-${randomUUID()}`; // no resolvable state
const CT_FIX = [41.2, -73.2];
const TX_FIX = [30.2, -97.7];
let created = false;

/* ------------------------------ fixtures ------------------------------ */
const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() { return JSON.stringify(body); },
  async json() { return body; },
  headers: new Headers({ "content-type": "application/json" }),
});

/** Mocked Towbook surface for reassignDriverCore: GET /api/calls/{id} returns
 *  the call (status + asset); PUT /api/calls/{id} applies the NEW driver from
 *  the Map-app payload and records the PUT body for payload-shape assertions.
 *  Any URL outside the surface throws — a stray call fails the test. */
function makeReassignFetch({ callId = 279111111, callStatus = 2, assetId = 777111, oldDriverId = Number(TB_A), reverseStates = {} }) {
  const calls = [];
  let call = { id: callId, callNumber: 25001, status: { id: callStatus }, version: 1, assets: [{ id: assetId, driver: { id: oldDriverId, name: "Old Driver" } }] };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body });
    // SAME-STATE GUARD reverse-geocode route (TomTom Search v2 shape): per
    // rounded coordinate → state from reverseStates; anything unmapped is CT
    // (all default fixtures sit at CT coords). A mapped null → 404 (state
    // unresolvable → the guard fails closed).
    const rg = u.match(/\/search\/2\/reverseGeocode\/(-?[\d.]+),(-?[\d.]+)\.json/);
    if (rg) {
      const key = `${Number(rg[1]).toFixed(3)},${Number(rg[2]).toFixed(3)}`;
      const st = key in reverseStates ? reverseStates[key] : "CT";
      if (!st) return jsonResponse(404, {});
      return jsonResponse(200, { addresses: [{ address: { countryCode: "US", adminDistrict: st } }] });
    }
    const m = u.match(/\/api\/calls\/(\d+)$/);
    if (!m) throw new Error(`reassign mock hit an unexpected URL: ${method} ${u}`);
    if (String(m[1]) !== String(callId)) return jsonResponse(404, { error: "not found" });
    if (method === "GET") return jsonResponse(200, call);
    if (method === "PUT") {
      const driverId = body?.assets?.[0]?.drivers?.[0]?.driver?.id;
      const asset = body?.assets?.[0]?.id ?? assetId;
      const statusId = body?.status?.id ?? callStatus;
      call = { ...call, status: { id: statusId }, assets: [{ id: asset, drivers: [{ driver: { id: driverId, name: "New Driver" } }] }] };
      return jsonResponse(200, { ok: true });
    }
    throw new Error(`reassign mock unexpected method ${method}`);
  };
  return { fetchImpl, calls, getCall: () => call };
}

/* --------------- AI-dispatcher guard fixtures (compacted from ai-dispatcher.test.mjs) --------------- */
const ZONE = { lat: 41.208862, lng: -73.207253, radiusMi: 30 };
const offer = (id, po, eligible = [603482, 703785]) => ({
  callRequestId: id,
  masterAccountId: 29,
  accountId: 894873,
  accountName: "Agero (Swoop) Bridgeport",
  companyId: 23257,
  status: 0,
  expirationDateUtc: new Date(Date.now() + 10 * 60000).toISOString(),
  defaultEta: 30,
  purchaseOrderNumber: po,
  startingLocation: "123 MAIN ST, BRIDGEPORT CT 06606",
  sound: false,
  startLocationLatitude: 41.2,
  startLocationLongitude: -73.2,
  drivers: eligible,
  availableActions: ["NearestDrivers", "REQUEST_CALL", "ACKNOWLEDGE"],
});
const driver = (id, name, opts = {}) => ({
  driverId: id, driverName: name, truckId: 0, latitude: opts.lat ?? 41.2, longitude: opts.lng ?? -73.2,
  estimatedDistanceMiles: 5, estimatedTimeSeconds: opts.etaSec ?? 600, isCheckedIn: opts.checkedIn ?? true, calls: opts.calls ?? [],
});
function makeEngineFetch({ offers, drivers }) {
  const calls = [];
  let call = null;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    const parsedBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body: parsedBody });
    if (u.endsWith("/api/callRequests/") && method === "GET") return jsonResponse(200, offers);
    if (u.includes("/api/nearestDrivers")) return jsonResponse(200, drivers);
    if (u.includes("/api/callRequests/") && method === "POST") {
      const offerFor = offers.find((o) => String(o.callRequestId) === u.split("/api/callRequests/")[1].split("/")[0]);
      call = {
        id: 279999999, callNumber: 25000, status: { id: 2 }, version: 1,
        purchaseOrderNumber: offerFor ? offerFor.purchaseOrderNumber : null,
        assets: parsedBody && Number(parsedBody.driverId) > 0
          ? [{ id: 424242, driver: { id: Number(parsedBody.driverId), name: "Assigned" } }]
          : [],
      };
      return jsonResponse(200, { id: 279999999, callNumber: 25000, status: { id: 2 }, version: 1 });
    }
    if (u.includes("/api/calls/") && method === "PUT") {
      const m2 = u.match(/\/api\/calls\/(\d+)$/);
      if (call && m2 && String(call.id) === m2[1]) {
        const driverId = parsedBody?.assets?.[0]?.drivers?.[0]?.driver?.id;
        if (driverId != null) { call.status = { id: 1 }; call.assets = [{ id: 424242, drivers: [{ driver: { id: driverId, name: "Assigned" } }] }]; }
      }
      return jsonResponse(200, { ok: true });
    }
    if (u.includes("/api/calls")) {
      const m = u.match(/\/api\/calls\/(\d+)$/);
      if (m) return call && String(call.id) === m[1] ? jsonResponse(200, call) : jsonResponse(404, { error: "not found" });
      return jsonResponse(200, []);
    }
    throw new Error(`guard mock fetch hit an unexpected URL: ${method} ${u}`);
  };
  return { fetchImpl, calls };
}
const makeRouter = () => async (fromLat, fromLng, toLat, toLng) => {
  const mi = Math.hypot((fromLat - toLat) * 69.09, (fromLng - toLng) * 54.6);
  return { seconds: Math.max(60, Math.round((mi / 30) * 3600 * 1.35)), provider: "osrm", liveTraffic: false, trafficDelaySeconds: null, notes: "static routing (mock)" };
};
const makeDeps = (fetchImpl) => ({
  syncForOrg: async () => ({ ok: true }),
  resolveOrgActor: async () => ({ id: USER, role: "owner" }),
  fetchImpl,
  verifyRetryDelayMs: 0,
  routerOverride: { provider: "osrm", tomtomKeyConfigured: false, router: makeRouter() },
  // SAME-STATE GUARD (owner rule 2026-08-13): hermetic driver-state resolver —
  // every fixture driver sits at CT coords; the engine's job-state parse,
  // comparison and fail-closed refusal still run.
  stateGuardResolver: async () => "CT",
});

try {
  await ensureSchema();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa reassign-driver'), (${ORG2}, 'qa reassign-driver guard')`;
  await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES
    (${USER}, 'QA Reassign Owner', ${`rd-${randomUUID()}@qa.local`}, 'x', NULL),
    (${DRIVER_A}, 'QA Old Driver', ${`rd-a-${randomUUID()}@qa.local`}, 'x', ${TB_A}),
    (${DRIVER_B}, 'QA New Driver', ${`rd-b-${randomUUID()}@qa.local`}, 'x', ${TB_B}),
    (${DRIVER_C}, 'QA Texas Driver', ${`rd-c-${randomUUID()}@qa.local`}, 'x', ${TB_C}),
    (${DRIVER_D}, 'QA No-Fix Driver', ${`rd-d-${randomUUID()}@qa.local`}, 'x', ${TB_D})`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
    (${ORG}, ${USER}, 'owner'),
    (${ORG}, ${DRIVER_A}, 'contractor'),
    (${ORG}, ${DRIVER_B}, 'contractor'),
    (${ORG}, ${DRIVER_C}, 'contractor'),
    (${ORG}, ${DRIVER_D}, 'contractor'),
    (${ORG2}, ${USER}, 'owner'),
    (${ORG2}, ${DRIVER_B}, 'contractor'),
    (${ORG2}, (SELECT id FROM users WHERE towbook_driver_id='603482'), 'contractor'),
    (${ORG2}, (SELECT id FROM users WHERE towbook_driver_id='703785'), 'contractor')`;
  // SAME-STATE GUARD fixtures: current locations for the drivers the guard
  // reverse-geocodes (freshest driver_locations fix → today's anchor).
  await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, latitude, longitude, captured_at) VALUES
    (${`qa-rd-loc-a-${randomUUID()}`}, ${ORG}, ${DRIVER_A}, ${TB_A}, ${CT_FIX[0]}, ${CT_FIX[1]}, NOW()),
    (${`qa-rd-loc-b-${randomUUID()}`}, ${ORG}, ${DRIVER_B}, ${TB_B}, ${CT_FIX[0]}, ${CT_FIX[1]}, NOW()),
    (${`qa-rd-loc-c-${randomUUID()}`}, ${ORG}, ${DRIVER_C}, ${TB_C}, ${TX_FIX[0]}, ${TX_FIX[1]}, NOW()),
    (${`qa-rd-loc-b-org2-${randomUUID()}`}, ${ORG2}, ${DRIVER_B}, ${TB_B}, ${CT_FIX[0]}, ${CT_FIX[1]}, NOW()),
    (${`qa-rd-loc-road-best-org2-${randomUUID()}`}, ${ORG2}, ${USER}, '603482', ${CT_FIX[0]}, ${CT_FIX[1]}, NOW()),
    (${`qa-rd-loc-road-second-org2-${randomUUID()}`}, ${ORG2}, ${USER}, '703785', ${CT_FIX[0]}, ${CT_FIX[1]}, NOW())`;
  // DRIVER_D intentionally has NO driver_locations row (the unknown-location case).
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES
    (${ORG}, ${await encryptSession(JSON.stringify({ cookies: "xtl=rd-session", baseUrl: "https://app.towbook.com" }))}, 'connected'),
    (${ORG2}, ${await encryptSession(JSON.stringify({ cookies: "xtl=rd-session", baseUrl: "https://app.towbook.com" }))}, 'connected')`;
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, raw_json, pickup, pickup_lat, pickup_lng, assigned_driver_towbook_id, assigned_driver_name, assigned_at)
    VALUES(${JOB}, ${ORG}, 'QA Motorist', '555', 41.2, -73.2, 'Bridgeport CT', 'jump_start', 'accepted', NOW(), '', '279111111', ${JSON.stringify({ id: 279111111, purchaseOrderNumber: "1125guard", status: { id: 2 } })}::jsonb, 'Bridgeport CT', 41.2, -73.2, ${TB_A}, 'QA Old Driver', NOW()),
          (${JOB_NO_TB}, ${ORG}, 'QA Platform Only', '555', 41.2, -73.2, 'Bridgeport CT', 'lockout', 'offered', NOW(), '', NULL, NULL, 'Bridgeport CT', 41.2, -73.2, ${TB_A}, 'QA Old Driver', NOW())`;
  // ORG2 (AI-dispatcher guard): a call tied to the offer's PO that a HUMAN
  // reassigned to the new driver — the marker the guard must respect.
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, raw_json, pickup, pickup_lat, pickup_lng, assigned_driver_towbook_id, assigned_driver_name, assigned_at, manually_reassigned_at, manually_reassigned_by)
    VALUES(${`qa-rd-guard-${randomUUID()}`}, ${ORG2}, 'QA Guarded Call', '555', 41.2, -73.2, 'Bridgeport CT', 'tire_change', 'offered', NOW(), '', '279222222', ${JSON.stringify({ id: 279222222, purchaseOrderNumber: "1125guard", status: { id: 2 } })}::jsonb, 'Bridgeport CT', 41.2, -73.2, ${TB_B}, 'QA New Driver', NOW(), NOW(), ${USER})`;
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, raw_json, pickup, pickup_lat, pickup_lng, assigned_driver_towbook_id, assigned_driver_name, assigned_at, manually_reassigned_at, manually_reassigned_by)
    VALUES(${`qa-rd-guard2-${randomUUID()}`}, ${ORG2}, 'QA Ineligible Guarded', '555', 41.2, -73.2, 'Bridgeport CT', 'fuel_delivery', 'offered', NOW(), '', '279333333', ${JSON.stringify({ id: 279333333, purchaseOrderNumber: "1125inelig", status: { id: 2 } })}::jsonb, 'Bridgeport CT', 41.2, -73.2, ${TB_A}, 'QA Old Driver', NOW(), NOW(), ${USER})`;
  // SAME-STATE GUARD jobs: JOB2 is a fresh CT job assigned to TB_A (the guard
  // tests reassign it); JOB_UNKNOWN's pickup has no resolvable state.
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, raw_json, pickup, pickup_lat, pickup_lng, assigned_driver_towbook_id, assigned_driver_name, assigned_at)
    VALUES(${JOB2}, ${ORG}, 'QA Guard Job', '555', 41.2, -73.2, 'Bridgeport CT', 'jump_start', 'accepted', NOW(), '', '279444444', ${JSON.stringify({ id: 279444444, purchaseOrderNumber: "1125guard2", status: { id: 2 } })}::jsonb, '1441 MAIN ST, BRIDGEPORT CT 06606', 41.2, -73.2, ${TB_A}, 'QA Old Driver', NOW()),
          (${JOB_UNKNOWN}, ${ORG}, 'QA No-State Job', '555', 41.2, -73.2, 'Bridgeport CT', 'lockout', 'offered', NOW(), '', '279555555', ${JSON.stringify({ id: 279555555, purchaseOrderNumber: "1125unk", status: { id: 2 } })}::jsonb, 'MAIN ST', 41.2, -73.2, ${TB_A}, 'QA Old Driver', NOW())`;
  created = true;

  /* ============ 1) role gating ============ */
  {
    const rC = await reassignDriverCore({ jobId: JOB, contractorId: DRIVER_B, orgId: ORG, actor: { id: DRIVER_A, role: "contractor" } });
    check("gate: contractor actor refused (unauthorized)", !rC.ok && rC.code === "unauthorized", JSON.stringify(rC));
    const rD = await reassignDriverCore({ jobId: JOB, contractorId: DRIVER_B, orgId: ORG, actor: { id: DRIVER_A, role: "dispatcher" } });
    check("gate: dispatcher actor refused (owner/admin only)", !rD.ok && rD.code === "unauthorized", JSON.stringify(rD));
  }

  /* ============ 2) happy path: Towbook PUT (proven payload, status preserved) + DB + audit + push ============ */
  {
    const m = makeReassignFetch({});
    const pushed = [];
    const r = await reassignDriverCore({
      jobId: JOB, contractorId: DRIVER_B, orgId: ORG, actor: { id: USER, role: "owner" },
      opts: { fetchImpl: m.fetchImpl, pushImpl: async (orgId, contractorUserId, jobId) => { pushed.push({ orgId, contractorUserId, jobId }); } },
    });
    check("happy: reassign ok, Towbook verified, old→new driver ids", r.ok && r.towbookStatus === "verified" && r.oldDriverId === TB_A && r.newDriverId === TB_B && r.oldDriverName === "QA Old Driver" && r.newDriverName === "QA New Driver", JSON.stringify(r));
    const put = m.calls.find((c) => c.method === "PUT");
    check("happy: PUT /api/calls/{id} fired", Boolean(put), JSON.stringify(m.calls));
    check("happy: PUT payload shape — {id, status:{id:<current>}, assets:[{id, drivers:[{driver:{id:new}}]}]}",
      put && Number(put.body.id) === 279111111 && put.body.status?.id === 2 && put.body.assets?.[0]?.id === 777111 && put.body.assets?.[0]?.drivers?.[0]?.driver?.id === Number(TB_B),
      JSON.stringify(put?.body));
    check("happy: read-back verification GET happened after the PUT", m.calls.filter((c) => c.method === "GET").length >= 2, JSON.stringify(m.calls));
    const row = (await q`SELECT assigned_driver_towbook_id, assigned_driver_name, manually_reassigned_at, manually_reassigned_by FROM dispatch_jobs WHERE id=${JOB} AND org_id=${ORG}`)[0];
    check("happy: dispatch_jobs updated + manual-reassign marker stamped",
      String(row.assigned_driver_towbook_id) === TB_B && String(row.assigned_driver_name) === "QA New Driver" && row.manually_reassigned_at != null && String(row.manually_reassigned_by) === USER, JSON.stringify(row));
    const audit = (await q`SELECT actor_user_id, actor_role, action, entity_type, entity_id, detail, occurred_at FROM audit_log WHERE org_id=${ORG} AND entity_id=${JOB} AND action='reassign_driver' ORDER BY occurred_at DESC LIMIT 1`)[0];
    check("happy: audit_log row (action reassign_driver, occurred_at timestamp, old→new in detail)",
      audit && String(audit.action) === "reassign_driver" && String(audit.entity_type) === "job" && audit.occurred_at != null && String(audit.actor_user_id) === USER && String(audit.detail.oldDriverId) === TB_A && String(audit.detail.newDriverId) === TB_B && String(audit.detail.contractorUserId) === DRIVER_B, JSON.stringify(audit));
    check("happy: push trigger fired for the NEW contractor user (notifyAssignedDriver semantics)",
      pushed.length === 1 && pushed[0].contractorUserId === DRIVER_B && pushed[0].jobId === JOB && pushed[0].orgId === ORG, JSON.stringify(pushed));
  }

  /* ============ 3) platform-only job (no towbook_job_id): Towbook skipped, DB+audit+push still happen ============ */
  {
    const pushed = [];
    const r = await reassignDriverCore({
      jobId: JOB_NO_TB, contractorId: DRIVER_B, orgId: ORG, actor: { id: USER, role: "admin" },
      opts: { pushImpl: async (orgId, contractorUserId, jobId) => { pushed.push({ orgId, contractorUserId, jobId }); } },
    });
    check("no-tb: ok with towbookStatus=skipped, towbookJobId null", r.ok && r.towbookStatus === "skipped" && r.towbookJobId === null && r.newDriverId === TB_B, JSON.stringify(r));
    const row = (await q`SELECT assigned_driver_towbook_id, manually_reassigned_at FROM dispatch_jobs WHERE id=${JOB_NO_TB} AND org_id=${ORG}`)[0];
    check("no-tb: DB updated + marker stamped", String(row.assigned_driver_towbook_id) === TB_B && row.manually_reassigned_at != null, JSON.stringify(row));
    const audit = (await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND entity_id=${JOB_NO_TB} AND action='reassign_driver' LIMIT 1`)[0];
    check("no-tb: audit row written", Boolean(audit), JSON.stringify(audit));
    check("no-tb: push fired for the new driver", pushed.length === 1 && pushed[0].contractorUserId === DRIVER_B, JSON.stringify(pushed));
  }

  /* ============ 4) no-ops refused: same driver, terminal job, unknown job/contractor ============ */
  {
    const same = await reassignDriverCore({ jobId: JOB, contractorId: DRIVER_B, orgId: ORG, actor: { id: USER, role: "owner" } });
    check("noop: same driver refused (conflict)", !same.ok && same.code === "conflict", JSON.stringify(same));
    await q`UPDATE dispatch_jobs SET status='completed' WHERE id=${JOB} AND org_id=${ORG}`;
    const terminal = await reassignDriverCore({ jobId: JOB, contractorId: DRIVER_B, orgId: ORG, actor: { id: USER, role: "owner" } });
    check("noop: terminal (completed) job refused (invalid_state)", !terminal.ok && terminal.code === "invalid_state", JSON.stringify(terminal));
    await q`UPDATE dispatch_jobs SET status='accepted' WHERE id=${JOB} AND org_id=${ORG}`;
    const missing = await reassignDriverCore({ jobId: "nope", contractorId: DRIVER_B, orgId: ORG, actor: { id: USER, role: "owner" } });
    check("noop: unknown job refused (not_found)", !missing.ok && missing.code === "not_found", JSON.stringify(missing));
    const notRoster = await reassignDriverCore({ jobId: JOB, contractorId: USER, orgId: ORG, actor: { id: USER, role: "owner" } });
    check("noop: non-roster target refused (not_found)", !notRoster.ok && notRoster.code === "not_found", JSON.stringify(notRoster));
  }

  /* ============ 5) AI-dispatcher guard: manual reassignment is authoritative ============ */
  {
    // The offer PO matches the seeded dispatch_jobs row carrying the
    // manual-reassign marker + the HUMAN-chosen driver TB_B (LD user DRIVER_B).
    // Road-best would be 603482 (closest); the guard must dispatch TB_B.
    const po = "1125guard";
    const m = makeEngineFetch({ offers: [offer(7001, po, [603482, 703785, Number(TB_B)])], drivers: [driver(603482, "Fast Driver", { lat: 41.2, lng: -73.2, etaSec: 300 }), driver(Number(TB_B), "QA New Driver", { lat: 41.199, lng: -73.199, etaSec: 900 })] });
    const pushedTo = [];
    const deps = makeDeps(m.fetchImpl);
    deps.sendAssignmentPush = async (_orgId, driverId) => { pushedTo.push(driverId); };
    const r = await runAutoDispatch(ORG2, deps);
    check("guard: offer processed, decision auto_accept_with_driver", r.processed === 1 && r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false, JSON.stringify(r.decisions));
    const accept = m.calls.find((c) => c.method === "POST" && c.url.includes("/accept"));
    check("guard: accept carries the HUMAN-chosen driver id (not the road-best 603482)", accept && Number(accept.body.driverId) === Number(TB_B), JSON.stringify(accept?.body));
    check("guard: assignment push fired for the HUMAN-chosen NEW driver (never the road-best)", pushedTo.length === 1 && Number(pushedTo[0]) === Number(TB_B), JSON.stringify(pushedTo));
    const dec = (await q`SELECT driver_id, reason FROM ai_dispatcher_decisions WHERE org_id=${ORG2} AND call_request_id='7001'`)[0];
    check("guard: decision ledger driver = human-chosen driver, reason records the respect",
      dec && String(dec.driver_id) === TB_B && String(dec.reason).includes("manual reassignment respected"), JSON.stringify(dec));
  }

  /* ============ 6b) ineligible human-chosen driver → accepted WITHOUT dispatch, escalated, never overwritten ============ */
  {
    const m = makeEngineFetch({ offers: [offer(7003, "1125inelig")], drivers: [driver(603482, "Fast Driver", { lat: 41.2, lng: -73.2, etaSec: 300 })] });
    const r = await runAutoDispatch(ORG2, makeDeps(m.fetchImpl));
    const accept = m.calls.find((c) => c.method === "POST" && c.url.includes("/accept"));
    check("ineligible-guard: accepted WITHOUT dispatch (auto_accept_no_driver, escalated)", r.processed === 1 && r.decisions[0]?.decision === "auto_accept_no_driver" && r.decisions[0]?.escalated === true, JSON.stringify(r.decisions));
    check("ineligible-guard: accept body has NO driver id (never send an ineligible id)", accept && Number(accept.body.driverId) === 0, JSON.stringify(accept?.body));
    const dec = (await q`SELECT reason FROM ai_dispatcher_decisions WHERE org_id=${ORG2} AND call_request_id='7003'`)[0];
    check("ineligible-guard: reason names the eligible-list problem + manual reassignment", dec && String(dec.reason).includes("NOT in the offer's eligible list") && String(dec.reason).includes("manual reassignment respected"), String(dec?.reason));
  }

  /* ============ 6) no marker → normal road-aware path unchanged ============ */
  {
    const m = makeEngineFetch({ offers: [offer(7002, "1125nomarker")], drivers: [driver(603482, "Fast Driver", { lat: 41.2, lng: -73.2, etaSec: 300 }), driver(703785, "Slow Driver", { lat: 41.199, lng: -73.199, etaSec: 900 })] });
    const r = await runAutoDispatch(ORG2, makeDeps(m.fetchImpl));
    const accept = m.calls.find((c) => c.method === "POST" && c.url.includes("/accept"));
    check("no-marker: road-aware dispatch unchanged (road-best 603482 chosen)", r.processed === 1 && accept && Number(accept.body.driverId) === 603482, JSON.stringify(accept?.body));
    const dec = (await q`SELECT reason FROM ai_dispatcher_decisions WHERE org_id=${ORG2} AND call_request_id='7002'`)[0];
    check("no-marker: reason has NO manual-reassign note", dec && !String(dec.reason).includes("manual reassignment respected"), String(dec?.reason));
  }

  /* ============ 7) SAME-STATE GUARD (owner rule 2026-08-13): the manual
     reassign path fails closed on cross-state + unknown, and succeeds same-state ============ */
  {
    // (a) same-state succeeds: CT job + CT driver → Towbook PUT + DB + audit.
    const m = makeReassignFetch({ callId: 279444444, oldDriverId: Number(TB_A) });
    const pushed = [];
    const r = await reassignDriverCore({
      jobId: JOB2, contractorId: DRIVER_B, orgId: ORG, actor: { id: USER, role: "owner" },
      opts: { fetchImpl: m.fetchImpl, pushImpl: async (orgId, contractorUserId, jobId) => { pushed.push({ orgId, contractorUserId, jobId }); } },
    });
    check("guard same-state: reassign ok + Towbook verified (CT job, CT driver)", r.ok && r.towbookStatus === "verified" && r.newDriverId === TB_B, JSON.stringify(r));
    check("guard same-state: Towbook PUT fired (guard did not block)", m.calls.some((c) => c.method === "PUT"), JSON.stringify(m.calls));
    const row2 = (await q`SELECT assigned_driver_towbook_id FROM dispatch_jobs WHERE id=${JOB2} AND org_id=${ORG}`)[0];
    check("guard same-state: dispatch_jobs updated to the new driver", String(row2.assigned_driver_towbook_id) === TB_B, JSON.stringify(row2));
  }
  {
    // (b) CROSS-STATE refused: the job is CT but the chosen driver's CURRENT
    // location reverse-geocodes to TX → invalid_state, ZERO Towbook calls
    // (no GET, no PUT), DB unchanged, no audit, no push.
    const m = makeReassignFetch({ callId: 279666666, oldDriverId: Number(TB_B), reverseStates: { "30.200,-97.700": "TX" } });
    const pushed = [];
    const r = await reassignDriverCore({
      jobId: JOB2, contractorId: DRIVER_C, orgId: ORG, actor: { id: USER, role: "owner" },
      opts: { fetchImpl: m.fetchImpl, pushImpl: async () => { pushed.push(1); } },
    });
    check("guard cross-state: refused invalid_state, reason names TX vs CT", !r.ok && r.code === "invalid_state" && String(r.message).includes("TX") && String(r.message).includes("CT"), JSON.stringify(r));
    check("guard cross-state: ZERO Towbook calls (no GET/PUT — assignment NOT changed)", !m.calls.some((c) => c.url.includes("/api/calls")), JSON.stringify(m.calls));
    check("guard cross-state: no push fired", pushed.length === 0, String(pushed.length));
    const row2 = (await q`SELECT assigned_driver_towbook_id, assigned_at FROM dispatch_jobs WHERE id=${JOB2} AND org_id=${ORG}`)[0];
    check("guard cross-state: dispatch_jobs unchanged (still the same-state driver)", String(row2.assigned_driver_towbook_id) === TB_B, JSON.stringify(row2));
    const aud2 = await q`SELECT count(*)::int n FROM audit_log WHERE org_id=${ORG} AND entity_id=${JOB2} AND action='reassign_driver'`;
    check("guard cross-state: no audit row written", Number(aud2[0].n) === 1, String(aud2[0].n)); // only the same-state reassign's row
  }
  {
    // (c) UNKNOWN JOB STATE refused: the job's address carries no resolvable
    // US state → fail closed BEFORE any driver check or Towbook call.
    const m = makeReassignFetch({ callId: 279555555, oldDriverId: Number(TB_A) });
    const r = await reassignDriverCore({
      jobId: JOB_UNKNOWN, contractorId: DRIVER_B, orgId: ORG, actor: { id: USER, role: "owner" },
      opts: { fetchImpl: m.fetchImpl },
    });
    check("guard unknown-job: refused invalid_state, reason names the state rule", !r.ok && r.code === "invalid_state" && String(r.message).includes("state could not be determined"), JSON.stringify(r));
    check("guard unknown-job: ZERO Towbook calls", m.calls.length === 0, JSON.stringify(m.calls));
  }
  {
    // (d) UNKNOWN DRIVER LOCATION refused: the chosen driver has no GPS fix
    // and no today anchor → their state cannot be verified → fail closed.
    const m = makeReassignFetch({ callId: 279666666, oldDriverId: Number(TB_B) });
    const r = await reassignDriverCore({
      jobId: JOB2, contractorId: DRIVER_D, orgId: ORG, actor: { id: USER, role: "owner" },
      opts: { fetchImpl: m.fetchImpl },
    });
    check("guard unknown-driver-loc: refused invalid_state, reason names the missing fresh app GPS fix", !r.ok && r.code === "invalid_state" && String(r.message).includes("no fresh app GPS fix"), JSON.stringify(r));
    check("guard unknown-driver-loc: ZERO Towbook calls", m.calls.length === 0, JSON.stringify(m.calls));
    const row2 = (await q`SELECT assigned_driver_towbook_id FROM dispatch_jobs WHERE id=${JOB2} AND org_id=${ORG}`)[0];
    check("guard unknown-driver-loc: dispatch_jobs unchanged", String(row2.assigned_driver_towbook_id) === TB_B, JSON.stringify(row2));
  }
  {
    // (e) UNKNOWN DRIVER STATE refused: the driver HAS a fix but the reverse
    // geocode cannot resolve a state → fail closed (mapped null → 404).
    const m = makeReassignFetch({ callId: 279666666, oldDriverId: Number(TB_B), reverseStates: { "30.200,-97.700": null } });
    const r = await reassignDriverCore({
      jobId: JOB2, contractorId: DRIVER_C, orgId: ORG, actor: { id: USER, role: "owner" },
      opts: { fetchImpl: m.fetchImpl },
    });
    check("guard unknown-driver-state: refused invalid_state, reason names state not verified", !r.ok && r.code === "invalid_state" && String(r.message).includes("state could not be verified"), JSON.stringify(r));
    check("guard unknown-driver-state: ZERO Towbook calls (evidence geocode only)", !m.calls.some((c) => c.url.includes("/api/calls")), JSON.stringify(m.calls));
  }

  /* ============ cleanup (assertQaOrg-guarded) ============ */
  for (const org of [ORG, ORG2]) { assertQaOrg(org); await q`DELETE FROM organizations WHERE id=${org}`; }
  await q`DELETE FROM users WHERE id IN (${USER}, ${DRIVER_A}, ${DRIVER_B}, ${DRIVER_C}, ${DRIVER_D})`;
  const failures = checks.filter(([, ok]) => !ok);
  console.log(`reassign-driver: ${checks.length - failures.length}/${checks.length} checks PASS`);
  if (failures.length) {
    for (const [name, , extra] of failures) console.error(`  FAIL ${name} ${extra}`);
    process.exit(1);
  }
  console.log("reassign-driver: ALL PASS — no leftovers (orgs deleted, users deleted)");
} catch (err) {
  console.error("reassign-driver suite error:", err);
  if (created) {
    try {
      for (const org of [ORG, ORG2]) { assertQaOrg(org); await q`DELETE FROM organizations WHERE id=${org}`; }
      await q`DELETE FROM users WHERE id IN (${USER}, ${DRIVER_A}, ${DRIVER_B}, ${DRIVER_C}, ${DRIVER_D})`;
    } catch { /* best-effort */ }
  }
  process.exit(1);
}
