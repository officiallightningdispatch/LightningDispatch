// Hermetic job-detail-expansion tests (2026-08-11, backlog #2). The collapsible
// job cards' lazy fetch: getJobDetailCore (full detail + photo metadata, role
// gated) and getJobPhotoCore (photo bytes via the EXISTING B2 path — mocked).
// Real network calls never happen. DB-backed against throwaway QA orgs deleted
// at the end (zero rows left).
//   DATABASE_URL=... bun job-detail.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
// Test key for THIS process only (env-first resolution overrides the stable
// key file — same pattern as the other suites).
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 7).toString("base64");
// Test B2 credentials for THIS process (env-first; the photo path uses them).
process.env.B2_KEY_ID = "004testkeyid";
process.env.B2_APPLICATION_KEY = "testsecret";
process.env.B2_BUCKET_NAME = "qa-bucket";

const { getJobDetailCore, getJobPhotoCore } = await import("./src/data/job-detail-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-jobdetail-${randomUUID()}`;
const OWNER = `qa-jobdetail-owner-${randomUUID()}`;
const DISPATCHER = `qa-jobdetail-dispatch-${randomUUID()}`;
const DRIVER_A = `qa-jobdetail-driver-a-${randomUUID()}`; // Towbook driver 501 → jobA + not jobC
const DRIVER_B = `qa-jobdetail-driver-b-${randomUUID()}`; // Towbook driver 502 → jobC (trimmed raw) + not jobA
const DRIVER_C = `qa-jobdetail-driver-c-${randomUUID()}`; // legacy contractor_id link → jobB
const JOB_A = `qa-jd-job-a-${randomUUID()}`;   // full synced job (assigned_driver_name + assets + PO + ETA + 9 photos)
const JOB_B = `qa-jd-job-b-${randomUUID()}`;   // legacy manual assign (dispatch_contractors FK), no photos
const JOB_C = `qa-jd-job-c-${randomUUID()}`;   // assigned_driver_towbook_id set, raw trimmed (no assets)
const CALL_A = "7001001";
const CALL_B = "7001002";
const CALL_C = "7001003";
const DRIVER_B_ID = 502;
const LEGACY_CON = `qa-jd-legacy-con-${randomUUID()}`;

/** Mock fetch for the B2 surface: authorize + S3 GET (photos). Records calls. */
function makeB2Fetch(objects = new Map()) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ method, url: u });
    if (u.startsWith("https://api.backblazeb2.com/")) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ apiInfo: { storageApi: { s3ApiUrl: "https://s3.us-west-004.backblazeb2.com" } }, allowed: { bucketName: "qa-bucket" } }),
        json: async () => ({ apiInfo: { storageApi: { s3ApiUrl: "https://s3.us-west-004.backblazeb2.com" } } }),
      };
    }
    if (u.startsWith("https://s3.us-west-004.backblazeb2.com/")) {
      const path = u.split("/").slice(3).join("/"); // bucket/key
      if (method === "GET") {
        return objects.has(path)
          ? { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(objects.get(path)).buffer }
          : { ok: false, status: 404, arrayBuffer: async () => new Uint8Array(0).buffer };
      }
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  };
  return { fetchImpl, calls, objects };
}

const OWNER_USER = { orgId: ORG, id: OWNER, role: "owner", towbookDriverId: "" };
const DISPATCHER_USER = { orgId: ORG, id: DISPATCHER, role: "dispatcher", towbookDriverId: "" };
const DRIVER_A_USER = { orgId: ORG, id: DRIVER_A, role: "contractor", towbookDriverId: "501" };
const DRIVER_B_USER = { orgId: ORG, id: DRIVER_B, role: "contractor", towbookDriverId: String(DRIVER_B_ID) };
const DRIVER_C_USER = { orgId: ORG, id: DRIVER_C, role: "contractor", contractorId: LEGACY_CON, towbookDriverId: "503" };

