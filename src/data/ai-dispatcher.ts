import { createHash } from "node:crypto";
import { resolveStateFromAddress, reverseGeocodeState, driverStateCacheKey, isAgeroPlaceholderCoords } from "./state-guard-core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sql } from "~/db";
import { decryptSession, findSiteRoot } from "./towbook-key";
import type { RecoveryResult } from "./towbook-recovery";

/* ============================ AI dispatcher engine ============================
 * Owner-directed: every pending, unexpired Towbook motor-club offer is claimed
 * by an accept POST. The engine dispatches the closest eligible driver when it
 * can prove one; otherwise it accepts with driverId 0 and the club SLA ceiling
 * (honest "awaiting driver assignment"). Eligibility, geography, malformed
 * payloads, and missing driver data never leave an offer unaccepted. Only an
 * accept POST failure or an offer already expired may escalate before acceptance.
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
 *   2. Expiration check — expired → escalate (we never use acceptMissedRequest)
 *   3. Resolve coordinates/zone/driver data when available; uncertainty falls
 *      through to the universal driverId 0 SLA-ceiling accept
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
 * Hard rails: a pending offer with callRequestId + expiration is accepted even
 * when coordinates or driver data are absent (driverId 0 + SLA ceiling). A shape
 * lacking callRequestId/expiration cannot be claimed and is escalated. Out-of-zone
 * and cross-state are eligibility outcomes, not no-accept rails: they use the
 * universal fallback. Accept POST failure and already-expired offers remain hard rails. Fetch, the env bag, and the router provider
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
  /** Assigned-offer push (owner top priority 2026-08-12): called AFTER a
   *  verified dispatch with (orgId, towbookDriverId, payload). Injected for
   *  hermetic tests; production defaults to a dynamic import of push-core
   *  (sendAssignmentPushByTowbookDriver). NEVER awaited by the engine flow —
   *  fire-and-forget with its own catch, so push problems can never fail or
   *  slow the dispatch. */
  sendAssignmentPush?: (orgId: string, towbookDriverId: string | number, payload: import("./push-core").AssignmentPushPayload) => Promise<unknown>;
  /** Coordinate-less offer resolution (owner-directed 2026-08-13): a raw TomTom
   *  Search geocode result for a startingLocation address. Injected for hermetic
   *  tests — production defaults to the real tomtomGeocodeLookup (which uses the
   *  resolved TomTom key + deps.fetchImpl). The ENGINE always runs the
   *  validation (score floor + token overlap) on whatever this returns — an
   *  override can never bypass the safety rail. */
  geocodeOverride?: (address: string) => Promise<GeocodeLookup | null>;
  /** SAME-STATE GUARD driver-state resolver (owner rule 2026-08-13, no
   *  cross-state assignments): resolves a driver's CURRENT US state from its
   *  ETA-origin coordinates. Injected for hermetic tests — production defaults
   *  to a TomTom reverse geocode (reverseGeocodeState) with the resolved key.
   *  The override supplies ONLY the driver-state evidence; the guard's job-state
   *  parsing, same-state comparison and fail-closed refusal all stay in the
   *  engine — an override can never weaken the containment rule. */
  stateGuardResolver?: (driverId: number, lat: number, lng: number) => Promise<string | null>;
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
  /** Hard qualification safety rail; default ON and org-configurable for rollback. */
  qualificationGateEnabled: boolean;
  nudgeEnabled: boolean;
  reassignNotHeadedMinutes: number;
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
  | "escalated_dispatch_failed"
  | "escalated_state_unknown"
  | "escalated_cross_state"
  | "rejected_tow_no_eligible_driver";

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

/* ---------------- area anchoring + GPS-fix ETA origin (owner 2026-08-13) ----------------
 * Owner direction: "keep the drivers in the area they get assigned for their
 * first job of the day (for instance, if Jayden gets a job in Darien, he
 * shouldn't get a job in New Haven when Levi is in West Haven)... all jobs
 * getting accurate ETAs based on live traffic from the drivers location to the
 * customer."
 * Rule (owner-directed 2026-08-13):
 *  1. A driver's FIRST ASSIGNED job of the day (local ET 00:00-23:59) sets
 *     their service area: a circle of ANCHOR_RADIUS_MILES around that job's
 *     pickup coords, persisting until 23:59 ET.
 *  2. Drivers with NO anchor yet are flexible — candidates for any job (the
 *     job they take becomes their anchor). Anchored drivers are candidates only
 *     when the job falls inside their circle. Pick the candidate with the
 *     SHORTEST live-traffic road ETA (not straight-line). FALLBACK: when no
 *     in-area candidate exists, fall back to the global closest-by-ETA among
 *     all available drivers. The existing escalation is the backstop when no
 *     candidate yields a validated ETA (never auto-accept blindly).
 *  3. ETA origin = the freshest app GPS fix (driver_locations). A fix older
 *     than STALE_GPS_FIX_MINUTES falls back to the driver's anchor center and
 *     the basis is noted in the offer/audit. A driver with NO app fix at all
 *     keeps the pre-geography payload GPS (nearestDrivers lat/lng) — absence of
 *     a ping is not treated as a stale ping.
 * Both the anchor and the fix are DERIVED from existing rows (dispatch_jobs
 * assignment history + driver_locations) — no migration needed. */

/** Owner-tunable service-area radius (miles) — the single named constant: a
 *  driver's first assigned job of the day anchors them to a circle of this
 *  radius around that job. Tune with the owner later (15 mi default). */
export const ANCHOR_RADIUS_MILES = 15;

/** An app GPS fix older than this (minutes) is NOT fresh — the ETA origin
 *  falls back to the driver's anchor center (owner-directed 2026-08-13) and
 *  the basis is noted in the offer/audit. */
export const STALE_GPS_FIX_MINUTES = 15;

/** A driver's service-area anchor for today — DERIVED from dispatch_jobs (the
 *  first row with an assigned driver + usable pickup coords created in today's
 *  ET day), never stored. */
export type DriverAnchor = {
  /** Towbook driver id (dispatch_jobs.assigned_driver_towbook_id). */
  driverTowbookId: string;
  /** Anchor center = the first assigned job's pickup coordinates. */
  lat: number;
  lng: number;
  /** The dispatch_jobs row id that set the anchor. */
  jobId: string;
  /** The anchoring job's created_at (assignment-time proxy), ISO. */
  assignedAt: string;
};

/** Freshest app GPS fix for a driver (driver_locations), keyed by Towbook
 *  driver id. */
export type DriverGpsFix = {
  lat: number;
  lng: number;
  /** Fix time (captured_at), ISO. */
  capturedAt: string;
};

/** Where the road ETA was routed FROM — surfaced in the offer/audit so a
 *  stale-GPS fallback is never silent: "gps" = fresh app fix, "anchor" = the
 *  driver's anchor center (stale fix), "payload" = the nearestDrivers payload
 *  lat/lng (no app fix — the pre-geography default). */
export type EtaOriginBasis = "gps" | "anchor" | "payload";

/** Start of today's ET business day (America/New_York 00:00) as UTC ms —
 *  DST-aware: the offset is resolved from the ET calendar date, so winter EST
 *  (-5) and summer EDT (-4) both land on the correct instant. */
export function etDayStartUtcMs(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const naiveUtc = Date.UTC(y, m - 1, d);
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" })
    .formatToParts(new Date(naiveUtc)).find((p) => p.type === "timeZoneName")?.value;
  return naiveUtc + (tz === "EST" ? 5 : 4) * 3600e3;
}

/** Derive every driver's area anchor for TODAY (ET): the FIRST dispatch_jobs
 *  row with an assigned driver + usable pickup coords ASSIGNED since ET
 *  midnight, per driver. The assignment instant = COALESCE(assigned_at, raw
 *  dispatchTime, created_at) — the team's busy-bonus ground-truth chain
 *  (busy-bonus-core, verified against the live org 2026-08-13): assigned_at is
 *  set only when a job's status passes through the platform accept flow (2/70
 *  live rows), raw_json.dispatchTime is the true Towbook dispatch moment
 *  (70/70 driver-attributed rows, Z-less ISO in UTC — the DB session timezone
 *  is GMT, so the cast is exact; a regex guard keeps a malformed value from
 *  ever taking down the anchor load), and created_at (import time) is the
 *  fallback for platform-only rows with no Towbook payload. One org-scoped
 *  read, ordered oldest-first; the first row per driver wins (the anchor
 *  persists for the rest of the day). Rows whose assignment predates today
 *  (ET) never anchor today — a late-imported, already-dispatched call cannot
 *  lock a driver into today's area. A driver with no row assigned today has
 *  no anchor (flexible). Never throws — a DB error returns an empty map so
 *  the engine degrades to the pre-geography behavior instead of crashing a
 *  tick. */
export async function loadDriverAnchors(orgId: string, now: Date = new Date()): Promise<Map<string, DriverAnchor>> {
  try {
    const dayStart = new Date(etDayStartUtcMs(now)).toISOString();
    const rows = await sql()`SELECT id, assigned_driver_towbook_id, pickup_lat, pickup_lng,
        COALESCE(assigned_at,
          CASE WHEN raw_json->>'dispatchTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
            THEN (raw_json->>'dispatchTime')::timestamptz END,
          created_at) AS dispatch_at
      FROM dispatch_jobs
      WHERE org_id=${orgId}
        AND assigned_driver_towbook_id IS NOT NULL
        AND pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL
        AND pickup_lat != 0 AND pickup_lng != 0
        AND COALESCE(assigned_at,
          CASE WHEN raw_json->>'dispatchTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
            THEN (raw_json->>'dispatchTime')::timestamptz END,
          created_at) >= ${dayStart}
      ORDER BY 5 ASC`;
    const anchors = new Map<string, DriverAnchor>();
    for (const r of rows as Array<Record<string, unknown>>) {
      const did = String(r.assigned_driver_towbook_id ?? "");
      if (!did || anchors.has(did)) continue;
      const lat = Number(r.pickup_lat);
      const lng = Number(r.pickup_lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      anchors.set(did, {
        driverTowbookId: did,
        lat,
        lng,
        jobId: String(r.id ?? ""),
        assignedAt: new Date(String(r.dispatch_at ?? "")).toISOString(),
      });
    }
    return anchors;
  } catch {
    return new Map();
  }
}

/** Freshest app GPS fix per driver (driver_locations), keyed by Towbook driver
 *  id — the ETA origin when fresh. No time window: the ping ledger is pruned to
 *  24h on write, so any row here is recent; the caller decides freshness via
 *  STALE_GPS_FIX_MINUTES against captured_at. Never throws — a DB error
 *  returns an empty map so the engine degrades to payload-GPS origins. */
export async function loadRegionalPreferenceMatches(orgId: string, candidates: unknown[], lat: number, lng: number, queues = new Map<string, DriverQueue>()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const rows = await sql()`SELECT driver_id, config FROM driver_region_preferences WHERE org_id=${orgId} AND enabled=TRUE` as Array<Record<string, unknown>>;
    const miles=(a:number,b:number,c:number,d:number)=>{const r=Math.PI/180,p=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 3958.7613*2*Math.atan2(Math.sqrt(p),Math.sqrt(1-p));};
    for (const d of candidates) { const id=String((d as Record<string, unknown>).driverId??""); const row=rows.find(r=>String(r.driver_id)===id); if(!row) continue; const c=(row.config&&typeof row.config==='object'?row.config:{}) as Record<string,unknown>; if(driverActiveCount(d as NearestDriver,queues)>Number(c.max_backlog_before_waive??2)) continue; const inCircle=(list:unknown[])=>list.filter(x=>x&&typeof x==='object').some(x=>{const center=x as Record<string,unknown>; return miles(lat,lng,Number(center.lat),Number(center.lng))<=Number(center.radius_miles??3)}); if(inCircle(Array.isArray(c.core_centers)?c.core_centers:[])) out.set(id,Number(c.priority_weight??1)); else if(inCircle(Array.isArray(c.nearby_centers)?c.nearby_centers:[])) out.set(id,Math.max(Number(c.nearby_weight??0.5),Number.MIN_VALUE)); }
  } catch {}
  return out;
}

