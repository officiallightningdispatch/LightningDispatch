// Hermetic tests for jumpstart battery-group AUTO-SELECT (owner 2026-09-03).
// When a jumpstart job already carries a VIN in raw_json.assets[0].vin and the
// battery test is faulty, the state-read path pre-resolves the group via the
// authoritative VIN → NHTSA decode → compatibility match and auto-creates the
// sale (vehicle_confirmed=true), landing on the install step — skipping VIN entry
// and the vehicle-confirm tap. Fail-closed: no VIN, decode failure, or no
// authoritative match leaves NO sale row and falls through to the VIN step.
// DATABASE_URL=... bun battery-vin-autoselect.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { batteryAgentStateCore } = await import("./src/data/battery-sales-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
await ensureSchema();

const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };

const ORG = `qa-vinauto-${randomUUID()}`;
const D1 = `qa-vinauto-d1-${randomUUID()}`;
const tb = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 900_000_000n);
const TB1 = tb(D1);
const DRIVER = { orgId: ORG, id: D1, role: "contractor", towbookDriverId: TB1 };

const VIN_OK = "1HGCM82633A004352";     // decodes to 2019 HONDA Accord (has approved fitment)
const VIN_NOMATCH = "5YFBURHE8KP900000"; // decodes to 2019 TOYOTA Camry (no fitment row)

