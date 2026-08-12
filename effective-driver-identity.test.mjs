// Hermetic tests for the unified effective-driver resolver (owner↔contractor
// view toggle, spec §3 — the heart of the feature):
//   contractor            → own row
//   staff w/ own towbook_driver_id (shape a) → own row
//   staff w/ linked_driver_user_id (shape b) → linked contractor's row
//   staff with neither     → null
//   linked driver later deactivated → { deactivated: true }
//   linked row missing towbook_driver_id → null
// currentUser() extends AuthUser with driverIdentity (seroval-safe explicit
// nulls) — exercised through the real cookie→session→user resolution path by
// seeding the TanStack Start AsyncLocalStorage event context (same mechanism
// the server runtime uses; no HTTP server required).
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun effective-driver-identity.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
await import("@tanstack/start-server-core");
const { H3Event } = await import("h3-v2");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { currentUser, effectiveDriverIdentity } = await import("./src/data/auth-server.ts");
const { driverGateAllows } = await import("./src/components/portal-gate.tsx");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ORG = `qa effective-driver ${randomUUID()}`;
const PREFIX = "qa-effective-driver";
const tbId = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 1_000_000_000n);
const user = (prefix) => `qa-${prefix}-${randomUUID()}`;
const OWNER_PURE = user(PREFIX);      // owner, no driver id, no link
const OWNER_A = user(PREFIX);         // owner w/ own towbook_driver_id (shape a)
const ADMIN_B = user(PREFIX);         // admin w/ linked driver (shape b)
const DRIVER_B = user(PREFIX);        // contractor linked to ADMIN_B
const DRIVER_C = user(PREFIX);        // contractor w/ towbook id (self)
const DRIVER_NONE = user(PREFIX);     // contractor w/o towbook id
const OWNER_DEACT = user(PREFIX);     // owner linked to a deactivated driver
const DRIVER_DEACT = user(PREFIX);    // deactivated contractor
const OWNER_NOTB = user(PREFIX);      // owner linked to a driver w/o towbook id
const DRIVER_NOTB = user(PREFIX);     // contractor w/o towbook id (linked)
const TA = tbId(user(PREFIX));
const TB = tbId(user(PREFIX));
const TC = tbId(user(PREFIX));
const TD = tbId(user(PREFIX));
const email = (u) => `${u}@lightning.test`;

