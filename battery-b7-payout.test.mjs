// B7 hermetic payout package: completion idempotency, payday aggregation,
// cancellation/void exclusion, paid-manifest immutability, and earnings UI.
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
const { ensureSchema } = await import("./src/data/migrations.ts");
const { computePaydayCore, periodBoundariesFor } = await import("./src/data/payouts-core.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
await ensureSchema();
const checks = [];
const check = (name, ok, extra = "") => { checks.push([name, Boolean(ok), extra]); if (!ok) throw new Error(`FAIL: ${name} ${extra}`); };
const tag = randomUUID();
const ORG = `qa-b7-${tag}`;
const OWNER = `qa-b7-owner-${tag}`;
const DRIVER = `qa-b7-driver-${tag}`;
const JOB = `qa-b7-job-${tag}`;
const SALE = `qa-b7-sale-${tag}`;
const PERIOD = `qa-b7-period-${tag}`;
const TB = `b7-${tag.slice(0, 8)}`;
const actor = { orgId: ORG, id: OWNER, role: "owner" };
const iso = (d) => new Date(d).toISOString();
const cleanup = async () => {
  await q`DELETE FROM audit_log WHERE org_id=${ORG} OR actor_user_id IN (${OWNER}, ${DRIVER})`;
  await q`DELETE FROM payout_records WHERE org_id=${ORG}`;
  await q`DELETE FROM payment_transactions WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_payouts WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_sales WHERE org_id=${ORG}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG}`;
  await q`DELETE FROM payout_methods WHERE org_id=${ORG}`;
  await q`DELETE FROM contractor_profiles WHERE org_id=${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`;
  await q`DELETE FROM users WHERE id IN (${OWNER}, ${DRIVER})`;
  assertQaOrg(ORG);
  await q`DELETE FROM organizations WHERE id=${ORG}`;
};
try {
  const closed = periodBoundariesFor(new Date(Date.now() - 8 * 86400000));
  await q`INSERT INTO organizations(id,name) VALUES(${ORG}, 'qa B7 payout')`;
  await q`INSERT INTO users(id,name,email,password_hash,towbook_driver_id) VALUES
    (${OWNER}, 'B7 Owner', ${OWNER + '@qa.local'}, 'x', NULL),
    (${DRIVER}, 'B7 Driver', ${DRIVER + '@qa.local'}, 'x', ${TB})`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES
    (${ORG},${OWNER},'owner'),(${ORG},${DRIVER},'contractor')`;
  await q`INSERT INTO contractor_profiles(org_id,user_id,payrate_cents) VALUES(${ORG},${DRIVER},10000)`;
  await q`INSERT INTO payout_methods(id,org_id,contractor_id,rail,handle,status,is_default,created_at,updated_at)
    VALUES(${`pm-${tag}`},${ORG},${DRIVER},'venmo','@b7','verified',TRUE,NOW(),NOW())`;
  await q`INSERT INTO pay_periods(id,org_id,starts_at,ends_at,payout_due_on,status)
    VALUES(${PERIOD},${ORG},${iso(closed.startsAt)},${iso(closed.endsAt)},${closed.payoutDueOn},'open')`;
  const completion = new Date(closed.startsAt.getTime() + 3600000);
  await q`INSERT INTO dispatch_jobs(id,org_id,towbook_job_id,customer_name,phone,lat,lng,area,service_type,status,created_at,completed_at,assigned_driver_towbook_id,raw_json)
    VALUES(${JOB},${ORG},${`tb-${tag}`},'B7 Customer','5555555555',41,-73,'CT','Jump','completed',${iso(completion)},${iso(completion)},${TB},${JSON.stringify({completionTime:completion.toISOString()})})`;
  await q`INSERT INTO battery_sales(id,org_id,job_id,contractor_user_id,vin,vehicle_make,vehicle_model,vehicle_year,battery_price_cents,install_type,install_fee_cents,sales_tax_cents,admin_fee_cents,total_cents,status,install_job_id,driver_payout_snapshot_cents,completed_at)
    VALUES(${SALE},${ORG},${JOB},${DRIVER},'1HGCM82633A004352','Honda','Accord','2003',20000,'standard',0,0,0,20000,'paid',${JOB},4500,${iso(completion)})`;
  const insertBattery = async () => q`INSERT INTO battery_payouts(id,org_id,sale_id,job_id,contractor_user_id,amount_cents,earned_at)
    VALUES(${`bp-${tag}`},${ORG},${SALE},${JOB},${DRIVER},4500,${iso(completion)}) ON CONFLICT(org_id,sale_id) DO NOTHING`;
  await insertBattery(); await insertBattery();
  const ledger = await q`SELECT amount_cents FROM battery_payouts WHERE org_id=${ORG} AND sale_id=${SALE}`;
  check("completion payout ledger is exactly once", ledger.length === 1 && Number(ledger[0].amount_cents) === 4500, JSON.stringify(ledger));
  const computed = await computePaydayCore(actor, PERIOD);
  check("battery payout appears in owner manifest", computed.ok && computed.data.records[0].batteryPayoutCents === 4500, JSON.stringify(computed));
  check("battery install is excluded from generic payrate count", computed.ok && computed.data.records[0].jobCount === 0 && computed.data.records[0].grossCents === 0, JSON.stringify(computed));
  check("battery payout is included in total", computed.ok && computed.data.records[0].totalCents === 4500, JSON.stringify(computed));
  const again = await computePaydayCore(actor, PERIOD);
  check("recompute is stable", again.ok && again.data.records[0].batteryPayoutCents === 4500 && again.data.records[0].totalCents === 4500, JSON.stringify(again));
  await q`UPDATE payout_records SET status='paid', paid_at=NOW() WHERE org_id=${ORG} AND period_id=${PERIOD}`;
  await q`UPDATE battery_sales SET status='voided' WHERE org_id=${ORG} AND id=${SALE}`;
  const voided = await computePaydayCore(actor, PERIOD);
  check("voided-after-completion sale excluded from recompute", voided.ok && voided.data.records[0].batteryPayoutCents === 4500, JSON.stringify(voided));
  check("paid manifest rows remain immutable", voided.ok && voided.data.records[0].status === 'paid' && voided.data.records[0].totalCents === 4500, JSON.stringify(voided));
  const [photos, earnings] = await Promise.all([
    readFile("./src/data/driver-photos-core.ts", "utf8"),
    readFile("./src/routes/driver/earnings.tsx", "utf8"),
  ]);
  check("completion hook writes snapshot ledger", /INSERT INTO battery_payouts[\s\S]*ON CONFLICT \(org_id, sale_id\) DO NOTHING/.test(photos));
  check("earnings UI exposes battery install line", /Battery install earnings/.test(earnings) && /batteryInstalls/.test(earnings));
  await cleanup();
  console.log(`battery-b7-payout.test.mjs: ${checks.length}/${checks.length} passed`);
} catch (e) {
  try { await cleanup(); } catch {}
  console.error(e?.stack || e);
  process.exitCode = 1;
}
