// Hermetic test for the Driver Activity job-count source (owner 2026-09-06).
//
// computePaydayCore must treat the Towbook Driver Activity report as the
// AUTHORITATIVE weekly job count (reportData[].callCount joined by reportData[].id
// = users.towbook_driver_id), with goa_count ALWAYS 0 (owner multiplies callCount
// by payrate directly — no GOA flat-$10 path). CallWorkflow remains a FALLBACK
// only when Driver Activity fetch + snapshot are both unavailable.
//
// The Driver Activity path only runs for NON-QA orgs (computePaydayCore skips
// report fetches for /^qa-/ orgs), so this suite seeds an org whose ID does NOT
// match qa- (so the report path runs) but whose NAME starts with "qa " (so
// assertQaOrg still permits safe deletion). The report fetch is stubbed via
// globalThis.fetch exactly as towbook-reports.test.mjs stubs CallWorkflow.
//
// Run: DATABASE_URL=... bun payday-driver-activity.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
if (!process.env.DATABASE_URL) {
  const { readFile } = await import("node:fs/promises");
  const { execSync } = await import("node:child_process");
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
const { computePaydayCore } = await import("./src/data/payouts-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
await ensureSchema();

const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const authText = (token = "A".repeat(64)) => new Response(token, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "x-towbook-token-expires-utc": new Date(Date.now() + 300000).toUTCString() } });

const iso = (d) => new Date(d).toISOString();
const tb = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 900_000_000n);
// NON-qa id so computePaydayCore runs the report path; "qa " name so deletion is allowed.
const ORG = `da-${randomUUID()}`;
const ORG_NAME = `qa driver activity ${randomUUID()}`;
const OWNER = `da-owner-${randomUUID()}`;
const D1 = `da-d1-${randomUUID()}`;
const D2 = `da-d2-${randomUUID()}`;
const TB1 = tb(D1), TB2 = tb(D2);
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const oldFetch = globalThis.fetch;

const cleanup = async () => {
  await q`DELETE FROM audit_log WHERE org_id=${ORG} OR actor_user_id IN (${OWNER}, ${D1}, ${D2})`;
  await q`DELETE FROM payout_records WHERE org_id=${ORG}`;
  await q`DELETE FROM pay_periods WHERE org_id=${ORG}`;
  await q`DELETE FROM payment_transactions WHERE org_id=${ORG}`;
  await q`DELETE FROM completion_tips WHERE org_id=${ORG}`;
  await q`DELETE FROM status_events WHERE org_id=${ORG}`;
  await q`DELETE FROM job_completions WHERE org_id=${ORG}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG}`;
  await q`DELETE FROM payout_methods WHERE org_id=${ORG}`;
  await q`DELETE FROM contractor_profiles WHERE org_id=${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`;
  await q`DELETE FROM towbook_report_snapshots WHERE org_id=${ORG}`;
  await q`DELETE FROM users WHERE id IN (${OWNER}, ${D1}, ${D2})`;
  assertQaOrg(ORG, ORG_NAME);
  await q`DELETE FROM organizations WHERE id=${ORG}`;
};

const seedPeriod = async (periodId, startsAt, endsAt) => {
  await q`INSERT INTO pay_periods(id, org_id, starts_at, ends_at, payout_due_on, status) VALUES
    (${periodId}, ${ORG}, ${iso(startsAt)}, ${iso(endsAt)}, '2026-08-26', 'open')`;
};