export async function loadZoneMatches(orgId: string, candidates: unknown[], lat: number, lng: number, state?: string | Date, now = new Date()): Promise<Map<string, boolean>> {
  if (state instanceof Date) { now = state; state = undefined; }
  const out = new Map<string, boolean>(); for (const d of candidates) out.set(String((d as Record<string, unknown>).driverId ?? ''), false);
  try {
    const zones = await sql()`SELECT id,state,zone_type,lat,lng,radius_miles,tz FROM dispatch_zones WHERE org_id=${orgId} AND active=TRUE` as Array<Record<string,unknown>>;
    const miles=(a:number,b:number,c:number,d:number)=>{const r=Math.PI/180,p=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 3958.7613*2*Math.atan2(Math.sqrt(p),Math.sqrt(1-p));};
    const scoped = state ? zones.filter(z=>String(z.state??"").toUpperCase()===state.toUpperCase()) : zones.filter(z=>String(z.zone_type??"").toLowerCase()!=="coverage");
    const containing = scoped.map(z=>({...z,distance:miles(lat,lng,Number(z.lat),Number(z.lng))})).filter(z=>z.distance<=Number(z.radius_miles));
    const nonCoverage=containing.filter(z=>String(z.zone_type??"").toLowerCase()!=="coverage").sort((a,b)=>a.distance-b.distance);
    const coverage=containing.filter(z=>String(z.zone_type??"").toLowerCase()==="coverage").sort((a,b)=>a.distance-b.distance);
    const job=nonCoverage[0]??coverage[0]; if(!job)return out;
    const rows=await sql()`SELECT u.towbook_driver_id,l.zone_id,to_char(l.day,'YYYY-MM-DD') AS day,z.tz FROM driver_availability_log l JOIN users u ON u.id=l.user_id JOIN dispatch_zones z ON z.id=l.zone_id AND z.org_id=l.org_id WHERE l.org_id=${orgId} AND l.session_started_at IS NOT NULL AND l.heartbeat_at > NOW() - INTERVAL '90 seconds' AND l.zone_id IS NOT NULL` as Array<Record<string,unknown>>;
    const day=(tz:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(now), selected=new Map<string,string>();
    for(const r of rows)if(String(r.day)===day(String(r.tz)))selected.set(String(r.towbook_driver_id),String(r.zone_id));
    for(const d of candidates){const id=String((d as Record<string,unknown>).driverId??'');out.set(id,selected.get(id)===String(job.id));}
  } catch {}
  return out;
}

export async function loadDriverGpsFixes(orgId: string): Promise<Map<string, DriverGpsFix>> {
  try {
    const rows = await sql()`SELECT DISTINCT ON (towbook_driver_id) towbook_driver_id, latitude, longitude, captured_at
      FROM driver_locations
      WHERE org_id=${orgId} AND towbook_driver_id IS NOT NULL
        AND latitude != 0 AND longitude != 0
      ORDER BY towbook_driver_id, captured_at DESC`;
    const fixes = new Map<string, DriverGpsFix>();
    for (const r of rows as Array<Record<string, unknown>>) {
      const did = String(r.towbook_driver_id ?? "");
      if (!did) continue;
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      fixes.set(did, {
        lat,
        lng,
        capturedAt: new Date(String(r.captured_at ?? "")).toISOString(),
      });
    }
    return fixes;
  } catch {
    return new Map();
  }
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

/* ------------------ coordinate-less offer resolution (2026-08-13) ------------------
 * Owner-directed: a Towbook offer with NO startLocationLatitude/Longitude must
 * STILL dispatch when its location is resolvable — first from our own data
 * (dispatch_jobs: the sync already imported the call with real coords), else
 * from a VALIDATED TomTom Search geocode of the offer's startingLocation text.
 * NAIVE geocoding is proven unsafe (live hit 2026-08-13: the Georgetown TX
 * address resolved to Cotulla TX ~200 mi away at score 14), so any geocode is
 * accepted ONLY when BOTH rails pass: a score floor AND a strong-token overlap
 * (ZIP / city / street) between the offer address and the geocoded address.
 * Unresolvable offers keep the existing escalated_unexpected_shape rail. */

/** Minimum TomTom Search score for a geocode result to be trusted (the proven
 *  bad hit scored 14; 40 is a conservative floor for street-level US results). */
export const GEOCODE_SCORE_FLOOR = 40;
const TOMTOM_GEOCODE_ENDPOINT = "https://api.tomtom.com/search/2/geocode";

/** One raw TomTom Search geocode result (the fields validation acts on). */
export type GeocodeLookup = {
  lat: number;
  lng: number;
  /** TomTom result confidence (0-100). */
  score: number;
  /** The geocoded address as TomTom formatted it (validation compares its
   *  strong tokens against the offer's startingLocation). */
  freeformAddress: string;
};

const normTokens = (value: string): Set<string> =>
  new Set(String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0));
/** Whitespace/punctuation-insensitive equality form ("1441 I 35 N FRONTAGE RD,
 *  GEORGETOWN TX 78628" == "1441I35NFRONTAGERDGEORGETOWNTX78628"). */
const normText = (value: string): string =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The 5-digit ZIP (first 5 of a ZIP+4) in a US address, or null. */
const zipOf = (value: string): string | null => {
  const m = String(value ?? "").match(/\b\d{5}(?:-\d{4})?\b/);
  return m ? m[0].slice(0, 5) : null;
};

/** The trailing "CITY ST ZIP" part of a US address, parsed as
 *  {state: "tx", city: "georgetown"}. City is null when the address has no
 *  recognizable trailing city/state (validation then falls back to a stricter
 *  street-token requirement). */
const stateCityOf = (value: string): { state: string; city: string | null } | null => {
  const tokens = String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  if (!tokens.length) return null;
  // the LAST 5-digit token is the ZIP (a leading 5-digit token can be a street
  // number — "12345 MAIN ST, BRIDGEPORT CT 06606" — so never take the first).
  let zipIdx = -1;
  tokens.forEach((t, i) => { if (/^\d{5}$/.test(t)) zipIdx = i; });
  let stateIdx: number;
  if (zipIdx >= 1) stateIdx = zipIdx - 1;
  else if (/^[a-z]{2}$/.test(tokens[tokens.length - 1] ?? "")) stateIdx = tokens.length - 1;
  else return null;
  const state = tokens[stateIdx] ?? "";
  if (!/^[a-z]{2}$/.test(state)) return null;
  const cityTok = stateIdx >= 1 ? tokens[stateIdx - 1] : null;
  const city = cityTok && !/^\d+$/.test(cityTok) && cityTok.length >= 2 ? cityTok : null;
  return { state, city };
};

/** Strong street tokens of an address: alphanumeric tokens of length >= 4 that
 *  are NOT the city/state/ZIP and not a bare number. These are the tokens that
 *  distinguish one location from another ("frontage" vs "cotulla") — short
 *  tokens ("n", "rd", "st") and numbers never count. */
const streetTokensOf = (value: string): Set<string> => {
  const sc = stateCityOf(value);
  const drop = new Set<string>([sc?.city, sc?.state, zipOf(value)].filter((t): t is string => Boolean(t)));
  return new Set([...normTokens(value)].filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !drop.has(t)));
};

/** The coordinate-less-offer safety rail (2026-08-13): accept a geocode result
 *  ONLY when (1) its score is at/above the floor, and (2) its strong tokens
 *  actually overlap the offer address — at minimum the ZIP, else the city AND
 *  a shared street token (two shared street tokens when the offer has no
 *  parseable city). The proven-bad Cotulla TX hit fails BOTH rails (score 14,
 *  ZIP 78014 ≠ 78628). Pure, exported so the suite asserts the exact cases. */
export function validateGeocodeResult(
  address: string,
  lookup: GeocodeLookup,
): { ok: true; lat: number; lng: number } | { ok: false; reason: string } {
  if (!lookup || !Number.isFinite(lookup.score)) return { ok: false, reason: "geocode returned no score" };
  if (lookup.score < GEOCODE_SCORE_FLOOR) {
    return { ok: false, reason: `geocode score ${lookup.score} < floor ${GEOCODE_SCORE_FLOOR}` };
  }
  if (!Number.isFinite(lookup.lat) || !Number.isFinite(lookup.lng) || lookup.lat === 0 || lookup.lng === 0) {
    return { ok: false, reason: "geocode position unusable" };
  }
  const geoTokens = normTokens(lookup.freeformAddress);
  const offerZIP = zipOf(address);
  const geoZIP = zipOf(lookup.freeformAddress);
  if (offerZIP && geoZIP && offerZIP !== geoZIP) {
    return { ok: false, reason: `geocode ZIP ${geoZIP} ≠ offer ZIP ${offerZIP}` };
  }
  if (offerZIP && geoTokens.has(offerZIP)) return { ok: true, lat: lookup.lat, lng: lookup.lng };
  const offerStreet = streetTokensOf(address);
  const sharedStreet = [...offerStreet].filter((t) => geoTokens.has(t));
  const sc = stateCityOf(address);
  if (sc?.city && geoTokens.has(sc.city) && sharedStreet.length >= 1) {
    return { ok: true, lat: lookup.lat, lng: lookup.lng };
  }
  if (!sc?.city && sharedStreet.length >= 2) {
    return { ok: true, lat: lookup.lat, lng: lookup.lng };
  }
  const why = sc?.city && !geoTokens.has(sc.city)
    ? `geocode address lacks offer city '${sc.city}'`
    : sc?.city
      ? `city '${sc.city}' matches but no street-token overlap`
      : `no city in offer address; only ${sharedStreet.length} shared street token(s)`;
  return { ok: false, reason: `no strong token overlap — ${why}` };
}

/** Real TomTom Search geocode lookup (the production path): best result for a
 *  full address, limit=3, US-only + the address's state hint when present.
 *  Returns null on ANY failure (no key is the caller's concern — the caller
 *  only calls this with a resolved key; 429/5xx/network/timeout/bad shape all
 *  yield null) so the engine always escalates instead of guessing. The raw
 *  result is VALIDATED by validateGeocodeResult before any coordinates are
 *  trusted — this function never decides acceptability. */
export async function tomtomGeocodeLookup(
  address: string,
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GeocodeLookup | null> {
  try {
    const params = new URLSearchParams({ key: apiKey, limit: "3", countrySet: "US" });
    const sc = stateCityOf(address);
    if (sc?.state) params.set("adminDistrictSet", sc.state.toUpperCase());
    const url = `${TOMTOM_GEOCODE_ENDPOINT}/${encodeURIComponent(address)}.json?${params.toString()}`;
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const results = (body as Record<string, unknown>).results;
    if (!Array.isArray(results) || !results.length) return null;
    const r0 = results[0] as Record<string, unknown> | undefined;
    if (!r0 || typeof r0 !== "object") return null;
    const pos = r0.position as Record<string, unknown> | undefined;
    const addr = r0.address as Record<string, unknown> | undefined;
    if (!pos || typeof pos !== "object" || !addr || typeof addr !== "object") return null;
    const lat = Number(pos.lat);
    const lng = Number(pos.lon);
    const score = Number(r0.score);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(score)) return null;
    return {
      lat,
      lng,
      score,
      freeformAddress: typeof addr.freeformAddress === "string" ? addr.freeformAddress : "",
    };
  } catch {
    return null;
  }
}

/* ------------------------------- settings + ledger ------------------------------- */

/** Load the org's AI-dispatcher settings, lazily creating the row with the
 *  owner-directed defaults (migrations v8+v9): enabled, 06606 centroid, 30 mi,
 *  45 min ceiling, 5 min prep buffer, 5 min quoted-ETA floor. */
