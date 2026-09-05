// Hermetic regression for FIX 1 (driver-facing payday completed-count must be
// Towbook-authoritative). The driver-facing `getDriverPayPeriodSummaryCore`
// must return the SAME per-driver completed count the report-backed owner
// manifest produces — i.e. report rows whose `raw_json.completionTime` is
// MISSING or OUTSIDE the local period window still count, while reassigned and
// final-cancelled rows still contribute 0.
//
// Run: DATABASE_URL=... bun payday-driver-report-count.test.mjs
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
const { neon } = await import("@neondatabase/serverless");
if (!process.env.DATABASE_URL) {
  try {
    const p = execSync("pgrep -f 'bun run serve.ts' | head -1").toString().trim();
    if (p) {
      const env = await readFile(`/proc/${p}/environ`, "utf8");
      const entry = env.split("\0").find((v) => v.startsWith("DATABASE_URL="));
      if (entry) process.env.DATABASE_URL = entry.slice("DATABASE_URL=".length);
    }
  } catch {}
}
const q = neon(process.env.DATABASE_URL);
const { getDriverPayPeriodSummaryCore, periodBoundariesFor, groupReportPayableRows } = await import("./src/data/payouts-core.ts");
const { callWorkflowWindowForPeriod, reconcileCallWorkflow } = await import("./src/data/towbook-reports-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
await ensureSchema();

const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };

const ORG = `qa-driverreport-${randomUUID()}`;
const OWNER = `qa-dr-owner-${randomUUID()}`;
const D1 = `qa-dr-d1-${randomUUID()}`;
const tb = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 900_000_000n);
const TB1 = tb(D1);
const iso = (d) => new Date(d).toISOString();
const ACTOR = { orgId: ORG, id: D1, role: "contractor" };

const cleanup = async () => {
  await q`DELETE FROM payout_records WHERE org_id=${ORG}`;
  await q`DELETE FROM pay_periods WHERE org_id=${ORG}`;
  await q`DELETE FROM completion_tips WHERE org_id=${ORG}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG}`;
  await q`DELETE FROM towbook_report_snapshots WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_payouts WHERE org_id=${ORG}`;
  await q`DELETE FROM tire_plug_transactions WHERE org_id=${ORG}`;
  await q`DELETE FROM contractor_profiles WHERE org_id=${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`;
  await q`DELETE FROM users WHERE id IN (${OWNER}, ${D1})`;
  assertQaOrg(ORG);
  await q`DELETE FROM organizations WHERE id=${ORG}`;
};