try {
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG_NAME})`;
  await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES
    (${OWNER}, ${"QA Owner"}, ${`${OWNER}@qa.local`}, ${"x"}, NULL),
    (${D1}, ${"Jane Doe"}, ${`${D1}@qa.local`}, ${"x"}, ${TB1}),
    (${D2}, ${"Pat Smith"}, ${`${D2}@qa.local`}, ${"x"}, ${TB2})`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
    (${ORG}, ${OWNER}, 'owner'), (${ORG}, ${D1}, 'contractor'), (${ORG}, ${D2}, 'contractor')`;
  await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents) VALUES
    (${ORG}, ${D1}, 1700), (${ORG}, ${D2}, 1900)`;
  const closedStart = new Date(Date.now() - 15 * 86400000);
  const closedEnd = new Date(closedStart.getTime() + 7 * 86400000 - 1000);

  /* ---------------- CASE A + B: Driver Activity is authoritative ---------------- */
  {
    const PERIOD = `pay-${ORG}-da`;
    await seedPeriod(PERIOD, closedStart, closedEnd);
    // Stub: Driver Activity returns 51 for D1 (TB1), 50 for D2 (TB2), and an
    // unmapped Chaz row (id 999999) that must be excluded with a diagnostic.
    // NON-towbook requests (e.g. Neon's own HTTP transport) pass through to the
    // real fetch so DB queries keep working.
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes("towbook.com")) return oldFetch(url, init);
      if (String(url).endsWith("authentication")) return authText();
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.reportType === "DriverActivity") {
        return json({ reportData: [
          { id: Number(TB1), name: "Jane Doe", callCount: 51, totalInvoice: 867 },
          { id: Number(TB2), name: "Pat Smith", callCount: 50, totalInvoice: 950 },
          { id: 999999, name: "Chaz Underwood", callCount: 1, totalInvoice: 276.66 },
        ] });
      }
      return json({ reportData: [] });
    };
    const res = await computePaydayCore(ACTOR, PERIOD);
    check("DA compute: ok", res.ok, JSON.stringify(res));
    const d1 = res.ok ? res.data.records.find((r) => r.contractorId === D1) : null;
    const d2 = res.ok ? res.data.records.find((r) => r.contractorId === D2) : null;
    const chaz = res.ok ? res.data.records.find((r) => r.contractorName.includes("Chaz")) : undefined;
    // (a) callCount N → job_count N; goa 0; gross = payrate * callCount
    check("DA (a): D1 callCount 51 → job_count 51, goa 0", d1 && d1.jobCount === 51 && d1.goaJobCount === 0, JSON.stringify(d1));
    check("DA (a): D1 gross = 51 × $17 = $867", d1 && d1.grossCents === 86700, JSON.stringify(d1));
    check("DA (a): D2 callCount 50 → job_count 50", d2 && d2.jobCount === 50 && d2.grossCents === 95000, JSON.stringify(d2));
    // (b) unmapped Chaz row excluded (no record) + surfaced diagnostic
    check("DA (b): unmapped driver has no payout record", !chaz, JSON.stringify(res.data?.records.map((r) => r.contractorName)));
    const warn = res.ok ? res.data.diagnostics?.reconciliationWarning ?? "" : "";
    check("DA (b): unmapped driver surfaced in diagnostic (name + id + callCount)", warn.includes("Chaz Underwood") && warn.includes("999999") && warn.includes("callCount 1"), warn);
    check("DA (b): Driver Activity row count diagnostic present", res.ok && res.data.diagnostics?.driverActivityRowCount === 3, JSON.stringify(res.data?.diagnostics));
    globalThis.fetch = oldFetch;
  }

  /* ---------------- CASE C: Driver Activity unavailable → CallWorkflow fallback ---------------- */
  {
    const PERIOD = `pay-${ORG}-fallback`;
    // Distinct date window: pay_periods has a UNIQUE (org_id, starts_at, ends_at)
    // constraint, so CASE C must not reuse CASE A's closedStart/closedEnd. Use a
    // second 7-day window one week earlier (still in the past, still 7 days).
    const closedStartC = new Date(closedStart.getTime() - 8 * 86400000);
    const closedEndC = new Date(closedStartC.getTime() + 7 * 86400000 - 1000);
    await seedPeriod(PERIOD, closedStartC, closedEndC);
    // Stub: Driver Activity report FAILS (500) and there is no DriverActivity
    // snapshot → computePaydayCore must fall back to CallWorkflow (3 rows D1, 2 D2).
    // NON-towbook requests pass through to the real fetch (Neon transport).
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes("towbook.com")) return oldFetch(url, init);
      if (String(url).endsWith("authentication")) return authText();
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.reportType === "DriverActivity") return json({ error: "boom" }, 500);
      if (body.reportType === "CallWorkflow") {
        return json({ reportData: [
          { id: 1, driver: "Jane Doe", driverId: Number(TB1), completed: "2026-08-12T12:00:00Z", status: "Completed" },
          { id: 2, driver: "Jane Doe", driverId: Number(TB1), completed: "2026-08-12T13:00:00Z", status: "Completed" },
          { id: 3, driver: "Jane Doe", driverId: Number(TB1), completed: "2026-08-12T14:00:00Z", status: "Completed" },
          { id: 4, driver: "Pat Smith", driverId: Number(TB2), completed: "2026-08-12T12:00:00Z", status: "Completed" },
          { id: 5, driver: "Pat Smith", driverId: Number(TB2), completed: "2026-08-12T13:00:00Z", status: "Completed" },
        ] });
      }
      return json({ reportData: [] });
    };
    const res = await computePaydayCore(ACTOR, PERIOD);
    check("fallback compute: ok", res.ok, JSON.stringify(res));
    const d1 = res.ok ? res.data.records.find((r) => r.contractorId === D1) : null;
    const d2 = res.ok ? res.data.records.find((r) => r.contractorId === D2) : null;
    // (c) fallback to CallWorkflow still attributes completed rows by driverId
    check("fallback (c): D1 CallWorkflow 3 completed rows → job_count 3", d1 && d1.jobCount === 3 && d1.grossCents === 5100, JSON.stringify(d1));
    check("fallback (c): D2 CallWorkflow 2 completed rows → job_count 2", d2 && d2.jobCount === 2 && d2.grossCents === 3800, JSON.stringify(d2));
    check("fallback (c): no Driver Activity row count in diagnostics", res.ok && !(res.data.diagnostics?.driverActivityRowCount), JSON.stringify(res.data?.diagnostics));
    globalThis.fetch = oldFetch;
  }

  console.log(`\npayday-driver-activity.test.mjs: ${checks.length}/${checks.length} passed`);
} finally {
  globalThis.fetch = oldFetch;
  await cleanup();
}

const leftover = await q`SELECT
  (SELECT count(*) FROM organizations WHERE id=${ORG}) AS orgs,
  (SELECT count(*) FROM payout_records WHERE org_id=${ORG}) AS records,
  (SELECT count(*) FROM pay_periods WHERE org_id=${ORG}) AS periods,
  (SELECT count(*) FROM towbook_report_snapshots WHERE org_id=${ORG}) AS snapshots,
  (SELECT count(*) FROM users WHERE id IN (${OWNER}, ${D1}, ${D2})) AS users`;
check("cleanup: zero rows", Object.values(leftover[0]).every((v) => Number(v) === 0), JSON.stringify(leftover[0]));
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
process.exit(checks.every(([, c]) => c) ? 0 : 1);
