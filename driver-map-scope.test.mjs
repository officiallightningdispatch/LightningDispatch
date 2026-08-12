// Hermetic tests for the driver-map scope of the view toggle (spec TEST item 6)
// + migration-30 idempotency:
//   - liveMapDataHandler(driverScope=true) returns the CONTRACTOR-scoped feed
//     for an owner in driver view (shape-b linked): only the linked driver's
//     pin + self pin, own active jobs with full detail (mine), other jobs
//     anonymized (no customer/driver names).
//   - liveMapDataHandler() (owner view) returns the ORG feed: all drivers, all
//     jobs with customer detail, no self pin.
//   - staff without a usable identity requesting driver scope → null.
//   - migration 30 (linked_driver_user_id + partial unique index) is idempotent:
//     ensureAuthSchema()/ensureSchema() re-run on a fixture DB where the column
//     is already present → no error; users_linked_driver_uidx still exists and
//     still enforces one-owner-per-driver (23505 on a second link).
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun driver-map-scope.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
await import("@tanstack/start-server-core");
const { H3Event } = await import("h3-v2");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { ensureAuthSchema } = await import("./src/data/auth-server.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { liveMapDataHandler } = await import("./src/data/live-map-core.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ORG = `qa map-scope ${randomUUID()}`;
const PREFIX = "qa-map-scope";
const tbId = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 1_000_000_000n);
const uid = (tag) => `qa-${PREFIX}-${tag}-${randomUUID()}`;
const OWNER = uid("owner");    // owner, shape-b linked to DRIVER_B
const DRIVER_B = uid("drv");   // contractor (the linked driver)
const OTHER = uid("oth");      // contractor (other driver on the map)
const PURE = uid("pure");      // owner with NO driver identity
const OWNER2 = uid("owner2");  // second owner for the unique-index check
const T_B = tbId(uid("tb"));
const T_O = tbId(uid("to"));
const email = (u) => `${u}@lightning.test`;

/* ------------------------------ fixture ------------------------------ */
await ensureSchema();
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa map-scope%'`) {
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
await q`DELETE FROM users WHERE email LIKE 'qa-map-scope-%@lightning.test'`.catch(() => {});
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
const ins = (id, name) => q`INSERT INTO users(id, name, email, password_hash) VALUES(${id}, ${name}, ${email(id)}, 'x')`;
await ins(OWNER, "Map Owner");
await ins(DRIVER_B, "Linked Driver");
await ins(OTHER, "Other Driver");
await ins(PURE, "Pure Owner");
await ins(OWNER2, "Second Owner");
await q`UPDATE users SET towbook_driver_id=${T_B} WHERE id=${DRIVER_B}`;
await q`UPDATE users SET towbook_driver_id=${T_O} WHERE id=${OTHER}`;
await q`UPDATE users SET linked_driver_user_id=${DRIVER_B} WHERE id=${OWNER}`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'),
  (${ORG}, ${DRIVER_B}, 'contractor'),
  (${ORG}, ${OTHER}, 'contractor'),
  (${ORG}, ${PURE}, 'owner'),
  (${ORG}, ${OWNER2}, 'owner')`;
// Latest pings: the linked driver and the other driver (owner view sees both;
// driver view only the linked driver's own pin + self).
await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, job_id, latitude, longitude, accuracy) VALUES
  (gen_random_uuid()::text, ${ORG}, ${DRIVER_B}, ${T_B}, NULL, 41.2, -73.2, 10),
  (gen_random_uuid()::text, ${ORG}, ${OTHER}, ${T_O}, NULL, 41.4, -73.4, 12)`;
