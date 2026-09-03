/**
 * Pure extraction of a job's owner-facing vehicle string and Towbook call
 * number from the dispatch_jobs row. Kept dependency-free and client-safe so
 * both the server-side mapJob (src/data/server.ts) and hermetic tests share one
 * truth without touching the DB or the server-only import graph.
 *
 * Vehicle precedence (owner-directed):
 *   1. raw_json.assets[0].year + make + model (single space, empty skipped).
 *   2. vehicle_desc free-text fallback (only when assets[0] has no usable
 *      year/make/model).
 *   Undefined when neither yields a non-whitespace string.
 *
 * raw_json may arrive already-parsed (jsonb driver) OR as a JSON string — parse
 * defensively and never throw on malformed JSON.
 */

export interface JobIdentityExtras {
  vehicle?: string;
  callNumber?: string;
}

function parseRawJson(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Join assets[0].year/make/model with single spaces, skipping empties. */
function assetVehicle(asset: unknown): string | undefined {
  if (!asset || typeof asset !== "object") return undefined;
  const a = asset as Record<string, unknown>;
  const parts = [a.year, a.make, a.model]
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter((s) => s !== "");
  return parts.length ? parts.join(" ") : undefined;
}

/** Trim to undefined so callers never render "· ·" for whitespace-only rows. */
function clean(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function jobIdentityExtras(rawJson: unknown, vehicleDesc: unknown): JobIdentityExtras {
  const raw = parseRawJson(rawJson);

  let vehicle = assetVehicle(Array.isArray(raw?.assets) ? raw.assets[0] : undefined);
  if (!vehicle) vehicle = clean(vehicleDesc == null ? undefined : String(vehicleDesc));
  vehicle = clean(vehicle);

  let callNumber: string | undefined;
  if (raw?.callNumber != null && String(raw.callNumber) !== "") {
    callNumber = String(raw.callNumber);
  }

  const out: JobIdentityExtras = {};
  if (vehicle) out.vehicle = vehicle;
  if (callNumber) out.callNumber = callNumber;
  return out;
}
