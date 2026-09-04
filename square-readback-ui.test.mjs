// DB safety (2026-09-04): org deletes guarded by assertQaOrg — see
// src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic tests for SLICE 2 of the "Square as source of truth" READ-BACK
// (owner-directed 2026-09-04) — the UI-facing facade surface:
//   - the client-safe facade re-exports the ReconcileResult shape and exposes
//     owner/admin-gated server fns (listSquarePayments GET / reconcile POST);
//   - the pure UI presentation helpers (RECONCILE_KIND_LABELS,
//     RECONCILE_VERDICT_BADGE, reconcileFailureMessage) cover every verdict and
//     every non-ok result shape without touching Square / DB / auth;
//   - reconcileSquarePaymentsCore still exercises the full (not-configured /
//     unauthorized / per-row verdict) paths end-to-end so the render surface has
//     a guaranteed-correct source.
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun square-readback-ui.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const facade = await import("./src/data/square-readback.ts");
const {
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
const ORG = `qa-square-ui-${TAG}`;
const OWNER = `qa-sq-ui-owner-${TAG}`;
const DRIVER = `qa-sq-ui-driver-${TAG}`;
const email = (u) => `${u}-${randomUUID()}@lightning.test`;
const OWNER_ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const CONTRACTOR_ACTOR = { orgId: ORG, id: DRIVER, role: "contractor" };

process.env.SQUARE_ACCESS_TOKEN = "qa-access-token";
process.env.SQUARE_LOCATION_ID = "DM6Z9C1EYM8J2";
process.env.SQUARE_APPLICATION_ID = "qa-app-id";

const resp = (status, { json } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() { return json != null ? JSON.stringify(json) : ""; },
  async json() { return json != null ? JSON.parse(JSON.stringify(json)) : {}; },
});
const payment = (id, status, totalAmount, opts = {}) => ({
  payment: {
    id, status,
    total_money: { amount: totalAmount, currency: "USD" },
    tip_money: { amount: opts.tip ?? 0, currency: "USD" },
    refunds: opts.refunds ?? [],
    ...(opts.refunded_money != null ? { refunded_money: { amount: opts.refunded_money } } : {}),
  },
});
function makeFetch() {
  return async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (u.startsWith("https://connect.squareup.com/v2/payments?") && method === "GET") {
      return resp(200, { json: { payments: [payment("pay-ok", "COMPLETED", 1000).payment], cursor: null } });
    }
    const m = u.match(/\/v2\/payments\/([^/?]+)/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (id === "pay-missing") return resp(404, { json: { errors: [{ code: "NOT_FOUND" }] } });
      if (id === "pay-error") return resp(500, { json: { errors: [{ code: "INTERNAL_SERVER_ERROR" }] } });
      if (id === "pay-ok") return resp(200, { json: payment("pay-ok", "COMPLETED", 1000) });
      if (id === "pay-refunded") return resp(200, { json: payment("pay-refunded", "COMPLETED", 500, { refunds: [{ id: "r1", amount_money: { amount: 500 }, status: "COMPLETED" }], refunded_money: 500 }) });
      if (id === "pay-failed") return resp(200, { json: payment("pay-failed", "FAILED", 0) });
      if (id === "pay-mismatch") return resp(200, { json: payment("pay-mismatch", "COMPLETED", 9999) });
      return resp(404, { json: { errors: [{ code: "NOT_FOUND" }] } });
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  };
}

/* ============ 1) facade: server fns + type re-export surface ============ */
{
  check("facade exports listSquarePayments server fn", typeof facade.listSquarePayments === "function", String(Object.keys(facade)));
  check("facade exports reconcileSquarePayments server fn", typeof facade.reconcileSquarePayments === "function");
  check("facade exports RECONCILE_KIND_LABELS", facade.RECONCILE_KIND_LABELS && typeof facade.RECONCILE_KIND_LABELS === "object");
  check("facade exports RECONCILE_VERDICT_BADGE", facade.RECONCILE_VERDICT_BADGE && typeof facade.RECONCILE_VERDICT_BADGE === "object");
  check("facade exports reconcileFailureMessage", typeof facade.reconcileFailureMessage === "function");
}

