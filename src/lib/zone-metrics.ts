import { pointInZone } from "./zone-containment";

export type ZoneMetricZone = {
  id: string | number;
  tz: string;
  lat: number;
  lng: number;
  radius_miles: number;
  polygon_geojson?: unknown;
  zip_codes?: unknown;
};
export type ZoneMetricJob = { status?: unknown; lat?: unknown; lng?: unknown; pickup_lat?: unknown; pickup_lng?: unknown; zip?: unknown; pickup_zip?: unknown };
export type ZoneMetricAvailability = { zone_id?: unknown; user_id?: unknown; day?: unknown };
export type ZoneMetrics = { busyness: string; availableDrivers: number; activeJobs: number; unassignedJobs: number; recentVolume24h: number; demandRatio: number; assignedDriverCount: number };

/** Pure demand/busyness aggregation. Polygon membership is authoritative when valid. */
export function aggregateZoneMetrics(
  zones: ZoneMetricZone[],
  availability: ZoneMetricAvailability[],
  jobs: ZoneMetricJob[],
  dayForZone: (zone: ZoneMetricZone) => string,
): Map<string, ZoneMetrics> {
  const out = new Map<string, ZoneMetrics>();
  for (const zone of zones) {
    const zid = String(zone.id);
    const day = dayForZone(zone);
    const users = new Set(availability
      .filter(row => String(row.zone_id) === zid && String(row.day) === day)
      .map(row => String(row.user_id)));
    const inJobs = jobs.filter(job => {
      const lat = Number(job.pickup_lat ?? job.lat);
      const lng = Number(job.pickup_lng ?? job.lng);
      return Number.isFinite(lat) && Number.isFinite(lng) && pointInZone(zone, lat, lng, String(job.pickup_zip ?? job.zip ?? "") || undefined);
    });
    const activeJobs = inJobs.filter(job => ["offered", "assigned", "in_progress"].includes(String(job.status))).length;
    const unassignedJobs = inJobs.filter(job => String(job.status) === "new").length;
    const availableDrivers = users.size;
    const demand = activeJobs + unassignedJobs;
    const demandRatio = demand / Math.max(availableDrivers, 1);
    const busyness = availableDrivers === 0 && demand > 0 ? "Busy" : demandRatio >= 2 ? "Busy" : demandRatio >= 1 ? "Moderate" : "Low";
    out.set(zid, { busyness, availableDrivers, activeJobs, unassignedJobs, recentVolume24h: inJobs.length, demandRatio: Number(demandRatio.toFixed(1)), assignedDriverCount: users.size });
  }
  return out;
}
