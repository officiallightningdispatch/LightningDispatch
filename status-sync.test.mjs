// Hermetic bidirectional status-sync tests (2026-08-11, owner bug: "the job
// status does not change on Towbook when I change it on the portal and vice
// versa"). The pull side (Towbook → portal, server.ts syncForOrg / 30s loop +
// upsertPulledJobs) already existed and is regression-checked here; the push
// side (portal → Towbook, status-push-core.ts) is the new surface under test:
// every owner/admin/dispatcher job status change that lands in dispatch_jobs
// is pushed to Towbook via PUT /api/calls/{callId} {id, status:{id:N}} with
// GET-first idempotency, a predecessor last-write-wins guard, one retry, a
// read-back verify, and escalation (escalated_status_push_failed) into the ops
// "Needs attention" ledger on failure. Real Towbook calls never happen: the
// push takes an injectable fetchImpl. DB-backed against throwaway QA orgs
// (qa-status-*@lightning.test) deleted at the end (zero rows left).
//   DATABASE_URL=... bun status-sync.test.mjs
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  // Sandbox convenience: the live server process carries DATABASE_URL in its
  // environ — reuse it so the suite runs with the same DB as everything else.
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
// Test key for THIS process only (env-first resolution overrides the stable
// key file — same pattern as the other suites).
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 7).toString("base64");
const { pushJobStatusToTowbook, LIFECYCLE_TO_TOWBOOK_STATUS_ID } = await import("./src/data/status-push-core.ts");
const { upsertPulledJobs } = await import("./src/data/server.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-status-${randomUUID()}`;      // connected owner session → push flows
const ORG2 = `qa-status2-${randomUUID()}`;    // NO owner session → skip gate
const OWNER = `qa-status-owner-${randomUUID()}`;
const ADMIN = `qa-status-admin-${randomUUID()}`;
const DISPATCHER = `qa-status-dispatch-${randomUUID()}`;
const JOB_ACCEPT = `qa-status-accept-${randomUUID()}`;   // offered→accepted push (2)
const JOB_NOOP = `qa-status-noop-${randomUUID()}`;       // already-at-status no-op
const JOB_RACE = `qa-status-race-${randomUUID()}`;       // newer-status-wins guard
const JOB_DISPATCHER = `qa-status-disp-${randomUUID()}`; // en_route→arrived (4), dispatcher actor
const JOB_FAIL = `qa-status-fail-${randomUUID()}`;       // PUT 500 → retry → escalate
const JOB_VERIFY = `qa-status-verify-${randomUUID()}`;   // PUT ok, verify mismatch → escalate
const JOB_DECLINE = `qa-status-decline-${randomUUID()}`; // offered→new push (0)
const JOB_ASSIGN = `qa-status-assign-${randomUUID()}`;   // new→offered push (1)
const JOB_NOID = `qa-status-noid-${randomUUID()}`;       // no towbook_job_id → skip
const JOB_CANCEL = `qa-status-cancel-${randomUUID()}`;   // cancelled → unpushable skip
const JOB2_SESSION = `qa-status2-job-${randomUUID()}`;   // ORG2 no-session skip
const CALL_ACCEPT = "880001";
const CALL_DECLINE = "880002";
const CALL_ASSIGN = "880003";

const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const DISPATCH_ACTOR = { orgId: ORG, id: DISPATCHER, role: "dispatcher" };

/** Stateful Towbook /api/calls mock: GET returns the CURRENT status; PUT
 *  applies the requested status (unless failPut) so the read-back verify sees
 *  the write. Records every call with parsed body. */
function makeFetch({ initialStatus = 1, failPut = false, getStatus = null, expireGet = false } = {}) {
  const calls = [];
  let status = initialStatus;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    const m = u.match(/\/api\/calls\/(\d+)$/);
    if (!m) throw new Error(`unexpected URL ${method} ${u}`);
    const callId = Number(m[1]);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body });
    const json = (s, b) => ({ status: s, ok: s >= 200 && s < 300, text: async () => JSON.stringify(b), json: async () => JSON.parse(JSON.stringify(b)) });
    if (method === "GET") {
      if (expireGet) return json(401, { error: "unauthorized" });
      return json(200, { id: callId, status: { id: getStatus ? getStatus() : status } });
    }
    if (method === "PUT") {
      if (failPut) return json(500, { error: "boom" });
      const toStatus = body.status.id;
      status = toStatus; // Towbook applied the update
      return json(200, { id: body.id, status: { id: toStatus } });
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { fetchImpl, calls, setStatus: (s) => { status = s; }, getStatus: () => status };
}
const puts = (calls) => calls.filter((c) => c.method === "PUT");
const gets = (calls) => calls.filter((c) => c.method === "GET");