/* ============ 2) pure presentation helpers (no Square/DB/auth) ============ */
{
  const { RECONCILE_KIND_LABELS, RECONCILE_VERDICT_BADGE, reconcileFailureMessage } = facade;
  const verdicts = ["ok", "square_refunded", "square_failed", "square_missing", "square_amount_mismatch", "square_read_error"];
  check("kind labels cover all three kinds", ["tip", "tire_plug", "battery"].every((k) => typeof RECONCILE_KIND_LABELS[k] === "string"), JSON.stringify(RECONCILE_KIND_LABELS));
  check("verdict badge covers every verdict", verdicts.every((v) => RECONCILE_VERDICT_BADGE[v] && RECONCILE_VERDICT_BADGE[v].cls && RECONCILE_VERDICT_BADGE[v].label), JSON.stringify(RECONCILE_VERDICT_BADGE));
  check("verdict badge: ok is confirmed/green", RECONCILE_VERDICT_BADGE.ok.label === "Confirmed" && RECONCILE_VERDICT_BADGE.ok.cls.includes("success"));
  check("verdict badge: problem verdicts are non-green", ["square_refunded", "square_failed", "square_missing", "square_amount_mismatch", "square_read_error"].every((v) => !RECONCILE_VERDICT_BADGE[v].cls.includes("success")), JSON.stringify(RECONCILE_VERDICT_BADGE));

  check("failure: square_not_configured → clear notice", reconcileFailureMessage("square_not_configured", "x").includes("SQUARE_ACCESS_TOKEN"));
  check("failure: unauthorized → owner/admin notice", reconcileFailureMessage("unauthorized", "x").toLowerCase().includes("owner"));
  check("failure: database_error → passes message through", reconcileFailureMessage("database_error", "db broke") === "db broke");
  check("failure: unknown code → passes message through", reconcileFailureMessage("something_else", "mystery") === "mystery");
  check("failure: unknown code → fallback when message empty", reconcileFailureMessage("something_else", "").length > 0);
}

/* ============ 3) reconcile core still emits the exact ReconcileResult shape ============ */
async function cleanup() {
  const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-square-ui-%'`;
  for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa-square-ui-%'`) {
    assertQaOrg(org.id, org.name);
    await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
  }
  for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
  await q`DELETE FROM users WHERE email LIKE 'qa-square-ui-%@lightning.test'`.catch(() => {});
}
await cleanup();
await ensureSchema();
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES
  (${OWNER}, 'QA SQ UI Owner', ${email(OWNER)}, 'x'),
  (${DRIVER}, 'QA SQ UI Driver', ${email(DRIVER)}, 'x')`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'),
  (${ORG}, ${DRIVER}, 'contractor')`;
const JOB = "sq-ui-job-1";
await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at)
  VALUES(${JOB}, ${ORG}, 'QA Customer', '2035550100', 41.2, -73.2, 'Bridgeport', 'jump_start', 'completed', NOW())`;
await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, square_payment_id, status, attempt, idempotency_key) VALUES
  ('sq-ui-tip-ok', ${ORG}, ${JOB}, ${DRIVER}, NULL, 1000, 'USD', 'pay-ok', 'paid', 1, 'sq-ui-tip-ok-key'),
  ('sq-ui-tip-refunded', ${ORG}, ${JOB}, ${DRIVER}, NULL, 500, 'USD', 'pay-refunded', 'paid', 1, 'sq-ui-tip-refunded-key'),
  ('sq-ui-tip-missing', ${ORG}, ${JOB}, ${DRIVER}, NULL, 250, 'USD', 'pay-missing', 'paid', 1, 'sq-ui-tip-missing-key'),
  ('sq-ui-tip-error', ${ORG}, ${JOB}, ${DRIVER}, NULL, 350, 'USD', 'pay-error', 'paid', 1, 'sq-ui-tip-error-key')`;
await q`INSERT INTO tire_plug_transactions(id, org_id, job_id, contractor_user_id, amount_cents, status, square_charge_id, paid_at) VALUES
  ('sq-ui-plug-failed', ${ORG}, ${JOB}, ${DRIVER}, 4500, 'charged', 'pay-failed', NULL)`;
