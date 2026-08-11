import { createHash } from "node:crypto";
import { sql } from "~/db";
import { decryptSession } from "./towbook-key";

/* ============================ AI dispatcher engine ============================
 * Owner-directed 2026-08-10: auto-accept ALL Towbook motor-club offers inside
 * the approved zone (30-mile radius of zip 06606), dispatch the best available
 * driver with an accurate ETA, log EVERY decision, and escalate uncertainty —
 * never guess.
 *
 * ETA accuracy (owner-directed 2026-08-10, live incident 2026-08-10 23:33:52Z —
 * offer 326520203 quoted Towbook's straight-line estimatedTimeSeconds (~3 min)
 * which the owner had to manually extend by 35 min): the quoted ETA is now the
 * ROAD-AWARE drive time from the driver's precise GPS (nearestDrivers lat/lng)
 * to the offer's pickup, via the ETA v3 provider chain (owner-approved 2026-08-10:
 * TomTom as the traffic-aware routing provider): TomTom Routing (live traffic +
 * construction-aware, ONLY when TOMTOM_API_KEY is set in the server env) →
 * OSRM public routing (static; duration = routes[0].duration) → haversine ÷
 * 30 mph × 1.35 road factor on any failure. Each provider has a 4s timeout; a
 * failure (429/5xx/network/bad shape) falls through to the next. Until the
 * owner supplies TOMTOM_API_KEY the behavior is UNCHANGED: OSRM, then the
 * factor model. The drive time then gets a prep buffer, never below the floor,
 * never above the ceiling (org max_eta_minutes, lowered by the offer's own
 * maxEta when smaller). Every decision reason records WHICH provider produced
 * the ETA (tomtom-traffic / osrm / factor fallback).
 * Choice is BY ROAD ETA: each candidate (checked in && has GPS && no current
 * calls) is routed and the minimum road ETA wins — a driver with a better real
 * drive time beats one with a better straight-line time. Drivers with no GPS
 * (0,0) are NEVER auto-dispatched and NO ETA is quoted for them: the offer is
 * accepted with driverId 0 + escalated (auto_accept_no_driver) so it can never
 * expire but no fabricated ETA goes to the club.
 *
 * Per-offer sequence (the accept POST is the ONLY state-changing call this
 * module makes):
 *   1. GET /api/callRequests/            → pending offers (status == 0)
 *   2. Zone check (haversine vs 06606 centroid) — out of zone / no coords → escalate
 *   3. Expiration check — expired → escalate (we never use acceptMissedRequest)
 *   4. GET /api/nearestDrivers?latitude=<pickup>&longitude=<pickup>&checkInForAllDrivers=true
 *      → choose best driver: checked in && has GPS && no current calls,
 *        minimizing ROAD drive time (OSRM per candidate; fallback model on
 *        routing failure)
 *   5. POST /api/callRequests/{id}/accept {id, ETA, driverId|0, notes} — one
 *      retry on failure, then escalate (never silently drop). No eligible driver
 *      → driverId 0, ETA = the club's SLA ceiling (honest "not yet assigned"),
 *      notes "awaiting driver assignment", escalated. Choice is constrained to
 *      the offer's own `drivers[]` eligible list when one is carried (the UI
 *      dropdown is built from it — an ineligible driverId is silently ignored).
 *   6. VERIFY the dispatch: GET the created call and confirm the chosen driver
 *      is actually on it (assets[].driver.id / assets[].drivers[].driver.id).
 *      Not verified → ONE assign attempt (POST /api/calls/{id}/assignDrivers,
 *      best-guess endpoint — not statically discoverable) → re-verify → still
 *      not assigned → escalated_dispatch_failed with the evidence. The engine
 *      NEVER reports "dispatched" without verification.
 *   7. Record decision + audit (every row captures the FULL offer JSON in
 *      raw_response = {offer, accept, verification}), then syncForOrg so the
 *      accepted call lands in dispatch_jobs immediately (reconcile by
 *      call.id/callNumber)
 *
 * Hard rails: only act on the documented offer shape (callRequestId, status,
 * startLocationLatitude/Longitude, expirationDateUtc); ANY unexpected shape →
 * escalated_unexpected_shape with the full offer JSON, NO accept. Out-of-zone
 * and unverifiable → never accept. Fetch, the env bag, and the router provider
 * are injectable (tests never hit real Towbook, TomTom, or OSRM); the loop
 * wiring resolves the provider from the server env (TomTom when TOMTOM_API_KEY
 * is set, else OSRM static — see resolveRouter).
 * ----------------------------------------------------------------------------- */

export type AiDispatcherActor = { id: string; role: string };

/** One road-routing result — what a provider returns on success. Both the
 *  TomTom and OSRM providers return this shape so the engine (and the decision
 *  record) always knows WHICH provider produced the ETA and whether live
 *  traffic was included. */
export type RoadResult = {
  /** Drive time in seconds (TomTom travelTimeInSeconds / OSRM duration). */
  seconds: number;
  /** Which provider produced this result. */
  provider: "tomtom" | "osrm";
  /** True when the result reflects live traffic (TomTom traffic=true). */
  liveTraffic: boolean;
  /** TomTom's trafficDelayInSeconds (0 when reported as none; null for OSRM). */
  trafficDelaySeconds: number | null;
  /** Human-readable router notes (TomTom: travel + delay; OSRM: static). */
  notes?: string | null;
};

/** Road-aware drive-time source (injectable so tests are hermetic). Returns a
 *  RoadResult (drive SECONDS between two lat/lng pairs + provider metadata), or
 *  null when routing failed (network / timeout / 429 / 5xx / bad body) — the
 *  caller falls back to the next provider in the chain, then to the haversine
 *  ÷ 30 mph × 1.35 factor model. */
export type RoadRouter = (
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
) => Promise<RoadResult | null>;

/** Which ETA provider is active for a deployment. */
export type EtaProvider = "tomtom" | "osrm" | "factor";

/** The resolved router for an env bag: the provider to use plus the router
 *  itself. `router` is null ONLY when provider === "factor" (routing is
 *  disabled — the engine goes straight to the distance model). */
export type ResolvedRouter = {
  /** Active provider: tomtom when TOMTOM_API_KEY is set (live traffic +
   *  construction), osrm static otherwise, factor when routing is disabled. */
  provider: EtaProvider;
  /** The road router to call; null → factor model only. */
  router: RoadRouter | null;
  /** Boolean presence of TOMTOM_API_KEY — NEVER the key itself. */
  tomtomKeyConfigured: boolean;
};

