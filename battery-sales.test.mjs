// Hermetic tests for the AI BATTERY SALES AGENT (owner-spec'd 2026-08-13,
// Phase 1; formula owner-corrected: salesTax + adminFee apply to the BATTERY
// PRICE ONLY — the install fee is never taxed and carries no admin fee).
// Coverage: pricing math, NHTSA VIN decode (mocked fetch), test→vin→vehicle→
// price→install→quote→approve→handoff→paid flow, the payment HAND-OFF hard
// gate (charge refused until approved; approve refused before quote ready),
// auto-created "Battery installation" job (same contractor, linked to the
// sale), rates config (defaults + owner-only update), decline→voided path, and
// the REQUIRED battery-test completion gate (completeJobCore blocks jumpstart
// jobs until the test is recorded, and until a faulty test reaches paid/voided).
// DB safety: org deletes guarded by assertQaOrg — see src/data/db-guard.ts.
// DATABASE_URL=... bun battery-sales.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const {
  batteryQuoteCents, decodeVin, batteryRatesCore, updateBatteryRatesCore,
  batteryAgentStateCore, recordBatteryTestCore, batteryAgentStepCore, chargeBatterySaleCore,
} = await import("./src/data/battery-sales-core.ts");
const { completeJobCore } = await import("./src/data/driver-photos-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { squareIdempotencyKey } = await import("./src/data/square-client.ts");
await ensureSchema();
const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };
const ORG = `qa-battery-${randomUUID()}`;
const OWNER = `qa-batt-owner-${randomUUID()}`;
const D1 = `qa-batt-d1-${randomUUID()}`;
const tb = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 900_000_000n);
const TB1 = tb(D1);
const JOB = `qa-batt-job-${randomUUID().slice(0, 8)}`;
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const DRIVER = { orgId: ORG, id: D1, role: "contractor", towbookDriverId: TB1 };
const VIN = "1HGCM82633A004352";
const VEHICLE = { Make: "HONDA", Model: "Accord", ModelYear: "2019", ErrorCode: "0" };

/* ---- cleanup (guarded, ALWAYS runs) ---- */
const cleanup = async () => {
  await q`DELETE FROM battery_sales WHERE org_id = ${ORG}`;
  await q`DELETE FROM battery_compatibility WHERE org_id = ${ORG}`;
  await q`DELETE FROM battery_products WHERE org_id = ${ORG}`;
  await q`DELETE FROM audit_log WHERE org_id = ${ORG} OR actor_user_id IN (${OWNER}, ${D1})`;
  await q`DELETE FROM status_events WHERE org_id = ${ORG}`;
  await q`DELETE FROM job_completions WHERE org_id = ${ORG}`;
  await q`DELETE FROM completion_tips WHERE org_id = ${ORG}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id = ${ORG}`;
  await q`DELETE FROM org_settings WHERE org_id = ${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id = ${ORG}`;
  await q`DELETE FROM users WHERE id IN (${OWNER}, ${D1})`;
  assertQaOrg(ORG);
  await q`DELETE FROM organizations WHERE id = ${ORG}`;
};

