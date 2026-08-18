// Regression contract for the driver-facing status map. This stays hermetic:
// the map is a client-side constant and the real-data verification is a
// separate read-only production query documented in the gate log.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./src/components/driver-queue.tsx", import.meta.url), "utf8");
const auth = readFileSync(new URL("./src/data/driver-auth.ts", import.meta.url), "utf8");
const completed = source.match(/252:\s*\{\s*label:\s*"([^"]+)"[^}]*\}/);
assert.ok(completed, "Towbook completed acknowledgement (252) must have an explicit driver label");
assert.match(completed[1], /^Complete(?:d)?$/, "real completed jobs must render Complete/Completed");
assert.notEqual(completed[1].toLowerCase(), "cancelled");
assert.match(source, /5:\s*\{\s*label:\s*"Completed"/);
assert.match(source, /6:\s*\{\s*label:\s*"Complete"/);
assert.match(auth, /c\.statusId === 5 \|\| c\.statusId === 6 \|\| c\.statusId === 252/);
console.log("driver completed display regression: 2 passed");
