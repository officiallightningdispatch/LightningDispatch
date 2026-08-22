// Hermetic tests for the owner-in-driver-view session (view toggle, spec TEST
// items 3 + 5 + 8): a shape-b linked owner drives the REAL contractor flow
// through the EFFECTIVE driver identity:
//   - jobs list (driverJobs → GET /api/calls via the LINKED driver's session)
//   - accept thumbs-up + en-route (driverJobAction → PUT via the linked
//     driver's session; dispatch_jobs write-through mirrors to the owner board)
//   - availability GO/Offline (driverSetAvailability → checkin/checkout via the
//     linked driver's session + towbook user id + last-known position)
//   - earnings + profile (driverEarnings/driverProfile resolve the effective
//     driver row)
//   - logout (driverLogout performs Towbook CHECKOUT for the EFFECTIVE driver,
//     then clears the LD session)
//   - Q4 audit attribution (owner-confirmed 2026-08-12): status_events written
//     under the REAL session actor (owner user id) with the note suffix
//     "(owner in driver view)".
// The raw-TS createServerFn wrappers run hermetically via the client middleware
// path: the handler executes with FULL side effects but the return value is
// dropped (serverFn undefined in bun) — so every assertion is side-effect-based:
// mock globalThis.fetch passthrough (towbook.test → canned, else real fetch),
// record the Cookie header on /api/calls (must be the linked driver's
// xtl=fake-… session), assert DB rows (status_events / audit_log /
// dispatch_jobs / sessions).
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun driver-effective-session.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
await import("@tanstack/start-server-core");
const { H3Event } = await import("h3-v2");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const {
  driverJobs, driverJobAction, driverSetAvailability, driverEarnings, driverProfile, driverLogout,
} = await import("./src/data/driver-auth.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ORG = `qa effective-session ${randomUUID()}`;
const PREFIX = "qa-effective-session";
const tbId = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 1_000_000_000n);
const uid = (tag) => `qa-${PREFIX}-${tag}-${randomUUID()}`;
const OWNER = uid("owner");      // owner, shape-b linked to DRIVER
const DRIVER = uid("drv");       // contractor (the linked driver identity)
const OTHER = uid("oth");        // contractor (other driver, queue-scope check)
const PURE = uid("pure");        // owner with NO driver identity
const T_DRIVER = tbId(uid("td"));
const T_OTHER = tbId(uid("to"));
const TB_USER_DRIVER = `tb-user-${tbId(uid("tu"))}`;
const email = (u) => `${u}@lightning.test`;

/* ------------------------------ fixture ------------------------------ */
await ensureSchema();
// sweep any leftovers from earlier crashed runs (QA-prefixed only)
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa effective-session%'`) {
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
await q`DELETE FROM users WHERE email LIKE 'qa-effective-session-%@lightning.test'`.catch(() => {});
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
const ins = (id, name) => q`INSERT INTO users(id, name, email, password_hash) VALUES(${id}, ${name}, ${email(id)}, 'x')`;
await ins(OWNER, "Effective Owner");
await ins(DRIVER, "Linked Driver");
await ins(OTHER, "Other Driver");
await ins(PURE, "Pure Owner");
await q`UPDATE users SET towbook_driver_id=${T_DRIVER}, towbook_user_id=${TB_USER_DRIVER} WHERE id=${DRIVER}`;
await q`UPDATE users SET towbook_driver_id=${T_OTHER} WHERE id=${OTHER}`;
await q`UPDATE users SET linked_driver_user_id=${DRIVER} WHERE id=${OWNER}`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'),
  (${ORG}, ${DRIVER}, 'contractor'),
  (${ORG}, ${OTHER}, 'contractor'),
  (${ORG}, ${PURE}, 'owner')`;
// The linked driver's stored Towbook session (session_kind='driver') — the ONLY
// session an owner-in-driver-view can act through.
await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id, error, updated_at)
  VALUES(${ORG}, ${await encryptSession(JSON.stringify({ cookies: `xtl=fake-session-${T_DRIVER}`, baseUrl: "https://towbook.test" }))}, 'connected', 'driver', ${T_DRIVER}, NULL, NOW())`;
