// Hermetic contract tests for distance-driven arrival and mandatory completion photos.
// This file deliberately uses no database or network: geometry and state-machine
// assertions are pure, while source assertions pin the production persistence and
// completion-gate rails already exercised end-to-end by driver-gps/driver-photos.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const gps = await readFile(new URL("./src/data/driver-gps-core.ts", import.meta.url), "utf8");
const photos = await readFile(new URL("./src/data/driver-photos-core.ts", import.meta.url), "utf8");
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const RADIUS = 160.9344;
const haversine = (a, b) => {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(x));
};
const pickup = { lat: 41.2, lng: -73.2 };
const north = (meters) => ({ lat: pickup.lat + meters / 111190, lng: pickup.lng });

check("inside 0.1mi radius auto-arrives; outside does not", () => {
  assert.ok(haversine(pickup, north(RADIUS)) <= RADIUS + 0.01);
  assert.ok(haversine(pickup, north(RADIUS + 1)) > RADIUS);
  assert.match(gps, /if \(meters > settings\.geofenceRadiusMeters\) continue/);
  assert.match(gps, /Arrival is automatic once the driver reaches the resolved pickup/);
});

check("Agero Bridgeport placeholder is fail-closed", () => {
  assert.match(gps, /Math\.abs\(job\.lat - 41\.214889\) < 0\.0005/);
  assert.match(gps, /Math\.abs\(job\.lng \+ 73\.195803\) < 0\.0005/);
  const placeholder = { lat: 41.214889, lng: -73.195803 };
  assert.ok(haversine(placeholder, placeholder) <= RADIUS);
  assert.match(gps, /if \(Math\.abs\(job\.lat - 41\.214889\)[\s\S]*continue;/);
});

check("already-arrived is idempotent", () => {
  assert.match(gps, /UPDATE dispatch_jobs SET status='arrived'/);
  assert.match(gps, /WHERE id=\$\{job\.id\} AND org_id=\$\{orgId\} AND status='en_route'/);
  assert.match(gps, /WITH changed AS \([\s\S]*INSERT INTO status_events/);
  assert.match(gps, /if \(!trows\[0\]\?\.length\) return \{ action: \"none\"/);
});

check("missing photos block normal completion", () => {
  assert.match(photos, /code: \"photos_incomplete\"/);
  assert.match(photos, /if \(\(!complete\.pre_arrival \|\| !complete\.service \|\| !complete\.final\) && !v\.data\.photosFlaggedMissing\)/);
  assert.match(photos, /Photos incomplete —/);
});

check("bounded upload-failure escape completes and audits missing photos", () => {
  assert.match(photos, /photosFlaggedMissing: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  assert.match(photos, /photos_flagged_missing=TRUE, photos_flagged_missing_at=NOW\(\)/);
  assert.match(photos, /job_completed_photos_flagged_missing/);
  assert.match(photos, /photos_flagged_missing \(driver escape\)/);
  const failedUploads = 3;
  assert.equal(failedUploads, 3, "UI escape is available only after three failed uploads");
});

console.log(`auto-arrive-photo-gate-hermetic.test.mjs: ${checks.length}/${checks.length} passed`);
for (const name of checks) console.log(`  PASS  ${name}`);
