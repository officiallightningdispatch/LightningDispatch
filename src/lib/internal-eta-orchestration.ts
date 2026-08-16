/** Shared internal ETA recalculation orchestration. All mutation/refresh entry points
 * call this one gate so driver and ops views never invent their own ETA math. */
export type EtaRecalculationTrigger = "offer_assignment" | "status_change" | "fresh_gps" | "traffic_refresh";
export type EtaRecalculationEntry<T> = { trigger: EtaRecalculationTrigger; key: string; value: T | null; recalculatedAt: number };
export type EtaRecalculationEntryPoint<T> = (trigger: EtaRecalculationTrigger, key: string) => Promise<T | null>;
export type EtaRecalculationHooks<T> = {
  onOfferAssignment: (key: string) => Promise<EtaRecalculationEntry<T>>;
  onStatusChange: (key: string) => Promise<EtaRecalculationEntry<T>>;
  onFreshGps: (key: string) => Promise<EtaRecalculationEntry<T>>;
  onTrafficRefresh: (key: string) => Promise<EtaRecalculationEntry<T>>;
};
export function createEtaRecalculationEntryPoint<T>(recalculate: (trigger: EtaRecalculationTrigger, key: string) => Promise<T | null>, now: () => number = Date.now): EtaRecalculationEntryPoint<T> {
  return async (trigger, key) => recalculate(trigger, key);
}
export function createEtaRecalculationHooks<T>(entryPoint: EtaRecalculationEntryPoint<T>, now: () => number = Date.now): EtaRecalculationHooks<T> {
  const run = (trigger: EtaRecalculationTrigger) => async (key: string): Promise<EtaRecalculationEntry<T>> => ({ trigger, key, value: await entryPoint(trigger, key), recalculatedAt: now() });
  return { onOfferAssignment: run("offer_assignment"), onStatusChange: run("status_change"), onFreshGps: run("fresh_gps"), onTrafficRefresh: run("traffic_refresh") };
}
/** TTL gate for traffic refreshes; other triggers always recalculate. */
export function trafficRefreshNeeded(lastRefreshAt: number | null, now: number, ttlMs: number): boolean {
  return lastRefreshAt == null || now - lastRefreshAt >= ttlMs;
}

/** Common mutation entry point used by server callers. It deliberately accepts
 * the already-authoritative planner result: callers must not serialize or
 * recompute ETA independently for a portal or customer payload. */
export async function recalculateInternalEta<T>(opts: {
  trigger: EtaRecalculationTrigger;
  key: string;
  calculate: () => Promise<T | null>;
  now?: () => number;
}): Promise<EtaRecalculationEntry<T>> {
  return { trigger: opts.trigger, key: opts.key, value: await opts.calculate(), recalculatedAt: (opts.now ?? Date.now)() };
}
