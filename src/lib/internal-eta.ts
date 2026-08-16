/**
 * Pure internal ETA planner. This module intentionally has no database, clock,
 * routing, or UI dependencies: production callers resolve a traffic-aware route
 * first and pass the measured legs here; tests can provide a deterministic matrix.
 */

export type EtaJobStatus = "accepted" | "en_route" | "in_progress" | "arrived" | string | number;

/** Towbook numeric lifecycle IDs are normalized before planning. */
export function normalizeEtaStatus(raw: EtaJobStatus): string {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (Number.isFinite(n)) return ({ 0: "new", 1: "offered", 2: "accepted", 3: "en_route", 4: "arrived", 5: "in_progress", 70: "accepted", 252: "completed", 255: "cancelled" } as Record<number, string>)[n] ?? "unknown";
  return String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
export type EtaPoint = { lat: number; lng: number };
export type RouteLeg = {
  durationSeconds: number;
  distanceMeters?: number;
  /** Provider metadata from the routing adapter; kept with the leg for ledger honesty. */
  provider?: "tomtom" | "osrm" | "factor";
  tomtomFailure?: string | null;
};
export type EtaJob = {
  id: string;
  status: EtaJobStatus;
  location: EtaPoint;
  serviceType?: string | null;
  serviceName?: string | null;
  batteryInstallType?: string | null;
};
export type EtaRoute = Record<string, RouteLeg | undefined>;
export type InternalEtaInput = {
  liveLocation: EtaPoint | null | undefined;
  jobs: EtaJob[];
  /** Keys are `${fromId}->${toId}`; the live origin is `live`. */
  routes: EtaRoute;
  /** Offer is preview-only and is never included in active sequencing. */
  offer?: EtaJob | null;
};
export type EtaBreakdown = {
  jobId: string;
  status: string;
  serviceType: string;
  serviceMinutes: number;
  unknownServiceType: boolean;
  travelMinutes: number;
  distanceMeters: number | null;
  arrivalOffsetMinutes: number;
  completionOffsetMinutes: number;
  routeFrom: string;
  /** Provider metadata for the route leg represented by this breakdown row. */
  provider?: RouteLeg["provider"];
  tomtomFailure?: string | null;
};
export type InternalEtaResult = {
  ok: true;
  orderedJobIds: string[];
  breakdown: EtaBreakdown[];
  totalMinutes: number;
  reviewRequired: boolean;
  preview: boolean;
} | {
  ok: false;
  reason: "missing_live_location" | "invalid_live_location" | "missing_route_leg";
  orderedJobIds: [];
  breakdown: [];
  totalMinutes: null;
  reviewRequired: true;
  preview: boolean;
};

const SERVICE_MINUTES: Record<string, number> = {
  tire_change: 15,
  jump_start: 5,
  lockout: 5,
  fuel_delivery: 5,
  battery_standard: 60,
  battery_advanced: 120,
};

/** Canonical install labels used by the internal planner. Unknown labels fail
 * safe to the short estimate and require dispatcher review. */
export function normalizeBatteryInstallType(raw: string | null | undefined): { type: string; minutes: number; reviewRequired: boolean } {
  const value = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(standard|standard_install|top_terminal|basic)$/.test(value)) return { type: "battery_standard", minutes: 60, reviewRequired: false };
  if (/^(advanced|advanced_install|buried|heavy_duty)$/.test(value)) return { type: "battery_advanced", minutes: 120, reviewRequired: false };
  if (/^(european|battery_location_remote|programming_required|dual_battery)$/.test(value)) return { type: `battery_${value}`, minutes: 15, reviewRequired: true };
  return { type: "battery_unknown", minutes: 15, reviewRequired: true };
}

export type InternalEtaAudience = "internal" | "customer";
export function serializeEtaForAudience(result: InternalEtaResult, audience: InternalEtaAudience): Record<string, unknown> {
  if (audience === "customer") return result.ok ? { ok: true, etaMinutes: result.totalMinutes } : { ok: false, etaMinutes: null };
  return result.ok ? { ok: true, totalMinutes: result.totalMinutes, orderedJobIds: result.orderedJobIds, breakdown: result.breakdown, reviewRequired: result.reviewRequired } : result;
}
const ACTIVE = new Set(["offered", "accepted", "en_route", "in_progress", "arrived"]);
const COMMITTED = new Set(["en_route", "in_progress", "arrived"]);

export function normalizeEtaServiceType(raw: string | null | undefined, batteryInstallType?: string | null): string {
  const value = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (value.includes("battery")) {
    return normalizeBatteryInstallType(batteryInstallType ?? value).type;
  }
  if (value.includes("tire") || value.includes("tyre")) return "tire_change";
  if (value.includes("jump")) return "jump_start";
  if (value.includes("lock") || value.includes("unlock")) return "lockout";
  if (value.includes("fuel")) return "fuel_delivery";
  return "unknown";
}