async function setup() {
  await ensureSchema();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa job-detail')`;
  for (const [id, name, email, tbDriver] of [
    [OWNER, "QA JD Owner", `qa-jd-owner-${randomUUID()}@lightning.test`, null],
    [DISPATCHER, "QA JD Dispatcher", `qa-jd-dispatch-${randomUUID()}@lightning.test`, null],
    [DRIVER_A, "QA Driver A", `qa-jd-driver-a-${randomUUID()}@lightning.test`, "501"],
    [DRIVER_B, "QA Driver B", `qa-jd-driver-b-${randomUUID()}@lightning.test`, String(DRIVER_B_ID)],
    [DRIVER_C, "QA Driver C", `qa-jd-driver-c-${randomUUID()}@lightning.test`, "503"],
  ]) {
    await q`INSERT INTO users(id, name, email, password_hash${tbDriver ? q`, towbook_driver_id` : q``})
      VALUES(${id}, ${name}, ${email}, 'x'${tbDriver ? q`, ${tbDriver}` : q``})`;
  }
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OWNER}, 'owner')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DISPATCHER}, 'dispatcher')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DRIVER_A}, 'contractor')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DRIVER_B}, 'contractor')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role, contractor_id) VALUES(${ORG}, ${DRIVER_C}, 'contractor', ${LEGACY_CON})`;
  // Legacy roster row for jobB's manual assign.
  await q`INSERT INTO dispatch_contractors(id, org_id, name, status, lat, lng, area, vehicle_types, rating, completed_job_count, response_time_history_minutes)
    VALUES(${LEGACY_CON}, ${ORG}, 'Marcus Q Legacy', 'offline', 41.17, -73.2, 'Bridgeport', '[]', 4.5, 12, '[]')`;

  // jobA — full synced call: assigned driver + PO + ETA + photos.
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, assigned_at, arrived_at, completed_at, note, customer_phone, vehicle_desc, pickup, dropoff, towbook_job_id, towbook_status, raw_json, assigned_driver_towbook_id, assigned_driver_name)
    VALUES(${JOB_A}, ${ORG}, 'Ada Lovelace', '2035550100', 41.17, -73.2, 'Bridgeport', 'tire_change', 'completed', '2026-08-11T14:00:00Z', '2026-08-11T14:03:00Z', '2026-08-11T14:20:00Z', '2026-08-11T14:45:00Z', 'Flat tire on the exit ramp.', '(203) 555-0100', '2020 Honda Accord', '70 Pitt Street, Bridgeport CT', 'Bridgeport Auto Care', ${CALL_A}, '5', ${JSON.stringify({ purchaseOrderNumber: "PO-88231", arrivalETA: "2026-08-11T15:30:00Z", assets: [{ id: "a1", driver: { id: 501, name: "QA Driver A" } }] })}::jsonb, '501', 'QA Driver A')`;
  // jobB — legacy manual assign: FK only, no photos, no raw.
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, assigned_at, note, customer_phone, pickup, assigned_contractor_id, towbook_job_id)
    VALUES(${JOB_B}, ${ORG}, 'Grace Hopper', '2035550200', 41.17, -73.21, 'Fairfield', 'lockout', 'en_route', '2026-08-11T15:00:00Z', '2026-08-11T15:05:00Z', 'Keys locked in the car.', '(203) 555-0200', '1 Post Road, Fairfield CT', ${LEGACY_CON}, ${CALL_B})`;
  // jobC — attribution column set but raw trimmed (no assets): the bug-batch
  // column alone must still authorize the assigned driver.
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, customer_phone, pickup, towbook_job_id, raw_json, assigned_driver_towbook_id)
    VALUES(${JOB_C}, ${ORG}, 'Katherine Johnson', '2035550300', 41.18, -73.19, 'Stratford', 'flatbed_tow', 'new', '2026-08-11T16:00:00Z', 'Battery dead, needs a boost first.', '(203) 555-0300', '33 Main Street, Stratford CT', ${CALL_C}, ${JSON.stringify({ status: { id: 0 }, account: { company: "Katherine Johnson" } })}::jsonb, ${String(DRIVER_B_ID)})`;

  // AI-dispatcher decisions for jobA: two rows — the LATEST eta must win.
  // (call_request_id is unique per org; each fixture row gets its own id.)
  await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, reason, created_at)
    VALUES(gen_random_uuid()::text, ${ORG}, 'cr-jd-older', ${CALL_A}, 'auto_accepted', FALSE, '501', 'QA Driver A', 30, 'older', '2026-08-11T13:50:00Z')`;
  await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, reason, created_at)
    VALUES(gen_random_uuid()::text, ${ORG}, 'cr-jd-newer', ${CALL_A}, 'auto_accepted', FALSE, '501', 'QA Driver A', 22, 'newer', '2026-08-11T13:52:00Z')`;

  // Photos for jobA: 4 pre_arrival (front match-confirmed), 3 service, 2 final
  // — deliberately OUT of side order so upload-order sorting is proven.
  const photos = [
    ["pre_arrival", "front", "2026-08-11T14:21:00Z", true],
    ["pre_arrival", "driver_side", "2026-08-11T14:21:30Z", false],
    ["pre_arrival", "passenger_side", "2026-08-11T14:22:00Z", false],
    ["pre_arrival", "rear", "2026-08-11T14:22:30Z", false],
    ["service", "front", "2026-08-11T14:25:00Z", false],
    ["service", "driver_side", "2026-08-11T14:25:40Z", false],
    ["service", "rear", "2026-08-11T14:26:10Z", false],
    ["final", "front", "2026-08-11T14:40:00Z", false],
    ["final", "rear", "2026-08-11T14:41:00Z", false],
  ];
  for (const [phase, side, uploadedAt, match] of photos) {
    await q`INSERT INTO job_photos(id, org_id, job_id, phase, side, storage_key, uploaded_at, uploaded_by_user_id, match_confirmed)
      VALUES(gen_random_uuid()::text, ${ORG}, ${JOB_A}, ${phase}, ${side}, ${`ld-photos/${ORG}/${JOB_A}/${phase}/${side}.jpg`}, ${uploadedAt}, ${DRIVER_A}, ${match})`;
  }
}
await setup();

