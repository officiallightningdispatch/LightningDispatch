// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Towbook session self-healing (backlog #1, owner-directed 2026-08-11: "set up
// Towbook and forget"). Covers the 2026-08-11 13:10Z incident: a real
// motor-club offer arrived while the stored Towbook session had expired; the
// engine's dispatch push failed and the offer was lost (5×
// escalated_contractor_push_failed). The suite proves:
//   1. expired-session push → recovery → retry succeeds (decision NOT escalated,
//      audit row exists, the retried assign used the recovered session)
//   2. recovery fails (bad creds) → escalation preserved + throttle respected
//      (second attempt within 60s skipped, exactly one login)
//   3. no stored creds → today's behavior unchanged (escalation + alert, session
//      row untouched, zero login attempts)
//   4. in-flight guard (concurrent recover calls → one login)
//   5. sync-path expiry heals the session row (status connected, encrypted
//      session refreshed, towbook_driver_id preserved, driver-kind rows never
//      touched) — the REAL recovery (real .secrets creds) driven against a
//      full session row with globalThis.fetch stubbed for towbook.com only.
//      doSyncForOrg stays PRIVATE (exporting it would leak node:fs/node:url
//      into the client bundle — see tanstack-client-graph-leak), so the sync
//      trigger wiring is proven by scenario 1 (the real engine's
//      session-expired verification path) + this recovery-healing test + the
//      fixture suite's session_expired classification coverage.
//   6. cleanup verified zero leftovers
//
//   DATABASE_URL=... TOWBOOK_SESSION_KEY=... bun towbook-recovery.test.mjs
//
// Hermetic: Towbook HTTP is a mocked fetchImpl; the sync-path test stubs
// globalThis.fetch for towbook.com only (the DB client passes through to the
// real network). QA orgs qa-rx-<uuid> only; never touches the owner org.
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
// Test key for THIS process only (env-first resolution overrides the stable
// key). The QA session rows are encrypted with it; the running server is a
// separate process and never sees it.
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const { runAutoDispatch } = await import("./src/data/ai-dispatcher.ts");
const { recoverTowbookSession, readOwnerCreds, RECOVERY_THROTTLE_MS } = await import("./src/data/towbook-recovery.ts");
const { encryptSession, decryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ORG_PUSH = `qa-rx-push-${randomUUID()}`;
const ORG_BAD = `qa-rx-bad-${randomUUID()}`;
const ORG_NOCREDS = `qa-rx-nocreds-${randomUUID()}`;
const ORG_INFLIGHT = `qa-rx-inflight-${randomUUID()}`;
const ORG_SYNC = `qa-rx-sync-${randomUUID()}`;
const USER = `qa-rx-user-${randomUUID()}`;
let created = false;

/* ------------------------------ fixtures ------------------------------ */
const jsonResponse = (status, body, headers = null) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: headers ?? new Headers({ "content-type": "application/json" }),
  async text() { return JSON.stringify(body); },
  async json() { return body; },
});
/** The login page + auth-cookie responses the towbookLogin protocol expects:
 *  GET → 200 page carrying RequestVerificationToken + antiforgery cookie;
 *  POST success → auth cookie (.AspNetCore.Cookies) and a non-form body;
 *  POST failure → the login page re-rendered (invalid_credentials). */
const loginPage = (setCookies = [".AspNetCore.Antiforgery=tok; path=/; httponly"]) => {
  const h = new Headers();
  for (const c of setCookies) h.append("set-cookie", c);
  return {
    status: 200,
    ok: true,
    headers: h,
    async text() { return '<html><body><form method="post"><input name="Username" /><input name="Password" /><input name="RequestVerificationToken" value="tok123" /></form></body></html>'; },
    async json() { throw new Error("not json"); },
  };
};
/** Mocked Towbook login surface for recoverTowbookSession's injectable
 *  fetchImpl. Counts login POSTs so tests can assert exactly-one-login. */