export function serviceMinutesFor(job: Pick<EtaJob, "serviceType" | "serviceName" | "batteryInstallType">): { minutes: number; serviceType: string; unknown: boolean } {
  const type = normalizeEtaServiceType(job.serviceType ?? job.serviceName, job.batteryInstallType);
  const minutes = SERVICE_MINUTES[type];
  return { minutes: minutes ?? 15, serviceType: type, unknown: minutes == null };
}

function validPoint(p: EtaPoint | null | undefined): p is EtaPoint {
  return Boolean(p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180 && !(p.lat === 0 && p.lng === 0));
}
function key(from: string, to: string): string { return `${from}->${to}`; }
function permutations<T>(items: T[]): T[][] {
  if (items.length < 2) return [items.slice()];
  return items.flatMap((item, i) => permutations(items.slice(0, i).concat(items.slice(i + 1))).map((tail) => [item, ...tail]));
}
function lex(ids: string[]): string { return ids.join("\u0000"); }

/** Calculates an internal driver/dispatcher ETA. No ETA ceiling or dispatch rejection is applied. */
export function calculateInternalEta(input: InternalEtaInput): InternalEtaResult {
  const preview = Boolean(input.offer);
  if (!validPoint(input.liveLocation)) return { ok: false, reason: input.liveLocation ? "invalid_live_location" : "missing_live_location", orderedJobIds: [], breakdown: [], totalMinutes: null, reviewRequired: true, preview };
  if (input.jobs.some((j) => !j.id || !validPoint(j.location)) || (input.offer && (!input.offer.id || !validPoint(input.offer.location)))) {
    return { ok: false, reason: "invalid_live_location", orderedJobIds: [], breakdown: [], totalMinutes: null, reviewRequired: true, preview };
  }
  const active = input.jobs.filter((j) => ACTIVE.has(normalizeEtaStatus(j.status)));
  const committed = active.filter((j) => COMMITTED.has(normalizeEtaStatus(j.status)));
  const accepted = active.filter((j) => normalizeEtaStatus(j.status) === "accepted");
  // Started commitments retain their existing order. Only unstarted accepted work is resequenced.
  const candidateOrders = permutations(accepted).map((p) => [...committed, ...p]);
  let best: { order: EtaJob[]; travel: number } | null = null;
  for (const order of candidateOrders) {
    let from = "live";
    let travel = 0;
    let valid = true;
    for (const job of order) {
      const leg = input.routes[key(from, job.id)];
      if (!leg || !Number.isFinite(leg.durationSeconds) || leg.durationSeconds < 0) { valid = false; break; }
      travel += leg.durationSeconds;
      from = job.id;
    }
    if (valid && (!best || travel < best.travel || (travel === best.travel && lex(order.map((j) => j.id)) < lex(best.order.map((j) => j.id))))) best = { order, travel };
  }
  if (!best) return { ok: false, reason: "missing_route_leg", orderedJobIds: [], breakdown: [], totalMinutes: null, reviewRequired: true, preview };
  const outputOrder = input.offer ? [...best.order, input.offer] : best.order;
  // An offer is preview-only, but its route is still calculated after the active plan.
  if (input.offer) {
    const prior = best.order.at(-1)?.id ?? "live";
    const leg = input.routes[key(prior, input.offer.id)];
    if (!leg || !Number.isFinite(leg.durationSeconds) || leg.durationSeconds < 0) return { ok: false, reason: "missing_route_leg", orderedJobIds: [], breakdown: [], totalMinutes: null, reviewRequired: true, preview };
  }
  let elapsed = 0;
  let from = "live";
  let reviewRequired = false;
  const breakdown = outputOrder.map((job) => {
    const leg = input.routes[key(from, job.id)]!;
    const service = serviceMinutesFor(job);
    const travelMinutes = leg.durationSeconds / 60;
    elapsed += travelMinutes;
    const arrivalOffsetMinutes = elapsed;
    elapsed += service.minutes;
    if (service.unknown) reviewRequired = true;
    const result: EtaBreakdown = { jobId: job.id, status: normalizeEtaStatus(job.status), serviceType: service.serviceType, serviceMinutes: service.minutes, unknownServiceType: service.unknown, travelMinutes, distanceMeters: leg.distanceMeters ?? null, arrivalOffsetMinutes, completionOffsetMinutes: elapsed, routeFrom: from, provider: leg.provider, tomtomFailure: leg.tomtomFailure ?? null };
    from = job.id;
    return result;
  });
  return { ok: true, orderedJobIds: best.order.map((j) => j.id), breakdown, totalMinutes: elapsed, reviewRequired, preview };
}

export function routeKey(from: string, to: string): string { return key(from, to); }

/** Adapter contract for the existing TomTom/OSRM provider; keeps API I/O outside the pure planner. */
export type TrafficRoutingAdapter = (from: EtaPoint, to: EtaPoint) => Promise<RouteLeg>;