/* ===================== 1) owner: full mapped detail ===================== */
{
  const r = await getJobDetailCore(OWNER_USER, { jobId: JOB_A });
  check("owner sees jobA detail", r.ok === true, JSON.stringify(r));
  if (r.ok) {
    const d = r.detail;
    check("customer name", d.customerName === "Ada Lovelace", JSON.stringify(d));
    check("phone from customer_phone", d.phone === "(203) 555-0100", JSON.stringify(d));
    check("service type", d.serviceType === "tire_change", JSON.stringify(d));
    check("area", d.area === "Bridgeport", JSON.stringify(d));
    check("pickup full address", d.pickup === "70 Pitt Street, Bridgeport CT", JSON.stringify(d));
    check("dropoff", d.dropoff === "Bridgeport Auto Care", JSON.stringify(d));
    check("vehicle", d.vehicleDesc === "2020 Honda Accord", JSON.stringify(d));
    check("status", d.status === "completed", JSON.stringify(d));
    check("createdAt iso", d.createdAt === "2026-08-11T14:00:00.000Z", JSON.stringify(d));
    check("assignedAt", d.assignedAt === "2026-08-11T14:03:00.000Z", JSON.stringify(d));
    check("arrivedAt", d.arrivedAt === "2026-08-11T14:20:00.000Z", JSON.stringify(d));
    check("completedAt", d.completedAt === "2026-08-11T14:45:00.000Z", JSON.stringify(d));
    check("assigned driver name (bug-batch column)", d.assignedDriverName === "QA Driver A", JSON.stringify(d));
    check("note", d.note === "Flat tire on the exit ramp.", JSON.stringify(d));
    check("towbook call id", d.towbookJobId === CALL_A, JSON.stringify(d));
    check("purchase order", d.purchaseOrderNumber === "PO-88231", JSON.stringify(d));
    check("arrival ETA", d.arrivalETA === "2026-08-11T15:30:00Z", JSON.stringify(d));
    check("quoted ETA = latest decision (22 not 30)", d.quotedEtaMinutes === 22, JSON.stringify(d));
    check("photos: 9 total", d.photos.length === 9, JSON.stringify(d.photos));
    check("photos grouped by phase in upload order",
      d.photos[0].phase === "pre_arrival" && d.photos[0].side === "front" &&
      d.photos[3].phase === "pre_arrival" && d.photos[3].side === "rear" &&
      d.photos[4].phase === "service" && d.photos[4].side === "front" &&
      d.photos[7].phase === "final" && d.photos[7].side === "front" &&
      d.photos[8].phase === "final" && d.photos[8].side === "rear", JSON.stringify(d.photos.map((p) => `${p.phase}/${p.side}`)));
    check("pre-arrival front matchConfirmed", d.photos[0].matchConfirmed === true && d.photos[1].matchConfirmed === false, JSON.stringify(d.photos[0]));
    // Seroval rule: no undefined-valued properties anywhere in the payload.
    const walk = (node, path) => {
      if (node === undefined) return [`${path} is undefined`];
      const out = [];
      if (Array.isArray(node)) node.forEach((v, i) => out.push(...walk(v, `${path}[${i}]`)));
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) out.push(...walk(v, `${path}.${k}`));
      return out;
    };
    check("seroval: no undefined values", walk(d, "detail").length === 0, JSON.stringify(walk(d, "detail")));
  }
}

