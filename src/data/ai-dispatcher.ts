import { createHash } from "node:crypto";
import { sql } from "~/db";
import { decryptSession } from "./towbook-key";

/* ============================ AI dispatcher engine ============================
 * Owner-directed 2026-08-10: auto-accept ALL Towbook motor-club offers inside
 * the approved zone (30-mile radius of zip 06606), dispatch the best available
 * driver with an accurate ETA, log EVERY decision, and escalate uncertainty —
 * never guess.
 *
 * Per-offer sequence (the accept POST is the ONLY state-changing call this
 * module makes):
 *   1. GET /api/callRequests/            → pending offers (status == 0)
 *   2. Zone check (haversine vs 06606 centroid) — out of zone / no coords → escalate
 *   3. Expiration check — expired → escalate (we never use acceptMissedRequest)
 *   4. GET /api/nearestDrivers?latitude=<pickup>&longitude=<pickup>&checkInForAllDrivers=true
 *      → choose best driver: checked in && has GPS && no current calls,
 *        minimizing estimatedTimeSeconds
 *   5. POST /api/callRequests/{id}/accept {id, ETA, driverId|0, ...} — one retry
 *      on failure, then escalate (never silently drop)
 *   6. Record decision + audit, then syncForOrg so the accepted call lands in
 *      dispatch_jobs immediately (reconcile by call.id/callNumber)
 *
 * Hard rails: only act on the documented offer shape (callRequestId, status,
 * startLocationLatitude/Longitude, expirationDateUtc); ANY unexpected shape →
 * escalated_unexpected_shape with the full offer JSON, NO accept. Out-of-zone
 * and unverifiable → never accept. Fetch is injectable (tests never hit real
 * Towbook); the loop wiring passes the real fetch.
 * ----------------------------------------------------------------------------- */

