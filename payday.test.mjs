// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts.
// Hermetic tests for PAYDAY (build order #8, owner-directed 2026-08-11):
//   period window math in America/New_York (Mon 00:00 → Sun 23:59:59.999,
//   payout Wednesday after, DST-safe), compute payday from completed jobs +
//   paid tips (rate snapshot, tips separate line, out-of-window excluded),
//   blocked contractors (no method / unverified method — amount still
//   recorded), recompute idempotency (paid rows immutable), per-row + whole-
//   period mark-paid, PII masking (handle_masked vs handle_full), the
//   payment_transactions payout mirror, role gates, and zero QA rows after.
//   DATABASE_URL=... bun payday.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const {
  periodBoundariesFor, listPayPeriodsCore, getPayPeriodDetailCore, computePaydayCore,
  markPayoutPaidCore, markPaydayPeriodPaidCore, verifyPayoutMethodCore, rejectPayoutMethodCore,
  getMoneyOverviewCore, setMyPayoutMethodCore, maskHandle,
} = await import("./src/data/payouts-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
await ensureSchema();
const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };
const ORG = `qa-payday-${randomUUID()}`;
const ORG2 = `qa-payday2-${randomUUID()}`;
const OWNER = `qa-pd-owner-${randomUUID()}`;
const ADMIN = `qa-pd-admin-${randomUUID()}`;
const D1 = `qa-pd-d1-${randomUUID()}`;
const D2 = `qa-pd-d2-${randomUUID()}`;
const D3 = `qa-pd-d3-${randomUUID()}`;
const D4 = `qa-pd-d4-${randomUUID()}`;
const OTHER2 = `qa-pd-owner2-${randomUUID()}`;
const tb = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 900_000_000n);
const TB1 = tb(D1), TB2 = tb(D2), TB3 = tb(D3);
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const ADMIN_ACTOR = { orgId: ORG, id: ADMIN, role: "admin" };
const DRIVER_ACTOR = { orgId: ORG, id: D1, role: "contractor" };
const WRONG_ORG = { orgId: ORG2, id: OTHER2, role: "owner" };
const iso = (d) => new Date(d).toISOString();
/* ---- cleanup (guarded, ALWAYS runs) ---- */
const cleanup = async () => {
  await q`DELETE FROM audit_log WHERE org_id IN (${ORG}, ${ORG2}) OR actor_user_id IN (${OWNER}, ${ADMIN}, ${D1}, ${D2}, ${D3}, ${D4}, ${OTHER2})`;
  await q`DELETE FROM payout_records WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM pay_periods WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM payment_transactions WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM completion_tips WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM status_events WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM job_completions WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM dispatch_jobs WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM payout_methods WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM contractor_profiles WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM organization_memberships WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM users WHERE id IN (${OWNER}, ${ADMIN}, ${D1}, ${D2}, ${D3}, ${D4}, ${OTHER2})`;
  assertQaOrg(ORG); assertQaOrg(ORG2);
  await q`DELETE FROM organizations WHERE id IN (${ORG}, ${ORG2})`;
};
try {
/* ---------------- period window math (pure, DST-proof) ---------------- */
{
  const b = periodBoundariesFor(new Date("2026-03-10T15:00:00Z")); // Tue Mar 10 2026 (spring-forward was Mar 8)
  check("math: starts Monday 00:00 ET (Mar 9 04:00Z, EDT)", b.startsAt.toISOString() === "2026-03-09T04:00:00.000Z", b.startsAt.toISOString());
  check("math: ends Sunday 23:59:59.999 ET (Mar 16 03:59:59.999Z, EDT)", b.endsAt.toISOString() === "2026-03-16T03:59:59.999Z", b.endsAt.toISOString());
  check("math: payout due = Wed after close (Mar 18)", b.payoutDueOn === "2026-03-18", b.payoutDueOn);
  const b2 = periodBoundariesFor(new Date("2026-11-03T12:00:00Z")); // Tue Nov 3 2026 (fall-back Nov 1)
  check("math: fall-back week starts Nov 2 05:00Z (EST)", b2.startsAt.toISOString() === "2026-11-02T05:00:00.000Z", b2.startsAt.toISOString());
  check("math: fall-back week ends Nov 9 04:59:59.999Z", b2.endsAt.toISOString() === "2026-11-09T04:59:59.999Z", b2.endsAt.toISOString());
  const b3 = periodBoundariesFor(new Date("2026-08-03T01:00:00Z")); // Mon Aug 3 2026 01:00Z = Sun Aug 2 21:00 ET — still the PREVIOUS week
  check("math: Mon 01:00Z (Sun 21:00 ET) belongs to the week ending Aug 2", b3.endsAt.toISOString().startsWith("2026-08-03"), b3.endsAt.toISOString());
  const b4 = periodBoundariesFor(new Date("2026-08-03T04:00:00Z")); // Mon Aug 3 04:00Z = Mon 00:00 ET exactly
  check("math: Mon 00:00 ET starts the new week", b4.startsAt.toISOString() === "2026-08-03T04:00:00.000Z", b4.startsAt.toISOString());
  const span = (b4.endsAt.getTime() - b4.startsAt.getTime() + 1);
  check("math: window is exactly 7 days (168h) for a non-DST week", span === 7 * 86400000, String(span));
}
/* ------------------------- fixtures ------------------------- */
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${"qa payday"}), (${ORG2}, ${"qa payday 2"})`;
await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES
  (${OWNER}, ${"QA Owner"}, ${`${OWNER}@qa.local`}, ${"x"}, NULL),
  (${ADMIN}, ${"QA Admin"}, ${`${ADMIN}@qa.local`}, ${"x"}, NULL),
  (${D1}, ${"Jane Doe"}, ${`${D1}@qa.local`}, ${"x"}, ${TB1}),
  (${D2}, ${"Pat NoMethod"}, ${`${D2}@qa.local`}, ${"x"}, ${TB2}),
  (${D3}, ${"Alex Unverified"}, ${`${D3}@qa.local`}, ${"x"}, ${TB3}),
  (${D4}, ${"Tips Only"}, ${`${D4}@qa.local`}, ${"x"}, NULL),
  (${OTHER2}, ${"QA Owner2"}, ${`${OTHER2}@qa.local`}, ${"x"}, NULL)`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'), (${ORG}, ${ADMIN}, 'admin'),
  (${ORG}, ${D1}, 'contractor'), (${ORG}, ${D2}, 'contractor'), (${ORG}, ${D3}, 'contractor'), (${ORG}, ${D4}, 'contractor'),
  (${ORG2}, ${OTHER2}, 'owner')`;
// payrates: D1 $100/job, D2 $150/job, D3 unset (rate not set), D4 n/a
await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents) VALUES
  (${ORG}, ${D1}, 10000), (${ORG}, ${D2}, 15000), (${ORG}, ${D3}, NULL)`;
