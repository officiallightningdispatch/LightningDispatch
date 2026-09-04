// Hermetic account-deletion tests (Apple App Store requirement, 2026-09-03).
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
// Covers the REQUIRED behaviors:
//   1. contractor self-deletion removes profile / documents / selfies / job
//      photos / location history / payout methods / sessions (sign-out);
//   2. the users row becomes an anonymized tombstone (name scrubbed, email
//      rewritten, password hash replaced, Towbook/login identifiers cleared,
//      deactivated_at set) — so org-scoped FK history survives;
//   3. payroll/tax records (dispatch_jobs, payout_records, completion_tips,
//      contractor_form_submissions) are RETAINED;
//   4. owner/admin/staff accounts are REFUSED (staff_account) — the org is
//      never destroyed;
//   5. a contractor deleting does NOT touch a peer member's data or the org.
//   DATABASE_URL=... bun account-deletion.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
await import("@tanstack/start-server-core");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { ensureAuthSchema } = await import("./src/data/auth-server.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { deleteMyAccountCore, anonymizedEmail } = await import("./src/data/account-deletion-core.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa account-deletion ${randomUUID()}`;
const PREFIX = "qa-account-deletion";
const uid = (tag) => `${PREFIX}-${tag}-${randomUUID()}`;
const OWNER = uid("owner");
const DRIVER = uid("drv");
const OTHER = uid("oth");
const T_DRIVER = `tb-drv-${randomUUID().slice(0, 12)}`;
const T_OTHER = `tb-oth-${randomUUID().slice(0, 12)}`;
const email = (u) => `${u}@lightning.test`;
const DOC_TYPE = `${PREFIX}-doctype-${randomUUID()}`;
const PERIOD = `${PREFIX}-period-${randomUUID()}`;
const JOB = `${PREFIX}-job-${randomUUID()}`;
const FORM = `${PREFIX}-form-${randomUUID()}`;

const driverUser = {
  id: DRIVER,
  name: "Del Me",
  email: email(DRIVER),
  role: "contractor",
  orgId: ORG,
  driverIdentity: null,
};
const ownerUser = {
  id: OWNER,
  name: "The Owner",
  email: email(OWNER),
  role: "owner",
  orgId: ORG,
  driverIdentity: null,
};

/* ------------------------------ fixture ------------------------------ */
await ensureAuthSchema();
await ensureSchema();
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa account-deletion%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
await q`DELETE FROM users WHERE email LIKE 'qa-account-deletion-%@lightning.test'`.catch(() => {});
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
const ins = (id, name) => q`INSERT INTO users(id, name, email, password_hash) VALUES(${id}, ${name}, ${email(id)}, 'hash')`;
await ins(OWNER, "The Owner");
await ins(DRIVER, "Del Me");
await ins(OTHER, "Peer Driver");
await q`UPDATE users SET towbook_driver_id=${T_DRIVER}, towbook_user_id=${`tb-user-${DRIVER}`}, login_handle=${`handle-${DRIVER}`} WHERE id=${DRIVER}`;
await q`UPDATE users SET towbook_driver_id=${T_OTHER} WHERE id=${OTHER}`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'),
  (${ORG}, ${DRIVER}, 'contractor'),
  (${ORG}, ${OTHER}, 'contractor')`;

// Personal data rows to be REMOVED on deletion:
await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents, phone, vehicle_desc, profile_photo_key)
  VALUES(${ORG}, ${DRIVER}, 1600, '203-555-0100', '2020 Ford F-250', 'profile-photos/${ORG}/${DRIVER}/avatar')`;
await q`INSERT INTO contractor_doc_types(id, org_id, name, requires_expiry) VALUES(${DOC_TYPE}, ${ORG}, 'Driver License', TRUE)`;
await q`INSERT INTO contractor_documents(id, org_id, contractor_id, doc_type_id, storage_key, file_name, uploaded_by_user_id)
  VALUES(${`${DRIVER}-doc`}, ${ORG}, ${DRIVER}, ${DOC_TYPE}, 'docs/${ORG}/${DRIVER}/license.jpg', 'license.jpg', ${DRIVER})`;
await q`INSERT INTO contractor_doc_selfies(id, org_id, contractor_id, doc_type_id, storage_key, uploaded_by_user_id)
  VALUES(${`${DRIVER}-selfie`}, ${ORG}, ${DRIVER}, ${DOC_TYPE}, 'docs/${ORG}/${DRIVER}/selfie.jpg', ${DRIVER})`;
await q`INSERT INTO job_photos(id, org_id, job_id, phase, side, storage_key, uploaded_by_user_id)
  VALUES(${`${DRIVER}-photo`}, ${ORG}, 'some-job', 'arrival', 'front', 'photos/${ORG}/${DRIVER}/front.jpg', ${DRIVER})`;
await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, latitude, longitude)
  VALUES(${`${DRIVER}-loc`}, ${ORG}, ${DRIVER}, ${T_DRIVER}, 41.2, -73.2)`;