const sqEnv = { t: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID, a: process.env.SQUARE_APPLICATION_ID };
// Body-capturing Square mock — records every /v2/payments request so the test
// can assert the idempotency key actually sent (hashed ≤45 chars, deterministic
// per attempt — Square's no-double-charge guarantee).
const squareCalls = [];
const squareOk = () => (url, opts) => {
  if (String(url).includes("/v2/payments")) {
    let body = {};
    try { body = JSON.parse(String(opts?.body ?? "{}")); } catch { /* keep {} */ }
    squareCalls.push({ url: String(url), body });
    return Promise.resolve(new Response(JSON.stringify({ payment: { id: "pay_test_battery", status: "COMPLETED", receipt_url: "https://receipt.test" } }), { status: 200, headers: { "content-type": "application/json" } }));
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
};
const nhtsaOk = () => (_url, _opts) =>
  Promise.resolve(new Response(JSON.stringify({ Results: [VEHICLE] }), { status: 200, headers: { "content-type": "application/json" } }));

try {
/* ---- seed the QA org + users + the jumpstart job up front (rates/state
 *      reads need the org row before any org_settings write) ---- */
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa battery sales')`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES(${OWNER}, 'QA Owner', ${`${OWNER}@qa.local`}, 'x'), (${D1}, 'QA Driver', ${`${D1}@qa.local`}, 'x')`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OWNER}, 'owner'), (${ORG}, ${D1}, 'contractor')`;
await q`UPDATE users SET towbook_driver_id=${TB1} WHERE id=${D1}`;
await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, customer_phone, vehicle_desc, pickup, assigned_driver_towbook_id, assigned_driver_name)
  VALUES(${JOB}, ${ORG}, 'Test Customer', '(860) 555-0111', 41.76, -72.67, 'Hartford', 'jump_start', 'arrived', NOW(), '2019 Honda Accord; dead battery.', 'call-123456', '(860) 555-0111', '2019 HONDA ACCORD', '1 Main St, Hartford', ${TB1}, 'QA Driver')`;
// B3 fixtures: approved fitment plus active, org-scoped product. Price is server-authoritative.
await q`INSERT INTO battery_products(id, org_id, group_size, display_name, retail_cents, installation_cents, warranty_years, free_replacement_years, core_charge_cents, availability, active) VALUES(gen_random_uuid()::text, ${ORG}, '47', 'LIGHTNING GOLD BATTERY', 14999, 4500, 3, 3, 0, 'in_stock', true)`;
await q`INSERT INTO battery_compatibility(id, org_id, make, model, year_from, year_to, trim, engine, battery_group_size, status, source_reference_internal) VALUES(gen_random_uuid()::text, ${ORG}, 'HONDA', 'ACCORD', 2018, 2020, null, null, '47', 'approved', 'qa-battery-sales-fitment')`;
await q`INSERT INTO battery_compatibility(id, org_id, make, model, year_from, year_to, trim, engine, battery_group_size, status, source_reference_internal) VALUES(gen_random_uuid()::text, ${ORG}, 'FORD', 'F-150', 2017, 2019, null, null, '47', 'approved', 'qa-battery-sales-fitment')`;

/* ===================== 1) PURE PRICING — the owner-corrected formula ===================== */
{
  // battery $149.99, install $45, tax 6.35% ON BATTERY ONLY, admin 8.75% ON BATTERY ONLY.
  const quote = batteryQuoteCents(14999, 4500, 635, 875);
  check("pricing: salesTax = batteryPrice × 6.35% only", quote.salesTaxCents === 952, `got ${quote.salesTaxCents}`); // 149.99 × 0.0635 = 9.524365 → 952
  check("pricing: adminFee = batteryPrice × 8.75% only", quote.adminFeeCents === 1312, `got ${quote.adminFeeCents}`); // 149.99 × 0.0875 = 13.124125 → 1312
  check("pricing: install fee is NOT taxed (install unchanged)", quote.installFeeCents === 4500, `got ${quote.installFeeCents}`);
  check("pricing: total = battery + install + tax + admin", quote.totalCents === 14999 + 4500 + 952 + 1312, `got ${quote.totalCents}`);
  // Advanced $65, $200 battery: tax 1270 (200×6.35), admin 1750 (200×8.75) — install 6500 untaxed.
  const adv = batteryQuoteCents(20000, 6500, 635, 875);
  check("pricing: advanced fee 65, tax on battery only (1270)", adv.salesTaxCents === 1270, String(adv.salesTaxCents));
  check("pricing: admin on battery only (1750)", adv.adminFeeCents === 1750, String(adv.adminFeeCents));
  check("pricing: advanced total", adv.totalCents === 20000 + 6500 + 1270 + 1750, String(adv.totalCents));
  // Zero tax rate → no tax; zero admin → no admin.
  const zero = batteryQuoteCents(10000, 4500, 0, 0);
  check("pricing: 0% tax/admin → total = battery + install", zero.salesTaxCents === 0 && zero.adminFeeCents === 0 && zero.totalCents === 14500, String(zero.totalCents));
}

/* ===================== 2) NHTSA VIN DECODE (mock) ===================== */
{
  const ok = await decodeVin(VIN, nhtsaOk());
  check("vin: decode ok → make/model/year", ok.ok && ok.make === "HONDA" && ok.model === "Accord" && ok.year === "2019", JSON.stringify(ok));
  const bad = await decodeVin("1HGCM82633A00435", nhtsaOk()); // 16 chars
  check("vin: 16-char VIN refused", !bad.ok, bad.ok ? "accepted" : "ok");
  const iqo = await decodeVin("1HGOQ82633A004352", nhtsaOk());
  check("vin: I/O/Q characters refused", !iqo.ok, "accepted");
  const errCode = await decodeVin(VIN, () => Promise.resolve(new Response(JSON.stringify({ Results: [{ Make: "", Model: "", ModelYear: "", ErrorCode: "11" }] }), { status: 200, headers: { "content-type": "application/json" } })));
  check("vin: NHTSA error code → graceful failure", !errCode.ok && String(errCode.message).includes("manual"), JSON.stringify(errCode));
  const httpErr = await decodeVin(VIN, () => Promise.resolve(new Response("nope", { status: 503 })));
  check("vin: HTTP failure → graceful failure", !httpErr.ok, "accepted");
  const networkErr = await decodeVin(VIN, () => Promise.reject(new Error("down")));
  check("vin: network failure → graceful failure", !networkErr.ok && String(networkErr.message).includes("connection"), JSON.stringify(networkErr));
}

/* ===================== 3) RATES — defaults + owner-only update ===================== */
{
  const rates = await batteryRatesCore(ORG);
  check("rates: defaults 6.35% / 8.75% / $45 / $65", rates.taxRateBps === 635 && rates.adminFeeBps === 875 && rates.installStandardCents === 4500 && rates.installAdvancedCents === 6500, JSON.stringify(rates));
  const upd = await updateBatteryRatesCore(ACTOR, { taxRateBps: 700, adminFeeBps: 900, installStandardCents: 5000, installAdvancedCents: 7000, warehouseAddress: "12 Warehouse Way, Hartford CT" });
  check("rates: owner update persists", upd.ok && upd.rates.taxRateBps === 700 && upd.rates.installAdvancedCents === 7000 && upd.rates.warehouseAddress.includes("Warehouse"), JSON.stringify(upd));
  const denied = await updateBatteryRatesCore(DRIVER, { taxRateBps: 700, adminFeeBps: 900, installStandardCents: 5000, installAdvancedCents: 7000, warehouseAddress: "" });
  check("rates: contractor update refused", !denied.ok && denied.code === "unauthorized", JSON.stringify(denied));
}

/* ===================== 4) THE FULL FLOW — test → … → paid + install job ===================== */
// The flow assertions use the OWNER-CORRECTED DEFAULT math (6.35%/8.75%/$45/$65) —
// section 3 mutated the org rates, so reset them before the flow.
{
  const reset = await updateBatteryRatesCore(ACTOR, { taxRateBps: 635, adminFeeBps: 875, installStandardCents: 4500, installAdvancedCents: 6500, warehouseAddress: "12 Warehouse Way, Hartford CT" });
  check("rates: reset to defaults before the flow", reset.ok && reset.rates.taxRateBps === 635 && reset.rates.installStandardCents === 4500, JSON.stringify(reset));
}
// Required battery test — blocks completion before it's recorded.
const gate1 = await completeJobCore(DRIVER, { jobId: JOB });
check("gate: complete refused before battery test", !gate1.ok && gate1.code === "battery_test_required", JSON.stringify(gate1));

const testFaulty = await recordBatteryTestCore(DRIVER, { jobId: JOB, result: "faulty" });
check("flow: faulty test → step vin", testFaulty.ok && testFaulty.state.step === "vin", JSON.stringify(testFaulty));

const gate2 = await completeJobCore(DRIVER, { jobId: JOB });
check("gate: faulty + no sale decision → still blocked", !gate2.ok && gate2.code === "battery_test_required", JSON.stringify(gate2));

const vinStep = await batteryAgentStepCore(DRIVER, { jobId: JOB, action: "vin", vin: VIN }, { fetchImpl: nhtsaOk() });
check("flow: vin decoded → step vehicle", vinStep.ok && vinStep.state.step === "vehicle" && vinStep.state.sale?.vehicleMake === "HONDA", JSON.stringify(vinStep));
check("flow: decoded from NHTSA (not manual)", vinStep.ok && vinStep.state.sale?.vehicleManual === false, "manual flag set");
check("flow: decoded vehicle needs the driver's confirm", vinStep.ok && vinStep.state.sale?.vehicleConfirmed === false, "confirmed too early");

// B3 removed driver-entered pricing; install is gated until confirmation.
const earlyInstall = await batteryAgentStepCore(DRIVER, { jobId: JOB, action: "install", installType: "standard" });
check("gate: install refused before vehicle confirm", !earlyInstall.ok && earlyInstall.code === "invalid_state", JSON.stringify(earlyInstall));

const confirmStep = await batteryAgentStepCore(DRIVER, { jobId: JOB, action: "confirm_vehicle" });
check("flow: vehicle confirmed → step install", confirmStep.ok && confirmStep.state.step === "install" && confirmStep.state.sale?.vehicleConfirmed === true, JSON.stringify(confirmStep));

const installStep = await batteryAgentStepCore(DRIVER, { jobId: JOB, action: "install", installType: "standard" });
check("flow: standard install → quote step", installStep.ok && installStep.state.step === "quote", JSON.stringify(installStep));
check("flow: server-authoritative product price + owner formula", installStep.ok && installStep.state.sale?.batteryPriceCents === 14999 && installStep.state.sale?.totalCents === 21763, String(installStep.state.sale?.totalCents));

// HAND-OFF HARD GATE: charge before approval is refused. (Square env must be
// set BEFORE the gate check — otherwise loadSquareConfig throws and the test
// sees square_not_configured instead of the invalid_state gate.)
process.env.SQUARE_ACCESS_TOKEN = "test-square-token";
process.env.SQUARE_LOCATION_ID = "loc_test";
process.env.SQUARE_APPLICATION_ID = "app_test";
const chargeEarly = await chargeBatterySaleCore(DRIVER, { saleId: installStep.state.sale.id, token: "cnon:qa_nonce", attempt: 1 }, { fetchImpl: squareOk(), squareStableDir: "/tmp/battery-sq-missing" });
check("gate: charge refused before customer approval", !chargeEarly.ok && chargeEarly.code === "invalid_state", JSON.stringify(chargeEarly));

const approveStep = await batteryAgentStepCore(DRIVER, { jobId: JOB, action: "approve" });
check("flow: approve → handoff (hard gate)", approveStep.ok && approveStep.state.step === "handoff", JSON.stringify(approveStep));

// charge with REAL env square config (token read from env, mocked /v2/payments)
const paid = await chargeBatterySaleCore(DRIVER, { saleId: installStep.state.sale.id, token: "cnon:qa_battery_nonce", attempt: 1 }, { fetchImpl: squareOk() });
check("flow: charge ok → step paid", paid.ok && paid.state.step === "paid", JSON.stringify(paid));
// SQUARE KEY LENGTH REPAIR (2026-08-13): the battery charge must send the
// HASHED idempotency key (≤45 chars) — the raw `battery-<uuid>-<attempt>` was
// 46–47 chars and Square rejects it with HTTP 400 VALUE_TOO_LONG (the same
// incident that broke every club charge). Deterministic per (sale, attempt):
// the replayed attempt carries the SAME key → no double charge.
{
  const saleId = installStep.state.sale.id;
  const charge = squareCalls.find((c) => c.body?.idempotency_key === squareIdempotencyKey("battery-", saleId, 1));
  check("key: battery charge sent the HASHED idempotency key (≤45 chars)", charge != null && charge.body.idempotency_key.length <= 45, charge ? charge.body.idempotency_key : "no charge body captured");
  check("key: raw legacy `battery-<uuid>-<attempt>` WOULD exceed 45 (the 400)", `battery-${saleId}-1`.length > 45, `battery-${saleId}-1`.length);
  check("key: re-computing the same (sale, attempt) yields the SAME key (retry replay-safe)", squareIdempotencyKey("battery-", saleId, 1) === squareIdempotencyKey("battery-", saleId, 1), "");
  check("key: attempt 2 yields a DIFFERENT key (confirmed-failure retry is a new logical attempt)", squareIdempotencyKey("battery-", saleId, 2) !== squareIdempotencyKey("battery-", saleId, 1), "");
}
check("flow: sale status paid + square id stored", paid.ok && paid.state.sale?.status === "paid" && paid.state.sale?.squareChargeId === "pay_test_battery", JSON.stringify(paid.state.sale));
check("flow: paid_at set", paid.ok && paid.state.sale?.paidAt != null, "no paid_at");
check("flow: install job created + linked", paid.ok && paid.state.sale?.installJobId != null && paid.state.installJob?.status === "offered", JSON.stringify(paid.state.installJob));

const installRows = await q`SELECT id, service_type, status, assigned_driver_towbook_id, note, raw_json FROM dispatch_jobs WHERE org_id=${ORG} AND service_type='battery_install'`;
check("flow: install job row exists (battery_install, same driver)", installRows.length === 1 && String(installRows[0].assigned_driver_towbook_id) === TB1, JSON.stringify(installRows));
check("flow: install job note carries vehicle + VIN", String(installRows[0].note).includes(VIN) && String(installRows[0].note).includes("HONDA"), String(installRows[0].note));
const rawInstall = installRows[0].raw_json && typeof installRows[0].raw_json === "object" ? installRows[0].raw_json : {};
check("flow: install job raw links the sale", String(rawInstall.batterySaleId ?? "") === String(installStep.state.sale.id), JSON.stringify(rawInstall));

// Idempotent replay: re-charging the same sale returns the SAME paid state without a new charge.
const replay = await chargeBatterySaleCore(DRIVER, { saleId: installStep.state.sale.id, token: "cnon:qa_battery_nonce", attempt: 2 }, { fetchImpl: squareOk() });
check("flow: replay of a paid sale is idempotent", replay.ok && replay.state.step === "paid", JSON.stringify(replay));

// Completion now passes the battery gate (fails later at the signature gate instead).
const gate3 = await completeJobCore(DRIVER, { jobId: JOB });
check("gate: after paid, battery gate passes (next gate is the signature gate)", !gate3.ok && gate3.code === "completion_capture_required", JSON.stringify(gate3));

/* ===================== 5) DECLINE PATH ===================== */
{
  const D2 = `qa-batt-d2-${randomUUID()}`;
  const TB2 = tb(D2);
  const JOB2 = `qa-batt-job2-${randomUUID().slice(0, 8)}`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${D2}, 'QA Driver 2', ${`${D2}@qa.local`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${D2}, 'contractor')`;
  await q`UPDATE users SET towbook_driver_id=${TB2} WHERE id=${D2}`;
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, assigned_driver_towbook_id, assigned_driver_name)
    VALUES(${JOB2}, ${ORG}, 'Decline Customer', '', 41.76, -72.67, 'Hartford', 'jump_start', 'arrived', NOW(), '', ${TB2}, 'QA Driver 2')`;
  const driver2 = { orgId: ORG, id: D2, role: "contractor", towbookDriverId: TB2 };
  await recordBatteryTestCore(driver2, { jobId: JOB2, result: "faulty" });
  const v = await batteryAgentStepCore(driver2, { jobId: JOB2, action: "vin", vin: VIN }, { fetchImpl: nhtsaOk() });
  check("decline: vin → vehicle step (awaiting confirm)", v.ok && v.state.step === "vehicle", JSON.stringify(v));
  await batteryAgentStepCore(driver2, { jobId: JOB2, action: "confirm_vehicle" });
  await batteryAgentStepCore(driver2, { jobId: JOB2, action: "install", installType: "advanced" });
  const declined = await batteryAgentStepCore(driver2, { jobId: JOB2, action: "decline" });
  check("decline: at quote → voided", declined.ok && declined.state.step === "voided" && declined.state.sale?.status === "voided", JSON.stringify(declined));
  // Decline at the hand-off (approved) works too — the customer can back out at payment.
  const v3 = await batteryAgentStepCore(driver2, { jobId: JOB2, action: "vin", vin: VIN }, { fetchImpl: nhtsaOk() }); // voided sale freed the slot
  await batteryAgentStepCore(driver2, { jobId: JOB2, action: "confirm_vehicle" });
  await batteryAgentStepCore(driver2, { jobId: JOB2, action: "install", installType: "advanced" });
  await batteryAgentStepCore(driver2, { jobId: JOB2, action: "approve" });
  const declinedAtHandoff = await batteryAgentStepCore(driver2, { jobId: JOB2, action: "decline" });
  check("decline: at handoff (approved) → voided", declinedAtHandoff.ok && declinedAtHandoff.state.sale?.status === "voided", JSON.stringify(declinedAtHandoff));
  // A voided sale frees the open slot — a new quote can start.
  const restart = await batteryAgentStepCore(driver2, { jobId: JOB2, action: "vin", vin: VIN }, { fetchImpl: nhtsaOk() });
  check("decline: voided sale frees the slot (new quote starts)", restart.ok && restart.state.sale != null && restart.state.step === "vehicle", JSON.stringify(restart));
  await q`DELETE FROM battery_sales WHERE org_id=${ORG} AND job_id=${JOB2}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG} AND id=${JOB2}`;
  await q`DELETE FROM status_events WHERE org_id=${ORG} AND job_id=${JOB2}`;
  await q`DELETE FROM audit_log WHERE org_id=${ORG} AND actor_user_id=${D2}`;
  await q`DELETE FROM organization_memberships WHERE user_id=${D2}`;
  await q`DELETE FROM users WHERE id=${D2}`;
}

/* ===================== 6) BATTERY-OK PATH + UNAUTHORIZED ===================== */
{
  const D3 = `qa-batt-d3-${randomUUID()}`;
  const TB3 = tb(D3);
  const JOB3 = `qa-batt-job3-${randomUUID().slice(0, 8)}`;
  const OTHER = `qa-batt-other-${randomUUID()}`;
  const TBOTH = tb(OTHER);
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${D3}, 'QA Driver 3', ${`${D3}@qa.local`}, 'x'), (${OTHER}, 'Other Driver', ${`${OTHER}@qa.local`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${D3}, 'contractor'), (${ORG}, ${OTHER}, 'contractor')`;
  await q`UPDATE users SET towbook_driver_id=${TB3} WHERE id=${D3}`;
  await q`UPDATE users SET towbook_driver_id=${TBOTH} WHERE id=${OTHER}`;
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, assigned_driver_towbook_id, assigned_driver_name)
    VALUES(${JOB3}, ${ORG}, 'OK Customer', '', 41.76, -72.67, 'Hartford', 'jump_start', 'arrived', NOW(), '', ${TB3}, 'QA Driver 3')`;
  const driver3 = { orgId: ORG, id: D3, role: "contractor", towbookDriverId: TB3 };
  const other = { orgId: ORG, id: OTHER, role: "contractor", towbookDriverId: TBOTH };
  const notAssigned = await recordBatteryTestCore(other, { jobId: JOB3, result: "faulty" });
  check("auth: non-assigned driver refused", !notAssigned.ok && notAssigned.code === "unauthorized", JSON.stringify(notAssigned));
  const okTest = await recordBatteryTestCore(driver3, { jobId: JOB3, result: "ok" });
  check("ok: battery OK → step ok (no sale)", okTest.ok && okTest.state.step === "ok" && okTest.state.sale === null, JSON.stringify(okTest));
  const gateOk = await completeJobCore(driver3, { jobId: JOB3 });
  check("ok: battery-OK job passes the battery gate (signature gate next)", !gateOk.ok && gateOk.code === "completion_capture_required", JSON.stringify(gateOk));

  // Manual fallback: driver can't read the VIN → make/model/year entry. The
  // entry IS the confirmation (no separate confirm tap needed).
  const JOB4 = `qa-batt-job4-${randomUUID().slice(0, 8)}`;
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, assigned_driver_towbook_id, assigned_driver_name)
    VALUES(${JOB4}, ${ORG}, 'Manual Customer', '', 41.76, -72.67, 'Hartford', 'jump_start', 'arrived', NOW(), '', ${TB3}, 'QA Driver 3')`;
  await recordBatteryTestCore(driver3, { jobId: JOB4, result: "faulty" });
  const manual = await batteryAgentStepCore(driver3, { jobId: JOB4, action: "vehicle_manual", vin: "MANUAL", make: "Ford", model: "F-150", year: "2018" });
  check("manual: entry → step install (confirmed immediately)", manual.ok && manual.state.step === "install" && manual.state.sale?.vehicleManual === true && manual.state.sale?.vehicleConfirmed === true, JSON.stringify(manual));
  const manualInstall = await batteryAgentStepCore(driver3, { jobId: JOB4, action: "install", installType: "standard" });
  check("manual: quote math on the manual vehicle (server-authoritative group-47 product 14999 + 4500 + tax 952 + admin 1312 = 21763)", manualInstall.ok && manualInstall.state.sale?.totalCents === 21763 && manualInstall.state.sale?.batteryPriceCents === 14999, String(manualInstall.state.sale?.totalCents));
  await q`DELETE FROM battery_sales WHERE org_id=${ORG} AND job_id=${JOB4}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG} AND id=${JOB4}`;
  await q`DELETE FROM status_events WHERE org_id=${ORG} AND job_id=${JOB4}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG} AND id=${JOB3}`;
  await q`DELETE FROM status_events WHERE org_id=${ORG} AND job_id=${JOB3}`;
  await q`DELETE FROM audit_log WHERE org_id=${ORG} AND actor_user_id IN (${D3}, ${OTHER})`;
  await q`DELETE FROM organization_memberships WHERE user_id IN (${D3}, ${OTHER})`;
  await q`DELETE FROM users WHERE id IN (${D3}, ${OTHER})`;
}

/* ===================== 7) STATE READ (assigned driver) ===================== */
{
  const r = await batteryAgentStateCore(DRIVER, { jobId: JOB });
  check("read: paid state re-reads as step paid", r.ok && r.state.step === "paid" && r.state.installJob?.id != null, JSON.stringify(r));
  const denied = await batteryAgentStateCore(DRIVER, { jobId: "nope-12345" });
  check("read: unknown job → not_found", !denied.ok && denied.code === "not_found", JSON.stringify(denied));
}

console.log(`battery-sales: ${checks.length} checks passed`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  process.env.SQUARE_ACCESS_TOKEN = sqEnv.t;
  process.env.SQUARE_LOCATION_ID = sqEnv.l;
  process.env.SQUARE_APPLICATION_ID = sqEnv.a;
  try { await cleanup(); } catch (e) { console.error("cleanup failed:", e instanceof Error ? e.message : e); }
}