function makeLoginFetch({ succeed = true, authCookie = "fresh-cookie" } = {}) {
  let posts = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (!u.includes("/Security/Login.aspx")) throw new Error(`login mock hit unexpected URL: ${u}`);
    const method = init.method || "GET";
    if (method === "GET") return loginPage();
    if (method === "POST") {
      posts++;
      if (!succeed) return loginPage(); // re-rendered login page → invalid_credentials
      return loginPage([`.AspNetCore.Cookies=${authCookie}; path=/; httponly`]);
    }
    throw new Error(`login mock unexpected method ${method}`);
  };
  return { fetchImpl, posts: () => posts };
}
const goodCreds = async () => ({ username: "qa-owner", password: "qa-password" });
const noCreds = async () => null;
/** The engine's real recovery wired with a mocked login — hermetic. */
const realRecoveryWith = (loginFetch, readCreds) => async (orgId) =>
  recoverTowbookSession(orgId, { fetchImpl: loginFetch.fetchImpl, readCreds });

/** Mocked Towbook dispatch surface for runAutoDispatch. The stored session
 *  cookie ("xtl=session-A") works for the feed/drivers/accept, then the
 *  session DIES right after the accept (the exact 2026-08-11 13:10Z shape:
 *  accept succeeded, the dispatch push hit the expired session). Only
 *  requests carrying the RECOVERED cookie ("fresh-cookie") succeed afterward,
 *  and a successful assign PUT (PUT /api/calls/{id} — the current path)
 *  actually puts the driver on the call. */
function makeEngineFetch({ offers, drivers }) {
  const calls = [];
  let sessionDead = false; // flips after the accept POST
  let call = { id: 279999999, status: { id: 2 }, assets: [{ id: 777001, driver: { id: 999999 } }] }; // chosen driver NOT on call (asset id present so the PUT assign can attach)
  const isFresh = (init) => String(init?.headers?.cookie || "").includes("fresh-cookie");
  const dead = (init) => !isFresh(init) && sessionDead;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ method, url: u, fresh: isFresh(init) });
    if (u.endsWith("/api/callRequests/") && method === "GET") {
      if (dead(init)) return jsonResponse(401, { error: "Invalid Security Token. Please re-authenticate" });
      return jsonResponse(200, offers ?? []);
    }
    if (u.includes("/api/nearestDrivers") && method === "GET") {
      if (dead(init)) return jsonResponse(401, { error: "Invalid Security Token" });
      return jsonResponse(200, drivers ?? []);
    }
    if (/\/api\/callRequests\/\d+\/accept$/.test(u) && method === "POST") {
      if (dead(init)) return jsonResponse(401, { error: "Invalid Security Token" });
      sessionDead = true; // the session expires immediately after the accept
      return jsonResponse(200, { callNumber: 25000 });
    }
    if (/\/api\/calls\/\d+$/.test(u) && method === "GET") {
      if (dead(init)) return jsonResponse(401, { error: "Invalid Security Token" });
      return jsonResponse(200, call);
    }
    if (u.includes("/api/calls?status=") && method === "GET") {
      if (dead(init)) return jsonResponse(401, { error: "Invalid Security Token" });
      return jsonResponse(200, [call]);
    }
    // The current assign path is PUT /api/calls/{id} (postAssignDriver — the
    // old POST /assignDrivers guess 404s live, proven 2026-08-12 on five
    // offers). Dead session → 401; recovered (fresh) session → apply the driver.
    if (/\/api\/calls\/\d+$/.test(u) && method === "PUT") {
      if (dead(init)) return jsonResponse(401, { error: "Invalid Security Token. Please re-authenticate" });
      const body = JSON.parse(init.body);
      const assetId = Array.isArray(body.assets) && body.assets[0] ? body.assets[0].id : 777001;
      const driverId = body.assets?.[0]?.drivers?.[0]?.driver?.id;
      call = { ...call, assets: [{ id: assetId, driver: { id: driverId } }] };
      return jsonResponse(200, { ok: true });
    }
    throw new Error(`engine mock hit unexpected URL: ${method} ${u}`);
  };
  return { fetchImpl, calls };
}
const offer = (id) => ({
  callRequestId: id,
  masterAccountId: 29,
  accountId: 894873,
  accountName: "Agero (Swoop) Bridgeport",
  companyId: 23257,
  status: 0,
  expirationDateUtc: new Date(Date.now() + 10 * 60000).toISOString(),
  defaultEta: 30,
  purchaseOrderNumber: `1125${id}`,
  sound: false,
  startLocationLatitude: 41.2,
  startLocationLongitude: -73.2,
  drivers: [703785],
  availableActions: ["NearestDrivers", "REQUEST_CALL", "ACKNOWLEDGE"],
});
const driver = (id, name) => ({
  driverId: id, driverName: name, truckId: 0, latitude: 41.18, longitude: -73.15,
  estimatedDistanceMiles: 5, estimatedTimeSeconds: 604, isCheckedIn: true, calls: [],
});
const makeDeps = (fetchImpl, recoverSession) => ({
  syncForOrg: async () => ({ ok: true }),
  resolveOrgActor: async () => ({ id: USER, role: "owner" }),
  fetchImpl,
  verifyRetryDelayMs: 0,
  routerOverride: { provider: "osrm", tomtomKeyConfigured: false, router: async () => ({ seconds: 540, provider: "osrm", liveTraffic: false, trafficDelaySeconds: null, notes: "mock" }) },
  recoverSession,
});
const ownerSessionRow = (cookie) => encryptSession(JSON.stringify({ cookies: cookie, baseUrl: "https://app.towbook.com" }));

