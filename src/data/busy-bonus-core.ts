/**
 * Busy-time bonus — PURE computation core (owner-locked mechanics 2026-08-13).
 *
 * MECHANICS (owner-locked, do not redesign):
 *   - 3+ ASSIGNED calls per contractor within one clock hour = that
 *     contractor's busy hour.
 *   - +$1 per job COMPLETED in that busy hour.
 *   - Renders as an Earnings line item AND a payday manifest line item.
 *
 * WORKING INTERPRETATION (confirmed at build against the live schema —
 * flagged in the 2026-08-13 build report): busy hour = the clock hour in which
 * the 3rd assignment lands; jobs completed within that clock hour each earn
 * +$1. Clock hours are America/New_York wall-clock hours — the business
 * timezone the weekly payday period math already uses (payouts-core ET_TZ), so
 * the driver app and the owner manifest agree on what an "hour" is.
 *
 * DATA SOURCES (real-data reality, verified 2026-08-13 against the live org):
 * dispatch_jobs.assigned_at is set only when a job's synced status passes
 * through 'offered' — real jobs dispatched by the AI dispatcher land in
 * Towbook already-assigned, so only 2/70 live rows carry assigned_at and
 * 19/44 completed rows carry completed_at. The GROUND TRUTH is the raw Towbook
 * call JSON persisted on dispatch_jobs.raw_json:
 *   - raw_json.dispatchTime    — when the call was dispatched to the driver
 *     (70/70 driver-attributed rows) → the moment an assignment landed.
 *   - raw_json.completionTime  — when the call was completed (69/70) → the
 *     moment a job was completed.
 * Those are Z-less ISO timestamps in UTC (verified: dispatchTime precedes the
 * sync import by hours on the same rows, so treating them as UTC is the only
 * consistent reading) — parseRawTimestamp handles them.
 *
 * ASSIGNMENT TIME of a job = COALESCE(assigned_at, raw dispatchTime,
 * created_at) — our own precise record when we dispatched locally, else
 * Towbook's dispatchTime, else the row's creation/import time (deterministic
 * last resort; real rows essentially always carry dispatchTime).
 * COMPLETION TIME of a job = COALESCE(completed_at, raw completionTime) — a
 * job with NO completion timestamp cannot be placed in an hour, so it earns
 * nothing (it also never counts toward payday gross, which requires
 * completed_at — consistent).
 *
 * Recompute-stability: everything derives from dispatch_jobs rows (the system
 * of record) — repeated computes over the same rows produce identical results,
 * matching the payday manifest's derived/recompute-stable posture.
 *
 * Imported ONLY by server-only callers (payouts-core statically; driver-auth
 * dynamic-imports it INSIDE a createServerFn handler body so the client
 * bundle never follows it — tanstack-client-graph-leak rule). Pure — no db.
 */
export const BUSY_BONUS_PER_JOB_CENTS = 100;
export const BUSY_THRESHOLD_ASSIGNMENTS = 3;
const ET_TZ = "America/New_York";

/** The wall-clock hour start (America/New_York) containing `ms`, in epoch ms.
 *  Exact for DST: reads the instant's ET wall clock (Y-M-D H) AND its real
 *  offset (timeZoneName GMT±H — disambiguates the fall-back 01:00 hour, where
 *  a round-trip hour-only check cannot tell 01:00 EDT from 01:00 EST). */
export function hourStartET(ms: number): number {
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const year = Number(get("year")), month = Number(get("month")), day = Number(get("day"));
  let hour = Number(get("hour")); if (hour === 24) hour = 0;
  const tzName = get("timeZoneName"); // e.g. "GMT-4" (EDT) / "GMT-5" (EST)
  const offMatch = /^GMT([+-]\d{1,2})$/.exec(tzName);
  const offHours = offMatch ? Number(offMatch[1]) : -5;
  return Date.UTC(year, month - 1, day, hour - offHours);
}

/** Parse the Z-less ISO timestamps Towbook stores in raw_json (dispatchTime /
 *  completionTime / createDate) as UTC. Accepts "T" or space separators and
 *  optional fractional seconds; null when unparseable. */
export function parseRawTimestamp(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : iso + "Z");
  return Number.isFinite(t) ? t : null;
}

/** DB value → epoch ms (timestamptz comes back as Date objects or ISO). */
function toMs(v: unknown): number | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

export type JobEventRow = {
  assigned_at?: unknown;
  completed_at?: unknown;
  created_at?: unknown;
  raw_json?: unknown;
};

/** The instant a job's assignment landed (busy-hour detection input):
 *  local assigned_at → raw dispatchTime → created_at. Deterministic. */
export function jobAssignmentMs(r: JobEventRow): number | null {
  const a = toMs(r.assigned_at);
  if (a != null) return a;
  if (r.raw_json && typeof r.raw_json === "object") {
    const raw = r.raw_json as Record<string, unknown>;
    const t = parseRawTimestamp(raw.dispatchTime ?? raw.dispatch_time);
    if (t != null) return t;
  }
  return toMs(r.created_at);
}

/** The instant a job was completed (bonus eligibility input): Towbook's
 * authoritative raw completionTime → local completed_at fallback. A job with
 * NO completion timestamp returns null (it cannot be placed in an hour). */
export function jobCompletedMs(r: JobEventRow): number | null {
  if (r.raw_json && typeof r.raw_json === "object") {
    const raw = r.raw_json as Record<string, unknown>;
    const authoritative = parseRawTimestamp(raw.completionTime ?? raw.completion_time);
    if (authoritative != null) return authoritative;
  }
  return toMs(r.completed_at);
}

/** Busy-hour starts (epoch ms of the ET clock-hour start, ascending, unique)
 *  for the given assignment instants — hours with >= BUSY_THRESHOLD_ASSIGNMENTS
 *  assignments. Boundary: exactly 3 = busy, 2 = not, 4 = still ONE busy hour. */
export function busyHourStartsFor(assignmentMs: Array<number | null>): number[] {
  const counts = new Map<number, number>();
  for (const ms of assignmentMs) {
    if (ms == null || !Number.isFinite(ms)) continue;
    const h = hourStartET(ms);
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= BUSY_THRESHOLD_ASSIGNMENTS)
    .map(([h]) => h)
    .sort((a, b) => a - b);
}

export type BusyBonusHour = { startsAtMs: number; completedJobs: number };
export type BusyBonusResult = { hours: BusyBonusHour[]; bonusJobs: number; bonusCents: number };

/** +$1 per completion inside each busy hour. A completion belongs to the busy
 *  hour whose start is its OWN clock-hour start (i.e. completions in
 *  [hourStart, hourStart+1h) — a 17:00:00.000 completion belongs to the 17:00
 *  hour, never the 16:00 one). */
export function computeBusyBonus(assignments: Array<number | null>, completions: Array<number | null>): BusyBonusResult {
  const hours: BusyBonusHour[] = busyHourStartsFor(assignments).map((h) => ({ startsAtMs: h, completedJobs: 0 }));
  const byHour = new Map(hours.map((h) => [h.startsAtMs, h] as const));
  for (const ms of completions) {
    if (ms == null || !Number.isFinite(ms)) continue;
    const hour = byHour.get(hourStartET(ms));
    if (hour) hour.completedJobs += 1;
  }
  const bonusJobs = hours.reduce((s, h) => s + h.completedJobs, 0);
  return { hours, bonusJobs, bonusCents: bonusJobs * BUSY_BONUS_PER_JOB_CENTS };
}
