// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Fixture verification for the Towbook status-capture path and the numeric
// status-id lifecycle mapping (decisions 2026-08-10): status 255 imports as the
// terminal 'cancelled' state, and status 252 imports as the terminal 'completed'
// state (owner-verified: 252 = Towbook's completed-awaiting-acknowledgement
// terminal, with full chain statuses [0..5] + completionTime + ACKNOWLEDGE_COMPLETE).
//
//   DATABASE_URL=... bun fixture-status-capture.test.mjs
//
// Creates a throwaway QA org + owner, runs the real capture/persist/upsert code
// against it, asserts the round-trip + lifecycle + transition + message-arithmetic
// behavior, then deletes every row it created. It never touches the owner org.
// The QA towbook_sessions row is created with status='error' so the running
// server's 60s background sync can never pick it up.
import { randomUUID } from "node:crypto";

const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);

const {
  buildTowbookSample,
  trimRawCall,
  upsertPulledJobs,
  normalizeJsonCall,
  extractTowbookStatusId,
  previousStatusFromHistory,
  buildSyncMessage,
  TOWBOOK_STATUS_ID_TO_LIFECYCLE,
  TOWBOOK_STATUS_ID_UNMAPPED,
} = await import("./src/data/server.ts");
const { persistSyncResult } = await import("./src/data/sync-engine.ts");

const { assertQaOrg } = await import("./src/data/db-guard.ts");
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
// mirrors the owner's REAL 252 call (full chain [0,1,2,3,4,5] + completionTime +
// ACKNOWLEDGE_COMPLETE actions) — imports as 'completed'.
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
  // 252 call — mirrors the owner's REAL 252 payload (call 279656932): full chain
  // [0,1,2,3,4,5], completionTime set, ACKNOWLEDGE_COMPLETE/UPDATE_STATUS/CANCEL.
  // Imports as 'completed'.
  fixtureCall(109, 252, [0, 1, 2, 3, 4, 5], {
    createDate: "2026-08-10T19:10:00",
    dispatchTime: "2026-08-10T20:01:00",
    enrouteTime: "2026-08-10T20:02:00",
    arrivalTime: "2026-08-10T20:28:00",
    completionTime: "2026-08-10T20:33:00",
    invoiceStatusId: 1,
    purchaseOrderNumber: "112509304",
    availableActions: ["DIGITAL_CANCEL", "GUIDED_PHOTOS", "MODIFY", "CANCEL", "ACKNOWLEDGE_COMPLETE", "DELETE", "ASSIGN_DRIVERS", "UPDATE_STATUS"],
    notes: "252 call (completed-awaiting-acknowledgement) — imports as completed",
  }),
];

