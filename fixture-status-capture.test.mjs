// Fixture verification for the Towbook status-capture path and the 255 safety rail.
//
//   DATABASE_URL=... bun fixture-status-capture.test.mjs
//
// Creates a throwaway QA org + owner, runs the real capture/persist/upsert code
// against it, asserts the round-trip, then deletes every row it created. It never
// touches the owner org. The QA towbook_sessions row is created with status='error'
// so the running server's 60s background sync can never pick it up.
import { randomUUID } from "node:crypto";

const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);

const {
  buildTowbookSample,
  trimRawCall,
  persistSyncResult,
  upsertPulledJobs,
  normalizeJsonCall,
  extractTowbookStatusId,
} = await import("./src/data/server.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-${randomUUID()}`;
const USER = `qa-user-${randomUUID()}`;
let created = false;

/** Realistic raw call object per the confirmed /api/calls vocabulary. */
const fixtureCall = (id, statusId, statuses, extra = {}) => ({
  id,
  callNumber: id + 100000,
  type: 1,
  tags: [],
  groups: [],
  reason: { id: 365, name: "Jump Start" },
  status: { id: statusId },
  account: { id: 894873, zip: "06606", city: "Bridgeport", state: "CT", typeId: 5, address: "70 Pitt Street", company: "Agero (Swoop) Bridgeport", masterAccountId: 29 },
  impound: false,
  version: 11,
  callType: 2,
  channels: [],
  contacts: [],
  insights: [],
  payments: [],
  priority: 1,
  statuses,
  companyId: 23257,
  sourceUrl: "",
  towSource: "1034 Garden Rd Orange, CT 06477",
  waypoints: [{ id: 516761554, zip: "06477", title: "Pickup", address: "1034 Garden Rd Orange, CT 06477", hasToll: false, latitude: 41.309574, position: 1, longitude: -73.055314 }],
  arrivalETA: null,
  attributes: {},
  balanceDue: 0,
  createDate: "2026-08-10T19:10:38.06",
  invoiceTax: 0,
  statements: [],
  enrouteTime: undefined,
  dispatchTime: "2026-08-10T20:02:00",
  invoiceItems: [],
  invoiceTotal: 0,
  referenceUrl: "",
  invoiceNumber: "",
  balanceByClass: {},
  invoiceStatusId: null,
  invoiceSubtotal: 0,
  paymentsApplied: [],
  availableActions: [],
  invoiceTaxExempt: false,
  referenceUrlName: "",
  purchaseOrderNumber: "",
  notes: `fixture call status ${statusId}`,
  ...extra,
});

// 0..5: one call per mapped lifecycle status (all carry the full workflow chain,
// exactly like the owner's real calls). 255: TWO calls — an older one with
// [0,255] and a newer one with [0,1,255] — to prove newest-wins per shape. The
// newer 255 call also carries a big invoiceItems array to exercise the trim path.
const calls = [
  fixtureCall(101, 0, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T18:00:00" }),
  fixtureCall(102, 1, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T18:01:00", enrouteTime: "2026-08-10T18:02:00" }),
  fixtureCall(103, 2, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T19:10:38.06" }),
  fixtureCall(104, 3, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T19:20:00", enrouteTime: "2026-08-10T19:21:00", arrivalTime: "2026-08-10T19:45:00" }),
  fixtureCall(105, 4, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T19:30:00", enrouteTime: "2026-08-10T19:31:00", arrivalTime: "2026-08-10T19:50:00" }),
  fixtureCall(106, 5, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T19:05:00", dispatchTime: "2026-08-10T19:06:00", enrouteTime: "2026-08-10T19:06:00", arrivalTime: "2026-08-10T19:22:00", completionTime: "2026-08-10T19:38:00" }),
  // older 255 call
  fixtureCall(107, 255, [0, 255], {
    createDate: "2026-08-08T18:00:00",
    dispatchTime: "2026-08-08T18:05:00",
    notes: "older 255 call (must NOT win)",
  }),
  // newer 255 call — big invoiceItems to force the trim path
  fixtureCall(108, 255, [0, 1, 255], {
    createDate: "2026-08-09T09:30:00",
    dispatchTime: "2026-08-09T09:40:00",
    enrouteTime: "2026-08-09T09:41:00",
    arrivalTime: null,
    completionTime: null,
    availableActions: [{ id: 17, name: "Cancel" }, { id: 3, name: "Edit" }],
    notes: "newest 255 call — statuses [0,1,255]",
    invoiceItems: Array.from({ length: 400 }, (_, i) => ({ id: i, lineTotal: 5, description: `item ${i} padding padding padding padding padding` })),
  }),
];

try {
  // ---- setup: QA org + owner user + error-status session row (never auto-synced)
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa fixture')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${USER}, 'QA Fixture Owner', ${`fixture-${randomUUID()}@qa.local`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${USER}, 'owner')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG}, '', 'error')`;
  created = true;

  // ---- 1) capture: sample / statusShapes / sampleByStatus
  const capture = buildTowbookSample(calls);
  check("capture.sample is an array of 2 objects", Array.isArray(capture.sample) && capture.sample.length === 2 && typeof capture.sample[0] === "object", JSON.stringify(capture.sample?.length));
  check("capture.sample objects are not strings", capture.sample.every((o) => typeof o !== "string"));
  const shapes = JSON.stringify(capture.statusShapes);
  check("statusShapes has 7 distinct shapes 0..5 + 255", capture.statusShapes.length === 7 && capture.statusShapes.some((s) => s.includes('"id":0')) && capture.statusShapes.some((s) => s.includes('"id":5')) && capture.statusShapes.some((s) => s.includes('"id":255')), shapes);
  const sbs = capture.sampleByStatus;
  const sbsKeys = Object.keys(sbs).sort((a, b) => Number(a) - Number(b)).join(",");
  check("sampleByStatus has keys 0..5,255", sbsKeys === "0,1,2,3,4,5,255", sbsKeys);
  check("sampleByStatus['255'] is the NEWER call", sbs["255"] && sbs["255"].id === 108 && JSON.stringify(sbs["255"].statuses) === "[0,1,255]", `id=${sbs["255"]?.id}`);
  check("sampleByStatus['5'] is the completed call", sbs["5"] && sbs["5"].completionTime === "2026-08-10T19:38:00");
  for (const k of Object.keys(sbs)) {
    check(`sampleByStatus['${k}'] JSON ≤ 6000 chars`, JSON.stringify(sbs[k]).length <= 6000, `len=${JSON.stringify(sbs[k]).length}`);
  }
  check("trimRawCall dropped the heavy invoiceItems on the big 255 call", sbs["255"] && !("invoiceItems" in sbs["255"]));
  check("trimRawCall never returns undefined/string", typeof trimRawCall(calls[7]) === "object");

  // ---- 2) mapping loop (mirrors doSyncForOrg): 0..5 import, 255 skipped w/ named diag
  const normalized = [];
  const skipped = [];
  const statusIdCounts = new Map();
  for (const call of calls) {
    const rid = String(call.id ?? call.callNumber).trim();
    const sid = extractTowbookStatusId(call.status);
    if (sid != null) statusIdCounts.set(String(sid), (statusIdCounts.get(String(sid)) ?? 0) + 1);
    const n = normalizeJsonCall(call, "");
    if (!n.ok) { skipped.push({ id: rid, reason: n.reason }); continue; }
    normalized.push(n.job);
  }
  check("6 mapped jobs (0..5)", normalized.length === 6, String(normalized.length));
  check("2 calls skipped (both 255)", skipped.length === 2, String(skipped.length));
  check("skip reason names the unmapped status id 255", skipped.every((s) => s.reason.includes("unmapped status") && s.reason.includes("statusId=255")), JSON.stringify(skipped));
  const unmappedIds = [...statusIdCounts.keys()].filter((s) => s === "255");
  check("diagnostic unmapped set contains 255", unmappedIds.join(",") === "255", unmappedIds.join(","));

  // ---- 3) upsert into the QA org (real code path)
  const actor = { id: USER, role: "owner" };
  const res = await upsertPulledJobs(ORG, actor, normalized, "fixture-test");
  check("upsert added exactly 6 jobs", res.added === 6 && res.updated === 0 && res.failed === 0, JSON.stringify(res));
  const jobs = await q`SELECT towbook_job_id, status, towbook_status FROM dispatch_jobs WHERE org_id=${ORG}`;
  check("dispatch_jobs has 6 rows, none with towbook_status 255", jobs.length === 6 && jobs.every((j) => String(j.towbook_status) !== "255"), jobs.map((j) => `${j.towbook_job_id}:${j.towbook_status}`).join(","));

  // ---- 4) persist + JSONB round-trip (the exact doSyncForOrg result shape)
  const result = {
    ok: true,
    code: "ok",
    message: `Synced ${normalized.length} Towbook job(s): ${res.added} added, ${res.updated} updated, ${res.failed + skipped.length} failed.`,
    added: res.added,
    updated: res.updated,
    failed: res.failed + skipped.length,
    diagnostics: [],
    ranAt: new Date().toISOString(),
    sample: capture.sample,
    statusShapes: capture.statusShapes,
    sampleByStatus: capture.sampleByStatus,
  };
  await persistSyncResult(ORG, result);

  const rows = await q`SELECT last_result FROM towbook_sessions WHERE org_id=${ORG}`;
  const p = rows[0].last_result;
  check("last_result persisted with code ok + ranAt", p.code === "ok" && typeof p.ranAt === "string" && p.ranAt.length > 0);
  check("sample is a JSONB ARRAY (round-trips; not the string 'undefined')", Array.isArray(p.sample) && typeof p.sample !== "string", `typeof=${typeof p.sample}`);
  check("sample[0] is a real call object with status", p.sample[0] && typeof p.sample[0] === "object" && p.sample[0].status && typeof p.sample[0].status.id === "number");
  check("sample[1].statuses is an array", Array.isArray(p.sample[1]?.statuses));
  check("sampleByStatus round-trips as an object", p.sampleByStatus && typeof p.sampleByStatus === "object" && !Array.isArray(p.sampleByStatus));
  check("sampleByStatus['255'].statuses === [0,1,255] (the complete 255 history)", JSON.stringify(p.sampleByStatus["255"]?.statuses) === "[0,1,255]", JSON.stringify(p.sampleByStatus["255"]?.statuses));
  check("sampleByStatus['255'] keeps availableActions + account + waypoints", Array.isArray(p.sampleByStatus["255"]?.availableActions) && p.sampleByStatus["255"]?.account?.company && Array.isArray(p.sampleByStatus["255"]?.waypoints));
  check("sampleByStatus['255'].id is the newest call", p.sampleByStatus["255"]?.id === 108, String(p.sampleByStatus["255"]?.id));
  check("sampleByStatus['5'].completionTime present", p.sampleByStatus["5"]?.completionTime === "2026-08-10T19:38:00");
  check("statusShapes persisted unchanged (7 shapes incl 255)", Array.isArray(p.statusShapes) && p.statusShapes.length === 7 && p.statusShapes.some((s) => s.includes("255")));
  check("no field is the literal string 'undefined'", !Object.values(p).some((v) => v === "undefined"));

  // ---- 5) persist a bare result (no calls → no capture): must not crash, no sample key
  await persistSyncResult(ORG, {
    ok: true, code: "no_jobs", message: "no jobs", added: 0, updated: 0, failed: 0, diagnostics: [], ranAt: new Date().toISOString(),
  });
  const rows2 = await q`SELECT last_result FROM towbook_sessions WHERE org_id=${ORG}`;
  const p2 = rows2[0].last_result;
  check("bare persist: sample key absent (no crash, no bogus value)", !("sample" in p2) && !("sampleByStatus" in p2) && p2.code === "no_jobs");

  console.log("\nALL FIXTURE CHECKS PASSED");
  for (const [name, ok, extra] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
} finally {
  // ---- cleanup: QA org cascades jobs/events/audit/session/membership; delete the user
  if (created) {
    await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
    await q`DELETE FROM users WHERE id=${USER}`.catch(() => {});
  }
  const leftover = await q`SELECT (SELECT count(*) FROM dispatch_jobs WHERE org_id=${ORG}) AS jobs, (SELECT count(*) FROM status_events WHERE org_id=${ORG}) AS ev, (SELECT count(*) FROM audit_log WHERE org_id=${ORG}) AS audit, (SELECT count(*) FROM towbook_sessions WHERE org_id=${ORG}) AS sess, (SELECT count(*) FROM organization_memberships WHERE org_id=${ORG}) AS members, (SELECT count(*) FROM users WHERE id=${USER}) AS users`;
  const l = leftover[0];
  console.log(`\ncleanup: jobs=${l.jobs} events=${l.ev} audit=${l.audit} sessions=${l.sess} members=${l.members} users=${l.users}`);
  if (Object.values(l).some((v) => Number(v) > 0)) {
    console.error("WARNING: QA rows remain!");
    process.exitCode = 1;
  }
}