// payout methods: D1 venmo VERIFIED, D3 cash_app UNVERIFIED, D2 none (blocked)
const M1 = `pm-${randomUUID()}`, M3 = `pm-${randomUUID()}`;
await q`INSERT INTO payout_methods(id, org_id, contractor_id, rail, handle, status, is_default, created_at, updated_at) VALUES
  (${M1}, ${ORG}, ${D1}, 'venmo', ${"@jane"}, 'verified', TRUE, NOW(), NOW()),
  (${M3}, ${ORG}, ${D3}, 'cash_app', ${"$alex"}, 'connected_unverified', TRUE, NOW(), NOW())`;
// the CLOSED period: last week (fully in the past), seeded directly.
const closed = periodBoundariesFor(new Date(Date.now() - 8 * 86400000));
const PERIOD = `pay-${ORG}-closed`;
await q`INSERT INTO pay_periods(id, org_id, starts_at, ends_at, payout_due_on, status) VALUES
  (${PERIOD}, ${ORG}, ${iso(closed.startsAt)}, ${iso(closed.endsAt)}, ${closed.payoutDueOn}, 'open')`;
const J1 = `qa-pd-j1-${randomUUID()}`, J2 = `qa-pd-j2-${randomUUID()}`, J3 = `qa-pd-j3-${randomUUID()}`;
const J_OUT = `qa-pd-jout-${randomUUID()}`;
const J_EDGE = `qa-pd-jedge-${randomUUID()}`;
await q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at, completed_at, assigned_driver_towbook_id) VALUES
  (${J1}, ${ORG}, ${"9101"}, ${"C1"}, ${"9145550101"}, 41.1, -73.5, ${"CT"}, ${"Tire"}, 'completed', ${iso(new Date(closed.startsAt.getTime() + 3600e3))}, ${iso(new Date(closed.startsAt.getTime() + 3600e3))}, ${TB1}),
  (${J2}, ${ORG}, ${"9102"}, ${"C2"}, ${"9145550102"}, 41.1, -73.5, ${"CT"}, ${"Jump"}, 'completed', ${iso(new Date(closed.startsAt.getTime() + 7200e3))}, ${iso(new Date(closed.startsAt.getTime() + 7200e3))}, ${TB1}),
  (${J3}, ${ORG}, ${"9103"}, ${"C3"}, ${"9145550103"}, 41.1, -73.5, ${"CT"}, ${"Lock"}, 'completed', ${iso(new Date(closed.startsAt.getTime() + 8600e3))}, ${iso(new Date(closed.startsAt.getTime() + 8600e3))}, ${TB2}),
  (${J_OUT}, ${ORG}, ${"9104"}, ${"C4"}, ${"9145550104"}, 41.1, -73.5, ${"CT"}, ${"Tire"}, 'completed', ${iso(new Date(closed.endsAt.getTime() + 3600e3))}, ${iso(new Date(closed.endsAt.getTime() + 3600e3))}, ${TB1}),
  (${J_EDGE}, ${ORG}, ${"9105"}, ${"C5"}, ${"9145550105"}, 41.1, -73.5, ${"CT"}, ${"Jump"}, 'completed', ${iso(new Date(closed.endsAt.getTime() - 1000))}, ${iso(new Date(closed.endsAt.getTime() - 1000))}, ${TB3})`;
// D3 also has an uncompleted job inside the window — must NOT count
await q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at, assigned_driver_towbook_id) VALUES
  (${`qa-pd-jopen-${randomUUID()}`}, ${ORG}, ${"9106"}, ${"C6"}, ${"9145550106"}, 41.1, -73.5, ${"CT"}, ${"Tire"}, 'dispatched', ${iso(new Date(closed.startsAt.getTime() + 5000e3))}, ${TB3})`;