export type AiDispatcherDeps = {
  /** Runs a full Towbook sync for the org (imported from server.ts by the caller;
   *  injected so this module never imports server.ts — avoids a module cycle). */
  syncForOrg: (orgId: string, trigger: string, actor?: AiDispatcherActor) => Promise<unknown>;
  /** Org's first owner (audit attribution); null when the org has no members. */
  resolveOrgActor: (orgId: string) => Promise<AiDispatcherActor | null>;
  /** Injectable fetch for hermetic tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Router provider override for hermetic tests — bypasses env resolution
   *  entirely so tests never hit real TomTom/OSRM. When omitted the provider
   *  is resolved from `env` (defaults to process.env). */
  routerOverride?: ResolvedRouter;
  /** Env bag for provider resolution (defaults to process.env). Tests inject
   *  { TOMTOM_API_KEY } here without touching the process environment. */
  env?: Record<string, string | undefined>;
  /** Post-accept verification retry delay for the call-fetch race (default 5s;
   *  tests inject 0). */
  verifyRetryDelayMs?: number;
};

export type OrgAiSettings = {
  aiDispatcherEnabled: boolean;
  zoneLat: number;
  zoneLng: number;
  zoneRadiusMiles: number;
  maxEtaMinutes: number;
  /** Prep/response buffer added on top of the road drive time (migration v9). */
  etaBufferMinutes: number;
  /** Never quote below this (migration v9). */
  etaFloorMinutes: number;
};

/** Decision taxonomy — every row in ai_dispatcher_decisions carries one of these.
 *  `auto_accept_*` = the offer was accepted (the only state changes the engine
 *  makes); `escalated_*` = the offer was NOT auto-accepted (or the accept failed)
 *  and needs a human; escalated=true marks rows the ops queue must surface. */
export type AiDispatcherDecision =
  | "auto_accept_with_driver"
  | "auto_accept_no_driver"
  | "escalated_out_of_zone"
  | "escalated_missing_coords"
  | "escalated_expired"
  | "escalated_driver_lookup_failed"
  | "escalated_accept_failed"
  | "escalated_unexpected_shape"
  | "escalated_dispatch_failed";

export type AutoDispatchRunResult = {
  gated: boolean; // ai_dispatcher_enabled=false → engine did nothing
  offersSeen: number;
  processed: number; // offers this run acted on (decisions written)
  decisions: Array<{ callRequestId: string; decision: AiDispatcherDecision; escalated: boolean; reason: string }>;
  /** Whole-run skip reason when the engine could not even poll (not connected,
   *  session unavailable, offer fetch failed/unexpected) — never a decision. */
  skipped: string | null;
};

/* ------------------------------- zone geometry ------------------------------- */

const EARTH_RADIUS_MILES = 3958.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance between two lat/lng pairs in miles. */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

/* --------------------------- road-aware ETA model --------------------------- */

/** Fallback drive-time model (used when OSRM routing fails): straight-line
 *  miles ÷ 30 mph × 1.35 road factor → minutes, ceiled. */
const FALLBACK_ROAD_SPEED_MPH = 30;
const FALLBACK_ROAD_FACTOR = 1.35;

/** Minutes for a straight-line distance under the fallback road model
 *  (haversine ÷ 30 mph × 1.35, ceiled). Exported so tests assert exact values. */
export function fallbackRoadMinutes(distanceMiles: number): number {
  if (!Number.isFinite(distanceMiles) || distanceMiles <= 0) return 1;
  return Math.ceil((distanceMiles / FALLBACK_ROAD_SPEED_MPH) * 60 * FALLBACK_ROAD_FACTOR);
}

const OSRM_ENDPOINT = "https://router.project-osrm.org/route/v1/driving";
const ROUTER_TIMEOUT_MS = 4000;

/** Default road router, link 2 of the ETA v3 chain: OSRM public routing API
 *  (static — no live traffic). drive time = routes[0].duration (seconds).
 *  Returns null on ANY failure — network error, timeout, non-2xx (429/5xx
 *  included), or a malformed body — so the engine always falls back to the
 *  factor model instead of quoting a fabricated number. */
