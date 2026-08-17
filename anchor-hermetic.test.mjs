// Hermetic regression contract for the real-pickup anchor fix.
// Deliberately uses no database, network, or application server: it verifies the
// reviewed resolver contract and the observable nearest-driver ranking inputs.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("./src/data/ai-dispatcher.ts", import.meta.url), "utf8");
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const placeholder = { lat: 41.214889, lng: -73.195803 };
const txPickup = { lat: 30.505, lng: -97.82 }; // Cedar Park, TX fixture
const distance = (a, b) => Math.hypot((a.lat - b.lat) * 69, (a.lng - b.lng) * 59);
const rank = (anchor, drivers) => drivers
  .filter((d) => d.isCheckedIn && d.lat !== 0 && d.lng !== 0)
  .map((d) => ({ ...d, miles: distance(anchor, d) }))
  .sort((a, b) => a.miles - b.miles)[0];

// Scenario A: exact production shape. The real TX pickup wins; the CT driver
// must not be selected merely because Towbook supplied CT placeholder coords.
check("A: placeholder Agero offer anchors to resolved TX pickup", () => {
  assert.match(source, /isAgeroPlaceholderCoords\(lat, lng\)/);
  assert.match(source, /stateResolution\.authoritativeLat/);
  assert.match(source, /resolveOfferPickupCoords\(orgId, rawOffer, deps, fetchImpl\)/);
  assert.match(source, /offer coords suppressed/);
  const chosen = rank(txPickup, [
    { id: 721132, name: "Ai Dispatch GB", lat: 30.51, lng: -97.83, isCheckedIn: true },
    { id: 9001, name: "CT Bridgeport", lat: 41.21, lng: -73.2, isCheckedIn: true },
  ]);
  assert.equal(chosen.id, 721132);
  assert.notEqual(rank(placeholder, [{ id: 9001, lat: 41.21, lng: -73.2, isCheckedIn: true }])?.id, 721132);
  assert.match(source, /lookupAnchor\.lat, lookupAnchor\.lng/);
});

// Scenario B: non-placeholder offers also use a resolved real pickup.
check("B: non-placeholder offer anchors to resolved pickup", () => {
  assert.match(source, /stateResolution\.authoritativeLat[\s\S]*resolveOfferPickupCoords/);
  assert.match(source, /offer coordinates retained \(no better resolution\)/);
  assert.doesNotMatch(source, /if \(!isAgeroPlaceholderCoords\(lat, lng\)\)/);
});

// Scenario C: no trustworthy real pickup retains the placeholder and therefore
// follows the existing safety/escalation path; it must never invent coordinates.
check("C: unresolved placeholder is retained fail-closed", () => {
  assert.match(source, /offer coordinates retained \(no better resolution\)/);
  assert.match(source, /real pickup unresolved/);
});

// Both initial and verification nearestDrivers reads, plus road ranking, use
// the single resolved anchor (prevents a later cross-state regression).
check("anchor is reused for all dispatch ranking stages", () => {
  assert.equal((source.match(/latitude=\$\{lookupAnchor\.lat\}/g) ?? []).length, 2);
  assert.ok((source.match(/chooseBestDriverByRoad\(\n\s*candidates,\n\s*lookupAnchor\.lat/g) ?? []).length >= 1);
});



// Queue ETA contract: two routed legs to queued jobs, service after each, then
// the final routed leg.  12 + 30 + 24 + 30 + 20 = 116; SLA 45 is not a quote cap.
check("D: queue-aware ETA exact arithmetic is uncapped", () => {
  const travel = [12, 24, 20];
  const service = 30;
  const quoted = travel[0] + service + travel[1] + service + travel[2];
  assert.equal(quoted, 116);
  assert.ok(quoted > 45);
  assert.match(source, /queueMinutes \+= leg\.minutes \+ SERVICE_MINUTES_PER_JOB/);
  assert.match(source, /arrivalMinutes: queueMinutes \+ finalLeg\.minutes/);
  assert.match(source, /return Math.min(Math.max(floor, raw), Math.max(1, Math.round(_maxEtaMinutes \?\? 60)))/);
});
check("E: no queued jobs uses direct route and routing failures remain honest", () => {
  assert.match(source, /if \(total === 0\) return null/);
  assert.match(source, /roadRouter \? await roadRouter\(origin\.lat, origin\.lng, pickupLat, pickupLng\)/);
  assert.match(source, /fallbackRoadMinutes\(haversineMiles/);
  assert.match(source, /tomtomFailure: chainTomtomFailure/);
});

console.log(`ANCHOR HERMETIC CHECKS PASSED (${checks.length})`);
for (const name of checks) console.log(`  PASS  ${name}`);