// tips: D1 $25 paid (in window), D3 $10 paid (in window), D1 $5 FAILED (excluded), D4 $8 paid (tips-only contractor)
await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, status, idempotency_key, created_at) VALUES
  (${`qa-pd-t1-${randomUUID()}`}, ${ORG}, ${J1}, ${D1}, ${TB1}, 2500, 'USD', 'paid', ${`tip-pd-${randomUUID()}`}, ${iso(new Date(closed.startsAt.getTime() + 5000e3))}),
  (${`qa-pd-t2-${randomUUID()}`}, ${ORG}, ${J_EDGE}, ${D3}, ${TB3}, 1000, 'USD', 'paid', ${`tip-pd-${randomUUID()}`}, ${iso(new Date(closed.startsAt.getTime() + 6000e3))}),
  (${`qa-pd-t3-${randomUUID()}`}, ${ORG}, ${J2}, ${D1}, ${TB1}, 500, 'USD', 'failed', ${`tip-pd-${randomUUID()}`}, ${iso(new Date(closed.startsAt.getTime() + 7000e3))}),
  (${`qa-pd-t4-${randomUUID()}`}, ${ORG}, ${J1}, ${D4}, NULL, 800, 'USD', 'paid', ${`tip-pd-${randomUUID()}`}, ${iso(new Date(closed.startsAt.getTime() + 8000e3))})`;

/* ------------------------- listPayPeriods + gates ------------------------- */
{
  const list = await listPayPeriodsCore(ACTOR);
  check("periods: list ok", list.ok, JSON.stringify(list));
  check("periods: current + just-closed created, default = just-closed", list.ok && list.data.defaultPeriodId !== list.data.currentPeriodId && list.data.periods.some((p) => p.id === list.data.currentPeriodId && p.isCurrent) && list.data.periods.some((p) => p.id === list.data.defaultPeriodId && !p.isCurrent), JSON.stringify(list.data));
  const denied = await listPayPeriodsCore(DRIVER_ACTOR);
  check("periods: contractor cannot list periods", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const wrongOrg = await listPayPeriodsCore(WRONG_ORG);
  check("periods: other-org owner sees no qa periods", wrongOrg.ok && wrongOrg.data.periods.every((p) => !p.id.includes(ORG)), JSON.stringify(wrongOrg.data));
}

/* ------------------------- compute payday ------------------------- */
let detail;
{
  const res = await computePaydayCore(ACTOR, PERIOD);
  check("compute: ok", res.ok, JSON.stringify(res));
  detail = res.ok ? res.data : null;
  check("compute: period status → computed", detail && detail.period.status === "computed", JSON.stringify(detail?.period));
  // D1: 2 jobs × $100 + $25 tip = $225, verified venmo → computed
  const d1 = detail.records.find((r) => r.contractorId === D1);
  check("compute: D1 gross = 2 × $100", d1 && d1.grossCents === 20000, JSON.stringify(d1));
  check("compute: D1 tips separate line = $25", d1 && d1.tipsCents === 2500, JSON.stringify(d1));
  check("compute: D1 total = $225", d1 && d1.totalCents === 22500 && d1.status === "computed" && d1.rail === "venmo", JSON.stringify(d1));
  check("compute: D1 full handle owner-only @jane", d1 && d1.handleFull === "@jane", JSON.stringify(d1));
  check("compute: D1 masked handle never full", d1 && d1.handleMasked !== "@jane" && d1.handleMasked.includes("••"), JSON.stringify(d1));
  // D2: no method → blocked, amount still recorded, rail NULL
  const d2 = detail.records.find((r) => r.contractorId === D2);
  check("compute: D2 blocked (no method), amount recorded $150", d2 && d2.status === "blocked" && d2.rail === null && d2.methodStatus === "none" && d2.totalCents === 15000, JSON.stringify(d2));
  // D3: unverified method → blocked, rail+handle snapshot, rate not set → gross 0, tip $10
  const d3 = detail.records.find((r) => r.contractorId === D3);
  check("compute: D3 blocked (unverified), handle snapshot kept", d3 && d3.status === "blocked" && d3.rail === "cash_app" && d3.methodStatus === "connected_unverified" && d3.handleFull === "$alex", JSON.stringify(d3));
  check("compute: D3 rate not set → gross 0, tip separate $10", d3 && d3.payrateCents === null && d3.grossCents === 0 && d3.tipsCents === 1000 && d3.totalCents === 1000 && d3.jobCount === 1, JSON.stringify(d3));
  // D4: tips-only contractor → record with 0 jobs, $8 tip, no method → blocked
  const d4 = detail.records.find((r) => r.contractorId === D4);
  check("compute: D4 tips-only → 0 jobs + $8 tip, blocked (no method)", d4 && d4.jobCount === 0 && d4.grossCents === 0 && d4.tipsCents === 800 && d4.totalCents === 800 && d4.status === "blocked", JSON.stringify(d4));
  // out-of-window job + failed tip + open job excluded
  check("compute: exactly 4 records (out-of-window / failed / open-job excluded)", detail && detail.records.length === 4, JSON.stringify(detail?.records));
  check("compute: totals — 4 contractors, $393 total ($350 gross + $43 tips)", detail && detail.totals.contractorCount === 4 && detail.totals.totalCents === 39300 && detail.totals.grossCents === 35000 && detail.totals.tipsCents === 4300 && detail.totals.blockedCount === 3 && detail.totals.dueCount === 1, JSON.stringify(detail?.totals));
  // rail groups: only VERIFIED rows group — Venmo (1) — $225
  check("compute: rail groups only verified — venmo $225", detail && detail.totals.rails.length === 1 && detail.totals.rails[0].rail === "venmo" && detail.totals.rails[0].totalCents === 22500, JSON.stringify(detail?.totals.rails));
  // payment_transactions payout mirror
  const mirrors = await q`SELECT idempotency_key, amount_cents, status, kind FROM payment_transactions WHERE org_id=${ORG} AND kind='payout'`;
  check("mirror: 4 staged payout ledger rows", mirrors.length === 4 && mirrors.every((m) => m.status === "staged"), JSON.stringify(mirrors));
  check("mirror: idempotency key payout-pr-<period>-<contractor>", mirrors.some((m) => m.idempotency_key === `payout-pr-${PERIOD}-${D1}`), JSON.stringify(mirrors));
}

/* ------------------------- idempotent recompute ------------------------- */
{
  const res = await computePaydayCore(ACTOR, PERIOD);
  check("recompute: ok", res.ok, JSON.stringify(res));
  const rows = await q`SELECT COUNT(*)::int AS c FROM payout_records WHERE org_id=${ORG} AND period_id=${PERIOD}`;
  check("recompute: no duplicate records (still 4)", Number(rows[0].c) === 4, JSON.stringify(rows));
  check("recompute: totals unchanged (4 contractors, $393, 3 blocked)", res.ok && res.data.totals.totalCents === 39300 && res.data.totals.blockedCount === 3, JSON.stringify(res.data?.totals));
  const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND entity_type='pay_period' ORDER BY occurred_at`;
  check("audit: payday_computed + payout_period_recomputed recorded", aud.some((a) => a.action === "payday_computed") && aud.some((a) => a.action === "payout_period_recomputed"), JSON.stringify(aud));
}