async function setup() {
  await ensureSchema();
  for (const [org, owner, admin, dispatcher] of [
    [ORG, OWNER, ADMIN, DISPATCHER],
    [ORG2, `qa-status2-owner-${randomUUID()}`, null, null],
  ]) {
    await q`INSERT INTO organizations(id, name) VALUES(${org}, 'qa status-sync')`;
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${owner}, 'QA Status Owner', ${`qa-status-owner-${randomUUID()}@lightning.test`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${owner}, 'owner')`;
    if (admin) {
      await q`INSERT INTO users(id, name, email, password_hash) VALUES(${admin}, 'QA Status Admin', ${`qa-status-admin-${randomUUID()}@lightning.test`}, 'x')`;
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${admin}, 'admin')`;
    }
    if (dispatcher) {
      await q`INSERT INTO users(id, name, email, password_hash) VALUES(${dispatcher}, 'QA Status Dispatcher', ${`qa-status-dispatch-${randomUUID()}@lightning.test`}, 'x')`;
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${dispatcher}, 'dispatcher')`;
    }
    if (org === ORG) {
      // The owner's connected Towbook session — the same row the pull uses.
      await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind)
        VALUES(${org}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake-status", baseUrl: "https://app.towbook.com" }))}, 'connected', 'owner')`;
    }
  }
  // Jobs: the local transition ALREADY committed (that's what the server fns
  // do before calling the push) — the push reads the fresh DB status.
  const jobs = [
    [JOB_ACCEPT, "accepted", CALL_ACCEPT],
    [JOB_NOOP, "arrived", "880004"],
    [JOB_RACE, "accepted", "880005"],
    [JOB_DISPATCHER, "arrived", "880006"],
    [JOB_FAIL, "arrived", "880007"],
    [JOB_VERIFY, "arrived", "880008"],
    [JOB_DECLINE, "new", CALL_DECLINE],
    [JOB_ASSIGN, "offered", CALL_ASSIGN],
    [JOB_NOID, "accepted", null],
    [JOB_CANCEL, "cancelled", "880009"],
  ];
  for (const [id, status, callId] of jobs) {
    await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, customer_phone, vehicle_desc, pickup, dropoff, towbook_status)
      VALUES(${id}, ${ORG}, 'QA Status Job', '', 0, 0, 'Bridgeport', 'flatbed_tow', ${status}, NOW(), '', ${callId}, '', '', 'Main St', '', ${callId ? "1" : null})`;
  }
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id)
    VALUES(${JOB2_SESSION}, ${ORG2}, 'QA Status Job 2', '', 0, 0, 'Bridgeport', 'flatbed_tow', 'accepted', NOW(), '', '880010')`;
}
await setup();

/* ==================== 1) owner push fires exactly one verified PUT ==================== */
{
  // The owner advanced offered→accepted locally; Towbook is still at 1 (offered).
  const m = makeFetch({ initialStatus: 1 });
  const r = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_ACCEPT, actor: ACTOR, opts: { fetchImpl: m.fetchImpl } });
  check("owner push ok + changed", r.ok === true && r.changed === true && r.skipped === false, JSON.stringify(r));
  const p = puts(m.calls);
  check("exactly ONE PUT fired", p.length === 1, JSON.stringify(m.calls));
  check("PUT has the right shape + status id", p[0].url.endsWith(`/api/calls/${CALL_ACCEPT}`) && p[0].body && p[0].body.id === 880001 && p[0].body.status && p[0].body.status.id === 2, JSON.stringify(p[0]));
  check("sequence: GET-idempotency → PUT → GET-verify", gets(m.calls).length === 2 && m.calls[0].method === "GET" && m.calls[1].method === "PUT" && m.calls[2].method === "GET", JSON.stringify(m.calls));
  const row = await q`SELECT status, towbook_status FROM dispatch_jobs WHERE id=${JOB_ACCEPT}`;
  check("DB towbook_status records the verified push", row.length === 1 && String(row[0].status) === "accepted" && String(row[0].towbook_status) === "2", JSON.stringify(row));
  const aud = await q`SELECT action, actor_role, detail FROM audit_log WHERE org_id=${ORG} AND entity_id=${JOB_ACCEPT} AND action='status_push_verified'`;
  check("audit status_push_verified (owner actor)", aud.length === 1 && String(aud[0].actor_role) === "owner" && aud[0].detail && aud[0].detail.toStatus === 2 && aud[0].detail.towbookJobId === CALL_ACCEPT, JSON.stringify(aud));
}

