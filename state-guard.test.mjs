import assert from "node:assert/strict";
import { resolveStateFromAddress, parseStateFromAddress } from "./src/data/state-guard-core.ts";

const cases = [
  ["16 Lords Hwy Weston Connecticut 06001", "CT", "address"],
  ["16 Lords Hwy, Weston, CT 06901", "CT", "address"],
  ["16 Lords Hwy, WESTON, c.t. 06883", "CT", "address"],
  ["16 Lords Hwy Weston ZZ 00000", null, "unknown"],
  ["16 Lords Hwy Weston Texas 06883", "TX", "address"],
  ["16 Lords Hwy Weston 06883", "CT", "zip"],
];
for (const [address, state, source] of cases) {
  const result = resolveStateFromAddress(address);
  assert.equal(result.state, state, address);
  assert.equal(result.source, source, address);
  assert.equal(parseStateFromAddress(address), state, address);
}
assert.equal(resolveStateFromAddress("16 Lords Hwy Weston Connecticut 78626").mismatch, true);
console.log(`state-guard ${cases.length + 1}/${cases.length + 1} passed`);