export async function osrmRoadSeconds(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RoadResult | null> {
  try {
    const url = `${OSRM_ENDPOINT}/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const o = body as Record<string, unknown>;
    if (o.code !== "Ok" || !Array.isArray(o.routes) || !o.routes.length) return null;
    const duration = Number((o.routes[0] as Record<string, unknown>)?.duration);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return {
      seconds: duration,
      provider: "osrm",
      liveTraffic: false,
      trafficDelaySeconds: null,
      notes: "static routing (no traffic)",
    };
  } catch {
    return null;
  }
}

const TOMTOM_ENDPOINT = "https://api.tomtom.com/routing/1/calculateRoute";

/** Default road router, link 1 of the ETA v3 chain: TomTom Routing with live
 *  traffic + construction awareness (traffic=true, routeType=fastest, and
 *  departAt=<now> so the route reflects current conditions). drive time =
 *  routes[0].summary.travelTimeInSeconds; the extra traffic delay is carried
 *  separately (summary.trafficDelayInSeconds) and reported in notes + the
 *  decision row. vehicleCommercial=false keeps the route on LIGHT-DUTY rules
 *  (our trucks are not commercial-vehicle restricted). Returns null on ANY
 *  failure (429/5xx/network/timeout/bad shape) so the chain falls through to
 *  OSRM. The API key comes from the env ONLY — it is never logged or stored. */
export async function tomtomRoadSeconds(
  apiKey: string,
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RoadResult | null> {
  try {
    const params = new URLSearchParams({
      key: apiKey,
      traffic: "true",
      routeType: "fastest",
      departAt: new Date().toISOString(),
      vehicleCommercial: "false",
    });
    const url = `${TOMTOM_ENDPOINT}/${fromLat},${fromLng}:${toLat},${toLng}/json?${params.toString()}`;
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const routes = (body as Record<string, unknown>).routes;
    if (!Array.isArray(routes) || !routes.length) return null;
    const summary = (routes[0] as Record<string, unknown>).summary as Record<string, unknown> | undefined;
    if (!summary || typeof summary !== "object") return null;
    const travel = Number(summary.travelTimeInSeconds);
    if (!Number.isFinite(travel) || travel <= 0) return null;
    const delay = Number(summary.trafficDelayInSeconds);
    const delaySec = Number.isFinite(delay) && delay > 0 ? delay : 0;
    return {
      seconds: travel,
      provider: "tomtom",
      liveTraffic: true,
      trafficDelaySeconds: delaySec,
      notes: `travel ${travel}s; traffic delay ${delaySec}s`,
    };
  } catch {
    return null;
  }
}

/** ETA v3 provider selection. Chain: TomTom (live traffic + construction, only
 *  when TOMTOM_API_KEY is configured) → OSRM static → haversine factor model
 *  (caller side). With NO key the behavior is exactly the pre-traffic default:
 *  OSRM, then the factor model. The TomTom provider internally falls through to
 *  OSRM on any TomTom failure, so a 429/5xx never loses the ETA. ETA_ROUTER=off
 *  is the explicit opt-out: no routing calls at all, straight to the factor
 *  model. The env bag is injectable so tests never touch process.env. */
export function resolveRouter(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = globalThis.fetch,
): ResolvedRouter {
  const key = (env.TOMTOM_API_KEY ?? "").trim();
  if (key) {
    return {
      provider: "tomtom",
      tomtomKeyConfigured: true,
      router: async (fromLat, fromLng, toLat, toLng) => {
        const tomtom = await tomtomRoadSeconds(key, fromLat, fromLng, toLat, toLng, fetchImpl);
        if (tomtom) return tomtom;
        return osrmRoadSeconds(fromLat, fromLng, toLat, toLng, fetchImpl);
      },
    };
  }
  if ((env.ETA_ROUTER ?? "").trim() === "off") {
    return { provider: "factor", tomtomKeyConfigured: false, router: null };
  }
  return {
    provider: "osrm",
    tomtomKeyConfigured: false,
    router: (fromLat, fromLng, toLat, toLng) => osrmRoadSeconds(fromLat, fromLng, toLat, toLng, fetchImpl),
  };
}

/** The provider status surface for the owner panel (getAiDispatcherStatus):
 *  which ETA provider is active for this deployment + whether the TomTom key
 *  is present — the boolean only, never the key itself. */
export function etaProviderStatus(env: Record<string, string | undefined>): {
  etaProvider: EtaProvider;
  tomtomKeyConfigured: boolean;
} {
  const r = resolveRouter(env);
  return { etaProvider: r.provider, tomtomKeyConfigured: r.tomtomKeyConfigured };
}

/* ------------------------------- settings + ledger ------------------------------- */

/** Load the org's AI-dispatcher settings, lazily creating the row with the
 *  owner-directed defaults (migrations v8+v9): enabled, 06606 centroid, 30 mi,
 *  45 min ceiling, 5 min prep buffer, 5 min quoted-ETA floor. */
export async function getOrgSettings(orgId: string): Promise<OrgAiSettings> {
  const q = sql();
  await q`INSERT INTO org_settings(org_id) VALUES(${orgId}) ON CONFLICT(org_id) DO NOTHING`;
  const rows = await q`SELECT ai_dispatcher_enabled, zone_lat, zone_lng, zone_radius_miles, max_eta_minutes, eta_buffer_minutes, eta_floor_minutes FROM org_settings WHERE org_id=${orgId}`;
  const r = rows[0] as Record<string, unknown>;
  return {
    aiDispatcherEnabled: r.ai_dispatcher_enabled !== false,
    zoneLat: Number(r.zone_lat),
    zoneLng: Number(r.zone_lng),
    zoneRadiusMiles: Number(r.zone_radius_miles),
    maxEtaMinutes: Number(r.max_eta_minutes) || 45,
    etaBufferMinutes: Number(r.eta_buffer_minutes) || 5,
    etaFloorMinutes: Number(r.eta_floor_minutes) || 5,
  };
}

type DecisionRecord = {
  callRequestId: string;
  callId: string | null;
  decision: AiDispatcherDecision;
  driverId: string | null;
  driverName: string | null;
  etaMinutes: number | null;
  zoneDistanceMiles: number | null;
  reason: string;
  rawResponse: unknown;
};

/** Append a decision row + audit entry. The decision row is the record of truth
 *  and is always written; the audit entry (which needs a real user) is
 *  best-effort — an org with no members must still get its decision persisted.
 *  ON CONFLICT DO NOTHING on the (org_id, call_request_id) unique partial index
 *  is the hard backstop against a racing re-poll ever double-processing an offer. */
async function recordDecision(
  orgId: string,
  actor: AiDispatcherActor | null,
  d: DecisionRecord,
): Promise<boolean> {
  const q = sql();
  const escalated = d.decision.startsWith("escalated_") || d.decision === "auto_accept_no_driver";
  const inserted = await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response)
    VALUES(gen_random_uuid()::text, ${orgId}, ${d.callRequestId}, ${d.callId}, ${d.decision}, ${escalated}, ${d.driverId}, ${d.driverName}, ${d.etaMinutes}, ${d.zoneDistanceMiles}, ${d.reason}, ${JSON.stringify(d.rawResponse ?? null)}::jsonb)
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!inserted.length) return false; // a concurrent poll already processed this offer
  if (!actor) return true;
  try {
    // Audit action: accepts are "ai_dispatcher:accept" (owner-specified verb);
    // every other decision (escalation, no-driver accept) is
    // "ai_dispatcher:decision" so ops can query either set.
    const auditAction = d.decision.startsWith("auto_accept_") ? "ai_dispatcher:accept" : "ai_dispatcher:decision";
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      VALUES(gen_random_uuid()::text, ${orgId}, ${actor.id}, ${actor.role}, ${auditAction}, 'call_request', ${d.callRequestId},
        ${JSON.stringify({ decision: d.decision, callRequestId: d.callRequestId, callId: d.callId, driverId: d.driverId, driverName: d.driverName, etaMinutes: d.etaMinutes })}::jsonb, 'ai_dispatcher')`;
  } catch { /* never mask the decision with an audit-write failure */ }
  return true;
}

/** True when the offer's callRequestId already has a decision row (dedupe —
 *  a re-poll can never double-process an offer; the unique partial index is the
 *  hard backstop). */
async function alreadyProcessed(orgId: string, callRequestId: string): Promise<boolean> {
  const rows = await sql()`SELECT 1 FROM ai_dispatcher_decisions WHERE org_id=${orgId} AND call_request_id=${callRequestId} LIMIT 1`;
  return rows.length > 0;
}

/* --------------------------------- offer shape --------------------------------- */

/** Documented offer shape (recon 2026-08-10, callRequestsv2.js + live probe):
 *  every field the engine acts on must be PRESENT with the right primitive type.
 *  Extra fields are tolerated; missing/mistyped required fields are NOT — the
 *  caller escalates with the full offer JSON instead of guessing. */
type OfferShape = {
  callRequestId: string;
  status: number;
  startLocationLatitude: number;
  startLocationLongitude: number;
  expirationDateUtc: string;
  maxEta: number | null;
  /** Eligible driver ids carried by the offer (UI dropdown is built from this
   *  list — accept-with-driverId is only honored for ids in it; absent/empty
   *  means "any company driver" per the UI fallback). Captured so the engine
   *  never dispatches a driver the club did not pre-approve (the 2026-08-10
   *  incident: 703785 was accepted but never landed on the call — the engine
   *  bypassed this rail). */
  drivers: number[] | null;
};

const numeric = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v
  : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim())) ? Number(v.trim())
  : null;