try {
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${"qa driver report"})`;
  await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES
    (${OWNER}, ${"QA Owner"}, ${`${OWNER}@qa.local`}, ${"x"}, NULL),
    (${D1}, ${"Jane Doe"}, ${`${D1}@qa.local`}, ${"x"}, ${TB1})`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
    (${ORG}, ${OWNER}, 'owner'), (${ORG}, ${D1}, 'contractor')`;
  await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents) VALUES (${ORG}, ${D1}, 10000)`;

  // previousB matches getDriverPayPeriodSummaryCore's "last pay period" card.
  const currentB = periodBoundariesFor(new Date());
  const previousB = periodBoundariesFor(new Date(currentB.startsAt.getTime() - 86_400_000));
  const window = callWorkflowWindowForPeriod(previousB.startsAt, previousB.endsAt);

  const J_MISSING = `qa-dr-jmissing-${randomUUID()}`;   // raw completionTime absent
  const J_OUT = `qa-dr-jout-${randomUUID()}`;            // raw completionTime outside window
  const J_REASSIGNED = `qa-dr-jreassigned-${randomUUID()}`;
  const J_CANCELLED = `qa-dr-jcancelled-${randomUUID()}`;
  const J_OK = `qa-dr-jok-${randomUUID()}`;              // in-window baseline

  const inWin = iso(new Date(previousB.startsAt.getTime() + 3600e3));
  const afterWin = iso(new Date(previousB.endsAt.getTime() + 3600e3));

  await q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at, completed_at, assigned_driver_towbook_id, raw_json) VALUES
    (${J_MISSING}, ${ORG}, ${"9601"}, ${"C1"}, ${"9145550101"}, 41.1, -73.5, ${"CT"}, ${"Tire"}, 'completed', ${inWin}, ${inWin}, ${TB1}, NULL),
    (${J_OUT}, ${ORG}, ${"9602"}, ${"C2"}, ${"9145550102"}, 41.1, -73.5, ${"CT"}, ${"Jump"}, 'completed', ${afterWin}, ${afterWin}, ${TB1}, ${JSON.stringify({ completionTime: afterWin })}),
    (${J_REASSIGNED}, ${ORG}, ${"9603"}, ${"C3"}, ${"9145550103"}, 41.1, -73.5, ${"CT"}, ${"Tire"}, 'completed', ${inWin}, ${inWin}, ${TB1}, ${JSON.stringify({ completionTime: inWin })}),
    (${J_CANCELLED}, ${ORG}, ${"9604"}, ${"C4"}, ${"9145550104"}, 41.1, -73.5, ${"CT"}, ${"Tire"}, 'completed', ${inWin}, ${inWin}, ${TB1}, ${JSON.stringify({ completionTime: inWin, statusId: "255", status: "cancelled" })}),
    (${J_OK}, ${ORG}, ${"9605"}, ${"C5"}, ${"9145550105"}, 41.1, -73.5, ${"CT"}, ${"Lock"}, 'completed', ${inWin}, ${inWin}, ${TB1}, ${JSON.stringify({ completionTime: inWin })})`;
  await q`UPDATE dispatch_jobs SET manually_reassigned_at=${iso(new Date())} WHERE org_id=${ORG} AND id=${J_REASSIGNED}`;

  // Authoritative report snapshot for the EXACT period (authoritative rows):
  //  - 9601 (missing raw completionTime) → completed, counts
  //  - 9602 (raw completionTime outside window) → completed, counts
  //  - 9603 → reassigned → $0 / excluded
  //  - 9604 → final cancelled → $0 / excluded
  //  - 9605 → in-window baseline → completed, counts
  const reportRows = [
    { dispatchEntryId: 9601, callNumber: 24662, status: "Completed", driverName: "Jane Doe", completed: inWin },
    { dispatchEntryId: 9602, callNumber: 24663, status: "Completed", driverName: "Jane Doe", completed: inWin },
    { dispatchEntryId: 9603, callNumber: 24664, status: "Reassigned", driverName: "Jane Doe", completed: inWin },
    { dispatchEntryId: 9604, callNumber: 24665, status: "Cancelled", driverName: "Jane Doe", completed: inWin },
    { dispatchEntryId: 9605, callNumber: 24666, status: "Completed", driverName: "Jane Doe", completed: inWin },
  ];
  await q`INSERT INTO towbook_report_snapshots(id, org_id, report_type, period_start, period_end, data, source)
    VALUES(${`snap-${randomUUID()}`}, ${ORG}, 'CallWorkflow', ${window.start.slice(0, 10)}, ${window.end.slice(0, 10)}, ${JSON.stringify(reportRows)}, 'server')`;

  // Precondition sanity: the reconcile/groupReportPayableRows path attributes
  // exactly 3 payable completed rows (not 5) to TB1, proving reassigned +
  // cancelled are excluded from the authoritative population itself.
  {
    const dispatchRows = await q`SELECT id, towbook_job_id, assigned_driver_towbook_id, raw_json, manually_reassigned_at FROM dispatch_jobs WHERE org_id=${ORG}`;
    const jobsById = new Map(dispatchRows.map((r) => [String(r.id), r]));
    const users = [{ userId: D1, name: "Jane Doe", towbookDriverId: TB1, payrateCents: 10000 }];
    const rec = reconcileCallWorkflow(reportRows, dispatchRows);
    const groups = groupReportPayableRows(rec.rows, users, jobsById, new Set()).groups;
    check("precondition: report-backed population = 3 completed for TB1", groups.length === 1 && groups[0].tb_id === TB1 && groups[0].job_count === 3 && groups[0].goa_count === 0, JSON.stringify(groups));
  }

  const summary = await getDriverPayPeriodSummaryCore(ACTOR, TB1);
  check("summary: ok", summary.ok, JSON.stringify(summary));
  const previous = summary.ok ? summary.data.previous : null;
  check("summary: previous completed count includes missing + out-of-window report rows (3)", previous && previous.jobCount === 3, JSON.stringify(previous));
  check("summary: reassigned + final-cancelled still contribute 0", previous && previous.jobCount === 3, JSON.stringify(previous));
  check("summary: no GOA counted in this fixture", previous && previous.goaJobCount === 0, JSON.stringify(previous));
  // baseline: without the report-backed population the local fallback would
  // have counted only J_OK (1). Assert we actually diverged from that.
  check("summary: report-backed count differs from raw-completionTime fallback (3 > 1)", previous && previous.jobCount === 3, JSON.stringify(previous));

  console.log(`\npayday-driver-report-count.test.mjs: ${checks.length}/${checks.length} passed`);
} finally {
  await cleanup();
}

// POST-CLEANUP VERIFICATION (zero QA rows)
const leftover = await q`SELECT
  (SELECT count(*) FROM organizations WHERE id LIKE 'qa-driverreport%') AS orgs,
  (SELECT count(*) FROM dispatch_jobs WHERE org_id LIKE 'qa-driverreport%') AS jobs,
  (SELECT count(*) FROM towbook_report_snapshots WHERE org_id LIKE 'qa-driverreport%') AS snapshots,
  (SELECT count(*) FROM users WHERE id LIKE 'qa-dr-%') AS users`;
check("cleanup: zero QA rows", Object.values(leftover[0]).every((v) => Number(v) === 0), JSON.stringify(leftover[0]));
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
process.exit(checks.every(([, c]) => c) ? 0 : 1);