/* ==================== 2) dispatcher actor push (en_route→arrived) ==================== */
{
  const m = makeFetch({ initialStatus: 2 });
  const r = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_DISPATCHER, actor: DISPATCH_ACTOR, opts: { fetchImpl: m.fetchImpl } });
  check("dispatcher push ok, one PUT status 4", r.ok === true && r.changed === true && puts(m.calls).length === 1 && puts(m.calls)[0].body.status.id === 4, JSON.stringify(r) + JSON.stringify(m.calls));
  const aud = await q`SELECT actor_role FROM audit_log WHERE org_id=${ORG} AND entity_id=${JOB_DISPATCHER} AND action='status_push_verified'`;
  check("audit actor_role dispatcher", aud.length === 1 && String(aud[0].actor_role) === "dispatcher", JSON.stringify(aud));
}

/* ==================== 3) same transition again → no-op, never a double PUT ==================== */
{
  // Towbook already reports 4 (arrived) — re-pushing the same transition is a no-op.
  const m = makeFetch({ initialStatus: 4 });
  const r = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_NOOP, actor: ACTOR, opts: { fetchImpl: m.fetchImpl } });
  check("re-push no-op", r.ok === true && r.changed === false && r.skipped === true && r.reason === "already-at-status", JSON.stringify(r));
  check("zero PUTs on no-op", puts(m.calls).length === 0, JSON.stringify(m.calls));
}

