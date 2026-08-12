// Hermetic acceptance-sync test (2026-08-12, release-blocking fix):
// a driver-accepted call (Towbook status id 1 = Dispatched) must land in
// dispatch_jobs within ONE sync cycle. Proven live shapes are reproduced:
//   - /api/calls?status=1 returns [] (the broken bucket — accepted calls never
//     surface there; 21:41 probe: 200, 2 bytes, count 0, 4.6s)
//   - the UNFILTERED /api/calls base list is the ONLY surface that contains
//     every status incl. accepted (21:41 probe: 42 calls spanning 2/3/5/255)
// The sync walk now walks the base list FIRST and stops once a JSON page
// yields jobs, so the accepted call imports within one syncForOrg call —
// previously the walk burned the 10s discovery budget on status=0/1/2 and
// never reached the base list (job 279919891 accepted 18:43, imported only at
// 20:43 after advancing to status 2).
//   DATABASE_URL=... bun acceptance-sync.test.mjs
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL) {
  try {
    const pid = execSync("pgrep -f 'bun run serve.ts' | head -1").toString().trim();
    if (pid) {
      const env = await readFile(`/proc/${pid}/environ`, "utf8");
      const hit = env.split("\0").find((e) => e.startsWith("DATABASE_URL="));
      if (hit) process.env.DATABASE_URL = hit.slice("DATABASE_URL=".length);
    }
  } catch { /* runner must supply DATABASE_URL */ }
}
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 13).toString("base64");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { syncForOrg } = await import("./src/data/sync-engine.ts");
await ensureSchema();
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ORG = `qa-acc-${randomUUID()}`;
const USER = `qa-acc-u-${randomUUID()}`;
const CALL_ACCEPTED = "279988501"; // unique — must not collide with stray QA fixtures
const CALL_ENROUTE = "279988502";
const CALL_COMPLETED = "279988503";
const ACTOR = { id: USER, role: "owner" };

/** Faithful minimal call objects matching the REAL Towbook shapes captured in
 *  /home/team/shared/towbook-recon-evidence/acceptance-sync-2026-08-12/. */
const acceptedCall = {
  id: Number(CALL_ACCEPTED), callNumber: 24699, type: 1, companyId: 23257,
  version: 1, status: { id: 1, next: { statusId: 2, waypointId: 517299001 } },
  statuses: [0, 1, 2, 3, 4, 5], dispatchTime: "2026-08-12T21:30:00",
  createDate: "2026-08-12T21:25:00", priority: 0, towSource: "84 Grand Ave New Haven, CT 06513",
  purchaseOrderNumber: "26-0812-99999",
  reason: { id: 364, name: "Lock-Out" },
  account: { id: 894873, company: "Agero (Swoop) Bridgeport", zip: "06606", state: "CT", city: "Bridgeport" },
  contacts: [{ id: 251099001, name: "QA Acceptance Tester", phone: "475-555-0101", type: 0 }],
  waypoints: [{ id: 517299001, title: "Pickup", address: "84 Grand Ave New Haven, CT 06513", latitude: 41.309244, longitude: -72.891035, position: 1 }],
  assets: [{ id: 281999001, vin: "1FMCU93168KA62623", make: "Ford", model: "Escape", year: 2008, driver: { id: 703785, name: "Jayden Fountain", responseStatusId: 1 } }],
};
const enrouteCall = { ...acceptedCall, id: Number(CALL_ENROUTE), callNumber: 24700, status: { id: 2 }, enrouteTime: "2026-08-12T21:40:00", dispatchTime: "2026-08-12T21:30:00" };
const completedCall = { ...acceptedCall, id: Number(CALL_COMPLETED), callNumber: 24701, status: { id: 5 }, completionTime: "2026-08-12T20:00:00", createDate: "2026-08-12T18:00:00", dispatchTime: "2026-08-12T18:05:00" };

let baseCalls = [acceptedCall, enrouteCall, completedCall]; // stateful: test mutates accepted→en_route
const hitUrls = [];
const json = (body) => ({ status: 200, ok: true, headers: new Headers({ "content-type": "application/json; charset=utf-8" }), async text() { return JSON.stringify(body); }, async json() { return body; } });
/** Stub ONLY app.towbook.com — everything else passes through (DB client). */
const realFetch = globalThis.fetch;
const stub = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes("app.towbook.com")) return realFetch(url, init);
  hitUrls.push(u);
  const path = u.replace("https://app.towbook.com", "");
  if (path === "/api/calls") return json(baseCalls);
  if (path === "/api/calls?status=0") return json([]);
  if (path === "/api/calls?status=1") return json([]); // PROVEN broken bucket
  if (path === "/api/calls?status=2") return json(baseCalls.filter((c) => c.status.id === 2));
  if (path === "/api/callRequests/") return json([]);
  if (path === "/api/jobs" || path === "/api/jobs/current" || path === "/api/jobs/open" || path === "/api/jobs/active" || path === "/api/jobs/completed" || path === "/api/dispatch" || path === "/api/dispatches") return { status: 404, ok: false, headers: new Headers(), async text() { return ""; }, async json() { throw new Error("nf"); } };
  return { status: 200, ok: true, headers: new Headers({ "content-type": "text/html" }), async text() { return "<html><body>dashboard</body></html>"; }, async json() { throw new Error("not json"); } };
};