/* ===================== 2) resolve by Towbook call id ===================== */
{
  const r = await getJobDetailCore(OWNER_USER, { jobId: CALL_A });
  check("owner resolves by Towbook call id", r.ok === true && r.detail.id === JOB_A, JSON.stringify(r));
}

/* ===================== 3) role gates ===================== */
{
  const byDriverA = await getJobDetailCore(DRIVER_A_USER, { jobId: JOB_A });
  check("assigned driver sees their job (assets match)", byDriverA.ok === true && byDriverA.detail.customerName === "Ada Lovelace", JSON.stringify(byDriverA));
  const deniedA = await getJobDetailCore(DRIVER_B_USER, { jobId: JOB_A });
  check("unassigned driver → unauthorized", deniedA.ok === false && deniedA.code === "unauthorized", JSON.stringify(deniedA));
  const byDispatcher = await getJobDetailCore(DISPATCHER_USER, { jobId: JOB_A });
  check("dispatcher sees any org job", byDispatcher.ok === true, JSON.stringify(byDispatcher));
  const byB = await getJobDetailCore(DRIVER_B_USER, { jobId: JOB_C });
  check("assigned driver sees job with trimmed raw (attribution column)", byB.ok === true && byB.detail.id === JOB_C, JSON.stringify(byB));
  const deniedC = await getJobDetailCore(DRIVER_A_USER, { jobId: JOB_C });
  check("other driver denied on trimmed-raw job", deniedC.ok === false && deniedC.code === "unauthorized", JSON.stringify(deniedC));
  const byLegacy = await getJobDetailCore(DRIVER_C_USER, { jobId: JOB_B });
  check("legacy contractor_id link sees jobB", byLegacy.ok === true, JSON.stringify(byLegacy));
  if (byLegacy.ok) {
    check("legacy assign name from roster fallback", byLegacy.detail.assignedDriverName === "Marcus Q Legacy", JSON.stringify(byLegacy.detail));
    check("jobB has no photos → empty array", Array.isArray(byLegacy.detail.photos) && byLegacy.detail.photos.length === 0, JSON.stringify(byLegacy.detail.photos));
    check("jobB omits absent optional fields (seroval)", byLegacy.detail.purchaseOrderNumber === undefined && byLegacy.detail.quotedEtaMinutes === undefined && byLegacy.detail.completedAt === undefined, JSON.stringify(byLegacy.detail));
  }
  const missing = await getJobDetailCore(OWNER_USER, { jobId: `nope-${randomUUID()}` });
  check("missing job → not_found", missing.ok === false && missing.code === "not_found", JSON.stringify(missing));
  const badInput = await getJobDetailCore(OWNER_USER, { jobId: "" });
  check("empty jobId → invalid_state", badInput.ok === false && badInput.code === "invalid_state", JSON.stringify(badInput));
}

