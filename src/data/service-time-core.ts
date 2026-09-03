/**
 * Job completion-time goals + live counter core (owner-directed 2026-08-13,
 * completion-goals-spec.md). SERVER-ONLY module — the client-safe facade is
 * ./service-time.ts (createServerFn wrappers dynamic-import this module).
 *
 * OWNER-SPECIFIED DEFAULTS (goal seconds):
 *   jump_start 5 min · tire_change 15 min · fuel_delivery 5 min · lockout 5 min
 *   battery_install STANDARD 1 hr · battery_install ADVANCED 2 hr
 * Stored per-org in `service_time_goals` (org_id, service_type, variant,
 * goal_seconds) with variant '' for the non-battery services and
 * 'standard'|'advanced' for battery installs. Rows are lazily created with
 * these defaults (org_settings pattern); the owner edits them from the owner
 * Settings "Service time goals" card. Past jobs keep their recorded
 * duration_seconds — goals never rewrite history (recompute-stable).
 *
 * Service duration (spec grounding facts): completed_at − arrived_at, falling
 * back to assigned_at when arrived_at is missing; no timestamp → no duration
 * (metrics render "—"). duration_seconds is written ONCE at completion on
 * dispatch_jobs; the metrics query COALESCEs it with the on-the-fly
 * computation so jobs completed before migration 45 still score.
 */
import { sql } from "~/db";
import { z } from "zod";

/* ------------------------------ defaults & normalization ------------------------------ */
/** Canonical service keys → owner-spec'd default goal seconds. */
export const SERVICE_GOAL_DEFAULTS: Readonly<Record<string, number>> = {
  jump_start: 5 * 60,
  tire_change: 15 * 60,
  fuel_delivery: 5 * 60,
  lockout: 5 * 60,
};
export const BATTERY_GOAL_DEFAULTS: Readonly<Record<string, number>> = {
  standard: 60 * 60,
  advanced: 2 * 60 * 60,
};
/** Owner 2026-08-16 (arrival module): an unknown service type still shows a
 *  15-minute goal and is flagged for review — never a blank target. */
export const UNKNOWN_SERVICE_GOAL_SECONDS = 15 * 60;
export const SERVICE_TIME_SERVICE_TYPES = Object.keys(SERVICE_GOAL_DEFAULTS);
export const SERVICE_TIME_LABELS: Readonly<Record<string, string>> = {
  jump_start: "Jump start",
  tire_change: "Tire change",
  fuel_delivery: "Fuel delivery",
  lockout: "Lockout",
  battery_install: "Battery install",
  heavy_tow: "Heavy tow",
};
/** Positive contractor capability keys. These are the only values that can be
 * selected or seeded; raw Towbook names are normalized into this set. */
export const SERVICE_SELECTION_SERVICE_TYPES = [
  "jump_start", "tire_change", "fuel_delivery", "lockout",
  "battery_standard", "battery_advanced", "heavy_tow",
] as const;
export const SERVICE_SELECTION_LABELS: Readonly<Record<string, string>> = {
  jump_start: "Jump start", tire_change: "Tire change", fuel_delivery: "Fuel delivery",
  lockout: "Unlock / lockout", battery_standard: "Battery — standard",
  battery_advanced: "Battery — advanced", heavy_tow: "Heavy tow",
};
export function normalizeServiceSelectionType(serviceType: string | null | undefined): string | null {
  const raw = String(serviceType ?? "").trim().toLowerCase().replace(/[ -]+/g, "_");
  if (!raw) return null;
  if (raw.includes("heavy") || raw.includes("flatbed") || raw.includes("wheel_lift") || raw.includes("wheel_lift") || raw === "tow" || raw.includes("tow")) return "heavy_tow";
  if (raw.includes("battery") && raw.includes("advanced")) return "battery_advanced";
  if (raw.includes("battery") || raw === "battery_install") return "battery_standard";
  if (raw.includes("jump") || raw === "jump_start") return "jump_start";
  if (raw.includes("tire") || raw.includes("tyre") || raw === "tire_change") return "tire_change";
  if (raw.includes("fuel") || raw === "fuel_delivery") return "fuel_delivery";
  if (raw.includes("lock") || raw.includes("unlock") || raw === "lockout") return "lockout";
  return null;
}
/** Map a raw service type (Towbook reason name or LD service_type) to a
 *  canonical goal key. Unknown services → null (no goal; the counter shows the
 *  elapsed time without a target). battery_install is exact (the Phase-1
 *  auto-created install job); the rest match on case-insensitive keywords. */
