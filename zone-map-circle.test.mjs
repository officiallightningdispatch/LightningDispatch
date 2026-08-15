import assert from 'node:assert/strict';
import { zoneCirclePolygon } from './src/lib/zone-circle.ts';

const lat = 41.18;
const lng = -73.19;
const radiusMiles = 10;
const ring = zoneCirclePolygon(lat, lng, radiusMiles).coordinates[0];

assert.deepEqual(ring[0], ring.at(-1), 'circle polygon ring must be closed');
assert.ok(ring.length >= 48, `expected at least 48 vertices, got ${ring.length}`);

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const haversineMiles = (a, b) => {
  const earthRadiusMiles = 3958.7613;
  const dLat = toRadians(b[1] - a[1]);
  const dLng = toRadians(b[0] - a[0]);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat ** 2 + Math.cos(toRadians(a[1])) * Math.cos(toRadians(b[1])) * sinLng ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(h));
};

for (const vertex of ring.slice(0, -1)) {
  const distance = haversineMiles([lng, lat], vertex);
  assert.ok(Math.abs(distance - radiusMiles) / radiusMiles <= 0.05, `vertex is ${distance} miles from center`);
}

// Longitude spans more miles at the equator than at this latitude; the helper
// compensates by widening longitude degrees so the circle remains round.
const equator = zoneCirclePolygon(0, 0, radiusMiles).coordinates[0][0];
const local = ring[0];
assert.ok(Math.abs(local[0] - lng) > Math.abs(equator[0]), 'longitude degree span widens with latitude');

console.log('ok - zoneCirclePolygon closed, sufficiently sampled, and radius-stable');
