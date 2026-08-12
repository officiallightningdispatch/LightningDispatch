// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic login-core reason tests (owner bug 2026-08-12): the LD login core
// reports a machine-readable failure reason so the login form can decide
// whether the Towbook driver fallback may run —
//   (i)  owner/admin/dispatcher wrong password → invalid_password (STOP),
//   (ii) unknown identifier → unknown_identifier (fallback fires),
//   (iii) contractor account with the unusable random hash → contractor_account
//        (fallback fires — drivers authenticate via Towbook).
// Also covers: correct-password success (role returned), login_handle vs email
// matching, no-workspace, and short-password input (drivers' Towbook passwords
// may be short — a short password must reach verification, never be rejected
// on shape alone).
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun login-core.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { hash, loginCore, upsertTowbookOwnerUser } = await import("./src/data/auth-server.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ORG = `qa login-core ${randomUUID()}`;
const PREFIX = "qa-login-core";
const uid = (tag) => `qa-${PREFIX}-${tag}-${randomUUID()}`;
const email = (tag) => `${PREFIX}-${tag}-${randomUUID()}@lightning.test`;
const OWNER = uid("owner");
const ADMIN = uid("admin");
const DISPATCHER = uid("disp");
const DRIVER = uid("drv");
const WORKSPACELESS = uid("nws"); // user with a real password but NO membership
const OWNER_EMAIL = email("owner");
const ADMIN_EMAIL = email("admin");
const DISPATCHER_EMAIL = email("disp");
const DRIVER_EMAIL = email("drv"); // the @towbook.driver-style derived address
const DRIVER_HANDLE = `driver-handle-${randomUUID().slice(0, 12)}`;
const PASSWORD = "qa-real-password-123"; // >= 10 chars, matches the owner row
const DRIVER_TB_ID = String(BigInt("0x" + randomUUID().replace(/-/g, "").slice(0, 10)) % 1_000_000_000n);
await ensureSchema();
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa login-core fixture')`;
await q`INSERT INTO users(id, name, email, password_hash, login_handle) VALUES(${OWNER}, 'QA Owner', ${OWNER_EMAIL}, ${hash(PASSWORD)}, ${`owner-handle-${randomUUID().slice(0, 10)}`})`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OWNER}, 'owner')`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES(${ADMIN}, 'QA Admin', ${ADMIN_EMAIL}, ${hash("qa-admin-password-456")})`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${ADMIN}, 'admin')`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES(${DISPATCHER}, 'QA Dispatcher', ${DISPATCHER_EMAIL}, ${hash("qa-dispatch-password-789")})`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DISPATCHER}, 'dispatcher')`;
// Contractor row mirrors upsertDriverUser: random never-usable password hash,
// login_handle = the Towbook username, derived @towbook.driver-style email,
// towbook_driver_id set.
await q`INSERT INTO users(id, name, email, password_hash, login_handle, towbook_driver_id) VALUES(${DRIVER}, 'QA Driver', ${DRIVER_EMAIL}, ${hash(Math.random().toString(36).slice(2) + Date.now().toString(36))}, ${DRIVER_HANDLE}, ${DRIVER_TB_ID})`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DRIVER}, 'contractor')`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES(${WORKSPACELESS}, 'QA No Workspace', ${email("nws")}, ${hash("qa-no-workspace-password")})`;
/* ==================== (i) staff wrong password → invalid_password ==================== */
{
  const r = await loginCore(OWNER_EMAIL, "wrong-password-for-owner-123");
  check("(i) owner wrong password → invalid_password, 'Invalid username or password.'", r.ok === false && r.reason === "invalid_password" && r.error === "Invalid username or password.", JSON.stringify(r));
}
{
  const r = await loginCore(ADMIN_EMAIL, "wrong-password-for-admin-123");
  check("(i) admin wrong password → invalid_password", r.ok === false && r.reason === "invalid_password", JSON.stringify(r));
}
{
  const r = await loginCore(DISPATCHER_EMAIL, "wrong-password-for-dispatch-123");
  check("(i) dispatcher wrong password → invalid_password", r.ok === false && r.reason === "invalid_password", JSON.stringify(r));
}
/* ==================== correct password → session-worthy success ==================== */
{
  const r = await loginCore(OWNER_EMAIL.toUpperCase(), PASSWORD); // email matched case-insensitively
  check("owner correct password (email case-insensitive) → ok, role owner", r.ok === true && r.role === "owner" && r.userId === OWNER, JSON.stringify(r));
}
{
  // Handle-based matching (handles are unique and stored lowercase).
  const rows = await q`SELECT login_handle FROM users WHERE id=${OWNER}`;
  const handle = String(rows[0].login_handle);
  const h = await loginCore(handle, PASSWORD);
  check("owner correct password via login_handle → ok", h.ok === true && h.role === "owner", JSON.stringify(h));
}
/* ==================== (ii) unknown identifier → unknown_identifier ==================== */
{
  const r = await loginCore(`nobody-${randomUUID()}@nowhere.test`, "whatever-password-123");
  check("(ii) unknown identifier → unknown_identifier", r.ok === false && r.reason === "unknown_identifier" && r.error === "Invalid username or password.", JSON.stringify(r));
}
/* ==================== (iii) contractor → contractor_account ==================== */
{
  // Any password (never verifies against the random hash) → contractor_account.
  const r = await loginCore(DRIVER_HANDLE, "any-password-at-all-123");
  check("(iii) contractor by login_handle → contractor_account (fallback allowed)", r.ok === false && r.reason === "contractor_account", JSON.stringify(r));
}
{
  // The derived @towbook.driver-style email resolves the same contractor row.
  const r = await loginCore(DRIVER_EMAIL, "another-password-456");
  check("(iii) contractor by derived email → contractor_account", r.ok === false && r.reason === "contractor_account", JSON.stringify(r));
}
{
  // A contractor's real dispatch password (even a SHORT one — Towbook has no
  // minimum) must also classify as contractor_account, never invalid_input.
  const r = await loginCore(DRIVER_HANDLE, "abc");
  check("(iii) contractor with short password → contractor_account (not invalid_input)", r.ok === false && r.reason === "contractor_account", JSON.stringify(r));
}
/* ==================== no workspace ==================== */
{
  const r = await loginCore((await q`SELECT email FROM users WHERE id=${WORKSPACELESS}`)[0].email, "qa-no-workspace-password");
  check("real password but no workspace → no_workspace error (no fallback)", r.ok === false && r.reason === "no_workspace" && r.error.includes("no workspace"), JSON.stringify(r));
}
/* ============ Towbook manager/dispatcher upsert (owner-directed 2026-08-12) ============ */
// A Towbook account type 2 (manager/dispatcher) signs in as an OWNER: the LD
// user is upserted mirroring the contractor upsert — login_handle = the Towbook
// username lowercased, derived <handle>@towbook.manager email, random
// never-usable password hash, name from Towbook, membership role 'owner'.
{
  const handle = `qa-mgr-${randomUUID().slice(0, 10)}`;
  const tbUser = { userId: `822856-${randomUUID().slice(0, 6)}`, name: "Lightning Dispatch" };
  const a = await upsertTowbookOwnerUser(ORG, handle, tbUser);
  check("manager upsert creates an LD user", a.created === true && Boolean(a.userId));
  const rows = await q`SELECT u.name, u.email, u.login_handle, u.towbook_user_id, m.role, u.towbook_driver_id
    FROM users u JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${ORG}
    WHERE u.id = ${a.userId}`;
  check("owner user row: derived @towbook.manager email + lowercased handle + towbook_user_id + role owner",
    rows.length === 1 && String(rows[0].name) === "Lightning Dispatch"
      && String(rows[0].email) === `${handle}@towbook.manager`
      && String(rows[0].login_handle) === handle
      && String(rows[0].towbook_user_id) === tbUser.userId
      && String(rows[0].role) === "owner"
      && rows[0].towbook_driver_id == null, JSON.stringify(rows));
  // Idempotent: same handle (case-insensitive) + same Towbook user → reuse.
  const b = await upsertTowbookOwnerUser(ORG, handle.toUpperCase(), tbUser);
  check("manager upsert reuses the same LD user (no dupes)", b.created === false && b.userId === a.userId, JSON.stringify(b));
  const dupes = await q`SELECT COUNT(*)::int AS n FROM users WHERE login_handle = ${handle}`;
  check("no duplicate login_handle on re-upsert", Number(dupes[0].n) === 1);
  // RE-LOGIN path (critical): the manager's LD row is role 'owner' with a
  // random never-usable hash — their real password lives in Towbook. loginCore
  // must classify as contractor_account (Towbook fallback fires), NEVER
  // invalid_password (which would lock the manager out on the second sign-in).
  const again = await loginCore(handle, "their-real-towbook-password-123");
  check("manager re-login (owner row, @towbook.manager email) → contractor_account, fallback allowed",
    again.ok === false && again.reason === "contractor_account", JSON.stringify(again));
}
/* ==================== summary + cleanup ==================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`login-core.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa login-core%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa login-core%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-login-core-%@lightning.test'`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-mgr-%@towbook.manager'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa login-core%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-login-core-%@lightning.test' OR email LIKE 'qa-mgr-%@towbook.manager') AS users,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa login-core%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("login-core.test.mjs: cleanup verified — zero QA rows left");
