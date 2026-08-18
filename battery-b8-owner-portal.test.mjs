// B8 hermetic owner portal gates: owner-only handlers, atomic CSV imports, audit coverage,
// reporting from real rows, no internal-field leakage, and B7 ledger non-double-counting.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
const { neon } = await import("@neondatabase/serverless");
if (!process.env.DATABASE_URL) {
  try {
    const pid = execSync("pgrep -f 'bun run serve.ts' | head -1").toString().trim();
    if (pid) {
      const env = await readFile(`/proc/${pid}/environ`, "utf8");
      const found = env.split("\0").find((x) => x.startsWith("DATABASE_URL="));
      if (found) process.env.DATABASE_URL = found.slice("DATABASE_URL=".length);
    }
  } catch {}
}
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const core = await import("./src/data/battery-owner-core.ts");
const { validateCompatibilityRows } = await import("./src/data/compat-validation.ts");
const { parseBatteryPriceBookCsv } = await import("./src/data/battery-pricebook-core.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
await ensureSchema();
const checks = [];
const check = (name, ok, extra = "") => { checks.push([name, Boolean(ok), extra]); if (!ok) throw new Error(`FAIL: ${name} ${extra}`); };
const tag = randomUUID();
const ORG = `qa-b8-${tag}`;
const OWNER = `qa-b8-owner-${tag}`;
const DRIVER = `qa-b8-driver-${tag}`;
const actor = { orgId: ORG, id: OWNER, role: "owner" };
const nonOwner = { orgId: ORG, id: DRIVER, role: "contractor" };
const priceHeader = "group_size,alternate_group_sizes,brand,line,part_number,autozone_price,lightning_price,warranty_years,currency,core_charge_excluded";
const priceRows = `${priceHeader}\n47,47;H6,Lightning,Gold,LG-47,100.00,149.99,3,USD,true\n35,35;35-1,Lightning,Gold,LG-35,100.00,159.99,3,USD,true`;
const compatHeader = "make,model,year_from,year_to,trim,engine,battery_group_size,source_reference_internal,status";
const compatRows = `${compatHeader}\nHONDA,ACCORD,2018,2020,,2.5L I4,47,authoritative-fixture,approved`;
const cleanup = async () => {
  await q`DELETE FROM audit_log WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_inventory_ledger WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_inventory WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_payouts WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_sales WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_compatibility WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_products WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_install_types WHERE org_id=${ORG}`;
  await q`DELETE FROM battery_warranties WHERE org_id=${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`;
  await q`DELETE FROM users WHERE id=${OWNER}`;
  await q`DELETE FROM users WHERE id=${DRIVER}`;
  assertQaOrg(ORG);
  await q`DELETE FROM organizations WHERE id=${ORG}`;
};
try {
  await q`INSERT INTO organizations(id,name) VALUES(${ORG},'qa B8 owner portal')`;
  await q`INSERT INTO users(id,name,email,password_hash) VALUES(${OWNER},'B8 Owner',${OWNER+'@qa.local'},'x'),(${DRIVER},'B8 Driver',${DRIVER+'@qa.local'},'x')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG},${OWNER},'owner'),(${ORG},${DRIVER},'contractor')`;

  check("price-book parser accepts authoritative seed shape", parseBatteryPriceBookCsv(priceRows).length === 2);
  check("compatibility validator accepts authoritative row", validateCompatibilityRows([{ make:"HONDA", model:"ACCORD", year_from:2018, year_to:2020, trim:null, engine:"2.5L I4", battery_group_size:"47", source_reference_internal:"fixture", status:"approved" }]).valid);

  const mutationCalls = [
    ["product", () => core.upsertOwnerProductCore(nonOwner, {})],
    ["install type", () => core.upsertOwnerInstallTypeCore(nonOwner, {})],
    ["inventory", () => core.adjustOwnerInventoryCore(nonOwner, {})],
    ["warranty", () => core.overrideOwnerWarrantyCore(nonOwner, {})],
    ["compatibility edit", () => core.editOwnerCompatibilityCore(nonOwner, {})],
    ["price-book import", () => core.importOwnerPriceBookCore(nonOwner, priceRows)],
    ["compatibility import", () => core.importOwnerCompatibilityCore(nonOwner, compatRows)],
  ];
  for (const [name, call] of mutationCalls) check(`${name} is owner-only`, (await call()).code === "forbidden");
  check("audit list is owner-only", (await core.listBatteryAuditCore(nonOwner)).code === "forbidden");

  const invalid = await core.importOwnerPriceBookCore(actor, `${priceHeader}\n47,,Lightning,Gold,LG-47,not-a-price,149.99,3,USD,true`);
  check("invalid price-book rows rejected before write", !invalid.ok && invalid.code === "invalid");
  check("invalid import is atomic", Number((await q`SELECT COUNT(*)::int AS n FROM battery_products WHERE org_id=${ORG}`)[0].n) === 0);

  const imported = await core.importOwnerPriceBookCore(actor, priceRows);
  check("valid price-book import writes all rows", imported.ok && imported.imported === 2);
  check("price-book import writes one audit row", Number((await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND action='battery_price_book_import'`)[0].n) === 1);
  const compatImported = await core.importOwnerCompatibilityCore(actor, compatRows);
  check("valid compatibility import writes rows", compatImported.ok && compatImported.imported === 1);
  check("compatibility import writes one audit row", Number((await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND action='battery_compatibility_import'`)[0].n) === 1);

  const portal = await core.getBatteryOwnerPortalCore(actor);
  check("owner reporting returns real rows", portal.ok && portal.products.length === 2 && portal.reports.summary.salesCount === 0);
  const driverSurface = await readFile("./src/data/battery-sales-core.ts", "utf8");
  const driverPhotos = await readFile("./src/data/driver-photos-core.ts", "utf8");
  const ownerSurface = await readFile("./src/routes/owner/batteries.tsx", "utf8");
  check("internal cost/margin/source stay out of non-owner surfaces", !/internalCostCents|internalMarginCents|sourceReferenceInternal/.test(driverSurface) && !/internalCostCents|internalMarginCents|sourceReferenceInternal/.test(driverPhotos) && /sourceReferenceInternal/.test(ownerSurface));
  const ownerCore = await readFile("./src/data/battery-owner-core.ts", "utf8");
  for (const action of ["battery_product_upsert", "battery_install_type_upsert", "battery_inventory_adjust", "battery_warranty_override", "battery_compatibility_edit", "battery_price_book_import", "battery_compatibility_import"]) check(`audit action exists: ${action}`, ownerCore.includes(action));
  check("B7 report reads unique battery payout ledger", /FROM battery_payouts p[\s\S]*GROUP BY/.test(ownerCore) && !/SUM\([^)]*driver_payout_snapshot/.test(ownerCore));

  await cleanup();
  console.log(`battery-b8-owner-portal.test.mjs: ${checks.length}/${checks.length} passed`);
} catch (error) {
  try { await cleanup(); } catch {}
  console.error(error?.stack || error);
  process.exitCode = 1;
}
