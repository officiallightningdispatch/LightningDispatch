// Pure payday period label regression: ET boundaries must not render in the
// browser's local timezone. Run with TZ=America/Los_Angeles to prove the
// boundary stays Aug 10–16 rather than rolling back to Aug 9–16.
process.env.TZ = "America/Los_Angeles";
const { formatEtDate, payPeriodLabel } = await import("./src/data/payouts.ts");
const checks = [];
const check = (name, condition, extra = "") => {
  checks.push([name, Boolean(condition), extra]);
  if (!condition) throw new Error(`FAIL: ${name} ${extra}`);
};

const label = payPeriodLabel(
  "2026-08-10T04:00:00.000Z",
  "2026-08-17T04:00:00.000Z",
  "2026-08-19",
  false,
);
check("pay-period label uses ET start/end calendar dates", label.includes("Aug 10 – Aug 16"), label);
check("pay-period label keeps payout due date", label.includes("pays Wed, Aug 19"), label);
check("ET formatter keeps Monday midnight boundary on Aug 10", formatEtDate("2026-08-10T04:00:00.000Z") === "Aug 10");
check("ET formatter treats a date-only period start as Aug 10, not UTC-midnight Aug 9", formatEtDate("2026-08-10") === "Aug 10");
check("date-only period label stays Aug 10–16", payPeriodLabel("2026-08-10", "2026-08-17", "2026-08-19", false).includes("Aug 10 – Aug 16"));
check("ET formatter renders exclusive end as Aug 16 when given the final instant", formatEtDate("2026-08-17T03:59:59.999Z") === "Aug 16");

const failed = checks.filter(([, ok]) => !ok);
console.log(`pay-period-label.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
console.log("pay-period-label.test.mjs: ET formatting is timezone-independent");