// LD sessions (owner + pure owner sign in once; the linked driver already did).
const OWNER_TOKEN = `sess-${randomUUID()}`;
const PURE_TOKEN = `sess-${randomUUID()}`;
await q`INSERT INTO sessions(id, user_id, expires_at) VALUES
  (${OWNER_TOKEN}, ${OWNER}, NOW() + INTERVAL '1 day'),
  (${PURE_TOKEN}, ${PURE}, NOW() + INTERVAL '1 day')`;
// The linked driver's last known position (availability GO uses it for checkin).
await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, job_id, latitude, longitude, accuracy)
  VALUES(gen_random_uuid()::text, ${ORG}, ${DRIVER}, ${T_DRIVER}, NULL, 41.2, -73.2, NULL)`;
// The on-platform job (offered, assigned to the linked driver) — the accept
// write-through updates THIS row, mirroring to the owner board (spec Q3).
await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, customer_phone, vehicle_desc, pickup, dropoff, towbook_status, raw_json, pickup_lat, pickup_lng, assigned_driver_towbook_id, assigned_driver_name)
  VALUES('job-900001', ${ORG}, 'Jane Q Public', '', 0, 0, 'Bridgeport', 'jump_start', 'offered', NOW(), '', '900001', '', '2020 Honda Civic', '100 Main St', '', '1', '{}'::jsonb, 41.2, -73.2, ${T_DRIVER}, 'Linked Driver')`;
// Tip rows (earnings read path — scoped by tip->>'driver_towbook_id').
await q`INSERT INTO job_completions(org_id, job_id, tip) VALUES
  (${ORG}, 'job-900001', ${JSON.stringify({ driver_towbook_id: T_DRIVER, amount_cents: 500, currency: "USD", status: "paid" })}::jsonb),
  (${ORG}, 'job-999002', ${JSON.stringify({ driver_towbook_id: T_OTHER, amount_cents: 700, currency: "USD", status: "paid" })}::jsonb)`;

/* ------------------- seeded request context (server-runtime parity) ------------------- */
const eventStorage = globalThis[Symbol.for("tanstack-start:event-storage")];
const startStorage = globalThis[Symbol.for("tanstack-start:start-storage-context")];
const withSession = (token, fn) => {
  const cookie = `ld_session_v2=${token}`;
  const h3Event = new H3Event(new Request("http://localhost/", { headers: { cookie } }));
  const req = new Request("http://localhost/", { headers: { cookie } });
  return startStorage.run(
    { startOptions: {}, request: req, contextAfterGlobalMiddlewares: null, executedRequestMiddlewares: new Set() },
    () => eventStorage.run({ h3Event }, fn),
  );
};

/* ------------------- Towbook fetch mock (passthrough + canned) ------------------- */
const tbCalls = []; // {url, method, cookie, body}
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const jobsState = { 900001: 1, 900002: 1 }; // Towbook-side status ids (mutated by PUTs)
const rawCall = (id, driverId) => ({
  id,
  callNumber: `C-${id}`,
  createDate: "2026-08-12T12:00:00Z",
  status: { id: jobsState[id] },
  reason: { name: "Jump Start" },
  waypoints: [{ address: id === 900001 ? "100 Main St" : "200 Elm St", zip: "06606", latitude: 41.2, longitude: -73.2 }],
  contacts: [{ name: id === 900001 ? "Jane Q Public" : "Bob Smith", phone: "555-0100" }],
  assets: [{ year: 2020, make: "Honda", model: "Civic", color: { name: "Silver" }, vin: `VIN${id}`, driver: { id: Number(driverId), name: "Driver" } }],
  arrivalETA: "2026-08-12T12:30:00Z",
});
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const method = String(init?.method ?? "GET").toUpperCase();
  const cookie = String((init?.headers && init.headers.cookie) ?? "");
  if (u.startsWith("https://towbook.test/")) {
    tbCalls.push({ url: u, method, cookie, body: init?.body ?? null });
    if (method === "GET" && /\/api\/calls$/.test(u)) return json([rawCall(900001, T_DRIVER), rawCall(900002, T_OTHER)]);
    const m = u.match(/\/api\/calls\/(\d+)$/);
    if (m && (method === "GET" || method === "PUT")) {
      const id = Number(m[1]);
      if (method === "PUT") {
        try {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const next = body?.status?.id;
          if (Number.isFinite(Number(next))) jobsState[id] = Number(next);
        } catch { /* keep current state */ }
      }
      return json(rawCall(id, T_DRIVER));
    }
    if (method === "POST" && u.endsWith("/api/user/checkin")) return json({ ok: true });
    if (method === "POST" && u.endsWith("/api/user/checkout")) return json({});
    return json({});
  }
  return realFetch(url, init);
};
const callsTo = (path) => tbCalls.filter((c) => c.url.includes(path));
const callsOn = (path, method) => tbCalls.filter((c) => c.url.includes(path) && c.method === method);

