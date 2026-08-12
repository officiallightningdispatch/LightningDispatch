// Hermetic tests for the owner↔contractor link flows (view toggle, spec §3):
//   listLinkableDriversCore / linkDriverAccountCore / unlinkDriverAccountCore.
//   - source: owner/admin only; shape-a (own towbook_driver_id) hides the link UI
//   - target: same org, role contractor, active, non-null towbook_driver_id
//   - one driver per owner (column); one owner per driver (partial unique index)
//     — a second account linking the same driver is rejected
//   - audited driver_link_set / driver_link_unset (best-effort)
//   - roster regression (spec #7): staff-with-driver-id appears on
//     listRosterContractors; a pure owner never appears.
// Cookie-backed cores are driven through the seeded TanStack Start event
// context (server-runtime parity; no HTTP server). DB-backed against throwaway
// QA orgs deleted at the end (zero rows left).
//   DATABASE_URL=... bun driver-link-flows.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
await import("@tanstack/start-server-core");
const { H3Event } = await import("h3-v2");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { listLinkableDriversCore, linkDriverAccountCore, unlinkDriverAccountCore } = await import("./src/data/auth-server.ts");
const { listRosterContractors } = await import("./src/data/server.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ORG = `qa driver-link ${randomUUID()}`;
const ORG2 = `qa driver-link ${randomUUID()}`;
const PREFIX = "qa-driver-link";
const tbId = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 1_000_000_000n);
const uid = (tag) => `qa-${PREFIX}-${tag}-${randomUUID()}`;
const OWNER = uid("owner");
const ADMIN = uid("admin");
const DRIVER1 = uid("d1");
const DRIVER2 = uid("d2");
const DRIVER_NULL_TB = uid("dnull");
const DRIVER_DEACT = uid("ddeact");
const SHAPE_A = uid("shapea");
const OWNER2 = uid("owner2");
const DRIVER_OTHER = uid("dother");
const T1 = tbId(uid("t1"));
const T2 = tbId(uid("t2"));
const TS = tbId(uid("ts"));
const TSA = tbId(uid("tsa"));
const TOTHER = tbId(uid("to"));
const email = (u) => `${u}@lightning.test`;

/* ------------------------------ fixture ------------------------------ */
await ensureSchema();
// sweep any leftovers from earlier crashed runs (QA-prefixed only)
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa driver-link%'`) {
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
await q`DELETE FROM users WHERE email LIKE 'qa-driver-link-%@lightning.test'`.catch(() => {});
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG}), (${ORG2}, ${ORG2})`;
const ins = (id, name) => q`INSERT INTO users(id, name, email, password_hash) VALUES(${id}, ${name}, ${email(id)}, 'x')`;
await ins(OWNER, "Link Owner");
await ins(ADMIN, "Link Admin");
await ins(DRIVER1, "Driver One");
await ins(DRIVER2, "Driver Two");
await ins(DRIVER_NULL_TB, "No Id Driver");
await ins(DRIVER_DEACT, "Deact Driver");
await ins(SHAPE_A, "ShapeA Owner");
await ins(OWNER2, "Other Org Owner");
await ins(DRIVER_OTHER, "Other Org Driver");
await q`UPDATE users SET towbook_driver_id=${T1} WHERE id=${DRIVER1}`;
await q`UPDATE users SET towbook_driver_id=${T2} WHERE id=${DRIVER2}`;
await q`UPDATE users SET towbook_driver_id=${TS} WHERE id=${DRIVER_DEACT}`;
await q`UPDATE users SET deactivated_at=NOW() WHERE id=${DRIVER_DEACT}`;
await q`UPDATE users SET towbook_driver_id=${TSA} WHERE id=${SHAPE_A}`;
await q`UPDATE users SET towbook_driver_id=${TOTHER} WHERE id=${DRIVER_OTHER}`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'),
  (${ORG}, ${ADMIN}, 'admin'),
  (${ORG}, ${DRIVER1}, 'contractor'),
  (${ORG}, ${DRIVER2}, 'contractor'),
  (${ORG}, ${DRIVER_NULL_TB}, 'contractor'),
  (${ORG}, ${DRIVER_DEACT}, 'contractor'),
  (${ORG}, ${SHAPE_A}, 'owner'),
  (${ORG2}, ${OWNER2}, 'owner'),
  (${ORG2}, ${DRIVER_OTHER}, 'contractor')`;
