// Hermetic stale-active-jobs reconciliation sweep tests (2026-09-05).
// The sweep backfills a non-terminal dispatch_jobs row's true terminal state
// from the authoritative Towbook CallWorkflow report when the call has aged out
// of the live /api/calls window — closing the row through the SAME
// status_events + audit_log path a normal sync uses (never a bare UPDATE).
// No network: report rows are injected. DB-backed against a throwaway QA org
// deleted at the end (zero rows left).
//   DATABASE_URL=... bun stale-active-jobs.test.mjs
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
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
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 7).toString("base64");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { ensureAuthSchema } = await import("./src/data/auth-server.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { reconcileStaleActiveJobsCore, runStaleActiveJobsSweep } = await import("./src/data/stale-active-jobs-core.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-stale-${randomUUID()}`;
const OWNER = `qa-stale-owner-${randomUUID()}`;
const ACTOR = { id: OWNER, role: "owner" };

async function insertJob(tbId, status, rawJson = null) {
  // dispatch_jobs.id is the GLOBAL primary key (not org-scoped) and prod already
  // holds rows with ids like `tb-281178567` — use a unique QA-scoped id.
  const jobId = `qa-stale-${randomUUID()}`;
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, customer_phone, vehicle_desc, pickup, dropoff, towbook_status, raw_json, assigned_driver_towbook_id, assigned_driver_name)
    VALUES(${jobId}, ${ORG}, 'QA Stale', '', 0, 0, 'Bridgeport', 'jump_start', ${status}, NOW(), '', ${tbId}, '', '', 'Main St', '', ${status === "en_route" ? "2" : status === "accepted" ? "1" : null}, ${rawJson ? JSON.stringify(rawJson) : null}::jsonb, ${tbId === "281178567" ? "703785" : tbId === "281179463" ? "721132" : tbId === "281179472" ? "603482" : null}, ${tbId === "281178567" ? "Jayden Fountain" : tbId === "281179463" ? "Ai Dispatch GB" : tbId === "281179472" ? "Antone jerret" : null})`;
  return jobId;
}

await ensureSchema();
await ensureAuthSchema();
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa stale-active-jobs')`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES(${OWNER}, 'QA Stale Owner', ${`qa-stale-owner-${randomUUID()}@lightning.test`}, 'x')`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OWNER}, 'owner')`;

// Fixture rows (mirror the 3 confirmed stuck prod jobs + 2 extra edge cases).
const COMPLETE_TIRE = "281178567";   // en_route, tire_change, Jayden Fountain
const COMPLETE_JUMP = "281179463";   // accepted, jump_start, Ai Dispatch GB
const COMPLETE_LOCK = "281179472";   // accepted, lockout, Antone jerret
const MISSING_CT = "400000001";      // completed-intent report but NO completionTime
const STILL_ACTIVE = "400000002";    // report still non-terminal (accepted) — skip
const CANCELLED_TB = "400000003";    // report final cancelled — close as cancelled

const JOB_TIRE = await insertJob(COMPLETE_TIRE, "en_route");
const JOB_JUMP = await insertJob(COMPLETE_JUMP, "accepted");
const JOB_LOCK = await insertJob(COMPLETE_LOCK, "accepted");
const JOB_MISSING = await insertJob(MISSING_CT, "accepted");
const JOB_STILL = await insertJob(STILL_ACTIVE, "accepted");
const JOB_CANCELLED = await insertJob(CANCELLED_TB, "en_route");

const reportRows = [
  { dispatchEntryId: Number(COMPLETE_TIRE), status: "Completed", completionTime: "2026-08-23T21:04:00Z", driverId: 703785, driverName: "Jayden Fountain" },
  { dispatchEntryId: Number(COMPLETE_JUMP), status: "Completed", completionTime: "2026-08-23T21:26:00Z", driverId: 721132, driverName: "Ai Dispatch GB" },
  { dispatchEntryId: Number(COMPLETE_LOCK), status: "Completed", completionTime: "2026-08-23T21:19:00Z", driverId: 603482, driverName: "Antone jerret" },
  { dispatchEntryId: Number(MISSING_CT), status: "Completed", completionTime: null, completed: null },
  { dispatchEntryId: Number(STILL_ACTIVE), status: "Accepted", completionTime: null },
  { dispatchEntryId: Number(CANCELLED_TB), status: "Cancelled" },
];

