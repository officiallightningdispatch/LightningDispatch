// Hermetic regression tests for the owner-ops job-card vehicle + call-number
// enrichment (2026-09-03). Pure unit test of the shared extraction helper —
// no React render, no DB.
//   bun job-vehicle.test.mjs
import { jobIdentityExtras } from "./src/lib/job-vehicle.ts";

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

/* (a) assets[0] year/make/model -> vehicle string (raw_json as object) */
{
  const e = jobIdentityExtras(
    { assets: [{ year: 2025, make: "Chevrolet", model: "Silverado" }], callNumber: 25512 },
    "2025 Chevrolet Silverado White",
  );
  check("assets[0] year/make/model joined with single space", e.vehicle === "2025 Chevrolet Silverado", JSON.stringify(e));
  check("vehicle wins over vehicle_desc fallback", e.vehicle === "2025 Chevrolet Silverado", e.vehicle);
  check("callNumber stringified", e.callNumber === "25512", e.callNumber);
}

/* (a2) empty components skipped */
{
  const e = jobIdentityExtras(
    { assets: [{ year: 2025, make: "", model: "Silverado" }] },
    undefined,
  );
  check("empty make skipped — no double space", e.vehicle === "2025 Silverado", JSON.stringify(e.vehicle));
}

/* (b) vehicle_desc fallback when assets[0] absent / no usable fields */
{
  const e = jobIdentityExtras({ callNumber: "25513" }, "2025 Chevrolet Silverado White");
  check("vehicle_desc fallback used", e.vehicle === "2025 Chevrolet Silverado White", e.vehicle);
  check("callNumber still extracted", e.callNumber === "25513", e.callNumber);
}

/* (b2) assets[0] present but no year/make/model -> fallback */
{
  const e = jobIdentityExtras({ assets: [{ vin: "1GCUDED8XKZ123456" }] }, "2019 Honda Accord");
  check("no usable asset fields -> vehicle_desc fallback", e.vehicle === "2019 Honda Accord", e.vehicle);
}

/* raw_json arriving as a JSON string */
{
  const e = jobIdentityExtras(
    JSON.stringify({ assets: [{ year: "2022", make: "Toyota", model: "Camry" }], callNumber: 999 }),
    undefined,
  );
  check("raw_json string parsed", e.vehicle === "2022 Toyota Camry", e.vehicle);
  check("raw_json string callNumber", e.callNumber === "999", e.callNumber);
}

/* malformed JSON never throws */
{
  let e;
  let threw = false;
  try {
    e = jobIdentityExtras("{not json", "Ford F-150");
  } catch {
    threw = true;
  }
  check("malformed raw_json does not throw", !threw, String(threw));
  check("malformed raw_json falls back to vehicle_desc", e && e.vehicle === "Ford F-150", JSON.stringify(e));
}

/* absent -> undefined (never "· ·") */
{
  const e = jobIdentityExtras(null, null);
  check("absent vehicle -> undefined", e.vehicle === undefined, JSON.stringify(e));
  check("absent callNumber -> undefined", e.callNumber === undefined, JSON.stringify(e));
}

/* whitespace-only vehicle_desc -> undefined */
{
  const e = jobIdentityExtras(null, "   ");
  check("whitespace vehicle_desc -> undefined", e.vehicle === undefined, JSON.stringify(e));
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`job-vehicle.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n"));
  process.exit(1);
}
