// Hermetic inactive-account sign-in refusal tests (owner-clarified 2026-08-12:
// "inactive/deactivated accounts on Towbook get NO access. Only active drivers,
// managers, and dispatchers sign in."). HEAD fb0dca2 harden delta on e832369:
//   (a) Towbook disabled:true refused with exact white-label copy — and NOT
//       an expired-session signal (identifyDriver, pure). The status is the
//       `disabled` BOOLEAN from the /api/users list (owner-corrected
//       2026-08-13 — type 3 is a normal driver category, NOT a status).
//   (b) deactivated LD DRIVER refused on the contractor path: isDriverDeactivated
//       matches on BOTH towbook_driver_id and towbook_user_id (roster-fallback /
//       id-shift coverage) and loginCore refuses a deactivated contractor row
//       BEFORE the contractor_account fallthrough (never reaches Towbook).
//   (c) deactivated LD owner/admin refused on the owner path: loginCore refuses
//       even with the CORRECT password, and upsertTowbookOwnerUser (the type-2
//       Towbook manager path) hard-refuses a deactivated row by login_handle OR
//       towbook_user_id — no owner session is ever started for it.
//   (d) active regressions: active driver rows are NOT deactivated; active LD
//       owner still logs in; active type-2 manager still re-upserts.
// NOTE ON SCOPE: driverLogin itself is NOT invoked end-to-end here — its
// resolveOwnerOrgId() resolves the FIRST owner membership globally, which in the
// shared QA/production database is the PRODUCTION org; a driverLogin success
// path would upsert QA fixture rows into production. Every gate driverLogin
// calls (identifyDriver, isDriverDeactivated, loginCore-fallback classification,
// upsertTowbookOwnerUser) is instead exercised directly with an explicit QA org.
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun inactive-account.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { hash, loginCore, upsertTowbookOwnerUser } = await import("./src/data/auth-server.ts");
const { isDriverDeactivated } = await import("./src/data/driver-gps-core.ts");
const { identifyDriver } = await import("./src/data/driver-auth.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ORG = `qa inactive-account ${randomUUID()}`;
const PREFIX = "qa-inactive-account";
const uid = (tag) => `qa-${PREFIX}-${tag}-${randomUUID()}`;
const email = (tag) => `${PREFIX}-${tag}-${randomUUID()}@lightning.test`;
const handle = (tag) => `${PREFIX}-${tag}-${randomUUID().slice(0, 12)}`;
const tbId = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 1_000_000_000n);
const PASSWORD = "qa-real-password-123"; // >= 10 chars (owner rows verify)
const DACT_DRV = uid("drv-deact");
const DACT_FB = uid("drv-fallback"); // roster id changed between sign-ins
const ACT_DRV = uid("drv-active");
const DACT_OWNER = uid("owner-deact");
const ACT_OWNER = uid("owner-active");
const DACT_MGR = uid("mgr-deact");
const ACT_MGR = uid("mgr-active");
const DACT_DRV_TB = tbId(uid("td1"));   // towbook driver id == towbook user id
const DACT_FB_DRIVER = tbId(uid("tf1")); // OLD roster driver id (stale key)
const DACT_FB_USER = tbId(uid("tu1"));   // stable towbook USER id
const ACT_DRV_TB = tbId(uid("ta1"));
const DACT_MGR_TB = tbId(uid("tm1"));
const ACT_MGR_TB = tbId(uid("tm2"));
const DACT_DRV_HANDLE = handle("drv");
const DACT_FB_HANDLE = handle("fb");
const ACT_DRV_HANDLE = handle("act");
const DACT_MGR_HANDLE = handle("mgr");
const ACT_MGR_HANDLE = handle("mgr2");
const DACT_MGR_EMAIL = `${DACT_MGR_HANDLE}@towbook.manager`;
const ACT_MGR_EMAIL = `${ACT_MGR_HANDLE}@towbook.manager`;
/* ------------------------------ fixture ------------------------------ */
await ensureSchema();
// sweep any leftovers from earlier crashed runs (QA-prefixed only)
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa inactive-account%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa inactive-account fixture')`;
// (b) deactivated driver — normal roster key (driver id == user id)
await q`INSERT INTO users(id, name, email, password_hash, login_handle, towbook_driver_id, towbook_user_id, deactivated_at)
  VALUES(${DACT_DRV}, 'QA Deactivated Driver', ${email("drv")}, ${hash(Math.random().toString(36))}, ${DACT_DRV_HANDLE}, ${DACT_DRV_TB}, ${DACT_DRV_TB}, NOW())`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DACT_DRV}, 'contractor')`;
// (b) deactivated driver whose roster DRIVER id changed (id-shift / roster
//     fallback): only the stable towbook_user_id still identifies them.
await q`INSERT INTO users(id, name, email, password_hash, login_handle, towbook_driver_id, towbook_user_id, deactivated_at)
  VALUES(${DACT_FB}, 'QA Fallback Driver', ${email("fb")}, ${hash(Math.random().toString(36))}, ${DACT_FB_HANDLE}, ${DACT_FB_DRIVER}, ${DACT_FB_USER}, NOW())`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DACT_FB}, 'contractor')`;
