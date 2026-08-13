/**
 * SAME-STATE ASSIGNMENT GUARD (owner rule 2026-08-13: "No cross-state
 * assignments"; production incident — offers carrying CT placeholder coords
 * with Texas addresses were auto-accepted and dispatched to CT drivers, e.g.
 * call 280058368 "317 Cherokee Rose Cir, Georgetown, TX 78626" dispatched to
 * Levi C Martin with the zone check passing at 0.73 mi because the OFFER's
 * coords said Bridgeport). SERVER-ONLY module.
 *
 * The guard answers ONE question per candidate: is the driver CURRENTLY in the
 * SAME US state as the JOB? It reads state from real data:
 *   - job state:    the offer/call ADDRESS text (ZIP prefix table + trailing
 *                   state-token fallback) — never from coordinates, because
 *                   the production offers carried placeholder coords.
 *   - driver state: TomTom REVERSE geocode of the driver's CURRENT location
 *                   (freshest app GPS fix / payload lat,lng / anchor center —
 *                   the same ETA origin the road router uses).
 * FAIL-CLOSED by design: a driver whose state cannot be resolved is NOT
 * eligible; a job whose state cannot be resolved must NOT be auto-assigned
 * (the caller escalates). Never throws.
 */
import { createHash } from "node:crypto";

/** ZIP-3 prefix ranges → US state (the first three digits of a ZIP code
 *  uniquely identify a state; compact range table). Real address evidence:
 *  "78626" → TX, "06880" → CT, "78754" → TX. */
const ZIP3_RANGES: Array<[number, number, string]> = [
  [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"], [200, 205, "DC"],
  [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"],
  [290, 299, "SC"], [300, 319, "GA"], [320, 327, "FL"], [328, 329, "FL"],
  [330, 349, "FL"], [350, 352, "AL"], [354, 369, "AL"], [370, 385, "TN"],
  [386, 397, "MS"], [398, 399, "GA"], [400, 418, "KY"], [420, 427, "KY"],
  [430, 459, "OH"], [460, 479, "IN"], [480, 499, "MI"], [500, 528, "IA"],
  [530, 532, "WI"], [534, 535, "WI"], [537, 539, "WI"], [540, 549, "WI"],
  [550, 567, "MN"], [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"],
  [600, 629, "IL"], [630, 637, "IL"], [640, 658, "MO"], [660, 662, "KS"],
  [664, 679, "KS"], [680, 693, "NE"], [700, 714, "LA"], [716, 729, "AR"],
  [730, 731, "OK"], [733, 735, "TX"], [739, 749, "OK"], [750, 799, "TX"],
  [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"],
  [850, 865, "AZ"], [870, 884, "NM"], [885, 885, "TX"], [889, 891, "NV"],
  [893, 898, "NV"], [900, 961, "CA"], [962, 966, "AA"], [967, 968, "HI"],
  [969, 969, "GU"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];
const stateFromZip3 = (zip3: number): string | null => {
  for (const [lo, hi, st] of ZIP3_RANGES) if (zip3 >= lo && zip3 <= hi) return st;
  return null;
};

/** Parse a 2-letter US state from an address line. Sources, in order:
 *  1. a 5-digit ZIP (or ZIP+4) → ZIP3 range table (the reliable evidence);
 *  2. a trailing 2-letter token ("…, Georgetown, TX") — must not be a common
 *     non-state abbreviation (RD/ST/AVE/USA/NW…).
 * Returns the UPPERCASE state code or null when unresolvable (caller fails
 * closed). Never throws. */
const NON_STATE_TOKENS = new Set(["RD", "ST", "AVE", "BLVD", "DR", "LN", "PKWY", "USA", "US", "NW", "NE", "SW", "SE", "N", "S", "E", "W", "CTR", "CIR", "HWY", "STE", "UNIT", "APT"]);
export function parseStateFromAddress(value: string): string | null {
  if (!value || typeof value !== "string") return null;
  const zip = value.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zip) {
    const st = stateFromZip3(Number(zip[1].slice(0, 3)));
    if (st) return st;
  }
  const tokens = value.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!.toUpperCase();
    if (/^[A-Z]{2}$/.test(t) && !NON_STATE_TOKENS.has(t)) return t;
  }
  return null;
}

/** TomTom full state names → abbreviation (reverse geocode returns the FULL
 *  subdivision name, e.g. "Texas", in address.countrySubdivision and
 *  adminDistrict; the 2-letter code is NOT guaranteed). */
const STATE_NAMES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA",
  COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC",
  FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL",
  INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA",
  MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI",
  MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT",
  NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR",
  PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT",
  VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV",
  WISCONSIN: "WI", WYOMING: "WY",
};
const normalizeState = (raw: string): string | null => {
  const t = (raw ?? "").trim().toUpperCase();
  if (!t) return null;
  if (/^[A-Z]{2}$/.test(t)) return t;
  return STATE_NAMES[t] ?? null;
};

export const TOMTOM_REVERSE_ENDPOINT = "https://api.tomtom.com/search/2/reverseGeocode";
/** Reverse-geocode a lat/lng to a 2-letter US state via TomTom Search v2.
 *  Returns null on ANY failure (no key is the caller's concern; 429/5xx/
 *  network/timeout/non-US/bad shape all yield null) — the guard then treats
 *  the driver's state as UNKNOWN and fails closed. Injectable fetchImpl for
 *  hermetic tests. */
export async function reverseGeocodeState(
  lat: number,
  lng: number,
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0 || !apiKey) return null;
    const params = new URLSearchParams({ key: apiKey, radius: "20000" });
    const url = `${TOMTOM_REVERSE_ENDPOINT}/${lat.toFixed(6)},${lng.toFixed(6)}.json?${params.toString()}`;
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const addresses = (body as Record<string, unknown>).addresses;
    if (!Array.isArray(addresses) || !addresses.length) return null;
    const addr = (addresses[0] as Record<string, unknown> | undefined)?.address as Record<string, unknown> | undefined;
    if (!addr || typeof addr !== "object") return null;
    if (String(addr.countryCode ?? "").toUpperCase() !== "US") return null;
    const candidate = String(addr.adminDistrict ?? addr.countrySubdivision ?? addr.countrySubdivisionName ?? "");
    return normalizeState(candidate);
  } catch {
    return null;
  }
}

/** Deterministic per-run cache key for a driver's position (rounded to ~110 m
 *  so repeated reverse geocodes for the same spot collapse to one call). */
export function driverStateCacheKey(driverId: number, lat: number, lng: number): string {
  return `${driverId}@${lat.toFixed(3)},${lng.toFixed(3)}`;
}

/** sha1 digest helper (test assertions + any caller needing a short stable id). */
export function shortDigest(...parts: Array<string | number>): string {
  return createHash("sha1").update(parts.join("|")).digest("hex");
}