try {
  await ensureSchema();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG_PUSH}, 'qa rx push'), (${ORG_BAD}, 'qa rx bad'), (${ORG_NOCREDS}, 'qa rx nocreds'), (${ORG_INFLIGHT}, 'qa rx inflight'), (${ORG_SYNC}, 'qa rx sync')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${USER}, 'QA Recovery Owner', ${`rx-${randomUUID()}@qa.local`}, 'x')`;
  for (const org of [ORG_PUSH, ORG_BAD, ORG_NOCREDS, ORG_INFLIGHT, ORG_SYNC]) {
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${USER}, 'owner')`;
  }
  // Connected owner session rows (status='error' until the moment each test
  // needs them, so the running server's 3s background loop can never pick a
  // QA org up mid-suite; flipped to 'connected' right before each operation).
  const encPush = await ownerSessionRow("xtl=session-A");
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind) VALUES(${ORG_PUSH}, ${encPush}, 'error', 'owner'), (${ORG_BAD}, ${encPush}, 'error', 'owner'), (${ORG_NOCREDS}, ${encPush}, 'error', 'owner'), (${ORG_INFLIGHT}, ${await ownerSessionRow("xtl=whatever")}, 'error', 'owner')`;
  // ORG_SYNC: an OLD (pre-expiry) connected session + the owner-driver link
  // that recovery must PRESERVE + a driver-kind row that recovery must never
  // touch.
  const encSyncOld = await ownerSessionRow("xtl=dead-sync-cookie");
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id) VALUES(${ORG_SYNC}, ${encSyncOld}, 'error', 'owner', '910008')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id) VALUES(${ORG_SYNC}, 'driver-kind-encrypted', 'connected', 'driver', 'd-1')`;
  created = true;

  /* ============ 1) expired-session PUSH → recovery → retry succeeds ============ */
  {
    await q`UPDATE towbook_sessions SET status='connected' WHERE org_id=${ORG_PUSH} AND session_kind='owner'`;
    const m = makeEngineFetch({ offers: [offer(5001)], drivers: [driver(703785, "Jayden Fountain")] });
    const login = makeLoginFetch({ succeed: true, authCookie: "fresh-cookie" });
    const r = await runAutoDispatch(ORG_PUSH, makeDeps(m.fetchImpl, realRecoveryWith(login, goodCreds)));
    check("push-heal: offer processed, NOT escalated (auto_accept_with_driver)", r.processed === 1 && r.decisions[0]?.decision === "auto_accept_with_driver" && r.decisions[0]?.escalated === false, JSON.stringify(r.decisions));
    check("push-heal: exactly ONE recovery login", login.posts() === 1, `posts=${login.posts()}`);
    check("push-heal: the retried assign push (PUT /api/calls/{id}) used the RECOVERED session", m.calls.some((c) => c.method === "PUT" && c.url.includes("/api/calls/279999999") && c.fresh), JSON.stringify(m.calls.filter((c) => c.method === "PUT" && c.url.includes("/api/calls/279999999"))));
    const rows = await q`SELECT decision, escalated, reason FROM ai_dispatcher_decisions WHERE org_id=${ORG_PUSH} AND call_request_id='5001'`;
    check("push-heal: decision row present, not escalated, reason records the recovery", rows.length === 1 && String(rows[0].decision) === "auto_accept_with_driver" && rows[0].escalated === false && String(rows[0].reason).includes("session recovered; dispatch push retried"), JSON.stringify(rows[0]));
    const audit = await q`SELECT detail FROM audit_log WHERE org_id=${ORG_PUSH} AND action='towbook_session_recovered'`;
    check("push-heal: audit row towbook_session_recovered with recovered:true", audit.length === 1 && audit[0].detail?.recovered === true, JSON.stringify(audit));
    const sess = await q`SELECT encrypted_session FROM towbook_sessions WHERE org_id=${ORG_PUSH} AND session_kind='owner'`;
    check("push-heal: session row now holds the recovered cookie", sess.length === 1 && JSON.parse(await decryptSession(String(sess[0].encrypted_session))).cookies.includes("fresh-cookie"), "");
  }

  /* ============ 2) recovery fails (bad creds) → escalation preserved + throttle ============ */
  {
    await q`UPDATE towbook_sessions SET status='connected' WHERE org_id=${ORG_BAD} AND session_kind='owner'`;
    const m = makeEngineFetch({ offers: [offer(5002)], drivers: [driver(703785, "Jayden Fountain")] });
    const login = makeLoginFetch({ succeed: false }); // bad credentials → login page re-rendered
    const r = await runAutoDispatch(ORG_BAD, makeDeps(m.fetchImpl, realRecoveryWith(login, goodCreds)));
    check("bad-creds: escalation preserved (escalated_dispatch_failed, escalated=true)", r.decisions[0]?.decision === "escalated_dispatch_failed" && r.decisions[0]?.escalated === true, JSON.stringify(r.decisions));
    const rows = await q`SELECT decision, escalated, reason FROM ai_dispatcher_decisions WHERE org_id=${ORG_BAD} AND call_request_id='5002'`;
    check("bad-creds: reason records the classified recovery failure", rows.length === 1 && rows[0].escalated === true && String(rows[0].reason).includes("session recovery failed (login_failed:invalid_credentials)"), String(rows[0]?.reason));
    check("bad-creds: exactly ONE login attempt (no hammering)", login.posts() === 1, `posts=${login.posts()}`);
    const second = await recoverTowbookSession(ORG_BAD, { fetchImpl: login.fetchImpl, readCreds: goodCreds });
    check("bad-creds: throttle — second attempt within 60s is SKIPPED", second.recovered === false && second.reason === "throttled" && second.throttled === true, JSON.stringify(second));
    check("bad-creds: throttle — still exactly ONE login after the skipped attempt", login.posts() === 1, `posts=${login.posts()}`);
    check("bad-creds: throttle window is 60s", RECOVERY_THROTTLE_MS === 60_000, String(RECOVERY_THROTTLE_MS));
  }

  /* ============ 3) no stored creds → today's behavior unchanged ============ */
  {
    await q`UPDATE towbook_sessions SET status='connected' WHERE org_id=${ORG_NOCREDS} AND session_kind='owner'`;
    const before = await q`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${ORG_NOCREDS} AND session_kind='owner'`;
    const m = makeEngineFetch({ offers: [offer(5003)], drivers: [driver(703785, "Jayden Fountain")] });
    const login = makeLoginFetch({ succeed: true });
    const r = await runAutoDispatch(ORG_NOCREDS, makeDeps(m.fetchImpl, realRecoveryWith(login, noCreds)));
    check("no-creds: today's behavior unchanged — escalation + alert preserved", r.decisions[0]?.decision === "escalated_dispatch_failed" && r.decisions[0]?.escalated === true, JSON.stringify(r.decisions));
    const rows = await q`SELECT reason FROM ai_dispatcher_decisions WHERE org_id=${ORG_NOCREDS} AND call_request_id='5003'`;
    check("no-creds: reason names the missing creds (no silent drop)", rows.length === 1 && String(rows[0].reason).includes("session recovery failed (no_stored_owner_creds)"), String(rows[0]?.reason));
    check("no-creds: zero login attempts", login.posts() === 0, `posts=${login.posts()}`);
    const after = await q`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${ORG_NOCREDS} AND session_kind='owner'`;
    check("no-creds: session row untouched", before.length === 1 && after.length === 1 && String(before[0].encrypted_session) === String(after[0].encrypted_session) && String(before[0].status) === String(after[0].status), "");
  }

  /* ============ 4) in-flight guard: concurrent recover calls → ONE login ============ */
  {
    const login = makeLoginFetch({ succeed: true, authCookie: "fresh-cookie" });
    const [r1, r2] = await Promise.all([
      recoverTowbookSession(ORG_INFLIGHT, { fetchImpl: login.fetchImpl, readCreds: goodCreds }),
      recoverTowbookSession(ORG_INFLIGHT, { fetchImpl: login.fetchImpl, readCreds: goodCreds }),
    ]);
    check("in-flight: both concurrent calls succeed", r1.recovered === true && r2.recovered === true, JSON.stringify([r1, r2]));
    check("in-flight: exactly ONE login for two concurrent recoveries", login.posts() === 1, `posts=${login.posts()}`);
  }

  /* ============ 5) sync-path expiry heals the session row ============ */
  {
    // doSyncForOrg (the sync-path trigger) is private for client-graph safety;
    // the healing it invokes IS recoverTowbookSession — drive the REAL recovery
    // against a full session row with the REAL stored creds, the same way the
    // tick's session_expired branch does. globalThis.fetch is stubbed for
    // towbook.com only (302 → login → auth cookie); the DB client passes
    // through to the real network.
    await q`UPDATE towbook_sessions SET status='connected' WHERE org_id=${ORG_SYNC} AND session_kind='owner'`;
    const realFetch = globalThis.fetch;
    const login = makeLoginFetch({ succeed: true, authCookie: "fresh-cookie" });
    const stub = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("app.towbook.com")) {
        if (u.includes("/Security/Login.aspx")) return login.fetchImpl(url, init);
        if (u.includes("/Security/Login")) return loginPage();
        return { status: 302, ok: false, headers: new Headers({ location: "/Security/Login?ReturnUrl=/" }), async text() { return ""; }, async json() { throw new Error("not json"); } };
      }
      return realFetch(url, init);
    };
    globalThis.fetch = stub;
    let recovery;
    try {
      recovery = await recoverTowbookSession(ORG_SYNC); // no opts → REAL .secrets creds
    } finally {
      globalThis.fetch = realFetch; // always restore — the suite must never leak the stub
    }
    check("sync-path: recovery succeeded with the REAL stored creds", recovery.recovered === true, JSON.stringify(recovery));
    check("sync-path: recovery login happened once", login.posts() === 1, `posts=${login.posts()}`);
    const sess = await q`SELECT encrypted_session, status, towbook_driver_id FROM towbook_sessions WHERE org_id=${ORG_SYNC} AND session_kind='owner'`;
    check("sync-path: session row healed — status connected", sess.length === 1 && String(sess[0].status) === "connected", JSON.stringify(sess[0]));
    check("sync-path: encrypted_session REFRESHED (old cookie gone, fresh cookie stored)", sess.length === 1 && !JSON.parse(await decryptSession(String(sess[0].encrypted_session))).cookies.includes("dead-sync-cookie") && JSON.parse(await decryptSession(String(sess[0].encrypted_session))).cookies.includes("fresh-cookie"), "");
    check("sync-path: towbook_driver_id PRESERVED across recovery", sess.length === 1 && String(sess[0].towbook_driver_id) === "910008", String(sess[0]?.towbook_driver_id));
    const drv = await q`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${ORG_SYNC} AND session_kind='driver'`;
    check("sync-path: driver-kind session row NEVER touched", drv.length === 1 && String(drv[0].encrypted_session) === "driver-kind-encrypted" && String(drv[0].status) === "connected", JSON.stringify(drv));
    const audit = await q`SELECT detail FROM audit_log WHERE org_id=${ORG_SYNC} AND action='towbook_session_recovered'`;
    check("sync-path: audit row towbook_session_recovered with recovered:true", audit.length === 1 && audit[0].detail?.recovered === true, JSON.stringify(audit));
    // The real creds files exist on this host (owner-stored, live-verified) —
    // readOwnerCreds() must have resolved them; prove the resolution worked by
    // checking the file-backed resolver agrees the files exist.
    const realCreds = await readOwnerCreds();
    check("sync-path: stored owner creds resolved by the real path", realCreds !== null && typeof realCreds.username === "string" && realCreds.username.length > 0 && typeof realCreds.password === "string" && realCreds.password.length > 0, JSON.stringify({ username: realCreds?.username, hasPassword: Boolean(realCreds?.password) }));
  }

  console.log("\nALL TOWBOOK-RECOVERY CHECKS PASSED");
  for (const [name, ok, extra] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
} finally {
  // ---- cleanup: QA orgs cascade decisions/settings/jobs/events/audit/session/membership
  if (created) {
    for (const org of [ORG_PUSH, ORG_BAD, ORG_NOCREDS, ORG_INFLIGHT, ORG_SYNC]) {
      assertQaOrg(org);
      await q`DELETE FROM organizations WHERE id=${org}`.catch(() => {});
    }
    await q`DELETE FROM users WHERE id=${USER}`.catch(() => {});
  }
  const leftover = await q`SELECT
    (SELECT count(*) FROM ai_dispatcher_decisions WHERE org_id=${ORG_PUSH}) AS ad,
    (SELECT count(*) FROM org_settings WHERE org_id=${ORG_PUSH}) AS os,
    (SELECT count(*) FROM dispatch_jobs WHERE org_id=${ORG_PUSH}) AS jobs,
    (SELECT count(*) FROM status_events WHERE org_id=${ORG_PUSH}) AS ev,
    (SELECT count(*) FROM audit_log WHERE org_id=${ORG_PUSH}) AS audit,
    (SELECT count(*) FROM towbook_sessions WHERE org_id=${ORG_PUSH}) AS sess,
    (SELECT count(*) FROM organization_memberships WHERE org_id=${ORG_PUSH}) AS members,
    (SELECT count(*) FROM ai_dispatcher_runs WHERE org_id=${ORG_PUSH}) AS runs,
    (SELECT count(*) FROM audit_log WHERE org_id=${ORG_BAD}) AS audit_bad,
    (SELECT count(*) FROM towbook_sessions WHERE org_id=${ORG_BAD}) AS sess_bad,
    (SELECT count(*) FROM towbook_sessions WHERE org_id=${ORG_SYNC}) AS sess_sync,
    (SELECT count(*) FROM audit_log WHERE org_id=${ORG_SYNC}) AS audit_sync,
    (SELECT count(*) FROM users WHERE id=${USER}) AS users`;
  const l = leftover[0];
  console.log(`\ncleanup: ad=${l.ad} settings=${l.os} jobs=${l.jobs} events=${l.ev} audit=${l.audit} sessions=${l.sess} members=${l.members} runs=${l.runs} auditBad=${l.audit_bad} sessBad=${l.sess_bad} sessSync=${l.sess_sync} auditSync=${l.audit_sync} users=${l.users}`);
  const allZero = Object.values(l).every((v) => Number(v) === 0);
  if (!allZero) {
    console.error("WARNING: QA rows remain!");
    process.exitCode = 1;
  }
}
