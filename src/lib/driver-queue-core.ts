import type { DriverCall } from "~/data/driver-auth";

export type DriverQueueLocation = { latitude: number; longitude: number } | null;
export type QueueCall = DriverCall & {
  vehicleYear?: string | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  dutyType?: "Light Duty" | "Medium Duty" | "Heavy Duty" | null;
};

const ACTIVE = new Set([1, 2, 3, 4]);
const TERMINAL = new Set([5, 6, 252, 255]);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const miles = (a: DriverQueueLocation, lat: number | null, lng: number | null): number => {
  if (!a || !finite(lat) || !finite(lng)) return Number.POSITIVE_INFINITY;
  const rad = Math.PI / 180;
  const dLat = (lat - a.latitude) * rad;
  const dLng = (lng - a.longitude) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(lat * rad) * Math.sin(dLng / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

/** Active assigned calls, ordered by current next-stop distance. Missing GPS or
 * pickup coordinates sort after routable jobs; id is the deterministic tie-break. */
export function orderDriverQueue(calls: readonly QueueCall[], location: DriverQueueLocation): QueueCall[] {
  return calls.filter((c) => ACTIVE.has(c.statusId) && !TERMINAL.has(c.statusId)).slice().sort((a, b) => {
    const da = miles(location, a.pickupLat, a.pickupLng);
    const db = miles(location, b.pickupLat, b.pickupLng);
    if (da !== db) return da - db;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Reducer used by realtime delivery and hermetic tests: assignment events are
 * merged, never replaced; terminal events remove the call. */
export function applyDriverQueueEvent(current: readonly QueueCall[], event: { type: "assigned" | "updated" | "completed" | "cancelled"; call: QueueCall }): QueueCall[] {
  const next = current.filter((c) => c.id !== event.call.id);
  return event.type === "completed" || event.type === "cancelled" || TERMINAL.has(event.call.statusId)
    ? next
    : [...next, event.call];
}

export function normalizeDutyType(value: unknown): QueueCall["dutyType"] {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/(heavy|class\s*[789]|8\s*\+|over\s*26)/.test(s)) return "Heavy Duty";
  if (/(medium|class\s*[4-6]|10[, ]?001|26[, ]?000)/.test(s)) return "Medium Duty";
  if (/(light|class\s*[1-3]|under\s*10)/.test(s)) return "Light Duty";
  return null;
}

export const queueIsActive = (statusId: number) => ACTIVE.has(statusId);