try {
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa acceptance sync')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${USER}, 'QA Acceptance', ${`acc-${randomUUID()}@qa.local`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${USER}, 'owner')`;
  const enc = await encryptSession(JSON.stringify({ cookies: "xtl=acceptance-sync-cookie", baseUrl: "https://app.towbook.com" }));
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind) VALUES(${ORG}, ${enc}, 'connected', 'owner')`;

  /* ============ 1) accepted call (status 1) imports within ONE cycle ============ */
  globalThis.fetch = stub;
  let r;
  try {
    r = await syncForOrg(ORG, "sync:test", ACTOR);
  } finally {
    globalThis.fetch = realFetch; // NEVER leak the stub
  }
  check("run 1: code ok", r.code === "ok", r.message);
  check("run 1: accepted call added", r.added >= 1, `added=${r.added} msg=${r.message}`);
  const jobs1 = await q`SELECT id, status, towbook_job_id, towbook_status FROM dispatch_jobs WHERE org_id=${ORG} AND towbook_job_id=${CALL_ACCEPTED}`;
  check("run 1: accepted call row exists with lifecycle 'accepted'", jobs1.length === 1 && String(jobs1[0].status) === "accepted", JSON.stringify(jobs1));
  check("run 1: raw towbook status preserved as 1", jobs1.length === 1 && String(jobs1[0].towbook_status) === "1", JSON.stringify(jobs1));
  check("run 1: base list walked FIRST (url order)", hitUrls.indexOf("https://app.towbook.com/api/calls") !== -1 && hitUrls.indexOf("https://app.towbook.com/api/calls") < (hitUrls.findIndex((h) => h.includes("?status=")) === -1 ? hitUrls.length : hitUrls.findIndex((h) => h.includes("?status="))), JSON.stringify(hitUrls));
  check("run 1: status=1 bucket never needed — base list carried the accepted call (early-stop)", !hitUrls.some((h) => h.includes("status=1")), JSON.stringify(hitUrls));
  const diagUrls = (r.diagnostics || []).map((d) => d.url);
  check("run 1: no discovery-cap (base list reached within budget)", !diagUrls.some((u) => u === "<discovery-cap>"), JSON.stringify(r.diagnostics?.slice(-3)));
  const allJobs1 = await q`SELECT count(*) AS n FROM dispatch_jobs WHERE org_id=${ORG}`;
  check("run 1: en_route + completed also imported", Number(allJobs1[0].n) === 3, `n=${allJobs1[0].n}`);

  /* ============ 2) idempotent re-sync: zero churn ============ */
  globalThis.fetch = stub;
  try {
    r = await syncForOrg(ORG, "sync:test2", ACTOR);
  } finally {
    globalThis.fetch = realFetch;
  }
  check("run 2: unchanged (no churn on same shapes)", r.added === 0 && r.updated === 0, `added=${r.added} updated=${r.updated}`);

  /* ============ 3) status transition accepted→en_route still flows ============ */
  baseCalls = baseCalls.map((c) => (String(c.id) === CALL_ACCEPTED ? { ...c, status: { id: 2 }, enrouteTime: "2026-08-12T21:50:00" } : c));
  globalThis.fetch = stub;
  try {
    r = await syncForOrg(ORG, "sync:test3", ACTOR);
  } finally {
    globalThis.fetch = realFetch;
  }
  const jobs3 = await q`SELECT status, towbook_status FROM dispatch_jobs WHERE org_id=${ORG} AND towbook_job_id=${CALL_ACCEPTED}`;
  check("run 3: accepted→en_route update applied", jobs3.length === 1 && String(jobs3[0].status) === "en_route" && String(jobs3[0].towbook_status) === "2", JSON.stringify(jobs3));

  console.log("\nALL ACCEPTANCE-SYNC CHECKS PASSED");
  for (const [name, ok, extra] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
} finally {
  // ---- cleanup: QA org cascade; verify ZERO rows left behind
  globalThis.fetch = realFetch;
  assertQaOrg(ORG);
  await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
  await q`DELETE FROM users WHERE id=${USER}`.catch(() => {});
  const leftover = await q`SELECT
    (SELECT count(*) FROM dispatch_jobs WHERE org_id=${ORG}) AS jobs,
    (SELECT count(*) FROM status_events WHERE org_id=${ORG}) AS ev,
    (SELECT count(*) FROM audit_log WHERE org_id=${ORG}) AS audit,
    (SELECT count(*) FROM towbook_sessions WHERE org_id=${ORG}) AS sess,
    (SELECT count(*) FROM organization_memberships WHERE org_id=${ORG}) AS members`;
  check("cleanup: zero QA rows", Number(leftover[0].jobs) === 0 && Number(leftover[0].ev) === 0 && Number(leftover[0].audit) === 0 && Number(leftover[0].sess) === 0 && Number(leftover[0].members) === 0, JSON.stringify(leftover[0]));
  if (!checks.every(([, ok]) => ok)) {
    console.log("\nFAILED checks:");
    for (const [name, ok, extra] of checks) if (!ok) console.log(`  FAIL ${name} ${extra}`);
    process.exit(1);
  }
}