/** Stable pseudo-key for a shape-failed offer (no real callRequestId to key on):
 *  content hash of the raw offer, so the SAME malformed offer dedupes across
 *  polls while different malformed offers never collide on the unique index. */
export function shapeKeyOf(rawOffer: unknown): string {
  const h = createHash("sha1").update(JSON.stringify(rawOffer ?? null)).digest("hex").slice(0, 12);
  return `shape-${h}`;
}

/** Returns {ok:true, offer} or {ok:false, missing: string[]} — why the offer
 *  failed the documented-shape rail. Never coerces a missing field. */
export function validateOfferShape(raw: unknown): { ok: true; offer: OfferShape } | { ok: false; missing: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, missing: ["<offer is not an object>"] };
  const o = raw as Record<string, unknown>;
  const missing: string[] = [];
  const callRequestId = numeric(o.callRequestId);
  if (callRequestId == null) missing.push("callRequestId");
  const status = numeric(o.status);
  if (status == null) missing.push("status");
  const lat = numeric(o.startLocationLatitude);
  if (lat == null) missing.push("startLocationLatitude");
  const lng = numeric(o.startLocationLongitude);
  if (lng == null) missing.push("startLocationLongitude");
  const expirationDateUtc = typeof o.expirationDateUtc === "string" ? o.expirationDateUtc : null;
  if (!expirationDateUtc || Number.isNaN(Date.parse(expirationDateUtc))) missing.push("expirationDateUtc");
  if (missing.length) return { ok: false, missing };
  const maxEta = numeric(o.maxEta);
  const drivers = Array.isArray(o.drivers)
    ? o.drivers.map((d) => numeric(d)).filter((d): d is number => d != null && d > 0)
    : null;
  return {
    ok: true,
    offer: {
      callRequestId: String(callRequestId),
      status: status as number,
      startLocationLatitude: lat as number,
      startLocationLongitude: lng as number,
      expirationDateUtc: expirationDateUtc as string,
      maxEta: maxEta != null && maxEta > 0 ? maxEta : null,
      drivers,
    },
  };
}

/* ------------------------------- driver selection ------------------------------- */

type NearestDriver = Record<string, unknown>;

/** One candidate's road-aware ETA facts (everything the decision row needs). */
export type ChosenDriverEta = {
  driver: NearestDriver;
  /** Route seconds from the road router; null when routing failed (fallback used). */
  roadSeconds: number | null;
  /** Minutes used for ranking + the ETA formula: road minutes when routing
   *  succeeded, fallback-model minutes when it failed. */
  baseMinutes: number;
  /** Towbook straight-line minutes (informational; the old ETA source). */
  straightLineMinutes: number;
  /** True when the router failed and the fallback factor model was used. */
  usedFallback: boolean;
  /** Which provider produced the drive time: "tomtom" (live traffic),
   *  "osrm" (static), or "factor" (fallback model — usedFallback true). */
  provider: EtaProvider;
  /** True when the drive time reflects live traffic (TomTom traffic=true). */
  liveTraffic: boolean;
  /** TomTom trafficDelayInSeconds when TomTom reported it (osrm/factor: null). */
  trafficDelaySeconds: number | null;
  /** Router notes (TomTom travel/delay detail; osrm static; null on fallback). */
  routerNotes: string | null;
};

/** Road-aware driver choice: same rails as before (checked in, real GPS — lat/lng
 *  nonzero AND finite, NO current calls, finite estimatedTimeSeconds), but each
 *  candidate is routed from its precise GPS to the pickup and the minimum ROAD
 *  ETA wins — a driver with a better real drive time beats one with a better
 *  straight-line time. Routing failures fall back to the factor model per
 *  candidate, so a driver is never dropped for a router hiccup. `roadRouter`
 *  may be null (routing disabled — every candidate uses the factor model).
 *  Returns null when no driver qualifies (→ accept with driverId 0 + escalate;
 *  no ETA quoted). */
export async function chooseBestDriverByRoad(
  drivers: unknown[],
  pickupLat: number,
  pickupLng: number,
  roadRouter: RoadRouter | null,
): Promise<ChosenDriverEta | null> {
  const eligible = drivers.filter((d): d is NearestDriver => {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    const o = d as NearestDriver;
    return (
      o.isCheckedIn === true &&
      typeof o.latitude === "number" && Number.isFinite(o.latitude) && o.latitude !== 0 &&
      typeof o.longitude === "number" && Number.isFinite(o.longitude) && o.longitude !== 0 &&
      Array.isArray(o.calls) && o.calls.length === 0 &&
      typeof o.estimatedTimeSeconds === "number" && Number.isFinite(o.estimatedTimeSeconds)
    );
  });
  if (!eligible.length) return null;
  const routed = await Promise.all(
    eligible.map(async (d): Promise<ChosenDriverEta> => {
      const straightLineMinutes = Math.max(1, Math.ceil(Number(d.estimatedTimeSeconds) / 60));
      let result: RoadResult | null = null;
      try {
        result = roadRouter ? await roadRouter(
          Number(d.latitude), Number(d.longitude), pickupLat, pickupLng,
        ) : null;
      } catch { result = null; }
      if (result && Number.isFinite(result.seconds) && result.seconds > 0) {
        return {
          driver: d,
          roadSeconds: result.seconds,
          baseMinutes: Math.ceil(result.seconds / 60),
          straightLineMinutes,
          usedFallback: false,
          provider: result.provider,
          liveTraffic: result.liveTraffic === true,
          trafficDelaySeconds: result.provider === "tomtom" && Number.isFinite(result.trafficDelaySeconds as number)
            ? (result.trafficDelaySeconds as number) : null,
          routerNotes: result.notes ?? null,
        };
      }
      const fallback = fallbackRoadMinutes(
        haversineMiles(Number(d.latitude), Number(d.longitude), pickupLat, pickupLng),
      );
      return {
        driver: d,
        roadSeconds: null,
        baseMinutes: fallback,
        straightLineMinutes,
        usedFallback: true,
        provider: "factor",
        liveTraffic: false,
        trafficDelaySeconds: null,
        routerNotes: null,
      };
    }),
  );
  routed.sort((a, b) =>
    a.baseMinutes - b.baseMinutes ||
    String(a.driver.driverId ?? "").localeCompare(String(b.driver.driverId ?? "")));
  return routed[0];
}

/** Final quoted ETA: ceil(base minutes) + prep buffer, clamped to
 *  [floor, ceiling] (ceiling = org max, lowered by the offer's own maxEta). */
export function finalEtaMinutes(
  baseMinutes: number,
  bufferMinutes: number,
  floorMinutes: number,
  ceilingMinutes: number,
): number {
  const raw = Math.ceil(Number.isFinite(baseMinutes) ? baseMinutes : 0) + (Number.isFinite(bufferMinutes) ? bufferMinutes : 0);
  const ceiling = Math.round(ceilingMinutes) || 45;
  const floor = Math.round(floorMinutes) || 5;
  return Math.min(ceiling, Math.max(floor, raw));
}