// (d) active driver — same shape, deactivated_at NULL
await q`INSERT INTO users(id, name, email, password_hash, login_handle, towbook_driver_id, towbook_user_id)
  VALUES(${ACT_DRV}, 'QA Active Driver', ${email("act")}, ${hash(Math.random().toString(36))}, ${ACT_DRV_HANDLE}, ${ACT_DRV_TB}, ${ACT_DRV_TB})`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${ACT_DRV}, 'contractor')`;
// (c) deactivated LD owner — real password, would pass verification
await q`INSERT INTO users(id, name, email, password_hash, login_handle, deactivated_at)
  VALUES(${DACT_OWNER}, 'QA Deactivated Owner', ${email("od")}, ${hash(PASSWORD)}, ${handle("od")}, NOW())`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DACT_OWNER}, 'owner')`;
// (d) active LD owner — real password
await q`INSERT INTO users(id, name, email, password_hash, login_handle)
  VALUES(${ACT_OWNER}, 'QA Active Owner', ${email("oa")}, ${hash(PASSWORD)}, ${handle("oa")})`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${ACT_OWNER}, 'owner')`;
// (c) deactivated Towbook manager mirror (role owner, @towbook.manager email,
//     random never-usable hash — the upsertTowbookOwnerUser row shape)
await q`INSERT INTO users(id, name, email, password_hash, login_handle, towbook_user_id, deactivated_at)
  VALUES(${DACT_MGR}, 'QA Deactivated Manager', ${DACT_MGR_EMAIL}, ${hash(Math.random().toString(36))}, ${DACT_MGR_HANDLE}, ${DACT_MGR_TB}, NOW())`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DACT_MGR}, 'owner')`;