const sessions = new Map();
for (const [u, role] of [[OWNER, "owner"], [ADMIN, "admin"], [DRIVER1, "contractor"], [SHAPE_A, "owner"], [OWNER2, "owner"], [DRIVER2, "contractor"]]) {
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
const auditFor = async (action, entityId) => (await q`SELECT actor_user_id, actor_role, action, entity_type, entity_id, detail FROM audit_log WHERE org_id=${ORG} AND action=${action} AND entity_id=${entityId} ORDER BY occurred_at DESC`);

/* ------------------------- 1) picker payload + shape-a UI rule ------------------------- */
{
  const r = await withSession(sessions.get(OWNER), () => listLinkableDriversCore());
  check("picker: owner → ok, no own driver id, nothing linked", r.ok === true && r.ownDriverId === null && r.linked === null, JSON.stringify(r));
  check("picker: candidates = active contractors with tb id, not already linked",
    r.ok === true && r.candidates.map((c) => c.id).sort().join(",") === [DRIVER1, DRIVER2].sort().join(","), JSON.stringify(r.candidates));
  const s = await withSession(sessions.get(SHAPE_A), () => listLinkableDriversCore());
  check("picker: shape-a owner → ownDriverId set (link UI hidden)", s.ok === true && s.ownDriverId === TSA && s.linked === null, JSON.stringify(s));
  const c = await withSession(sessions.get(DRIVER1), () => listLinkableDriversCore());
  check("picker: contractor → denied", c.ok === false && c.error.includes("Owner access"), JSON.stringify(c));
}
/* ------------------------- 2) link: happy path + audit ------------------------- */
{
  const r = await withSession(sessions.get(OWNER), () => linkDriverAccountCore(DRIVER1));
  check("link: owner → active driver ok (name + tb id + not deactivated)", r.ok === true && r.linked.name === "Driver One" && r.linked.towbookDriverId === T1 && r.linked.deactivated === false, JSON.stringify(r));
  const row = await q`SELECT linked_driver_user_id FROM users WHERE id=${OWNER}`;
  check("link: column set on source row", row[0].linked_driver_user_id === DRIVER1);
  const audit = await auditFor("driver_link_set", DRIVER1);
  check("link: audit driver_link_set under actor id with detail", audit.length === 1 && audit[0].actor_user_id === OWNER && audit[0].actor_role === "owner" && audit[0].entity_type === "user" && String(audit[0].detail.driverName) === "Driver One", JSON.stringify(audit));
  const pick = await withSession(sessions.get(OWNER), () => listLinkableDriversCore());
  check("link: linked row surfaces in picker with driver id; candidates exclude it",
    pick.ok === true && pick.linked !== null && pick.linked.id === DRIVER1 && pick.linked.towbookDriverId === T1 && pick.candidates.map((c) => c.id).join(",") === DRIVER2, JSON.stringify(pick));
}
/* ------------------------- 3) mutual exclusivity + unique index ------------------------- */
{
  const dup = await withSession(sessions.get(OWNER), () => linkDriverAccountCore(DRIVER2));
  check("link: second link while already linked → rejected (one driver per owner)", dup.ok === false && dup.error.includes("unlink first"), JSON.stringify(dup));
  const admin = await withSession(sessions.get(ADMIN), () => linkDriverAccountCore(DRIVER1));
  check("link: second account linking the same driver → rejected (unique index)", admin.ok === false && admin.error.includes("already linked to another account"), JSON.stringify(admin));
  const rows = await q`SELECT id FROM users WHERE linked_driver_user_id=${DRIVER1}`;
  check("link: only ONE account holds the link (unique index enforced)", rows.length === 1 && rows[0].id === OWNER, JSON.stringify(rows));
  // admin can link a DIFFERENT driver (unique index per driver, not global)
  const admin2 = await withSession(sessions.get(ADMIN), () => linkDriverAccountCore(DRIVER2));
  check("link: admin links a different driver ok", admin2.ok === true, JSON.stringify(admin2));
  await withSession(sessions.get(ADMIN), () => unlinkDriverAccountCore());
}
/* ------------------------- 4) validation matrix ------------------------- */
{
  const deact = await withSession(sessions.get(OWNER), () => linkDriverAccountCore(DRIVER_DEACT));
  check("link: deactivated driver → blocked with reactivate copy", deact.ok === false && deact.error.includes("reactivate"), JSON.stringify(deact));
  const notb = await withSession(sessions.get(OWNER), () => linkDriverAccountCore(DRIVER_NULL_TB));
  check("link: driver without tb id → blocked with sign-in-once copy", notb.ok === false && notb.error.includes("sign in once"), JSON.stringify(notb));
  const foreign = await withSession(sessions.get(OWNER), () => linkDriverAccountCore(DRIVER_OTHER));
  check("link: other-org driver → rejected (same-org validation)", foreign.ok === false && foreign.error.includes("isn't on this account"), JSON.stringify(foreign));
  const shapeA = await withSession(sessions.get(SHAPE_A), () => linkDriverAccountCore(DRIVER1));
  check("link: shape-a owner → blocked (mutually exclusive with own driver id)", shapeA.ok === false && shapeA.error.includes("already a driver"), JSON.stringify(shapeA));
  const contractor = await withSession(sessions.get(DRIVER2), () => linkDriverAccountCore(DRIVER1));
  check("link: contractor actor → denied", contractor.ok === false && contractor.error.includes("Owner access"), JSON.stringify(contractor));
  const bogus = await withSession(sessions.get(OWNER), () => linkDriverAccountCore("no-such-user"));
  check("link: unknown target → rejected", bogus.ok === false && bogus.error.includes("isn't on this account"), JSON.stringify(bogus));
}
/* ------------------------- 5) unlink: clears + audit + re-link ------------------------- */
{
  const u = await withSession(sessions.get(OWNER), () => unlinkDriverAccountCore());
  check("unlink: ok", u.ok === true, JSON.stringify(u));
  const row = await q`SELECT linked_driver_user_id FROM users WHERE id=${OWNER}`;
  check("unlink: column cleared", row[0].linked_driver_user_id === null);
  const audit = await auditFor("driver_link_unset", DRIVER1);
  check("unlink: audit driver_link_unset under actor id", audit.length === 1 && audit[0].actor_user_id === OWNER, JSON.stringify(audit));
  const again = await withSession(sessions.get(OWNER), () => unlinkDriverAccountCore());
  check("unlink: already-unlinked → error", again.ok === false && again.error.includes("No driver account"), JSON.stringify(again));
  const relink = await withSession(sessions.get(OWNER), () => linkDriverAccountCore(DRIVER1));
  check("link: re-link after unlink ok", relink.ok === true && relink.linked.id === DRIVER1, JSON.stringify(relink));
  const dup = await withSession(sessions.get(OWNER), () => linkDriverAccountCore(DRIVER2));
  check("link: still one driver per owner after re-link", dup.ok === false && dup.error.includes("unlink first"));
  await withSession(sessions.get(OWNER), () => unlinkDriverAccountCore());
}
/* ------------------------- 6) roster regression (spec #7) ------------------------- */
{
  const roster = await listRosterContractors(ORG);
  const ids = roster.map((r) => r.id);
  check("roster: shape-a owner (staff w/ driver id) appears", ids.includes(SHAPE_A), JSON.stringify(ids));
  check("roster: pure owner never appears", !ids.includes(OWNER), JSON.stringify(ids));
  check("roster: contractors still appear", ids.includes(DRIVER1) && ids.includes(DRIVER2), JSON.stringify(ids));
}
/* ------------------------------- summary + cleanup ------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-link-flows.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa driver-link%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa driver-link%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-driver-link-%@lightning.test'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa driver-link%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-driver-link-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa driver-link%') AS audit,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa driver-link%') AS members,
  (SELECT COUNT(*)::int FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email LIKE 'qa-driver-link-%@lightning.test') AS sessions`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("driver-link-flows.test.mjs: cleanup verified — zero QA rows left");