/* ------------------------- mark paid (per row + period) ------------------------- */
{
  const res = await markPayoutPaidCore(ACTOR, { recordId: `pr-${PERIOD}-${D1}`, note: "venmo sent" });
  check("markpaid: D1 paid", res.ok && res.data.records.find((r) => r.contractorId === D1)?.status === "paid", JSON.stringify(res.data?.records));
  check("markpaid: paid row carries note + paidAt", res.ok && res.data.records.find((r) => r.contractorId === D1)?.payNote === "venmo sent" && res.data.records.find((r) => r.contractorId === D1)?.paidAt != null, JSON.stringify(res.data?.records));
  check("markpaid: period stays computed while blocked rows remain", res.ok && res.data.period.status === "computed", JSON.stringify(res.data?.period));
  const mirrors = await q`SELECT status FROM payment_transactions WHERE org_id=${ORG} AND idempotency_key=${`payout-pr-${PERIOD}-${D1}`}`;
  check("markpaid: mirror flipped staged → charged", mirrors.length === 1 && mirrors[0].status === "charged", JSON.stringify(mirrors));
  const denied = await markPayoutPaidCore(DRIVER_ACTOR, { recordId: `pr-${PERIOD}-${D1}` });
  check("markpaid: contractor cannot mark paid", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const again = await markPayoutPaidCore(ACTOR, { recordId: `pr-${PERIOD}-${D1}` });
  check("markpaid: already-paid row refuses double-mark", again.ok === false && again.code === "invalid_input", JSON.stringify(again));
  const blockedMark = await markPayoutPaidCore(ACTOR, { recordId: `pr-${PERIOD}-${D2}` });
  check("markpaid: blocked row cannot be marked paid", blockedMark.ok === false && blockedMark.code === "invalid_input", JSON.stringify(blockedMark));

  // recompute after pay: D1's paid row IMMUTABLE
  const recomputed = await computePaydayCore(ACTOR, PERIOD);
  check("recompute: paid row untouched after recompute", recomputed.ok && recomputed.data.records.find((r) => r.contractorId === D1)?.status === "paid" && recomputed.data.records.find((r) => r.contractorId === D1)?.totalCents === 22500, JSON.stringify(recomputed.data?.records));

  // mark the WHOLE period paid — computed rows flip, blocked stay blocked
  const whole = await markPaydayPeriodPaidCore(ACTOR, PERIOD);
  check("markperiod: period → paid", whole.ok && whole.data.period.status === "paid" && whole.data.period.paidAt != null, JSON.stringify(whole.data?.period));
  check("markperiod: blocked rows still blocked (never silently dropped)", whole.ok && whole.data.records.find((r) => r.contractorId === D2)?.status === "blocked" && whole.ok && whole.data.records.find((r) => r.contractorId === D3)?.status === "blocked", JSON.stringify(whole.data?.records));
  const computeOnPaid = await computePaydayCore(ACTOR, PERIOD);
  check("recompute: paid period recompute is a safe no-op (no status regression)", computeOnPaid.ok && computeOnPaid.data.period.status === "paid" && computeOnPaid.data.records.filter((r) => r.status === "paid").length === 1, JSON.stringify(computeOnPaid.data?.period));
}

/* ------------------------- verify → recompute unblocks ------------------------- */
{
  const vres = await verifyPayoutMethodCore(ACTOR, M3);
  check("verify: unverified method → verified", vres.ok && vres.data && vres.data.status === "verified", JSON.stringify(vres));
  const rres = await rejectPayoutMethodCore(ACTOR, { methodId: M1, note: "wrong handle" });
  check("reject: verified method → rejected with note", rres.ok && rres.data && rres.data.status === "rejected" && rres.data.rejectNote === "wrong handle", JSON.stringify(rres));
  const vdenied = await verifyPayoutMethodCore(DRIVER_ACTOR, M3);
  check("verify: contractor cannot verify", vdenied.ok === false && vdenied.code === "unauthorized", JSON.stringify(vdenied));
  // re-verify D3's method and compute a FRESH period → D3 lands in a rail group
  const vres2 = await verifyPayoutMethodCore(ACTOR, M3);
  check("verify: re-verify after reject works", vres2.ok && vres2.data && vres2.data.status === "verified", JSON.stringify(vres2));
  const fresh = periodBoundariesFor(new Date(Date.now() - 15 * 86400000));
  const PERIOD2 = `pay-${ORG}-fresh`;
  await q`INSERT INTO pay_periods(id, org_id, starts_at, ends_at, payout_due_on, status) VALUES
    (${PERIOD2}, ${ORG}, ${iso(fresh.startsAt)}, ${iso(fresh.endsAt)}, ${fresh.payoutDueOn}, 'open')`;
  await q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at, completed_at, assigned_driver_towbook_id) VALUES
    (${`qa-pd-jf-${randomUUID()}`}, ${ORG}, ${"9201"}, ${"CF"}, ${"9145550107"}, 41.1, -73.5, ${"CT"}, ${"Tire"}, 'completed', ${iso(new Date(fresh.startsAt.getTime() + 3600e3))}, ${iso(new Date(fresh.startsAt.getTime() + 3600e3))}, ${TB3})`;
  const c2 = await computePaydayCore(ACTOR, PERIOD2);
  check("fresh: D3 verified now → computed + rail group", c2.ok && c2.data.records.find((r) => r.contractorId === D3)?.status === "computed" && c2.data.records.find((r) => r.contractorId === D3)?.rail === "cash_app", JSON.stringify(c2.data?.records));
  // mark ALL paid in period2 → period flips to paid (no blocked rows)
  const m2 = await markPaydayPeriodPaidCore(ACTOR, PERIOD2);
  check("fresh: markperiod flips to paid when no blocked rows", m2.ok && m2.data.period.status === "paid" && m2.data.totals.paidCount === 1, JSON.stringify(m2.data?.period));
}

/* ------------------------- open-period guard + overview ------------------------- */
{
  const open = await listPayPeriodsCore(ACTOR);
  const openId = open.ok ? open.data.currentPeriodId : "";
  const tryOpen = await computePaydayCore(ACTOR, openId);
  check("guard: open (current) period refuses compute", tryOpen.ok === false && tryOpen.code === "invalid_input" && tryOpen.message.includes("open"), JSON.stringify(tryOpen));
  const overview = await getMoneyOverviewCore(ACTOR);
  check("overview: revenue zero + demo flag (no real money)", overview.ok && overview.data.revenueCents === 0 && overview.data.hasRealMoney === false && overview.data.revenueStagedCount === 0, JSON.stringify(overview));
  check("overview: tips = $43 paid tips (3 paid rows)", overview.ok && overview.data.tipsCents === 4300 && overview.data.tipsCount === 3, JSON.stringify(overview));
  check("overview: payouts due row present", overview.ok && typeof overview.data.payoutsDueCents === "number" && overview.data.payoutsDueOn != null, JSON.stringify(overview.data));
}

/* ------------------------- PII: masked in ledger rows ------------------------- */
{
  const rows = await q`SELECT handle_full, handle_masked FROM payout_records WHERE org_id=${ORG} AND contractor_id=${D1}`;
  check("pii: handle_masked stored, never the full handle", rows.length === 1 && rows[0].handle_full === "@jane" && rows[0].handle_masked !== "@jane" && rows[0].handle_masked.includes("••"), JSON.stringify(rows));
  const aud = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND action='payout_marked_paid'`;
  check("pii: audit detail carries masked only", aud.every((a) => !JSON.stringify(a.detail).includes("@jane")), JSON.stringify(aud));
  check("mask: maskHandle util", maskHandle("cash_app", "$joe", null, null) === "$jo••••" && maskHandle("bank", null, "Chase", "4321") === "Chase ••4321", "");
}

