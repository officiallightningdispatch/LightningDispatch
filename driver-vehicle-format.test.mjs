// Hermetic test for the driver-facing vehicle-string formatter (2026-09-03).
// Owner order: color · year · make · model, VIN dropped, empty tokens omitted
// (never render dangling "· ·"). Pure unit test — no React, no DB.
//   bun driver-vehicle-format.test.mjs
import { formatDriverVehicle } from "./src/data/driver-auth.ts";

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

/* Full line: color · year · make · model */
check(
  "color+year+make+model",
  formatDriverVehicle("White", 2019, "Honda", "Accord") === "White 2019 Honda Accord",
  formatDriverVehicle("White", 2019, "Honda", "Accord"),
);

/* No color → starts at year, no leading separator */
check(
  "missing color omitted",
  formatDriverVehicle(null, 2019, "Honda", "Accord") === "2019 Honda Accord",
  formatDriverVehicle(null, 2019, "Honda", "Accord"),
);

/* Color only + partial rest */
check(
  "missing model omitted",
  formatDriverVehicle("White", 2019, "Honda", null) === "White 2019 Honda",
  formatDriverVehicle("White", 2019, "Honda", null),
);

/* Empty string tokens skipped (no double space) */
check(
  "empty string skipped",
  formatDriverVehicle("", 2019, "", "Accord") === "2019 Accord",
  formatDriverVehicle("", 2019, "", "Accord"),
);

/* Whitespace-only tokens trimmed/skipped */
check(
  "whitespace trimmed",
  formatDriverVehicle("  White  ", "2019", " Honda ", "Accord") === "White 2019 Honda Accord",
  formatDriverVehicle("  White  ", "2019", " Honda ", "Accord"),
);

/* All absent → empty string */
check(
  "all absent → empty string",
  formatDriverVehicle(null, null, null, null) === "",
  JSON.stringify(formatDriverVehicle(null, null, null, null)),
);

/* Numbers stringified (year as number) */
check(
  "numeric year stringified",
  formatDriverVehicle("Black", 2021, "Ford", "F-150") === "Black 2021 Ford F-150",
  formatDriverVehicle("Black", 2021, "Ford", "F-150"),
);

const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-vehicle-format.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n"));
  process.exit(1);
}
