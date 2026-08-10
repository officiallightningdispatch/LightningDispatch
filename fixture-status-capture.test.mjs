// Fixture verification for the Towbook status-capture path and the 255=CANCELLED
// lifecycle mapping (decision 2026-08-10: status 255 imports as the terminal
// 'cancelled' state).
//
//   DATABASE_URL=... bun fixture-status-capture.test.mjs
//
// Creates a throwaway QA org + owner, runs the real capture/persist/upsert code
// against it, asserts the round-trip + cancelled lifecycle behavior, then deletes
// every row it created. It never touches the owner org. The QA towbook_sessions
// row is created with status='error' so the running server's 60s background sync
// can never pick it up.
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
  TOWBOOK_STATUS_ID_TO_LIFECYCLE,
  TOWBOOK_STATUS_ID_UNMAPPED,
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
// [0,255] and a NEWER one with the full chain [0,1,2,3,4,5] + completionTime +
// UNDO_CANCEL/DELETE actions (per the owner's captured 255 call) — to prove
// newest-wins per shape AND that 255 imports as 'cancelled'. 252: one call that
// must stay skipped/unmapped.
const calls = [
  fixtureCall(101, 0, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T18:00:00" }),
  fixtureCall(102, 1, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T18:01:00", enrouteTime: "2026-08-10T18:02:00" }),
  fixtureCall(103, 2, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T19:10:38.06" }),
  fixtureCall(104, 3, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T19:20:00", enrouteTime: "2026-08-10T19:21:00", arrivalTime: "2026-08-10T19:45:00" }),
  fixtureCall(105, 4, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T19:30:00", enrouteTime: "2026-08-10T19:31:00", arrivalTime: "2026-08-10T19:50:00" }),
  fixtureCall(106, 5, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T19:05:00", dispatchTime: "2026-08-10T19:06:00", enrouteTime: "2026-08-10T19:06:00", arrivalTime: "2026-08-10T19:22:00", completionTime: "2026-08-10T19:38:00" }),
  // older 255 call — full workflow chain too (real 255 calls carry [0,1,2,3,4,5]),
  // but must NOT win the newest-wins sample
  fixtureCall(107, 255, [0, 1, 2, 3, 4, 5], {
    createDate: "2026-08-08T18:00:00",
    dispatchTime: "2026-08-08T18:05:00",
    completionTime: "2026-08-08T18:40:00",
    availableActions: ["UNDO_CANCEL", "DELETE"],
    notes: "older 255 call (must NOT win)",
  }),
  // newer 255 call — full workflow chain + completionTime + UNDO_CANCEL/DELETE,
  // plus a big invoiceItems array to exercise the trim path
  fixtureCall(108, 255, [0, 1, 2, 3, 4, 5], {
    createDate: "2026-08-09T09:30:00",
    dispatchTime: "2026-08-09T09:40:00",
    enrouteTime: "2026-08-09T09:41:00",
    arrivalTime: "2026-08-09T10:00:00",
    completionTime: "2026-08-09T10:16:00",
    invoiceStatusId: 1,
    purchaseOrderNumber: "112434881",
    availableActions: ["DIGITAL_REQUEST_GOA", "GUIDED_PHOTOS", "MODIFY", "UNDO_CANCEL", "INTERNAL_NOTES", "DELETE", "ASSIGN_DRIVERS", "VIEW_CHARGES", "DUPLICATE", "VIEW_PAYMENTS", "CREATE_PAYMENTS"],
    notes: "newest 255 call — statuses [0,1,2,3,4,5]",
    invoiceItems: Array.from({ length: 400 }, (_, i) => ({ id: i, lineTotal: 5, description: `item ${i} padding padding padding padding padding` })),
  }),
  // 252 sentinel — must stay unmapped/skipped
  fixtureCall(109, 252, [0, 252], { createDate: "2026-08-08T12:00:00", notes: "252 call (must stay skipped)" }),
];

try {
  // ---- setup: QA org + owner user + error-status session row (never auto-synced)
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa fixture')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${USER}, 'QA Fixture Owner', ${`fixture-${randomUUID()}@qa.local`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${USER}, 'owner')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG}, '', 'error')`;
  created = true;

  // ---- 0) mapping consts: 255 in the lifecycle map, 252 still unmapped
  check("TOWBOOK_STATUS_ID_TO_LIFECYCLE[255] === 'cancelled'", TOWBOOK_STATUS_ID_TO_LIFECYCLE[255] === "cancelled");
  check("TOWBOOK_STATUS_ID_TO_LIFECYCLE[0..5] unchanged", [0, 1, 2, 3, 4, 5].every((n, i) => TOWBOOK_STATUS_ID_TO_LIFECYCLE[n] === ["new", "offered", "accepted", "en_route", "arrived", "completed"][i]));
  check("TOWBOOK_STATUS_ID_UNMAPPED keeps 252", TOWBOOK_STATUS_ID_UNMAPPED.has(252) && TOWBOOK_STATUS_ID_UNMAPPED.size === 1);

  // ---- 1) capture: sample / statusShapes / sampleByStatus
  const capture = buildTowbookSample(calls);
  check("capture.sample is an array of 2 objects", Array.isArray(capture.sample) && capture.sample.length === 2 && typeof capture.sample[0] === "object", JSON.stringify(capture.sample?.length));
  check("capture.sample objects are not strings", capture.sample.every((o) => typeof o !== "string"));
  const shapes = JSON.stringify(capture.statusShapes);
  check("statusShapes has 8 distinct shapes (0..5 + 255 + 252)", capture.statusShapes.length === 8 && capture.statusShapes.some((s) => s.includes('"id":0')) && capture.statusShapes.some((s) => s.includes('"id":5')) && capture.statusShapes.some((s) => s.includes('"id":255')) && capture.statusShapes.some((s) => s.includes('"id":252')), shapes);
  const sbs = capture.sampleByStatus;
  const sbsKeys = Object.keys(sbs).sort((a, b) => Number(a) - Number(b)).join(",");
  check("sampleByStatus has keys 0..5,252,255", sbsKeys === "0,1,2,3,4,5,252,255", sbsKeys);
  check("sampleByStatus['255'] is the NEWER call (full chain)", sbs["255"] && sbs["255"].id === 108 && JSON.stringify(sbs["255"].statuses) === "[0,1,2,3,4,5]", `id=${sbs["255"]?.id}`);
  check("sampleByStatus['255'].completionTime is set (it completed)", sbs["255"]?.completionTime === "2026-08-09T10:16:00");
  check("sampleByStatus['255'].availableActions includes UNDO_CANCEL + DELETE", Array.isArray(sbs["255"]?.availableActions) && sbs["255"].availableActions.includes("UNDO_CANCEL") && sbs["255"].availableActions.includes("DELETE"));
  check("sampleByStatus['5'] is the completed call", sbs["5"] && sbs["5"].completionTime === "2026-08-10T19:38:00");
  check("sampleByStatus['252'] captured (shape-known, still unmapped)", sbs["252"] && sbs["252"].id === 109);
  for (const k of Object.keys(sbs)) {
    check(`sampleByStatus['${k}'] JSON ≤ 6000 chars`, JSON.stringify(sbs[k]).length <= 6000, `len=${JSON.stringify(sbs[k]).length}`);
  }
  check("trimRawCall dropped the heavy invoiceItems on the big 255 call", sbs["255"] && !("invoiceItems" in sbs["255"]));
  check("trimRawCall never returns undefined/string", typeof trimRawCall(calls[7]) === "object");

  // ---- 2) mapping loop (mirrors doSyncForOrg): 0..5 import, 255 → cancelled,
  //        252 skipped with a named diagnostic
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
  check("8 mapped jobs (0..5 + 2×255)", normalized.length === 8, String(normalized.length));
  const cancelledNorm = normalized.filter((j) => j.status === "cancelled");
  check("255 normalized as 'cancelled' (2 calls → both cancelled)", cancelledNorm.length === 2 && cancelledNorm.every((j) => j.towbookStatus === "255"), cancelledNorm.map((j) => j.towbookJobId).join(","));
  check("1 call skipped (252)", skipped.length === 1, String(skipped.length));
  check("skip reason names the unmapped status id 252", skipped.every((s) => s.reason.includes("unmapped status") && s.reason.includes("statusId=252")), JSON.stringify(skipped));
  const unmappedIds = [...statusIdCounts.keys()].filter((s) => !TOWBOOK_STATUS_ID_TO_LIFECYCLE[Number(s)]);
  check("diagnostic unmapped set contains only 252", unmappedIds.join(",") === "252", unmappedIds.join(","));

  // ---- 3) FIRST upsert into the QA org (real code path): all 7 import
  const actor = { id: USER, role: "owner" };
  const res = await upsertPulledJobs(ORG, actor, normalized, "fixture-test");
  check("first upsert added 8, updated 0, failed 0", res.added === 8 && res.updated === 0 && res.failed === 0, JSON.stringify(res));
  const jobs = await q`SELECT id, towbook_job_id, status, towbook_status FROM dispatch_jobs WHERE org_id=${ORG}`;
  check("dispatch_jobs has 8 rows", jobs.length === 8, String(jobs.length));
  const cancelledRows = jobs.filter((j) => String(j.status) === "cancelled");
  check("2 rows imported as 'cancelled' with towbook_status 255", cancelledRows.length === 2 && cancelledRows.every((j) => String(j.towbook_status) === "255"), jobs.map((j) => `${j.towbook_job_id}:${j.status}`).join(","));
  check("0..5 rows import with their lifecycle status", jobs.filter((j) => ["new", "offered", "accepted", "en_route", "arrived", "completed"].includes(String(j.status))).length === 6, jobs.map((j) => `${j.towbook_job_id}:${j.status}`).join(","));
  check("no row imported with towbook_status 252", jobs.every((j) => String(j.towbook_status) !== "252"));

  // import events: 255 row must carry the real previous state (completed from the
  // statuses chain [0,1,2,3,4,5]); the new/status-0 row keeps import→new.
  const ev = await q`SELECT job_id, from_status, to_status, note FROM status_events WHERE org_id=${ORG} ORDER BY occurred_at, job_id`;
  check("8 import events written (one per job)", ev.length === 8, String(ev.length));
  const cancelEv = ev.filter((e) => String(e.to_status) === "cancelled");
  check("cancelled import events go completed→cancelled (from statuses history)", cancelEv.length === 2 && cancelEv.every((e) => String(e.from_status) === "completed"), JSON.stringify(cancelEv));
  check("cancelled import events carry the import note", cancelEv.every((e) => String(e.note).includes("imported from Towbook")));
  const newEv = ev.filter((e) => String(e.to_status) === "new");
  check("new job import stays import→new (history not misused when it equals current)", newEv.length === 1 && String(newEv[0].from_status) === "import", JSON.stringify(newEv));
  const audit = await q`SELECT count(*)::int n FROM audit_log WHERE org_id=${ORG}`;
  check("audit_log has 8 towbook_import rows", Number(audit[0].n) === 8, String(audit[0].n));

  // ---- 4) SECOND sync (same calls): re-upsert without churn
  const res2 = await upsertPulledJobs(ORG, actor, normalized, "fixture-test");
  check("second upsert: added 0, updated 0, failed 0 (no churn)", res2.added === 0 && res2.updated === 0 && res2.failed === 0, JSON.stringify(res2));
  const ev2 = await q`SELECT count(*)::int n FROM status_events WHERE org_id=${ORG}`;
  check("status_events unchanged after re-sync (still 8)", Number(ev2[0].n) === 8, String(ev2[0].n));

  // ---- 5) completed→cancelled TRANSITION: a job first imported as completed
  //        (status 5) re-syncs as 255 → UPDATE + transition event
  const doneCall = fixtureCall(110, 5, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T20:00:00", completionTime: "2026-08-10T20:30:00", notes: "transition fixture: completed then cancelled" });
  const cancelledAgainCall = fixtureCall(110, 255, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T20:00:00", completionTime: "2026-08-10T20:30:00", availableActions: ["UNDO_CANCEL", "DELETE"], notes: "transition fixture: completed then cancelled" });
  const nDone = normalizeJsonCall(doneCall, "");
  check("transition pre-step: status-5 call normalizes as completed", nDone.ok && nDone.job.status === "completed", JSON.stringify(nDone));
  const res3 = await upsertPulledJobs(ORG, actor, [nDone.job], "fixture-test");
  check("transition step 1: completed job added", res3.added === 1 && res3.updated === 0, JSON.stringify(res3));
  const nCancel = normalizeJsonCall(cancelledAgainCall, "");
  check("transition pre-step: 255 call normalizes as cancelled", nCancel.ok && nCancel.job.status === "cancelled", JSON.stringify(nCancel));
  const res4 = await upsertPulledJobs(ORG, actor, [nCancel.job], "fixture-test");
  check("transition step 2: re-sync as 255 → updated 1 (no re-add)", res4.added === 0 && res4.updated === 1 && res4.failed === 0, JSON.stringify(res4));
  const tj = await q`SELECT status FROM dispatch_jobs WHERE org_id=${ORG} AND towbook_job_id='110'`;
  check("transitioned row is now 'cancelled'", tj.length === 1 && String(tj[0].status) === "cancelled", JSON.stringify(tj));
  const tev = await q`SELECT from_status, to_status, note FROM status_events WHERE org_id=${ORG} AND job_id='tb-110' ORDER BY occurred_at`;
  check("transition wrote import→completed then completed→cancelled events", tev.length === 2 && String(tev[0].from_status) === "import" && String(tev[0].to_status) === "completed" && String(tev[1].from_status) === "completed" && String(tev[1].to_status) === "cancelled", JSON.stringify(tev));
  check("transition event carries the status-change note", String(tev[1].note).includes("status change from Towbook"));

  // ---- 6) History query (the data-layer equivalent of the History tab filter
  //        HISTORY_STATUSES = ['completed','cancelled']): includes cancelled jobs
  const historyRows = await q`SELECT towbook_job_id, status FROM dispatch_jobs WHERE org_id=${ORG} AND status IN ('completed','cancelled') ORDER BY towbook_job_id`;
  check("History query returns completed + cancelled jobs", historyRows.length === 4, JSON.stringify(historyRows));
  check("History includes both cancelled (255) rows + completed rows", historyRows.filter((r) => String(r.status) === "cancelled").length === 3 && historyRows.filter((r) => String(r.status) === "completed").length === 1, JSON.stringify(historyRows));
  const activeQuery = await q`SELECT count(*)::int n FROM dispatch_jobs WHERE org_id=${ORG} AND status IN ('offered','accepted','en_route','arrived')`;
  check("Active query excludes cancelled (4 rows in offered..arrived, none cancelled)", Number(activeQuery[0].n) === 4, String(activeQuery[0].n));

  // ---- 7) persist + JSONB round-trip (the exact doSyncForOrg result shape)
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
  check("sampleByStatus['255'].statuses === [0,1,2,3,4,5] (the complete 255 history)", JSON.stringify(p.sampleByStatus["255"]?.statuses) === "[0,1,2,3,4,5]", JSON.stringify(p.sampleByStatus["255"]?.statuses));
  check("sampleByStatus['255'] keeps availableActions + account + waypoints + completionTime", Array.isArray(p.sampleByStatus["255"]?.availableActions) && p.sampleByStatus["255"]?.account?.company && Array.isArray(p.sampleByStatus["255"]?.waypoints) && p.sampleByStatus["255"]?.completionTime);
  check("sampleByStatus['255'].id is the newest call", p.sampleByStatus["255"]?.id === 108, String(p.sampleByStatus["255"]?.id));
  check("sampleByStatus['5'].completionTime present", p.sampleByStatus["5"]?.completionTime === "2026-08-10T19:38:00");
  check("statusShapes persisted unchanged (8 shapes incl 255 + 252)", Array.isArray(p.statusShapes) && p.statusShapes.length === 8 && p.statusShapes.some((s) => s.includes("255")) && p.statusShapes.some((s) => s.includes("252")));
  check("no field is the literal string 'undefined'", !Object.values(p).some((v) => v === "undefined"));

  // ---- 8) persist a bare result (no calls → no capture): must not crash, no sample key
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
