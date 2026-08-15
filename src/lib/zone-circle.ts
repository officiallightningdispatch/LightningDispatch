type Point = [number, number];

/** Build a closed GeoJSON circle ring from a zone's center and radius. */
export function zoneCirclePolygon(
  lat: number,
  lng: number,
  radiusMiles: number,
): { type: 'Polygon'; coordinates: [Point[]] } {
  const vertices = 64;
  const safeRadius = Math.max(0, Number(radiusMiles) || 0);
  const latRad = (lat * Math.PI) / 180;
  const dLat = safeRadius / 69;
  const dLng = safeRadius / (69 * Math.max(Math.abs(Math.cos(latRad)), 0.01));
  const ring: Point[] = [];
  for (let i = 0; i < vertices; i += 1) {
    const angle = (i / vertices) * Math.PI * 2;
    ring.push([lng + dLng * Math.cos(angle), lat + dLat * Math.sin(angle)]);
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}