// Active jobs with pickup waypoints: one assigned to the linked driver, one to
// the other driver.
await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, customer_phone, vehicle_desc, pickup, dropoff, towbook_status, raw_json, pickup_lat, pickup_lng, assigned_driver_towbook_id, assigned_driver_name)
  VALUES('job-mine', ${ORG}, 'Mine Customer', '', 0, 0, 'Bridgeport', 'jump_start', 'accepted', NOW(), '', '700001', '', '2020 Honda Civic', '1 Mine Ave', '', '2', '{}'::jsonb, 41.21, -73.21, ${T_B}, 'Linked Driver'),
        ('job-other', ${ORG}, 'Other Customer', '', 0, 0, 'Bridgeport', 'flatbed_tow', 'en_route', NOW(), '', '700002', '', '2015 Ford F150', '2 Other Ave', '', '3', '{}'::jsonb, 41.31, -73.31, ${T_O}, 'Other Driver')`;
const sessions = new Map();
for (const [u, role] of [[OWNER, "owner"], [PURE, "owner"], [OWNER2, "owner"]]) {
  const token = `sess-${randomUUID()}`;
  sessions.set(u, token);
  await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${token}, ${u}, NOW() + INTERVAL '1 day')`;
}
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
/* ------------------------- 1) owner view = org feed ------------------------- */
{
  const feed = await withSession(sessions.get(OWNER), () => liveMapDataHandler(false));
  check("owner view: org feed — BOTH drivers' pins with names",
    feed !== null && feed.drivers.length === 2 && feed.drivers.some((d) => d.driverId === DRIVER_B && d.driverName === "Linked Driver") && feed.drivers.some((d) => d.driverId === OTHER), JSON.stringify(feed?.drivers));
  check("owner view: no self pin; all jobs with customer detail; mine never set",
    feed !== null && feed.self === null && feed.jobs.length === 2 &&
    feed.jobs.every((j) => j.customerName !== null && j.driverName !== null && j.mine === false),
    JSON.stringify(feed?.jobs));
}
/* ------------------------- 2) driver view = contractor-scoped feed ------------------------- */
{
  const feed = await withSession(sessions.get(OWNER), () => liveMapDataHandler(true));
  check("driver view: only the LINKED driver's pin + self pin",
    feed !== null && feed.drivers.length === 1 && feed.drivers[0].driverId === DRIVER_B &&
    feed.self !== null && feed.self.lat === 41.2 && feed.self.lng === -73.2,
    JSON.stringify({ drivers: feed?.drivers, self: feed?.self }));
  const mineJob = feed?.jobs.find((j) => j.jobId === "job-mine");
  const otherJob = feed?.jobs.find((j) => j.jobId === "job-other");
  check("driver view: own job full detail (mine + customer + driver name)",
    feed !== null && mineJob !== undefined && mineJob.mine === true && mineJob.customerName === "Mine Customer" && mineJob.driverName === "Linked Driver",
    JSON.stringify(mineJob));
  check("driver view: other jobs anonymized (no customer/driver names, mine false)",
    feed !== null && otherJob !== undefined && otherJob.mine === false && otherJob.customerName === null && otherJob.driverName === null,
    JSON.stringify(otherJob));
}
/* ------------------------- 3) staff without identity requesting driver scope ------------------------- */
{
  const feed = await withSession(sessions.get(PURE), () => liveMapDataHandler(true));
  check("driver view for pure owner (no identity) → null", feed === null);
  const orgFeed = await withSession(sessions.get(PURE), () => liveMapDataHandler(false));
  check("owner view for pure owner still returns the org feed",
    orgFeed !== null && orgFeed.drivers.length === 2 && orgFeed.jobs.length === 2);
}
/* ------------------------- 4) migration-30 idempotency + index intact ------------------------- */
{
  let threw = false;
  try {
    await ensureAuthSchema();
    await ensureAuthSchema();
    await ensureSchema();
    await ensureSchema();
  } catch (err) { threw = true; console.error("migration re-run error:", err); }
  check("migration 30 idempotent: ensureAuthSchema + ensureSchema re-run with linked_driver_user_id present → no error", threw === false);
  const idx = await q`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='users_linked_driver_uidx'`;
  check("migration 30: users_linked_driver_uidx still exists", idx.length === 1, JSON.stringify(idx));
  let dup = null;
  try {
    await q`UPDATE users SET linked_driver_user_id=${DRIVER_B} WHERE id=${OWNER2}`;
  } catch (err) { dup = err; }
  check("migration 30: unique index still enforces ONE owner per driver (23505)",
    dup !== null && String(dup.message).includes("duplicate key"), dup ? String(dup.message).slice(0, 120) : "no error");
  const linked = await q`SELECT id FROM users WHERE linked_driver_user_id=${DRIVER_B}`;
  check("migration 30: the original link is untouched after the failed second link",
    linked.length === 1 && linked[0].id === OWNER, JSON.stringify(linked));
}
/* ------------------------------- summary + cleanup ------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-map-scope.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa map-scope%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa map-scope%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-map-scope-%@lightning.test'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa map-scope%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-map-scope-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email LIKE 'qa-map-scope-%@lightning.test') AS sessions,
  (SELECT COUNT(*)::int FROM driver_locations dl JOIN organizations o ON o.id=dl.org_id WHERE o.name LIKE 'qa map-scope%') AS locs,
  (SELECT COUNT(*)::int FROM dispatch_jobs j JOIN organizations o ON o.id=j.org_id WHERE o.name LIKE 'qa map-scope%') AS jobs,
  (SELECT COUNT(*)::int FROM status_events e JOIN organizations o ON o.id=e.org_id WHERE o.name LIKE 'qa map-scope%') AS events,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa map-scope%') AS audit,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa map-scope%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("driver-map-scope.test.mjs: cleanup verified — zero QA rows left");
