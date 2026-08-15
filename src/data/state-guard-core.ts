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
const ZIP3_RANGES: Array<[string, string, string]> = [
  ["100", "149", "NY"], ["150", "196", "PA"], ["197", "199", "DE"], ["200", "205", "DC"],
  ["206", "219", "MD"], ["220", "246", "VA"], ["247", "268", "WV"], ["270", "289", "NC"],
  ["290", "299", "SC"], ["300", "319", "GA"], ["320", "327", "FL"], ["328", "329", "FL"],
  ["330", "349", "FL"], ["350", "352", "AL"], ["354", "369", "AL"], ["370", "385", "TN"],
  ["386", "397", "MS"], ["398", "399", "GA"], ["400", "418", "KY"], ["420", "427", "KY"],
  ["430", "459", "OH"], ["460", "479", "IN"], ["480", "499", "MI"], ["500", "528", "IA"],
  ["530", "532", "WI"], ["534", "535", "WI"], ["537", "539", "WI"], ["540", "549", "WI"],
  ["550", "567", "MN"], ["570", "577", "SD"], ["580", "588", "ND"], ["590", "599", "MT"],
  ["060", "069", "CT"], ["600", "629", "IL"], ["630", "637", "IL"], ["640", "658", "MO"], ["660", "662", "KS"],
  ["664", "679", "KS"], ["680", "693", "NE"], ["700", "714", "LA"], ["716", "729", "AR"],
  ["730", "731", "OK"], ["733", "735", "TX"], ["739", "749", "OK"], ["750", "799", "TX"],
  ["800", "816", "CO"], ["820", "831", "WY"], ["832", "838", "ID"], ["840", "847", "UT"],
  ["850", "865", "AZ"], ["870", "884", "NM"], ["885", "885", "TX"], ["889", "891", "NV"],
  ["893", "898", "NV"], ["900", "961", "CA"], ["962", "966", "AA"], ["967", "968", "HI"],
  ["969", "969", "GU"], ["970", "979", "OR"], ["980", "994", "WA"], ["995", "999", "AK"],
];
const stateFromZip3 = (zip3: string): string | null => {
  for (const [lo, hi, st] of ZIP3_RANGES) if (zip3 >= lo && zip3 <= hi) return st;
  return null;
};

/** US state names → postal abbreviations. */
const STATE_NAMES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
};

/** Parse and normalize a US state from address text. Explicit state names/codes
 * win over ZIP inference, so an address cannot silently change state because a
 * ZIP or placeholder coordinate disagrees. Unknown codes are rejected. */
const NON_STATE_TOKENS = new Set(["RD", "ST", "AVE", "BLVD", "DR", "LN", "PKWY", "USA", "US", "NW", "NE", "SW", "SE", "N", "S", "E", "W", "CTR", "CIR", "HWY", "STE", "UNIT", "APT"]);
const US_STATE_CODES = new Set(Object.values(STATE_NAMES));
export function normalizeUsState(raw: unknown): string | null {
  const t = String(raw ?? "").trim().toUpperCase().replace(/[.,]/g, "");
  if (!t) return null;
  return US_STATE_CODES.has(t) ? t : (STATE_NAMES[t] ?? null);
}
export type AddressStateResolution = { state: string | null; source: "address" | "zip" | "unknown"; mismatch: boolean };
/** Known Agero/Bridgeport starting-location placeholder cluster. Towbook has
 * historically put these CT coordinates on otherwise out-of-state offers.
 * This is deliberately narrow: it identifies provenance, it never authorizes a
 * state and callers must resolve the pickup record/address independently. */
export function isAgeroPlaceholderCoords(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat - 41.17) <= 0.12
    && Math.abs(lng - (-73.19)) <= 0.12;
}

export function resolveStateFromAddress(value: string): AddressStateResolution {
  if (!value || typeof value !== "string") return { state: null, source: "unknown", mismatch: false };
  const normalized = value.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const compact = normalized.join(" ").toUpperCase();
  let explicit: string | null = null;
  for (const [stateName, code] of Object.entries(STATE_NAMES)) {
    if (new RegExp(`(^| )${stateName}( |$)`).test(compact)) { explicit = code; break; }
  }
  if (!explicit) {
    // Accept punctuation-separated postal forms such as "C.T." deterministically.
    const rawUpper = value.toUpperCase();
    for (const [code, name] of Object.entries(STATE_NAMES).map(([name, code]) => [code, name] as const)) {
      const letters = code.split("");
      if (new RegExp(`(^|[^A-Z])${letters[0]}[^A-Z]*${letters[1]}([^A-Z]|$)`).test(rawUpper)) { explicit = code; break; }
    }
  }
  if (!explicit) {
    for (let i = normalized.length - 1; i >= 0; i--) {
      const token = normalized[i]!.toUpperCase().replace(/[^A-Z]/g, "");
      const candidate = normalizeUsState(token);
      if (candidate && token.length === 2 && !NON_STATE_TOKENS.has(token)) { explicit = candidate; break; }
    }
  }
  const zip = value.match(/\b(\d{5})(?:-\d{4})?\b/);
  const zipState = zip ? stateFromZip3(zip[1]!.slice(0, 3)) : null;
  if (explicit) return { state: explicit, source: "address", mismatch: Boolean(zipState && zipState !== explicit) };
  if (zipState) return { state: zipState, source: "zip", mismatch: false };
  return { state: null, source: "unknown", mismatch: false };
}
export function parseStateFromAddress(value: string): string | null {
  return resolveStateFromAddress(value).state;
}

/** Normalize reverse-geocoder state output (full name or postal code). */
const normalizeState = (raw: string): string | null => normalizeUsState(raw);

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
