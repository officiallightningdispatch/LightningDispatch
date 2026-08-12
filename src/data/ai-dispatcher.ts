import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sql } from "~/db";
import { decryptSession, findSiteRoot } from "./towbook-key";
import type { RecoveryResult } from "./towbook-recovery";

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
 * construction-aware, ONLY when a TomTom API key is configured — env
 * TOMTOM_API_KEY or the stable key file, see resolveTomtomKey) →
 * OSRM public routing (static; duration = routes[0].duration) → haversine ÷
 * 30 mph × 1.35 road factor on any failure. Each provider has a 4s timeout; a
 * failure (429/5xx/network/bad shape) falls through to the next. Until a
 * TomTom key is configured the behavior is UNCHANGED: OSRM, then the
 * factor model. The drive time then gets a prep buffer, never below the floor,
 * never above the ceiling (org max_eta_minutes, lowered by the offer's own
 * maxEta when smaller). Every decision reason records WHICH provider produced
 * the ETA (tomtom-traffic / osrm / factor fallback).
 * Choice is BY ROAD ETA: each candidate (checked in && has GPS && fewer than
 * MAX_DRIVER_QUEUE active jobs — queue-aware capacity, owner-directed
 * 2026-08-11; active = new/offered/accepted/en_route/arrived, counted from
 * the org's dispatch_jobs cross-checked against the payload's `calls`) is
 * routed and the minimum road ETA wins — a driver with a better real
 * drive time beats one with a better straight-line time. When EVERY candidate
 * is at the 3-job cap, the engine dispatches to whoever would ARRIVE fastest
 * after their queue (queue travel + SERVICE_MINUTES_PER_JOB per queued job +
 * the final road leg to the offer) and quotes THAT queue-inclusive ETA
 * (clamped to [floor, ceiling]). Drivers with no GPS (0,0) are NEVER
 * auto-dispatched and NO ETA is quoted for them: the offer is accepted with
 * driverId 0 + escalated (auto_accept_no_driver) so it can never expire but
 * no fabricated ETA goes to the club.
 *
 * Per-offer sequence (the accept POST is the ONLY state-changing call this
 * module makes):
 *   1. GET /api/callRequests/            → pending offers (status == 0)
 *   2. Zone check (haversine vs 06606 centroid) — out of zone / no coords → escalate
 *   3. Expiration check — expired → escalate (we never use acceptMissedRequest)
 *   4. GET /api/nearestDrivers?latitude=<pickup>&longitude=<pickup>&checkInForAllDrivers=true
 *      → choose best driver: checked in && has GPS && < MAX_DRIVER_QUEUE active
 *        jobs (queue-aware), minimizing ROAD drive time (OSRM per candidate;
 *        fallback model on routing failure); all-loaded → queue-inclusive
 *        arrival model
 *   5. POST /api/callRequests/{id}/accept {id, ETA, driverId|0, notes} — one
 *      retry on failure, then escalate (never silently drop). No eligible driver
 *      → driverId 0, ETA = the club's SLA ceiling (honest "not yet assigned"),
 *      notes "awaiting driver assignment", escalated. Choice is constrained to
 *      the offer's own `drivers[]` eligible list when one is carried (the UI
 *      dropdown is built from it — an ineligible driverId is silently ignored).
 *   6. VERIFY the dispatch: GET the created call and confirm the chosen driver
 *      is actually on it (assets[].driver.id / assets[].drivers[].driver.id).
 *      Not verified → ONE assign attempt (PUT /api/calls/{id} with status 1 +
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
 * wiring resolves the provider from the server env (TomTom when a key is
 * configured — env TOMTOM_API_KEY or the stable key file — else OSRM static;
 * see resolveRouter).
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
  /** Set ONLY when the TomTom provider was attempted and FAILED and the chain
   *  fell through to OSRM (e.g. "HTTP 429" / "timeout" / "bad body"). Lets the
   *  decision reason be honest about the transient failure instead of silently
   *  recording "osrm" — ETA honesty (owner-directed 2026-08-11 incident: a live
   *  5-min-understating quote was OSRM-only while TomTom was momentarily down). */
  tomtomFailure?: string | null;
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
  /** Active provider: tomtom when a TomTom key is configured (env or the
   *  stable key file — live traffic + construction), osrm static otherwise,
   *  factor when routing is disabled. */
  provider: EtaProvider;
  /** The road router to call; null → factor model only. */
  router: RoadRouter | null;
  /** Boolean presence of a TomTom key — NEVER the key itself. */
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
   *  { TOMTOM_API_KEY } / { TOMTOM_KEY_FILE } here without touching the process
   *  environment. */
  env?: Record<string, string | undefined>;
  /** Post-accept verification retry delay for the call-fetch race (default 5s;
   *  tests inject 0). */
  verifyRetryDelayMs?: number;
  /** Injectable session recovery for hermetic tests; defaults to the real
   *  recoverTowbookSession (self-healing re-login with the stored owner
   *  credentials — the owner-directed "set up Towbook and forget" behavior). */
  recoverSession?: (orgId: string) => Promise<RecoveryResult>;
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
 *  and needs a human; escalated=true marks rows the ops queue must surface.
 *  `offer_lost_race` = the accept POST itself was a no-op because another
 *  provider already accepted the broadcast offer ("already been responded to
 *  with an Accept") — the job is COVERED by the winner, so this is a calm
 *  non-escalating record, NOT a needs-a-human error (owner-reported 2026-08-11:
 *  offers 326636200 + 326600476 were falsely escalated on this exact reply). */
export type AiDispatcherDecision =
  | "auto_accept_with_driver"
  | "auto_accept_no_driver"
  | "offer_lost_race"
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

/* ------------------ queue-aware capacity (owner-directed 2026-08-11) ------------------
 * A driver may hold up to MAX_DRIVER_QUEUE active (queued) jobs at a time.
 * Active = the lifecycle statuses new/offered/accepted/en_route/arrived
 * (completed/cancelled are terminal and never count). An incoming offer goes
 * to the NEAREST driver with < MAX_DRIVER_QUEUE jobs (by road-aware ETA, as
 * before); when EVERY candidate is at the cap, the engine dispatches to
 * whoever would ARRIVE fastest after finishing their queue: queue travel
 * between consecutive job pickups + SERVICE_MINUTES_PER_JOB of on-scene time
 * per queued job + the road leg to the incoming offer — and quotes THAT
 * queue-inclusive ETA (still clamped to [floor, ceiling]). */

/** Owner cap (2026-08-11): a driver with this many active jobs is NOT
 *  eligible for a new auto-dispatch. */
export const MAX_DRIVER_QUEUE = 3;

/** Tunable on-scene service-time estimate per queued job (minutes) used by the
 *  all-loaded queue-inclusive arrival model. Tune with the owner when real
 *  service-time data accumulates. */
export const SERVICE_MINUTES_PER_JOB = 30;

/** dispatch_jobs lifecycle statuses that count toward a driver's queue
 *  (terminal states never count). */
export const ACTIVE_JOB_STATUSES = ["new", "offered", "accepted", "en_route", "arrived"] as const;

/** Towbook status ids that count as active when the nearestDrivers payload
 *  carries a driver's `calls` (0 new, 1 offered, 2 accepted, 3 en_route,
 *  4 arrived; 5/252 completed and 255 cancelled never count). An UNKNOWN
 *  status counts conservatively (never under-count a driver's load). */
const ACTIVE_TOWBOOK_STATUS_IDS = new Set([0, 1, 2, 3, 4]);

/** A GPS ping older than this (minutes) is surfaced in the decision reason as
 *  stale — never silently quoted on an old ping (ETA honesty 2026-08-11). The
 *  live nearestDrivers payload carries no ping timestamp today, so this only
 *  fires when a payload starts including one (best-effort, future-proof). */
const STALE_GPS_MINUTES = 5;

/** One queued (active) job for a driver, with the pickup coords the queue
 *  travel model needs. Jobs are ordered the driver will do them (oldest
 *  created/assigned first — FIFO, the natural dispatch assumption). */
export type QueuedJob = {
  pickupLat: number;
  pickupLng: number;
  status: string;
  createdAt: string;
};

/** A driver's queue, from the org's dispatch_jobs (the sync already persists
 *  calls with the assigned driver + pickup lat/lng): the active-job count and
 *  the queued jobs that carry usable pickup coords (only those are routable —
 *  a job without coords still counts toward the cap). */
export type DriverQueue = {
  activeCount: number;
  queuedJobs: QueuedJob[];
};

/** Load every driver's queue for an org from dispatch_jobs — ONE org-scoped
 *  read (indexed by dispatch_jobs_org_idx), no live Towbook calls in the
 *  selection path (owner-directed: use what's already stored). Terminal
 *  statuses are excluded by the WHERE clause; rows are ordered oldest-first
 *  (the queue order the driver will work). */
export async function loadOrgDriverQueues(orgId: string): Promise<Map<string, DriverQueue>> {
  const rows = await sql()`SELECT assigned_driver_towbook_id AS did, status, pickup_lat, pickup_lng, created_at
    FROM dispatch_jobs
    WHERE org_id=${orgId}
      AND assigned_driver_towbook_id IS NOT NULL
      AND status IN ('new','offered','accepted','en_route','arrived')
    ORDER BY created_at ASC`;
  const map = new Map<string, DriverQueue>();
  for (const r of rows as Array<Record<string, unknown>>) {
    const did = String(r.did ?? "");
    if (!did) continue;
    const entry = map.get(did) ?? { activeCount: 0, queuedJobs: [] };
    entry.activeCount++;
    const lat = Number(r.pickup_lat);
    const lng = Number(r.pickup_lng);
    if (Number.isFinite(lat) && lat !== 0 && Number.isFinite(lng) && lng !== 0) {
      entry.queuedJobs.push({ pickupLat: lat, pickupLng: lng, status: String(r.status ?? ""), createdAt: String(r.created_at ?? "") });
    }
    map.set(did, entry);
  }
  return map;
}

/** Active calls the nearestDrivers payload carries for a driver (statuses 0-4;
 *  unknown status counts conservatively; completed/cancelled never count).
 *  Each call's own pickup coords are kept when present (real payload evidence:
 *  every call entry carries latitude/longitude of its pickup) — they backfill
 *  queue geometry when dispatch_jobs lags the payload. */
function activePayloadCalls(driver: NearestDriver): Array<{ pickupLat: number; pickupLng: number }> {
  const calls = (driver as Record<string, unknown>).calls;
  if (!Array.isArray(calls)) return [];
  const out: Array<{ pickupLat: number; pickupLng: number }> = [];
  for (const c of calls) {
    if (!c || typeof c !== "object") { out.push({ pickupLat: NaN, pickupLng: NaN }); continue; }
    const s = Number((c as Record<string, unknown>).status);
    if (Number.isFinite(s) && !ACTIVE_TOWBOOK_STATUS_IDS.has(s)) continue;
    const lat = Number((c as Record<string, unknown>).latitude);
    const lng = Number((c as Record<string, unknown>).longitude);
    out.push(Number.isFinite(lat) && Number.isFinite(lng) ? { pickupLat: lat, pickupLng: lng } : { pickupLat: NaN, pickupLng: NaN });
  }
  return out;
}

/** A driver's total active-job count = max(dispatch_jobs queue, payload calls)
 *  — the max is deliberately conservative so a 3s sync lag can never
 *  under-count a driver's load (capacity rails protect the drivers). */
export function driverActiveCount(driver: NearestDriver, queues: Map<string, DriverQueue>): number {
  const payload = activePayloadCalls(driver).length;
  const db = queues.get(String((driver as Record<string, unknown>).driverId))?.activeCount ?? 0;
  return Math.max(payload, db);
}

/** The driver's queue geometry for the arrival model: dispatch_jobs jobs
 *  first (ordered), then any payload calls whose coords the sync hasn't
 *  persisted yet (deduped by position — the db count is authoritative). */
function queueGeometryFor(driver: NearestDriver, queues: Map<string, DriverQueue>): QueuedJob[] {
  const db = queues.get(String((driver as Record<string, unknown>).driverId));
  const jobs = [...(db?.queuedJobs ?? [])];
  const payload = activePayloadCalls(driver);
  for (let i = (db?.activeCount ?? 0) - (db?.queuedJobs.length ?? 0); i < payload.length; i++) {
    const p = payload[i];
    if (Number.isFinite(p.pickupLat) && Number.isFinite(p.pickupLng)) {
      jobs.push({ pickupLat: p.pickupLat, pickupLng: p.pickupLng, status: "payload", createdAt: "" });
    }
  }
  return jobs;
}

/** Best-effort GPS ping age (minutes) for a driver, from the payload fields
 *  that plausibly carry a last-ping timestamp (none exists in today's live
 *  payload — scanned defensively). Returns null when no timestamp is present
 *  or it is unparseable; the caller surfaces a STALE ping in the reason. */
export function gpsPingAgeMinutes(driver: NearestDriver): number | null {
  const o = driver as Record<string, unknown>;
  const keys = ["lastCheckInUtc", "lastCheckInDateUtc", "lastGpsUtc", "gpsUpdatedAtUtc", "lastPingUtc", "checkInDateUtc", "lastSeenUtc", "gpsPingEpochMs", "lastPingEpochMs"];
  for (const k of keys) {
    const v = o[k];
    if (v == null) continue;
    let ms: number | null = null;
    if (typeof v === "number" && Number.isFinite(v)) {
      ms = v > 1e12 ? v : v * 1000; // epoch ms (or seconds)
    } else if (typeof v === "string" && v.trim() !== "") {
      const t = Date.parse(v);
      if (Number.isFinite(t)) ms = t;
      else if (/^\d+(\.\d+)?$/.test(v.trim())) ms = Number(v.trim()) > 1e12 ? Number(v.trim()) : Number(v.trim()) * 1000;
    }
    if (ms != null && Number.isFinite(ms)) {
      const ageMin = (Date.now() - ms) / 60000;
      if (Number.isFinite(ageMin) && ageMin >= 0) return ageMin;
    }
  }
  return null;
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

/** One TomTom attempt: the RoadResult (or null) PLUS a short failure reason
 *  ("HTTP 429" / "HTTP 5xx" / "timeout" / "network" / "bad body") when the
 *  call failed. The failure reason is what the chained router attaches to the
 *  OSRM fallback so the decision ledger is honest about WHY live traffic was
 *  not used (ETA honesty, 2026-08-11 incident: OSRM-only 150s quote vs the
 *  TomTom live 283s for the same pair — the transient TomTom failure must be
 *  visible, not silently swallowed). */
async function tomtomAttempt(
  apiKey: string,
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  fetchImpl: typeof fetch,
): Promise<{ result: RoadResult | null; failure: string | null }> {
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
    if (!res.ok) return { result: null, failure: `HTTP ${res.status}` };
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return { result: null, failure: "bad body" };
    const routes = (body as Record<string, unknown>).routes;
    if (!Array.isArray(routes) || !routes.length) return { result: null, failure: "bad shape" };
    const summary = (routes[0] as Record<string, unknown>).summary as Record<string, unknown> | undefined;
    if (!summary || typeof summary !== "object") return { result: null, failure: "bad shape" };
    const travel = Number(summary.travelTimeInSeconds);
    if (!Number.isFinite(travel) || travel <= 0) return { result: null, failure: "bad shape" };
    const delay = Number(summary.trafficDelayInSeconds);
    const delaySec = Number.isFinite(delay) && delay > 0 ? delay : 0;
    return {
      result: {
        seconds: travel,
        provider: "tomtom",
        liveTraffic: true,
        trafficDelaySeconds: delaySec,
        notes: `travel ${travel}s; traffic delay ${delaySec}s`,
      },
      failure: null,
    };
  } catch (err) {
    const msg = String(err);
    return { result: null, failure: msg.includes("timeout") ? "timeout" : "network" };
  }
}

/** Default road router, link 1 of the ETA v3 chain: TomTom Routing with live
 *  traffic + construction awareness (traffic=true, routeType=fastest, and
 *  departAt=<now> so the route reflects current conditions). drive time =
 *  routes[0].summary.travelTimeInSeconds; the extra traffic delay is carried
 *  separately (summary.trafficDelayInSeconds) and reported in notes + the
 *  decision row. vehicleCommercial=false keeps the route on LIGHT-DUTY rules
 *  (our trucks are not commercial-vehicle restricted). Returns null on ANY
 *  failure (429/5xx/network/timeout/bad shape) so the chain falls through to
 *  OSRM. The API key is supplied by resolveTomtomKey (env or the stable key
 *  file) — it is never logged, stored, or serialized. */
export async function tomtomRoadSeconds(
  apiKey: string,
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RoadResult | null> {
  const attempt = await tomtomAttempt(apiKey, fromLat, fromLng, toLat, toLng, fetchImpl);
  return attempt.result;
}

/** Site root (walked up from this module — source runs, tests, and the
 *  published bundle all land on the same directory: the one with
 *  package.json). */
const SITE_ROOT = findSiteRoot(import.meta.url);
/** Stable, publish-proof TomTom key path: sibling of the site root, OUTSIDE
 *  the repo and outside the build output — /home/team/shared/.secrets/tomtom.key
 *  for this deployment (the same pattern as the Towbook session key,
 *  towbook-key.ts). A publish/clean rebuild can never touch it. */
const STABLE_TOMTOM_KEY_FILE = join(dirname(SITE_ROOT), ".secrets", "tomtom.key");
/** Artifact fallbacks (mirror b2-client.ts ARTIFACT_DIRS): the hosted live
 *  deployment cannot read the machine-local sibling dir, so the build embeds
 *  the key at <site-root>/dist/.secrets (preferred over the source-tree
 *  .secrets, which only local source runs would have). */
const ARTIFACT_TOMTOM_KEY_FILES = [
  join(SITE_ROOT, "dist", ".secrets", "tomtom.key"),
  join(SITE_ROOT, ".secrets", "tomtom.key"),
];

/** Resolve the TomTom Routing API key for this deployment. Resolution order
 *  (first match wins, mirroring the Towbook session key + b2-client):
 *    1. env TOMTOM_API_KEY — non-empty (trimmed).
 *    2. env TOMTOM_KEY_FILE — an explicit key-file path (unreadable → null, so
 *       the chain degrades instead of crashing, and hermetic tests can pin a
 *       broken path to force "no key" without touching any real key file).
 *    3. The stable key file at <site-root-parent>/.secrets/tomtom.key (outside
 *       the repo and the build output).
 *    4. The artifact key files at <site-root>/dist/.secrets/tomtom.key then
 *       <site-root>/.secrets/tomtom.key (the hosted live deployment cannot
 *       read the machine-local sibling dir, so the build embeds the key).
 *  Returns null when nothing is configured. Whitespace/newlines are trimmed
 *  (a key file with a trailing newline resolves cleanly). The key VALUE is
 *  never logged, stored, or serialized — callers expose only the boolean
 *  (tomtomKeyConfigured).
 *
 *  Hermeticity (mirror loadB2Config): when opts.stableKeyFile is passed (tests
 *  pin their fixtures) the artifact fallback files are NOT consulted, so a
 *  test can never accidentally resolve the real production key. The artifact
 *  fallback applies only on the production path (no stableKeyFile override),
 *  or when the caller explicitly opts in with allowArtifactFallback
 *  (verification harnesses). */
export function resolveTomtomKey(
  env: Record<string, string | undefined>,
  opts: { stableKeyFile?: string; allowArtifactFallback?: boolean } = {},
): string | null {
  const fromEnv = (env.TOMTOM_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const explicitFile = (env.TOMTOM_KEY_FILE ?? "").trim();
  if (explicitFile) {
    try {
      return readFileSync(explicitFile, "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  const stableFile = opts.stableKeyFile ?? STABLE_TOMTOM_KEY_FILE;
  try {
    const v = readFileSync(stableFile, "utf8").trim();
    if (v) return v;
  } catch { /* fall through to the artifact copies */ }
  const artifactFiles = opts.stableKeyFile && !opts.allowArtifactFallback ? [] : ARTIFACT_TOMTOM_KEY_FILES;
  for (const file of artifactFiles) {
    try {
      const v = readFileSync(file, "utf8").trim();
      if (v) return v;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** ETA v3 provider selection. Chain: TomTom (live traffic + construction, only
 *  when a TomTom key is configured — env TOMTOM_API_KEY or the stable key file
 *  via resolveTomtomKey) → OSRM static → haversine factor model (caller side).
 *  With NO key the behavior is exactly the pre-traffic default: OSRM, then the
 *  factor model. The TomTom provider internally falls through to OSRM on any
 *  TomTom failure, so a 429/5xx never loses the ETA. ETA_ROUTER=off is the
 *  explicit opt-out: no routing calls at all, straight to the factor model.
 *  The env bag is injectable so tests never touch process.env. */
export function resolveRouter(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = globalThis.fetch,
): ResolvedRouter {
  const key = resolveTomtomKey(env);
  if (key) {
    return {
      provider: "tomtom",
      tomtomKeyConfigured: true,
      router: async (fromLat, fromLng, toLat, toLng) => {
        const attempt = await tomtomAttempt(key, fromLat, fromLng, toLat, toLng, fetchImpl);
        if (attempt.result) return attempt.result;
        // TomTom failed (transient 429/5xx/timeout/network/bad shape) — fall
        // through to OSRM and CARRY the failure so the decision reason is
        // honest about why live traffic was not used (ETA honesty 2026-08-11).
        const osrm = await osrmRoadSeconds(fromLat, fromLng, toLat, toLng, fetchImpl);
        if (osrm) return { ...osrm, tomtomFailure: attempt.failure ?? "unavailable" };
        return null;
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
 *  which ETA provider is active for this deployment + whether a TomTom key is
 *  configured (env or the stable key file) — the boolean only, never the key. */
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
  /** Motor-club purchase order number — the field that TIES the created call
   *  to this offer (every observed call record carries `purchaseOrderNumber`;
   *  the offer carries it as the "Dispatch #"). Captured so post-accept
   *  verification can locate the call by PO instead of the unsafe "newest in
   *  list" guess (2026-08-12: the PO was never captured, the PO-match branch
   *  was dead code, and the newest fallback re-matched stale calls). */
  purchaseOrderNumber: string | null;
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
  // Purchase order: the offer's "Dispatch #" that the created call mirrors —
  // the ONLY reliable tie between offer and call (calls carry no callRequestId).
  const purchaseOrderNumber =
    typeof o.purchaseOrderNumber === "string" && o.purchaseOrderNumber.trim() !== ""
      ? o.purchaseOrderNumber.trim()
      : o.purchaseOrderNumber != null && typeof o.purchaseOrderNumber !== "object"
        ? String(o.purchaseOrderNumber)
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
      purchaseOrderNumber,
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
   *  succeeded, fallback-model minutes when it failed. For the all-loaded
   *  queue case this is the QUEUE-INCLUSIVE arrival minutes (queue travel +
   *  service + final leg to the offer). */
  baseMinutes: number;
  /** Towbook straight-line minutes (informational; the old ETA source). */
  straightLineMinutes: number;
  /** True when the router failed and the fallback factor model was used. */
  usedFallback: boolean;
  /** Which provider produced the drive time: "tomtom" (live traffic),
   *  "osrm" (static), or "factor" (fallback model — usedFallback true). For
   *  the all-loaded queue case: the FINAL leg's provider (the leg to the
   *  offer). */
  provider: EtaProvider;
  /** True when the drive time reflects live traffic (TomTom traffic=true). */
  liveTraffic: boolean;
  /** TomTom trafficDelayInSeconds when TomTom reported it (osrm/factor: null). */
  trafficDelaySeconds: number | null;
  /** Router notes (TomTom travel/delay detail; osrm static; null on fallback). */
  routerNotes: string | null;
  /** True when this choice came from the workload-aware chain model (the
   *  driver had active jobs; previously only the all-loaded queue-inclusive
   *  path, now ANY busy driver — owner-directed 2026-08-11). */
  queueInclusive: boolean;
  /** Queue travel + service minutes (workload-aware case only; null otherwise). */
  queueMinutes: number | null;
  /** Number of active jobs modeled (workload-aware case only; null otherwise). */
  queuedJobCount: number | null;
  /** Final road leg minutes last-job-location → offer (workload-aware only). */
  finalLegMinutes: number | null;
  /** True when the driver was already ON SCENE at their current job (arrived)
   *  — the chain starts at that job's service time, no GPS→pickup leg
   *  (workload-aware only; null otherwise). */
  startedOnScene: boolean | null;
  /** Active jobs with no pickup coords, estimated as service time at the tail
   *  (workload-aware only; 0/null otherwise). */
  unlocatedJobs: number | null;
  /** Why TomTom live traffic was NOT used (chained fallback; null = TomTom OK
   *  or no TomTom key). ETA honesty: transient TomTom failures are recorded. */
  tomtomFailure: string | null;
  /** GPS ping age in minutes when the payload carried a timestamp (null when
   *  the payload has none). A stale ping is surfaced in the decision reason. */
  gpsPingAgeMinutes: number | null;
};

/** Workload-aware arrival model (owner-directed 2026-08-11): a driver with
 *  active jobs can't start the offer until those jobs are done, so their REAL
 *  earliest arrival is
 *    (remaining time on the current/in-progress job)
 *    + Σ over subsequent queued jobs of (road travel from the PREVIOUS job's
 *      pickup to THIS job's pickup + SERVICE_MINUTES_PER_JOB on-scene time)
 *    + the road leg from the LAST job's pickup to the incoming offer.
 *  A driver already ARRIVED at the current job contributes only on-scene
 *  service time for it — no GPS→pickup leg (owner formula: "remaining time on
 *  any current/in-progress job" + "travel from the CURRENT job's location to
 *  the NEXT pickup, not from the driver's last GPS ping"). A driver EN ROUTE
 *  to the current job contributes GPS→pickup travel + service (no progress
 *  data exists, so the remaining drive is at most that — errs toward a longer,
 *  safer ETA). Active jobs that carry no pickup coords (unlocated) contribute
 *  their service time at the tail — never dropped from the workload, never
 *  routed blind. Every travel leg uses the road router (TomTom → OSRM chain)
 *  with the straight-line factor model as per-leg fallback — never fabricated.
 *  Returns null only when the driver has NO active jobs at all (free — the
 *  caller uses current-position travel instead). `activeCount` is the driver's
 *  TOTAL active-job count (may exceed queue.length when some jobs lack coords);
 *  it defaults to queue.length so callers that only have geometry stay correct. */
export async function workloadAwareArrivalMinutes(
  driver: NearestDriver,
  queue: QueuedJob[],
  pickupLat: number,
  pickupLng: number,
  roadRouter: RoadRouter | null,
  activeCount?: number,
): Promise<{
  arrivalMinutes: number;
  queueMinutes: number;
  finalLegMinutes: number;
  finalLegProvider: EtaProvider;
  startedOnScene: boolean;
  unlocatedJobs: number;
  /** First TomTom failure seen on ANY chain leg (a leg that fell back to
   *  OSRM/factor after TomTom failed). Lets the decision record be honest
   *  about live traffic NOT being used for part of the chain (ETA honesty). */
  tomtomFailure: string | null;
} | null> {
  const total = activeCount != null && Number.isFinite(activeCount) && activeCount >= 0
    ? Math.round(activeCount)
    : queue.length;
  if (total === 0) return null; // free driver — current-position travel is the caller's model
  let chainTomtomFailure: string | null = null;
  const legMinutes = async (fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<{ minutes: number; provider: EtaProvider }> => {
    let result: RoadResult | null = null;
    try {
      result = roadRouter ? await roadRouter(fromLat, fromLng, toLat, toLng) : null;
    } catch { result = null; }
    if (result && Number.isFinite(result.seconds) && result.seconds > 0) {
      if (result.tomtomFailure && !chainTomtomFailure) chainTomtomFailure = result.tomtomFailure;
      return { minutes: result.seconds / 60, provider: result.provider };
    }
    return { minutes: fallbackRoadMinutes(haversineMiles(fromLat, fromLng, toLat, toLng)), provider: "factor" };
  };
  const lat = Number(driver.latitude);
  const lng = Number(driver.longitude);
  const unlocatedJobs = Math.max(0, total - queue.length);
  let queueMinutes = 0;
  let prevLat = lat;
  let prevLng = lng;
  let startedOnScene = false;
  if (queue.length) {
    const first = queue[0];
    if (first.status === "arrived") {
      // Already ON the current job — remaining = on-scene service only; the
      // chain to the NEXT job starts from THIS job's location (owner formula —
      // never from the driver's last GPS ping).
      startedOnScene = true;
      queueMinutes += SERVICE_MINUTES_PER_JOB;
      prevLat = first.pickupLat;
      prevLng = first.pickupLng;
      for (let i = 1; i < queue.length; i++) {
        const leg = await legMinutes(prevLat, prevLng, queue[i].pickupLat, queue[i].pickupLng);
        queueMinutes += leg.minutes + SERVICE_MINUTES_PER_JOB;
        prevLat = queue[i].pickupLat;
        prevLng = queue[i].pickupLng;
      }
    } else {
      for (const job of queue) {
        const leg = await legMinutes(prevLat, prevLng, job.pickupLat, job.pickupLng);
        queueMinutes += leg.minutes + SERVICE_MINUTES_PER_JOB;
        prevLat = job.pickupLat;
        prevLng = job.pickupLng;
      }
    }
  }
  // Unlocated active jobs (no pickup coords): their on-scene service time is
  // still real workload — estimate it at the tail (never dropped, never routed
  // blind).
  if (unlocatedJobs > 0) queueMinutes += SERVICE_MINUTES_PER_JOB * unlocatedJobs;
  // Final leg: from the LAST job's location to the offer — NOT from the
  // driver's GPS (they are at the last job when this leg begins).
  const finalLeg = await legMinutes(prevLat, prevLng, pickupLat, pickupLng);
  return {
    arrivalMinutes: queueMinutes + finalLeg.minutes,
    queueMinutes,
    finalLegMinutes: finalLeg.minutes,
    finalLegProvider: finalLeg.provider,
    startedOnScene,
    unlocatedJobs,
    tomtomFailure: chainTomtomFailure,
  };
}

/** Road-aware driver choice (owner-directed 2026-08-11, queue-aware):
 *  rails = checked in && real GPS (lat/lng nonzero AND finite) && finite
 *  estimatedTimeSeconds && active-job-count < MAX_DRIVER_QUEUE (active =
 *  dispatch_jobs lifecycle statuses new/offered/accepted/en_route/arrived,
 *  cross-checked against the payload `calls` — a driver at the 3-job cap is
 *  NOT eligible). Each ELIGIBLE candidate is routed from its precise GPS to
 *  the pickup and the minimum ROAD ETA wins — a driver with a better real
 *  drive time beats one with a better straight-line time. Routing failures
 *  fall back to the factor model per candidate, so a driver is never dropped
 *  for a router hiccup.
 *  ALL-LOADED path: when EVERY candidate is at the cap, dispatch to whoever
 *  would ARRIVE fastest after their queue — queue travel between consecutive
 *  job pickups + SERVICE_MINUTES_PER_JOB per queued job + the road leg to the
 *  offer (queueInclusiveArrivalMinutes) — and baseMinutes carries that
 *  queue-inclusive arrival so the quoted ETA tracks reality.
 *  `roadRouter` may be null (routing disabled — every leg uses the factor
 *  model). Returns null when no driver qualifies (→ accept with driverId 0 +
 *  escalate; no ETA quoted). */
export async function chooseBestDriverByRoad(
  drivers: unknown[],
  pickupLat: number,
  pickupLng: number,
  roadRouter: RoadRouter | null,
  driverQueues?: Map<string, DriverQueue>,
): Promise<ChosenDriverEta | null> {
  const queues = driverQueues ?? new Map<string, DriverQueue>();
  const baseEligible = drivers.filter((d): d is NearestDriver => {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    const o = d as NearestDriver;
    return (
      o.isCheckedIn === true &&
      typeof o.latitude === "number" && Number.isFinite(o.latitude) && o.latitude !== 0 &&
      typeof o.longitude === "number" && Number.isFinite(o.longitude) && o.longitude !== 0 &&
      typeof o.estimatedTimeSeconds === "number" && Number.isFinite(o.estimatedTimeSeconds)
    );
  });
  if (!baseEligible.length) return null;

  const underCap = baseEligible.filter((d) => driverActiveCount(d, queues) < MAX_DRIVER_QUEUE);
  const pickCandidates = underCap.length ? underCap : baseEligible;
  const routeOne = async (d: NearestDriver): Promise<ChosenDriverEta | null> => {
    const straightLineMinutes = Math.max(1, Math.ceil(Number(d.estimatedTimeSeconds) / 60));
    const pingAge = gpsPingAgeMinutes(d);
    const activeCount = driverActiveCount(d, queues);
    if (activeCount > 0) {
      // Workload-aware (owner-directed 2026-08-11): a driver with active jobs
      // must finish them before this offer — remaining on the in-progress job
      // + travel between consecutive job pickups + the final leg from the LAST
      // job's location to the offer. A busy driver is always modelable
      // (unlocated jobs contribute their service time at the tail), so the
      // chain never fails here.
      const geometry = queueGeometryFor(d, queues);
      const chain = await workloadAwareArrivalMinutes(d, geometry, pickupLat, pickupLng, roadRouter, activeCount);
      if (chain) {
        return {
          driver: d,
          roadSeconds: null,
          baseMinutes: Math.max(1, chain.arrivalMinutes),
          straightLineMinutes,
          usedFallback: chain.finalLegProvider === "factor",
          provider: chain.finalLegProvider,
          liveTraffic: chain.finalLegProvider === "tomtom",
          trafficDelaySeconds: null,
          routerNotes: `workload-aware; ${activeCount} active jobs${chain.unlocatedJobs > 0 ? ` (+${chain.unlocatedJobs} unlocated ≈ service time)` : ""}`,
          queueInclusive: true,
          queueMinutes: chain.queueMinutes,
          queuedJobCount: activeCount,
          finalLegMinutes: chain.finalLegMinutes,
          startedOnScene: chain.startedOnScene,
          unlocatedJobs: chain.unlocatedJobs,
          tomtomFailure: chain.tomtomFailure,
          gpsPingAgeMinutes: pingAge,
        };
      }
      return null; // free-only guard; busy drivers are always modelable
    }
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
        queueInclusive: false,
        queueMinutes: null,
        queuedJobCount: null,
        finalLegMinutes: null,
        startedOnScene: null,
        unlocatedJobs: null,
        tomtomFailure: result.tomtomFailure ?? null,
        gpsPingAgeMinutes: pingAge,
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
      queueInclusive: false,
      queueMinutes: null,
      queuedJobCount: null,
      finalLegMinutes: null,
      startedOnScene: null,
      unlocatedJobs: null,
      tomtomFailure: null,
      gpsPingAgeMinutes: pingAge,
    };
  };

  if (underCap.length) {
    const routed = (await Promise.all(pickCandidates.map(routeOne))).filter((r): r is ChosenDriverEta => r != null);
    routed.sort((a, b) =>
      a.baseMinutes - b.baseMinutes ||
      String(a.driver.driverId ?? "").localeCompare(String(b.driver.driverId ?? "")));
    return routed[0] ?? null;
  }

  // --- all-loaded: EVERY candidate is at the cap → chain-aware arrival ---
  const modeled = await Promise.all(baseEligible.map(async (d): Promise<ChosenDriverEta | null> => {
    const geometry = queueGeometryFor(d, queues);
    const arrival = await workloadAwareArrivalMinutes(d, geometry, pickupLat, pickupLng, roadRouter, driverActiveCount(d, queues));
    if (!arrival) return null; // free driver — cannot be in the all-loaded path
    const straightLineMinutes = Math.max(1, Math.ceil(Number(d.estimatedTimeSeconds) / 60));
    const activeCount = driverActiveCount(d, queues);
    return {
      driver: d,
      roadSeconds: null,
      baseMinutes: arrival.arrivalMinutes,
      straightLineMinutes,
      usedFallback: arrival.finalLegProvider === "factor",
      provider: arrival.finalLegProvider,
      liveTraffic: arrival.finalLegProvider === "tomtom",
      trafficDelaySeconds: null,
      routerNotes: `workload-aware; ${geometry.length} queued jobs`,
      queueInclusive: true,
      queueMinutes: arrival.queueMinutes,
      queuedJobCount: activeCount,
      finalLegMinutes: arrival.finalLegMinutes,
      startedOnScene: arrival.startedOnScene,
      unlocatedJobs: arrival.unlocatedJobs,
      tomtomFailure: arrival.tomtomFailure,
      gpsPingAgeMinutes: gpsPingAgeMinutes(d),
    };
  }));
  const winners = modeled.filter((m): m is ChosenDriverEta => m != null);
  if (!winners.length) return null;
  winners.sort((a, b) =>
    a.baseMinutes - b.baseMinutes ||
    String(a.driver.driverId ?? "").localeCompare(String(b.driver.driverId ?? "")));
  return winners[0];
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
 *  … (factor model)". Workload-aware chain case (any busy driver, owner
 *  2026-08-11): "ETA 125 min (workload-aware: 3 active jobs ≈ 110 min (incl.
 *  30-min service/job) + final leg 10 (osrm) + buffer 5; floor 5, ceiling 45;
 *  straight-line 11; GPS 41.15,-73.10)" — with "; already on-scene at current
 *  job" when the driver is arrived at job 1 and "; +1 unlocated ≈ service"
 *  when an active job lacks pickup coords. A transient TomTom failure is
 *  surfaced ("tomtom failed (HTTP 429) → osrm") and a stale GPS ping is
 *  flagged ("GPS ping age 30 min") — ETA honesty (2026-08-11). */
export function etaDetailLabel(c: ChosenDriverEta, buffer: number, floor: number, ceiling: number, finalMinutes: number): string {
  const base = c.queueInclusive
    ? `workload-aware: ${c.queuedJobCount ?? 0} active jobs ≈ ${Math.round(c.queueMinutes ?? 0)} min (incl. ${SERVICE_MINUTES_PER_JOB}-min service/job) + final leg ${Math.round(c.finalLegMinutes ?? 0)} (${c.provider === "tomtom" ? "tomtom-traffic" : c.provider === "osrm" ? "osrm" : "factor"})${c.startedOnScene ? "; already on-scene at current job" : ""}${c.unlocatedJobs ? `; +${c.unlocatedJobs} unlocated ≈ service` : ""}`
    : c.usedFallback
      ? `road fallback ${c.baseMinutes} (factor model)`
      : c.provider === "tomtom"
        ? `tomtom-traffic road ${c.baseMinutes}`
        : `osrm road ${c.baseMinutes}`;
  const delay = !c.queueInclusive && !c.usedFallback && c.provider === "tomtom" && c.trafficDelaySeconds != null && c.trafficDelaySeconds > 0
    ? `; delay ${Math.round(c.trafficDelaySeconds / 60)}`
    : "";
  const tomtomNote = c.tomtomFailure ? `; tomtom failed (${c.tomtomFailure}) → ${c.provider}` : "";
  const pingNote = c.gpsPingAgeMinutes != null && c.gpsPingAgeMinutes >= STALE_GPS_MINUTES
    ? `; GPS ping age ${Math.round(c.gpsPingAgeMinutes)} min`
    : "";
  return `ETA ${finalMinutes} min (${base} + buffer ${buffer}${delay}${tomtomNote}${pingNote}; floor ${floor}, ceiling ${ceiling}; straight-line ${c.straightLineMinutes}; GPS ${Number(c.driver.latitude)},${Number(c.driver.longitude)})`;
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
      headers: init?.body
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

/* --------------------------- session self-healing --------------------------- */
/* Owner-directed 2026-08-11 ("set up Towbook and forget"): an expired stored
 * session must be healed by the engine itself, not by the owner. These helpers
 * classify a Towbook API response as session-dead (401/403, or a 200 that is
 * actually the MVC login page — the same fingerprint status-push-core uses)
 * and reload the org's OWNER session row after recovery. */

/** True when a Towbook API response means the stored session is dead. */
const SESSION_EXPIRED_STATUSES = new Set([401, 403]);
function isSessionExpiredResponse(r: FetchResult): boolean {
  if (r.status != null && SESSION_EXPIRED_STATUSES.has(r.status)) return true;
  return r.status === 200 && typeof r.body === "string" && /<form/i.test(r.body) && /RequestVerificationToken/i.test(r.body);
}
const hasSessionExpiredAttempt = (attempts: FetchResult[]): boolean => attempts.some(isSessionExpiredResponse);
const hasSessionExpiredVerification = (attempts: DispatchVerification["attempts"]): boolean =>
  attempts.some((a) => a.status != null && SESSION_EXPIRED_STATUSES.has(a.status));

/** Load + decrypt the org's owner Towbook session (cookie jar + base URL), or
 *  null when there is no usable connected owner row. Used to pick up the
 *  freshly recovered session after recoverTowbookSession rewrites the row. */
async function loadOwnerSession(orgId: string): Promise<{ cookie: string; baseUrl: string } | null> {
  const sess = await sql()`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${orgId} AND session_kind='owner'`;
  if (!sess.length || String(sess[0].status) !== "connected" || !String(sess[0].encrypted_session || "").length) return null;
  try {
    const plain = await decryptSession(String(sess[0].encrypted_session));
    const parsed = JSON.parse(plain) as { cookies?: string; baseUrl?: string };
    return { cookie: parsed.cookies || "", baseUrl: parsed.baseUrl || "https://app.towbook.com" };
  } catch {
    return null;
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
/* --------------------------- lost-race classification ---------------------------
 * Club offers are broadcast to MULTIPLE providers; when another provider accepts
 * first, Towbook's reply to OUR accept POST is "This dispatch offer has already
 * been responded to with an Accept and is currently being processed." That is
 * NOT a failure: the job is covered by the winning provider and no human is
 * needed. Classify it as the calm non-escalating decision `offer_lost_race`
 * instead of the old false-alarm path — accept looked OK (HTTP 200 + message),
 * post-accept verification couldn't find the call (it lives under the winning
 * provider), and the engine escalated_dispatch_failed ("needs a human to assign
 * on Towbook"). Owner-reported 2026-08-11: offers 326636200 (19:09Z) and
 * 326600476 (15:25Z) both hit this exact reply. The match is deliberately TIGHT
 * (the canonical phrase only): genuine accept errors (network/auth/5xx) and
 * genuine "assigned but not verified" cases still escalate. */
const LOST_RACE_ACCEPT_SIGNALS = ["already been responded to with an accept"];
/** True when a response body/raw text carries the Towbook lost-race reply. */
export function acceptResponseIsLostRace(body: unknown): boolean {
  if (body == null) return false;
  const text =
    typeof body === "string" ? body : (() => {
      try {
        return JSON.stringify(body);
      } catch {
        return "";
      }
    })();
  const lower = text.toLowerCase();
  return LOST_RACE_ACCEPT_SIGNALS.some((s) => lower.includes(s));
}
/** True when ANY accept attempt (parsed body or raw text) carries the reply. */
function acceptIsLostRace(accept: { raw: unknown; attempts: FetchResult[] }): boolean {
  if (acceptResponseIsLostRace(accept.raw)) return true;
  return accept.attempts.some((a) => acceptResponseIsLostRace(a.body) || acceptResponseIsLostRace(a.bodyText));
}
/* ------------------------- dispatch verification + retry ------------------------- */
/** The assign endpoint for EXISTING calls is not statically discoverable in the
 *  Towbook UI JS (the Map app's typed client has per-call verbs lock/audit/
 *  Complete/Cancel/... but NO assignDrivers; drag-to-assign code is not in any
 *  fetched bundle). Best-guess candidate following the `/api/calls/{id}/<verb>`
 *  convention; a wrong guess fails harmlessly (404/400 → no state change) and
 *  the engine escalates with evidence instead of claiming a dispatch. */
/** The assign endpoint for EXISTING calls, VERIFIED against the app's own
 *  code (2026-08-11 recon, map-actions.js useDispatchCall): dispatch = PUT
 *  /api/calls/{id} with {id, status:{id:1}, assets:[{id: assetId,
 *  drivers:[{driver:{id: driverId}}]}]} — status 1 (Dispatched) is what makes
 *  the driver app see the offer. The old guess (POST /api/calls/{id}/
 *  assignDrivers) 404s live (proven 2026-08-12 on five offers) — that is why
 *  the assign path never worked. One attempt, never retried: if the PUT fails
 *  we escalate with evidence, we do not spam the live API. */
async function postAssignDriver(
  fetchImpl: typeof fetch,
  baseUrl: string,
  cookie: string,
  callId: string,
  driverId: number,
  assetId: string | null,
): Promise<FetchResult> {
  const url = `${baseUrl}/api/calls/${callId}`;
  const body: Record<string, unknown> = { id: Number(callId) || callId, status: { id: 1 } };
  // Attach the driver to the call's asset exactly like the Map SPA does; when
  // the call carries NO asset the driver cannot be attached — the caller
  // escalates instead of fabricating a "dispatched" status (no asset ⇒ no PUT).
  if (assetId != null) {
    body.assets = [{ id: Number(assetId), drivers: [{ driver: { id: driverId } }] }];
  }
  return towbookFetch(fetchImpl, url, cookie, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
/** First asset (vehicle) id on a call — the Map app's dispatch payload
 *  requires it (assets[0].id). */
function firstAssetIdOnCall(call: Record<string, unknown>): string | null {
  const assets = call.assets;
  if (!Array.isArray(assets) || !assets.length) return null;
  const a = assets[0];
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const id = (a as Record<string, unknown>).id;
  return id != null ? String(id) : null;
}
/** True when a call record carries the offer's callRequestId (any of the
 *  observed shapes: flat, nested {id}, or {callRequestId}). Calls fetched so
 *  far do NOT carry it (the PO is the tie), but if a shape ever does, prefer
 *  it — it is the strongest possible tie. */
function callCarriesRequestId(call: Record<string, unknown>, want: string): boolean {
  for (const k of ["callRequestId", "requestId", "offerId", "callRequest"]) {
    const v = call[k];
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number") {
      if (String(v) === want) return true;
      continue;
    }
    if (typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (o.id != null && String(o.id) === want) return true;
      if (o.callRequestId != null && String(o.callRequestId) === want) return true;
    }
  }
  return false;
}
export type DispatchVerification = {
  /** True only when the chosen driver is actually on the fetched call. */
  ok: boolean;
  callId: string | null;
  statusId: number | null;
  driverOnCall: string | null;
  /** How the call was located: "acceptResponse", "purchaseOrder",
   *  "callRequestId", or "none" (no tie found — escalated, never guessed). */
  source: string;
  /** The call asset (vehicle) id the driver was attached to on the assign PUT
   *  (the Map app's dispatch payload requires assets[0].id); null when the
   *  call carried no asset (assign then cannot attach a driver). */
  assetId: string | null;
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
  callRequestId: string | null,
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
  // Status 0 FIRST — a freshly accepted callRequest creates the call at
  // Received (0). The old [2,1]-only search could never see it: the 2026-08-12
  // evidence shows 4/8 offers escalated "call not found after accept" for
  // exactly that reason. Then 2 (En Route — already dispatched by the club /
  // owner) and 1 (Dispatched) for calls that move fast.
  const po = purchaseOrderNumber != null ? String(purchaseOrderNumber) : null;
  const wantRequestId = callRequestId != null ? String(callRequestId) : null;
  for (const statusId of [0, 2, 1]) {
    const url = `${baseUrl}/api/calls?status=${statusId}`;
    const res = await towbookFetch(fetchImpl, url, cookie);
    fetches.push({ url, status: res.status, error: res.error, matched: false });
    if (!res.ok || !Array.isArray(res.body) || !res.body.length) continue;
    const list = res.body as Array<Record<string, unknown>>;
    // Tie the call to THIS offer — never guess. PO first (every observed call
    // carries purchaseOrderNumber, the offer's "Dispatch #"); then callRequestId
    // for call shapes that carry it. The bare "newest in list" fallback is GONE
    // (2026-08-12): it demonstrably re-matched stale calls (326760451→
    // 279860306; 326762556 & 326762868→both 279865368) and one offer even
    // "verified" a call the OWNER had manually dispatched (326773655→279878088
    // — a false auto_accept_with_driver). If no call can be tied, the caller
    // escalates: verification NEVER claims or assigns a call it cannot tie.
    if (po) {
      const byPo = list.find((c) => String((c as Record<string, unknown>).purchaseOrderNumber ?? "") === po);
      if (byPo) {
        fetches[fetches.length - 1].matched = true;
        return { call: byPo, source: "purchaseOrder", fetches };
      }
    }
    if (wantRequestId) {
      const byRequest = list.find((c) => callCarriesRequestId(c, wantRequestId));
      if (byRequest) {
        fetches[fetches.length - 1].matched = true;
        return { call: byRequest, source: "callRequestId", fetches };
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
    const { call, source, fetches } = await findAcceptedCall(fetchImpl, baseUrl, cookie, acceptResponseId, offer.purchaseOrderNumber, offer.callRequestId);
    const base: DispatchVerification = {
      ok: false, callId: call ? String((call as Record<string, unknown>).id ?? "") : null,
      statusId: call && (call as Record<string, unknown>).status && typeof (call as Record<string, unknown>).status === "object"
        ? Number((((call as Record<string, unknown>).status) as Record<string, unknown>).id) ?? null : null,
      driverOnCall: null, source, assetId: call ? firstAssetIdOnCall(call) : null, assignedAfterRetry: false, found: !!call, attempts: fetches, error: null,
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
  // Assign = PUT /api/calls/{id} {id, status:{id:1}, assets:[{id, drivers:
  // [{driver:{id}}]}]} — the Map app's own dispatch payload (the old
  // POST /assignDrivers guess 404s live). A call with NO asset cannot attach
  // the driver: escalate with evidence, never fabricate a dispatched status.
  if (v.assetId == null) {
    return { ...v, error: `call ${v.callId} has no asset to attach the driver to — ${v.error}` };
  }
  const assignUrl = `${baseUrl}/api/calls/${v.callId}`;
  const assignRes = await postAssignDriver(fetchImpl, baseUrl, cookie, v.callId, driverId, v.assetId);
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
  // Observability (owner-approved backlog #1, 2026-08-11 incident follow-up):
  // every tick persists a run row INSIDE the engine so the trace exists
  // regardless of caller — the 3s background loop, a manual run, or a test.
  // The internal poll returns the run result plus every offer it SAW (id +
  // status, including silent skips); this wrapper writes one cheap INSERT and
  // never lets a write failure crash the sync loop or mask the run result.
  let result: AutoDispatchRunResult;
  let seenOffers: Array<{ id: string; status?: number }> = [];
  try {
    const internal = await runAutoDispatchInternal(orgId, deps, fetchImpl, base);
    result = internal.result;
    seenOffers = internal.seenOffers;
  } catch (err) {
    // Database or unexpected failure — never crash the sync loop.
    result = { ...base, skipped: `engine_error (${String(err).slice(0, 200)})` };
  }
  await persistDispatcherRun(orgId, result, seenOffers);
  return result;
}
/** One cheap INSERT per tick (3s cadence ≈ 28,800 rows/day/org — small rows;
 *  acceptable, but a later cleanup job should prune > 14 days; retention
 *  automation is deliberately NOT built here). Never throws: a failed
 *  run-row write must not crash the sync loop or mask the run result. */
async function persistDispatcherRun(
  orgId: string,
  run: AutoDispatchRunResult,
  seenOffers: Array<{ id: string; status?: number }>,
): Promise<void> {
  try {
    await sql()`INSERT INTO ai_dispatcher_runs(id, org_id, gated, offers_seen, processed, skipped, offer_ids)
      VALUES(gen_random_uuid()::text, ${orgId}, ${run.gated}, ${run.offersSeen}, ${run.processed}, ${run.skipped}, ${JSON.stringify(seenOffers)}::jsonb)`;
  } catch { /* never crash the sync loop on a run-row write */ }
}
/** The engine poll itself (see runAutoDispatch): returns the run result plus
 *  offer_ids for EVERY offer the tick saw — including offers skipped silently
 *  (status!==0, already-processed, shape-failed) — so the run row proves the
 *  engine saw an offer and chose not to touch it. */
async function runAutoDispatchInternal(
  orgId: string,
  deps: AiDispatcherDeps,
  fetchImpl: typeof fetch,
  base: AutoDispatchRunResult,
): Promise<{ result: AutoDispatchRunResult; seenOffers: Array<{ id: string; status?: number }> }> {
  const settings = await getOrgSettings(orgId);
    if (!settings.aiDispatcherEnabled) return { result: { ...base, gated: true }, seenOffers: [] };

    // Session recovery seam: tests inject a mock; production uses the real
    // self-healing re-login (towbook-recovery.ts). The recovery module is
    // server-only (node:fs + node:url for the stable .secrets key) — it must
    // never be statically imported from a client-reachable module, so it is
    // reached by a dynamic import inside this PRIVATE function (tree-shaken
    // out of the client bundle — same pattern as status-push-core).
    const recoverSession: (oid: string) => Promise<RecoveryResult> =
      deps.recoverSession ?? (async (oid: string) => (await import("./towbook-recovery")).recoverTowbookSession(oid));

    const sess = await sql()`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${orgId} AND session_kind='owner'`;
    if (!sess.length || String(sess[0].status) !== "connected" || !String(sess[0].encrypted_session || "").length) {
      return { result: { ...base, skipped: "not_connected" }, seenOffers: [] };
    }
    let cookies: string;
    let baseUrl: string;
    try {
      const plain = await decryptSession(String(sess[0].encrypted_session));
      const parsed = JSON.parse(plain) as { cookies?: string; baseUrl?: string };
      cookies = parsed.cookies || "";
      baseUrl = parsed.baseUrl || "https://app.towbook.com";
    } catch {
      return { result: { ...base, skipped: "session_unavailable" }, seenOffers: [] };
    }

    const offersRes0 = await towbookFetch(fetchImpl, `${baseUrl}/api/callRequests/`, cookies);
    // Self-healing (owner-directed 2026-08-11): a session that died between
    // ticks is healed HERE — detect expiry on ticks, not only at push time —
    // and the feed is retried once with the recovered session so the offer is
    // still processed in this tick. Recovery is throttled + in-flight guarded
    // inside towbook-recovery; a failure keeps the run's skip reason honest.
    let offersRes = offersRes0;
    if (!offersRes.ok && isSessionExpiredResponse(offersRes)) {
      const recovery = await recoverSession(orgId);
      if (recovery.recovered) {
        const fresh = await loadOwnerSession(orgId);
        if (fresh) {
          cookies = fresh.cookie;
          baseUrl = fresh.baseUrl;
          offersRes = await towbookFetch(fetchImpl, `${baseUrl}/api/callRequests/`, cookies);
        }
      } else {
        return { result: { ...base, skipped: `offer_fetch_failed (${offersRes.error ?? offersRes.status}; session recovery failed: ${recovery.reason})` }, seenOffers: [] };
      }
    }
    if (!offersRes.ok) return { result: { ...base, skipped: `offer_fetch_failed (${offersRes.error ?? offersRes.status})` }, seenOffers: [] };
    if (!Array.isArray(offersRes.body)) return { result: { ...base, skipped: "offer_payload_unexpected" }, seenOffers: [] };
    const offers = offersRes.body as unknown[];
    // Every offer this tick SAW, id + status — shape-failed offers are keyed by
    // their content hash (the same pseudo-key the decision ledger uses), and a
    // non-numeric status is omitted (JSON.stringify drops the property).
    const seenOffers = offers.map((rawOffer: unknown) => {
      const shape = validateOfferShape(rawOffer);
      if (shape.ok) return { id: shape.offer.callRequestId, status: shape.offer.status };
      const o = rawOffer as Record<string, unknown>;
      const s = numeric(o?.status);
      return s != null ? { id: shapeKeyOf(rawOffer), status: s } : { id: shapeKeyOf(rawOffer) };
    });
    if (!offers.length) return { result: { ...base, offersSeen: 0 }, seenOffers: [] };

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
      // Queue-aware capacity (owner-directed 2026-08-11): load every driver's
      // active-job count + queue geometry from the org's dispatch_jobs (the
      // sync already persists calls with assigned driver + pickup coords) —
      // one indexed read, no live Towbook calls in the selection path.
      const driverQueues = await loadOrgDriverQueues(orgId);
      const chosen = await chooseBestDriverByRoad(
        candidates,
        offer.startLocationLatitude,
        offer.startLocationLongitude,
        resolved.router,
        driverQueues,
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
        // Workload-aware facts (owner-directed 2026-08-11): when the chosen
        // driver has active jobs, the ETA is the chain model (remaining on the
        // in-progress job + travel between consecutive job pickups + final leg
        // from the LAST job to the offer) — the ledger records the chain math.
        queueInclusive: chosen.queueInclusive,
        queueMinutes: chosen.queueMinutes,
        queuedJobCount: chosen.queuedJobCount,
        finalLegMinutes: chosen.finalLegMinutes,
        startedOnScene: chosen.startedOnScene,
        unlocatedJobs: chosen.unlocatedJobs,
        tomtomFailure: chosen.tomtomFailure,
        gpsPingAgeMinutes: chosen.gpsPingAgeMinutes,
      } : null;
      const allLoadedNote: string | null = null;
      const noDriverReason = driver
        ? null
        : eligibleIds
          ? `no ELIGIBLE checked-in driver with real GPS to quote an honest workload ETA (offer eligible list [${offer.drivers!.join(", ")}]${allLoadedNote ?? ""}; accepted WITHOUT dispatch so the motor-club offer cannot expire or be missed; assign manually, ETA quoted at the ${effectiveMaxEta}-min ceiling — no ETA recorded)`
          : `no checked-in driver with real GPS to quote an honest workload ETA${allLoadedNote ?? ""} — accepted WITHOUT dispatch so the motor-club offer cannot expire or be missed; assign manually (ETA quoted at the SLA ceiling — no ETA recorded)`;
      // --- accept (the ONE state-changing call) — with a self-healing retry:
      // an expired session mid-offer (401/403/login-page on the POST) triggers
      // recovery, and the accept is retried once with the recovered session.
      // Only if recovery or the retry fails is the escalation recorded.
      let accept = await postAccept(fetchImpl, baseUrl, cookies, offer.callRequestId, postEta, driverId, postNotes);
      let acceptRecoveryNote: string | null = null;
      if (!accept.ok && hasSessionExpiredAttempt(accept.attempts)) {
        const recovery = await recoverSession(orgId);
        if (recovery.recovered) {
          const fresh = await loadOwnerSession(orgId);
          if (fresh) {
            cookies = fresh.cookie;
            baseUrl = fresh.baseUrl;
            const retried = await postAccept(fetchImpl, baseUrl, cookies, offer.callRequestId, postEta, driverId, postNotes);
            accept = retried;
            acceptRecoveryNote = "session recovered; accept retried";
          } else {
            acceptRecoveryNote = "session recovered but reload failed";
          }
        } else {
          acceptRecoveryNote = `session recovery failed (${recovery.reason})`;
        }
      }
      // --- lost-race classification (owner-reported 2026-08-11, offers
      // 326636200 + 326600476): when another provider already accepted the
      // broadcast offer, Towbook's accept reply says "already been responded to
      // with an Accept" — the job is COVERED, so record the calm non-escalating
      // decision offer_lost_race and move on (no verify/assign/sync — nothing
      // changed on our side). Before this, the 200+message reply looked like a
      // successful accept, then verification failed ("call not found after
      // accept" — the call lives under the winning provider) and the engine
      // falsely escalated_dispatch_failed "needs a human to assign on Towbook".
      // Runs BEFORE the !accept.ok branch so a non-2xx lost-race reply can never
      // become escalated_accept_failed either. ---
      if (acceptIsLostRace(accept)) {
        const reason = "offer already responded to with an Accept — another provider won the offer; no action needed";
        await record({
          decision: "offer_lost_race",
          driverId: driver ? String(driver.driverId) : null,
          driverName: driver ? String(driver.driverName ?? "") : null,
          etaMinutes, zoneDistanceMiles: zoneDistance, reason,
          rawResponse: { offer, eta: etaFacts, accept: accept.raw, attempts: accept.attempts.map((a) => ({ status: a.status, body: a.body })) },
        });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "offer_lost_race", escalated: false, reason });
        continue;
      }
      if (!accept.ok) {
        const reason = `accept POST failed after retry (${accept.attempts.map((a) => a.error ?? `HTTP ${a.status}`).join("; ")}) — offer NOT auto-accepted, needs a human${acceptRecoveryNote ? `; ${acceptRecoveryNote}` : ""}${chosen ? `; ${etaDetailLabel(chosen, settings.etaBufferMinutes, settings.etaFloorMinutes, effectiveMaxEta, etaMinutes as number)}` : ""}`;
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
        // Self-healing: when the assignDrivers push (or a verification fetch)
        // hits an expired session (the 2026-08-11 13:10Z incident), recover the
        // session and RETRY the push once with the fresh session — the owner's
        // alert fires only if recovery or the retry fails.
        let verification = await verifyDispatch(fetchImpl, baseUrl, cookies, offer, callIdFromAcceptResponse(accept.raw), driverId, {
          retryDelayMs: deps.verifyRetryDelayMs ?? 5000,
          allowAssign: true,
        });
        let verificationRecoveryNote: string | null = null;
        if (!verification.ok && hasSessionExpiredVerification(verification.attempts)) {
          const recovery = await recoverSession(orgId);
          if (recovery.recovered) {
            const fresh = await loadOwnerSession(orgId);
            if (fresh) {
              const retried = await verifyDispatch(fetchImpl, fresh.baseUrl, fresh.cookie, offer, callIdFromAcceptResponse(accept.raw), driverId, {
                retryDelayMs: deps.verifyRetryDelayMs ?? 5000,
                allowAssign: true,
              });
              verification = { ...retried, attempts: [...verification.attempts, ...retried.attempts] };
              verificationRecoveryNote = "session recovered; dispatch push retried";
            } else {
              verificationRecoveryNote = "session recovered but reload failed";
            }
          } else {
            verificationRecoveryNote = `session recovery failed (${recovery.reason})`;
          }
        }
        if (verification.ok) {
          const reason = `accepted and dispatched to ${String(driver.driverName ?? driver.driverId)} (driver ${driver.driverId}, VERIFIED on call ${verification.callId})${verificationRecoveryNote ? `; ${verificationRecoveryNote}` : ""} — ${etaDetailLabel(chosen, settings.etaBufferMinutes, settings.etaFloorMinutes, effectiveMaxEta, etaMinutes)}`;
          await record({
            decision: "auto_accept_with_driver",
            callId: verification.callId,
            driverId: String(driver.driverId), driverName: String(driver.driverName ?? ""),
            etaMinutes, zoneDistanceMiles: zoneDistance, reason,
            rawResponse: { offer, eta: etaFacts, accept: accept.raw, verification },
          });
          result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "auto_accept_with_driver", escalated: false, reason });
        } else {
          const reason = `accepted (call ${verification.callId ?? "unknown"}) but dispatch NOT verified for ${String(driver.driverName ?? driver.driverId)} (driver ${driver.driverId}) — ${verification.error}${verificationRecoveryNote ? `; ${verificationRecoveryNote}` : ""}; needs a human to assign on Towbook (ETA ${etaMinutes} min quoted)`;
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
    return { result, seenOffers };
  }