try {
  // ---- setup: QA org + owner user + error-status session row (never auto-synced)
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa fixture')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${USER}, 'QA Fixture Owner', ${`fixture-${randomUUID()}@qa.local`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${USER}, 'owner')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status) VALUES(${ORG}, '', 'error')`;
  created = true;
  // ---- Agero motor-club call normalization (owner bug 2026-08-11: live queue
  //      showed the ACCOUNT name 'Agero (Swoop) Bridgeport' + location 'Unknown').
  //      Real /api/calls shape: account = motor club, contacts[0] = the member,
  //      waypoints[0] = pickup with coords, assets[0] = the vehicle.
  const ageroCall = {
    id: 279754520,
    callNumber: 279754520,
    type: 1,
    tags: [],
    status: { id: 1, next: { statusId: 2, waypointId: 516941812 } },
    account: { id: 894873, zip: "06606", city: "Bridgeport", state: "CT", typeId: 5, address: "70 Pitt Street", company: "Agero (Swoop) Bridgeport", masterAccountId: 29 },
    contacts: [{ id: 250891316, zip: "", city: "", name: "Morgan R R.", type: 0, email: "", phone: "475-238-5705", state: "", address: "", isProblemCustomer: false, enableRoadsideMessages: false }],
    waypoints: [{ id: 516941812, zip: "06513", title: "Pickup", address: "55 Thompson St East Haven, CT 06513", hasToll: false, latitude: 41.323631, position: 1, longitude: -72.849784 }],
    towSource: "55 Thompson St East Haven, CT 06513",
    assets: [{ id: 281812512, vin: "2G1105SA7G9135427", make: "Chevrolet", year: 2016, color: { id: 1, name: "Black" }, model: "Impala", drivable: false }],
    reason: { id: 365, name: "Jump Start" },
    owner: { id: 116012, fullName: "Brittani Simms" },
    createDate: "2026-08-11T16:00:00",
  };
  const nA = normalizeJsonCall(ageroCall, "");
  check("Agero: call normalizes ok", nA.ok === true, nA.ok ? "" : nA.reason);
  if (nA.ok) {
    const j = nA.job;
    check("Agero: customer is the MEMBER (contacts[0].name), never the account", j.customer === "Morgan R R.", j.customer);
    check("Agero: phone comes from contacts[0].phone", j.phone === "475-238-5705", j.phone);
    check("Agero: pickup is the Pickup waypoint address", j.pickup === "55 Thompson St East Haven, CT 06513", j.pickup);
    check("Agero: area derives from pickup (never 'Unknown')", (j.pickup || "Unknown") !== "Unknown");
    check("Agero: pickup coords from the waypoint", j.pickupLat === 41.323631 && j.pickupLng === -72.849784, `${j.pickupLat},${j.pickupLng}`);
    check("Agero: vehicle make/model/year from assets[0]", j.vehicle.includes("2016") && j.vehicle.includes("Chevrolet") && j.vehicle.includes("Impala") && j.vehicle.includes("Black"), j.vehicle);
    check("Agero: single waypoint -> no spurious dropoff", j.dropoff === "", j.dropoff);
    check("Agero: service type derived from reason.name", typeof j.serviceType === "string" && j.serviceType.length > 0, j.serviceType);
    // upsert-level: the 3s loop's next pull must rewrite stored rows (backfill).
    // dispatch_jobs.id = "tb-<towbookId>" is a GLOBAL pkey: the owner org already
    // holds tb-279754520, so the DB-level insert uses a cloned call with a fresh id.
    const jIns = normalizeJsonCall({ ...ageroCall, id: 279999520, callNumber: 279999520 }, "").job;
    const rA = await upsertPulledJobs(ORG, { id: USER, role: "owner" }, [jIns], "sync:fixture-agero");
    check("Agero: first upsert adds 1", rA.added === 1, JSON.stringify(rA));
    const rowA = await q`SELECT customer_name, area, pickup, pickup_lat, pickup_lng FROM dispatch_jobs WHERE towbook_job_id='279999520' AND org_id=${ORG}`;
    check("Agero: stored customer_name is the member", rowA.length === 1 && rowA[0].customer_name === "Morgan R R.", JSON.stringify(rowA[0]));
    check("Agero: stored area is the pickup address, not 'Unknown'", rowA.length === 1 && rowA[0].area === "55 Thompson St East Haven, CT 06513", JSON.stringify(rowA[0]));
    check("Agero: stored pickup + coords", rowA.length === 1 && rowA[0].pickup === "55 Thompson St East Haven, CT 06513" && Math.abs(Number(rowA[0].pickup_lat) - 41.323631) < 1e-6 && Math.abs(Number(rowA[0].pickup_lng) - -72.849784) < 1e-6, JSON.stringify(rowA[0]));
    const rA2 = await upsertPulledJobs(ORG, { id: USER, role: "owner" }, [jIns], "sync:fixture-agero");
    check("Agero: re-sync reports unchanged (no churn)", rA2.unchanged === 1 && rA2.updated === 0, JSON.stringify(rA2));
    // Simulate the pre-fix stored state, then confirm the re-sync backfills it.
    await q`UPDATE dispatch_jobs SET customer_name='Agero (Swoop) Bridgeport', area='Unknown', pickup='', pickup_lat=NULL, pickup_lng=NULL WHERE towbook_job_id='279999520' AND org_id=${ORG}`;
    const rA3 = await upsertPulledJobs(ORG, { id: USER, role: "owner" }, [jIns], "sync:fixture-agero");
    check("Agero: backfill re-sync updates the row", rA3.updated === 1 && rA3.unchanged === 0, JSON.stringify(rA3));
    const rowA3 = await q`SELECT customer_name, area, pickup, pickup_lat, pickup_lng FROM dispatch_jobs WHERE towbook_job_id='279999520' AND org_id=${ORG}`;
    check("Agero: backfilled customer/area/pickup/coords", rowA3.length === 1 && rowA3[0].customer_name === "Morgan R R." && rowA3[0].area === "55 Thompson St East Haven, CT 06513" && rowA3[0].pickup === "55 Thompson St East Haven, CT 06513" && Number(rowA3[0].pickup_lat) === 41.323631 && Number(rowA3[0].pickup_lng) === -72.849784, JSON.stringify(rowA3[0]));
    await q`DELETE FROM status_events WHERE org_id=${ORG} AND job_id='tb-279999520'`.catch(() => {});
    await q`DELETE FROM audit_log WHERE org_id=${ORG} AND entity_id='tb-279999520'`.catch(() => {});
    await q`DELETE FROM dispatch_jobs WHERE towbook_job_id='279999520' AND org_id=${ORG}`.catch(() => {});
  }
  // two-waypoint variant: dropoff must come from the second waypoint
  const twoWp = { ...ageroCall, id: 999001, waypoints: [{ title: "Pickup", address: "A St", latitude: 41.1, longitude: -72.1, position: 1 }, { title: "Dropoff", address: "B St", latitude: 41.2, longitude: -72.2, position: 2 }] };
  const nT = normalizeJsonCall(twoWp, "");
  check("two-waypoint: pickup + dropoff both extracted", nT.ok && nT.job.pickup === "A St" && nT.job.dropoff === "B St", nT.ok ? `${nT.job.pickup} -> ${nT.job.dropoff}` : nT.reason);
  // club-only (no contacts): must still fall back to account.company
  const clubOnly = { ...ageroCall, id: 999002, contacts: [] };
  const nC = normalizeJsonCall(clubOnly, "");
  check("club-only (no contacts): falls back to account.company", nC.ok && nC.job.customer === "Agero (Swoop) Bridgeport", nC.ok ? nC.job.customer : nC.reason);
  // plain call with a top-level customer string: member wins over account
  const plain = { ...ageroCall, id: 999003, contacts: [], customer: "Jane Public" };
  const nP = normalizeJsonCall(plain, "");
  check("plain call: top-level customer wins over account", nP.ok && nP.job.customer === "Jane Public", nP.ok ? nP.job.customer : nP.reason);

  // ---- 0) mapping consts: 255 → cancelled, 252 → completed, 0..5 matches the
  //        CORRECTED map (2026-08-12 owner-reported bug: 1=Dispatched→accepted,
  //        2=En Route→en_route, 3=On Scene→arrived, 4=Towing→arrived),
  //        nothing left unmapped
  check("TOWBOOK_STATUS_ID_TO_LIFECYCLE[255] === 'cancelled'", TOWBOOK_STATUS_ID_TO_LIFECYCLE[255] === "cancelled");
  check("TOWBOOK_STATUS_ID_TO_LIFECYCLE[252] === 'completed'", TOWBOOK_STATUS_ID_TO_LIFECYCLE[252] === "completed");
  check("TOWBOOK_STATUS_ID_TO_LIFECYCLE[0..5] matches the corrected map (1=accepted, 2=en_route, 3/4=arrived, 5=completed)", [0, 1, 2, 3, 4, 5].every((n, i) => TOWBOOK_STATUS_ID_TO_LIFECYCLE[n] === ["new", "accepted", "en_route", "arrived", "arrived", "completed"][i]));
  check("TOWBOOK_STATUS_ID_UNMAPPED is empty (252 no longer unmapped)", !TOWBOOK_STATUS_ID_UNMAPPED.has(252) && TOWBOOK_STATUS_ID_UNMAPPED.size === 0);

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
  check("sampleByStatus['252'] captured with the evidence fields (chain + completionTime + ACKNOWLEDGE_COMPLETE)", sbs["252"] && sbs["252"].id === 109 && JSON.stringify(sbs["252"].statuses) === "[0,1,2,3,4,5]" && sbs["252"].completionTime === "2026-08-10T20:33:00" && Array.isArray(sbs["252"].availableActions) && sbs["252"].availableActions.includes("ACKNOWLEDGE_COMPLETE"), `id=${sbs["252"]?.id}`);
  for (const k of Object.keys(sbs)) {
    check(`sampleByStatus['${k}'] JSON ≤ 6000 chars`, JSON.stringify(sbs[k]).length <= 6000, `len=${JSON.stringify(sbs[k]).length}`);
  }
  check("trimRawCall dropped the heavy invoiceItems on the big 255 call", sbs["255"] && !("invoiceItems" in sbs["255"]));
  check("trimRawCall never returns undefined/string", typeof trimRawCall(calls[7]) === "object");

  // ---- 2) mapping loop (mirrors doSyncForOrg): 0..5 import, 255 → cancelled,
  //        252 → completed, nothing skipped
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
  check("9 mapped jobs (0..5 + 2×255 + 252)", normalized.length === 9, String(normalized.length));
  const cancelledNorm = normalized.filter((j) => j.status === "cancelled");
  check("255 normalized as 'cancelled' (2 calls → both cancelled)", cancelledNorm.length === 2 && cancelledNorm.every((j) => j.towbookStatus === "255"), cancelledNorm.map((j) => j.towbookJobId).join(","));
  const completed252 = normalized.filter((j) => j.towbookStatus === "252");
  check("252 normalized as 'completed' (1 call, towbookStatus 252)", completed252.length === 1 && completed252[0].status === "completed", JSON.stringify(completed252));
  check("0 calls skipped (all observed ids now map)", skipped.length === 0, String(skipped.length));
  const unmappedIds = [...statusIdCounts.keys()].filter((s) => !TOWBOOK_STATUS_ID_TO_LIFECYCLE[Number(s)]);
  check("diagnostic unmapped set is empty", unmappedIds.join(",") === "", unmappedIds.join(","));

  // ---- 2.5) previousStatusFromHistory: no spurious X→X import events
  check("prev([0,252]→completed) = import (derived prev equals current — guard)", previousStatusFromHistory({ statuses: [0, 252] }, "completed") === "import");
  check("prev([0..5]→completed) = import (in-chain: allowed workflow, not journey)", previousStatusFromHistory({ statuses: [0, 1, 2, 3, 4, 5] }, "completed") === "import");
  check("prev([0..5]→cancelled) = completed (255 journey preserved)", previousStatusFromHistory({ statuses: [0, 1, 2, 3, 4, 5] }, "cancelled") === "completed");
  check("prev([255]→cancelled) = import (255 in its own chain)", previousStatusFromHistory({ statuses: [255] }, "cancelled") === "import");
  check("prev([]→completed) = import (no chain)", previousStatusFromHistory({ statuses: [] }, "completed") === "import");

  // ---- 3) FIRST upsert into the QA org (real code path): all 9 import
  const actor = { id: USER, role: "owner" };
  const res = await upsertPulledJobs(ORG, actor, normalized, "fixture-test");
  check("first upsert added 9, updated 0, unchanged 0, failed 0", res.added === 9 && res.updated === 0 && res.unchanged === 0 && res.failed === 0, JSON.stringify(res));
  const jobs = await q`SELECT id, towbook_job_id, status, towbook_status FROM dispatch_jobs WHERE org_id=${ORG}`;
  check("dispatch_jobs has 9 rows", jobs.length === 9, String(jobs.length));
  const cancelledRows = jobs.filter((j) => String(j.status) === "cancelled");
  check("2 rows imported as 'cancelled' with towbook_status 255", cancelledRows.length === 2 && cancelledRows.every((j) => String(j.towbook_status) === "255"), jobs.map((j) => `${j.towbook_job_id}:${j.status}`).join(","));
  const completed252Rows = jobs.filter((j) => String(j.towbook_status) === "252");
  check("1 row imported as 'completed' with towbook_status 252", completed252Rows.length === 1 && String(completed252Rows[0].status) === "completed", jobs.map((j) => `${j.towbook_job_id}:${j.status}`).join(","));
  check("0..5 rows import with their lifecycle status", jobs.filter((j) => ["0", "1", "2", "3", "4", "5"].includes(String(j.towbook_status))).length === 6, jobs.map((j) => `${j.towbook_job_id}:${j.status}`).join(","));

  // import events: 255 row must carry the real previous state (completed from the
  // statuses chain [0,1,2,3,4,5]); the new/status-0 row keeps import→new; the
  // 252 row keeps import→completed (NO spurious completed→completed).
  const ev = await q`SELECT job_id, from_status, to_status, note FROM status_events WHERE org_id=${ORG} ORDER BY occurred_at, job_id`;
  check("9 import events written (one per job)", ev.length === 9, String(ev.length));
  const cancelEv = ev.filter((e) => String(e.to_status) === "cancelled");
  check("cancelled import events go completed→cancelled (from statuses history)", cancelEv.length === 2 && cancelEv.every((e) => String(e.from_status) === "completed"), JSON.stringify(cancelEv));
  check("cancelled import events carry the import note", cancelEv.every((e) => String(e.note).includes("imported from Towbook")));
  const newEv = ev.filter((e) => String(e.to_status) === "new");
  check("new job import stays import→new (history not misused when it equals current)", newEv.length === 1 && String(newEv[0].from_status) === "import", JSON.stringify(newEv));
  const ev252 = ev.filter((e) => String(e.job_id) === "tb-109");
  check("252 first-seen import is import→completed (no spurious completed→completed)", ev252.length === 1 && String(ev252[0].from_status) === "import" && String(ev252[0].to_status) === "completed" && String(ev252[0].note).includes("imported from Towbook"), JSON.stringify(ev252));
  const audit = await q`SELECT count(*)::int n FROM audit_log WHERE org_id=${ORG}`;
  check("audit_log has 9 towbook_import rows", Number(audit[0].n) === 9, String(audit[0].n));

  // ---- 4) SECOND sync (same calls): re-upsert without churn
  const res2 = await upsertPulledJobs(ORG, actor, normalized, "fixture-test");
  check("second upsert: added 0, updated 0, unchanged 9, failed 0 (no churn)", res2.added === 0 && res2.updated === 0 && res2.unchanged === 9 && res2.failed === 0, JSON.stringify(res2));
  const ev2 = await q`SELECT count(*)::int n FROM status_events WHERE org_id=${ORG}`;
  check("status_events unchanged after re-sync (still 9)", Number(ev2[0].n) === 9, String(ev2[0].n));

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

  // ---- 5b) accepted→completed TRANSITION via 252: a job first imported as
  //        accepted (status 1 = Dispatched — corrected map 2026-08-12; the
  //        owner's live job 279656932 shape) re-syncs as 252 → UPDATE
  //        accepted→completed + event + audit
  const acceptedCall = fixtureCall(111, 1, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T21:00:00", dispatchTime: "2026-08-10T21:05:00", notes: "accepted→completed via 252" });
  const completedVia252 = fixtureCall(111, 252, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T21:00:00", dispatchTime: "2026-08-10T21:05:00", enrouteTime: "2026-08-10T21:06:00", arrivalTime: "2026-08-10T21:20:00", completionTime: "2026-08-10T21:33:00", invoiceStatusId: 1, purchaseOrderNumber: "112509304", availableActions: ["ACKNOWLEDGE_COMPLETE", "UPDATE_STATUS", "CANCEL"], notes: "accepted→completed via 252" });
  const nAcc = normalizeJsonCall(acceptedCall, "");
  check("5b pre-step: status-1 call normalizes as accepted", nAcc.ok && nAcc.job.status === "accepted", JSON.stringify(nAcc));
  const res5 = await upsertPulledJobs(ORG, actor, [nAcc.job], "fixture-test");
  check("5b step 1: accepted job added", res5.added === 1 && res5.updated === 0, JSON.stringify(res5));
  const n252 = normalizeJsonCall(completedVia252, "");
  check("5b pre-step: 252 call normalizes as completed with towbookStatus 252", n252.ok && n252.job.status === "completed" && n252.job.towbookStatus === "252", JSON.stringify(n252));
  const res6 = await upsertPulledJobs(ORG, actor, [n252.job], "fixture-test");
  check("5b step 2: re-sync as 252 → updated 1 (accepted→completed)", res6.added === 0 && res6.updated === 1 && res6.failed === 0, JSON.stringify(res6));
  const tj111 = await q`SELECT status, towbook_status FROM dispatch_jobs WHERE org_id=${ORG} AND towbook_job_id='111'`;
  check("5b row is now 'completed' with towbook_status 252", tj111.length === 1 && String(tj111[0].status) === "completed" && String(tj111[0].towbook_status) === "252", JSON.stringify(tj111));
  const tev111 = await q`SELECT from_status, to_status FROM status_events WHERE org_id=${ORG} AND job_id='tb-111' ORDER BY occurred_at`;
  check("5b wrote import→accepted then accepted→completed events", tev111.length === 2 && String(tev111[0].from_status) === "import" && String(tev111[0].to_status) === "accepted" && String(tev111[1].from_status) === "accepted" && String(tev111[1].to_status) === "completed", JSON.stringify(tev111));
  const aud111 = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND entity_id='tb-111' AND action='towbook_status_change'`;
  check("5b audit row: towbook_status_change from accepted to completed", aud111.length === 1 && aud111[0].detail.from === "accepted" && aud111[0].detail.to === "completed", JSON.stringify(aud111));

  // ---- 5c) 255→252 FLIP: a job imported as cancelled (255) re-syncs as 252 →
  //        UPDATE cancelled→completed — terminal→terminal IS allowed for
  //        sync-driven corrections (Towbook is the system of record)
  const cancelledCall = fixtureCall(112, 255, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T19:00:00", dispatchTime: "2026-08-10T19:05:00", completionTime: "2026-08-10T19:40:00", availableActions: ["UNDO_CANCEL", "DELETE"], notes: "cancelled→completed via 252 flip" });
  const flipTo252 = fixtureCall(112, 252, [0, 1, 2, 3, 4, 5], { createDate: "2026-08-10T19:00:00", dispatchTime: "2026-08-10T19:05:00", completionTime: "2026-08-10T19:40:00", availableActions: ["ACKNOWLEDGE_COMPLETE", "UPDATE_STATUS", "CANCEL"], notes: "cancelled→completed via 252 flip" });
  const nCancelled = normalizeJsonCall(cancelledCall, "");
  check("5c pre-step: 255 call normalizes as cancelled", nCancelled.ok && nCancelled.job.status === "cancelled", JSON.stringify(nCancelled));
  const res7 = await upsertPulledJobs(ORG, actor, [nCancelled.job], "fixture-test");
  check("5c step 1: cancelled (255) job added", res7.added === 1 && res7.updated === 0, JSON.stringify(res7));
  const nFlip = normalizeJsonCall(flipTo252, "");
  check("5c pre-step: 252 call normalizes as completed", nFlip.ok && nFlip.job.status === "completed", JSON.stringify(nFlip));
  const res8 = await upsertPulledJobs(ORG, actor, [nFlip.job], "fixture-test");
  check("5c step 2: 255→252 flip → updated 1 (terminal→terminal allowed)", res8.added === 0 && res8.updated === 1 && res8.failed === 0, JSON.stringify(res8));
  const tj112 = await q`SELECT status FROM dispatch_jobs WHERE org_id=${ORG} AND towbook_job_id='112'`;
  check("5c row is now 'completed' (corrected by sync)", tj112.length === 1 && String(tj112[0].status) === "completed", JSON.stringify(tj112));
  const tev112 = await q`SELECT from_status, to_status, note FROM status_events WHERE org_id=${ORG} AND job_id='tb-112' ORDER BY occurred_at`;
  check("5c wrote completed→cancelled (import) then cancelled→completed (transition)", tev112.length === 2 && String(tev112[0].from_status) === "completed" && String(tev112[0].to_status) === "cancelled" && String(tev112[1].from_status) === "cancelled" && String(tev112[1].to_status) === "completed", JSON.stringify(tev112));
  check("5c transition event carries the status-change note", String(tev112[1].note).includes("status change from Towbook"));
  const aud112 = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND entity_id='tb-112' AND action='towbook_status_change'`;
  check("5c audit row: towbook_status_change from cancelled to completed", aud112.length === 1 && aud112[0].detail.from === "cancelled" && aud112[0].detail.to === "completed", JSON.stringify(aud112));

  // ---- 6) History query (the data-layer equivalent of the History tab filter
  //        HISTORY_STATUSES = ['completed','cancelled']): includes cancelled jobs
  const historyRows = await q`SELECT towbook_job_id, status FROM dispatch_jobs WHERE org_id=${ORG} AND status IN ('completed','cancelled') ORDER BY towbook_job_id`;
  check("History query returns completed + cancelled jobs (7 rows)", historyRows.length === 7, JSON.stringify(historyRows));
  check("History: 3 cancelled (255 rows + completed-then-cancelled) + 4 completed (incl. 252)", historyRows.filter((r) => String(r.status) === "cancelled").length === 3 && historyRows.filter((r) => String(r.status) === "completed").length === 4, JSON.stringify(historyRows));
  const activeQuery = await q`SELECT count(*)::int n FROM dispatch_jobs WHERE org_id=${ORG} AND status IN ('offered','accepted','en_route','arrived')`;
  check("Active query excludes completed/cancelled (4 rows in offered..arrived)", Number(activeQuery[0].n) === 4, String(activeQuery[0].n));

  // ---- 6.5) message arithmetic (the exact doSyncForOrg formula): found =
  //        normalized + skipped; failed = res.failed + skipped; and
  //        found === added + updated + unchanged + failed, always.
  const found = normalized.length + skipped.length;
  const failed = res.failed + skipped.length;
  const msg = buildSyncMessage(found, res.added, res.updated, res.unchanged, failed);
  check("message reconciles: found === added+updated+unchanged+failed (9 = 9+0+0+0)", found === res.added + res.updated + res.unchanged + failed, msg);
  check("message text exact", msg === "Synced 9 Towbook job(s): 9 added, 0 updated, 0 unchanged, 0 failed.", msg);
  // the 22:33 bug shape ("Synced 20 … 21 failed") — new form must reconcile
  const msgBug = buildSyncMessage(41, 0, 0, 20, 21);
  check("22:33 bug shape now reconciles: 41 = 0+0+20+21", msgBug === "Synced 41 Towbook job(s): 0 added, 0 updated, 20 unchanged, 21 failed.", msgBug);
  // a skip-bearing batch (found = normalized + skipped, failed includes skipped)
  const msgSkip = buildSyncMessage(3, 2, 0, 0, 1);
  check("skip-bearing batch reconciles: 3 = 2+0+0+1", msgSkip === "Synced 3 Towbook job(s): 2 added, 0 updated, 0 unchanged, 1 failed.", msgSkip);

  // ---- 7) persist + JSONB round-trip (the exact doSyncForOrg result shape)
  const result = {
    ok: true,
    code: "ok",
    message: msg,
    added: res.added,
    updated: res.updated,
    failed,
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
  check("persisted counts: added 9 / updated 0 / failed 0", Number(p.added) === 9 && Number(p.updated) === 0 && Number(p.failed) === 0, JSON.stringify({ added: p.added, updated: p.updated, failed: p.failed }));
  check("persisted message matches the helper", p.message === msg, p.message);
  check("sample is a JSONB ARRAY (round-trips; not the string 'undefined')", Array.isArray(p.sample) && typeof p.sample !== "string", `typeof=${typeof p.sample}`);
  check("sample[0] is a real call object with status", p.sample[0] && typeof p.sample[0] === "object" && p.sample[0].status && typeof p.sample[0].status.id === "number");
  check("sample[1].statuses is an array", Array.isArray(p.sample[1]?.statuses));
  check("sampleByStatus round-trips as an object", p.sampleByStatus && typeof p.sampleByStatus === "object" && !Array.isArray(p.sampleByStatus));
  check("sampleByStatus['255'].statuses === [0,1,2,3,4,5] (the complete 255 history)", JSON.stringify(p.sampleByStatus["255"]?.statuses) === "[0,1,2,3,4,5]", JSON.stringify(p.sampleByStatus["255"]?.statuses));
  check("sampleByStatus['255'] keeps availableActions + account + waypoints + completionTime", Array.isArray(p.sampleByStatus["255"]?.availableActions) && p.sampleByStatus["255"]?.account?.company && Array.isArray(p.sampleByStatus["255"]?.waypoints) && p.sampleByStatus["255"]?.completionTime);
  check("sampleByStatus['255'].id is the newest call", p.sampleByStatus["255"]?.id === 108, String(p.sampleByStatus["255"]?.id));
  check("sampleByStatus['5'].completionTime present", p.sampleByStatus["5"]?.completionTime === "2026-08-10T19:38:00");
  check("sampleByStatus['252'] persisted with completionTime + ACKNOWLEDGE_COMPLETE", p.sampleByStatus["252"]?.completionTime === "2026-08-10T20:33:00" && Array.isArray(p.sampleByStatus["252"]?.availableActions) && p.sampleByStatus["252"].availableActions.includes("ACKNOWLEDGE_COMPLETE"), JSON.stringify(p.sampleByStatus["252"]?.completionTime));
  check("statusShapes persisted unchanged (8 shapes incl 255 + 252)", Array.isArray(p.statusShapes) && p.statusShapes.length === 8 && p.statusShapes.some((s) => s.includes("255")) && p.statusShapes.some((s) => s.includes("252")));
  check("no field is the literal string 'undefined'", !Object.values(p).some((v) => v === "undefined"));
  const auditTotals = await q`SELECT count(*)::int n, count(*) FILTER (WHERE action='towbook_import')::int imports, count(*) FILTER (WHERE action='towbook_status_change')::int changes FROM audit_log WHERE org_id=${ORG}`;
  check("audit totals: 12 imports + 3 status changes = 15 rows", Number(auditTotals[0].n) === 15 && Number(auditTotals[0].imports) === 12 && Number(auditTotals[0].changes) === 3, JSON.stringify(auditTotals[0]));

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
    assertQaOrg(ORG);
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