export function normalizeServiceType(serviceType: string | null | undefined): string | null {
  const raw = String(serviceType ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "battery_install" || raw === "battery installation") return "battery_install";
  if (raw.includes("jump")) return "jump_start";
  if (raw.includes("tire") || raw.includes("tyre")) return "tire_change";
  if (raw.includes("fuel")) return "fuel_delivery";
  if (raw.includes("lock")) return "lockout";
  return null;
}
/** Pure goal lookup: exact raw key → canonical key → battery variant → null.
 *  goals: array of {serviceType, variant, goalSeconds} (the org's rows).
 *  batteryVariant: 'standard'|'advanced'|null (Phase 1 install type). */
export function goalSecondsFor(
  goals: { serviceType: string; variant: string; goalSeconds: number }[],
  rawServiceType: string | null | undefined,
  batteryVariant: string | null,
): { goalSeconds: number | null; serviceKey: string | null } {
  const exact = rawServiceType != null
    ? goals.find((g) => g.serviceType === rawServiceType && g.variant === "")
    : undefined;
  if (exact) return { goalSeconds: exact.goalSeconds, serviceKey: exact.serviceType };
  const key = normalizeServiceType(rawServiceType);
  if (!key) return { goalSeconds: null, serviceKey: null };
  if (key === "battery_install") {
    const v = batteryVariant === "advanced" ? "advanced" : batteryVariant === "standard" ? "standard" : "";
    const row = goals.find((g) => g.serviceType === "battery_install" && (v ? g.variant === v : true));
    if (row) return { goalSeconds: row.goalSeconds, serviceKey: "battery_install" };
    return { goalSeconds: null, serviceKey: "battery_install" };
  }
  const row = goals.find((g) => g.serviceType === key && g.variant === "");
  return row
    ? { goalSeconds: row.goalSeconds, serviceKey: key }
    : { goalSeconds: null, serviceKey: key };
}
/** Service duration in seconds for a completed job (spec grounding): stored
 *  duration_seconds wins (written once at completion, immutable); else compute
 *  completed − arrived (fallback assigned); neither → null. */
export function serviceDurationSeconds(job: {
  durationSeconds: number | null;
  completedAtMs: number | null;
  arrivedAtMs: number | null;
  assignedAtMs: number | null;
}): number | null {
  if (job.durationSeconds != null && Number.isFinite(job.durationSeconds) && job.durationSeconds >= 0) {
    return job.durationSeconds;
  }
  if (job.completedAtMs == null) return null;
  const anchor = job.arrivedAtMs ?? job.assignedAtMs;
  if (anchor == null) return null;
  const d = Math.round((job.completedAtMs - anchor) / 1000);
  return d >= 0 ? d : null;
}

/* ---------------------------------- db reads ---------------------------------- */
const configured = () => Boolean(process.env.DATABASE_URL);
export type ServiceTimeGoalRow = { serviceType: string; variant: string; goalSeconds: number };
const DEFAULTS: { serviceType: string; variant: string; goalSeconds: number }[] = [
  ...SERVICE_TIME_SERVICE_TYPES.map((s) => ({ serviceType: s, variant: "", goalSeconds: SERVICE_GOAL_DEFAULTS[s] })),
  { serviceType: "battery_install", variant: "standard", goalSeconds: BATTERY_GOAL_DEFAULTS.standard },
  { serviceType: "battery_install", variant: "advanced", goalSeconds: BATTERY_GOAL_DEFAULTS.advanced },
];
/** Read the org's service-time goals, lazily seeding the owner-spec'd defaults
 *  (org_settings pattern). Returns the rows in a stable order. */
