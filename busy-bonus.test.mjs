// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts.
// Hermetic tests for the BUSY-TIME BONUS (owner-locked mechanics 2026-08-13):
//   3+ ASSIGNED calls per contractor within one clock hour = that contractor's
//   busy hour; +$1 per job COMPLETED in that busy hour; renders as an Earnings
//   line item AND a payday manifest line item. Working interpretation (flagged
//   at build): busy hour = the clock hour in which the 3rd assignment lands
//   (America/New_York wall-clock hours); jobs completed within that clock hour
//   each earn +$1. Coverage: pure hour/boundary math (exactly 3 = busy, 2 =
//   not, 4 = one busy hour), assignment/completion timestamp resolution (local
//   assigned_at/completed_at AND the Towbook raw_json dispatchTime/completionTime
//   path real data actually carries), manifest line item + totals, +$1 per
//   completed job, out-of-hour + out-of-period exclusion, payment mirror
//   including the bonus, recompute stability, paid-row immutability, and zero
//   QA rows after. DATABASE_URL=... bun busy-bonus.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const {
  hourStartET, parseRawTimestamp, busyHourStartsFor, computeBusyBonus,
  jobAssignmentMs, jobCompletedMs, BUSY_BONUS_PER_JOB_CENTS,
} = await import("./src/data/busy-bonus-core.ts");
const {
  periodBoundariesFor, computePaydayCore, getPayPeriodDetailCore, markPayoutPaidCore,
} = await import("./src/data/payouts-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
await ensureSchema();
const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };
const ORG = `qa-busybonus-${randomUUID()}`;
const OWNER = `qa-bb-owner-${randomUUID()}`;
const D1 = `qa-bb-d1-${randomUUID()}`;
const D2 = `qa-bb-d2-${randomUUID()}`;
const D3 = `qa-bb-d3-${randomUUID()}`;
const tb = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 900_000_000n);
const TB1 = tb(D1), TB2 = tb(D2), TB3 = tb(D3);
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const iso = (d) => new Date(d).toISOString();
/* ---- cleanup (guarded, ALWAYS runs) ---- */
const cleanup = async () => {
  await q`DELETE FROM audit_log WHERE org_id = ${ORG} OR actor_user_id IN (${OWNER}, ${D1}, ${D2}, ${D3})`;
  await q`DELETE FROM payout_records WHERE org_id = ${ORG}`;
  await q`DELETE FROM pay_periods WHERE org_id = ${ORG}`;
  await q`DELETE FROM payment_transactions WHERE org_id = ${ORG}`;
  await q`DELETE FROM completion_tips WHERE org_id = ${ORG}`;
  await q`DELETE FROM status_events WHERE org_id = ${ORG}`;
  await q`DELETE FROM job_completions WHERE org_id = ${ORG}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id = ${ORG}`;
  await q`DELETE FROM payout_methods WHERE org_id = ${ORG}`;
  await q`DELETE FROM contractor_profiles WHERE org_id = ${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id = ${ORG}`;
  await q`DELETE FROM users WHERE id IN (${OWNER}, ${D1}, ${D2}, ${D3})`;
  assertQaOrg(ORG);
  await q`DELETE FROM organizations WHERE id = ${ORG}`;
};
try {
/* ===================== 1) PURE MATH — hours & boundaries ===================== */
{
  // 2026-07-15 is EDT (UTC-4). 14:37Z = 10:37 AM EDT → hour start 10:00 EDT = 14:00Z.
  const h = hourStartET(Date.parse("2026-07-15T14:37:00.000Z"));
  check("hour: mid-hour instant → ET hour start (EDT 10:00 = 14:00Z)", h === Date.parse("2026-07-15T14:00:00.000Z"), new Date(h).toISOString());
  // boundary: 14:59:59.999 belongs to the 14:00Z hour; 15:00:00.000 belongs to the next.
  const hb1 = hourStartET(Date.parse("2026-07-15T14:59:59.999Z"));
  const hb2 = hourStartET(Date.parse("2026-07-15T15:00:00.000Z"));
  check("hour: 14:59:59.999Z still the 14:00Z hour", hb1 === Date.parse("2026-07-15T14:00:00.000Z"), new Date(hb1).toISOString());
  check("hour: 15:00:00.000Z starts the 15:00Z hour", hb2 === Date.parse("2026-07-15T15:00:00.000Z"), new Date(hb2).toISOString());
  // winter (EST, UTC-5): 2026-01-15T19:37:00Z = 2:37 PM EST → 14:00 EST = 19:00Z.
  const hw = hourStartET(Date.parse("2026-01-15T19:37:00.000Z"));
  check("hour: EST hour start (2 PM EST = 19:00Z)", hw === Date.parse("2026-01-15T19:00:00.000Z"), new Date(hw).toISOString());
  // DST spring-forward 2026-03-08: 01:30 EST → 01:00 EST = 06:00Z; 03:30 EDT → 03:00 EDT = 07:00Z.
  const spr1 = hourStartET(Date.parse("2026-03-08T06:30:00.000Z"));
  const spr2 = hourStartET(Date.parse("2026-03-08T07:30:00.000Z"));
  check("hour: spring-forward 01:30 EST → 01:00 EST (06:00Z)", spr1 === Date.parse("2026-03-08T06:00:00.000Z"), new Date(spr1).toISOString());
  check("hour: spring-forward 03:30 EDT → 03:00 EDT (07:00Z)", spr2 === Date.parse("2026-03-08T07:00:00.000Z"), new Date(spr2).toISOString());
  const fall = hourStartET(Date.parse("2026-11-01T06:30:00.000Z")); // 01:30 EST after fall-back (05:00Z was 01:00 EDT)
  check("hour: fall-back 01:30 EST → 01:00 EST (06:00Z)", fall === Date.parse("2026-11-01T06:00:00.000Z"), new Date(fall).toISOString());
  // parseRawTimestamp: Z-less Towbook ISO treated as UTC.
  check("raw: Z-less ISO parsed as UTC", parseRawTimestamp("2026-07-15T14:05:00") === Date.parse("2026-07-15T14:05:00Z"), String(parseRawTimestamp("2026-07-15T14:05:00")));
  check("raw: fractional seconds ok", parseRawTimestamp("2026-07-15T14:05:00.79") === Date.parse("2026-07-15T14:05:00.79Z"), String(parseRawTimestamp("2026-07-15T14:05:00.79")));
  check("raw: space separator ok", parseRawTimestamp("2026-07-15 14:05:00") === Date.parse("2026-07-15T14:05:00Z"), String(parseRawTimestamp("2026-07-15 14:05:00")));
  check("raw: explicit Z left alone", parseRawTimestamp("2026-07-15T14:05:00Z") === Date.parse("2026-07-15T14:05:00Z"));
  check("raw: garbage → null", parseRawTimestamp("nope") === null);
  check("raw: null → null", parseRawTimestamp(null) === null);
}
{
  const H = Date.parse("2026-07-15T14:00:00.000Z"); // 10 AM EDT
  const Hp1 = H + 3600_000;
  // exactly 2 assignments in an hour → NOT busy
  check("busy: 2 assignments in an hour → not busy", busyHourStartsFor([H + 600_000, H + 1_200_000]).length === 0);
  // exactly 3 → busy
  const b3 = busyHourStartsFor([H + 600_000, H + 1_200_000, H + 1_800_000]);
  check("busy: exactly 3 assignments in an hour → busy", b3.length === 1 && b3[0] === H, JSON.stringify(b3));
  // 4 in the same hour → still ONE busy hour
  const b4 = busyHourStartsFor([H + 600_000, H + 1_200_000, H + 1_800_000, H + 2_400_000]);
  check("busy: 4 assignments in an hour → one busy hour", b4.length === 1 && b4[0] === H, JSON.stringify(b4));
  // two separate busy hours
  const b2h = busyHourStartsFor([H + 600_000, H + 1_200_000, H + 1_800_000, Hp1 + 600_000, Hp1 + 1_200_000, Hp1 + 1_800_000]);
  check("busy: 3+3 across two hours → two busy hours", b2h.length === 2 && b2h[0] === H && b2h[1] === Hp1, JSON.stringify(b2h));
  // 3rd assignment lands at 14:59:59 vs 15:00:00 → different hours; a
  // 15:00:00.000 3rd assignment lands in an hour that only has ONE assignment
  // (the 14:00 hour has just 2) → NO busy hour at all (correct boundary math).
  const late = busyHourStartsFor([H + 600_000, H + 1_200_000, H + 3_599_999]);
  const early = busyHourStartsFor([H + 600_000, H + 1_200_000, Hp1]);
  check("busy: 3rd at 14:59:59.999 keeps the 14:00Z hour", late.length === 1 && late[0] === H, JSON.stringify(late));
  check("busy: 3rd at 15:00:00.000 leaves no busy hour (15:00 has only 1)", early.length === 0, JSON.stringify(early));
  // computeBusyBonus: +$1 per completion inside the busy hour
  const bonus = computeBusyBonus([H + 600_000, H + 1_200_000, H + 1_800_000], [H + 2_000_000, H + 2_500_000, Hp1 + 60_000, H - 60_000]);
  check("bonus: 2 completions inside busy hour → $2", bonus.bonusJobs === 2 && bonus.bonusCents === 2 * BUSY_BONUS_PER_JOB_CENTS, JSON.stringify(bonus));
  check("bonus: hour breakdown carries completedJobs=2", bonus.hours.length === 1 && bonus.hours[0].startsAtMs === H && bonus.hours[0].completedJobs === 2, JSON.stringify(bonus.hours));
  // completion exactly at the hour boundary belongs to the NEXT hour → not counted
  const edge = computeBusyBonus([H + 600_000, H + 1_200_000, H + 1_800_000], [H + 3_600_000]);
  check("bonus: completion at 15:00:00.000 excluded (next hour)", edge.bonusJobs === 0, JSON.stringify(edge));
  // jobAssignmentMs / jobCompletedMs resolution
  check("resolve: assigned_at wins", jobAssignmentMs({ assigned_at: new Date(H + 5), created_at: new Date(H - 5) }) === H + 5);
  check("resolve: raw dispatchTime used when assigned_at missing", jobAssignmentMs({ raw_json: { dispatchTime: "2026-07-15T14:05:00" }, created_at: new Date(H - 5) }) === Date.parse("2026-07-15T14:05:00Z"));
  check("resolve: created_at last resort for assignment", jobAssignmentMs({ created_at: new Date(H - 5) }) === H - 5);
  check("resolve: completion needs completed_at or raw completionTime", jobCompletedMs({ created_at: new Date(H - 5) }) === null);
  check("resolve: raw completionTime used when completed_at missing", jobCompletedMs({ raw_json: { completionTime: "2026-07-15T14:45:00" } }) === Date.parse("2026-07-15T14:45:00Z"));
  check("resolve: completed_at wins", jobCompletedMs({ completed_at: new Date(H + 9), raw_json: { completionTime: "2026-07-15T13:45:00" } }) === H + 9);
}

/* ===================== 2) FIXTURES (closed past period) ===================== */
const b = periodBoundariesFor(new Date("2026-07-15T12:00:00Z")); // week Mon 2026-07-13 → Sun 07-19 (EDT)
const PERIOD = `pay-${ORG}-busy`;
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${"qa busy-bonus"})`;
await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES
  (${OWNER}, ${"QA Owner"}, ${`${OWNER}@qa.local`}, ${"x"}, NULL),
  (${D1}, ${"Busy Driver"}, ${`${D1}@qa.local`}, ${"x"}, ${TB1}),
  (${D2}, ${"Not Busy"}, ${`${D2}@qa.local`}, ${"x"}, ${TB2}),
  (${D3}, ${"Raw Imports"}, ${`${D3}@qa.local`}, ${"x"}, ${TB3})`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'),
  (${ORG}, ${D1}, 'contractor'), (${ORG}, ${D2}, 'contractor'), (${ORG}, ${D3}, 'contractor')`;
await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents) VALUES
  (${ORG}, ${D1}, 10000), (${ORG}, ${D2}, 15000), (${ORG}, ${D3}, 10000)`;
