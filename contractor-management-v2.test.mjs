// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic Contractor Management v2 tests (2026-08-12): the OWNER-side v2
// surface built on the shipped cores (migration 27, commit c3e9e09) — vehicle
// save + roster display, schedule save/read via the owner core with the
// owner-override flag, the driver /driver/schedule round-trip via
// setMyScheduleCore (effective-driver: the owner-with-driver-identity acts as
// the driver at core level through the linked driver user), the expiring-soon
// + missing-docs roster filter data (listContractorsCore), and the
// DocCompareSheet data (license + live selfie present for facial-verification
// types, listContractorDocumentsCore). Real network calls never happen: doc
// rows are seeded directly. DB-backed against throwaway QA orgs deleted at the
// end (zero rows left).
//   DATABASE_URL=... bun contractor-management-v2.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const {
  getContractorDetailCore,
  getContractorScheduleCore,
  listContractorDocumentsCore,
  listContractorsCore,
  setContractorScheduleCore,
  setContractorVehicleCore,
  setMyScheduleCore,
} = await import("./src/data/contractor-admin-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const TAG = randomUUID();
const ORG = `qa-contractor-v2-${TAG}`;
const OWNER = `qa-contractor-v2-owner-${TAG}`;
const DRIVER = `qa-contractor-v2-driver-${TAG}`;
const OTHER_ORG = `qa-contractor-v2-other-${TAG}`;
const OTHER_OWNER = `qa-contractor-v2-other-owner-${TAG}`;
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const DRIVER_ACTOR = { orgId: ORG, id: DRIVER, role: "contractor" };
const OTHER_ACTOR = { orgId: OTHER_ORG, id: OTHER_OWNER, role: "owner" };
// expiry helpers — ISO date strings N days from today
const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
async function setup() {
  await ensureSchema();
  for (const [org, owner, driver] of [[ORG, OWNER, DRIVER], [OTHER_ORG, OTHER_OWNER, null]]) {
    await q`INSERT INTO organizations(id, name) VALUES(${org}, 'qa contractor v2')`;
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${owner}, 'QA V2 Owner', ${`qa-contractor-v2-owner-${TAG}@lightning.test`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${owner}, 'owner')`;
    if (driver) {
      await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES(${driver}, 'QA V2 Driver', ${`qa-contractor-v2-driver-${TAG}@lightning.test`}, 'x', 'v2-1001')`;
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${driver}, 'contractor')`;
      // owner-with-driver-identity (view-toggle shape): owner row links the driver.
      await q`UPDATE users SET linked_driver_user_id=${driver} WHERE id=${owner}`;
    }
  }
  // Required doc types: driver's license (facial + expiry) and insurance (expiry).
  await q`INSERT INTO contractor_doc_types(id, org_id, name, requires_expiry, requires_facial_verification, sort_order, active)
    VALUES('v2-license-${TAG}', ${ORG}, 'Driver license', TRUE, TRUE, 1, TRUE)`;
  await q`INSERT INTO contractor_doc_types(id, org_id, name, requires_expiry, requires_facial_verification, sort_order, active)
    VALUES('v2-insurance-${TAG}', ${ORG}, 'Insurance', TRUE, FALSE, 2, TRUE)`;
  await q`INSERT INTO contractor_doc_types(id, org_id, name, requires_expiry, sort_order, active)
    VALUES('v2-other-license-${TAG}', ${OTHER_ORG}, 'Other license', TRUE, 1, TRUE)`;
}
await setup();
/* ================= 1) vehicle save + roster display ================= */
{
  const r = await setContractorVehicleCore(ACTOR, {
    contractorId: DRIVER, type: "Flatbed", make: "Ford", model: "F-350", year: 2019,
    plate: "abc-123", plateState: "ct", color: "White",
  });
  check("vehicle: save ok (type + fields)", r.ok === true && r.data.vehicle.type === "Flatbed" && r.data.vehicle.make === "Ford" && r.data.vehicle.year === 2019 && r.data.vehicle.plate === "ABC-123" && r.data.vehicle.plateState === "CT", JSON.stringify(r));
  check("vehicle: legacy vehicle_desc overwritten with display string", r.ok === true && r.data.vehicleDesc !== null && r.data.vehicleDesc.includes("F-350") && r.data.vehicleDesc.includes("Flatbed") && r.data.vehicleDesc.includes("ABC-123"), r.ok ? r.data.vehicleDesc : JSON.stringify(r));
  const roster = await listContractorsCore(ACTOR);
  const row = roster.ok ? roster.data.find((c) => c.id === DRIVER) : null;
  check("roster: vehicleType surfaced for filter/display", row && row.vehicleType === "Flatbed", JSON.stringify(row));
  const detail = await getContractorDetailCore(ACTOR, { contractorId: DRIVER });
  check("detail: vehicle object present", detail.ok === true && detail.data.vehicle.type === "Flatbed" && detail.data.vehicleDesc.includes("F-350"), JSON.stringify(detail));
  const auth = await setContractorVehicleCore(DRIVER_ACTOR, { contractorId: DRIVER, type: null, make: null, model: null, year: null, plate: null, plateState: null, color: null });
  check("vehicle: contractor actor → unauthorized", auth.ok === false && auth.code === "unauthorized", JSON.stringify(auth));
}
/* ================= 2) schedule owner save/read + override flag ================= */
{
  const sched = [{ day: 1, start: "08:00", end: "17:00" }, { day: 2, start: "08:00", end: "17:00" }, { day: 5, start: "09:00", end: "15:00" }];
  const r = await setContractorScheduleCore(ACTOR, { contractorId: DRIVER, schedule: sched });
  check("schedule: owner save ok", r.ok === true, JSON.stringify(r));
  check("schedule: source=owner + ownerOverride=true", r.ok === true && r.data.source === "owner" && r.data.ownerOverride === true && r.data.schedule.length === 3, JSON.stringify(r));
  const g = await getContractorScheduleCore(ACTOR, { contractorId: DRIVER });
  check("schedule: getContractorScheduleCore round-trip", g.ok === true && g.data.ownerOverride === true && g.data.schedule.some((d) => d.day === 5 && d.start === "09:00"), JSON.stringify(g));
  const detail = await getContractorDetailCore(ACTOR, { contractorId: DRIVER });
  check("schedule: detail embeds the owner schedule", detail.ok === true && detail.data.schedule.ownerOverride === true && detail.data.schedule.schedule.length === 3, JSON.stringify(detail));
  const bad = await setContractorScheduleCore(ACTOR, { contractorId: DRIVER, schedule: [{ day: 1, start: "17:00", end: "08:00" }] });
  check("schedule: end-before-start rejected", bad.ok === false && bad.code === "invalid_input", JSON.stringify(bad));
  const iso2 = await setContractorScheduleCore(OTHER_ACTOR, { contractorId: DRIVER, schedule: [{ day: 1, start: "08:00", end: "09:00" }] });
  check("schedule: other org → not_found/denied (org isolation)", iso2.ok === false, JSON.stringify(iso2));
}
/* ============ 3) driver round-trip (effective-driver actor) ============ */
{
  const driverSched = [{ day: 3, start: "10:00", end: "18:00" }, { day: 4, start: "10:00", end: "18:00" }];
  const r = await setMyScheduleCore(DRIVER_ACTOR, { schedule: driverSched });
  check("driver: own schedule saved (contractor actor)", r.ok === true && r.data.source === "contractor" && r.data.ownerOverride === false && r.data.schedule.length === 2, JSON.stringify(r));
  const g = await getContractorScheduleCore(ACTOR, { contractorId: DRIVER });
  check("driver: owner sees the contractor-declared schedule (no override flag)", g.ok === true && g.data.ownerOverride === false && g.data.source === "contractor", JSON.stringify(g));
  // owner override now — driver edits must stop applying (v2 rule).
  const over = await setContractorScheduleCore(ACTOR, { contractorId: DRIVER, schedule: [{ day: 1, start: "07:00", end: "16:00" }] });
  check("driver: owner override re-saves + stays owner", over.ok === true && over.data.ownerOverride === true && over.data.schedule.length === 1, JSON.stringify(over));
  const blocked = await setMyScheduleCore(DRIVER_ACTOR, { schedule: [{ day: 6, start: "08:00", end: "17:00" }] });
  check("driver: schedule edits refused while owner-overridden", blocked.ok === false, JSON.stringify(blocked));
  const still = await getContractorScheduleCore(ACTOR, { contractorId: DRIVER });
  check("driver: owner schedule unchanged after blocked driver edit", still.ok === true && still.data.schedule.length === 1 && still.data.schedule[0].day === 1, JSON.stringify(still));
  const badActor = await setMyScheduleCore(ACTOR, { schedule: [] });
  check("driver: owner actor → unauthorized on driver core", badActor.ok === false && badActor.code === "unauthorized", JSON.stringify(badActor));
}
/* ============ 4) expiring-soon + missing-docs filter data ============ */
{
  // Driver license uploaded (expires in 9 days → expiring-soon rail); insurance missing.
  await q`INSERT INTO contractor_documents(id, org_id, contractor_id, doc_type_id, storage_key, file_name, mime, size_bytes, status, expires_on, uploaded_by_user_id)
    VALUES('v2-doc-license-${TAG}', ${ORG}, ${DRIVER}, 'v2-license-${TAG}', 'ld-docs/${ORG}/${DRIVER}/v2-license-${TAG}.jpg', 'license.jpg', 'image/jpeg', 2048, 'uploaded', ${iso(9)}, ${DRIVER})`;
  const roster = await listContractorsCore(ACTOR);
  const row = roster.ok ? roster.data.find((c) => c.id === DRIVER) : null;
  check("expiring: roster expiringSoonCount > 0 for ≤14-day expiry", row && row.expiringSoonCount >= 1, JSON.stringify(row));
  check("missing: requiredDocCount=2 > onFileDocCount=1 → filter rail", row && row.requiredDocCount === 2 && row.onFileDocCount === 1, JSON.stringify(row));
  const detail = await getContractorDetailCore(ACTOR, { contractorId: DRIVER });
  check("expiring: detail.docsExpiringSoon names the license", detail.ok === true && detail.data.docsExpiringSoon.length === 1 && detail.data.docsExpiringSoon[0].docTypeName === "Driver license", JSON.stringify(detail));
  // far-future expiry → not expiring soon (negative control): re-set the license to +60d.
  await q`UPDATE contractor_documents SET expires_on=${iso(60)} WHERE id='v2-doc-license-${TAG}'`;
  const roster2 = await listContractorsCore(ACTOR);
  const row2 = roster2.ok ? roster2.data.find((c) => c.id === DRIVER) : null;
  check("expiring: +60d expiry no longer counts", row2 && row2.expiringSoonCount === 0, JSON.stringify(row2));
}
/* ================= 5) DocCompareSheet data (license + selfie) ================= */
{
  await q`INSERT INTO contractor_doc_selfies(id, org_id, contractor_id, doc_type_id, storage_key, file_name, mime, size_bytes, uploaded_by_user_id)
    VALUES('v2-selfie-${TAG}', ${ORG}, ${DRIVER}, 'v2-license-${TAG}', 'ld-docs/${ORG}/${DRIVER}/v2-license-${TAG}-selfie.jpg', 'selfie.jpg', 'image/jpeg', 2048, ${DRIVER})`;
  const docs = await listContractorDocumentsCore(ACTOR, { contractorId: DRIVER });
  const license = docs.ok ? docs.data.find((d) => d.docTypeName === "Driver license") : null;
  check("compare: license row marks requiresFacialVerification", license && license.requiresFacialVerification === true, JSON.stringify(license));
  check("compare: license selfie uploaded (status + fileName present)", license && license.selfieStatus === "uploaded" && license.selfieFileName === "selfie.jpg", JSON.stringify(license));
  const insurance = docs.ok ? docs.data.find((d) => d.docTypeName === "Insurance") : null;
  check("compare: non-facial type has no selfie rail", insurance && insurance.requiresFacialVerification === false && insurance.selfieStatus === "none", JSON.stringify(insurance));
  const auth = await listContractorDocumentsCore(DRIVER_ACTOR, { contractorId: DRIVER });
  check("compare: contractor actor → unauthorized", auth.ok === false && auth.code === "unauthorized", JSON.stringify(auth));
}
/* ------------------------- cleanup: zero QA rows left ------------------------- */
const leftovers = await q`
  SELECT
    (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa contractor-v2%') AS orgs,
    (SELECT COUNT(*)::int FROM users WHERE email LIKE ${`qa-contractor-v2-%@lightning.test`}) AS users,
    (SELECT COUNT(*)::int FROM contractor_doc_types t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa contractor-v2%') AS types,
    (SELECT COUNT(*)::int FROM contractor_documents d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa contractor-v2%') AS docs,
    (SELECT COUNT(*)::int FROM contractor_doc_selfies s JOIN organizations o ON o.id=s.org_id WHERE o.name LIKE 'qa contractor-v2%') AS selfies,
    (SELECT COUNT(*)::int FROM contractor_schedules s JOIN organizations o ON o.id=s.org_id WHERE o.name LIKE 'qa contractor-v2%') AS scheds,
    (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa contractor-v2%') AS audit,
    (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa contractor-v2%') AS members`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa contractor-v2%'`) {
  await assertQaOrg(org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`;
}
const final = await q`
  SELECT
    (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa contractor-v2%') AS orgs,
    (SELECT COUNT(*)::int FROM users WHERE email LIKE ${`qa-contractor-v2-%@lightning.test`}) AS users,
    (SELECT COUNT(*)::int FROM contractor_doc_types t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa contractor-v2%') AS types,
    (SELECT COUNT(*)::int FROM contractor_documents d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa contractor-v2%') AS docs,
    (SELECT COUNT(*)::int FROM contractor_doc_selfies s JOIN organizations o ON o.id=s.org_id WHERE o.name LIKE 'qa contractor-v2%') AS selfies,
    (SELECT COUNT(*)::int FROM contractor_schedules s JOIN organizations o ON o.id=s.org_id WHERE o.name LIKE 'qa contractor-v2%') AS scheds,
    (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa contractor-v2%') AS audit,
    (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa contractor-v2%') AS members`;
check("cleanup: orgs/0", final[0].orgs === 0, JSON.stringify(final[0]));
check("cleanup: users/0", final[0].users === 0, JSON.stringify(final[0]));
check("cleanup: doc types/0", final[0].types === 0, JSON.stringify(final[0]));
check("cleanup: docs/0", final[0].docs === 0, JSON.stringify(final[0]));
check("cleanup: selfies/0", final[0].selfies === 0, JSON.stringify(final[0]));
check("cleanup: schedules/0", final[0].scheds === 0, JSON.stringify(final[0]));
check("cleanup: audit/0", final[0].audit === 0, JSON.stringify(final[0]));
check("cleanup: memberships/0", final[0].members === 0, JSON.stringify(final[0]));
console.log(`contractor-management-v2.test.mjs: ${checks.length}/${checks.length} passed (leftover rows before delete: ${JSON.stringify(leftovers[0])})`);
process.exit(0);