/* ------------------------------ fixture ------------------------------ */
await ensureSchema();
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
const ins = (id, name) => q`INSERT INTO users(id, name, email, password_hash) VALUES(${id}, ${name}, ${email(id)}, 'x')`;
await ins(OWNER_PURE, "Pure Owner");
await ins(OWNER_A, "ShapeA Owner");
await ins(ADMIN_B, "ShapeB Admin");
await ins(DRIVER_B, "Linked Driver");
await ins(DRIVER_C, "Contractor C");
await ins(DRIVER_NONE, "NoId Contractor");
await ins(OWNER_DEACT, "Deact Owner");
await ins(DRIVER_DEACT, "Deact Driver");
await ins(OWNER_NOTB, "NoTb Owner");
await ins(DRIVER_NOTB, "NoTb Driver");
await q`UPDATE users SET towbook_driver_id=${TA} WHERE id=${OWNER_A}`;
await q`UPDATE users SET towbook_driver_id=${TB} WHERE id=${DRIVER_B}`;
await q`UPDATE users SET towbook_driver_id=${TC} WHERE id=${DRIVER_C}`;
await q`UPDATE users SET towbook_driver_id=${TD}, deactivated_at=NOW() WHERE id=${DRIVER_DEACT}`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER_PURE}, 'owner'),
  (${ORG}, ${OWNER_A}, 'owner'),
  (${ORG}, ${ADMIN_B}, 'admin'),
  (${ORG}, ${DRIVER_B}, 'contractor'),
  (${ORG}, ${DRIVER_C}, 'contractor'),
  (${ORG}, ${DRIVER_NONE}, 'contractor'),
  (${ORG}, ${OWNER_DEACT}, 'owner'),
  (${ORG}, ${DRIVER_DEACT}, 'contractor'),
  (${ORG}, ${OWNER_NOTB}, 'owner'),
  (${ORG}, ${DRIVER_NOTB}, 'contractor')`;
await q`UPDATE users SET linked_driver_user_id=${DRIVER_B} WHERE id=${ADMIN_B}`;
await q`UPDATE users SET linked_driver_user_id=${DRIVER_DEACT} WHERE id=${OWNER_DEACT}`;
await q`UPDATE users SET linked_driver_user_id=${DRIVER_NOTB} WHERE id=${OWNER_NOTB}`;
// LD sessions (one per user row that needs currentUser to resolve)
const sessions = new Map(); // user → token
for (const u of [OWNER_PURE, OWNER_A, ADMIN_B, DRIVER_C, DRIVER_NONE, OWNER_DEACT, OWNER_NOTB]) {
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
/* ------------------------------ resolver: direct ------------------------------ */
{
  const pure = await effectiveDriverIdentity({ id: OWNER_PURE, name: "Pure Owner", email: email(OWNER_PURE), role: "owner", orgId: ORG, driverIdentity: null });
  check("owner with neither id nor link → null", pure === null);
  const a = await effectiveDriverIdentity({ id: OWNER_A, name: "ShapeA Owner", email: email(OWNER_A), role: "owner", orgId: ORG, towbookDriverId: TA, driverIdentity: null });
  check("shape-a owner → own row (userRowId self, towbook id own, not deactivated)",
    a !== null && a.userRowId === OWNER_A && a.towbookDriverId === TA && a.driverName === "ShapeA Owner" && a.deactivated === false, JSON.stringify(a));
  const b = await effectiveDriverIdentity({ id: ADMIN_B, name: "ShapeB Admin", email: email(ADMIN_B), role: "admin", orgId: ORG, linkedDriverUserId: DRIVER_B, driverIdentity: null });
  check("shape-b admin → linked contractor's row (userRowId = driver row, tb id = driver's)",
    b !== null && b.userRowId === DRIVER_B && b.towbookDriverId === TB && b.driverName === "Linked Driver" && b.deactivated === false, JSON.stringify(b));
  const c = await effectiveDriverIdentity({ id: DRIVER_C, name: "Contractor C", email: email(DRIVER_C), role: "contractor", orgId: ORG, towbookDriverId: TC, driverIdentity: null });
  check("contractor → own row", c !== null && c.userRowId === DRIVER_C && c.towbookDriverId === TC && c.deactivated === false, JSON.stringify(c));
  const none = await effectiveDriverIdentity({ id: DRIVER_NONE, name: "NoId Contractor", email: email(DRIVER_NONE), role: "contractor", orgId: ORG, driverIdentity: null });
  check("contractor without towbook id → null", none === null);
  const deact = await effectiveDriverIdentity({ id: OWNER_DEACT, name: "Deact Owner", email: email(OWNER_DEACT), role: "owner", orgId: ORG, linkedDriverUserId: DRIVER_DEACT, driverIdentity: null });
  check("linked-deactivated → identity with deactivated:true (link kept, entry blocked)",
    deact !== null && deact.userRowId === DRIVER_DEACT && deact.towbookDriverId === TD && deact.deactivated === true, JSON.stringify(deact));
  const notb = await effectiveDriverIdentity({ id: OWNER_NOTB, name: "NoTb Owner", email: email(OWNER_NOTB), role: "owner", orgId: ORG, linkedDriverUserId: DRIVER_NOTB, driverIdentity: null });
  check("linked driver missing towbook id → null", notb === null);
  check("dispatcher without identity → null", await effectiveDriverIdentity({ id: user(PREFIX), name: "D", email: email(user(PREFIX)), role: "dispatcher", orgId: ORG, driverIdentity: null }) === null);
}
/* ------------------------------ resolver: via currentUser (real cookie path) ------------------------------ */
{
  const u = await withSession(sessions.get(OWNER_A), () => currentUser());
  check("currentUser (shape a): driverIdentity = own row", u !== null && u.role === "owner" && u.towbookDriverId === TA && u.driverIdentity !== null && u.driverIdentity.userRowId === OWNER_A && u.driverIdentity.towbookDriverId === TA && u.driverIdentity.deactivated === false, JSON.stringify(u?.driverIdentity));
  const b = await withSession(sessions.get(ADMIN_B), () => currentUser());
  check("currentUser (shape b): driverIdentity = linked row + linkedDriverUserId present",
    b !== null && b.linkedDriverUserId === DRIVER_B && b.driverIdentity !== null && b.driverIdentity.userRowId === DRIVER_B && b.driverIdentity.towbookDriverId === TB && b.driverIdentity.driverName === "Linked Driver", JSON.stringify(b));
  const pure = await withSession(sessions.get(OWNER_PURE), () => currentUser());
  check("currentUser (pure owner): driverIdentity null (explicit)", pure !== null && pure.driverIdentity === null);
  const c = await withSession(sessions.get(DRIVER_C), () => currentUser());
  check("currentUser (contractor): driverIdentity = own row", c !== null && c.driverIdentity !== null && c.driverIdentity.userRowId === DRIVER_C && c.driverIdentity.towbookDriverId === TC);
  const deact = await withSession(sessions.get(OWNER_DEACT), () => currentUser());
  check("currentUser (linked-deactivated): driverIdentity.deactivated true", deact !== null && deact.driverIdentity !== null && deact.driverIdentity.deactivated === true);
  const notb = await withSession(sessions.get(OWNER_NOTB), () => currentUser());
  check("currentUser (linked no-tb-id): driverIdentity null", notb !== null && notb.driverIdentity === null);
  const none = await withSession(sessions.get(DRIVER_NONE), () => currentUser());
  check("currentUser (contractor no id): driverIdentity null", none !== null && none.driverIdentity === null);
  const bogus = await withSession("sess-does-not-exist", () => currentUser());
  check("currentUser (bad token): null", bogus === null);
}
/* ------------------- gate integration: real resolved identities feed DriverGate ------------------- */
{
  const ua = await withSession(sessions.get(OWNER_A), () => currentUser());
  check("DriverGate passes shape-a owner (resolved identity)", driverGateAllows(ua) === true);
  const ub = await withSession(sessions.get(ADMIN_B), () => currentUser());
  check("DriverGate passes shape-b admin (resolved identity)", driverGateAllows(ub) === true);
  const up = await withSession(sessions.get(OWNER_PURE), () => currentUser());
  check("DriverGate rejects pure owner (no identity)", driverGateAllows(up) === false);
  const ud = await withSession(sessions.get(OWNER_DEACT), () => currentUser());
  check("DriverGate rejects deactivated-link owner", driverGateAllows(ud) === false);
  const uc = await withSession(sessions.get(DRIVER_C), () => currentUser());
  check("DriverGate passes contractor (resolved identity)", driverGateAllows(uc) === true);
}
/* ------------------------------- summary + cleanup ------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`effective-driver-identity.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa effective-driver%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
await q`DELETE FROM users WHERE email LIKE 'qa-effective-driver-%@lightning.test'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa effective-driver%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-effective-driver-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email LIKE 'qa-effective-driver-%@lightning.test') AS sessions`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("effective-driver-identity.test.mjs: cleanup verified — zero QA rows left");