/** Human-readable ETA breakdown for decision reasons. The label NAMES the
 *  provider so the ledger is transparent about where each ETA came from:
 *  "ETA 14 min (tomtom-traffic road 9 + buffer 5; delay 2; floor 5, ceiling
 *  45; straight-line 11; GPS 41.18,-73.15)" vs "osrm road …" vs "road fallback
 *  … (factor model)". */
export function etaDetailLabel(c: ChosenDriverEta, buffer: number, floor: number, ceiling: number, finalMinutes: number): string {
  const base = c.usedFallback
    ? `road fallback ${c.baseMinutes} (factor model)`
    : c.provider === "tomtom"
      ? `tomtom-traffic road ${c.baseMinutes}`
      : `osrm road ${c.baseMinutes}`;
  const delay = !c.usedFallback && c.provider === "tomtom" && c.trafficDelaySeconds != null && c.trafficDelaySeconds > 0
    ? `; delay ${Math.round(c.trafficDelaySeconds / 60)}`
    : "";
  return `ETA ${finalMinutes} min (${base} + buffer ${buffer}${delay}; floor ${floor}, ceiling ${ceiling}; straight-line ${c.straightLineMinutes}; GPS ${Number(c.driver.latitude)},${Number(c.driver.longitude)})`;
}

/* ----------------------------------- Towbook HTTP ----------------------------------- */

const TOWBOOK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const towbookHeaders = (cookie: string) => ({
  "user-agent": TOWBOOK_UA,
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  ...(cookie ? { cookie } : {}),
});

type FetchResult = { ok: boolean; status: number | null; body: unknown; bodyText: string; error: string | null };

async function towbookFetch(
  fetchImpl: typeof fetch,
  url: string,
  cookie: string,
  init?: { method?: string; body?: string },
): Promise<FetchResult> {
  try {
    const res = await fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: init?.method === "POST"
        ? { ...towbookHeaders(cookie), "content-type": "application/json" }
        : towbookHeaders(cookie),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      ...(init?.body ? { body: init.body } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try { body = JSON.parse(text); } catch { /* keep raw text */ }
    }
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, body, bodyText: text, error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, body: null, bodyText: "", error: String(err).slice(0, 200) };
  }
}

/** Extract a resulting call id from an accept response (response shape is an
 *  unknown until the first real accept; scan the documented keys). */
const callIdFromAcceptResponse = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  for (const k of ["id", "callId", "callNumber", "callID"]) {
    const v = o[k];
    if (v != null && (typeof v === "number" || typeof v === "string")) return String(v);
  }
  return null;
};

/* ----------------------------------- accept POST ----------------------------------- */

/** POST /api/callRequests/{id}/accept with the documented body. One call, one
 *  retry on failure — a failed accept is NEVER silently dropped. Returns the
 *  last attempt's raw response for the decision row. The body id is the NUMERIC
 *  callRequestId when it parses as an integer (byte-matching the UI payload:
 *  `{ id: id, ... }` where id is the numeric offer id). `notes` is appended so
 *  the no-driver accept tells the club the truth ("awaiting driver assignment"). */
async function postAccept(
  fetchImpl: typeof fetch,
  baseUrl: string,
  cookie: string,
  callRequestId: string,
  etaMinutes: number,
  driverId: number,
  notes: string,
): Promise<{ ok: boolean; raw: unknown; attempts: FetchResult[] }> {
  const url = `${baseUrl}/api/callRequests/${callRequestId}/accept`;
  const numericId = Number(callRequestId);
  const body = JSON.stringify({
    id: Number.isInteger(numericId) ? numericId : callRequestId,
    comments: "",
    ETA: etaMinutes,
    driverId,
    notes,
    tireAvailable: false,
  });
  const attempts: FetchResult[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await towbookFetch(fetchImpl, url, cookie, { method: "POST", body });
    attempts.push(res);
    if (res.ok) return { ok: true, raw: res.body, attempts };
  }
  return { ok: false, raw: attempts[attempts.length - 1]?.body ?? null, attempts };
}
/* ------------------------- dispatch verification + retry ------------------------- */
/** The assign endpoint for EXISTING calls is not statically discoverable in the
 *  Towbook UI JS (the Map app's typed client has per-call verbs lock/audit/
 *  Complete/Cancel/... but NO assignDrivers; drag-to-assign code is not in any
 *  fetched bundle). Best-guess candidate following the `/api/calls/{id}/<verb>`
 *  convention; a wrong guess fails harmlessly (404/400 → no state change) and
 *  the engine escalates with evidence instead of claiming a dispatch. */
export const ASSIGN_DRIVER_ENDPOINT = "assignDrivers";
/** POST /api/calls/{id}/assignDrivers {driverId, callId} — one attempt, never
 *  retried: if the first guess fails we escalate with evidence, we do not spam
 *  the live API. */
async function postAssignDriver(
  fetchImpl: typeof fetch,
  baseUrl: string,
  cookie: string,
  callId: string,
  driverId: number,
): Promise<FetchResult> {
  const url = `${baseUrl}/api/calls/${callId}/${ASSIGN_DRIVER_ENDPOINT}`;
  return towbookFetch(fetchImpl, url, cookie, {
    method: "POST",
    body: JSON.stringify({ driverId, callId }),
  });
}
export type DispatchVerification = {
  /** True only when the chosen driver is actually on the fetched call. */
  ok: boolean;
  callId: string | null;
  statusId: number | null;
  driverOnCall: string | null;
  /** How the call was located: "acceptResponse", "purchaseOrder", "newest". */
  source: string;
  assignedAfterRetry: boolean;
  found: boolean;
  attempts: Array<{ url: string; status: number | null; error: string | null; matched: boolean }>;
  error: string | null;
};
/** True when the call's assets carry `driver.id === driverId` — the assignment
 *  mirror used by the Towbook UI (call-single.json evidence: assets[].driver.id
 *  and assets[].drivers[].driver.id are both DRIVER ids). */
