// DB safety (2026-09-04): org deletes guarded by assertQaOrg — see
// src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic tests for SLICE 1 of the "Square as source of truth" READ-BACK
// (owner-directed 2026-09-04) — SERVER-SIDE ONLY, read-only reconciliation:
//   - listSquarePaymentsCore / getSquarePaymentCore / searchSquareOrdersCore
//     against an injected fetchImpl (NO real Square in tests);
//   - reconcileSquarePaymentsCore reads locally-settled completion_tips /
//     tire_plug_transactions / battery_sales, pulls each Square payment via
//     GetPayment (deduped), and emits per-row verdicts (ok / square_refunded /
//     square_failed / square_amount_mismatch / square_missing /
//     square_read_error) + a summary;
//   - owner-only enforcement (contractor actor refused on both server fns);
//   - fail-closed when loadSquareConfig throws (nonexistent stableDir + no env).
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun square-readback.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const {
  listSquarePaymentsCore,
  getSquarePaymentCore,
  searchSquareOrdersCore,
  reconcileSquarePaymentsCore,
  listSquarePaymentsGatedCore,
} = await import("./src/data/square-readback-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const TAG = randomUUID().slice(0, 8);
const ORG = `qa-square-readback-${TAG}`;
const OWNER = `qa-sr-owner-${TAG}`;
const DRIVER = `qa-sr-driver-${TAG}`;
const email = (u) => `${u}-${randomUUID()}@lightning.test`;
const OWNER_ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const CONTRACTOR_ACTOR = { orgId: ORG, id: DRIVER, role: "contractor" };

// Fake Square creds resolved from env (no file access, deterministic). These are
// never sent to a real network — the injected fetchImpl intercepts everything.
process.env.SQUARE_ACCESS_TOKEN = "qa-access-token";
process.env.SQUARE_LOCATION_ID = "DM6Z9C1EYM8J2";
process.env.SQUARE_APPLICATION_ID = "qa-app-id";

/* ------------------------- canned Square responses ------------------------- */
const resp = (status, { json } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() { return json != null ? JSON.stringify(json) : ""; },
  async json() { return json != null ? JSON.parse(JSON.stringify(json)) : {}; },
});
const payment = (id, status, totalAmount, opts = {}) => ({
  payment: {
    id,
    status,
    total_money: { amount: totalAmount, currency: "USD" },
    tip_money: { amount: opts.tip ?? 0, currency: "USD" },
    refunds: opts.refunds ?? [],
    ...(opts.refunded_money != null ? { refunded_money: { amount: opts.refunded_money } } : {}),
  },
});
const PAYMENTS = {
  "pay-ok": payment("pay-ok", "COMPLETED", 1000),
  "pay-refunded": payment("pay-refunded", "COMPLETED", 500, {
    tip: 100,
    refunds: [{ id: "r1", amount_money: { amount: 500 }, status: "COMPLETED" }],
    refunded_money: 500,
  }),
  "pay-failed": payment("pay-failed", "FAILED", 0),
  "pay-mismatch": payment("pay-mismatch", "COMPLETED", 9999),
  "pay-error": null, // handled specially → 500
};
const getPaymentCalls = new Map(); // id → count
function makeFetch() {
  return async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (u.startsWith("https://connect.squareup.com/v2/orders/search") && method === "POST") {
      return resp(200, { json: { orders: [{ id: "order-1", state: "COMPLETED", total_money: { amount: 2500 } }], cursor: "order-cursor-1" } });
    }
    if (u.startsWith("https://connect.squareup.com/v2/payments?") && method === "GET") {
      return resp(200, { json: { payments: [PAYMENTS["pay-ok"].payment], cursor: "list-cursor-1" } });
    }
    // GetPayment
    const m = u.match(/\/v2\/payments\/([^/?]+)/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      getPaymentCalls.set(id, (getPaymentCalls.get(id) ?? 0) + 1);
      if (id === "pay-missing") return resp(404, { json: { errors: [{ code: "NOT_FOUND" }] } });
      if (id === "pay-error") return resp(500, { json: { errors: [{ code: "INTERNAL_SERVER_ERROR" }] } });
      if (PAYMENTS[id]) return resp(200, { json: PAYMENTS[id] });
      return resp(404, { json: { errors: [{ code: "NOT_FOUND" }] } });
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  };
}

/* ------------------------------ setup / cleanup ------------------------------ */
async function cleanup() {
  const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-square-readback-%'`;
  for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa-square-readback-%'`) {
    assertQaOrg(org.id, org.name);
    await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
  }
  for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
  await q`DELETE FROM users WHERE email LIKE 'qa-square-readback-%@lightning.test'`.catch(() => {});
}
await cleanup();
await ensureSchema();
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES
  (${OWNER}, 'QA SR Owner', ${email(OWNER)}, 'x'),
  (${DRIVER}, 'QA SR Driver', ${email(DRIVER)}, 'x')`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'),
  (${ORG}, ${DRIVER}, 'contractor')`;
