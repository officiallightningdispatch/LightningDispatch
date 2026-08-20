// Hermetic service-selection gate suite. Uses only throwaway QA rows and
// exercises the server-only authorization/core functions directly.
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";

const q = neon(process.env.DATABASE_URL);
const {
  ensureSchema,
  seedContractorServicesFromHistory,
  serviceSelectionMatchesJob,
} = await import("./src/data/migrations.ts");
const {
  canonicalServiceSelectionTypes,
  normalizeSelectedServices,
  getMyServicesCore,
  setMyServicesCore,
  listContractorServicesCore,
  setContractorServicesCore,
  bulkSetContractorServicesCore,
} = await import("./src/data/service-selection-core.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");

const checks = [];
const check = (name, condition, detail = "") => {
  checks.push([name, Boolean(condition), detail]);
  if (!condition)
    throw new Error(`FAIL: ${name}${detail ? ` (${detail})` : ""}`);
};
const ORG = `qa-service-selection-${randomUUID()}`;
const OWNER = `qa-service-owner-${randomUUID()}`;
const CONTRACTOR = `qa-service-contractor-${randomUUID()}`;
const CONTRACTOR2 = `qa-service-contractor-${randomUUID()}`;
const OWNER_DRIVER = `qa-service-owner-driver-${randomUUID()}`;
const PURE_ADMIN = `qa-service-pure-admin-${randomUUID()}`;
const NON_OWNER = `qa-service-non-owner-${randomUUID()}`;
const TB1 = String(8_000_000 + Math.floor(Math.random() * 999_999));
const TB2 = String(Number(TB1) + 1);
const TB_OWNER_DRIVER = String(Number(TB2) + 1);
let created = false;

const ownerActor = { orgId: ORG, id: OWNER, role: "owner" };
const contractorActor = { orgId: ORG, id: CONTRACTOR, role: "contractor" };
const contractor2Actor = { orgId: ORG, id: CONTRACTOR2, role: "contractor" };
const nonOwnerActor = { orgId: ORG, id: NON_OWNER, role: "dispatcher" };