export function callHasDriver(call: unknown, driverId: number): boolean {
  if (!call || typeof call !== "object") return false;
  const assets = (call as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return false;
  return assets.some((a) => {
    if (!a || typeof a !== "object") return false;
    const driver = (a as Record<string, unknown>).driver as Record<string, unknown> | undefined;
    if (driver && Number(driver.id) === driverId) return true;
    const drivers = (a as Record<string, unknown>).drivers;
    return Array.isArray(drivers) && drivers.some((d) => {
      if (!d || typeof d !== "object") return false;
      const sub = ((d as Record<string, unknown>).driver ?? null) as Record<string, unknown> | null;
      return sub != null && Number(sub.id) === driverId;
    });
  });
}
/** Locate the call created by the accept: accept-response id → PO match on the
 *  status-2 (accepted) list, falling back to status-1 (offered) → newest id. */
export async function findAcceptedCall(
  fetchImpl: typeof fetch,
  baseUrl: string,
  cookie: string,
  acceptResponseId: string | null,
  purchaseOrderNumber: unknown,
): Promise<{ call: Record<string, unknown> | null; source: string; fetches: Array<{ url: string; status: number | null; error: string | null; matched: boolean }> }> {
  const fetches: Array<{ url: string; status: number | null; error: string | null; matched: boolean }> = [];
  if (acceptResponseId) {
    const url = `${baseUrl}/api/calls/${acceptResponseId}`;
    const res = await towbookFetch(fetchImpl, url, cookie);
    fetches.push({ url, status: res.status, error: res.error, matched: false });
    if (res.ok && res.body && typeof res.body === "object" && !Array.isArray(res.body)) {
      fetches[fetches.length - 1].matched = true;
      return { call: res.body as Record<string, unknown>, source: "acceptResponse", fetches };
    }
  }
  // status 2 (accepted) then 1 (offered) — the accept may land in either.
  for (const statusId of [2, 1]) {
    const res = await towbookFetch(fetchImpl, `${baseUrl}/api/calls?status=${statusId}`, cookie);
    fetches.push({ url: `${baseUrl}/api/calls?status=${statusId}`, status: res.status, error: res.error, matched: false });
    if (res.ok && Array.isArray(res.body) && res.body.length) {
      const list = res.body as Array<Record<string, unknown>>;
      // PO match first (the offer carries purchaseOrderNumber; the call mirrors it)
      const po = purchaseOrderNumber != null ? String(purchaseOrderNumber) : null;
      const byPo = po ? list.find((c) => String((c as Record<string, unknown>).purchaseOrderNumber ?? "") === po) : undefined;
      if (byPo) {
        fetches[fetches.length - 1].matched = true;
        return { call: byPo, source: "purchaseOrder", fetches };
      }
      // else newest id (accept just created the call — it is the newest)
      const newest = list.reduce<Record<string, unknown> | null>((acc, c) => {
        const id = Number((c as Record<string, unknown>).id) || 0;
        return acc === null || id > (Number((acc as Record<string, unknown>).id) || 0) ? c : acc;
      }, null);
      if (newest) {
        fetches[fetches.length - 1].matched = true;
        return { call: newest, source: "newest", fetches };
      }
    }
  }
  return { call: null, source: "none", fetches };
}
/** Post-accept verification loop (the core of the dispatch fix): GET the
 *  created call and check the chosen driver is actually on it
 *  (assets[].driver.id / assets[].drivers[].driver.id). If NOT → one assign
 *  attempt (postAssignDriver) → re-verify. If the call can't be fetched (race)
 *  → retry once after `retryDelayMs`. NEVER reports dispatched without the
 *  driver being observed on the call. */
export async function verifyDispatch(
  fetchImpl: typeof fetch,
  baseUrl: string,
  cookie: string,
  offer: OfferShape,
  acceptResponseId: string | null,
  driverId: number,
  opts: { retryDelayMs?: number; allowAssign?: boolean } = {},
): Promise<DispatchVerification> {
  const delay = opts.retryDelayMs ?? 5000;
  const attempt = async (): Promise<DispatchVerification> => {
    const { call, source, fetches } = await findAcceptedCall(fetchImpl, baseUrl, cookie, acceptResponseId, (offer as unknown as Record<string, unknown>).purchaseOrderNumber);
    const base: DispatchVerification = {
      ok: false, callId: call ? String((call as Record<string, unknown>).id ?? "") : null,
      statusId: call && (call as Record<string, unknown>).status && typeof (call as Record<string, unknown>).status === "object"
        ? Number((((call as Record<string, unknown>).status) as Record<string, unknown>).id) ?? null : null,
      driverOnCall: null, source, assignedAfterRetry: false, found: !!call, attempts: fetches, error: null,
    };
    if (!call) return { ...base, error: "call not found after accept" };
    if (callHasDriver(call, driverId)) {
      return { ...base, ok: true, driverOnCall: String(driverId) };
    }
    const onCall = firstDriverIdOnCall(call);
    return { ...base, driverOnCall: onCall, error: `chosen driver ${driverId} not on the call (found ${onCall ?? "none"})` };
  };
  let v = await attempt();
  if (!v.found && v.error === "call not found after accept") {
    // Race — the accept is async ("Your request ... has been received"); retry once.
    await new Promise((r) => setTimeout(r, delay));
    v = await attempt();
    if (v.ok) return { ...v, assignedAfterRetry: v.assignedAfterRetry };
  }
  if (v.ok || !opts.allowAssign || !v.callId) return v;
  // Chosen driver not verified on the call → one assign attempt → re-verify.
  const assignUrl = `${baseUrl}/api/calls/${v.callId}/${ASSIGN_DRIVER_ENDPOINT}`;
  const assignRes = await postAssignDriver(fetchImpl, baseUrl, cookie, v.callId, driverId);
  v.attempts.push({ url: assignUrl, status: assignRes.status, error: assignRes.error, matched: false });
  if (!assignRes.ok) {
    return { ...v, error: `assign attempt failed (${assignRes.error ?? `HTTP ${assignRes.status}`}) — ${v.error}` };
  }
  const after = await attempt();
  if (after.ok) return { ...after, assignedAfterRetry: true, attempts: [...v.attempts, ...after.attempts] };
  return { ...after, attempts: [...v.attempts, ...after.attempts], error: `assign returned ok but driver still not on the call — ${after.error}` };
}
function firstDriverIdOnCall(call: Record<string, unknown>): string | null {
  const assets = call.assets;
  if (!Array.isArray(assets)) return null;
  for (const a of assets) {
    if (!a || typeof a !== "object") continue;
    const d = (a as Record<string, unknown>).driver as Record<string, unknown> | undefined;
    if (d && d.id != null) return String(d.id);
    const drs = (a as Record<string, unknown>).drivers;
    if (Array.isArray(drs)) {
      for (const dr of drs) {
        if (dr && typeof dr === "object" && (dr as Record<string, unknown>).driver) {
          const id = ((dr as Record<string, unknown>).driver as Record<string, unknown>).id;
          if (id != null) return String(id);
        }
      }
    }
  }
  return null;
}

/* ----------------------------------- the engine ----------------------------------- */

/** Poll the org's incoming Towbook offers and auto-accept the in-zone ones per
 *  the owner-directed policy. Safe to run on every sync tick: dedupe by
 *  callRequestId makes re-polls no-ops, and the only state-changing call is the
 *  accept POST. Never throws — every failure mode is a recorded decision or a
 *  run-level skip. */
export async function runAutoDispatch(orgId: string, deps: AiDispatcherDeps): Promise<AutoDispatchRunResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const base: AutoDispatchRunResult = { gated: false, offersSeen: 0, processed: 0, decisions: [], skipped: null };
  try {
    const settings = await getOrgSettings(orgId);
    if (!settings.aiDispatcherEnabled) return { ...base, gated: true };

    const sess = await sql()`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${orgId}`;
    if (!sess.length || String(sess[0].status) !== "connected" || !String(sess[0].encrypted_session || "").length) {
      return { ...base, skipped: "not_connected" };
    }
    let cookies: string;
    let baseUrl: string;
    try {
      const plain = await decryptSession(String(sess[0].encrypted_session));
      const parsed = JSON.parse(plain) as { cookies?: string; baseUrl?: string };
      cookies = parsed.cookies || "";
      baseUrl = parsed.baseUrl || "https://app.towbook.com";
    } catch {
      return { ...base, skipped: "session_unavailable" };
    }

    const offersRes = await towbookFetch(fetchImpl, `${baseUrl}/api/callRequests/`, cookies);
    if (!offersRes.ok) return { ...base, skipped: `offer_fetch_failed (${offersRes.error ?? offersRes.status})` };
    if (!Array.isArray(offersRes.body)) return { ...base, skipped: "offer_payload_unexpected" };
    const offers = offersRes.body as unknown[];
    if (!offers.length) return { ...base, offersSeen: 0 };

    const actor = await deps.resolveOrgActor(orgId);
    const result: AutoDispatchRunResult = { ...base, offersSeen: offers.length };

    for (const rawOffer of offers) {
      const shape = validateOfferShape(rawOffer);
      if (!shape.ok) {
        const reason = `offer shape unexpected — missing/mistyped: ${shape.missing.join(", ")} (no accept; full offer in raw_response)`;
        const key = shapeKeyOf(rawOffer);
        if (await alreadyProcessed(orgId, key)) continue; // same malformed offer re-polled
        await recordDecision(orgId, actor, {
          callRequestId: key, callId: null, decision: "escalated_unexpected_shape",
          driverId: null, driverName: null, etaMinutes: null, zoneDistanceMiles: null,
          reason, rawResponse: { offer: rawOffer },
        });
        result.processed++;
        result.decisions.push({ callRequestId: key, decision: "escalated_unexpected_shape", escalated: true, reason });
        continue;
      }
      const { offer } = shape;
      // dedupe: never double-process an offer (SELECT before acting; unique
      // partial index is the hard backstop against races)
      if (await alreadyProcessed(orgId, offer.callRequestId)) continue;
      if (offer.status !== 0) continue; // not a pending offer — not ours to touch

      const record = async (d: Partial<Omit<DecisionRecord, "callRequestId">>) =>
        recordDecision(orgId, actor, {
          callRequestId: offer.callRequestId,
          callId: d.callId ?? null,
          decision: d.decision ?? "escalated_unexpected_shape",
          driverId: d.driverId ?? null,
          driverName: d.driverName ?? null,
          etaMinutes: d.etaMinutes ?? null,
          zoneDistanceMiles: d.zoneDistanceMiles ?? null,
          reason: d.reason ?? "",
          rawResponse: d.rawResponse ?? null,
        });

      // --- zone check (haversine vs the 06606 centroid) ---
      if (offer.startLocationLatitude === 0 || offer.startLocationLongitude === 0) {
        const reason = `no usable pickup coordinates (lat=${offer.startLocationLatitude}, lng=${offer.startLocationLongitude}) — cannot verify zone (no accept)`;
        await record({ decision: "escalated_missing_coords", reason, rawResponse: { offer } });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "escalated_missing_coords", escalated: true, reason });
        continue;
      }
      const zoneDistance = haversineMiles(offer.startLocationLatitude, offer.startLocationLongitude, settings.zoneLat, settings.zoneLng);
      if (zoneDistance > settings.zoneRadiusMiles) {
        const reason = `pickup ${zoneDistance.toFixed(1)} mi from zone center — outside the ${settings.zoneRadiusMiles}-mile radius (no accept)`;
        await record({ decision: "escalated_out_of_zone", zoneDistanceMiles: zoneDistance, reason, rawResponse: { offer } });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "escalated_out_of_zone", escalated: true, reason });
        continue;
      }

      // --- expiration check ---
      if (Date.parse(offer.expirationDateUtc) < Date.now()) {
        const reason = `offer expired (expirationDateUtc=${offer.expirationDateUtc}) — not auto-accepted (no accept)`;
        await record({ decision: "escalated_expired", zoneDistanceMiles: zoneDistance, reason, rawResponse: { offer } });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "escalated_expired", escalated: true, reason });
        continue;
      }

      // --- driver lookup: nearestDrivers from the pickup point ---
      const nd = await towbookFetch(
        fetchImpl,
        `${baseUrl}/api/nearestDrivers?latitude=${offer.startLocationLatitude}&longitude=${offer.startLocationLongitude}&checkInForAllDrivers=true`,
        cookies,
      );
      if (!nd.ok || !Array.isArray(nd.body)) {
        const reason = `driver lookup failed (${nd.error ?? `HTTP ${nd.status}`}) — cannot dispatch (no accept)`;
        await record({ decision: "escalated_driver_lookup_failed", zoneDistanceMiles: zoneDistance, reason, rawResponse: { offer, nearestDrivers: nd.bodyText.slice(0, 400) } });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "escalated_driver_lookup_failed", escalated: true, reason });
        continue;
      }
      // --- road-aware driver choice: route EVERY candidate from its precise
      // GPS to the pickup and pick the minimum ROAD ETA (fallback factor model
      // per candidate when routing fails; no-GPS drivers are never eligible).
      // Eligibility rail (2026-08-10 incident fix): if the offer carries an
      // explicit `drivers[]` eligible list (the UI dropdown is built from it),
      // ONLY those ids may be dispatched — accept-with-driverId for an
      // ineligible driver is silently ignored by Towbook. ---
      const eligibleIds = offer.drivers && offer.drivers.length ? new Set(offer.drivers) : null;
      const candidates = eligibleIds
        ? (nd.body as unknown[]).filter((d) => {
            const id = Number((d as Record<string, unknown>).driverId);
            return Number.isFinite(id) && eligibleIds.has(id);
          })
        : (nd.body as unknown[]);
      // ETA v3 provider resolution: TomTom when TOMTOM_API_KEY is set (with
      // automatic fall-through to OSRM on any TomTom failure), else OSRM static,
      // else null (ETA_ROUTER=off → factor model only). Tests inject
      // routerOverride/env so this never hits real TomTom/OSRM.
      const resolved: ResolvedRouter = deps.routerOverride ?? resolveRouter(deps.env ?? process.env, fetchImpl);
      const chosen = await chooseBestDriverByRoad(
        candidates,
        offer.startLocationLatitude,
        offer.startLocationLongitude,
        resolved.router,
      );
      const driver = chosen?.driver ?? null;
      const effectiveMaxEta = Math.min(settings.maxEtaMinutes, offer.maxEta ?? settings.maxEtaMinutes);
      const driverId = driver ? Number(driver.driverId) || 0 : 0;
      // Final quoted ETA: ceil(road minutes) + buffer, clamped to [floor, ceiling].
      // NO driver → no ETA is computed (nothing is being dispatched); the accept
      // body still needs the field — quote the club's SLA ceiling (an honest
      // "not yet assigned" worst case, never a fabricated 1-minute promise).
      const etaMinutes = driver && chosen
        ? finalEtaMinutes(chosen.baseMinutes, settings.etaBufferMinutes, settings.etaFloorMinutes, effectiveMaxEta)
        : null;
      const postEta = etaMinutes ?? effectiveMaxEta;
      const postNotes = driver
        ? "auto-accept by Lightning Dispatch"
        : "auto-accept by Lightning Dispatch; awaiting driver assignment";
      const etaFacts = chosen ? {
        finalMinutes: etaMinutes,
        baseMinutes: chosen.baseMinutes,
        roadSeconds: chosen.roadSeconds,
        usedFallback: chosen.usedFallback,
        provider: chosen.provider,
        liveTraffic: chosen.liveTraffic,
        trafficDelaySeconds: chosen.trafficDelaySeconds,
        routerNotes: chosen.routerNotes,
        straightLineMinutes: chosen.straightLineMinutes,
        bufferMinutes: settings.etaBufferMinutes,
        floorMinutes: settings.etaFloorMinutes,
        ceilingMinutes: effectiveMaxEta,
        driverLatitude: Number(chosen.driver.latitude),
        driverLongitude: Number(chosen.driver.longitude),
      } : null;
      const noDriverReason = driver
        ? null
        : eligibleIds
          ? `no ELIGIBLE checked-in free driver with GPS (offer eligible list [${offer.drivers!.join(", ")}]; accepted WITHOUT dispatch so the motor-club offer cannot expire or be missed; assign manually, ETA quoted at the ${effectiveMaxEta}-min ceiling — no ETA recorded)`
          : "no checked-in free driver with GPS — accepted WITHOUT dispatch so the motor-club offer cannot expire or be missed; assign manually (ETA quoted at the SLA ceiling — no ETA recorded)";
      // --- accept (the ONE state-changing call) ---
      const accept = await postAccept(fetchImpl, baseUrl, cookies, offer.callRequestId, postEta, driverId, postNotes);
      if (!accept.ok) {
        const reason = `accept POST failed after retry (${accept.attempts.map((a) => a.error ?? `HTTP ${a.status}`).join("; ")}) — offer NOT auto-accepted, needs a human${chosen ? `; ${etaDetailLabel(chosen, settings.etaBufferMinutes, settings.etaFloorMinutes, effectiveMaxEta, etaMinutes as number)}` : ""}`;
        await record({
          decision: "escalated_accept_failed",
          driverId: driver ? String(driver.driverId) : null,
          driverName: driver ? String(driver.driverName ?? "") : null,
          etaMinutes, zoneDistanceMiles: zoneDistance, reason,
          rawResponse: { offer, eta: etaFacts, accept: accept.raw, attempts: accept.attempts.map((a) => ({ status: a.status, body: a.body })) },
        });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "escalated_accept_failed", escalated: true, reason });
        continue;
      }
      if (driver && chosen && etaMinutes != null) {
        // --- post-accept verification loop: NEVER claim "dispatched" without
        // seeing the chosen driver on the fetched call (assets[].driver.id /
        // assets[].drivers[].driver.id). Not verified → one assign attempt →
        // re-verify → still not assigned → escalated_dispatch_failed. ---
        const verification = await verifyDispatch(fetchImpl, baseUrl, cookies, offer, callIdFromAcceptResponse(accept.raw), driverId, {
          retryDelayMs: deps.verifyRetryDelayMs ?? 5000,
          allowAssign: true,
        });
        if (verification.ok) {
          const reason = `accepted and dispatched to ${String(driver.driverName ?? driver.driverId)} (driver ${driver.driverId}, VERIFIED on call ${verification.callId}) — ${etaDetailLabel(chosen, settings.etaBufferMinutes, settings.etaFloorMinutes, effectiveMaxEta, etaMinutes)}`;
          await record({
            decision: "auto_accept_with_driver",
            callId: verification.callId,
            driverId: String(driver.driverId), driverName: String(driver.driverName ?? ""),
            etaMinutes, zoneDistanceMiles: zoneDistance, reason,
            rawResponse: { offer, eta: etaFacts, accept: accept.raw, verification },
          });
          result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "auto_accept_with_driver", escalated: false, reason });
        } else {
          const reason = `accepted (call ${verification.callId ?? "unknown"}) but dispatch NOT verified for ${String(driver.driverName ?? driver.driverId)} (driver ${driver.driverId}) — ${verification.error}; needs a human to assign on Towbook (ETA ${etaMinutes} min quoted)`;
          await record({
            decision: "escalated_dispatch_failed",
            callId: verification.callId,
            driverId: String(driver.driverId), driverName: String(driver.driverName ?? ""),
            etaMinutes, zoneDistanceMiles: zoneDistance, reason,
            rawResponse: { offer, eta: etaFacts, accept: accept.raw, verification },
          });
          result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "escalated_dispatch_failed", escalated: true, reason });
        }
      } else {
        // No checked-in free (eligible) driver with GPS (no-GPS drivers are
        // never auto-dispatched, and no ETA is fabricated for them): accept
        // WITHOUT dispatch so the motor-club offer cannot expire or be missed.
        await record({
          decision: "auto_accept_no_driver",
          driverId: null, driverName: null,
          etaMinutes: null, zoneDistanceMiles: zoneDistance, reason: noDriverReason as string,
          rawResponse: { offer, eta: etaFacts, accept: accept.raw },
        });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "auto_accept_no_driver", escalated: true, reason: noDriverReason as string });
      }
      // Pull the resulting call into dispatch_jobs immediately (reconcile by
      // call.id/callNumber happens inside the sync's upsert).
      try { await deps.syncForOrg(orgId, "sync:auto-accept", actor ?? undefined); } catch { /* engine never throws */ }
    }
    return result;
  } catch (err) {
    // Database or unexpected failure — never crash the sync loop.
    return { ...base, skipped: `engine_error (${String(err).slice(0, 200)})` };
  }
}