const M1 = `pm-${randomUUID()}`;
await q`INSERT INTO payout_methods(id, org_id, contractor_id, rail, handle, status, is_default, created_at, updated_at) VALUES
  (${M1}, ${ORG}, ${D1}, 'venmo', ${"@busy"}, 'verified', TRUE, NOW(), NOW()),
  (${`pm-${randomUUID()}`}, ${ORG}, ${D2}, 'cash_app', ${"$notbusy"}, 'verified', TRUE, NOW(), NOW()),
  (${`pm-${randomUUID()}`}, ${ORG}, ${D3}, 'cash_app', ${"$raw"}, 'verified', TRUE, NOW(), NOW())`;
await q`INSERT INTO pay_periods(id, org_id, starts_at, ends_at, payout_due_on, status) VALUES
  (${PERIOD}, ${ORG}, ${iso(b.startsAt)}, ${iso(b.endsAt)}, ${b.payoutDueOn}, 'open')`;

// Clock-hour anchors (EDT, UTC-4): hour A = 14:00Z (10 AM), hour C = 20:00Z (4 PM), hour E = 22:00Z.
const A = Date.parse("2026-07-15T14:00:00.000Z");
const C = Date.parse("2026-07-15T20:00:00.000Z");
const E = Date.parse("2026-07-15T22:00:00.000Z");
const F = Date.parse("2026-07-16T14:00:00.000Z"); // D3 raw-import busy hour
// Towbook completionTime is the authoritative completion instant (owner 2026-08-17):
// the payday window query keys strictly on raw_json->>'completionTime', so every
// completed fixture must carry it in ET wall-clock form, not just completed_at.
const etWallClock = (instant) => new Date(instant).toLocaleString("sv-SE", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}).replace(" ", "T");
const job = (id, tbId, status, at, assignedAt, completedAt, raw) => {
  const rawJson = completedAt != null ? { completionTime: etWallClock(completedAt), ...(raw ?? {}) } : raw;
  return q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at, assigned_at, completed_at, assigned_driver_towbook_id, raw_json) VALUES
    (${id}, ${ORG}, ${id.replace(/^qa-bb-j-/, "")}, ${"C"}, ${"9145550100"}, 41.1, -73.5, ${"CT"}, ${"Tire"}, ${status}, ${iso(at)}, ${assignedAt ? iso(assignedAt) : null}, ${completedAt ? iso(completedAt) : null}, ${tbId}, ${rawJson ? JSON.stringify(rawJson) : null})`;
};

// D1 — busy hour A (14:00Z): assignments A1,A2,A3,X1 (4 ≥ 3 → busy); completions in A: A1,A2,X1 (3 → +$3).
//      busy hour C (20:00Z): assignments C1..C4 (4 ≥ 3 → busy); completions in C: C1,C2 (2 → +$2).
//      A3 completed 15:30Z (hour B, not busy) → no bonus. C3 completed 21:05Z → no bonus.
//      C4 en_route (assignment counts toward busy-hour detection; no completion → no bonus).
//      OUT assigned+completed BEFORE the period → fully excluded.
await job(`qa-bb-j-${randomUUID()}`, TB1, "completed", A - 3600_000 * 5, A - 3600_000 * 5, A - 3600_000 * 5); // OUT pre-period
await job(`qa-bb-j-${randomUUID()}`, TB1, "completed", A + 600_000, A + 600_000, A + 2_400_000); // A1
await job(`qa-bb-j-${randomUUID()}`, TB1, "completed", A + 1_200_000, A + 1_200_000, A + 2_900_000); // A2
await job(`qa-bb-j-${randomUUID()}`, TB1, "completed", A + 1_800_000, A + 1_800_000, A + 5_400_000); // A3 → completed hour B
await job(`qa-bb-j-${randomUUID()}`, TB1, "completed", A - 300_000, A - 300_000, A + 2_700_000); // X1 assigned hour 13, completed IN hour A
await job(`qa-bb-j-${randomUUID()}`, TB1, "completed", C + 300_000, C + 300_000, C + 2_700_000); // C1
await job(`qa-bb-j-${randomUUID()}`, TB1, "completed", C + 900_000, C + 900_000, C + 3_300_000); // C2
await job(`qa-bb-j-${randomUUID()}`, TB1, "completed", C + 1_500_000, C + 1_500_000, C + 3_900_000); // C3 → completed hour D
await job(`qa-bb-j-${randomUUID()}`, TB1, "en_route", C + 2_100_000, C + 2_100_000, null); // C4
await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, status, idempotency_key, created_at)
  SELECT ${`qa-bb-t-${randomUUID()}`}, ${ORG}, id, ${D1}, ${TB1}, 1000, 'USD', 'paid', ${`tip-bb-${randomUUID()}`}, ${iso(A + 2_000_000)} FROM dispatch_jobs WHERE org_id=${ORG} AND assigned_driver_towbook_id=${TB1} AND status='completed' LIMIT 1`;