/* ------------------------- detail read for a period with no records ------------------------- */
{
  const none = await getPayPeriodDetailCore(ACTOR, `pay-${ORG}-never`);
  check("detail: unknown period → null", none.ok && none.data === null, JSON.stringify(none));
}
} finally {
  await cleanup();
}
/* ================= POST-CLEANUP VERIFICATION (zero QA rows) ================= */
const leftover = await q`SELECT
  (SELECT count(*) FROM payout_records WHERE org_id LIKE 'qa-payday%') AS records,
  (SELECT count(*) FROM pay_periods WHERE org_id LIKE 'qa-payday%') AS periods,
  (SELECT count(*) FROM payment_transactions WHERE org_id LIKE 'qa-payday%') AS txns,
  (SELECT count(*) FROM payout_methods WHERE org_id LIKE 'qa-payday%') AS methods,
  (SELECT count(*) FROM completion_tips WHERE org_id LIKE 'qa-payday%') AS tips,
  (SELECT count(*) FROM dispatch_jobs WHERE org_id LIKE 'qa-payday%') AS jobs,
  (SELECT count(*) FROM contractor_profiles WHERE org_id LIKE 'qa-payday%') AS profiles,
  (SELECT count(*) FROM audit_log WHERE org_id LIKE 'qa-payday%') AS audit,
  (SELECT count(*) FROM organizations WHERE id LIKE 'qa-payday%') AS orgs,
  (SELECT count(*) FROM users WHERE id LIKE 'qa-pd-%') AS users,
  (SELECT count(*) FROM organization_memberships WHERE org_id LIKE 'qa-payday%') AS mems`;
check("cleanup: zero QA rows", Object.values(leftover[0]).every((v) => Number(v) === 0), JSON.stringify(leftover[0]));
console.log(`\npayday.test.mjs: ${checks.length}/${checks.length} passed`);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
process.exit(checks.every(([, c]) => c) ? 0 : 1);