// (d) active Towbook manager mirror
await q`INSERT INTO users(id, name, email, password_hash, login_handle, towbook_user_id)
  VALUES(${ACT_MGR}, 'QA Active Manager', ${ACT_MGR_EMAIL}, ${hash(Math.random().toString(36))}, ${ACT_MGR_HANDLE}, ${ACT_MGR_TB})`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${ACT_MGR}, 'owner')`;
/* ============ (a) Towbook disabled:true → refused, exact copy ============ */
{
  const jsonFetch = (routes) => async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const hit = routes[key] ?? routes[url];
    if (!hit) throw new Error(`no route for ${key}`);
    const { status = 200, body } = hit;
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), json: async () => JSON.parse(JSON.stringify(body)) };
  };
  // Real refusal shape: type 3 is a NORMAL driver category; the status is the
  // `disabled` boolean and only the /api/users LIST carries it (owner-corrected
  // 2026-08-13 — /api/user never includes `disabled`, verified live).
  const r = await identifyDriver({ cookies: "c=1", baseUrl: "https://app.towbook.com" }, {
    fetchImpl: jsonFetch({
      "GET https://app.towbook.com/api/user": { body: { id: 449284, name: "Jin Lugo CT", type: 3 } },
      "GET https://app.towbook.com/api/users": { body: [{ id: 449284, name: "Jin Lugo CT", type: 3, disabled: true }] },
    }),
  });
  check("(a) disabled:true (type 3) → refused with the EXACT white-label copy (no brand leakage)",
    !r.ok && r.message === "This account is disabled — contact the owner." && !String(r.message).includes("Towbook"), JSON.stringify(r));
  check("(a) disabled:true → not an expired-session signal (no silent reconnect)",
    !r.ok && r.expired !== true, JSON.stringify(r));
}
/* ==================== (b) deactivated driver — contractor path ==================== */
{
  check("(b) isDriverDeactivated true for a deactivated driver (towbook_driver_id key)",
    await isDriverDeactivated(ORG, DACT_DRV_TB) === true);
  // Id-shift / roster-fallback coverage: the row's towbook_driver_id is the OLD
  // roster id, so only the stable towbook_user_id still identifies it — the
  // pre-harden query (towbook_driver_id only) would have returned false here
  // and let a removed driver back in.
  check("(b) isDriverDeactivated true via towbook_user_id (id-shift / roster fallback)",
    await isDriverDeactivated(ORG, DACT_FB_USER) === true);
  // loginCore: a deactivated contractor must be refused BEFORE the
  // contractor_account classification — the login UI would otherwise fall
  // through to the Towbook driver flow (which driverLogin also blocks, but the
  // fallback must not even fire for a disabled account).
  const r = await loginCore(DACT_DRV_HANDLE, "any-password-at-all-123");
  check("(b) loginCore deactivated contractor → reason 'deactivated', never contractor_account",
    r.ok === false && r.reason === "deactivated" && r.error === "This account is disabled — contact the owner.", JSON.stringify(r));
}
/* ==================== (c) deactivated owner/admin — owner path ==================== */
{
  const r = await loginCore((await q`SELECT email FROM users WHERE id=${DACT_OWNER}`)[0].email, PASSWORD);
  check("(c) loginCore deactivated owner with CORRECT password → refused, reason 'deactivated'",
    r.ok === false && r.reason === "deactivated" && r.error === "This account is disabled — contact the owner.", JSON.stringify(r));
  const sess = await q`SELECT 1 FROM sessions WHERE user_id=${DACT_OWNER}`;
  check("(c) no LD session row for the deactivated owner (login never grants one)",
    sess.length === 0);
  // type-2 Towbook manager path: the upsert must hard-refuse a deactivated row.
  let threw = null;
  try { await upsertTowbookOwnerUser(ORG, DACT_MGR_HANDLE, { userId: DACT_MGR_TB, name: "QA Mgr" }); } catch (err) { threw = err; }
  check("(c) upsertTowbookOwnerUser throws 'disabled' for a deactivated manager (login_handle match)",
    threw instanceof Error && String(threw.message) === "This account is disabled — contact the owner.", String(threw));
  let threw2 = null;
  try { await upsertTowbookOwnerUser(ORG, handle("other"), { userId: DACT_MGR_TB, name: "QA Mgr" }); } catch (err) { threw2 = err; }
  check("(c) upsertTowbookOwnerUser throws 'disabled' even when matched only by towbook_user_id",
    threw2 instanceof Error && String(threw2.message) === "This account is disabled — contact the owner.", String(threw2));
  const row = await q`SELECT name FROM users WHERE id=${DACT_MGR}`;
  check("(c) deactivated manager row untouched by the refused upsert (no reactivation, no rename)",
    row.length === 1 && String(row[0].name) === "QA Deactivated Manager");
}
/* ==================== (d) active regressions ==================== */
{
  check("(d) active driver row → isDriverDeactivated false",
    await isDriverDeactivated(ORG, ACT_DRV_TB) === false);
  check("(d) never-seen driver id → isDriverDeactivated false (new drivers still sign in)",
    await isDriverDeactivated(ORG, tbId(uid("nope"))) === false);
  const ok = await loginCore((await q`SELECT email FROM users WHERE id=${ACT_OWNER}`)[0].email, PASSWORD);
  check("(d) active LD owner with correct password → still ok, role owner",
    ok.ok === true && ok.role === "owner", JSON.stringify(ok));
  const re = await upsertTowbookOwnerUser(ORG, ACT_MGR_HANDLE.toUpperCase(), { userId: ACT_MGR_TB, name: "QA Active Manager" });
  check("(d) active type-2 manager re-upsert → reuses the row (no new user, no throw)",
    re.created === false && re.userId === ACT_MGR, JSON.stringify(re));
}
/* ==================== summary + cleanup ==================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`inactive-account.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa inactive-account%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa inactive-account%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-inactive-account-%@lightning.test'`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-inactive-account-%@towbook.manager'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa inactive-account%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-inactive-account-%@lightning.test' OR email LIKE 'qa-inactive-account-%@towbook.manager') AS users,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa inactive-account%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("inactive-account.test.mjs: cleanup verified — zero QA rows left");