// D2 — exactly 2 assignments in hour E, both completed → 2 < 3 → NOT busy, no bonus.
await job(`qa-bb-j-${randomUUID()}`, TB2, "completed", E + 300_000, E + 300_000, E + 1_500_000);
await job(`qa-bb-j-${randomUUID()}`, TB2, "completed", E + 900_000, E + 900_000, E + 2_100_000);

// D3 — real-data shape: THREE jobs with NO assigned_at/completed_at, carrying
//      raw_json dispatchTime/completionTime (Z-less UTC) all inside hour F →
//      busy hour from raw dispatchTimes. The 3 raw jobs AND the normal
//      completed job all complete inside hour F (14:00–15:00Z) → +$1 × 4.
//      The normal job exists so the record is manifest-material (a bonus-only
//      contractor with zero completed_at rows is not — same rule as payday).
await job(`qa-bb-j-${randomUUID()}`, TB3, "completed", F - 60_000, null, F + 1_000_000); // normal, completed in hour F too
await job(`qa-bb-j-${randomUUID()}`, TB3, "completed", F - 60_000, null, null, { dispatchTime: "2026-07-16T14:05:00", completionTime: "2026-07-16T14:40:00" });
await job(`qa-bb-j-${randomUUID()}`, TB3, "completed", F - 60_000, null, null, { dispatchTime: "2026-07-16T14:10:00", completionTime: "2026-07-16T14:45:00" });
await job(`qa-bb-j-${randomUUID()}`, TB3, "completed", F - 60_000, null, null, { dispatchTime: "2026-07-16T14:15:00", completionTime: "2026-07-16T14:50:00" });