await q`INSERT INTO payout_methods(id, org_id, contractor_id, rail, handle) VALUES(${`${DRIVER}-pm`}, ${ORG}, ${DRIVER}, 'cash_app', '$delme')`;
await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${`${DRIVER}-sess`}, ${DRIVER}, NOW() + INTERVAL '1 day')`;
await q`INSERT INTO contractor_schedules(org_id, user_id, schedule, updated_by_user_id) VALUES(${ORG}, ${DRIVER}, '[]', ${DRIVER})`;
await q`INSERT INTO contractor_services(id, org_id, contractor_id, service_type, updated_by) VALUES(${`${DRIVER}-svc`}, ${ORG}, ${DRIVER}, 'jump_start', 'contractor')`;

// Payroll/tax records that must be RETAINED:
await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, assigned_driver_towbook_id)
  VALUES(${JOB}, ${ORG}, 'Customer', '', 0, 0, 'Bridgeport', 'jump_start', 'completed', NOW(), ${T_DRIVER})`;
await q`INSERT INTO pay_periods(id, org_id, starts_at, ends_at, payout_due_on) VALUES(${PERIOD}, ${ORG}, NOW() - INTERVAL '7 days', NOW(), CURRENT_DATE)`;
await q`INSERT INTO payout_records(id, org_id, period_id, contractor_id, rail, handle_full, handle_masked, gross_cents, status)
  VALUES(${`${DRIVER}-pr`}, ${ORG}, ${PERIOD}, ${DRIVER}, 'cash_app', '$delme', '$d***', 1600, 'computed')`;
