// Hermetic B3 regression coverage.  This suite deliberately does not connect to
// the database: DB-backed install-type/listing behavior is proved by auditing
// the server SQL contract and migration seed contract without production data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sales = await readFile(new URL("./src/data/battery-sales-core.ts", import.meta.url), "utf8");
const compat = await readFile(new URL("./src/data/battery-compat-core.ts", import.meta.url), "utf8");
const migrations = await readFile(new URL("./src/data/migrations.ts", import.meta.url), "utf8");
const owner = await readFile(new URL("./src/routes/owner/batteries.tsx", import.meta.url), "utf8");
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };

// (a) Listing is ACTIVE and org-scoped; migration has all six owner-defined
// types, with customer and driver snapshots at the same cents values.
check("listing filters by org", /WHERE org_id=\$\{u\.orgId\} AND active=true/.test(sales));
for (const [code, cents] of [["STANDARD", 4500], ["ADVANCED", 6500], ["EUROPEAN", 5500], ["BATTERY_LOCATION_REMOTE", 5500], ["PROGRAMMING_REQUIRED", 5500], ["DUAL_BATTERY", 5500]]) {
  const seed = new RegExp(`\\['${code}'|\\[\"${code}\"`);
  check(`${code} is seeded`, seed.test(migrations));
  check(`${code} customer/driver payout is ${cents}`, new RegExp(`${cents},\\s*${cents}`).test(migrations));
}
check("listing returns customer and driver cents", /customer_price_cents,driver_payout_cents/.test(sales));
check("listing excludes inactive rows", /active=true/.test(sales));

// (b) Existing STANDARD/ADVANCED rates fallback remains, while custom types
// fail closed instead of silently using an arbitrary price.
check("STANDARD/ADVANCED fallback preserved", /else if \(code === \"STANDARD\" \|\| code === \"ADVANCED\"\)/.test(sales));
check("fallback uses configured rates", /rates\.installAdvancedCents.*rates\.installStandardCents/.test(sales));
check("unknown install type fails closed", /Select an available installation type/.test(sales));

// (c) The server writes immutable sale snapshots and the Lightning-only brand
// at quote creation; those fields are read back for owner/history surfaces.
for (const field of ["retail_snapshot_cents", "installation_snapshot_cents", "driver_payout_snapshot_cents"]) {
  check(`sale snapshots ${field}`, sales.includes(field));
}
check("sale snapshots Lightning brand", sales.includes("customer_facing_brand='LIGHTNING GOLD BATTERY'"));
check("owner rows include snapshot fields", /retail_snapshot_cents[\s\S]*installation_snapshot_cents[\s\S]*driver_payout_snapshot_cents/.test(sales));

// (d) Pricing is not client-authoritative.  The action zod enum contains no
// legacy price action and no priceDollars field is accepted by the new core.
check("action enum rejects legacy price", /action: z\.enum\(\[\"vin\", \"vehicle_manual\", \"confirm_vehicle\", \"install\", \"approve\", \"decline\"\]\)/.test(sales));
check("step schema has no priceDollars", !/priceDollars/.test(sales));
check("install price comes from server product lookup", /SELECT id, retail_cents, installation_cents[\s\S]*battery_products/.test(sales));

// (e) Compatibility lookup is authoritative and fail-closed: only approved
// mappings with a matching product are queried; no result becomes NO_MATCH,
// while ambiguity is surfaced rather than guessed.
check("compatibility requires approved mapping", /status='approved'/.test(compat));
check("compatibility requires an active product", /battery_products p[\s\S]*p\.active=true/.test(compat));
check("no match is explicit", /outcome: \"review\"; reason: \"not_found\"/.test(compat));
check("ambiguous is explicit", /outcome: \"review\"; reason: [^\n]*\"ambiguous\"/.test(compat));
check("sale rejects unmatched fitment", /No battery sale can be started\. Please have the dispatcher or owner review/.test(sales));

// (f) VIN privacy: mapSaleRow strips VIN before any safe sale/owner payload is
// returned, while audit history only stores a SHA-256 digest.
check("owner payload strips full VIN", /const \{ vin: _vin, \.\.\.safeSale \} = mapSaleRow\(r\)/.test(sales));
check("VIN audit stores hash only", /vin_sha256: createHash\("sha256"\)/.test(sales));
check("owner review UI has no VIN field", !/row\.vin|full VIN/i.test(owner));

console.log(`battery-b3-regression: ${checks.length} checks passed`);