/* ===================== 3) COMPUTE → MANIFEST LINE ITEM ===================== */
let detail;
{
  const res = await computePaydayCore(ACTOR, PERIOD);
  check("compute: ok", res.ok, JSON.stringify(res));
  detail = res.ok ? res.data : null;
  check("compute: period → computed", detail && detail.period.status === "computed", JSON.stringify(detail?.period));
  const d1 = detail.records.find((r) => r.contractorId === D1);
  check("compute: D1 busy bonus $5 (3 in hour A + 2 in hour C)", d1 && d1.busyBonusCents === 500 && d1.busyBonusJobs === 5, JSON.stringify(d1));
  check("compute: D1 busy hours line items (A:3, C:2)", d1 && d1.busyBonusHours && d1.busyBonusHours.length === 2
    && d1.busyBonusHours.some((h) => h.startsAtIso === iso(A) && h.completedJobs === 3)
    && d1.busyBonusHours.some((h) => h.startsAtIso === iso(C) && h.completedJobs === 2), JSON.stringify(d1?.busyBonusHours));
  // D1 gross = 8 completed_at jobs × $100 = 80000 (OUT completes Wed 09:00Z —
  // still inside the period, so it counts toward jobCount but not the bonus),
  // tips 1000, bonus 500 → 81500
  check("compute: D1 total includes bonus ($815.00)", d1 && d1.jobCount === 8 && d1.grossCents === 80000 && d1.tipsCents === 1000 && d1.totalCents === 81500, JSON.stringify(d1));
  const d2 = detail.records.find((r) => r.contractorId === D2);
  check("compute: D2 exactly 2 assigned → no bonus (0)", d2 && d2.busyBonusCents === 0 && d2.busyBonusJobs === 0 && d2.busyBonusHours === null, JSON.stringify(d2));
  check("compute: D2 total unchanged ($300.00)", d2 && d2.totalCents === 30000, JSON.stringify(d2));
  const d3 = detail.records.find((r) => r.contractorId === D3);
  check("compute: D3 raw dispatchTime/completionTime path → +$4 (3 raw + 1 normal all complete in hour F)", d3 && d3.busyBonusCents === 400 && d3.busyBonusJobs === 4
    && d3.busyBonusHours && d3.busyBonusHours.length === 1 && d3.busyBonusHours[0].startsAtIso === iso(F) && d3.busyBonusHours[0].completedJobs === 4, JSON.stringify(d3));
  check("compute: D3 jobCount = 1 (only the completed_at row counts toward gross)", d3 && d3.jobCount === 1 && d3.grossCents === 10000 && d3.totalCents === 10400, JSON.stringify(d3));
  check("compute: totals.busyBonusCents = $9 across the manifest", detail && detail.totals.busyBonusCents === 900 && detail.totals.totalCents === 81500 + 30000 + 10400, JSON.stringify(detail?.totals));
  // payment_transactions mirror includes the bonus (the amount the owner sends)
  const mirror = await q`SELECT amount_cents FROM payment_transactions WHERE org_id=${ORG} AND idempotency_key=${`payout-pr-${PERIOD}-${D1}`}`;
  check("mirror: D1 payout mirror = 81500 (gross + tips + busy bonus)", mirror.length === 1 && Number(mirror[0].amount_cents) === 81500, JSON.stringify(mirror));
}