/* ==================== (1) stale completed rows close with the report's completionTime ==================== */
{
  const r = await reconcileStaleActiveJobsCore(ORG, reportRows, { actor: ACTOR });
  check("scanned all 6 stale rows", r.scanned === 6, JSON.stringify(r));
  check("closed 3 as completed", r.closedCompleted === 3, JSON.stringify(r));
  check("closed 1 as cancelled", r.closedCancelled === 1, JSON.stringify(r));
  check("skipped 1 still-active", r.skippedStillActive === 1, JSON.stringify(r));
  check("1 missing completionTime diagnostic", r.missingCompletionTime === 1 && r.diagnostics.some((d) => d.startsWith(`${MISSING_CT}:`)), JSON.stringify(r));

  // (a) correct completionTime backfilled — authoritative, not the sweep clock.
  const tire = await q`SELECT status, towbook_status, completed_at, raw_json->>'completionTime' AS completionTime, assigned_driver_towbook_id FROM dispatch_jobs WHERE id=${`${JOB_TIRE}`}`;
  check("tire row now completed", String(tire[0].status) === "completed", JSON.stringify(tire));
  check("tire completionTime authoritative (verbatim)", String(tire[0].completiontime) === "2026-08-23T21:04:00Z", JSON.stringify(tire));
  check("tire completed_at = completionTime (not now)", new Date(String(tire[0].completed_at)).toISOString() === "2026-08-23T21:04:00.000Z", JSON.stringify(tire));
  check("tire towbook_status = 5", String(tire[0].towbook_status) === "5", JSON.stringify(tire));
  check("tire driver preserved", String(tire[0].assigned_driver_towbook_id) === "703785", JSON.stringify(tire));

  const jump = await q`SELECT raw_json->>'completionTime' AS ct FROM dispatch_jobs WHERE id=${`${JOB_JUMP}`}`;
  check("jump completionTime authoritative", String(jump[0].ct) === "2026-08-23T21:26:00Z", JSON.stringify(jump));

  // (b) ledger path — status_events + audit_log both written (not a bare UPDATE).
  const se = await q`SELECT from_status, to_status, actor_role, note FROM status_events WHERE org_id=${ORG} AND job_id=${`${JOB_TIRE}`} AND to_status='completed'`;
  check("status_events transition written", se.length === 1 && String(se[0].from_status) === "en_route" && String(se[0].to_status) === "completed" && String(se[0].actor_role) === "owner", JSON.stringify(se));
  const aud = await q`SELECT action, detail FROM audit_log WHERE org_id=${ORG} AND entity_id=${`${JOB_TIRE}`} AND action='towbook_stale_reconcile'`;
  check("audit_log row written", aud.length === 1 && aud[0].detail && aud[0].detail.towbookJobId === COMPLETE_TIRE && aud[0].detail.completionTime === "2026-08-23T21:04:00Z", JSON.stringify(aud));

  // (c) cancelled close has no completionTime fabricated and status is cancelled.
  const canc = await q`SELECT status, towbook_status, completed_at, raw_json->>'completionTime' AS ct FROM dispatch_jobs WHERE id=${`${JOB_CANCELLED}`}`;
  check("cancelled row closed as cancelled", String(canc[0].status) === "cancelled" && String(canc[0].towbook_status) === "255" && canc[0].ct == null, JSON.stringify(canc));

  // (d) missing-completionTime row left non-terminal (diagnostic, not fabricated).
  const miss = await q`SELECT status FROM dispatch_jobs WHERE id=${`${JOB_MISSING}`}`;
  check("missing completionTime row left non-terminal", String(miss[0].status) === "accepted", JSON.stringify(miss));
}