export type AiDispatcherActor = { id: string; role: string };
export type AiDispatcherDeps = {
  /** Runs a full Towbook sync for the org (imported from server.ts by the caller;
   *  injected so this module never imports server.ts — avoids a module cycle). */
  syncForOrg: (orgId: string, trigger: string, actor?: AiDispatcherActor) => Promise<unknown>;
  /** Org's first owner (audit attribution); null when the org has no members. */
  resolveOrgActor: (orgId: string) => Promise<AiDispatcherActor | null>;
  /** Injectable fetch for hermetic tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

export type OrgAiSettings = {
  aiDispatcherEnabled: boolean;
  zoneLat: number;
  zoneLng: number;
  zoneRadiusMiles: number;
  maxEtaMinutes: number;
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
  | "escalated_unexpected_shape";

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

/* ------------------------------- settings + ledger ------------------------------- */

/** Load the org's AI-dispatcher settings, lazily creating the row with the
 *  owner-directed defaults (migration v8): enabled, 06606 centroid, 30 mi, 45 min. */
export async function getOrgSettings(orgId: string): Promise<OrgAiSettings> {
  const q = sql();
  await q`INSERT INTO org_settings(org_id) VALUES(${orgId}) ON CONFLICT(org_id) DO NOTHING`;
  const rows = await q`SELECT ai_dispatcher_enabled, zone_lat, zone_lng, zone_radius_miles, max_eta_minutes FROM org_settings WHERE org_id=${orgId}`;
  const r = rows[0] as Record<string, unknown>;
  return {
    aiDispatcherEnabled: r.ai_dispatcher_enabled !== false,
    zoneLat: Number(r.zone_lat),
    zoneLng: Number(r.zone_lng),
    zoneRadiusMiles: Number(r.zone_radius_miles),
    maxEtaMinutes: Number(r.max_eta_minutes) || 45,
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
  return {
    ok: true,
    offer: {
      callRequestId: String(callRequestId),
      status: status as number,
      startLocationLatitude: lat as number,
      startLocationLongitude: lng as number,
      expirationDateUtc: expirationDateUtc as string,
      maxEta: maxEta != null && maxEta > 0 ? maxEta : null,
    },
  };
}

/* ------------------------------- driver selection ------------------------------- */

type NearestDriver = Record<string, unknown>;

/** Pick the best driver for the offer: checked in, real GPS (lat/lng nonzero),
 *  NO current calls, minimizing estimatedTimeSeconds. Returns null when no
 *  driver qualifies (→ accept with driverId 0 + escalate for manual dispatch). */
export function chooseBestDriver(drivers: unknown[]): NearestDriver | null {
  const eligible = drivers.filter((d): d is NearestDriver => {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    const o = d as NearestDriver;
    return (
      o.isCheckedIn === true &&
      typeof o.latitude === "number" && o.latitude !== 0 &&
      typeof o.longitude === "number" && o.longitude !== 0 &&
      Array.isArray(o.calls) && o.calls.length === 0 &&
      typeof o.estimatedTimeSeconds === "number" && Number.isFinite(o.estimatedTimeSeconds)
    );
  });
  if (!eligible.length) return null;
  eligible.sort((a, b) =>
    Number(a.estimatedTimeSeconds) - Number(b.estimatedTimeSeconds) ||
    String(a.driverId ?? "").localeCompare(String(b.driverId ?? "")));
  return eligible[0];
}

/** Clamp a driver's drive time (seconds) to the club-accepted ETA window:
 *  minutes = ceil(seconds/60), never below 1, never above the effective max
 *  (org default, lowered by the offer's own maxEta when it is smaller). */
export function clampEtaMinutes(estimatedTimeSeconds: number, maxEtaMinutes: number): number {
  if (!Number.isFinite(estimatedTimeSeconds) || estimatedTimeSeconds <= 0) return 1;
  const minutes = Math.ceil(estimatedTimeSeconds / 60);
  return Math.max(1, Math.min(Math.round(maxEtaMinutes) || 1, minutes));
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
 *  `{ id: id, ... }` where id is the numeric offer id). */
async function postAccept(
  fetchImpl: typeof fetch,
  baseUrl: string,
  cookie: string,
  callRequestId: string,
  etaMinutes: number,
  driverId: number,
): Promise<{ ok: boolean; raw: unknown; attempts: FetchResult[] }> {
  const url = `${baseUrl}/api/callRequests/${callRequestId}/accept`;
  const numericId = Number(callRequestId);
  const body = JSON.stringify({
    id: Number.isInteger(numericId) ? numericId : callRequestId,
    comments: "",
    ETA: etaMinutes,
    driverId,
    notes: "auto-accept by Lightning Dispatch",
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
      const driver = chooseBestDriver(nd.body as unknown[]);
      const effectiveMaxEta = Math.min(settings.maxEtaMinutes, offer.maxEta ?? settings.maxEtaMinutes);
      const driverId = driver ? Number(driver.driverId) || 0 : 0;
      const etaMinutes = driver ? clampEtaMinutes(Number(driver.estimatedTimeSeconds), effectiveMaxEta) : 1;

      // --- accept + dispatch (the ONE state-changing call) ---
      const accept = await postAccept(fetchImpl, baseUrl, cookies, offer.callRequestId, etaMinutes, driverId);
      if (!accept.ok) {
        const reason = `accept POST failed after retry (${accept.attempts.map((a) => a.error ?? `HTTP ${a.status}`).join("; ")}) — offer NOT auto-accepted, needs a human`;
        await record({
          decision: "escalated_accept_failed",
          driverId: driver ? String(driver.driverId) : null,
          driverName: driver ? String(driver.driverName ?? "") : null,
          etaMinutes, zoneDistanceMiles: zoneDistance, reason,
          rawResponse: { offer, attempts: accept.attempts.map((a) => ({ status: a.status, body: a.body })) },
        });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "escalated_accept_failed", escalated: true, reason });
        continue;
      }

      if (driver) {
        const reason = `accepted and dispatched to ${String(driver.driverName ?? driver.driverId)} (driver ${driver.driverId}), ETA ${etaMinutes} min`;
        await record({
          decision: "auto_accept_with_driver",
          callId: callIdFromAcceptResponse(accept.raw),
          driverId: String(driver.driverId), driverName: String(driver.driverName ?? ""),
          etaMinutes, zoneDistanceMiles: zoneDistance, reason, rawResponse: accept.raw,
        });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "auto_accept_with_driver", escalated: false, reason });
      } else {
        const reason = "no checked-in free driver with GPS — accepted WITHOUT dispatch so the motor-club offer cannot expire or be missed; assign manually";
        await record({
          decision: "auto_accept_no_driver",
          driverId: null, driverName: null,
          etaMinutes: null, zoneDistanceMiles: zoneDistance, reason, rawResponse: accept.raw,
        });
        result.processed++; result.decisions.push({ callRequestId: offer.callRequestId, decision: "auto_accept_no_driver", escalated: true, reason });
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