const JOB = "sr-job-1";
await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at)
  VALUES(${JOB}, ${ORG}, 'QA Customer', '2035550100', 41.2, -73.2, 'Bridgeport', 'jump_start', 'completed', NOW())`;

/* seed locally-settled rows (the exact "locally settled" predicates under test) */
// completion_tips — paid + square_payment_id non-null
await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, square_payment_id, status, attempt, idempotency_key) VALUES
  ('sr-tip-ok', ${ORG}, ${JOB}, ${DRIVER}, NULL, 1000, 'USD', 'pay-ok', 'paid', 1, 'sr-tip-ok-key'),
  ('sr-tip-refunded', ${ORG}, ${JOB}, ${DRIVER}, NULL, 500, 'USD', 'pay-refunded', 'paid', 1, 'sr-tip-refunded-key'),
  ('sr-tip-missing', ${ORG}, ${JOB}, ${DRIVER}, NULL, 250, 'USD', 'pay-missing', 'paid', 1, 'sr-tip-missing-key'),
  ('sr-tip-error', ${ORG}, ${JOB}, ${DRIVER}, NULL, 350, 'USD', 'pay-error', 'paid', 1, 'sr-tip-error-key'),
  ('sr-tip-dedupe2', ${ORG}, ${JOB}, ${DRIVER}, NULL, 1000, 'USD', 'pay-ok', 'paid', 2, 'sr-tip-dedupe2-key'),
  ('sr-tip-declined-excluded', ${ORG}, ${JOB}, ${DRIVER}, NULL, 900, 'USD', 'pay-ok', 'declined', 1, 'sr-tip-declined-excluded-key'),
  ('sr-tip-null-excluded', ${ORG}, ${JOB}, ${DRIVER}, NULL, 800, 'USD', NULL, 'paid', 1, 'sr-tip-null-excluded-key')`;
// tire_plug_transactions — status IN ('charged','paid') + square_charge_id non-null
await q`INSERT INTO tire_plug_transactions(id, org_id, job_id, contractor_user_id, amount_cents, status, square_charge_id, paid_at) VALUES
  ('sr-plug-failed', ${ORG}, ${JOB}, ${DRIVER}, 4500, 'charged', 'pay-failed', NULL),
  ('sr-plug-offered-excluded', ${ORG}, ${JOB}, ${DRIVER}, 4500, 'offered', NULL, NULL)`;
// battery_sales — status 'paid' + square_charge_id non-null
await q`INSERT INTO battery_sales(id, org_id, job_id, contractor_user_id, vin, vehicle_make, vehicle_model, vehicle_year, battery_price_cents, install_type, install_fee_cents, sales_tax_cents, admin_fee_cents, total_cents, status, square_charge_id, paid_at) VALUES
  ('sr-battery-mismatch', ${ORG}, ${JOB}, ${DRIVER}, '1HGBH41JXMN109186', 'Honda', 'Civic', '2001', 15000, 'standard', 4500, 0, 0, 4500, 'paid', 'pay-mismatch', NOW()),
  ('sr-battery-quote-excluded', ${ORG}, ${JOB}, ${DRIVER}, '1HGBH41JXMN109187', 'Honda', 'Accord', '2002', 15000, 'standard', 4500, 0, 0, 4500, 'quote', NULL, NULL)`;

/* ============ 1) reconcile: verdicts + summary + dedupe + predicates ============ */
{
  const fetchImpl = makeFetch();
  const res = await reconcileSquarePaymentsCore(OWNER_ACTOR, { fetchImpl });
  check("reconcile: ok", res.ok === true, JSON.stringify(res));
  const rows = res.ok ? res.rows : [];
  const byId = (rid) => rows.find((r) => r.localRowId === rid);
  const find = (rid) => byId(rid) ?? { match: null, message: null };

  check("reconcile: settled count = 7 (excludes declined/null/offered/quote)", res.ok && res.summary.totalLocalSettledCount === 7, JSON.stringify(res.summary));
  check("tip ok → ok verdict", find("sr-tip-ok").match === "ok", JSON.stringify(find("sr-tip-ok")));
  check("tip refunded → square_refunded + refunded flag/amount", find("sr-tip-refunded").match === "square_refunded" && find("sr-tip-refunded").squareRefunded === true && find("sr-tip-refunded").squareRefundedAmountCents === 500, JSON.stringify(find("sr-tip-refunded")));
  check("plug FAILED → square_failed", find("sr-plug-failed").match === "square_failed" && find("sr-plug-failed").squareStatus === "FAILED", JSON.stringify(find("sr-plug-failed")));
  check("battery amount mismatch → square_amount_mismatch", find("sr-battery-mismatch").match === "square_amount_mismatch" && find("sr-battery-mismatch").squareTotalAmountCents === 9999 && find("sr-battery-mismatch").localAmountCents === 4500, JSON.stringify(find("sr-battery-mismatch")));
  check("tip missing → square_missing (GetPayment 404)", find("sr-tip-missing").match === "square_missing", JSON.stringify(find("sr-tip-missing")));
  check("tip read error → square_read_error (mid-batch continues)", find("sr-tip-error").match === "square_read_error", JSON.stringify(find("sr-tip-error")));
  check("dedupe: same Square payment ok for both rows", find("sr-tip-ok").match === "ok" && find("sr-tip-dedupe2").match === "ok", JSON.stringify(find("sr-tip-dedupe2")));
  check("dedupe: GetPayment called once for pay-ok", getPaymentCalls.get("pay-ok") === 1, JSON.stringify([...getPaymentCalls.entries()]));

  const s = res.ok ? res.summary : null;
  check("summary: totalSquareConfirmed = 2 (ok + dedupe)", s !== null && s.totalSquareConfirmed === 2, JSON.stringify(s));
  check("summary: refunded/failed/missing/mismatch/readError counts", s !== null && s.totalRefunded === 1 && s.totalFailed === 1 && s.totalMissing === 1 && s.totalMismatch === 1 && s.totalReadError === 1, JSON.stringify(s));
  check("summary: local total = 1000+500+250+350+1000+4500+4500 = 12100", s !== null && s.totalLocalAmountCents === 12100, JSON.stringify(s));
  check("summary: square-confirmed total = 1000+1000 = 2000", s !== null && s.totalSquareConfirmedAmountCents === 2000, JSON.stringify(s));
  check("summary: per-driver row present for the driver", s !== null && s.byDriver.some((d) => d.driverId === DRIVER && d.localCount === 7), JSON.stringify(s?.byDriver));
}