/* ===================== 4) RECOMPUTE STABILITY ===================== */
{
  const res = await computePaydayCore(ACTOR, PERIOD);
  check("recompute: ok", res.ok, JSON.stringify(res));
  check("recompute: D1 bonus unchanged ($5)", res.ok && res.data.records.find((r) => r.contractorId === D1)?.busyBonusCents === 500, JSON.stringify(res.data?.records));
  check("recompute: totals unchanged (900 bonus, 121900 total)", res.ok && res.data.totals.busyBonusCents === 900 && res.data.totals.totalCents === 121900, JSON.stringify(res.data?.totals));
  const rows = await q`SELECT COUNT(*)::int AS c FROM payout_records WHERE org_id=${ORG} AND period_id=${PERIOD}`;
  check("recompute: no duplicate records (3)", Number(rows[0].c) === 3, JSON.stringify(rows));
}

/* ===================== 5) PAID ROW IMMUTABILITY ===================== */
{
  const res = await markPayoutPaidCore(ACTOR, { recordId: `pr-${PERIOD}-${D1}`, note: "venmo sent" });
  check("paid: D1 marked paid", res.ok && res.data.records.find((r) => r.contractorId === D1)?.status === "paid", JSON.stringify(res.data?.records));
  check("paid: D1 paid row keeps the busy bonus snapshot", res.ok && res.data.records.find((r) => r.contractorId === D1)?.busyBonusCents === 500 && res.data.records.find((r) => r.contractorId === D1)?.totalCents === 81500, JSON.stringify(res.data?.records));
  const recomputed = await computePaydayCore(ACTOR, PERIOD);
  check("paid: recompute leaves paid D1 row untouched (bonus + total immutable)", recomputed.ok && recomputed.data.records.find((r) => r.contractorId === D1)?.status === "paid"
    && recomputed.data.records.find((r) => r.contractorId === D1)?.busyBonusCents === 500, JSON.stringify(recomputed.data?.records));
}

