import type { Contractor, Job } from "~/data/seed";

/**
 * Deterministic AI dispatch recommendation engine.
 *
 * Scores every contractor for a given job and returns a ranked list plus a
 * recommended pick. Pure function — no randomness, no I/O — so the same inputs
 * always produce the same output (core PRD principle: transparent and
 * explainable).
 *
 * Scoring model (in order of importance):
 *  1. Online availability  — gate: offline contractors are ineligible unless
 *                            NO contractor is online (then everyone is eligible
 *                            and the nearest available is recommended).
 *  2. Proximity            — weight 0.65, distanceScore = e^(-miles / 6).
 *                            Closest is best; score decays with distance.
 *  3. Rating               — weight 0.20, ratingScore = (rating - 3) / 2.
 *  4. Response time        — weight 0.15, responseScore = 1 - avgMin / 30
 *                            (clamped), where avgMin is the contractor's mean
 *                            of responseTimeHistoryMinutes. Faster is better.
 *
 * Final score = round(100 * (0.65*dist + 0.20*rating + 0.15*response)).
 *
 * Confidence is derived from the gap between the top pick and second place:
 *   gap >= 12  -> high     (top pick is clearly ahead)
 *   gap >= 5   -> medium
 *   gap < 5    -> low      (close race between several contractors)
 *   only one eligible contractor -> high (forced, obvious pick)
 */

export type Confidence = "low" | "medium" | "high";

export interface RankedCandidate {
  contractor: Contractor;
  /** 0-100 overall score */
  score: number;
  /** straight-line distance from contractor to job, miles */
  distanceMiles: number;
  /** mean of responseTimeHistoryMinutes, rounded */
  avgResponseMin: number;
  distanceScore: number;
  ratingScore: number;
  responseScore: number;
}

export interface DispatchRecommendation {
  /** All eligible contractors, ranked best-first */
  candidates: RankedCandidate[];
  /** The recommended pick (top of the ranked list) */
  top: RankedCandidate;
  confidence: Confidence;
  /** Plain-language summary line, e.g. "Marcus Johnson — 0.4 mi away, online, 4.9★, avg response 10 min" */
  explanation: string;
  /** Short "why" phrase shown under the explanation */
  reason: string;
  /** True when no contractor was online and offline ones were used as fallback */
  usedOfflineFallback: boolean;
}

const WEIGHT_DISTANCE = 0.65;
const WEIGHT_RATING = 0.2;
const WEIGHT_RESPONSE = 0.15;

/** Great-circle distance in miles between two lat/lng points (haversine). */
export function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function avgResponseMinutes(contractor: Contractor): number {
  const history = contractor.responseTimeHistoryMinutes;
  if (!history.length) return 0;
  return history.reduce((sum, m) => sum + m, 0) / history.length;
}

export function formatMiles(miles: number): string {
  return miles >= 10 ? `${Math.round(miles)} mi` : `${miles.toFixed(1)} mi`;
}

export function recommendForJob(job: Job, contractors: Contractor[]): DispatchRecommendation {
  const online = contractors.filter((c) => c.status === "online");
  const usedOfflineFallback = online.length === 0;
  const eligible = usedOfflineFallback ? contractors : online;

  const candidates: RankedCandidate[] = eligible
    .map((contractor) => {
      const distanceMiles = haversineMiles(job.location, contractor.location);
      const distanceScore = Math.exp(-distanceMiles / 6);
      const ratingScore = Math.min(Math.max((contractor.rating - 3) / 2, 0), 1);
      const avgResponseMin = avgResponseMinutes(contractor);
      const responseScore = Math.min(Math.max(1 - avgResponseMin / 30, 0), 1);
      const score = Math.round(
        100 *
          (WEIGHT_DISTANCE * distanceScore +
            WEIGHT_RATING * ratingScore +
            WEIGHT_RESPONSE * responseScore),
      );
      return {
        contractor,
        score,
        distanceMiles,
        avgResponseMin: Math.round(avgResponseMin),
        distanceScore,
        ratingScore,
        responseScore,
      };
    })
    .sort((a, b) => {
      // Deterministic: score desc, then distance asc, then rating desc, then name asc.
      if (b.score !== a.score) return b.score - a.score;
      if (a.distanceMiles !== b.distanceMiles) return a.distanceMiles - b.distanceMiles;
      if (b.contractor.rating !== a.contractor.rating) return b.contractor.rating - a.contractor.rating;
      return a.contractor.name.localeCompare(b.contractor.name);
    });

  const top = candidates[0];
  if (!top) {
    // No contractors at all — should not happen with the seeded dataset, but
    // keep the return shape safe.
    return {
      candidates: [],
      top: undefined as unknown as RankedCandidate,
      confidence: "low",
      explanation: "No contractors available.",
      reason: "Add contractors before dispatching.",
      usedOfflineFallback: false,
    };
  }

  const second = candidates[1];
  const gap = second ? top.score - second.score : Infinity;
  const confidence: Confidence =
    candidates.length === 1 ? "high" : gap >= 12 ? "high" : gap >= 5 ? "medium" : "low";

  const statusWord = top.contractor.status;
  const explanation =
    `${top.contractor.name} — ${formatMiles(top.distanceMiles)} away, ${statusWord}, ` +
    `${top.contractor.rating} rating, avg response ${top.avgResponseMin} min`;

  let reason: string;
  if (usedOfflineFallback) {
    reason = "No contractors online — nearest available recommended.";
  } else if (candidates.length === 1) {
    reason = "Only online contractor available.";
  } else if (confidence === "high") {
    reason = "Clearly ahead of the next option on proximity, rating, and speed.";
  } else if (confidence === "medium") {
    reason = "Best balance of proximity, rating, and response time.";
  } else {
    reason = "Close race — several contractors are in range; dispatcher discretion advised.";
  }

  return { candidates, top, confidence, explanation, reason, usedOfflineFallback };
}
