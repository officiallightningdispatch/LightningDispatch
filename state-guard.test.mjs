import assert from "node:assert/strict";
import { resolveStateFromAddress, parseStateFromAddress, isAgeroPlaceholderCoords } from "./src/data/state-guard-core.ts";

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
// Regression: "Co Rd" / "County Road" must NOT resolve "CO" (Colorado).
const countyRoadCases = [
  "4251 Co Rd 132, Hutto, TX 78634, USA",
  "1000 County Rd 200, Georgetown, TX 78626",
  "Co Rd 5, Hutto, TX 78634",
  "County Road 132, Hutto, TX 78634",
];
for (const address of countyRoadCases) {
  const result = resolveStateFromAddress(address);
  assert.equal(result.state, "TX", address);
  assert.equal(result.source, "address", address);
  assert.equal(result.mismatch, false, address);
}
// Real Colorado addresses still resolve CO.
assert.deepEqual(resolveStateFromAddress("Denver, CO 80202"), { state: "CO", source: "address", mismatch: false });
// Punctuation-separated postal form still resolves CT.
assert.deepEqual(resolveStateFromAddress("Bridgeport, C.T."), { state: "CT", source: "address", mismatch: false });
const placeholderCases = [
  [41.214889, -73.195803, true],
  [41.289999999, -73.070000001, true],
  [41.050000001, -73.309999999, true],
  [30.61948, -97.648242, false],
  [Number.NaN, Number.NaN, false],
  [0, 0, false],
];
for (const [lat, lng, expected] of placeholderCases) assert.equal(isAgeroPlaceholderCoords(lat, lng), expected, `${lat},${lng}`);
const total = cases.length + 1 + countyRoadCases.length + 2 + placeholderCases.length;
console.log(`state-guard ${total}/${total} passed`);
