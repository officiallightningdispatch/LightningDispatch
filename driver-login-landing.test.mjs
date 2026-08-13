// Owner direction 2026-08-13: username al0101 must have BOTH owner access AND
// contractor access. Landing rule: an active user who is an owner/admin member
// of the org lands in the OWNER portal EVEN when their Towbook account type is
// 1 (driver account) — membership is authoritative for the portal role, the
// Towbook type keeps its refusal (3) and non-member mapping (1 → contractor).
//
// This suite tests the NEW landing logic:
//   - ownerMemberRole (auth-server): the membership→landing-role resolver that
//     driverLogin consults after a type-1 sign-in. DB-backed against a
//     throwaway QA org (deleted at the end — zero rows left). The org is qa-
//     prefixed so resolveOwnerOrgId can NEVER resolve to it — this suite never
//     touches production data.
//   - wiring assertions (source-level, matching the towbook-account-type suite
//     pattern): driverLogin branches on ownerMemberRole before the contractor
//     return; the login route still routes role → portal via portal(d.role).
//   - the al0101 real-world shape: shape-a owner member (own towbook_driver_id
//     + towbook_user_id + login_handle) + a leftover QA org where the same user
//     is a contractor — ownerMemberRole must return the landing role from the
//     RESOLVED org's membership only (prod owner → owner; QA contractor → null).
//   DATABASE_URL=... bun driver-login-landing.test.mjs
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { ownerMemberRole } = await import("./src/data/auth-server.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const PREFIX = "qa-driver-login-landing";
const uid = (tag) => `qa-${PREFIX}-${tag}-${randomUUID()}`;
const ORG = `qa ${PREFIX} ${randomUUID()}`;
const ORG2 = `qa ${PREFIX}-b ${randomUUID()}`; // leftover-QA-org shape (contractor membership)
// LIKE patterns are passed as BIND PARAMETERS (never interpolated into the SQL
// text): a ${} interpolation inside a string literal would put the $n
// placeholder INSIDE the literal, which Postgres does not count as a
// parameter → "bind message supplies N parameters, but prepared statement
// requires 0" (08P01). Patterns as parameters keep the text literal-free.
const ORG_PAT = `qa ${PREFIX}%`; // matches both fixture org names
const USER_PAT = `${PREFIX}-%@lightning.test`;
const OWNER_DRIVER = uid("ownerdrv"); // al0101 shape: owner member + own driver identity
const ADMIN_DRIVER = uid("admindrv"); // admin member + own driver identity
const CONTRACTOR_DRIVER = uid("contractordrv"); // contractor member (type-1 driver — stays contractor)
const DISPATCHER_DRIVER = uid("dispatchdrv"); // dispatcher member (type-1 driver — stays contractor)
const NO_MEMBER = uid("nomember"); // type-1 driver with no membership — stays contractor
const email = (u) => `${u}@lightning.test`;
/* ------------------------------ fixture ------------------------------ */
await ensureSchema();
// sweep leftovers from earlier crashed runs (qa-prefixed only)
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE ${ORG_PAT}`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
await q`DELETE FROM users WHERE email LIKE ${USER_PAT}`.catch(() => {});
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
await q`INSERT INTO organizations(id, name) VALUES(${ORG2}, ${ORG2})`;
const ins = (id, name) => q`INSERT INTO users(id, name, email, password_hash) VALUES(${id}, ${name}, ${email(id)}, 'x')`;
await ins(OWNER_DRIVER, "Ai Dispatch GB");
await ins(ADMIN_DRIVER, "Admin Driver");
await ins(CONTRACTOR_DRIVER, "Contractor Driver");
await ins(DISPATCHER_DRIVER, "Dispatcher Driver");
await ins(NO_MEMBER, "No Member Driver");
// al0101 real-world SHAPE: the user row IS the driver identity (own
// towbook_driver_id + towbook_user_id + login_handle). Ids are fixture-unique
// (users_towbook_driver_id_idx is a unique index — the real 721132 already
// exists in the shared DB).
const tbId = (seed) => String(BigInt("0x" + seed.replace(/-/g, "").slice(-32)) % 900_000_000n + 100_000_000n);
const OWNER_TB_ID = tbId(uid("td"));
await q`UPDATE users SET towbook_driver_id=${OWNER_TB_ID}, towbook_user_id=${String(Number(OWNER_TB_ID) + 1)}, login_handle=${uid("ownerdrv-h")} WHERE id=${OWNER_DRIVER}`;
await q`UPDATE users SET towbook_driver_id=${tbId(uid("ta"))}, towbook_user_id=${tbId(uid("tua"))}, login_handle='admindrv1' WHERE id=${ADMIN_DRIVER}`;
await q`UPDATE users SET towbook_driver_id=${tbId(uid("tc"))}, towbook_user_id=${tbId(uid("tuc"))}, login_handle='contractordrv1' WHERE id=${CONTRACTOR_DRIVER}`;
await q`UPDATE users SET towbook_driver_id=${tbId(uid("tdd"))}, towbook_user_id=${tbId(uid("tud"))}, login_handle='dispatchdrv1' WHERE id=${DISPATCHER_DRIVER}`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER_DRIVER}, 'owner'),
  (${ORG}, ${ADMIN_DRIVER}, 'admin'),
  (${ORG}, ${CONTRACTOR_DRIVER}, 'contractor'),
  (${ORG}, ${DISPATCHER_DRIVER}, 'dispatcher')`;
// Leftover-QA shape: the SAME owner-member user is a contractor in another
// (QA) org — the resolved org's membership alone decides the landing role.
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG2}, ${OWNER_DRIVER}, 'contractor')`;
/* ------------------------------ ownerMemberRole ------------------------------ */
{
  const r = await ownerMemberRole(ORG, OWNER_DRIVER);
  check("owner member with a type-1 driver identity → landing role 'owner' (al0101 shape)", r === "owner", JSON.stringify(r));
}
{
  const r = await ownerMemberRole(ORG, ADMIN_DRIVER);
  check("admin member with a type-1 driver identity → landing role 'admin'", r === "admin", JSON.stringify(r));
}
{
  const r = await ownerMemberRole(ORG, CONTRACTOR_DRIVER);
  check("contractor member → null (stays contractor portal)", r === null, JSON.stringify(r));
}
{
  const r = await ownerMemberRole(ORG, DISPATCHER_DRIVER);
  check("dispatcher member → null (not an owner/admin landing)", r === null, JSON.stringify(r));
}
{
  const r = await ownerMemberRole(ORG, NO_MEMBER);
  check("no membership → null (plain type-1 driver stays contractor portal)", r === null, JSON.stringify(r));
}
{
  const r = await ownerMemberRole(ORG2, OWNER_DRIVER);
  check("leftover-QA org membership (contractor) → null — only the RESOLVED org's membership decides", r === null, JSON.stringify(r));
  const r2 = await ownerMemberRole(ORG, OWNER_DRIVER);
  check("same user, resolved (real) org membership (owner) → 'owner' regardless of the QA leftover", r2 === "owner", JSON.stringify(r2));
}
/* ------------------------------ driverLogin wiring ------------------------------ */
{
  const src = readFileSync("./src/data/driver-auth.ts", "utf8");
  check("driverLogin imports ownerMemberRole from auth-server", src.includes("ownerMemberRole") && src.includes('await import("./auth-server")'), "ownerMemberRole not wired into driver-auth");
  check("driverLogin branches on memberRole before the contractor return", /const memberRole = await ownerMemberRole\(orgId, userId\);[\s\S]*?if \(memberRole\) \{[\s\S]*?role: memberRole[\s\S]*?role: "contractor" as const/.test(src), "landing branch missing");
  check("driverLogin still persists the driver identity + driver session BEFORE the landing decision (toggle depends on it)", src.includes("await persistDriverSession(orgId, identity.identity.driverId, session);") && src.indexOf("persistDriverSession") < src.indexOf("memberRole"), "persist order broken");
}
{
  const src = readFileSync("./src/routes/login.tsx", "utf8");
  check("login route routes role→portal via portal(d.role) — owner lands /owner", src.includes("portal(d.role)") && src.includes('role==="contractor"?"/driver"'), "login portal routing unwired");
}
/* ------------------------------- summary + cleanup ------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-login-landing.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE ${ORG_PAT}`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
await q`DELETE FROM users WHERE email LIKE ${USER_PAT}`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE ${ORG_PAT}) AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE ${USER_PAT}) AS users,
  (SELECT COUNT(*)::int FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email LIKE ${USER_PAT}) AS sessions,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE ${ORG_PAT}) AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("driver-login-landing.test.mjs: cleanup verified — zero QA rows left");