/* ==================== 4) newer status on Towbook wins — no clobber ==================== */
{
  // Local said accepted, but the 30s pull already imported en_route (3) from the
  // driver's phone: the push must refuse (last-write-wins — newer status wins).
  const m = makeFetch({ initialStatus: 3 });
  const r = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_RACE, actor: ACTOR, opts: { fetchImpl: m.fetchImpl } });
  check("newer-status-wins → skipped, no PUT", r.ok === true && r.changed === false && r.skipped === true && r.reason === "newer-status-wins" && puts(m.calls).length === 0, JSON.stringify(r) + JSON.stringify(m.calls));
  const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND entity_id=${JOB_RACE} AND action='status_push_skipped'`;
  check("audit documents the skip", aud.length === 1, JSON.stringify(aud));
}

/* ==================== 5) PUT failure → retry once → escalate ==================== */
{
  const m = makeFetch({ initialStatus: 3, failPut: true });
  const r = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_FAIL, actor: ACTOR, opts: { fetchImpl: m.fetchImpl } });
  check("put failure → towbook_failed + escalated", r.ok === false && r.code === "towbook_failed" && r.escalated === true, JSON.stringify(r));
  check("exactly TWO PUTs (initial + retry), no more", puts(m.calls).length === 2, JSON.stringify(m.calls));
  const esc = await q`SELECT decision, escalated, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND decision='escalated_status_push_failed' AND call_request_id=${`status-push-${JOB_FAIL}-4`}`;
  check("escalation row with evidence", esc.length === 1 && Boolean(esc[0].escalated) && String(esc[0].reason).includes("500") && esc[0].raw_response && Array.isArray(esc[0].raw_response.attempts) && esc[0].raw_response.attempts.length === 3, JSON.stringify(esc));
  // Dedupe: a second identical failure must not spam the ledger.
  const m2 = makeFetch({ initialStatus: 3, failPut: true });
  await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_FAIL, actor: ACTOR, opts: { fetchImpl: m2.fetchImpl } });
  const again = await q`SELECT COUNT(*)::int AS n FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND decision='escalated_status_push_failed' AND call_request_id=${`status-push-${JOB_FAIL}-4`}`;
  check("escalation dedupes (ON CONFLICT DO NOTHING)", Number(again[0].n) === 1, JSON.stringify(again));
}

/* ==================== 6) PUT ok but verify mismatch → escalate ==================== */
{
  const m = makeFetch({ initialStatus: 3, getStatus: () => 3 }); // verify always sees old status
  const r = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_VERIFY, actor: ACTOR, opts: { fetchImpl: m.fetchImpl } });
  check("verify mismatch → verify_failed + escalated", r.ok === false && r.code === "verify_failed" && r.escalated === true, JSON.stringify(r));
  check("PUT fired once, then verify GET", puts(m.calls).length === 1 && gets(m.calls).length === 2, JSON.stringify(m.calls));
  const esc = await q`SELECT reason FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND decision='escalated_status_push_failed' AND call_request_id=${`status-push-${JOB_VERIFY}-4`}`;
  check("verify escalation recorded", esc.length === 1 && String(esc[0].reason).includes("did not confirm"), JSON.stringify(esc));
}

/* ==================== 7) assign (new→offered, 1) and decline (offered→new, 0) ==================== */
{
  const m = makeFetch({ initialStatus: 0 });
  const r = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_ASSIGN, actor: ACTOR, opts: { fetchImpl: m.fetchImpl } });
  check("assign push → one PUT status 1", r.ok === true && r.changed === true && puts(m.calls).length === 1 && puts(m.calls)[0].body.status.id === 1, JSON.stringify(r) + JSON.stringify(m.calls));
  const m2 = makeFetch({ initialStatus: 1 });
  const r2 = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_DECLINE, actor: ACTOR, opts: { fetchImpl: m2.fetchImpl } });
  check("decline push → one PUT status 0", r2.ok === true && r2.changed === true && puts(m2.calls).length === 1 && puts(m2.calls)[0].body.status.id === 0, JSON.stringify(r2) + JSON.stringify(m2.calls));
}

/* ==================== 8) skips: no session / no towbook id / unpushable ==================== */
{
  const m = makeFetch({ initialStatus: 1 });
  const noSess = await pushJobStatusToTowbook({ orgId: ORG2, jobId: JOB2_SESSION, actor: { orgId: ORG2, id: ACTOR.id, role: "owner" }, opts: { fetchImpl: m.fetchImpl } });
  check("no owner session → clean skip, zero PUTs, no escalation", noSess.ok === true && noSess.skipped === true && noSess.reason === "towbook-not-connected" && m.calls.length === 0, JSON.stringify(noSess) + JSON.stringify(m.calls));
  const esc = await q`SELECT COUNT(*)::int AS n FROM ai_dispatcher_decisions WHERE org_id=${ORG2}`;
  check("no escalation for a config skip", Number(esc[0].n) === 0, JSON.stringify(esc));
  const m2 = makeFetch({ initialStatus: 1 });
  const noId = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_NOID, actor: ACTOR, opts: { fetchImpl: m2.fetchImpl } });
  check("no towbook_job_id → clean skip", noId.ok === true && noId.skipped === true && noId.reason === "no-towbook-job-id" && m2.calls.length === 0, JSON.stringify(noId));
  const m3 = makeFetch({ initialStatus: 1 });
  const cancelled = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_CANCEL, actor: ACTOR, opts: { fetchImpl: m3.fetchImpl } });
  check("cancelled (import-only) → unpushable skip", cancelled.ok === true && cancelled.skipped === true && cancelled.reason === "status-not-pushable" && m3.calls.length === 0, JSON.stringify(cancelled));
}

/* ==================== 9) session expired mid-push → escalate ==================== */
{
  const m = makeFetch({ initialStatus: 1, expireGet: true });
  const r = await pushJobStatusToTowbook({ orgId: ORG, jobId: JOB_ACCEPT, actor: ACTOR, opts: { fetchImpl: m.fetchImpl } });
  check("expired session → session_expired + escalated, no PUT", r.ok === false && r.code === "session_expired" && r.escalated === true && puts(m.calls).length === 0, JSON.stringify(r));
  const esc = await q`SELECT COUNT(*)::int AS n FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND call_request_id=${`status-push-${JOB_ACCEPT}-2`}`;
  check("session-expired escalation recorded", Number(esc[0].n) >= 1, JSON.stringify(esc));
}

/* ==================== 10) pull still works after push (no regression) ==================== */
{
  // After the verified push (test 1), the 30s pull imports a NEWER Towbook
  // status (driver moved on their phone: status 3): the pull must still win and
  // overwrite status + towbook_status + record the transition.
  const pulled = await upsertPulledJobs(ORG, ACTOR, [{
    towbookJobId: CALL_ACCEPT,
    customer: "QA Status Job",
    phone: "",
    vehicle: "",
    pickup: "Main St",
    dropoff: "",
    status: "en_route",
    towbookStatus: "3",
    serviceType: "flatbed_tow",
    createdAt: new Date().toISOString(),
    note: "",
    raw: { sourceUrl: "status-sync.test" },
  }], "sync:test");
  check("pull updates the pushed job (updated=1)", pulled.updated === 1, JSON.stringify(pulled));
  const row = await q`SELECT status, towbook_status FROM dispatch_jobs WHERE id=${JOB_ACCEPT}`;
  check("pull overrides push (newer Towbook status wins in DB too)", String(row[0].status) === "en_route" && String(row[0].towbook_status) === "3", JSON.stringify(row));
  const ev = await q`SELECT to_status, note FROM status_events WHERE org_id=${ORG} AND job_id=${JOB_ACCEPT} ORDER BY occurred_at DESC LIMIT 1`;
  check("pull recorded the imported transition", String(ev[0].to_status) === "en_route" && String(ev[0].note).includes("Towbook"), JSON.stringify(ev));
}

/* ==================== 11) server-fn wiring + mapping parity ==================== */
{
  const src = readFileSync(new URL("./src/data/server.ts", import.meta.url), "utf8");
  const wiring = (src.match(/await pushJobStatus\(/g) || []).length;
  check("assignJob/advanceJob/declineJob each call the push (3 total)", wiring === 3, `wiring=${wiring}`);
  check("declineJob pushes via d.jobId", src.includes("pushJobStatus(u.orgId,d.jobId"));
  check("setContractorStatus does NOT push (contractor availability ≠ job status)", !src.slice(src.indexOf("setContractorStatus"), src.indexOf("getStatusEvents")).includes("pushJobStatus"));
  check("push is a dynamic import (client-graph safe)", src.includes('await import("./status-push-core")'));
  // Mapping parity with the pull side: 0..5 map 1:1.
  check("lifecycle→status id mapping parity (0-5)", LIFECYCLE_TO_TOWBOOK_STATUS_ID.new === 0 && LIFECYCLE_TO_TOWBOOK_STATUS_ID.offered === 1 && LIFECYCLE_TO_TOWBOOK_STATUS_ID.accepted === 2 && LIFECYCLE_TO_TOWBOOK_STATUS_ID.en_route === 3 && LIFECYCLE_TO_TOWBOOK_STATUS_ID.arrived === 4 && LIFECYCLE_TO_TOWBOOK_STATUS_ID.completed === 5, JSON.stringify(LIFECYCLE_TO_TOWBOOK_STATUS_ID));
  check("cancelled is NOT pushable (252/255 import-only)", LIFECYCLE_TO_TOWBOOK_STATUS_ID.cancelled === undefined, JSON.stringify(LIFECYCLE_TO_TOWBOOK_STATUS_ID));
}

/* ==================== 12) Team tab removed ==================== */
{
  const shell = readFileSync(new URL("./src/components/app-shell.tsx", import.meta.url), "utf8");
  const nav = shell.slice(shell.indexOf("const NAV"), shell.indexOf("const PORTAL_META"));
  check("owner nav no longer has /owner/team", !nav.includes("/owner/team") && !nav.includes(`label: "Team"`), nav.slice(0, 600));
  try {
    readFileSync(new URL("./src/routes/owner/team.tsx", import.meta.url), "utf8");
    check("src/routes/owner/team.tsx deleted", false, "file still exists");
  } catch {
    check("src/routes/owner/team.tsx deleted", true);
  }
  const views = readFileSync(new URL("./src/components/ai-dispatcher-views.tsx", import.meta.url), "utf8");
  check("escalation label surfaced in ops banner", views.includes("escalated_status_push_failed") && views.includes("status sync to Towbook failed"));
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`status-sync.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
for (const org of [ORG, ORG2]) await q`DELETE FROM organizations WHERE id=${org}`.catch(() => {});
for (const u of [OWNER, ADMIN, DISPATCHER]) await q`DELETE FROM users WHERE id=${u}`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM dispatch_jobs j JOIN organizations o ON o.id=j.org_id WHERE o.name='qa status-sync') AS jobs,
  (SELECT COUNT(*)::int FROM status_events e JOIN organizations o ON o.id=e.org_id WHERE o.name='qa status-sync') AS events,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name='qa status-sync') AS audit,
  (SELECT COUNT(*)::int FROM ai_dispatcher_decisions d JOIN organizations o ON o.id=d.org_id WHERE o.name='qa status-sync') AS decisions,
  (SELECT COUNT(*)::int FROM towbook_sessions s JOIN organizations o ON o.id=s.org_id WHERE o.name='qa status-sync') AS sessions,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name='qa status-sync') AS members,
  (SELECT COUNT(*)::int FROM users u WHERE u.id IN (${OWNER}, ${ADMIN}, ${DISPATCHER})) AS users`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("status-sync.test.mjs: cleanup verified — zero QA rows left");
