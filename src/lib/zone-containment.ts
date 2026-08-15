import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { haversineMiles } from "./dispatch-recommendation";

export type ZonePolygon = { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
type TurfFeature = { type: "Feature"; properties: Record<string, never>; geometry: ZonePolygon };
const feature = (geometry: ZonePolygon): TurfFeature => ({ type: "Feature", properties: {}, geometry });
export type ContainmentZone = { polygon_geojson?: unknown; zip_codes?: unknown; lat: number; lng: number; radius_miles: number; sort_order?: number; name?: string };

export function validateZonePolygon(value: unknown): ZonePolygon | null {
  if (value == null || value === "") return null;
  if (!value || typeof value !== "object") throw new Error("Polygon must be a GeoJSON Polygon or MultiPolygon.");
  const p = value as { type?: unknown; coordinates?: unknown };
  if (p.type !== "Polygon" && p.type !== "MultiPolygon") throw new Error("Polygon must be a GeoJSON Polygon or MultiPolygon.");
  if (!Array.isArray(p.coordinates) || !p.coordinates.length) throw new Error("Polygon must contain at least one ring.");
  const rings = p.type === "Polygon" ? p.coordinates : (p.coordinates as unknown[]).flat(1);
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error("Every polygon ring must contain at least 4 positions.");
    const first = ring[0], last = ring[ring.length - 1];
    if (!Array.isArray(first) || !Array.isArray(last) || first.length < 2 || last.length < 2 || first[0] !== last[0] || first[1] !== last[1]) throw new Error("Every polygon ring must be closed.");
    for (const pos of ring) if (!Array.isArray(pos) || pos.length < 2 || !Number.isFinite(Number(pos[0])) || !Number.isFinite(Number(pos[1]))) throw new Error("Polygon positions must be finite [longitude, latitude] coordinates.");
  }
  return value as ZonePolygon;
}

export function pointInZone(zone: ContainmentZone, lat: number, lng: number, zip?: string): boolean {
  const poly = zone.polygon_geojson;
  if (poly && typeof poly === "object" && ((poly as any).type === "Polygon" || (poly as any).type === "MultiPolygon")) {
    try { return booleanPointInPolygon({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lng, lat] } } as any, feature({type: (poly as any).type, coordinates: (poly as any).coordinates}) as any); } catch { return false; }
  }
  if (zip && Array.isArray(zone.zip_codes) && zone.zip_codes.map(String).includes(String(zip))) return true;
  return haversineMiles({ lat, lng }, { lat: Number(zone.lat), lng: Number(zone.lng) }) <= Number(zone.radius_miles);
}

export function zoneContainingPoint<T extends ContainmentZone>(zones: T[], lat: number, lng: number, zip?: string): T | null {
  return [...zones].sort((a,b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) || String(a.name ?? "").localeCompare(String(b.name ?? ""))).find(z => pointInZone(z, lat, lng, zip)) ?? null;
}