const VEHICLES = {
  [VIN_OK]: { Make: "HONDA", Model: "Accord", ModelYear: "2019", EngineModel: "2.5L I4", ErrorCode: "0" },
  [VIN_NOMATCH]: { Make: "TOYOTA", Model: "Camry", ModelYear: "2019", EngineModel: "2.5L I4", ErrorCode: "0" },
};
const vinFromUrl = (url) => { const m = String(url).match(/DecodeVinValues\/([^?]+)/); return m ? decodeURIComponent(m[1]) : ""; };
const nhtsaFor = (vehicles = VEHICLES) => {
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(String(url));
    const vin = vinFromUrl(url);
    const veh = vehicles[vin] ?? { Make: "", Model: "", ModelYear: "", ErrorCode: "11" };
    return Promise.resolve(new Response(JSON.stringify({ Results: [veh] }), { status: 200, headers: { "content-type": "application/json" } }));
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

const cleanup = async () => {
  await q`DELETE FROM battery_sales WHERE org_id = ${ORG}`;
  await q`DELETE FROM battery_compatibility WHERE org_id = ${ORG}`;
  await q`DELETE FROM battery_products WHERE org_id = ${ORG}`;
  await q`DELETE FROM audit_log WHERE org_id = ${ORG} OR actor_user_id = ${D1}`;
  await q`DELETE FROM status_events WHERE org_id = ${ORG}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id = ${ORG}`;
  await q`DELETE FROM org_settings WHERE org_id = ${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id = ${ORG}`;
  await q`DELETE FROM users WHERE id = ${D1}`;
  assertQaOrg(ORG);
  await q`DELETE FROM organizations WHERE id = ${ORG}`;
};

const newJob = async (suffix, rawJson) => {
  const id = `qa-vinauto-job-${suffix}-${randomUUID().slice(0, 6)}`;
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, customer_phone, vehicle_desc, pickup, assigned_driver_towbook_id, assigned_driver_name, raw_json, battery_test_result)
    VALUES(${id}, ${ORG}, 'Auto Customer', '', 41.76, -72.67, 'Hartford', 'jump_start', 'arrived', NOW(), '', NULL, '', '2019 HONDA ACCORD', '1 Main St', ${TB1}, 'QA Driver', ${rawJson === null ? null : JSON.stringify(rawJson)}::jsonb, 'faulty')`;
  return id;
};

try {
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa vin auto')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${D1}, 'QA Driver', ${`${D1}@qa.local`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${D1}, 'contractor')`;
  await q`UPDATE users SET towbook_driver_id=${TB1} WHERE id=${D1}`;
  await q`INSERT INTO battery_products(id, org_id, group_size, display_name, retail_cents, installation_cents, warranty_years, free_replacement_years, core_charge_cents, availability, active) VALUES(gen_random_uuid()::text, ${ORG}, '47', 'LIGHTNING GOLD BATTERY', 14999, 4500, 3, 3, 0, 'in_stock', true)`;
  await q`INSERT INTO battery_compatibility(id, org_id, make, model, year_from, year_to, trim, engine, battery_group_size, status, source_reference_internal) VALUES(gen_random_uuid()::text, ${ORG}, 'HONDA', 'ACCORD', 2018, 2020, null, '2.5L I4', '47', 'approved', 'qa-vin-auto-fitment')`;

  /* (a) VIN present + matched → auto-created sale, lands on install with group */
  {
    const jobId = await newJob("a", { assets: [{ vin: VIN_OK, year: "2019", make: "HONDA", model: "ACCORD" }] });
    const fetchImpl = nhtsaFor();
    const r = await batteryAgentStateCore(DRIVER, { jobId }, { fetchImpl });
    check("a: auto-resolve lands on install", r.ok && r.state.step === "install", JSON.stringify(r));
    check("a: group populated from match", r.ok && r.state.sale?.batteryGroupSize === "47", JSON.stringify(r.state.sale));
    check("a: vehicle auto-confirmed (not manual)", r.ok && r.state.sale?.vehicleConfirmed === true && r.state.sale?.vehicleManual === false, JSON.stringify(r.state.sale));
    check("a: sale row persisted", r.ok && r.state.sale != null, "no sale");
    check("a: NHTSA fired exactly once", fetchImpl.calls.length === 1, `calls=${fetchImpl.calls.length}`);
    const rows = await q`SELECT vin, vehicle_confirmed, compatibility_id, battery_group_size, status FROM battery_sales WHERE org_id=${ORG} AND job_id=${jobId}`;
    check("a: row carries the job VIN (uppercased)", rows.length === 1 && rows[0].vin === VIN_OK, JSON.stringify(rows));
    check("a: row status quote", rows.length === 1 && rows[0].status === "quote", JSON.stringify(rows));
    await q`DELETE FROM battery_sales WHERE org_id=${ORG} AND job_id=${jobId}`;
    await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG} AND id=${jobId}`;
  }

  /* (b) VIN present + no authoritative match → no sale row, stays at vin */
  {
    const jobId = await newJob("b", { assets: [{ vin: VIN_NOMATCH, year: "2019", make: "TOYOTA", model: "CAMRY" }] });
    const r = await batteryAgentStateCore(DRIVER, { jobId }, { fetchImpl: nhtsaFor() });
    check("b: no match falls through to vin step", r.ok && r.state.step === "vin", JSON.stringify(r));
    const rows = await q`SELECT id FROM battery_sales WHERE org_id=${ORG} AND job_id=${jobId}`;
    check("b: no sale row created", rows.length === 0, `rows=${rows.length}`);
    await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG} AND id=${jobId}`;
  }

  /* (c) no VIN → unchanged (vin step, no sale, NHTSA never fired) */
  {
    const jobId = await newJob("c", { assets: [{ year: "2019", make: "HONDA", model: "ACCORD" }] });
    const fetchImpl = nhtsaFor();
    const r = await batteryAgentStateCore(DRIVER, { jobId }, { fetchImpl });
    check("c: no VIN → vin step", r.ok && r.state.step === "vin", JSON.stringify(r));
    check("c: NHTSA never fired without a VIN", fetchImpl.calls.length === 0, `calls=${fetchImpl.calls.length}`);
    const rows = await q`SELECT id FROM battery_sales WHERE org_id=${ORG} AND job_id=${jobId}`;
    check("c: no sale row created", rows.length === 0, `rows=${rows.length}`);
    await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG} AND id=${jobId}`;
  }

  /* (d) existing sale row → resolve NOT re-run (fetch never called) */
  {
    const jobId = await newJob("d", { assets: [{ vin: VIN_OK, year: "2019", make: "HONDA", model: "ACCORD" }] });
    const compat = await q`SELECT id FROM battery_compatibility WHERE org_id=${ORG} AND make='HONDA' AND status='approved' LIMIT 1`;
    const compatId = String(compat[0].id);
    // Pre-existing sale row (as the vin action would have created it, already confirmed).
    await q`INSERT INTO battery_sales(id, org_id, job_id, contractor_user_id, vin, vehicle_make, vehicle_model, vehicle_year, vehicle_manual, vehicle_confirmed, compatibility_id, battery_group_size, product_id, install_type_id, battery_price_cents, install_type, install_fee_cents, sales_tax_cents, admin_fee_cents, total_cents, currency, status)
      VALUES(gen_random_uuid()::text, ${ORG}, ${jobId}, ${D1}, ${VIN_OK}, 'HONDA', 'Accord', '2019', false, true, ${compatId}, '47', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'USD', 'quote')`;
    const fetchImpl = nhtsaFor();
    const r = await batteryAgentStateCore(DRIVER, { jobId }, { fetchImpl });
    check("d: existing sale keeps its group", r.ok && r.state.sale?.batteryGroupSize === "47", JSON.stringify(r.state.sale));
    check("d: resolve NOT re-run (NHTSA zero calls)", fetchImpl.calls.length === 0, `calls=${fetchImpl.calls.length}`);
    await q`DELETE FROM battery_sales WHERE org_id=${ORG} AND job_id=${jobId}`;
    await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG} AND id=${jobId}`;
  }

  console.log(`battery-vin-autoselect: ${checks.length} checks passed`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (e) { console.error("cleanup failed:", e instanceof Error ? e.message : e); }
}