/* ------------------------- 1) jobs list through the effective driver ------------------------- */
{
  const before = tbCalls.length;
  await withSession(OWNER_TOKEN, () => driverJobs());
  const hits = callsOn("/api/calls", "GET").filter((c) => !/\/api\/calls\/\d+$/.test(c.url));
  check("queue: owner-in-driver-view driverJobs fetches /api/calls via the LINKED driver's session",
    tbCalls.length > before && hits.some((c) => c.cookie === `xtl=fake-session-${T_DRIVER}`), JSON.stringify(hits));
  const before2 = tbCalls.length;
  await withSession(PURE_TOKEN, () => driverJobs());
  check("queue: pure owner (no driver identity) refused with NO Towbook call",
    tbCalls.length === before2, JSON.stringify(tbCalls.slice(before2)));
  const before3 = tbCalls.length;
  await withSession("sess-does-not-exist", () => driverJobs());
  check("queue: signed-out token refused with NO Towbook call",
    tbCalls.length === before3, JSON.stringify(tbCalls.slice(before3)));
}
/* ------------------------- 2) accept thumbs-up (spec Q3 + Q4) ------------------------- */
{
  await withSession(OWNER_TOKEN, () => driverJobAction({ data: { jobId: "900001", action: "accept" } }));
  const get = callsOn("/api/calls/900001", "GET");
  const put = callsOn("/api/calls/900001", "PUT");
  check("accept: GET + PUT /api/calls/900001 via the LINKED driver's session (cookie)",
    get.some((c) => c.cookie === `xtl=fake-session-${T_DRIVER}`) && put.some((c) => c.cookie === `xtl=fake-session-${T_DRIVER}`), JSON.stringify(put));
  check("accept: PUT body = {id, status:{id:2}} (thumbs-up)",
    put.some((c) => c.body && String(c.body).includes('"id":2') && String(c.body).includes('"status"')), JSON.stringify(put));
  const row = await q`SELECT status, towbook_status FROM dispatch_jobs WHERE id='job-900001' AND org_id=${ORG}`;
  check("accept: dispatch_jobs row flips offered→en_route — accept&go in ONE step (owner board mirror, spec Q3)",
    row.length === 1 && row[0].status === "en_route" && String(row[0].towbook_status) === "2", JSON.stringify(row));
  const ev = await q`SELECT from_status, to_status, actor_user_id, actor_role, note FROM status_events WHERE org_id=${ORG} AND job_id='job-900001' ORDER BY occurred_at ASC`;
  const acceptEv = ev.find((e) => e.to_status === "en_route");
  check("accept: status_events under the REAL session actor (owner id, role owner) with '(owner in driver view)' note",
    Boolean(acceptEv) && acceptEv.from_status === "offered" && acceptEv.actor_user_id === OWNER && acceptEv.actor_role === "owner" &&
    String(acceptEv.note).includes("driver accepted (Lightning Dispatch)") && String(acceptEv.note).includes("(owner in driver view)"),
    JSON.stringify(acceptEv));
  const audit = await q`SELECT actor_user_id, actor_role, action, detail FROM audit_log WHERE org_id=${ORG} AND entity_id='job-900001' AND action='driver_status_change'`;
  check("accept: audit_log driver_status_change under the owner id",
    audit.some((a) => a.actor_user_id === OWNER && a.actor_role === "owner" && a.detail?.to === "en_route"), JSON.stringify(audit));
}
/* ------------------------- 3) en-route re-tap is a NO-OP (accept&go) ------------------------- */
{
  const putBefore = tbCalls.filter((c) => c.method === "PUT").length;
  const evBefore = await q`SELECT COUNT(*)::int AS n FROM status_events WHERE org_id=${ORG} AND job_id='job-900001'`;
  const auditBefore = await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND entity_id='job-900001' AND action='driver_status_change'`;
  const res = await withSession(OWNER_TOKEN, () => driverJobAction({ data: { jobId: "900001", action: "en_route" } })).catch(() => null);
  const putAfter = tbCalls.filter((c) => c.method === "PUT").length;
  const evAfter = await q`SELECT COUNT(*)::int AS n FROM status_events WHERE org_id=${ORG} AND job_id='job-900001'`;
  const auditAfter = await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND entity_id='job-900001' AND action='driver_status_change'`;
  check("en-route re-tap: accept&go already at en_route → no-op (no new PUT, no double event/audit)",
    putAfter === putBefore && evAfter[0].n === evBefore[0].n && auditAfter[0].n === auditBefore[0].n,
    JSON.stringify({ res, putDelta: putAfter - putBefore, evBefore: evBefore[0].n, evAfter: evAfter[0].n }));
}
/* ------------------------- 3b) manual arrive (SUB A, Towbook status 3) ------------------------- */
{
  const putsBefore = tbCalls.filter((c) => c.method === "PUT" && /\/api\/calls\/900001$/.test(c.url)).length;
  await withSession(OWNER_TOKEN, () => driverJobAction({ data: { jobId: "900001", action: "arrive" } }));
  const arrivePuts = tbCalls.filter((c) => c.method === "PUT" && /\/api\/calls\/900001$/.test(c.url));
  const lastArrive = arrivePuts[arrivePuts.length - 1];
  check("arrive: exactly one new PUT to /api/calls/900001 with status {id:3} (On Scene)",
    arrivePuts.length === putsBefore + 1 && lastArrive && JSON.parse(String(lastArrive.body ?? "{}")).status?.id === 3,
    JSON.stringify(arrivePuts));
  const row = await q`SELECT status, arrived_at, towbook_status FROM dispatch_jobs WHERE id='job-900001' AND org_id=${ORG}`;
  check("arrive: LD dispatch_jobs status='arrived' + arrived_at set + towbook_status 3",
    row.length === 1 && row[0].status === "arrived" && row[0].arrived_at != null && String(row[0].towbook_status) === "3",
    JSON.stringify(row));
  const ev = await q`SELECT from_status, to_status, actor_user_id, actor_role FROM status_events WHERE org_id=${ORG} AND job_id='job-900001' AND to_status='arrived' ORDER BY occurred_at DESC LIMIT 1`;
  check("arrive: status_events en_route→arrived under the real session actor",
    ev.length === 1 && String(ev[0].from_status) === "en_route" && String(ev[0].to_status) === "arrived" && ev[0].actor_user_id === OWNER && ev[0].actor_role === "owner",
    JSON.stringify(ev));
  // Idempotent re-tap → no-op (never a double PUT, no double event/audit).
  const putAfter = tbCalls.filter((c) => c.method === "PUT").length;
  const evCount = await q`SELECT COUNT(*)::int AS n FROM status_events WHERE org_id=${ORG} AND job_id='job-900001'`;
  const auditCount = await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND entity_id='job-900001' AND action='driver_status_change'`;
  await withSession(OWNER_TOKEN, () => driverJobAction({ data: { jobId: "900001", action: "arrive" } }));
  const putAfter2 = tbCalls.filter((c) => c.method === "PUT").length;
  const evCount2 = await q`SELECT COUNT(*)::int AS n FROM status_events WHERE org_id=${ORG} AND job_id='job-900001'`;
  const auditCount2 = await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND entity_id='job-900001' AND action='driver_status_change'`;
  check("arrive: re-tap is a no-op (no new PUT, no double event/audit)",
    putAfter2 === putAfter && evCount2[0].n === evCount[0].n && auditCount2[0].n === auditCount[0].n,
    JSON.stringify({ putDelta: putAfter2 - putAfter, evBefore: evCount[0].n, evAfter: evCount2[0].n }));
}

