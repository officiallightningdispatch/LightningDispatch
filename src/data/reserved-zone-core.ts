import { zoneContainingPoint } from "../lib/zone-containment";

export type ReservedZoneRecord = {
  id: string;
  is_reserved: boolean;
  unlock_jobs_required: unknown;
  [key: string]: unknown;
};

export type ReservedZoneDecision = { ok: true } | { ok: false; code: "reserved_zone_locked"; message: string };

/** Single fail-closed policy used by both Go Online and job acceptance. */
export function checkReservedZoneEligibility(input: {
  zone: ReservedZoneRecord | null | undefined;
  completedJobs: number | null | undefined;
  actorRole?: string;
  explicitOwnerOverride?: boolean;
}): ReservedZoneDecision {
  const zone = input.zone;
  // A missing containing zone means this job is outside the configured zone
  // system. Reserved-zone policy must not turn unzoned/non-reserved work into a
  // rejection; Go Online still requires an explicitly selected zone upstream.
  if (!zone) return { ok: true };
  if (!zone.is_reserved) return { ok: true };
  // Only an explicit, existing owner/admin override may bypass the gate.
  if (input.explicitOwnerOverride === true && (input.actorRole === "owner" || input.actorRole === "admin")) return { ok: true };
  const rawThreshold = zone.unlock_jobs_required;
  const threshold = Number(rawThreshold);
  const completed = Number(input.completedJobs);
  if (rawThreshold == null || (typeof rawThreshold === "string" && rawThreshold.trim() === "") || !Number.isInteger(threshold) || threshold < 0 || !Number.isFinite(completed) || completed < 0) {
    return { ok: false, code: "reserved_zone_locked", message: "This reserved zone is unavailable until its unlock requirement is verified." };
  }
  if (completed < threshold) return { ok: false, code: "reserved_zone_locked", message: `Complete ${threshold} roadside jobs to unlock this reserved zone.` };
  return { ok: true };
}

/** DB-backed gate. Completion count is always derived from real dispatch_jobs rows. */
export async function enforceReservedZoneEligibility(
  q: any,
  args: { orgId: string; userId: string; towbookDriverId?: string | null; zone: ReservedZoneRecord | null | undefined; actorRole?: string; explicitOwnerOverride?: boolean },
): Promise<ReservedZoneDecision> {
  if (!args.zone) return checkReservedZoneEligibility({ zone: null, completedJobs: null });
  if (!args.zone.is_reserved || (args.explicitOwnerOverride === true && (args.actorRole === "owner" || args.actorRole === "admin"))) {
    return checkReservedZoneEligibility({ zone: args.zone, completedJobs: 0, actorRole: args.actorRole, explicitOwnerOverride: args.explicitOwnerOverride });
  }
  if (!args.towbookDriverId) return checkReservedZoneEligibility({ zone: args.zone, completedJobs: null });
  const rows = await q`SELECT COUNT(*)::int AS completed FROM dispatch_jobs
    WHERE org_id=${args.orgId} AND status='completed'
      AND (assigned_driver_towbook_id=${args.towbookDriverId} OR assigned_contractor_id=${args.userId})`;
  return checkReservedZoneEligibility({ zone: args.zone, completedJobs: Number(rows[0]?.completed), actorRole: args.actorRole, explicitOwnerOverride: args.explicitOwnerOverride });
}

/** Select the authoritative polygon zone, with the existing ZIP/radius fallback. */
export function containingZone(zones: ReservedZoneRecord[], lat: number, lng: number, zip?: string) {
  return zoneContainingPoint(zones as any, lat, lng, zip) as ReservedZoneRecord | null;
}