await q`INSERT INTO battery_sales(id, org_id, job_id, contractor_user_id, vin, vehicle_make, vehicle_model, vehicle_year, battery_price_cents, install_type, install_fee_cents, sales_tax_cents, admin_fee_cents, total_cents, status, square_charge_id, paid_at) VALUES
  ('sq-ui-battery-mismatch', ${ORG}, ${JOB}, ${DRIVER}, '1HGBH41JXMN109186', 'Honda', 'Civic', '2001', 15000, 'standard', 4500, 0, 0, 4500, 'paid', 'pay-mismatch', NOW())`;

{
  const res = await reconcileSquarePaymentsCore(OWNER_ACTOR, { fetchImpl: makeFetch() });
  check("reconcile: ok result", res.ok === true, JSON.stringify(res));
  check("reconcile: rows array present", res.ok === true && Array.isArray(res.rows) && res.rows.length === 6, JSON.stringify(res.ok ? res.rows.length : res));
  check("reconcile: summary shape", res.ok === true && typeof res.summary.totalLocalSettledCount === "number" && typeof res.summary.totalSquareConfirmed === "number" && Array.isArray(res.summary.byDriver), JSON.stringify(res.ok ? res.summary : res));
  const matchOf = (rid) => (res.ok ? res.rows.find((r) => r.localRowId === rid)?.match : null);
  check("reconcile: ok verdict", matchOf("sq-ui-tip-ok") === "ok");
  check("reconcile: refunded verdict", matchOf("sq-ui-tip-refunded") === "square_refunded");
  check("reconcile: missing verdict", matchOf("sq-ui-tip-missing") === "square_missing");
  check("reconcile: read error verdict", matchOf("sq-ui-tip-error") === "square_read_error");
  check("reconcile: failed verdict (tire plug)", matchOf("sq-ui-plug-failed") === "square_failed");
  check("reconcile: mismatch verdict (battery)", matchOf("sq-ui-battery-mismatch") === "square_amount_mismatch");
  check("reconcile: every emitted verdict has a badge", res.ok === true && res.rows.every((r) => facade.RECONCILE_VERDICT_BADGE[r.match]));
}

/* ============ 4) non-ok result shapes ============ */
{
  const denied = await reconcileSquarePaymentsCore(CONTRACTOR_ACTOR, { fetchImpl: makeFetch() });
  check("contractor → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));

  const deniedList = await listSquarePaymentsGatedCore(CONTRACTOR_ACTOR, { fetchImpl: makeFetch() });
  check("list contractor → unauthorized", deniedList.ok === false && deniedList.code === "unauthorized", JSON.stringify(deniedList));

  const saved = { a: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID, i: process.env.SQUARE_APPLICATION_ID };
  delete process.env.SQUARE_ACCESS_TOKEN;
  delete process.env.SQUARE_LOCATION_ID;
  delete process.env.SQUARE_APPLICATION_ID;
  try {
    const nc = await reconcileSquarePaymentsCore(OWNER_ACTOR, { stableDir: "/nonexistent-square-ui-qa" });
    check("missing config → square_not_configured", nc.ok === false && nc.code === "square_not_configured", JSON.stringify(nc));
  } finally {
    if (saved.a != null) process.env.SQUARE_ACCESS_TOKEN = saved.a;
    if (saved.l != null) process.env.SQUARE_LOCATION_ID = saved.l;
    if (saved.i != null) process.env.SQUARE_APPLICATION_ID = saved.i;
  }
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`square-readback-ui.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
await cleanup();
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa-square-ui-%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-square-ui-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM completion_tips t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa-square-ui-%') AS tips,
  (SELECT COUNT(*)::int FROM tire_plug_transactions t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa-square-ui-%') AS plugs,
  (SELECT COUNT(*)::int FROM battery_sales b JOIN organizations o ON o.id=b.org_id WHERE o.name LIKE 'qa-square-ui-%') AS sales,
  (SELECT COUNT(*)::int FROM dispatch_jobs d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa-square-ui-%') AS jobs,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-square-ui-%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("square-readback-ui.test.mjs: cleanup verified — zero QA rows left");