/* ==================== (2) idempotency — running twice is a no-op ==================== */
{
  const before = await q`SELECT COUNT(*)::int AS c FROM status_events WHERE org_id=${ORG} AND to_status IN ('completed','cancelled')`;
  const r2 = await reconcileStaleActiveJobsCore(ORG, reportRows, { actor: ACTOR });
  check("second run closes nothing (already terminal)", r2.closedCompleted === 0 && r2.closedCancelled === 0 && r2.scanned === 2, JSON.stringify(r2));
  const after = await q`SELECT COUNT(*)::int AS c FROM status_events WHERE org_id=${ORG} AND to_status IN ('completed','cancelled')`;
  check("ledger row count unchanged (no double transition)", Number(before[0].c) === Number(after[0].c), `before=${before[0].c} after=${after[0].c}`);
}

/* ==================== (3) the 3 confirmed stuck prod rows are backfillable (dry-run shape) ==================== */
{
  const confirmed = [
    { dispatchEntryId: 281178567, status: "Completed", completionTime: "2026-08-23T21:04:00Z", driverName: "Jayden Fountain", driverId: 703785 },
    { dispatchEntryId: 281179463, status: "Completed", completionTime: "2026-08-23T21:26:00Z", driverName: "Ai Dispatch GB", driverId: 721132 },
    { dispatchEntryId: 281179472, status: "Completed", completionTime: "2026-08-23T21:19:00Z", driverName: "Antone jerret", driverId: 603482 },
  ];
  // dryRun against the ORG still holding the two remaining non-terminal rows is
  // enough to prove the confirmed ids classify as completed; assert classification
  // via a second QA org to avoid cross-talk with the already-closed rows.
  const ORG2 = `qa-stale2-${randomUUID()}`;
  const OWNER2 = `qa-stale2-owner-${randomUUID()}`;
  await q`INSERT INTO organizations(id, name) VALUES(${ORG2}, 'qa stale2')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${OWNER2}, 'QA Stale2 Owner', ${`qa-stale2-owner-${randomUUID()}@lightning.test`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG2}, ${OWNER2}, 'owner')`;
  for (const [tb, status, jobId] of [[281178567, "en_route", "tb-c2-281178567"], [281179463, "accepted", "tb-c2-281179463"], [281179472, "accepted", "tb-c2-281179472"]]) {
    await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, customer_phone, vehicle_desc, pickup, dropoff, towbook_status, assigned_driver_towbook_id, assigned_driver_name)
      VALUES(${jobId}, ${ORG2}, 'QA Stale2', '', 0, 0, 'Bridgeport', 'jump_start', ${status}, NOW(), '', ${String(tb)}, '', '', 'Main St', '', ${status === "en_route" ? "2" : "1"}, ${tb === 281178567 ? "703785" : tb === 281179463 ? "721132" : "603482"}, ${tb === 281178567 ? "Jayden Fountain" : tb === 281179463 ? "Ai Dispatch GB" : "Antone jerret"})`;
  }
  const r3 = await runStaleActiveJobsSweep(ORG2, { rows: confirmed, actor: { id: OWNER2, role: "owner" } });
  check("confirmed 3 rows backfillable as completed", r3.ok === true && r3.result.closedCompleted === 3 && r3.result.closedJobIds.length === 3, JSON.stringify(r3));
  const row567 = await q`SELECT status, raw_json->>'completionTime' AS ct FROM dispatch_jobs WHERE id='tb-c2-281178567' AND org_id=${ORG2}`;
  check("confirmed 567 completionTime exact", String(row567[0].ct) === "2026-08-23T21:04:00Z", JSON.stringify(row567));
  await q`DELETE FROM organizations WHERE id=${ORG2}`;
  await q`DELETE FROM users WHERE id=${OWNER2}`;
}

/* ==================== cleanup ==================== */
assertQaOrg(ORG);
await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
await q`DELETE FROM users WHERE id=${OWNER}`.catch(() => {});
const leftover = await q`SELECT (SELECT COUNT(*)::int FROM dispatch_jobs WHERE org_id=${ORG}) AS jobs, (SELECT COUNT(*)::int FROM status_events WHERE org_id=${ORG}) AS events, (SELECT COUNT(*)::int FROM audit_log WHERE org_id=${ORG}) AS audits`;
check("cleanup — zero QA rows left", Number(leftover[0].jobs) === 0 && Number(leftover[0].events) === 0 && Number(leftover[0].audits) === 0, JSON.stringify(leftover));

console.log(`stale-active-jobs.test.mjs: ${checks.length}/${checks.length} passed`);