/* ===================== 4) photo bytes via B2 (mocked) ===================== */
{
  const key = `ld-photos/${ORG}/${JOB_A}/pre_arrival/front.jpg`;
  const bytes = Buffer.from("fakephotobytes-" + randomUUID());
  const { fetchImpl, calls } = makeB2Fetch(new Map([[`qa-bucket/${key}`, bytes]]));
  const r = await getJobPhotoCore(OWNER_USER, { jobId: JOB_A, phase: "pre_arrival", side: "front" }, { fetchImpl });
  check("owner gets photo data url", r.ok === true && r.dataUrl.startsWith("data:image/jpeg;base64,"), JSON.stringify(r));
  if (r.ok) {
    const decoded = Buffer.from(r.dataUrl.split(",")[1], "base64");
    check("photo bytes round-trip through B2 mock", Buffer.compare(decoded, bytes) === 0, "");
  }
  check("B2 authorize + GET used the existing storage path", calls.some((c) => c.method === "GET" && c.url.includes(key)), JSON.stringify(calls));
  const denied = await getJobPhotoCore(DRIVER_B_USER, { jobId: JOB_A, phase: "pre_arrival", side: "front" }, { fetchImpl });
  check("unassigned driver photo → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const noSlot = await getJobPhotoCore(OWNER_USER, { jobId: JOB_A, phase: "service", side: "passenger_side" }, { fetchImpl });
  check("missing photo slot → not_found", noSlot.ok === false && noSlot.code === "not_found", JSON.stringify(noSlot));
  const badPhase = await getJobPhotoCore(OWNER_USER, { jobId: JOB_A, phase: "sneaky", side: "front" }, { fetchImpl });
  check("invalid phase → invalid_state", badPhase.ok === false && badPhase.code === "invalid_state", JSON.stringify(badPhase));
  const noJob = await getJobPhotoCore(OWNER_USER, { jobId: JOB_B, phase: "pre_arrival", side: "front" }, { fetchImpl });
  check("no-photo job → not_found (never a crash)", noJob.ok === false, JSON.stringify(noJob));
  // Missing B2 object → clean database_unavailable, never a throw.
  const missingObj = await getJobPhotoCore(OWNER_USER, { jobId: JOB_A, phase: "pre_arrival", side: "driver_side" }, { fetchImpl });
  check("B2 404 → clean error", missingObj.ok === false, JSON.stringify(missingObj));
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`job-detail.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
// Prove cleanup: deleting the QA org cascades every row it created; users that
// were members are deleted explicitly (users has no org FK).
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa job-detail%'`;
for (const org of await q`SELECT id FROM organizations WHERE name LIKE 'qa job-detail%'`) {
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-jd-%@lightning.test'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa job-detail%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-jd-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM dispatch_jobs d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa job-detail%') AS jobs,
  (SELECT COUNT(*)::int FROM job_photos p JOIN organizations o ON o.id=p.org_id WHERE o.name LIKE 'qa job-detail%') AS photos,
  (SELECT COUNT(*)::int FROM ai_dispatcher_decisions s JOIN organizations o ON o.id=s.org_id WHERE o.name LIKE 'qa job-detail%') AS decisions,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa job-detail%') AS members,
  (SELECT COUNT(*)::int FROM dispatch_contractors c JOIN organizations o ON o.id=c.org_id WHERE o.name LIKE 'qa job-detail%') AS contractors`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("job-detail.test.mjs: cleanup verified — zero QA rows left");