/* ============ 2) read endpoints (ListPayments / GetPayment / SearchOrders) ============ */
{
  const fetchImpl = makeFetch();
  const config = { accessToken: "qa", locationId: "DM6Z9C1EYM8J2", applicationId: "qa" };
  const list = await listSquarePaymentsCore(config, { limit: 10, fetchImpl });
  check("list: ok + one payment + cursor", list.ok === true && list.payments.length === 1 && list.payments[0].id === "pay-ok" && list.cursor === "list-cursor-1", JSON.stringify(list));

  const one = await getSquarePaymentCore(config, "pay-ok", { fetchImpl });
  check("get: ok + status/total/tip", one.ok === true && one.payment.status === "COMPLETED" && one.payment.totalAmountCents === 1000 && one.payment.tipAmountCents === 0, JSON.stringify(one));

  const missing = await getSquarePaymentCore(config, "pay-missing", { fetchImpl });
  check("get: 404 → square_missing", missing.ok === false && missing.code === "square_missing", JSON.stringify(missing));

  const orders = await searchSquareOrdersCore(config, { fetchImpl });
  check("orders: ok + one order + cursor", orders.ok === true && orders.orders.length === 1 && orders.orders[0].id === "order-1" && orders.cursor === "order-cursor-1", JSON.stringify(orders));
}

/* ============ 3) owner-only enforcement ============ */
{
  const deniedList = await listSquarePaymentsGatedCore(CONTRACTOR_ACTOR, { fetchImpl: makeFetch() });
  check("list: contractor actor → unauthorized", deniedList.ok === false && deniedList.code === "unauthorized", JSON.stringify(deniedList));
  const deniedRec = await reconcileSquarePaymentsCore(CONTRACTOR_ACTOR, { fetchImpl: makeFetch() });
  check("reconcile: contractor actor → unauthorized", deniedRec.ok === false && deniedRec.code === "unauthorized", JSON.stringify(deniedRec));
}

/* ============ 4) fail-closed when loadSquareConfig throws ============ */
{
  const saved = { a: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID, i: process.env.SQUARE_APPLICATION_ID };
  delete process.env.SQUARE_ACCESS_TOKEN;
  delete process.env.SQUARE_LOCATION_ID;
  delete process.env.SQUARE_APPLICATION_ID;
  try {
    const res = await reconcileSquarePaymentsCore(OWNER_ACTOR, { stableDir: "/nonexistent-square-dir-qa" });
    check("reconcile: missing config → square_not_configured", res.ok === false && res.code === "square_not_configured", JSON.stringify(res));
  } finally {
    if (saved.a != null) process.env.SQUARE_ACCESS_TOKEN = saved.a;
    if (saved.l != null) process.env.SQUARE_LOCATION_ID = saved.l;
    if (saved.i != null) process.env.SQUARE_APPLICATION_ID = saved.i;
  }
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`square-readback.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
await cleanup();
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa-square-readback-%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-square-readback-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM completion_tips t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa-square-readback-%') AS tips,
  (SELECT COUNT(*)::int FROM tire_plug_transactions t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa-square-readback-%') AS plugs,
  (SELECT COUNT(*)::int FROM battery_sales b JOIN organizations o ON o.id=b.org_id WHERE o.name LIKE 'qa-square-readback-%') AS sales,
  (SELECT COUNT(*)::int FROM dispatch_jobs d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa-square-readback-%') AS jobs,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-square-readback-%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("square-readback.test.mjs: cleanup verified — zero QA rows left");
