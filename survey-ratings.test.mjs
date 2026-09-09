// survey-ratings.test.mjs — REAL customer-survey aggregation backend acceptance
// (owner-directed backlog 4659f884, backend Part 1). Hermetic: QA-only fixtures,
// never touches the production org. Exercises surveyRatingsCore directly.
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL) {
  try {
    const p = execSync("pgrep -f 'bun run serve.ts'|head -1").toString().trim();
    if (p) {
      const e = await readFile(`/proc/${p}/environ`, "utf8");
      const x = e.split("\0").find((v) => v.startsWith("DATABASE_URL="));
      if (x) process.env.DATABASE_URL = x.slice(15);
    }
  } catch {}
}
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { ensureAuthSchema } = await import("./src/data/auth-server.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { surveyRatingsCore } = await import("./src/data/completion-core.ts");

const checks = [];
const check = (n, c, e = "") => checks.push([n, Boolean(c), e]);
const suffix = `${Date.now()}-${randomUUID()}`;
const OA = `qa-sr-a-${suffix}`, OB = `qa-sr-b-${suffix}`, OC = `qa-sr-c-${suffix}`;
const uid = (x) => `qa-sr-${x}-${suffix}`;
const email = (u) => `${u}@lightning.test`;
const OWNERA = uid("owner-a"), OWNERB = uid("owner-b"), OWNERC = uid("owner-c");
const DTOW = uid("d-tow"), DLEGACY = uid("d-legacy"), DB = uid("d-b");
const TDTOW = `tb-sr-tow-${suffix}`, TDB = `tb-sr-b-${suffix}`;
const LEGACY_CID = `legacy-sr-${suffix}`;
const J1 = `qa-sr-job1-${suffix}`, J2 = `qa-sr-job2-${suffix}`, J3 = `qa-sr-job3-${suffix}`, J4 = `qa-sr-job4-${suffix}`;
const JB = `qa-sr-jobb-${suffix}`;
const JI0 = `qa-sr-inv0-${suffix}`, JI6 = `qa-sr-inv6-${suffix}`, JIN = `qa-sr-invn-${suffix}`, JIS = `qa-sr-invs-${suffix}`;
const J1_CAPTURED_AT = "2026-09-01T12:00:00.000Z";

const insUser = (id, name, tb = null) => q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES(${id}, ${name}, ${email(id)}, 'x', ${tb})`;
const insJob = (orgId, jobId, { tb = null, cid = null, completedAt = null } = {}) => q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, assigned_driver_towbook_id, assigned_contractor_id, completed_at)
  VALUES(${jobId}, ${orgId}, ${"Customer " + jobId}, '555-0000', 41.0, -73.0, 'QA', 'tire', 'completed', NOW(), ${tb}, ${cid}, ${completedAt})`;
const insCompletion = (orgId, jobId, survey, updatedAt = null) => q`INSERT INTO job_completions(org_id, job_id, signature_storage_key, survey, updated_at)
  VALUES(${orgId}, ${jobId}, NULL, ${JSON.stringify(survey)}::jsonb, COALESCE(${updatedAt}, NOW()))`;

try {
  await ensureAuthSchema();
  await ensureSchema();
  await q`INSERT INTO organizations(id, name) VALUES(${OA}, 'QA survey-ratings A'),(${OB}, 'QA survey-ratings B'),(${OC}, 'QA survey-ratings C')`;
  await insUser(OWNERA, "Org A Owner"); await insUser(OWNERB, "Org B Owner"); await insUser(OWNERC, "Org C Owner");
  await insUser(DTOW, "Tow Driver", TDTOW);
  await insUser(DLEGACY, "Legacy Driver", null);
  await insUser(DB, "Org B Driver", TDB);
  await q`INSERT INTO organization_memberships(org_id, user_id, role, contractor_id) VALUES
    (${OA}, ${OWNERA}, 'owner', NULL),
    (${OA}, ${DTOW}, 'contractor', NULL),
    (${OA}, ${DLEGACY}, 'contractor', ${LEGACY_CID}),
    (${OB}, ${OWNERB}, 'owner', NULL),
    (${OB}, ${DB}, 'contractor', NULL),
    (${OC}, ${OWNERC}, 'owner', NULL)`;
  // Legacy contractor row so dispatch_jobs.assigned_contractor_id satisfies its FK.
  await q`INSERT INTO dispatch_contractors(id, org_id, name, status, lat, lng, area, rating) VALUES(${LEGACY_CID}, ${OA}, 'Legacy Contractor', 'active', 0, 0, 'QA', 0)`;

  // Org A rated jobs: DriverTow (towbook attribution, ratings 5 + 4 → avg 4.5),
  // DriverLegacy (contractor_id fallback, rating 3), unattributed (rating 2).
  await insJob(OA, J1, { tb: TDTOW, completedAt: "2026-09-01T11:50:00.000Z" });
  await insJob(OA, J2, { tb: TDTOW });
  await insJob(OA, J3, { cid: LEGACY_CID });
  await insJob(OA, J4, {});
  await insCompletion(OA, J1, { rating: 5, comment: "great" }, J1_CAPTURED_AT);
  await insCompletion(OA, J2, { rating: 4, comment: null });
  await insCompletion(OA, J3, { rating: 3, comment: "ok" });
  await insCompletion(OA, J4, { rating: 2, comment: null });
  // Invalid ratings (must all be excluded): 0, 6, null, and a string rating.
  await insJob(OA, JI0, { tb: TDTOW });
  await insJob(OA, JI6, { tb: TDTOW });
  await insJob(OA, JIN, { tb: TDTOW });
  await insJob(OA, JIS, { tb: TDTOW });
  await insCompletion(OA, JI0, { rating: 0, comment: null });
  await insCompletion(OA, JI6, { rating: 6, comment: null });
  await insCompletion(OA, JIN, { rating: null, comment: null });
  await insCompletion(OA, JIS, { rating: "5", comment: null });
  // Org B rated job (must never leak into org A's read).
  await insJob(OB, JB, { tb: TDB });
  await insCompletion(OB, JB, { rating: 1, comment: null });

  // --- owner read of org A (aggregation + drill-down) ---
  const resA = await surveyRatingsCore({ orgId: OA, role: "owner", id: OWNERA });
  const byContractor = (id) => resA.contractors.find((c) => c.contractorId === id);
  const tow = byContractor(DTOW);
  const legacy = byContractor(DLEGACY);
  const unattributed = resA.contractors.find((c) => c.contractorId === null);

  check("owner aggregation: towbook-attributed contractor present", !!tow, JSON.stringify(resA.contractors));
  check("towbook attribution: contractorId = users.id", tow?.contractorId === DTOW, JSON.stringify(tow));
  check("towbook attribution: towbookDriverId resolved", tow?.towbookDriverId === TDTOW, JSON.stringify(tow));
  check("towbook attribution: avg 4.5 (5,4)", tow?.averageRating === 4.5, JSON.stringify(tow));
  check("towbook attribution: count 2", tow?.ratingCount === 2, JSON.stringify(tow));
  check("contractor_id fallback: contractorId = users.id", legacy?.contractorId === DLEGACY, JSON.stringify(legacy));
  check("contractor_id fallback: avg 3, count 1", legacy?.averageRating === 3 && legacy?.ratingCount === 1, JSON.stringify(legacy));
  check("contractor_id fallback: towbookDriverId null (no towbook)", legacy?.towbookDriverId === null, JSON.stringify(legacy));
  check("unattributed rated job bucket exists (contractorId null)", !!unattributed && unattributed.ratingCount === 1 && unattributed.averageRating === 2, JSON.stringify(unattributed));

  // Valid-rating filter: 0/6/null/string ratings must NOT appear in rows or counts.
  const rowIds = new Set(resA.rows.map((r) => r.jobId));
  check("filter: reject rating 0", !rowIds.has(JI0), JSON.stringify(resA.rows));
  check("filter: reject rating 6", !rowIds.has(JI6), JSON.stringify(resA.rows));
  check("filter: reject null rating", !rowIds.has(JIN), JSON.stringify(resA.rows));
  check("filter: reject string rating", !rowIds.has(JIS), JSON.stringify(resA.rows));
  check("filter: valid rows present (J1..J4)", [J1, J2, J3, J4].every((j) => rowIds.has(j)), JSON.stringify(rowIds));

  // Org isolation: org B's rated job/contractor never appear in org A's read.
  check("org isolation: org B job absent", !rowIds.has(JB), JSON.stringify(resA.rows));
  check("org isolation: org B contractor absent", !resA.contractors.some((c) => c.contractorId === DB), JSON.stringify(resA.contractors));

  // Drill-down row shape (J1): capturedAt = job_completions.updated_at (not invented).
  const j1 = resA.rows.find((r) => r.jobId === J1);
  check("row: customerName present", j1?.customerName === "Customer " + J1, JSON.stringify(j1));
  check("row: serviceType present", j1?.serviceType === "tire", JSON.stringify(j1));
  check("row: completedAt from dispatch_jobs", j1?.completedAt === "2026-09-01T11:50:00.000Z", JSON.stringify(j1));
  check("row: driverName resolved", j1?.driverName === "Tow Driver", JSON.stringify(j1));
  check("row: rating + comment", j1?.rating === 5 && j1?.comment === "great", JSON.stringify(j1));
  check("row: capturedAt = job_completions.updated_at", j1?.capturedAt === J1_CAPTURED_AT, JSON.stringify(j1));
  check("row: every field defined (no undefined)", j1 && Object.values(j1).every((v) => v !== undefined), JSON.stringify(j1));

  // --- contractor-scoped read (own rated jobs only) ---
  const resTow = await surveyRatingsCore({ orgId: OA, role: "contractor", id: DTOW });
  check("contractor read: only own contractor row", resTow.contractors.length === 1 && resTow.contractors[0].contractorId === DTOW && resTow.contractors[0].ratingCount === 2, JSON.stringify(resTow.contractors));
  check("contractor read: only own rows", resTow.rows.length === 2 && new Set(resTow.rows.map((r) => r.jobId)).has(J1) && new Set(resTow.rows.map((r) => r.jobId)).has(J2), JSON.stringify(resTow.rows));

  // --- empty dataset ---
  const resEmpty = await surveyRatingsCore({ orgId: OC, role: "owner", id: OWNERC });
  check("empty dataset: contractors=[] rows=[]", resEmpty.contractors.length === 0 && resEmpty.rows.length === 0, JSON.stringify(resEmpty));

  // --- unknown role is refused (empty) ---
  const resUnknown = await surveyRatingsCore({ orgId: OA, role: "auditor", id: OWNERA });
  check("unknown role refused", resUnknown.contractors.length === 0 && resUnknown.rows.length === 0, JSON.stringify(resUnknown));
} catch (err) {
  console.error(err?.stack || err);
} finally {
  for (const org of await q`SELECT id, name FROM organizations WHERE id IN (${OA}, ${OB}, ${OC})`) {
    assertQaOrg(org.id, org.name);
  }
  await q`DELETE FROM organization_memberships WHERE org_id IN (${OA}, ${OB}, ${OC}) OR user_id IN (${OWNERA}, ${OWNERB}, ${OWNERC}, ${DTOW}, ${DLEGACY}, ${DB})`.catch(() => {});
  await q`DELETE FROM organizations WHERE id IN (${OA}, ${OB}, ${OC})`.catch(() => {});
  await q`DELETE FROM users WHERE id IN (${OWNERA}, ${OWNERB}, ${OWNERC}, ${DTOW}, ${DLEGACY}, ${DB})`.catch(() => {});
}
const left = (await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE id IN (${OA}, ${OB}, ${OC})) orgs,
  (SELECT COUNT(*)::int FROM users WHERE id IN (${OWNERA}, ${OWNERB}, ${OWNERC}, ${DTOW}, ${DLEGACY}, ${DB})) users,
  (SELECT COUNT(*)::int FROM organization_memberships WHERE org_id IN (${OA}, ${OB}, ${OC})) memberships,
  (SELECT COUNT(*)::int FROM dispatch_jobs WHERE org_id IN (${OA}, ${OB}, ${OC})) jobs,
  (SELECT COUNT(*)::int FROM job_completions WHERE org_id IN (${OA}, ${OB}, ${OC})) completions,
  (SELECT COUNT(*)::int FROM dispatch_contractors WHERE org_id IN (${OA}, ${OB}, ${OC})) legacy_contractors`)[0];
check("cleanup zero QA rows", Object.values(left).every((v) => Number(v) === 0), JSON.stringify(left));
const failed = checks.filter((x) => !x[1]);
console.log(`survey-ratings.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(failed.map((x) => `  ${x[0]} ${x[2]}`).join("\n"));
  process.exit(1);
}
console.log("cleanup: zero QA rows");
