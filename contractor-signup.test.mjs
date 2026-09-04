// DB safety (2026-09-04): org deletes guarded by assertQaOrg — see
// src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic tests for SLICE 1 of the contractor sign-up-on-login-screen feature
// (owner-directed 2026-09-04, "Uber-style onboarding" pulled from Phase C):
//   - signupContractorCore creates an LD user (role 'contractor') + membership,
//     hashes the password (not plaintext), and refuses a duplicate email;
//   - submit/getMy/list/setContractorApplicationStatus round-trip on the
//     contractor_applications table (status 'submitted' → owner 'activated');
//   - owner-only enforcement: a contractor actor is refused from list + set.
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun contractor-signup.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const {
  signupContractorCore,
  submitContractorApplicationCore,
  getMyApplicationStatusCore,
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
const ORG = `qa-signup-${TAG}`;
const OWNER = `qa-signup-owner-${TAG}`;
const email = (u) => `${u}-${randomUUID()}@lightning.test`;
const CONTRACTOR_EMAIL = `qa-signup-driver-${randomUUID()}@lightning.test`;

const OWNER_ACTOR = { orgId: ORG, id: OWNER, role: "owner" };

async function setup() {
  await ensureSchema();
  // Clean any crashed-run leftovers with the same prefix (assertQaOrg-guarded).
  const staleMembers = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-signup-%'`;
  for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa-signup-%'`) {
    assertQaOrg(org.id, org.name);
    await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
  }
  for (const m of staleMembers) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
  await q`DELETE FROM users WHERE email LIKE 'qa-signup-%@lightning.test'`.catch(() => {});

  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa-signup')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${OWNER}, 'QA Signup Owner', ${email(OWNER)}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OWNER}, 'owner')`;
}
await setup();

/* ==================== 1) signup: user + membership + hashing ==================== */
let contractorId;
{
  const res = await signupContractorCore(
    { name: "New Contractor", email: CONTRACTOR_EMAIL, password: "correct horse battery staple" },
    ORG,
  );
  check("signup: ok + returns a userId", res.ok === true && typeof res.userId === "string", JSON.stringify(res));
  contractorId = res.ok ? res.userId : null;

  const u = await q`SELECT id, name, email, password_hash FROM users WHERE id=${contractorId}`;
  check("signup: user row exists with matching email", u.length === 1 && String(u[0].email) === CONTRACTOR_EMAIL, JSON.stringify(u));
  check("signup: password is hashed (not plaintext, has salt:hash shape)",
    u.length === 1 && /^[0-9a-f]+:[0-9a-f]+$/.test(String(u[0].password_hash)) && !String(u[0].password_hash).includes("correct horse"), JSON.stringify(u));

  const m = await q`SELECT role FROM organization_memberships WHERE org_id=${ORG} AND user_id=${contractorId}`;
  check("signup: contractor membership in the target org", m.length === 1 && String(m[0].role) === "contractor", JSON.stringify(m));
}

/* ==================== 2) duplicate email rejection ==================== */
{
  const dup = await signupContractorCore(
    { name: "Another Contractor", email: CONTRACTOR_EMAIL.toUpperCase(), password: "another valid password" },
    ORG,
  );
  check("signup: duplicate email (case-insensitive) refused", dup.ok === false && /already registered/i.test(dup.error), JSON.stringify(dup));
  const count = await q`SELECT COUNT(*)::int AS n FROM users WHERE LOWER(email)=${CONTRACTOR_EMAIL.toLowerCase()}`;
  check("signup: no duplicate user row created", Number(count[0].n) === 1, JSON.stringify(count));
}

/* ==================== 3) application round-trip ==================== */
const CONTRACTOR_ACTOR = { orgId: ORG, id: contractorId, role: "contractor" };
let appId;
{
  const before = await getMyApplicationStatusCore(CONTRACTOR_ACTOR);
  check("app: no application before submit (null)", before.ok === true && before.data === null, JSON.stringify(before));

  const sub = await submitContractorApplicationCore(CONTRACTOR_ACTOR, {
    tools: ["jump_start", "tow", "battery_install", "jump_start"],
    serviceArea: "Bridgeport, CT",
    phone: "203-555-0100",
  });
  check("app: submit ok, status submitted, tools normalized + deduped",
    sub.ok === true && sub.data.status === "submitted" && sub.data.serviceArea === "Bridgeport, CT" && sub.data.phone === "203-555-0100",
    JSON.stringify(sub));
  // normalizeServiceSelectionType maps "tow"→heavy_tow and "battery_install"→battery_standard; jump_start dedupes.
  check("app: tools canonicalized to [battery_standard, heavy_tow, jump_start]",
    sub.ok === true && JSON.stringify(sub.data.tools) === JSON.stringify(["battery_standard", "heavy_tow", "jump_start"]), JSON.stringify(sub));
  appId = sub.ok ? sub.data.id : null;

  const mine = await getMyApplicationStatusCore(CONTRACTOR_ACTOR);
  check("app: getMy returns the submitted application", mine.ok === true && mine.data !== null && mine.data.id === appId, JSON.stringify(mine));

  const list = await listContractorApplicationsCore(OWNER_ACTOR);
  check("app: owner list contains the application", list.ok === true && list.data.some((r) => r.id === appId), JSON.stringify(list));

  const set = await setContractorApplicationStatusCore(OWNER_ACTOR, { applicationId: appId, status: "activated" });
  check("app: owner sets submitted→activated, reviewer recorded",
    set.ok === true && set.data.status === "activated" && set.data.reviewerUserId === OWNER && set.data.reviewedAt !== null, JSON.stringify(set));

  const mineAfter = await getMyApplicationStatusCore(CONTRACTOR_ACTOR);
  check("app: contractor sees the activated status", mineAfter.ok === true && mineAfter.data !== null && mineAfter.data.status === "activated", JSON.stringify(mineAfter));

  // Back-transition activated→submitted is allowed per the table.
  const back = await setContractorApplicationStatusCore(OWNER_ACTOR, { applicationId: appId, status: "submitted" });
  check("app: owner can move activated back to submitted", back.ok === true && back.data.status === "submitted", JSON.stringify(back));
}

/* ==================== 4) owner-only enforcement ==================== */
{
  const listDenied = await listContractorApplicationsCore(CONTRACTOR_ACTOR);
  check("app: contractor actor → list unauthorized", listDenied.ok === false && listDenied.code === "unauthorized", JSON.stringify(listDenied));

  const setDenied = await setContractorApplicationStatusCore(CONTRACTOR_ACTOR, { applicationId: appId, status: "activated" });
  check("app: contractor actor → set unauthorized", setDenied.ok === false && setDenied.code === "unauthorized", JSON.stringify(setDenied));

  // Unknown application id → not_found (owner actor, correct org).
  const missing = await setContractorApplicationStatusCore(OWNER_ACTOR, { applicationId: "nope", status: "activated" });
  check("app: unknown application → not_found", missing.ok === false && missing.code === "not_found", JSON.stringify(missing));

  // Disallowed transition (submitted→interested is not in the table).
  const bad = await setContractorApplicationStatusCore(OWNER_ACTOR, { applicationId: appId, status: "interested" });
  check("app: disallowed transition → invalid_input", bad.ok === false && bad.code === "invalid_input", JSON.stringify(bad));
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`contractor-signup.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }

const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-signup-%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa-signup-%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-signup-%@lightning.test'`.catch(() => {});

const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa-signup-%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-signup-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM contractor_applications a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa-signup-%') AS apps,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-signup-%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("contractor-signup.test.mjs: cleanup verified — zero QA rows left");