/* ===================== 6) MANIFEST READ (line item renders) ===================== */
{
  const res = await getPayPeriodDetailCore(ACTOR, PERIOD);
  check("detail: manifest read carries busyBonusHours + totals.busyBonusCents", res.ok && res.data
    && res.data.records.find((r) => r.contractorId === D1)?.busyBonusHours != null
    && res.data.totals.busyBonusCents === 900, JSON.stringify(res.data?.totals));
}

/* ============================== summary + cleanup ============================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`busy-bonus.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
await cleanup();
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa busy-bonus%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-bb-%@qa.local') AS users,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa busy-bonus%') AS members,
  (SELECT COUNT(*)::int FROM contractor_profiles cp JOIN organizations o ON o.id=cp.org_id WHERE o.name LIKE 'qa busy-bonus%') AS profiles,
  (SELECT COUNT(*)::int FROM payout_methods p JOIN organizations o ON o.id=p.org_id WHERE o.name LIKE 'qa busy-bonus%') AS methods,
  (SELECT COUNT(*)::int FROM dispatch_jobs j JOIN organizations o ON o.id=j.org_id WHERE o.name LIKE 'qa busy-bonus%') AS jobs,
  (SELECT COUNT(*)::int FROM status_events e JOIN organizations o ON o.id=e.org_id WHERE o.name LIKE 'qa busy-bonus%') AS events,
  (SELECT COUNT(*)::int FROM job_completions jc JOIN organizations o ON o.id=jc.org_id WHERE o.name LIKE 'qa busy-bonus%') AS completions,
  (SELECT COUNT(*)::int FROM completion_tips t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa busy-bonus%') AS tips,
  (SELECT COUNT(*)::int FROM pay_periods p JOIN organizations o ON o.id=p.org_id WHERE o.name LIKE 'qa busy-bonus%') AS periods,
  (SELECT COUNT(*)::int FROM payout_records pr JOIN organizations o ON o.id=pr.org_id WHERE o.name LIKE 'qa busy-bonus%') AS records,
  (SELECT COUNT(*)::int FROM payment_transactions pt JOIN organizations o ON o.id=pt.org_id WHERE o.name LIKE 'qa busy-bonus%') AS tx,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa busy-bonus%') AS audit`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("busy-bonus.test.mjs: cleanup verified — zero QA rows left");
}
catch (e) { console.error("FATAL:", e); await cleanup().catch(() => {}); process.exit(1); }
