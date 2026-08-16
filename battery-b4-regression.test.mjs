// Hermetic B4 Lightning Battery Price Book coverage; no database or production data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { parseBatteryPriceBookCsv, INTERNAL_FIELDS } = await import("./src/data/battery-pricebook-core.ts");
const csv = await readFile("/home/team/shared/lightning-battery-price-book.csv", "utf8");
const checks=[]; const check=(name, condition)=>{assert.ok(condition,name);checks.push(name)};
const rows=parseBatteryPriceBookCsv(csv);
check("authoritative CSV has 24 rows", rows.length===24);
const h5=rows.find(x=>x.groupSize==="47");
check("lightning_price maps to retail cents", h5?.retailCents===21399);
check("autozone_price maps to internal cost cents", h5?.internalCostCents===21499);
check("aliases split into alternate groups", h5?.aliases.length===1&&h5.aliases[0]==="H5");
check("owner-add groups are not invented", !rows.some(x=>x.groupSize==="25"||x.groupSize==="31"));
for (const [name,bad] of [["bad header",csv.replace("group_size,","wrong," )],["bad price",csv.replace("213.99","oops")],["bad currency",csv.replace(",USD,true",",CAD,true")]]) {
  let rejected=false; try { parseBatteryPriceBookCsv(bad) } catch { rejected=true }
  check(`${name} rejected`, rejected);
}
const core=await readFile(new URL("./src/data/battery-pricebook-core.ts",import.meta.url),"utf8");
const safeSource=core.match(/const safe=.*?\n/)[0];
check("customer DTO excludes internal fields", INTERNAL_FIELDS.every(k=>!safeSource.includes(k)) && safeSource.includes("displayName:\"LIGHTNING GOLD BATTERY\""));
check("alias resolution keeps active and availability guard", /alternate_group_sizes @>/.test(core) && /active=true/.test(core));
check("import and edit audit actions exist", core.includes("battery_price_book_import")&&core.includes("battery_product_upsert"));
console.log(`battery-b4-regression: ${checks.length} checks passed`);