try {
  await ensureSchema();
  await q`INSERT INTO organizations(id,name) VALUES(${ORG},'qa service selection')`;
  await q`INSERT INTO users(id,name,email,password_hash,towbook_driver_id) VALUES
    (${OWNER},'QA Service Owner',${`${OWNER}@qa.local`},'x',NULL),
    (${CONTRACTOR},'QA Service Contractor',${`${CONTRACTOR}@qa.local`},'x',${TB1}),
    (${CONTRACTOR2},'QA Service Contractor 2',${`${CONTRACTOR2}@qa.local`},'x',${TB2}),
    (${OWNER_DRIVER},'QA Owner Driver Identity',${`${OWNER_DRIVER}@qa.local`},'x',${TB_OWNER_DRIVER}),
    (${PURE_ADMIN},'QA Pure Admin',${`${PURE_ADMIN}@qa.local`},'x',NULL),
    (${NON_OWNER},'QA Service Dispatcher',${`${NON_OWNER}@qa.local`},'x',NULL)`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES
    (${ORG},${OWNER},'owner'),(${ORG},${CONTRACTOR},'contractor'),
    (${ORG},${CONTRACTOR2},'contractor'),(${ORG},${OWNER_DRIVER},'owner'),
    (${ORG},${PURE_ADMIN},'admin'),(${ORG},${NON_OWNER},'dispatcher')`;
  await q`INSERT INTO towbook_sessions(org_id,encrypted_session,status,session_kind,towbook_driver_id)
    VALUES(${ORG},'qa-owner-driver-session','connected','driver',${TB_OWNER_DRIVER})`;
  created = true;

  check(
    "canonical options are bounded",
    canonicalServiceSelectionTypes().includes("jump_start") &&
      !canonicalServiceSelectionTypes().includes("bogus"),
  );
  check(
    "normalization canonicalizes aliases and removes unknowns",
    JSON.stringify(
      normalizeSelectedServices([
        "Jump Start",
        "jump_start",
        "TIRE CHANGE",
        "bogus",
      ]),
    ) === JSON.stringify(["jump_start", "tire_change"]),
  );

  const ownSet = await setMyServicesCore(contractorActor, {
    services: ["Jump Start", "jump_start", "TIRE CHANGE", "not-a-service"],
  });
  check(
    "contractor can set own services canonically",
    ownSet.ok &&
      JSON.stringify(ownSet.data.selectedServices) ===
        JSON.stringify(["jump_start", "tire_change"]),
  );
  const ownRead = await getMyServicesCore(contractorActor);
  check(
    "contractor can read own services",
    ownRead.ok &&
      ownRead.data.services.contractorId === CONTRACTOR &&
      ownRead.data.services.selectedServices.includes("jump_start"),
  );

  const ownerIdentityMembership = await q`SELECT role FROM organization_memberships WHERE org_id=${ORG} AND user_id=${OWNER_DRIVER}`;
  const ownerRoster = await listContractorServicesCore(ownerActor);
  const ownerIdentityEdit = await setContractorServicesCore(ownerActor, {
    contractorId: OWNER_DRIVER,
    services: ["Battery Standard"],
  });
  const pureAdminEdit = await setContractorServicesCore(ownerActor, {
    contractorId: PURE_ADMIN,
    services: ["fuel"],
  });
  check(
    "owner identity driver is an owner member, not a contractor member",
    ownerIdentityMembership.length === 1 && ownerIdentityMembership[0].role === "owner",
  );
  check(
    "owner identity driver appears in owner service roster",
    ownerRoster.ok &&
      ownerRoster.data.some((row) => row.contractorId === OWNER_DRIVER) &&
      !ownerRoster.data.some((row) => row.contractorId === PURE_ADMIN),
  );
  check(
    "owner identity driver can be edited by owner",
    ownerIdentityEdit.ok &&
      ownerIdentityEdit.data.contractorId === OWNER_DRIVER &&
      JSON.stringify(ownerIdentityEdit.data.selectedServices) ===
        JSON.stringify(["battery_standard"]),
  );
  check(
    "pure admin without driver identity is not a contractor",
    !pureAdminEdit.ok && pureAdminEdit.code === "not_found",
  );

  const nonOwnerList = await listContractorServicesCore(nonOwnerActor);
  const nonOwnerEdit = await setContractorServicesCore(nonOwnerActor, {
    contractorId: CONTRACTOR,
    services: ["fuel"],
  });
  const contractorOwnerEdit = await setContractorServicesCore(contractorActor, {
    contractorId: CONTRACTOR2,
    services: ["fuel"],
  });
  check(
    "non-owner cannot call owner list endpoint",
    !nonOwnerList.ok && nonOwnerList.code === "unauthorized",
  );
  check(
    "non-owner cannot call owner individual endpoint",
    !nonOwnerEdit.ok && nonOwnerEdit.code === "unauthorized",
  );
  check(
    "contractor cannot edit another contractor",
    !contractorOwnerEdit.ok && contractorOwnerEdit.code === "unauthorized",
  );

  const individual = await setContractorServicesCore(ownerActor, {
    contractorId: CONTRACTOR2,
    services: ["Fuel Delivery", "fuel_delivery", "unknown"],
  });
  check(
    "owner individual edit succeeds",
    individual.ok &&
      JSON.stringify(individual.data.selectedServices) ===
        JSON.stringify(["fuel_delivery"]),
  );

  const bulk = await bulkSetContractorServicesCore(ownerActor, {
    contractorIds: [CONTRACTOR, CONTRACTOR2],
    services: ["Unlock", "Jump Start"],
  });
  const bulkRows = await listContractorServicesCore(ownerActor);
  const selectedById = new Map(
    bulkRows.ok
      ? bulkRows.data.map((r) => [r.contractorId, r.selectedServices])
      : [],
  );
  check(
    "owner bulk edit updates every contractor",
    bulk.ok &&
      bulk.data.updated === 2 &&
      JSON.stringify(selectedById.get(CONTRACTOR)) ===
        JSON.stringify(["jump_start", "lockout"]) &&
      JSON.stringify(selectedById.get(CONTRACTOR2)) ===
        JSON.stringify(["jump_start", "lockout"]),
  );

  const beforeAtomic = await listContractorServicesCore(ownerActor);
  const invalidBulk = await bulkSetContractorServicesCore(ownerActor, {
    contractorIds: [CONTRACTOR, `missing-${randomUUID()}`],
    services: ["fuel"],
  });
  const afterAtomic = await listContractorServicesCore(ownerActor);
  check(
    "owner bulk edit rejects invalid roster atomically",
    !invalidBulk.ok &&
      invalidBulk.code === "not_found" &&
      JSON.stringify(
        beforeAtomic.data.find((r) => r.contractorId === CONTRACTOR)
          ?.selectedServices,
      ) ===
        JSON.stringify(
          afterAtomic.data.find((r) => r.contractorId === CONTRACTOR)
            ?.selectedServices,
        ),
  );

  check(
    "dispatch service gate fails closed for empty list",
    !serviceSelectionMatchesJob("jump start", []),
  );
  check(
    "dispatch service gate fails closed for non-covering list",
    !serviceSelectionMatchesJob("jump start", ["fuel_delivery"]),
  );
  check(
    "dispatch service gate passes for covering list",
    serviceSelectionMatchesJob("jump start", ["jump_start"]),
  );
  check(
    "unknown dispatch service fails closed",
    !serviceSelectionMatchesJob("unclassified roadside work", [
      "jump_start",
      "fuel_delivery",
    ]),
  );

  await q`DELETE FROM contractor_services WHERE org_id=${ORG}`;
  await q`INSERT INTO dispatch_jobs(id,org_id,customer_name,phone,lat,lng,area,service_type,status,created_at,assigned_driver_towbook_id,towbook_status)
    VALUES
      (${`qa-seed-job-${randomUUID()}`},${ORG},'Seed Jump','',41.2,-73.2,'Bridgeport','Jump Start','completed',NOW(),${TB1},'252'),
      (${`qa-seed-job-${randomUUID()}`},${ORG},'Seed Tow','',41.2,-73.2,'Bridgeport','Heavy Tow','completed',NOW(),${TB2},'252')`;
  await seedContractorServicesFromHistory(q);
  const seeded =
    await q`SELECT contractor_id,service_type,updated_by FROM contractor_services WHERE org_id=${ORG} ORDER BY contractor_id,service_type`;
  check(
    "seed-from-history populates active contractors",
    seeded.length === 2 &&
      seeded.some(
        (r) =>
          r.contractor_id === CONTRACTOR &&
          r.service_type === "jump_start" &&
          r.updated_by === "seed",
      ) &&
      seeded.some(
        (r) =>
          r.contractor_id === CONTRACTOR2 &&
          r.service_type === "heavy_tow" &&
          r.updated_by === "seed",
      ),
  );

  const audits =
    await q`SELECT action,actor_user_id,detail FROM audit_log WHERE org_id=${ORG} AND actor_user_id=${OWNER} AND action IN ('owner_contractor_services_updated','owner_bulk_contractor_services_updated') ORDER BY occurred_at`;
  check(
    "audit rows are written for owner edits",
    audits.length >= 2 &&
      audits.some((r) => r.action === "owner_contractor_services_updated") &&
      audits.some((r) => r.action === "owner_bulk_contractor_services_updated"),
  );

  console.log("\nALL SERVICE-SELECTION CHECKS PASSED");
  for (const [name, ok, extra] of checks)
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`,
    );
} finally {
  if (created) {
    assertQaOrg(ORG);
    await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
    await q`DELETE FROM users WHERE id=${OWNER} OR id=${CONTRACTOR} OR id=${CONTRACTOR2} OR id=${OWNER_DRIVER} OR id=${PURE_ADMIN} OR id=${NON_OWNER}`.catch(
      () => {},
    );
  }
  const leftovers = await q`SELECT
    (SELECT count(*) FROM contractor_services WHERE org_id=${ORG})::int AS services,
    (SELECT count(*) FROM audit_log WHERE org_id=${ORG})::int AS audits,
    (SELECT count(*) FROM dispatch_jobs WHERE org_id=${ORG})::int AS jobs`;
  check(
    "QA cleanup leaves zero rows",
    Number(leftovers[0].services) === 0 &&
      Number(leftovers[0].audits) === 0 &&
      Number(leftovers[0].jobs) === 0,
    JSON.stringify(leftovers[0]),
  );
  if (checks.at(-1)?.[0] === "QA cleanup leaves zero rows")
    console.log(
      `  ${checks.at(-1)[1] ? "PASS" : "FAIL"}  QA cleanup leaves zero rows`,
    );
}