export async function serviceTimeGoalsCore(orgId: string): Promise<ServiceTimeGoalRow[]> {
  const q = sql();
  for (const d of DEFAULTS) {
    await q`INSERT INTO service_time_goals(org_id, service_type, variant, goal_seconds) VALUES(${orgId}, ${d.serviceType}, ${d.variant}, ${d.goalSeconds}) ON CONFLICT (org_id, service_type, variant) DO NOTHING`;
  }
  const rows = await q`SELECT service_type, variant, goal_seconds FROM service_time_goals WHERE org_id=${orgId} ORDER BY service_type, variant`;
  return (rows as Record<string, unknown>[]).map((r) => ({
    serviceType: String(r.service_type),
    variant: String(r.variant ?? ""),
    goalSeconds: Number(r.goal_seconds),
  }));
}
/** Format a goal for display ("5:00"). */
export function formatGoalSeconds(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return "—";
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/* ----------------------------- live counter enrichment ----------------------------- */
export type CounterCall = {
  id: string;
  statusId: number;
  serviceName: string;
  /** Raw LD service_type for this job (dispatch_jobs.service_type) if known. */
  ldServiceType?: string | null;
  /** Raw Towbook arrivalTime fallback (arrivalTime on the raw call). */
  rawArrivalAtIso?: string | null;
};
export type CounterEnrichment = {
  arrivedAtIso: string | null;
  goalSeconds: number | null;
  serviceKey: string | null;
  /** True when the service type couldn't be resolved — the arrival module
   *  shows the 15-minute default and "flagged for review". */
  reviewFlag: boolean;
};
/** Pure enrichment for the driver queue (spec "counter data source"): attach
 *  the arrival timestamp + service-time goal to every ARRIVED-state call
 *  (statusId 3 = on scene / 4 = towing). Arrival = LD dispatch_jobs.arrived_at
 *  (server timestamp, not local clock drift) with the raw Towbook arrivalTime
 *  as fallback; goal = org goals via goalSecondsFor (battery standard/advanced
 *  from Phase 1's battery_sales.install_type). Not-yet-arrived calls keep
 *  nulls — the counter waits for arrival. An UNKNOWN service type keeps
 *  serviceKey null but still resolves to the 15-minute default and sets
 *  reviewFlag (owner 2026-08-16) so the driver always sees a target. Pure +
 *  deterministic (unit-testable without a DB). */
export function attachServiceTimeData(
  calls: CounterCall[],
  goals: ServiceTimeGoalRow[],
  batteryVariantByJobId: Map<string, string>,
  arrivalByJobId: Map<string, { arrivedAtIso: string | null; serviceType: string | null; durationSeconds?: number | null }>,
): Map<string, CounterEnrichment> {
  const out = new Map<string, CounterEnrichment>();
  for (const c of calls) {
    if (c.statusId !== 3 && c.statusId !== 4) {
      out.set(c.id, { arrivedAtIso: null, goalSeconds: null, serviceKey: null, reviewFlag: false });
      continue;
    }
    const job = arrivalByJobId.get(c.id);
    const arrivedAtIso = job?.arrivedAtIso ?? c.rawArrivalAtIso ?? null;
    const serviceType = job?.serviceType ?? c.ldServiceType ?? c.serviceName;
    const { goalSeconds, serviceKey } = goalSecondsFor(
      goals,
      serviceType,
      batteryVariantByJobId.get(c.id) ?? null,
    );
    // Unknown service type → 15-min default + review flag; keep serviceKey null.
    if (serviceKey == null) {
      out.set(c.id, { arrivedAtIso, goalSeconds: UNKNOWN_SERVICE_GOAL_SECONDS, serviceKey: null, reviewFlag: true });
      continue;
    }
    // Known service key but a missing goal row (battery variant without a row) —
    // fall back to the 15-min default too, flagged for review.
    if (goalSeconds == null) {
      out.set(c.id, { arrivedAtIso, goalSeconds: UNKNOWN_SERVICE_GOAL_SECONDS, serviceKey, reviewFlag: true });
      continue;
    }
    out.set(c.id, { arrivedAtIso, goalSeconds, serviceKey, reviewFlag: false });
  }
  return out;
}

/* ---------------------------------- handlers ---------------------------------- */
export type ServiceTimeGoalsResult =
  | { ok: true; goals: ServiceTimeGoalRow[] }
  | { ok: false; code: "unauthorized" | "invalid_state"; message: string };
export async function getServiceTimeGoalsHandler(): Promise<ServiceTimeGoalsResult> {
  if (!configured()) return { ok: false, code: "invalid_state", message: "Requires database mode." };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in first." };
  try {
    return { ok: true, goals: await serviceTimeGoalsCore(u.orgId) };
  } catch {
    return { ok: false, code: "invalid_state", message: "Couldn't load the service time goals." };
  }
}
/** Owner/admin: edit the goal table. Only the six known rows are writable —
 *  unknown service types are refused (no invented rows). Changes apply to
 *  future jobs; recorded durations are never rewritten. */
export async function updateServiceTimeGoalsHandler(data: unknown): Promise<ServiceTimeGoalsResult> {
  if (!configured()) return { ok: false, code: "invalid_state", message: "Requires database mode." };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in first." };
  if (u.role !== "owner" && u.role !== "admin") {
    return { ok: false, code: "unauthorized", message: "Only the owner can change service time goals." };
  }
  const v = z.object({
    goals: z.array(z.object({
      serviceType: z.enum(["jump_start", "tire_change", "fuel_delivery", "lockout", "battery_install"]),
      variant: z.enum(["", "standard", "advanced"]),
      goalSeconds: z.number().int().min(30).max(4 * 60 * 60),
    })).min(1).max(10),
  }).safeParse(data);
  if (!v.success) {
    return { ok: false, code: "invalid_state", message: "Enter valid goals (30 seconds to 4 hours)." };
  }
  try {
    const q = sql();
    for (const g of v.data.goals) {
      await q`INSERT INTO service_time_goals(org_id, service_type, variant, goal_seconds) VALUES(${u.orgId}, ${g.serviceType}, ${g.variant}, ${g.goalSeconds})
        ON CONFLICT (org_id, service_type, variant) DO UPDATE SET goal_seconds=${g.goalSeconds}, updated_at=NOW()`;
    }
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail)
      VALUES(gen_random_uuid()::text, ${u.orgId}, ${u.id}, ${u.role}, 'update_service_time_goals', 'org_settings', ${u.orgId},
        ${JSON.stringify({ goals: v.data.goals, actorRole: u.role })}::jsonb)`;
    return { ok: true, goals: await serviceTimeGoalsCore(u.orgId) };
  } catch {
    return { ok: false, code: "invalid_state", message: "Couldn't save the goals — try again." };
  }
}
/** The Academy "On-Time Service Standards" lesson id (migration 45 seed). */
export const ON_TIME_STANDARDS_LESSON_ID = "lesson-on-time-service-standards";
export type AssignOnTimeResult = { ok: true; assigned: boolean } | { ok: false; code: "unauthorized" | "invalid_state" | "not_found"; message: string };
/** Owner/admin: manually assign the On-Time Service Standards course to a
 *  contractor (academy_progress row, status in_progress). The lesson then
 *  shows on the driver's Academy list as in progress. Idempotent. */
export async function assignOnTimeStandardsHandler(driverUserId: unknown): Promise<AssignOnTimeResult> {
  if (!configured()) return { ok: false, code: "invalid_state", message: "Requires database mode." };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false, code: "unauthorized", message: "Sign in first." };
  if (u.role !== "owner" && u.role !== "admin") {
    return { ok: false, code: "unauthorized", message: "Only the owner can assign academy training." };
  }
  const did = typeof driverUserId === "string" && driverUserId ? driverUserId : null;
  if (!did) return { ok: false, code: "invalid_state", message: "Pick a contractor first." };
  try {
    const q = sql();
    const member = await q`SELECT 1 FROM organization_memberships WHERE org_id=${u.orgId} AND user_id=${did} AND role='contractor' LIMIT 1`;
    if (!member.length) return { ok: false, code: "not_found", message: "That contractor isn't in this org." };
    const ins = await q`INSERT INTO academy_progress(org_id, user_id, lesson_id, status) VALUES(${u.orgId}, ${did}, ${ON_TIME_STANDARDS_LESSON_ID}, 'in_progress')
      ON CONFLICT (org_id, user_id, lesson_id) DO NOTHING RETURNING lesson_id`;
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail)
      VALUES(gen_random_uuid()::text, ${u.orgId}, ${u.id}, ${u.role}, 'assign_academy_lesson', 'academy_progress', ${did},
        ${JSON.stringify({ lessonId: ON_TIME_STANDARDS_LESSON_ID, actorRole: u.role })}::jsonb)`;
    return { ok: true, assigned: ins.length > 0 };
  } catch {
    return { ok: false, code: "invalid_state", message: "Couldn't assign the course — try again." };
  }
}