await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, status)
  VALUES(${`${DRIVER}-tip`}, ${ORG}, ${JOB}, ${DRIVER}, ${T_DRIVER}, 500, 'paid')`;
await q`INSERT INTO contractor_form_submissions(id, org_id, contractor_id, doc_type_id, form_kind, pdf_storage_key, payload)
  VALUES(${FORM}, ${ORG}, ${DRIVER}, ${DOC_TYPE}, 'w9', 'forms/${ORG}/${DRIVER}/w9.pdf', '{}')`;

/* ------------------------- 1) contractor self-deletion ------------------------- */
const res = await deleteMyAccountCore(driverUser, { b2StableDir: "/tmp/qa-no-real-b2" });
check("contractor deletion returns ok", res.ok === true, JSON.stringify(res));

check("contractor_profiles removed", (await q`SELECT 1 FROM contractor_profiles WHERE org_id=${ORG} AND user_id=${DRIVER}`).length === 0);
check("contractor_documents removed", (await q`SELECT 1 FROM contractor_documents WHERE org_id=${ORG} AND contractor_id=${DRIVER}`).length === 0);
check("contractor_doc_selfies removed", (await q`SELECT 1 FROM contractor_doc_selfies WHERE org_id=${ORG} AND contractor_id=${DRIVER}`).length === 0);
check("job_photos removed", (await q`SELECT 1 FROM job_photos WHERE org_id=${ORG} AND uploaded_by_user_id=${DRIVER}`).length === 0);
check("driver_locations removed", (await q`SELECT 1 FROM driver_locations WHERE org_id=${ORG} AND driver_id=${DRIVER}`).length === 0);
check("payout_methods removed", (await q`SELECT 1 FROM payout_methods WHERE org_id=${ORG} AND contractor_id=${DRIVER}`).length === 0);
check("sessions removed (sign-out)", (await q`SELECT 1 FROM sessions WHERE user_id=${DRIVER}`).length === 0);
check("contractor_schedules removed", (await q`SELECT 1 FROM contractor_schedules WHERE org_id=${ORG} AND user_id=${DRIVER}`).length === 0);
check("contractor_services removed", (await q`SELECT 1 FROM contractor_services WHERE org_id=${ORG} AND contractor_id=${DRIVER}`).length === 0);

// users row is an anonymized tombstone, not a hard delete.
const tomb = (await q`SELECT name, email, password_hash, towbook_driver_id, towbook_user_id, login_handle, linked_driver_user_id, deactivated_at FROM users WHERE id=${DRIVER}`)[0];
check("users row survives as anonymized tombstone", Boolean(tomb), "row missing");
check("name scrubbed", tomb && tomb.name === "Deleted account");
check("email rewritten to non-identifying value", tomb && tomb.email === anonymizedEmail(DRIVER), JSON.stringify(tomb?.email));
check("password hash replaced", tomb && tomb.password_hash !== "hash" && tomb.password_hash.length > 0);
check("towbook_driver_id cleared", tomb && tomb.towbook_driver_id === null);
check("towbook_user_id cleared", tomb && tomb.towbook_user_id === null);
check("login_handle cleared", tomb && tomb.login_handle === null);
check("linked_driver_user_id cleared", tomb && tomb.linked_driver_user_id === null);
check("deactivated_at set", tomb && tomb.deactivated_at != null);

// Payroll/tax records RETAINED.
check("dispatch_jobs retained", (await q`SELECT 1 FROM dispatch_jobs WHERE org_id=${ORG} AND id=${JOB}`).length === 1);
check("payout_records retained", (await q`SELECT 1 FROM payout_records WHERE org_id=${ORG} AND contractor_id=${DRIVER}`).length === 1);
check("completion_tips retained", (await q`SELECT 1 FROM completion_tips WHERE org_id=${ORG} AND driver_id=${DRIVER}`).length === 1);
check("contractor_form_submissions retained", (await q`SELECT 1 FROM contractor_form_submissions WHERE org_id=${ORG} AND contractor_id=${DRIVER}`).length === 1);
check("audit_log row written", (await q`SELECT 1 FROM audit_log WHERE org_id=${ORG} AND action='account_deleted' AND entity_id=${DRIVER}`).length === 1);

// Org + peer member untouched.
check("org never destroyed", (await q`SELECT 1 FROM organizations WHERE id=${ORG}`).length === 1);
check("peer contractor profile untouched", (await q`SELECT 1 FROM organization_memberships WHERE org_id=${ORG} AND user_id=${OTHER}`).length === 1);

/* ------------------------- 2) owner self-deletion refused ------------------------- */
const ownerRes = await deleteMyAccountCore(ownerUser, { b2StableDir: "/tmp/qa-no-real-b2" });
check("owner deletion refused", ownerRes.ok === false && ownerRes.code === "staff_account", JSON.stringify(ownerRes));
check("owner users row intact", (await q`SELECT 1 FROM users WHERE id=${OWNER} AND deactivated_at IS NULL`).length === 1);
check("owner sessions intact", (await q`SELECT 1 FROM users WHERE id=${OWNER}`).length === 1);

/* ------------------------- 3) idempotent (already-deleted) ------------------------- */
const again = await deleteMyAccountCore(driverUser, { b2StableDir: "/tmp/qa-no-real-b2" });
check("second deletion refused as already-deleted", again.ok === false && again.code === "already_deleted", JSON.stringify(again));

/* ------------------------------- summary + cleanup ------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`account-deletion.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }

const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa account-deletion%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-account-deletion-%@lightning.test' OR email LIKE 'deleted+qa-account-deletion-%@account-deleted.lightningdispatch.app') AS users,
  (SELECT COUNT(*)::int FROM contractor_profiles WHERE org_id=${ORG}) AS profiles,
  (SELECT COUNT(*)::int FROM driver_locations WHERE org_id=${ORG}) AS locs,
  (SELECT COUNT(*)::int FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email LIKE 'qa-account-deletion-%@lightning.test') AS sessions`;
// Cleanup: delete the QA org (cascades org-scoped rows) then any leftover QA users.
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa account-deletion%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
await q`DELETE FROM users WHERE email LIKE 'qa-account-deletion-%@lightning.test'`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'deleted+qa-account-deletion-%@account-deleted.lightningdispatch.app'`.catch(() => {});
const final = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa account-deletion%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-account-deletion-%@lightning.test' OR email LIKE 'deleted+qa-account-deletion-%@account-deleted.lightningdispatch.app') AS users`;
const clean = Object.values(final[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify({ before: leftover[0], after: final[0] })}`);
if (!clean) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("account-deletion.test.mjs: cleanup verified — zero QA rows left");