export async function getOrgSettings(orgId: string): Promise<OrgAiSettings> {
  const q = sql();
  await q`INSERT INTO org_settings(org_id) VALUES(${orgId}) ON CONFLICT(org_id) DO NOTHING`;
  const rows = await q`SELECT ai_dispatcher_enabled, qualification_gate_enabled, nudge_enabled, reassign_not_headed_minutes, zone_lat, zone_lng, zone_radius_miles, max_eta_minutes, eta_buffer_minutes, eta_floor_minutes FROM org_settings WHERE org_id=${orgId}`;
  const r = rows[0] as Record<string, unknown>;
  return {
    aiDispatcherEnabled: r.ai_dispatcher_enabled !== false,
    zoneLat: Number(r.zone_lat),
    zoneLng: Number(r.zone_lng),
    zoneRadiusMiles: Number(r.zone_radius_miles),
    maxEtaMinutes: Number(r.max_eta_minutes) || 45,
    etaBufferMinutes: Number(r.eta_buffer_minutes) || 5,
    etaFloorMinutes: Number(r.eta_floor_minutes) || 5,
    qualificationGateEnabled: r.qualification_gate_enabled !== false,
    nudgeEnabled: r.nudge_enabled !== false,
    reassignNotHeadedMinutes: Number(r.reassign_not_headed_minutes) || 5,
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
  serviceType: string | null;
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
  /** Pickup-coordinate provenance (owner-directed 2026-08-13, offer 326885213:
   *  a coordinate-less offer must still dispatch when the location is
   *  resolvable). Set ONLY on the resolution path: "db" = real coords found in
   *  dispatch_jobs from a previous import/sync (PO or address tie), "geocode" =
   *  VALIDATED TomTom geocode of startingLocation (score floor + token
   *  overlap). The normal offer payload path omits this field entirely — the
   *  offer's own coords are the trusted default. */
  coords?: { source: "db" | "geocode"; detail: string };
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

/** The offer's usable startingLocation text (the only thing a coordinate-less
 *  offer can be resolved from), trimmed; null when absent/empty. */
const startingLocationOf = (o: Record<string, unknown>): string | null => {
  const v = o.startingLocation;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

/** The offer's purchase-order ("Dispatch #") as a string, mirroring the
 *  purchaseOrderNumber extraction in buildOfferShape; null when absent. */
const purchaseOrderOf = (o: Record<string, unknown>): string | null => {
  const v = o.purchaseOrderNumber;
  return typeof v === "string" && v.trim() !== "" ? v.trim()
    : v != null && typeof v !== "object" ? String(v) : null;
};

type DbCoordsHit = { lat: number; lng: number; detail: string };
type AuthoritativeStateRow = { id: string; pickup: string; lat: number; lng: number };
type JobStateResolution = {
  state: string | null;
  source: "address" | "zip" | "authoritative" | "unknown";
  mismatch: boolean;
  note: string | null;
  authoritativeId: string | null;
  authoritativeLat: number | null;
  authoritativeLng: number | null;
};

/** Resolve job state without trusting Towbook's known placeholder coordinates.
 * The synced call is org-scoped and tied by PO; its pickup address and real
 * pickup coordinates must agree. A non-placeholder offer coordinate that
 * disagrees with the authoritative/address state is a genuine discrepancy and
 * remains fail-closed. */
async function resolveJobState(
  orgId: string,
  offer: Record<string, unknown>,
  address: string | null,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<JobStateResolution> {
  const addressResolution = address ? resolveStateFromAddress(address) : { state: null, source: "unknown" as const, mismatch: false };
  const lat = Number(offer.startLocationLatitude);
  const lng = Number(offer.startLocationLongitude);
  const placeholder = isAgeroPlaceholderCoords(lat, lng);
  const po = purchaseOrderOf(offer);
  let authoritative: AuthoritativeStateRow | null = null;
  if (po) {
    const rows = await sql()`SELECT towbook_job_id, pickup, pickup_lat, pickup_lng
      FROM dispatch_jobs WHERE org_id=${orgId} AND raw_json->>'purchaseOrderNumber'=${po}
      ORDER BY created_at DESC LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (r) {
      const rLat = Number(r.pickup_lat), rLng = Number(r.pickup_lng);
      if (typeof r.pickup === "string" && Number.isFinite(rLat) && rLat !== 0 && Number.isFinite(rLng) && rLng !== 0)
        authoritative = { id: String(r.towbook_job_id ?? po), pickup: r.pickup, lat: rLat, lng: rLng };
    }
  }
  if (authoritative) {
    const pickupState = resolveStateFromAddress(authoritative.pickup);
    if (!pickupState.state) {
      return { state: null, source: "unknown", mismatch: true,
        note: `authoritative pickup record ${authoritative.id} address unresolved (${authoritative.pickup})`, authoritativeId: authoritative.id, authoritativeLat: authoritative.lat, authoritativeLng: authoritative.lng };
    }
    // Address is the authoritative source; the reverse geocode only CORROBORATES.
    // A null geocode (TomTom down/429/timeout/non-US) is absence of evidence, not
    // a disagreement — only a conflicting state is a discrepancy (fail-closed).
    const callState = await reverseGeocodeState(authoritative.lat, authoritative.lng, apiKey, fetchImpl);
    if (callState && callState !== pickupState.state) {
      return { state: null, source: "unknown", mismatch: true,
        note: `authoritative pickup discrepancy (call ${authoritative.id}: address=${pickupState.state}, coords=${callState})`, authoritativeId: authoritative.id, authoritativeLat: authoritative.lat, authoritativeLng: authoritative.lng };
    }
    if (!placeholder && Number.isFinite(lat) && Number.isFinite(lng)) {
      const offerState = await reverseGeocodeState(lat, lng, apiKey, fetchImpl);
      if (offerState && offerState !== pickupState.state) {
        return { state: null, source: "unknown", mismatch: true,
          note: `offer coordinates discrepancy (offer coords ${lat},${lng} resolve to ${offerState}; authoritative record ${authoritative.id} resolves to ${pickupState.state})`, authoritativeId: authoritative.id, authoritativeLat: authoritative.lat, authoritativeLng: authoritative.lng };
      }
    }
    const state = pickupState.state;
    const note = placeholder
      ? `offer coordinates are known Agero CT placeholder (${lat},${lng}); authoritative pickup record ${authoritative.id} / address resolves to ${state}`
      : `authoritative pickup record ${authoritative.id} resolves to ${state}${Number.isFinite(lat) && Number.isFinite(lng) ? `; offer coordinates agree (${lat},${lng})` : ""}`;
    return { state, source: "authoritative", mismatch: false, note, authoritativeId: authoritative.id, authoritativeLat: authoritative.lat, authoritativeLng: authoritative.lng };
  }
  if (placeholder) {
    return { state: addressResolution.state, source: addressResolution.source, mismatch: addressResolution.mismatch,
      note: `offer coordinates are known Agero CT placeholder (${lat},${lng}); no authoritative call record, address-only resolution retained`, authoritativeId: null, authoritativeLat: null, authoritativeLng: null };
  }
  if (addressResolution.state && Number.isFinite(lat) && Number.isFinite(lng)) {
    const offerState = await reverseGeocodeState(lat, lng, apiKey, fetchImpl);
    if (offerState && offerState !== addressResolution.state) {
      return { state: null, source: "unknown", mismatch: true,
        note: `genuine location discrepancy (offer coords resolve to ${offerState}, address resolves to ${addressResolution.state})`, authoritativeId: null, authoritativeLat: null, authoritativeLng: null };
    }
  }
  return { state: addressResolution.state, source: addressResolution.source, mismatch: addressResolution.mismatch, note: null, authoritativeId: null, authoritativeLat: null, authoritativeLng: null };
}


/** DB-first leg of coordinate resolution (owner-directed 2026-08-13): the sync
 *  already imported this call into dispatch_jobs with real coords (pickup_lat/
 *  pickup_lng from the call's waypoints). Match 1: the offer's purchase-order
 *  number — the "Dispatch #" every accepted call record carries (the strongest
 *  offer↔call tie). Match 2: normalized-equality of the offer's startingLocation
 *  against the call's pickup / raw startingLocation (the same Towbook address
 *  string). Only usable (non-zero) coords count. */
async function lookupDbCoords(orgId: string, o: Record<string, unknown>, addr: string): Promise<DbCoordsHit | null> {
  const po = purchaseOrderOf(o);
  if (po) {
    const byPo = await sql()`SELECT towbook_job_id, pickup_lat, pickup_lng
      FROM dispatch_jobs
      WHERE org_id=${orgId} AND pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL
        AND raw_json->>'purchaseOrderNumber' = ${po}
      LIMIT 1`;
    if (byPo.length) {
      const r = byPo[0] as Record<string, unknown>;
      const lat = Number(r.pickup_lat);
      const lng = Number(r.pickup_lng);
      if (Number.isFinite(lat) && lat !== 0 && Number.isFinite(lng) && lng !== 0) {
        return { lat, lng, detail: `db PO match (call ${String(r.towbook_job_id ?? "")})` };
      }
    }
  }
  const addrNorm = normText(addr);
  const recent = await sql()`SELECT towbook_job_id, pickup_lat, pickup_lng, pickup, raw_json
    FROM dispatch_jobs
    WHERE org_id=${orgId} AND pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL
    ORDER BY created_at DESC LIMIT 100`;
  for (const row of recent as Array<Record<string, unknown>>) {
    const lat = Number(row.pickup_lat);
    const lng = Number(row.pickup_lng);
    if (!Number.isFinite(lat) || lat === 0 || !Number.isFinite(lng) || lng === 0) continue;
    const raw = row.raw_json && typeof row.raw_json === "object" ? row.raw_json as Record<string, unknown> : null;
    const rawStart = raw && typeof raw.startingLocation === "string" ? raw.startingLocation : "";
    if (normText(String(row.pickup ?? "")) === addrNorm || normText(String(rawStart)) === addrNorm) {
      return { lat, lng, detail: `db address match (call ${String(row.towbook_job_id ?? "")})` };
    }
  }
  return null;
}

type CoordsResolution =
  | { ok: true; lat: number; lng: number; source: "db" | "geocode"; detail: string }
  | { ok: false; reason: string };

/* ------------------ manual reassign guard (owner-directed 2026-08-13) ------------------
 * The owner/ops portal can reassign a call's driver (reassign-core). When an
 * offer lands for a call a HUMAN already reassigned, the engine must treat the
 * latest assignment as AUTHORITATIVE — it must never overwrite/re-dispatch to
 * the road-best driver. The guard: a dispatch_jobs row tied to this offer
 * (purchase-order match first — the "Dispatch #" every accepted call mirrors —
 * then normalized startingLocation equality) that carries the manual-reassign
 * marker (manually_reassigned_at, migration 44) and a non-terminal status
 * yields the human-chosen driver. The engine then dispatches ONLY that driver:
 * the accept carries their driverId (even when they are offline — offline
 * dispatch is owner-approved and the reassign push reaches offline phones),
 * and the decision ledger records the human's choice as respected. */

export type HumanReassignedDriver = {
  /** Towbook driver id of the human-chosen driver (dispatch_jobs.assigned_driver_towbook_id). */
  driverTowbookId: string;
  /** Human-readable driver name (assigned_driver_name), when captured. */
  driverName: string | null;
  /** The LD dispatch_jobs row id (jobId) the marker lives on. */
  jobId: string;
  /** When the human reassigned (manually_reassigned_at, ISO). */
  reassignedAt: string;
  /** Which tie found the row: "purchaseOrder" | "address". */
  source: "purchaseOrder" | "address";
};

/** Find the human-reassigned driver for an offer, or null. The offer ties to
 *  the existing call via its purchaseOrderNumber (the "Dispatch #") or the
 *  normalized startingLocation text; the row must carry the manual-reassign
 *  marker, a still-assigned driver, and a non-terminal status. Latest marker
 *  wins when multiple rows tie. Never throws — DB errors return null and the
 *  engine falls through to its normal path (a lookup failure must never crash
 *  or invent a reassignment). */
export async function lookupHumanReassignedDriver(
  orgId: string,
  offer: OfferShape,
): Promise<HumanReassignedDriver | null> {
  try {
    const po = offer.purchaseOrderNumber;
    const addr = startingLocationOf(offer as unknown as Record<string, unknown>) ?? "";
    const addrNorm = addr ? normText(addr) : "";
    const rows = await sql()`SELECT id, assigned_driver_towbook_id, assigned_driver_name, manually_reassigned_at, raw_json, pickup
      FROM dispatch_jobs
      WHERE org_id=${orgId}
        AND manually_reassigned_at IS NOT NULL
        AND assigned_driver_towbook_id IS NOT NULL
        AND status NOT IN ('completed','cancelled')
      ORDER BY manually_reassigned_at DESC`;
    for (const row of rows as Array<Record<string, unknown>>) {
      const raw = row.raw_json && typeof row.raw_json === "object" ? row.raw_json as Record<string, unknown> : null;
      const rowPo = raw && typeof raw.purchaseOrderNumber === "string" ? raw.purchaseOrderNumber : null;
      if (po && rowPo && rowPo === po) {
        return {
          driverTowbookId: String(row.assigned_driver_towbook_id),
          driverName: row.assigned_driver_name != null && String(row.assigned_driver_name) !== "" ? String(row.assigned_driver_name) : null,
          jobId: String(row.id),
          reassignedAt: new Date(String(row.manually_reassigned_at)).toISOString(),
          source: "purchaseOrder",
        };
      }
      if (addrNorm) {
        const rowPickup = row.pickup != null ? String(row.pickup) : "";
        const rowStart = raw && typeof raw.startingLocation === "string" ? raw.startingLocation : "";
        if (normText(rowPickup) === addrNorm || normText(rowStart) === addrNorm) {
          return {
            driverTowbookId: String(row.assigned_driver_towbook_id),
            driverName: row.assigned_driver_name != null && String(row.assigned_driver_name) !== "" ? String(row.assigned_driver_name) : null,
            jobId: String(row.id),
            reassignedAt: new Date(String(row.manually_reassigned_at)).toISOString(),
            source: "address",
          };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve pickup coordinates for a coordinate-less offer (owner-directed
 *  2026-08-13, offer 326885213): DB-first (dispatch_jobs already has real
 *  coords from a previous import/sync), else a VALIDATED TomTom geocode of the
 *  offer's startingLocation text (score floor + strong-token overlap — naive
 *  geocoding is proven unsafe). NEVER auto-accepts without coordinates from a
 *  trusted source; unresolvable → {ok:false} so the caller keeps escalating. */
async function resolveOfferPickupCoords(
  orgId: string,
  rawOffer: unknown,
  deps: AiDispatcherDeps,
  fetchImpl: typeof fetch,
): Promise<CoordsResolution> {
  const o = rawOffer as Record<string, unknown>;
  const addr = startingLocationOf(o);
  if (!addr) return { ok: false, reason: "no startingLocation text to resolve coordinates from" };
  const dbHit = await lookupDbCoords(orgId, o, addr);
  if (dbHit) return { ok: true, ...dbHit, source: "db" };
  const key = resolveTomtomKey(deps.env ?? process.env);
  if (!key) return { ok: false, reason: "geocode unavailable (no TomTom key configured)" };
  const lookup = await (deps.geocodeOverride ?? ((a: string) => tomtomGeocodeLookup(a, key, fetchImpl)))(addr);
  if (!lookup) return { ok: false, reason: "TomTom geocode lookup failed (network/HTTP/bad body)" };
  const validation = validateGeocodeResult(addr, lookup);
  if (!validation.ok) return { ok: false, reason: `TomTom geocode validated-out: ${validation.reason}` };
  return {
    ok: true,
    lat: validation.lat,
    lng: validation.lng,
    source: "geocode",
    detail: `TomTom geocode '${addr}' → '${lookup.freeformAddress}' (score ${lookup.score})`,
  };
}

/** Build the OfferShape from the raw offer record with the given pickup
 *  coordinates (lat/lng null = missing). Shared by validateOfferShape (coords
 *  from the payload) and the coordinate-less resolution path (coords from a
 *  DB hit or a validated geocode — owner-directed 2026-08-13). Never coerces a
 *  missing field: every missing/mistyped required field is reported. */
function buildOfferShape(
  o: Record<string, unknown>,
  lat: number | null,
  lng: number | null,
): { ok: true; offer: OfferShape } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const callRequestId = numeric(o.callRequestId);
  if (callRequestId == null) missing.push("callRequestId");
  const status = numeric(o.status);
  if (status == null) missing.push("status");
  if (lat == null) missing.push("startLocationLatitude");
  if (lng == null) missing.push("startLocationLongitude");
  const expirationDateUtc = typeof o.expirationDateUtc === "string" ? o.expirationDateUtc : null;
  if (!expirationDateUtc || Number.isNaN(Date.parse(expirationDateUtc))) missing.push("expirationDateUtc");
  if (missing.length) return { ok: false, missing };
  const maxEta = numeric(o.maxEta);
  const serviceType = typeof o.serviceType === "string" && o.serviceType.trim() ? o.serviceType.trim() : null;
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
      serviceType,
      purchaseOrderNumber,
      drivers,
    },
  };
}

/** Returns {ok:true, offer} or {ok:false, missing: string[]} — why the offer
 *  failed the documented-shape rail. Never coerces a missing field. */
export function validateOfferShape(raw: unknown): { ok: true; offer: OfferShape } | { ok: false; missing: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, missing: ["<offer is not an object>"] };
  const o = raw as Record<string, unknown>;
  return buildOfferShape(o, numeric(o.startLocationLatitude), numeric(o.startLocationLongitude));
}

/* ------------------------------- driver selection ------------------------------- */

type NearestDriver = Record<string, unknown>;

/** One candidate's road-aware ETA facts (everything the decision row needs). */
export type ChosenDriverEta = {
  driver: NearestDriver;
  /** Geographic distance from the selected ETA origin to pickup, in miles. */
  distanceMiles: number;
  /** GPS is primary-truth; anchor/payload origins are honest fallbacks. */
  distanceBasis: "gps" | "fallback";
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
  /** ETA origin (owner-directed 2026-08-13): the actual coordinates the road
   *  ETA was routed FROM (freshest app GPS fix, anchor center, or payload). */
  originLat: number;
  originLng: number;
  /** What produced the origin: "gps" (fresh app fix), "anchor" (anchor center
   *  — stale fix), "payload" (nearestDrivers lat/lng — no app fix). */
  originBasis: EtaOriginBasis;
  /** Age of the freshest app GPS fix in minutes (null when no fix exists). */
  gpsFixAgeMinutes: number | null;
  /** The driver's area anchor (first assigned job of the day) when they have
   *  one; null for flexible (unanchored) drivers. */
  anchor: DriverAnchor | null;
  /** The anchor radius used for the in-area test (ANCHOR_RADIUS_MILES). */
  anchorRadiusMiles: number;
  /** True when NO in-area candidate existed and the global closest-by-ETA
   *  fallback engaged (owner-directed 2026-08-13). */
  areaFallback: boolean;
};

/** Area-geography context (owner-directed 2026-08-13): the per-org anchors
 *  (first assigned job of the day per driver), freshest app GPS fixes, the
 *  anchor radius, and "now" for staleness. All optional — when omitted the
 *  engine behaves exactly as before (payload-GPS origins, no area filter).
 *  The manual-reassign path passes NO anchors (the human's choice is
 *  authoritative — never area-filtered), only fixes. */
/** SAME-STATE GUARD context (owner rule 2026-08-13: "No cross-state
 *  assignments"). When `stateGuard` is present on the AreaContext, ONLY
 *  drivers whose CURRENT state (resolved by the caller from real driver
 *  location data) equals the JOB's state are eligible; a driver whose state
 *  cannot be resolved is EXCLUDED (fail closed); a null jobState means the
 *  job's state is unresolvable and NO candidate may be chosen (the caller
 *  escalates instead of assigning). Opt-in: callers that omit it keep the
 *  pre-guard behavior exactly. */
export type StateGuardContext = {
  /** Uppercase 2-letter job state ("TX"); null = unresolvable → fail closed. */
  jobState: string | null;
  /** Resolve a driver's CURRENT state from its ETA-origin coordinates. */
  resolveDriverState: (driverId: number, lat: number, lng: number) => Promise<string | null>;
};
/** What the guard decided during one chooseBestDriverByRoad call (the caller
 *  passes an out-object to learn WHY selection was blocked — the return null
 *  alone cannot distinguish "no driver" from "guard refused"). */
export type StateGuardOutcome = {
  active: boolean;
  jobState: string | null;
  blocked: boolean;
  /** "job_state_unknown" | "no_in_state_driver" | null. */
  blockedReason: string | null;
  /** Selection tier: online in-state, offline in-state, or cross-state ETA candidate. */
  assignmentTier?: "online_in_state" | "offline_in_state" | "cross_state";
  checked: number;
  inState: number;
  excluded: Array<{ driverId: number; state: string | null; reason: string }>;
};
export type ServiceQualificationOutcome = { serviceType: string | null; assessed: boolean; excluded: Array<{ driverId: number; reason: string }> };

function serviceTypeQualification(driver: NearestDriver, serviceType: string | null): { eligible: boolean; reason: string } {
  if (!serviceType?.trim()) return { eligible: true, reason: "service type could not be assessed (missing/unknown)" };
  const wanted = serviceType.trim().toLowerCase();
  const values: unknown[] = ["serviceExclusions", "excludedServices", "excludedServiceTypes", "serviceTypeExclusions"].flatMap((k) => Array.isArray(driver[k]) ? driver[k] : []);
  const excluded = values.some((v) => { const x = typeof v === "string" ? v : v && typeof v === "object" ? (v as Record<string, unknown>).serviceType ?? (v as Record<string, unknown>).service : null; return typeof x === "string" && x.trim().toLowerCase() === wanted; });
  return excluded ? { eligible: false, reason: `excluded: driver explicitly does not perform service type '${serviceType}'` } : { eligible: true, reason: "service type eligible (no explicit exclusion)" };
}

export type AreaContext = {
  anchors?: Map<string, DriverAnchor>;
  gpsFixes?: Map<string, DriverGpsFix>;
  /** In-area circle radius (defaults to ANCHOR_RADIUS_MILES). */
  anchorRadiusMiles?: number;
  /** "Now" for the fresh/stale fix decision (defaults to new Date()). */
  now?: Date;
  /** Same-state assignment guard (owner-directed 2026-08-13). */
  stateGuard?: StateGuardContext;
  serviceType?: string | null;
  serviceQualification?: ServiceQualificationOutcome;
  zoneMatches?: Map<string, boolean>;
  regionalPreference?: Map<string, number>;
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
  /** Overrides the chain's STARTING position (the GPS→first-job leg): the
   *  area-geography path passes the driver's freshest app GPS fix or anchor
   *  center (owner 2026-08-13); when omitted the driver's payload
   *  latitude/longitude is used (pre-geography default). */
  origin?: { lat: number; lng: number },
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
  const originLat = origin != null && Number.isFinite(origin.lat) ? origin.lat : Number(driver.latitude);
  const originLng = origin != null && Number.isFinite(origin.lng) ? origin.lng : Number(driver.longitude);
  const unlocatedJobs = Math.max(0, total - queue.length);
  let queueMinutes = 0;
  let prevLat = originLat;
  let prevLng = originLng;
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

/** Road-aware driver choice (owner-directed 2026-08-11, queue-aware; area +
 *  fresh-GPS ETA origin owner-directed 2026-08-13):
 *  rails = checked in && real GPS (lat/lng nonzero AND finite) && finite
 *  estimatedTimeSeconds && active-job-count < MAX_DRIVER_QUEUE (active =
 *  dispatch_jobs lifecycle statuses new/offered/accepted/en_route/arrived,
 *  cross-checked against the payload `calls` — a driver at the 3-job cap is
 *  NOT eligible). Each ELIGIBLE candidate is routed from its ETA ORIGIN (the
 *  freshest app GPS fix when ≤ STALE_GPS_FIX_MINUTES old, else the driver's
 *  area-anchor center when they have one — stale fix, else the payload
 *  lat/lng — the pre-geography default) to the pickup, and the minimum ROAD
 *  ETA wins — a driver with a better real drive time beats one with a better
 *  straight-line time. Routing failures fall back to the factor model per
 *  candidate, so a driver is never dropped for a router hiccup.
 *  AREA ANCHOR (owner-directed 2026-08-13): a driver whose first assigned job
 *  of the day set their anchor is a candidate only when the job falls inside
 *  their anchor circle (ANCHOR_RADIUS_MILES); drivers with NO anchor are
 *  flexible candidates for any job. When NO in-area candidate exists, fall
 *  back to the global closest-by-ETA among ALL available drivers
 *  (areaFallback flagged on the choice). The manual-reassign path never
 *  passes anchors (the human's choice is authoritative — the caller narrows
 *  the pool).
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
  area?: AreaContext,
  out?: { stateGuard?: StateGuardOutcome },
): Promise<ChosenDriverEta | null> {
  const queues = driverQueues ?? new Map<string, DriverQueue>();
  const baseEligible = drivers.filter((d): d is NearestDriver => {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    const o = d as NearestDriver;
    // Offline candidates are admitted only when the state-tiered guard is
    // active; the unguarded pure selector retains its historical online-only
    // contract while dispatch can explicitly waive it for in-state fallback.
    if (!area?.stateGuard && o.isCheckedIn !== true) return false;
    return (
      typeof o.latitude === "number" && Number.isFinite(o.latitude) && o.latitude !== 0 &&
      typeof o.longitude === "number" && Number.isFinite(o.longitude) && o.longitude !== 0 &&
      typeof o.estimatedTimeSeconds === "number" && Number.isFinite(o.estimatedTimeSeconds)
    );
  });
  if (!baseEligible.length) return null;

  // --- area anchor filter + ETA origin (owner-directed 2026-08-13) ---
  // Anchored drivers are candidates only when the job falls inside their
  // anchor circle; unanchored drivers are flexible. When NO in-area candidate
  // exists the pool falls back to ALL available drivers (global closest by
  // ETA — the owner's New Haven example: a Darien-anchored Jayden must not
  // take a New Haven job when a West-Haven-anchored Levi is in-area).
  const radius = area?.anchorRadiusMiles ?? ANCHOR_RADIUS_MILES;
  const now = area?.now ?? new Date();
  const inArea = (d: NearestDriver): boolean => {
    const anchor = area?.anchors?.get(String(d.driverId));
    if (!anchor) return true; // no anchor → flexible candidate
    return haversineMiles(pickupLat, pickupLng, anchor.lat, anchor.lng) <= radius;
  };
  const qualification = area?.serviceQualification;
  const servicePool = baseEligible.filter((d) => {
    const result = serviceTypeQualification(d, area?.serviceType ?? null);
    if (!result.eligible && qualification) qualification.excluded.push({ driverId: Number(d.driverId), reason: result.reason });
    return result.eligible;
  });
  if (qualification) {
    qualification.serviceType = area?.serviceType?.trim() || null;
    qualification.assessed = Boolean(area?.serviceType?.trim());
  }
  const areaPool = servicePool.filter(inArea);
  const usedAreaFallback = areaPool.length === 0;
  const pool = usedAreaFallback ? servicePool : areaPool;

  // ETA origin per driver: freshest app GPS fix when fresh (≤ 15 min); a
  // STALE fix falls back to the anchor center (basis noted — the offer/audit
  // must never silently quote a stale position); no app fix at all keeps the
  // payload GPS (the pre-geography default — absence of a ping is not treated
  // as a stale ping).
  const originFor = (d: NearestDriver): { lat: number; lng: number; basis: EtaOriginBasis; fixAgeMinutes: number | null } => {
    const did = String(d.driverId);
    const fix = area?.gpsFixes?.get(did);
    let fixAge: number | null = null;
    if (fix) {
      const t = Date.parse(fix.capturedAt);
      if (Number.isFinite(t)) fixAge = (now.getTime() - t) / 60000;
    }
    if (fix && fixAge != null && fixAge >= 0 && fixAge <= STALE_GPS_FIX_MINUTES) {
      return { lat: fix.lat, lng: fix.lng, basis: "gps", fixAgeMinutes: fixAge };
    }
    const anchor = area?.anchors?.get(did);
    if (fix && fixAge != null && fixAge > STALE_GPS_FIX_MINUTES && anchor) {
      return { lat: anchor.lat, lng: anchor.lng, basis: "anchor", fixAgeMinutes: fixAge };
    }
    return { lat: Number(d.latitude), lng: Number(d.longitude), basis: "payload", fixAgeMinutes: fixAge };
  };

  // --- STATE-TIERED GUARD (owner directive 2026-08-15). Resolve state from
  // the ETA origin (fresh GPS, then anchor, then Towbook last-known payload).
  // Online is only a priority signal; offline candidates remain eligible when
  // no online driver is proven in-state. Unknown state always fails closed.
  let statePool = pool;
  const guardOut = out?.stateGuard;
  if (guardOut && area?.stateGuard && statePool.length > 0) {
    guardOut.active = true;
    guardOut.jobState = area.stateGuard.jobState;
    if (!area.stateGuard.jobState) {
      guardOut.blocked = true; guardOut.blockedReason = "job_state_unknown"; return null;
    }
    const inState: NearestDriver[] = [];
    const onlineInState: NearestDriver[] = [];
    const excluded: StateGuardOutcome["excluded"] = [];
    for (const d of statePool) {
      const did = Number(d.driverId);
      const origin = originFor(d);
      guardOut.checked++;
      const st = await area.stateGuard.resolveDriverState(did, origin.lat, origin.lng);
      if (st && st.toUpperCase() === area.stateGuard.jobState.toUpperCase()) {
        inState.push(d);
        if (d.isCheckedIn === true) onlineInState.push(d);
        guardOut.inState++;
      } else {
        excluded.push({ driverId: did, state: st ? st.toUpperCase() : null,
          reason: st ? `driver state ${st.toUpperCase()} ≠ job state ${area.stateGuard.jobState.toUpperCase()}` : "driver state unknown (reverse geocode unavailable)" });
      }
    }
    guardOut.excluded = excluded;
    if (onlineInState.length) {
      statePool = onlineInState; guardOut.assignmentTier = "online_in_state";
    } else if (inState.length) {
      statePool = inState; guardOut.assignmentTier = "offline_in_state";
    } else {
      // No driver in the job state: cross-state is the last dispatch tier.
      // Only provable out-of-state drivers qualify; unknown-state drivers fail closed.
      // The caller applies the SLA ceiling before accepting this choice.
      statePool = statePool.filter((d) => excluded.some((e) => e.driverId === Number(d.driverId) && e.state != null));
      guardOut.assignmentTier = "cross_state";
      if (!statePool.length) { guardOut.blocked = true; guardOut.blockedReason = "no_in_state_driver"; return null; }
    }
  }
  const underCap = statePool.filter((d) => driverActiveCount(d, queues) < MAX_DRIVER_QUEUE);
  const pickCandidates = underCap.length ? underCap : statePool;
  const routeOne = async (d: NearestDriver): Promise<ChosenDriverEta | null> => {
    const straightLineMinutes = Math.max(1, Math.ceil(Number(d.estimatedTimeSeconds) / 60));
    const pingAge = gpsPingAgeMinutes(d);
    const activeCount = driverActiveCount(d, queues);
    const origin = originFor(d);
    const anchor = area?.anchors?.get(String(d.driverId)) ?? null;
    if (activeCount > 0) {
      // Workload-aware (owner-directed 2026-08-11): a driver with active jobs
      // must finish them before this offer — remaining on the in-progress job
      // + travel between consecutive job pickups + the final leg from the LAST
      // job's location to the offer. A busy driver is always modelable
      // (unlocated jobs contribute their service time at the tail), so the
      // chain never fails here. The chain's STARTING position is the same
      // origin the free path uses (freshest fix / anchor center / payload).
      const geometry = queueGeometryFor(d, queues);
      const chain = await workloadAwareArrivalMinutes(d, geometry, pickupLat, pickupLng, roadRouter, activeCount, origin);
      if (chain) {
        return {
          driver: d,
          distanceMiles: haversineMiles(origin.lat, origin.lng, pickupLat, pickupLng),
          distanceBasis: origin.basis === "gps" ? "gps" : "fallback",
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
          originLat: origin.lat, originLng: origin.lng, originBasis: origin.basis,
          gpsFixAgeMinutes: origin.fixAgeMinutes, anchor, anchorRadiusMiles: radius, areaFallback: usedAreaFallback,
        };
      }
      return null; // free-only guard; busy drivers are always modelable
    }
    let result: RoadResult | null = null;
    try {
      result = roadRouter ? await roadRouter(origin.lat, origin.lng, pickupLat, pickupLng) : null;
    } catch { result = null; }
    if (result && Number.isFinite(result.seconds) && result.seconds > 0) {
      return {
        driver: d,
        distanceMiles: haversineMiles(origin.lat, origin.lng, pickupLat, pickupLng),
        distanceBasis: origin.basis === "gps" ? "gps" : "fallback",
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
        originLat: origin.lat, originLng: origin.lng, originBasis: origin.basis,
        gpsFixAgeMinutes: origin.fixAgeMinutes, anchor, anchorRadiusMiles: radius, areaFallback: usedAreaFallback,
      };
    }
    const fallback = fallbackRoadMinutes(
      haversineMiles(origin.lat, origin.lng, pickupLat, pickupLng),
    );
    return {
      driver: d,
      distanceMiles: haversineMiles(origin.lat, origin.lng, pickupLat, pickupLng),
      distanceBasis: origin.basis === "gps" ? "gps" : "fallback",
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
      originLat: origin.lat, originLng: origin.lng, originBasis: origin.basis,
      gpsFixAgeMinutes: origin.fixAgeMinutes, anchor, anchorRadiusMiles: radius, areaFallback: usedAreaFallback,
    };
  };

  // Proximity is the owner-directed primary rank. GPS-backed origins always
  // outrank fallback origins; within the same tier, geographic distance wins,
  // then road ETA, zone preference, regional preference, and deterministic
  // driver id. This comparator is shared by both dispatch paths so preference
  // terms cannot be bypassed when candidates are under the queue cap.
  const rank = (a: ChosenDriverEta, b: ChosenDriverEta): number =>
    (a.distanceBasis === "gps" ? 0 : 1) - (b.distanceBasis === "gps" ? 0 : 1) ||
    (a.distanceMiles - b.distanceMiles > 0.01 ? 1 : b.distanceMiles - a.distanceMiles > 0.01 ? -1 : 0) ||
    a.baseMinutes - b.baseMinutes ||
    (area?.zoneMatches?.get(String(b.driver.driverId)) ? 1 : 0) - (area?.zoneMatches?.get(String(a.driver.driverId)) ? 1 : 0) ||
    (area?.regionalPreference?.get(String(b.driver.driverId)) ?? 0) - (area?.regionalPreference?.get(String(a.driver.driverId)) ?? 0) ||
    String(a.driver.driverId ?? "").localeCompare(String(b.driver.driverId ?? ""));

  if (underCap.length) {
    const routed = (await Promise.all(pickCandidates.map(routeOne))).filter((r): r is ChosenDriverEta => r != null);
    routed.sort(rank);
    return routed[0] ?? null;
  }

  // --- all-loaded: EVERY candidate is at the cap → chain-aware arrival ---
  const modeled = await Promise.all(pool.map(async (d): Promise<ChosenDriverEta | null> => {
    const geometry = queueGeometryFor(d, queues);
    const origin = originFor(d);
    const arrival = await workloadAwareArrivalMinutes(d, geometry, pickupLat, pickupLng, roadRouter, driverActiveCount(d, queues), origin);
    if (!arrival) return null; // free driver — cannot be in the all-loaded path
    const straightLineMinutes = Math.max(1, Math.ceil(Number(d.estimatedTimeSeconds) / 60));
    const activeCount = driverActiveCount(d, queues);
    const anchor = area?.anchors?.get(String(d.driverId)) ?? null;
    return {
      driver: d,
      distanceMiles: haversineMiles(origin.lat, origin.lng, pickupLat, pickupLng),
      distanceBasis: origin.basis === "gps" ? "gps" : "fallback",
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
      originLat: origin.lat, originLng: origin.lng, originBasis: origin.basis,
      gpsFixAgeMinutes: origin.fixAgeMinutes, anchor, anchorRadiusMiles: radius, areaFallback: usedAreaFallback,
    };
  }));
  const winners = modeled.filter((m): m is ChosenDriverEta => m != null);
  if (!winners.length) return null;
  winners.sort(rank);
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
  // ETA-origin transparency (owner-directed 2026-08-13): the label prints the
  // ACTUAL origin the road ETA was routed FROM and names the basis — a stale
  // app fix routed from the anchor center is never silent in the ledger.
  const originNote = c.originBasis === "anchor"
    ? `; origin: anchor center${c.gpsFixAgeMinutes != null ? ` (GPS fix ${Math.round(c.gpsFixAgeMinutes)} min old)` : " (no app GPS fix)"}`
    : c.originBasis === "gps"
      ? `; origin: app GPS fix${c.gpsFixAgeMinutes != null ? ` (${Math.round(c.gpsFixAgeMinutes)} min old)` : ""}`
      : "";
  return `ETA ${finalMinutes} min (${base} + buffer ${buffer}${delay}${tomtomNote}${pingNote}; floor ${floor}, ceiling ${ceiling}; straight-line ${c.straightLineMinutes}; GPS ${Number(c.originLat) || Number(c.driver.latitude)},${Number(c.originLng) || Number(c.driver.longitude)}${originNote})`;
}

/** Human-readable area/origin note for the decision reason (owner-directed
 *  2026-08-13): which anchor (if any) the chosen driver carries + whether the
 *  job is in-circle, when the global closest-by-ETA fallback engaged (no
 *  in-area candidate), and when the ETA origin was the anchor center (stale
 *  app fix — never silent). Returns null when there is nothing notable (no
 *  anchors configured — pre-geography behavior). */
export function areaSelectionNote(c: ChosenDriverEta, pickupLat: number, pickupLng: number): string | null {
  const parts: string[] = [];
  if (c.anchor) {
    const dist = haversineMiles(pickupLat, pickupLng, c.anchor.lat, c.anchor.lng);
    parts.push(`area anchor job ${c.anchor.jobId} (${c.anchor.lat.toFixed(4)},${c.anchor.lng.toFixed(4)}; pickup ${dist.toFixed(1)} mi ${dist <= c.anchorRadiusMiles ? "in-circle" : "OUTSIDE"})`);
  }
  if (c.areaFallback) parts.push("no in-area candidate — global closest-by-ETA fallback");
  if (c.originBasis === "anchor") {
    parts.push(`ETA origin: anchor center (app GPS fix ${c.gpsFixAgeMinutes != null ? `${Math.round(c.gpsFixAgeMinutes)} min old` : "absent"})`);
  } else if (c.originBasis === "gps") {
    parts.push(`ETA origin: app GPS fix (${c.gpsFixAgeMinutes != null ? `${Math.round(c.gpsFixAgeMinutes)} min old` : "fresh"})`);
  }
  return parts.length ? `; ${parts.join("; ")}` : null;
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


/* ------------------------------ assignment push ------------------------------ */
/** Fire the assigned-offer push after a VERIFIED dispatch (owner top priority
 *  2026-08-12). Best-effort and never awaited by the engine flow: push failures
 *  must never fail or slow the dispatch. The deps.sendAssignmentPush seam lets
 *  hermetic tests mock the sender; production resolves the LD contractor by
 *  Towbook driver id and sends through push-core (RFC 8291 web push). */
async function fireDispatchAssignmentPush(
  orgId: string,
  driver: { driverId: number | string; driverName?: string | null },
  verification: DispatchVerification,
  offer: OfferShape,
  etaMinutes: number | null,
  deps: AiDispatcherDeps,
): Promise<void> {
  try {
    const payload: import("./push-core").AssignmentPushPayload = {
      callId: verification.callId,
      callRequestId: offer.callRequestId,
      jobType: "Tow job",
      location: `${offer.startLocationLatitude},${offer.startLocationLongitude}`,
      etaMinutes,
      jobUrl: "/driver",
    };
    if (deps.sendAssignmentPush) {
      await deps.sendAssignmentPush(orgId, driver.driverId, payload);
    } else {
      const { sendAssignmentPushByTowbookDriver } = await import("./push-core");
      await sendAssignmentPushByTowbookDriver(orgId, driver.driverId, payload);
    }
  } catch {
    /* push never fails the dispatch */
  }
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
    // Geography + ETA accuracy (owner-directed 2026-08-13): derive every
    // driver's area anchor (first assigned job of the day, ET), freshest app
    // GPS fix, and active-job queue ONCE per run from existing rows
    // (dispatch_jobs assignment history + driver_locations — no migration),
    // then let chooseBestDriverByRoad apply the in-area rule + fresh-fix ETA
    // origin per offer. Never throws (each loader degrades to empty).
    const [driverQueues, driverAnchors, driverGpsFixes] = await Promise.all([
      loadOrgDriverQueues(orgId),
      loadDriverAnchors(orgId),
      loadDriverGpsFixes(orgId),
    ]);

    for (const rawOffer of offers) {
      let shape: { ok: true; offer: OfferShape } | { ok: false; missing: string[] } = validateOfferShape(rawOffer);
      let coordsProvenance: { source: "db" | "geocode"; detail: string } | null = null;
      if (!shape.ok) {
        // Coordinate-less offers (owner-directed 2026-08-13, live offer
        // 326885213 — the first offer ever with NO startLocationLatitude/
        // Longitude): when the ONLY shape problem is the missing coords and the
        // offer carries a startingLocation text, resolve REAL coordinates —
        // DB-first (dispatch_jobs already imported the call with waypoint
        // coords), else a VALIDATED TomTom geocode (score floor + strong-token
        // overlap; naive geocoding is proven unsafe). Resolved → the offer
        // proceeds through the NORMAL dispatch path with the provenance
        // recorded on the decision; unresolvable → the existing escalation
        // rail with the resolution failure noted (never auto-accept blind).
        const coordsOnly = shape.missing.length > 0
          && shape.missing.every((m) => m === "startLocationLatitude" || m === "startLocationLongitude");
        if (coordsOnly) {
          const resolved = await resolveOfferPickupCoords(orgId, rawOffer, deps, fetchImpl);
          if (resolved.ok) {
            const rebuilt = buildOfferShape(rawOffer as Record<string, unknown>, resolved.lat, resolved.lng);
            if (rebuilt.ok) {
              shape = rebuilt;
              coordsProvenance = { source: resolved.source, detail: resolved.detail };
            }
          }
        }
      }
      if (!shape.ok) {
        const raw = rawOffer as Record<string, unknown>;
        const key = shapeKeyOf(rawOffer);
        const id = numeric(raw.callRequestId);
        const status = numeric(raw.status);
        const expiration = typeof raw.expirationDateUtc === "string" && !Number.isNaN(Date.parse(raw.expirationDateUtc)) ? raw.expirationDateUtc : null;
        if (id != null && status === 0 && expiration) {
          if (await alreadyProcessed(orgId, String(id))) continue;
          const synthetic = buildOfferShape(raw, 0, 0);
          if (synthetic.ok) { shape = synthetic; }
          else {
            // Coordinates are deliberately irrelevant to the fallback claim.
            if (Date.parse(expiration) < Date.now()) {
              const reason = `offer expired (expirationDateUtc=${expiration}) — not auto-accepted`;
              await recordDecision(orgId, actor, { callRequestId: String(id), callId: null, decision: "escalated_expired", driverId: null, driverName: null, etaMinutes: null, zoneDistanceMiles: null, reason, rawResponse: { offer: raw } }); result.processed++; result.decisions.push({ callRequestId: String(id), decision: "escalated_expired", escalated: true, reason }); continue;
            }
            const recordFallback = async (reason: string) => { const eta = Number(numeric(raw.maxEta) ?? settings.maxEtaMinutes); const a = await postAccept(fetchImpl, baseUrl, cookies, String(id), eta, 0, "auto-accept by Lightning Dispatch; awaiting driver assignment"); const decision = a.ok ? "auto_accept_no_driver" : "escalated_accept_failed"; const msg = a.ok ? `${reason} — accepted with driverId 0 at the ${eta}-minute SLA ceiling` : `accept POST failed after retry (${a.attempts.map((x) => x.error ?? `HTTP ${x.status}`).join("; ")})`; await recordDecision(orgId, actor, { callRequestId: String(id), callId: null, decision, driverId: a.ok ? "0" : null, driverName: null, etaMinutes: a.ok ? eta : null, zoneDistanceMiles: null, reason: msg, rawResponse: { offer: raw, accept: a.raw, attempts: a.attempts } }); result.processed++; result.decisions.push({ callRequestId: String(id), decision, escalated: decision !== "auto_accept_no_driver", reason: msg }); };
            await recordFallback(`offer shape incomplete (${shape.missing.join(", ")})`); continue;
          }
        }
        if (!shape.ok) {
          const reason = `offer shape cannot be accepted — missing/mistyped: ${shape.missing.join(", ")}`;
          if (await alreadyProcessed(orgId, key)) continue;
          await recordDecision(orgId, actor, { callRequestId: key, callId: null, decision: "escalated_unexpected_shape", driverId: null, driverName: null, etaMinutes: null, zoneDistanceMiles: null, reason, rawResponse: { offer: rawOffer } }); result.processed++; result.decisions.push({ callRequestId: key, decision: "escalated_unexpected_shape", escalated: true, reason }); continue;
        }
      }
      const { offer } = shape;
      const jobTypeRows = await sql() `SELECT service_type, note, raw_json FROM dispatch_jobs WHERE org_id=${orgId} AND towbook_job_id=${offer.callRequestId} ORDER BY created_at DESC LIMIT 1`;
      // dispatch_jobs is authoritative. If older sync data left service_type blank,
      // preserve the tow safety rail by inspecting the captured note/raw payload.
      const jobRow = jobTypeRows[0] as Record<string, unknown> | undefined;
      const rawText = JSON.stringify({ note: jobRow?.note ?? "", raw: jobRow?.raw_json ?? null });
      const inferredTow = /service\s*needed\s*[:=]\s*(tow|heavy)|\btow\b|\bheavy\b|\bflatbed\b/i.test(rawText) ? "tow" : null;
      if (jobRow?.service_type != null && String(jobRow.service_type).trim()) offer.serviceType = String(jobRow.service_type).trim();
      else if (inferredTow) offer.serviceType = inferredTow;
      if (coordsProvenance) offer.coords = coordsProvenance;
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
          reason: d.reason ? `${d.reason}${coordsProvenance ? ` (pickup coords: ${coordsProvenance.source} — ${coordsProvenance.detail})` : ""}` : "",
          rawResponse: d.rawResponse ?? null,
        });

      // Universal claim fallback: eligibility or data uncertainty must never
      // strand a live offer. The SLA ceiling is an honest not-yet-assigned ETA.
      const acceptFallback = async (reason: string, rawResponse: unknown, zoneDistanceMiles: number | null = null) => {
        const eta = Math.min(settings.maxEtaMinutes, offer.maxEta ?? settings.maxEtaMinutes);
        const accept = await postAccept(fetchImpl, baseUrl, cookies, offer.callRequestId, eta, 0, "auto-accept by Lightning Dispatch; awaiting driver assignment");
        if (!accept.ok) {
          const failed = `accept POST failed after retry (${accept.attempts.map((a) => a.error ?? `HTTP ${a.status}`).join("; ")}) — offer could not be claimed`;
          await record({ decision: "escalated_accept_failed", etaMinutes: null, zoneDistanceMiles, reason: failed, rawResponse: { offer, cause: reason, accept: accept.raw, attempts: accept.attempts, evidence: rawResponse } });
          result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "escalated_accept_failed", escalated: true, reason: failed });
          return;
        }
        const accepted = `${reason} — accepted with driverId 0 at the ${eta}-minute SLA ceiling; awaiting driver assignment`;
        await record({ decision: "auto_accept_no_driver", driverId: "0", etaMinutes: eta, zoneDistanceMiles, reason: accepted, rawResponse: { offer, cause: reason, accept: accept.raw, evidence: rawResponse } });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "auto_accept_no_driver", escalated: true, reason: accepted });
      };

      // --- multi-zone check (dispatch_zones; org_settings centroid is deprecated) ---
      if (offer.startLocationLatitude === 0 || offer.startLocationLongitude === 0) {
        await acceptFallback(`no usable pickup coordinates (lat=${offer.startLocationLatitude}, lng=${offer.startLocationLongitude})`, { offer: rawOffer });
        continue;
      }
      const rawStartingForZone = startingLocationOf(rawOffer as Record<string, unknown>);
      const zoneState = await resolveJobState(orgId, rawOffer as Record<string, unknown>, rawStartingForZone, resolveTomtomKey(deps.env ?? process.env) ?? "", fetchImpl);
      if (!zoneState.state) {
        const reason = `job state UNKNOWN (offer address ${rawStartingForZone ? `"${rawStartingForZone}"` : "missing"} did not resolve to a US state; state_resolution=unknown${zoneState.note ? `; ${zoneState.note}` : ""}) — cannot verify zone (no accept)`;
        await record({ decision: "escalated_state_unknown", reason, rawResponse: { offer } });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "escalated_state_unknown", escalated: true, reason });
        continue;
      }
      const zoneRows = await sql()`SELECT id,lat,lng,radius_miles,zip_codes FROM dispatch_zones WHERE org_id=${orgId} AND active=TRUE AND state=${zoneState.state.toUpperCase()}` as Array<Record<string, unknown>>;
      const zoneLat = zoneState.source === "authoritative" && zoneState.authoritativeLat != null
        ? zoneState.authoritativeLat : Number(offer.startLocationLatitude);
      const zoneLng = zoneState.source === "authoritative" && zoneState.authoritativeLng != null
        ? zoneState.authoritativeLng : Number(offer.startLocationLongitude);
      const jobZip = rawStartingForZone ? zipOf(rawStartingForZone) : null;
      const lat = zoneLat, lng = zoneLng;
      const usableZones = zoneRows.map((z) => {
        const zLat = Number(z.lat), zLng = Number(z.lng), radius = Number(z.radius_miles);
        const zips = Array.isArray(z.zip_codes) ? z.zip_codes.map(String) : [];
        const zipMatch = Boolean(jobZip && zips.includes(jobZip));
        const latDelta = radius / 69;
        const lngDelta = radius / (69 * Math.max(0.1, Math.cos(zLat * Math.PI / 180)));
        const inBox = Math.abs(lat - zLat) <= latDelta && Math.abs(lng - zLng) <= lngDelta;
        const distance = haversineMiles(lat, lng, zLat, zLng);
        return { id: String(z.id), distance, matched: zipMatch || (inBox && distance <= radius) };
      }).filter((z) => z.matched).sort((a, b) => a.distance - b.distance);
      const zoneDistance = usableZones[0]?.distance ?? null;
      if (!usableZones.length) {
        // Keep the nearest resolved-state zone distance for the out-of-zone
        // ledger too (the fallback claim still records it as a diagnostic).
        const nearestZoneDistance = zoneRows.reduce((nearest, z) => {
          const distance = haversineMiles(lat, lng, Number(z.lat), Number(z.lng));
          return nearest == null || distance < nearest ? distance : nearest;
        }, null as number | null);
        await acceptFallback(`pickup is outside active ${zoneState.state.toUpperCase()} dispatch zones`, { offer, state: zoneState, zonesChecked: zoneRows.length }, nearestZoneDistance);
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
        await acceptFallback(`driver lookup failed (${nd.error ?? `HTTP ${nd.status}`})`, { offer, nearestDrivers: nd.bodyText.slice(0, 400) });
        continue;
      }
      // --- road-aware driver choice: route EVERY candidate from its precise
      // GPS to the pickup and pick the minimum ROAD ETA (fallback factor model
      // per candidate when routing fails; no-GPS drivers are never eligible).
      // Eligibility rail (2026-08-10 incident fix): if the offer carries an
      // explicit `drivers[]` eligible list (the UI dropdown is built from it),
      // ONLY those ids may be dispatched — accept-with-driverId for an
      // ineligible driver is silently ignored by Towbook. ---
      // Preserve omitted vs explicit empty: Towbook omitted means any company driver;
      // an explicit empty eligible list means nobody is eligible.
      const eligibleIds = Array.isArray(offer.drivers) ? new Set(offer.drivers) : null;
      // MANUAL-REASSIGN GUARD (owner-directed 2026-08-13): when a HUMAN already
      // reassigned a call tied to this offer (purchase-order / address match on
      // a dispatch_jobs row carrying the manual-reassign marker), the human's
      // latest assignment is AUTHORITATIVE — the engine must NOT re-dispatch to
      // the road-best driver. The candidate pool is narrowed to the human-chosen
      // driver ONLY (when they are also in the offer's eligible list; an
      // ineligible human-chosen driver cannot be accepted with their id, so the
      // offer is accepted WITHOUT dispatch and escalated — never silently
      // overwritten with a different driver). Offline human-chosen drivers are
      // still dispatched (the accept carries their driverId and the verification
      // PUT attaches them — offline dispatch is owner-approved, and the reassign
      // push reaches offline phones). The ledger reason records the respect.
      const humanReassigned = await lookupHumanReassignedDriver(orgId, offer);
      const manualDriverId = humanReassigned ? Number(humanReassigned.driverTowbookId) || 0 : 0;
      const manualEligible = manualDriverId > 0 && (!eligibleIds || eligibleIds.has(manualDriverId));
      const manualNote = humanReassigned
        ? `manual reassignment respected — human-chosen driver ${humanReassigned.driverName ?? humanReassigned.driverTowbookId} (reassigned ${humanReassigned.reassignedAt} on job ${humanReassigned.jobId}) kept as authoritative; NOT re-dispatched to the road-best driver`
        : null;
      const candidates = humanReassigned
        ? manualEligible
          ? (nd.body as unknown[]).filter((d) => {
              const id = Number((d as Record<string, unknown>).driverId);
              return Number.isFinite(id) && id === manualDriverId;
            })
          : []
        : eligibleIds
          ? (nd.body as unknown[]).filter((d) => {
              const id = Number((d as Record<string, unknown>).driverId);
              return Number.isFinite(id) && eligibleIds.has(id);
            })
          : (nd.body as unknown[]);
      const serviceType = offer.serviceType || (typeof (rawOffer as Record<string, unknown>).serviceType === "string" ? String((rawOffer as Record<string, unknown>).serviceType) : null) || area?.serviceType || null;
      const serviceQualification: ServiceQualificationOutcome = { serviceType, assessed: Boolean(serviceType?.trim()), excluded: [] };
      const qualificationCandidates = candidates.length;
      // MINIMAL QUALIFICATION GATE is applied immediately after Towbook's eligible-list filter.
      if (settings.qualificationGateEnabled && candidates.length) {
        const ids = candidates.map((d) => Number((d as Record<string, unknown>).driverId)).filter(Number.isFinite);
        const gateRows = await sql()`SELECT u.towbook_driver_id, u.deactivated_at, m.user_id AS member_id, cp.vehicle_type,
          (SELECT COUNT(DISTINCT t.id)::int FROM contractor_doc_types t WHERE t.org_id=${orgId} AND t.active) AS required_docs,
          /* Existing GO/compliance model: every active type needs a current verified doc.
           * DISTINCT prevents legacy re-uploads from satisfying a missing type. */
          (SELECT COUNT(DISTINCT d.doc_type_id)::int FROM contractor_documents d JOIN contractor_doc_types t ON t.id=d.doc_type_id AND t.active WHERE d.org_id=${orgId} AND d.contractor_id=u.id AND d.status='verified' AND (d.expires_on IS NULL OR d.expires_on >= CURRENT_DATE)) AS approved_docs
          FROM users u LEFT JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${orgId}
          LEFT JOIN contractor_profiles cp ON cp.user_id=u.id AND cp.org_id=${orgId}
          WHERE u.towbook_driver_id = ANY(${ids})`;
        const byId = new Map(gateRows.map((r) => [String(r.towbook_driver_id), r as Record<string, unknown>]));
        const towJob = /(?:tow|heavy|flatbed|wheel[- ]?lift)/i.test(serviceType?.toLowerCase() || "");
        const onlineRows = towJob ? await sql() `SELECT u.towbook_driver_id, (l.heartbeat_at > NOW() - INTERVAL '90 seconds') AS online, COALESCE((SELECT COUNT(*) FROM dispatch_jobs j WHERE j.org_id=${orgId} AND j.assigned_driver_towbook_id=u.towbook_driver_id AND j.status NOT IN ('completed','cancelled')),0)::int AS active_count FROM users u LEFT JOIN driver_availability_log l ON l.user_id=u.id AND l.org_id=${orgId} AND l.session_started_at IS NOT NULL ORDER BY l.heartbeat_at DESC NULLS LAST` : [];
        const onlineById = new Map(onlineRows.map((r) => [String(r.towbook_driver_id), r as Record<string, unknown>]));
        const qualified = candidates.filter((d) => {
          const id = String((d as Record<string, unknown>).driverId), r = byId.get(id);
          const wanted = serviceType?.trim().toLowerCase() || "";
          const vehicle = String(r?.vehicle_type ?? "").toLowerCase();
          const towJob = /(?:tow|heavy|flatbed|wheel[- ]?lift)/i.test(wanted);
          const towCapable = /(?:tow truck|tow|heavy|flatbed|wheel[- ]?lift)/i.test(vehicle);
          const capabilityMismatch = towJob && !towCapable;
          const reason = !r ? "org-inactive" : r.deactivated_at != null ? "deactivated" : r.member_id == null ? "org-inactive" : Number(r.required_docs) > Number(r.approved_docs) ? "missing-compliance" : capabilityMismatch ? "capability-mismatch" : towJob && onlineById.get(id)?.online !== true ? "offline" : towJob && Number(onlineById.get(id)?.active_count ?? 0) > 0 ? "unavailable" : null;
          if (reason) serviceQualification.excluded.push({ driverId: Number(id), reason });
          return !reason;
        });
        candidates.splice(0, candidates.length, ...qualified);
      }
      // Qualification is a hard safety rail: unlike geographic fallback, never
      // claim an offer when every Towbook-eligible candidate failed the gate.
      // Persist the exclusion reasons in the same decision ledger used by all
      // other outcomes, then leave the offer for human handling (zero writes).
      if (settings.qualificationGateEnabled && candidates.length === 0 && (serviceQualification.excluded.length > 0 || (serviceType && /(?:tow|heavy|flatbed|wheel[- ]?lift)/i.test(serviceType)))) {
        const reason = serviceQualification.excluded.length
          ? `qualification gate excluded every eligible candidate: ${serviceQualification.excluded.map((e) => `driver ${e.driverId}: ${e.reason}`).join("; ")}`
          : "qualification gate rejected tow job: no eligible candidates";
        await record({ decision: serviceType && /(?:tow|heavy|flatbed|wheel[- ]?lift)/i.test(serviceType) ? "rejected_tow_no_eligible_driver" : "escalated_qualification_failed", driverId: null, driverName: null, etaMinutes: null, zoneDistanceMiles: null, reason, rawResponse: { offer, serviceQualification } });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: serviceType && /(?:tow|heavy|flatbed|wheel[- ]?lift)/i.test(serviceType) ? "rejected_tow_no_eligible_driver" : "escalated_qualification_failed", escalated: serviceType && /(?:tow|heavy|flatbed|wheel[- ]?lift)/i.test(serviceType) ? false : true, reason });
        continue;
      }
      // ETA v3 provider resolution: TomTom when TOMTOM_API_KEY is set (with
      // automatic fall-through to OSRM on any TomTom failure), else OSRM static,
      // else null (ETA_ROUTER=off → factor model only). Tests inject
      // routerOverride/env so this never hits real TomTom/OSRM.
      const resolved: ResolvedRouter = deps.routerOverride ?? resolveRouter(deps.env ?? process.env, fetchImpl);
      // Queue-aware capacity (owner-directed 2026-08-11): load every driver's
      // active-job count + queue geometry from the org's dispatch_jobs (the
      // sync already persists calls with assigned driver + pickup coords) —
      // one indexed read, no live Towbook calls in the selection path.
      // Area context (owner-directed 2026-08-13): anchors + freshest app GPS
      // fixes (loaded once per run above). The MANUAL-REASSIGN path passes NO
      // anchors — the human's choice is authoritative and must never be
      // area-filtered ("do not touch the manual assign path"); the fresh-fix
      // origin still improves the ETA for the human-chosen driver.
      // STATE-TIERED GUARD (owner policy 2026-08-15): prefer an online driver
      // in-state, then an offline in-state driver; permit a cross-state driver
      // only when the job state has no driver; use universal fallback last.
      // Cross-state requires ACTUAL ROAD TIME (no factor fallback); routing
      // failure fails closed. Offline cross-state drivers remain eligible.
      // Job state comes from the authoritative address (never
      // coordinates); driver states are reverse-geocoded from current origin,
      // cached per run. Unknown state fails closed (never guess assignment).
      const rawStarting = startingLocationOf(rawOffer as Record<string, unknown>);
      const tomtomKeyForGuard = resolveTomtomKey(deps.env ?? process.env);
      const jobStateResolution = await resolveJobState(orgId, rawOffer as Record<string, unknown>, rawStarting, tomtomKeyForGuard ?? "", fetchImpl);
      const jobState = jobStateResolution.state;
      const reverseStateCache = new Map<string, string | null>();
      // ALWAYS active (fail-closed): a null jobState (unresolvable address)
      // blocks selection and the caller escalates — the guard must NEVER
      // silently disable, even when no TomTom key is configured (a missing
      // key makes every driver's state UNKNOWN, which also blocks).
      const stateGuardCtx: StateGuardContext = {
        jobState: jobState ? jobState.toUpperCase() : null,
        resolveDriverState: deps.stateGuardResolver ?? (async (driverId, lat, lng) => {
          const key = driverStateCacheKey(driverId, lat, lng);
          if (reverseStateCache.has(key)) return reverseStateCache.get(key) ?? null;
          const st = tomtomKeyForGuard ? await reverseGeocodeState(lat, lng, tomtomKeyForGuard, fetchImpl) : null;
          reverseStateCache.set(key, st);
          return st;
        }),
      };
      const guardOutcome: StateGuardOutcome = { active: false, jobState: null, blocked: false, blockedReason: null, checked: 0, inState: 0, excluded: [] };
      const zoneMatches = await loadZoneMatches(orgId, candidates, offer.startLocationLatitude, offer.startLocationLongitude, zoneState.state);
      const regionalPreference = await loadRegionalPreferenceMatches(orgId, candidates, offer.startLocationLatitude, offer.startLocationLongitude, driverQueues);
      const areaCtx: AreaContext = humanReassigned
        ? { gpsFixes: driverGpsFixes, stateGuard: stateGuardCtx, serviceType, serviceQualification, zoneMatches, regionalPreference }
        : { anchors: driverAnchors, gpsFixes: driverGpsFixes, stateGuard: stateGuardCtx, serviceType, serviceQualification, zoneMatches, regionalPreference };
      let chosen = await chooseBestDriverByRoad(
        candidates,
        offer.startLocationLatitude,
        offer.startLocationLongitude,
        resolved.router,
        driverQueues,
        areaCtx,
        { stateGuard: guardOutcome },
      );
      if (guardOutcome.blocked) {
        await acceptFallback(guardOutcome.blockedReason === "job_state_unknown" ? "job state unknown" : "no eligible same-state driver (no eligible driver with a provable state); using universal fallback", { offer, stateGuard: guardOutcome.excluded });
        continue;
      }
      const effectiveMaxEta = Math.min(settings.maxEtaMinutes, offer.maxEta ?? settings.maxEtaMinutes);
      // Cross-state is permitted only as the final tier, only with ACTUAL ROAD
      // TIME (never a factor estimate), and only when that road ETA plus buffer
      // fits the 45-minute SLA ceiling. Offline cross-state drivers are eligible.
      if (guardOutcome.assignmentTier === "cross_state" && chosen && chosen.usedFallback) {
        await acceptFallback("cross-state assignment: actual road time unavailable (routing failed); cannot verify SLA ceiling", { offer, stateGuard: guardOutcome.excluded, chosenBaseMinutes: chosen.baseMinutes, etaBufferMinutes: settings.etaBufferMinutes, ceilingMinutes: effectiveMaxEta });
        continue;
      }
      if (guardOutcome.assignmentTier === "cross_state" && chosen && chosen.baseMinutes + settings.etaBufferMinutes > effectiveMaxEta) {
        await acceptFallback("cross-state sole-eligible assignment cannot make the SLA ceiling", { offer, stateGuard: guardOutcome.excluded, chosenBaseMinutes: chosen.baseMinutes, etaBufferMinutes: settings.etaBufferMinutes, ceilingMinutes: effectiveMaxEta });
        continue;
      }
      const driver = chosen?.driver ?? null;
      // The driver the accept POST carries: the human-chosen driver when a
      // manual reassignment was respected (even offline — their driverId IS the
      // assignment), else the road-aware choice. Zero = no driver.
      let dispatchDriverId = (manualDriverId > 0 && manualEligible) ? manualDriverId : (driver ? Number(driver.driverId) || 0 : 0);
      let dispatchDriverName = humanReassigned
        ? (humanReassigned.driverName ?? String(manualDriverId))
        : driver ? String(driver.driverName ?? "") : null;
      // Final quoted ETA: ceil(road minutes) + buffer, clamped to [floor, ceiling].
      // NO road-ETA candidate → no ETA is computed (the accept body still needs
      // the field — quote the club's SLA ceiling, an honest "not yet assigned"
      // worst case, never a fabricated 1-minute promise).
      let etaMinutes = driver && chosen
        ? finalEtaMinutes(chosen.baseMinutes, settings.etaBufferMinutes, settings.etaFloorMinutes, effectiveMaxEta)
        : null;
      const postEta = etaMinutes ?? effectiveMaxEta;
      const postNotes = dispatchDriverId
        ? (humanReassigned ? "auto-accept by Lightning Dispatch; keeping the human-assigned driver" : "auto-accept by Lightning Dispatch")
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
        // Area + ETA-origin facts (owner-directed 2026-08-13): where the ETA
        // was routed FROM and which area rule applied — the audit never hides
        // a stale-fix anchor-origin or a global fallback.
        originLatitude: chosen.originLat,
        originLongitude: chosen.originLng,
        originBasis: chosen.originBasis,
        gpsFixAgeMinutes: chosen.gpsFixAgeMinutes,
        anchor: chosen.anchor,
        anchorRadiusMiles: chosen.anchorRadiusMiles,
        areaFallback: chosen.areaFallback,
      } : null;
      const allLoadedNote: string | null = null;
      const stateTierReason = guardOutcome.assignmentTier === "offline_in_state"
        ? "no online driver in state; in-state offline assignment"
        : guardOutcome.assignmentTier === "cross_state"
          ? "cross-state sole-eligible assignment (ETA fits ceiling)"
          : null;
      const noDriverReason = driver
        ? null
        : humanReassigned
          ? (manualEligible
              ? `human-chosen driver ${dispatchDriverName} (${manualDriverId}) is not in the live nearestDrivers payload (offline or no GPS) — accepted WITH that driver (their id IS the assignment; ETA quoted at the ${effectiveMaxEta}-min ceiling — no road ETA fabricated)${manualNote ? `; ${manualNote}` : ""}`
              : `human-chosen driver ${dispatchDriverName} (${manualDriverId}) is NOT in the offer's eligible list [${offer.drivers!.join(", ")}] — Towbook would silently drop their id, so the offer is accepted WITHOUT dispatch (never overwrite a human's choice with a different driver); assign manually on Towbook${manualNote ? `; ${manualNote}` : ""}`)
          : eligibleIds
            ? `no ELIGIBLE checked-in driver with real GPS to quote an honest workload ETA (offer eligible list [${offer.drivers!.join(", ")}]${allLoadedNote ?? ""}; accepted WITHOUT dispatch so the motor-club offer cannot expire or be missed; assign manually, ETA quoted at the ${effectiveMaxEta}-min ceiling — no ETA recorded)`
            : `no checked-in driver with real GPS to quote an honest workload ETA${allLoadedNote ?? ""} — accepted WITHOUT dispatch so the motor-club offer cannot expire or be missed; assign manually (ETA quoted at the SLA ceiling — no ETA recorded)`;
      // --- accept (the ONE state-changing call) — with a self-healing retry:
      // an expired session mid-offer (401/403/login-page on the POST) triggers
      // recovery, and the accept is retried once with the recovered session.
      // Only if recovery or the retry fails is the escalation recorded.
      let accept = await postAccept(fetchImpl, baseUrl, cookies, offer.callRequestId, postEta, dispatchDriverId, postNotes);
      let acceptRecoveryNote: string | null = null;
      if (!accept.ok && hasSessionExpiredAttempt(accept.attempts)) {
        const recovery = await recoverSession(orgId);
        if (recovery.recovered) {
          const fresh = await loadOwnerSession(orgId);
          if (fresh) {
            cookies = fresh.cookie;
            baseUrl = fresh.baseUrl;
            const retried = await postAccept(fetchImpl, baseUrl, cookies, offer.callRequestId, postEta, dispatchDriverId, postNotes);
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
      if (dispatchDriverId > 0) {
        // --- post-accept verification loop: NEVER claim "dispatched" without
        // seeing the dispatched driver on the fetched call (assets[].driver.id /
        // assets[].drivers[].driver.id). Not verified → one assign attempt →
        // re-verify → still not assigned → escalated_dispatch_failed. ---
        // Self-healing: when the assignDrivers push (or a verification fetch)
        // hits an expired session (the 2026-08-11 13:10Z incident), recover the
        // session and RETRY the push once with the fresh session — the owner's
        // alert fires only if recovery or the retry fails.
        // Verify the selected driver without mutating the call first.  A call can
        // change between nearestDrivers selection and accept/verification (driver
        // stopped, disappeared from Towbook, or another dispatcher won the race).
        // In that case, immediately rank the remaining live candidates and retry
        // verification for the next-best driver.  Only the normal no-alternative
        // path reaches the existing assign/repair flow, preserving its wiring.
        let verification = await verifyDispatch(fetchImpl, baseUrl, cookies, offer, callIdFromAcceptResponse(accept.raw), dispatchDriverId, {
          retryDelayMs: deps.verifyRetryDelayMs ?? 5000,
          allowAssign: false,
        });
        let recalculationNote: string | null = null;
        if (!verification.ok && verification.found && dispatchDriverId > 0
          && !humanReassigned) {
          const firstChoice = dispatchDriverId;
          // Re-read the authoritative Towbook nearestDrivers payload at the
          // race point: this removes a driver who went offline/disappeared and
          // preserves the offer's explicit eligible-id restriction.
          const latestNd = await towbookFetch(
            fetchImpl,
            `${baseUrl}/api/nearestDrivers?latitude=${offer.startLocationLatitude}&longitude=${offer.startLocationLongitude}&checkInForAllDrivers=true`,
            cookies,
          );
          const livePool = latestNd.ok && Array.isArray(latestNd.body) ? latestNd.body as unknown[] : [];
          const remainingCandidates = (livePool.length ? livePool : candidates).filter((d) => {
            const id = Number((d as Record<string, unknown>).driverId);
            return id !== firstChoice && (!eligibleIds || eligibleIds.has(id));
          });
          const recalcGuard: StateGuardOutcome = { active: false, jobState: null, blocked: false, blockedReason: null, checked: 0, inState: 0, excluded: [] };
          const recalculated = await chooseBestDriverByRoad(
            remainingCandidates,
            offer.startLocationLatitude,
            offer.startLocationLongitude,
            resolved.router,
            driverQueues,
            { anchors: driverAnchors, gpsFixes: driverGpsFixes, stateGuard: stateGuardCtx, serviceType, serviceQualification, zoneMatches, regionalPreference },
            { stateGuard: recalcGuard },
          );
          if (recalculated) {
            chosen = recalculated;
            dispatchDriverId = Number(recalculated.driver.driverId) || 0;
            dispatchDriverName = String(recalculated.driver.driverName ?? dispatchDriverId);
            etaMinutes = finalEtaMinutes(recalculated.baseMinutes, settings.etaBufferMinutes, settings.etaFloorMinutes, effectiveMaxEta);
            recalculationNote = `first choice ${firstChoice} became unavailable (verification saw ${verification.driverOnCall == null ? "no eligible driver" : `driver ${verification.driverOnCall}`}) → recalculated to ${dispatchDriverId}`;
            verification = await verifyDispatch(fetchImpl, baseUrl, cookies, offer, callIdFromAcceptResponse(accept.raw), dispatchDriverId, {
              retryDelayMs: deps.verifyRetryDelayMs ?? 5000,
              allowAssign: true,
            });
          } else {
            // No remaining eligible driver: run the established repair path for
            // the original choice, which will escalate honestly if it is gone.
            verification = await verifyDispatch(fetchImpl, baseUrl, cookies, offer, callIdFromAcceptResponse(accept.raw), firstChoice, {
              retryDelayMs: deps.verifyRetryDelayMs ?? 5000,
              allowAssign: true,
            });
          }
        } else if (!verification.ok) {
          // Existing verification/assign repair path, unchanged for races where
          // no replacement can be selected (including missing call evidence).
          verification = await verifyDispatch(fetchImpl, baseUrl, cookies, offer, callIdFromAcceptResponse(accept.raw), dispatchDriverId, {
            retryDelayMs: deps.verifyRetryDelayMs ?? 5000,
            allowAssign: true,
          });
        }
        let verificationRecoveryNote: string | null = null;
        if (!verification.ok && hasSessionExpiredVerification(verification.attempts)) {
          const recovery = await recoverSession(orgId);
          if (recovery.recovered) {
            const fresh = await loadOwnerSession(orgId);
            if (fresh) {
              const retried = await verifyDispatch(fetchImpl, fresh.baseUrl, fresh.cookie, offer, callIdFromAcceptResponse(accept.raw), dispatchDriverId, {
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
          const etaLabel = etaMinutes != null && chosen
            ? ` — ${etaDetailLabel(chosen, settings.etaBufferMinutes, settings.etaFloorMinutes, effectiveMaxEta, etaMinutes)}`
            : " — no road ETA quoted (driver not in the live nearestDrivers payload; ETA at the SLA ceiling)";
          const areaNote = chosen ? areaSelectionNote(chosen, offer.startLocationLatitude, offer.startLocationLongitude) : null;
          const qualificationNote = serviceQualification.excluded.length
            ? `; service-type '${serviceQualification.serviceType}' excluded ${serviceQualification.excluded.map((e) => `driver ${e.driverId}: ${e.reason}`).join("; ")}`
            : `; service-type ${serviceQualification.assessed ? `'${serviceQualification.serviceType}' assessed; no explicit exclusions` : "could not be assessed (missing/unknown); no driver removed"}`;
          const reason = `accepted and dispatched to ${dispatchDriverName ?? dispatchDriverId} (driver ${dispatchDriverId}, VERIFIED on call ${verification.callId})${verificationRecoveryNote ? `; ${verificationRecoveryNote}` : ""}${recalculationNote ? `; ${recalculationNote}` : ""}${manualNote ? `; ${manualNote}` : ""}${guardOutcome.assignmentTier === "offline_in_state" ? "; no online driver in state; in-state offline assignment" : guardOutcome.assignmentTier === "cross_state" ? "; cross-state sole-eligible assignment (ETA fits ceiling)" : ""}${jobStateResolution.note ? `; ${jobStateResolution.note}` : ""}${qualificationNote}${etaLabel}${areaNote ?? ""}`;
          await record({
            decision: "auto_accept_with_driver",
            callId: verification.callId,
            driverId: String(dispatchDriverId), driverName: dispatchDriverName ?? null,
            etaMinutes, zoneDistanceMiles: zoneDistance, reason,
            rawResponse: { offer, eta: etaFacts, accept: accept.raw, verification, serviceQualification },
          });
          // Assigned-offer push: notify the contractor's phone (single-strike
          // sound) — fire-and-forget, never fails the dispatch.
          await fireDispatchAssignmentPush(orgId, { driverId: dispatchDriverId, driverName: dispatchDriverName }, verification, offer, etaMinutes, deps);
          try {
            const jobRows = await sql() `SELECT id FROM dispatch_jobs WHERE org_id=${orgId} AND (towbook_job_id=${verification.callId} OR towbook_job_id=${offer.callRequestId}) LIMIT 1`;
            if (jobRows.length) {
              const { recordNudge } = await import("./nudge-reassign-core");
              await recordNudge(orgId, String((jobRows[0] as Record<string, unknown>).id), String(dispatchDriverId), "assignment", "auto_accept");
            }
          } catch { /* ledger never blocks dispatch */ }
          result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "auto_accept_with_driver", escalated: false, reason });
        } else {
          const reason = `accepted (call ${verification.callId ?? "unknown"}) but dispatch NOT verified for ${dispatchDriverName ?? dispatchDriverId} (driver ${dispatchDriverId}) — ${verification.error}${verificationRecoveryNote ? `; ${verificationRecoveryNote}` : ""}${recalculationNote ? `; ${recalculationNote}` : ""}${manualNote ? `; ${manualNote}` : ""}${guardOutcome.assignmentTier === "offline_in_state" ? "; no online driver in state; in-state offline assignment" : guardOutcome.assignmentTier === "cross_state" ? "; cross-state sole-eligible assignment (ETA fits ceiling)" : ""}${jobStateResolution.note ? `; ${jobStateResolution.note}` : ""}; needs a human to assign on Towbook (ETA ${etaMinutes ?? effectiveMaxEta} min quoted)`;
          await record({
            decision: "escalated_dispatch_failed",
            callId: verification.callId,
            driverId: String(dispatchDriverId), driverName: dispatchDriverName ?? null,
            etaMinutes, zoneDistanceMiles: zoneDistance, reason,
            rawResponse: { offer, eta: etaFacts, accept: accept.raw, verification, serviceQualification },
          });
          result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "escalated_dispatch_failed", escalated: true, reason });
        }
      } else {
        // No dispatcheable driver (no checked-in free eligible driver with GPS
        // in the normal path; human-chosen driver ineligible/offline in the
        // manual-reassign path): accept WITHOUT dispatch so the motor-club
        // offer cannot expire or be missed — never overwrite a human's choice
        // with a different driver.
        await record({
          decision: "auto_accept_no_driver",
          driverId: null, driverName: null,
          etaMinutes: null, zoneDistanceMiles: zoneDistance, reason: noDriverReason as string,
          rawResponse: { offer, eta: etaFacts, accept: accept.raw, serviceQualification },
        });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "auto_accept_no_driver", escalated: true, reason: noDriverReason as string });
      }
      // Pull the resulting call into dispatch_jobs immediately (reconcile by
      // call.id/callNumber happens inside the sync's upsert).
      try { await deps.syncForOrg(orgId, "sync:auto-accept", actor ?? undefined); } catch { /* engine never throws */ }
    }
    return { result, seenOffers };
  }
