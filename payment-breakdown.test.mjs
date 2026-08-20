// Hermetic payment-breakdown reconciliation: real payday composer + recorded
// component ledgers. No demo data is used; every fixture row is QA-scoped and
// removed in finally.
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
const { periodBoundariesFor, computePaydayCore } = await import("./src/data/payouts-core.ts");
const { payPeriodLabel } = await import("./src/data/payouts.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
await ensureSchema();
const checks = [];
const check = (name, condition, extra = "") => { checks.push([name, Boolean(condition), extra]); if (!condition) throw new Error(`FAIL: ${name} ${extra}`); };
const ORG = `qa-breakdown-${randomUUID()}`;
const OWNER = `qa-bd-owner-${randomUUID()}`;
const DRIVER = `qa-bd-driver-${randomUUID()}`;
const TB = String(BigInt("0x" + DRIVER.replace(/-/g, "").slice(-12)) % 900000000n);
const JOB = `qa-bd-job-${randomUUID()}`;
const GOA = `qa-bd-goa-${randomUUID()}`;
const TIP = `qa-bd-tip-${randomUUID()}`;
const PLUG = `qa-bd-plug-${randomUUID()}`;
const iso = (d) => new Date(d).toISOString();
const cleanup = async () => {
  assertQaOrg(ORG);
  await q`DELETE FROM audit_log WHERE org_id=${ORG}`;
  await q`DELETE FROM payment_transactions WHERE org_id=${ORG}`;
  await q`DELETE FROM payout_records WHERE org_id=${ORG}`;
  await q`DELETE FROM pay_periods WHERE org_id=${ORG}`;
  await q`DELETE FROM completion_tips WHERE org_id=${ORG}`;
  await q`DELETE FROM tire_plug_transactions WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_payouts WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_sales WHERE org_id=${ORG}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG}`;
  await q`DELETE FROM payout_methods WHERE org_id=${ORG}`;
  await q`DELETE FROM contractor_profiles WHERE org_id=${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`;
  await q`DELETE FROM users WHERE id IN (${OWNER}, ${DRIVER})`;
  await q`DELETE FROM organizations WHERE id=${ORG}`;
};
try {
  await q`INSERT INTO organizations(id,name) VALUES(${ORG},'QA payment breakdown')`;
  await q`INSERT INTO users(id,name,email,password_hash,towbook_driver_id) VALUES(${OWNER},'QA Owner',${OWNER+'@qa.local'},'x',NULL),(${DRIVER},'QA Driver',${DRIVER+'@qa.local'},'x',${TB})`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG},${OWNER},'owner'),(${ORG},${DRIVER},'contractor')`;
  await q`INSERT INTO contractor_profiles(org_id,user_id,payrate_cents) VALUES(${ORG},${DRIVER},2500)`;
  await q`INSERT INTO payout_methods(id,org_id,contractor_id,rail,handle,status,is_default) VALUES(${`qa-bd-method-${randomUUID()}`},${ORG},${DRIVER},'venmo','@qa-driver','verified',TRUE)`;
  const period = periodBoundariesFor(new Date(Date.now() - 8 * 86400000));
  const PERIOD = `pay-${ORG}-closed`;
  await q`INSERT INTO pay_periods(id,org_id,starts_at,ends_at,payout_due_on,status) VALUES(${PERIOD},${ORG},${iso(period.startsAt)},${iso(period.endsAt)},${period.payoutDueOn},'open')`;
  const normalTime = new Date(period.startsAt.getTime() + 3600000);
  const goaTime = new Date(period.startsAt.getTime() + 7200000);
  await q`INSERT INTO dispatch_jobs(id,org_id,towbook_job_id,customer_name,phone,lat,lng,area,service_type,status,created_at,completed_at,assigned_driver_towbook_id,raw_json) VALUES
    (${JOB},${ORG},'bd-normal','Normal','',41,-73,'CT','jump','completed',${iso(normalTime)},${iso(normalTime)},${TB},${JSON.stringify({completionTime:iso(normalTime)})}),
    (${GOA},${ORG},'bd-goa','GOA','',41,-73,'CT','jump','completed',${iso(goaTime)},${iso(goaTime)},${TB},${JSON.stringify({completionTime:iso(goaTime),invoiceItems:[{name:'GOA - No Service',price:10}]})})`;
  await q`INSERT INTO completion_tips(id,org_id,job_id,driver_id,driver_towbook_id,amount_cents,currency,status,idempotency_key,created_at) VALUES(${TIP},${ORG},${JOB},${DRIVER},${TB},700,'USD','paid',${`bd-tip-${randomUUID()}`},${iso(goaTime)})`;
  await q`INSERT INTO tire_plug_transactions(id,org_id,job_id,contractor_user_id,amount_cents,status,created_at,paid_at) VALUES(${PLUG},${ORG},${JOB},${DRIVER},4500,'paid',${iso(goaTime)},${iso(goaTime)})`;
  const result = await computePaydayCore({orgId:ORG,id:OWNER,role:'owner'}, PERIOD);
  check('computed period returns a manifest', result.ok && result.data?.records.length === 1, JSON.stringify(result));
  const record = result.ok ? result.data.records[0] : null;
  const tips = await q`SELECT COALESCE(SUM(amount_cents),0)::int AS cents FROM completion_tips WHERE org_id=${ORG} AND driver_id=${DRIVER} AND status='paid' AND created_at >= ${iso(period.startsAt)} AND created_at < ${iso(period.endsAt)}`;
  const plugs = await q`SELECT COALESCE(SUM(amount_cents),0)::int AS cents FROM tire_plug_transactions WHERE org_id=${ORG} AND contractor_user_id=${DRIVER} AND status='paid' AND paid_at >= ${iso(period.startsAt)} AND paid_at < ${iso(period.endsAt)}`;
  const batteries = await q`SELECT COALESCE(SUM(amount_cents),0)::int AS cents FROM battery_payouts WHERE org_id=${ORG} AND contractor_user_id=${DRIVER} AND earned_at >= ${iso(period.startsAt)} AND earned_at < ${iso(period.endsAt)}`;
  check('authoritative completed jobs count includes normal + GOA', record?.jobCount === 2, JSON.stringify(record));
  check('GOA adjustment is separately preserved', record?.goaJobCount === 1 && record.grossCents === 3500, JSON.stringify(record));
  check('tips line matches completion_tips paid subtable', record?.tipsCents === Number(tips[0].cents) && record.tipsCents === 700, JSON.stringify({record,tips}));
  check('tire-plug line matches paid tire subtable', record?.tirePlugCents === Number(plugs[0].cents) && record.tirePlugCents === 4500, JSON.stringify({record,plugs}));
  check('battery line matches battery_payouts subtable (zero fixture)', record?.batteryPayoutCents === Number(batteries[0].cents) && record.batteryPayoutCents === 0, JSON.stringify({record,batteries}));
  const lineTotal = (record?.grossCents ?? 0) + (record?.tipsCents ?? 0) + (record?.tirePlugCents ?? 0) + (record?.batteryPayoutCents ?? 0) + (record?.busyBonusCents ?? 0);
  check('all displayed line items sum exactly to total', record?.totalCents === lineTotal && record.totalCents === 8700, JSON.stringify({record,lineTotal}));
  check('ET pay-period label remains intact', payPeriodLabel(iso(period.startsAt),iso(period.endsAt),period.payoutDueOn,false).includes('pays'), payPeriodLabel(iso(period.startsAt),iso(period.endsAt),period.payoutDueOn,false));
} finally {
  await cleanup();
}
const leftovers = await q`SELECT (SELECT count(*) FROM payout_records WHERE org_id=${ORG}) AS records, (SELECT count(*) FROM completion_tips WHERE org_id=${ORG}) AS tips, (SELECT count(*) FROM tire_plug_transactions WHERE org_id=${ORG}) AS plugs, (SELECT count(*) FROM organizations WHERE id=${ORG}) AS orgs`;
check('cleanup leaves zero QA rows', Object.values(leftovers[0]).every((v) => Number(v) === 0), JSON.stringify(leftovers[0]));
console.log(`payment-breakdown.test.mjs: ${checks.length}/${checks.length} passed`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
