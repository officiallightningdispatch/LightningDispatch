/**
 * Pure notification-detection logic (backlog #1, owner-directed 2026-08-11).
 *
 * Everything here is side-effect free and browser-agnostic so the unit suite
 * (notify.test.mjs) can exercise it directly with bun. Given the previous
 * seen-set + the incoming items it answers exactly one question: WHICH of these
 * are NEW to the viewer, and what does the seen-set become afterwards?
 *
 * Rules (owner spec):
 *  - A job is "new" when its id is not in the seen-set. On first portal load
 *    the caller SEEDS the seen-set with everything currently visible, so
 *    nothing already on screen ever fires (no sound burst on login). Only
 *    arrivals during the live session fire.
 *  - An AI-dispatcher escalation is "new" when its decision id is not in the
 *    seen-set AND the decision starts with `escalated_` (this covers the
 *    session-expired contractor-push failure and every other escalate path).
 *  - The seen-set is bounded (SEEN_CAP, ~200 ids): mergeSeen drops the OLDEST
 *    ids first (the array is ordered oldest → newest; new ids append).
 *  - Batches are deduped: an id that appears twice in one incoming batch is
 *    reported once.
 */

export type NotifyJob = {
  id: string;
  customerName?: string | null;
  serviceType?: string | null;
  area?: string | null;
};

export type NotifyDecision = {
  id: string;
  decision: string;
  reason?: string | null;
};

/** Upper bound for a seen-set — drop the oldest ids past this. */
export const SEEN_CAP = 200;

/** Every escalation decision type starts with this prefix (auto_accept_* never
 *  does) — verified against AI_DECISION_META in ai-dispatcher-views.tsx. */
export const ESCALATION_PREFIX = "escalated_";

/** True when a decision type is an escalation (e.g. escalated_expired,
 *  escalated_contractor_push_failed). Non-string / empty input → false. */
export function isEscalationDecision(decision: string): boolean {
  return typeof decision === "string" && decision.startsWith(ESCALATION_PREFIX);
}

/** Incoming jobs whose id is not in `seen` — the ones to notify about.
 *  Dedupes within the batch and skips malformed rows (no usable id). */
export function diffNewJobIds(seen: readonly string[], jobs: readonly NotifyJob[]): NotifyJob[] {
  if (!Array.isArray(jobs) || jobs.length === 0) return [];
  const s = new Set(seen ?? []);
  const out: NotifyJob[] = [];
  const seenInBatch = new Set<string>();
  for (const j of jobs) {
    if (!j || typeof j.id !== "string" || j.id === "") continue;
    if (s.has(j.id) || seenInBatch.has(j.id)) continue;
    seenInBatch.add(j.id);
    out.push(j);
  }
  return out;
}

/** Incoming decisions that are escalations AND whose id is not in `seen` —
 *  fire once per decision id, never again on the same id. */
export function diffEscalatedDecisionIds(
  seen: readonly string[],
  decisions: readonly NotifyDecision[],
): NotifyDecision[] {
  if (!Array.isArray(decisions) || decisions.length === 0) return [];
  const s = new Set(seen ?? []);
  const out: NotifyDecision[] = [];
  const seenInBatch = new Set<string>();
  for (const d of decisions) {
    if (!d || typeof d.id !== "string" || d.id === "") continue;
    if (!isEscalationDecision(d.decision)) continue;
    if (s.has(d.id) || seenInBatch.has(d.id)) continue;
    seenInBatch.add(d.id);
    out.push(d);
  }
  return out;
}

/** Append `added` ids (deduped, skipped when empty) and trim to the newest
 *  `cap`, dropping the OLDEST entries. `seen` is ordered oldest → newest. */
export function mergeSeen(
  seen: readonly string[],
  added: readonly string[],
  cap: number = SEEN_CAP,
): string[] {
  const out = [...(seen ?? [])];
  const s = new Set(out);
  for (const id of added ?? []) {
    if (typeof id !== "string" || id === "" || s.has(id)) continue;
    s.add(id);
    out.push(id);
  }
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** Tolerant parse of a persisted seen-set (JSON array of strings). Garbage,
 *  null, or a non-array → empty list (caller seeds on the next poll). */
export function parseSeen(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