/* ------------------------- 4) availability GO/Offline ------------------------- */
{
  const before = tbCalls.length;
  await withSession(OWNER_TOKEN, () => driverSetAvailability({ data: { online: true } }));
  const checkin = callsOn("/api/user/checkin", "POST").filter((c) => c.url.startsWith("https://towbook.test"));
  const ch = checkin.length ? JSON.parse(String(checkin[checkin.length - 1].body ?? "{}")) : null;
  check("availability GO: checkin POST via the LINKED driver's session (cookie + towbook user id + last-known position)",
    checkin.some((c) => c.cookie === `xtl=fake-session-${T_DRIVER}`) && ch !== null && ch.id === TB_USER_DRIVER && ch.latitude === 41.2 && ch.longitude === -73.2,
    JSON.stringify({ checkin, ch }));
  const before2 = tbCalls.length;
  await withSession(OWNER_TOKEN, () => driverSetAvailability({ data: { online: false } }));
  const checkout = callsOn("/api/user/checkout", "POST").filter((c) => c.url.startsWith("https://towbook.test"));
  check("availability Offline: checkout POST via the LINKED driver's session",
    tbCalls.length > before2 && checkout.some((c) => c.cookie === `xtl=fake-session-${T_DRIVER}`), JSON.stringify(checkout));
}
/* ------------------------- 5) earnings + profile resolve the effective driver ------------------------- */
{
  const before = tbCalls.length;
  await withSession(OWNER_TOKEN, () => driverEarnings());
  const hits = callsTo("/api/calls").filter((c) => !/\/api\/calls\/\d+$/.test(c.url));
  check("earnings: resolves the effective driver (queue fetch via the LINKED driver's session, not the owner row)",
    tbCalls.length > before && hits.some((c) => c.cookie === `xtl=fake-session-${T_DRIVER}`), JSON.stringify(hits));
  let threw = false;
  try { await withSession(OWNER_TOKEN, () => driverProfile()); } catch { threw = true; }
  check("profile: resolves the effective driver without error", threw === false);
}
/* ------------------------- 6) logout checks out the EFFECTIVE driver ------------------------- */
{
  let threw = false;
  try { await withSession(OWNER_TOKEN, () => driverLogout()); } catch { threw = true; } // cookie-clear may throw outside a real response — side effects already done
  const checkout = callsOn("/api/user/checkout", "POST").filter((c) => c.url.startsWith("https://towbook.test"));
  const body = checkout.length ? JSON.parse(String(checkout[checkout.length - 1].body ?? "{}")) : null;
  check("logout: Towbook checkout for the EFFECTIVE driver (linked session cookie + the driver's towbook user id)",
    checkout.some((c) => c.cookie === `xtl=fake-session-${T_DRIVER}`) && body !== null && body.id === TB_USER_DRIVER, JSON.stringify({ checkout, body }));
  const sess = await q`SELECT 1 FROM sessions WHERE id=${OWNER_TOKEN}`;
  check("logout: LD session for the owner fully cleared", sess.length === 0);
  check("logout: no unhandled error from the LD session clear", threw === false);
}
/* ------------------------------- summary + cleanup ------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-effective-session.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa effective-session%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa effective-session%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-effective-session-%@lightning.test'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa effective-session%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-effective-session-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email LIKE 'qa-effective-session-%@lightning.test') AS sessions,
  (SELECT COUNT(*)::int FROM status_events e JOIN organizations o ON o.id=e.org_id WHERE o.name LIKE 'qa effective-session%') AS events,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa effective-session%') AS audit,
  (SELECT COUNT(*)::int FROM dispatch_jobs j JOIN organizations o ON o.id=j.org_id WHERE o.name LIKE 'qa effective-session%') AS jobs,
  (SELECT COUNT(*)::int FROM towbook_sessions s JOIN organizations o ON o.id=s.org_id WHERE o.name LIKE 'qa effective-session%') AS tb_sessions,
  (SELECT COUNT(*)::int FROM driver_locations dl JOIN organizations o ON o.id=dl.org_id WHERE o.name LIKE 'qa effective-session%') AS locs,
  (SELECT COUNT(*)::int FROM job_completions jc JOIN organizations o ON o.id=jc.org_id WHERE o.name LIKE 'qa effective-session%') AS completions,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa effective-session%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("driver-effective-session.test.mjs: cleanup verified — zero QA rows left");
