// DB safety (2026-09-04): org deletes guarded by assertQaOrg — see
// src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic test for SLICE 2 of the contractor sign-up-on-login-screen feature
// (owner-directed 2026-09-04, "Uber-style onboarding"): the OWNER-SIDE
// application review data path behind /owner/applications.
//   - listContractorApplicationsCore returns the application WITH the
//     applicant's LD name + email (the fields the owner review table shows);
//   - setContractorApplicationStatusCore submitted→activated records
//     reviewerUserId + reviewedAt on the row;
//   - a contractor actor is refused from list AND set (unauthorized, fail
//     closed — a contractor must never see/act on this page).
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun contractor-applications-ui.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const {
  signupContractorCore,
  submitContractorApplicationCore,
  listContractorApplicationsCore,
  setContractorApplicationStatusCore,
} = await import("./src/data/contractor-signup-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const TAG = randomUUID().slice(0, 8);
const ORG = `qa-applications-${TAG}`;
const OWNER = `qa-applications-owner-${TAG}`;
const email = (u) => `${u}-${randomUUID()}@lightning.test`;
const CONTRACTOR_NAME = "UI Test Contractor";
const CONTRACTOR_EMAIL = `qa-applications-driver-${randomUUID()}@lightning.test`;

const OWNER_ACTOR = { orgId: ORG, id: OWNER, role: "owner" };

async function cleanup() {
  const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-applications-%'`;
  for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa-applications-%'`) {
    assertQaOrg(org.id, org.name);
    await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
  }
  for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
  await q`DELETE FROM users WHERE email LIKE 'qa-applications-%@lightning.test'`.catch(() => {});
}
await cleanup();
await ensureSchema();
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa-applications')`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES(${OWNER}, 'QA Applications Owner', ${email(OWNER)}, 'x')`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OWNER}, 'owner')`;

/* ==================== seed an application via the real core ==================== */
const signup = await signupContractorCore(
  { name: CONTRACTOR_NAME, email: CONTRACTOR_EMAIL, password: "correct horse battery staple" },
  ORG,
);
check("seed: signup ok", signup.ok === true, JSON.stringify(signup));
const contractorId = signup.ok ? signup.userId : null;
const CONTRACTOR_ACTOR = { orgId: ORG, id: contractorId, role: "contractor" };

const submitted = await submitContractorApplicationCore(CONTRACTOR_ACTOR, {
  tools: ["jump_start", "tire_change", "lockout"],
  serviceArea: "New Haven, CT",
  phone: "203-555-0123",
});
check("seed: application submitted", submitted.ok === true && submitted.data.status === "submitted", JSON.stringify(submitted));
const appId = submitted.ok ? submitted.data.id : null;

/* ==================== 1) owner list returns the row + applicant identity ==================== */
{
  const list = await listContractorApplicationsCore(OWNER_ACTOR);
  check("owner list: ok", list.ok === true, JSON.stringify(list));
  const row = list.ok ? list.data.find((r) => r.id === appId) : null;
  check("owner list: contains the application", Boolean(row), JSON.stringify(list));
  check("owner list: applicant name joined from users", row?.applicantName === CONTRACTOR_NAME, JSON.stringify(row));
  check("owner list: applicant email joined from users", row?.applicantEmail === CONTRACTOR_EMAIL, JSON.stringify(row));
  check("owner list: core row fields present", Boolean(row && row.phone === "203-555-0123" && row.serviceArea === "New Haven, CT"), JSON.stringify(row));
  check("owner list: tools comma-join source is the array", Array.isArray(row?.tools) && row.tools.length === 3, JSON.stringify(row));
}

/* ==================== 2) submitted→activated records reviewer + reviewedAt ==================== */
{
  const set = await setContractorApplicationStatusCore(OWNER_ACTOR, { applicationId: appId, status: "activated" });
  check("owner set: submitted→activated ok", set.ok === true && set.data.status === "activated", JSON.stringify(set));
  check("owner set: reviewerUserId recorded", set.ok === true && set.data.reviewerUserId === OWNER, JSON.stringify(set));
  check("owner set: reviewedAt recorded", set.ok === true && typeof set.data.reviewedAt === "string" && set.data.reviewedAt.length > 0, JSON.stringify(set));

  const dbRow = await q`SELECT reviewer_user_id, reviewed_at, status FROM contractor_applications WHERE id=${appId}`;
  check("owner set: DB row persisted reviewer + reviewedAt",
    dbRow.length === 1 && String(dbRow[0].reviewer_user_id) === OWNER && dbRow[0].reviewed_at != null && String(dbRow[0].status) === "activated",
    JSON.stringify(dbRow));
}

/* ==================== 3) contractor actor refused (list + set) ==================== */
{
  const listDenied = await listContractorApplicationsCore(CONTRACTOR_ACTOR);
  check("contractor: list unauthorized", listDenied.ok === false && listDenied.code === "unauthorized", JSON.stringify(listDenied));

  const setDenied = await setContractorApplicationStatusCore(CONTRACTOR_ACTOR, { applicationId: appId, status: "waitlisted" });
  check("contractor: set unauthorized", setDenied.ok === false && setDenied.code === "unauthorized", JSON.stringify(setDenied));
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`contractor-applications-ui.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }

await cleanup();

const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa-applications-%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-applications-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM contractor_applications a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa-applications-%') AS apps,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-applications-%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("contractor-applications-ui.test.mjs: cleanup verified — zero QA rows left");
