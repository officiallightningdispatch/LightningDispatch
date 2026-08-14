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

export type NotifyCashout = {
  id: string;
  contractorName?: string | null;
  amountCents?: number | null;
  rail?: string | null;
};

/** Pending tip cash-outs whose ids have not yet been surfaced. */
export function diffNewCashoutIds(seen: readonly string[], requests: readonly NotifyCashout[]): NotifyCashout[] {
  if (!Array.isArray(requests) || requests.length === 0) return [];
  const s = new Set(seen ?? []);
  const out: NotifyCashout[] = [];
  const seenInBatch = new Set<string>();
  for (const r of requests) {
    if (!r || typeof r.id !== "string" || r.id === "" || s.has(r.id) || seenInBatch.has(r.id)) continue;
    seenInBatch.add(r.id);
    out.push(r);
  }
  return out;
}

/** Upper bound for a seen-set — drop the oldest ids past this. */
export const SEEN_CAP = 200;

/** Every escalation decision type starts with this prefix (auto_accept_* never
 *  does) — verified against AI_DECISION_META in ai-dispatcher-views.tsx. */
export const ESCALATION_PREFIX = "escalated_";

/** A call in the driver's live queue, with enough context to render a banner
 *  (id + optional statusId + pickup/vehicle fields for the cancelled notice). */
export type NotifyCall = NotifyJob & {
  statusId?: number | null;
  serviceName?: string | null;
  pickupAddress?: string | null;
  zip?: string | null;
  vehicle?: string | null;
  /** DriverCall.arrivalETA — feeds the assignment banner's ETA pill. */
  arrivalETA?: string | null;
};

/** Towbook statuses that mean "the driver was actively working this job":
 *  1 Dispatched (offered) · 2 En Route · 3 On Scene · 4 Towing. A call in one
 *  of these states that is later cancelled (255) — or vanishes from the queue
 *  — is the Uber-style "this job was cancelled" signal. */
const LIVE_STATUS_IDS = new Set([1, 2, 3, 4]);

/** Calls that were LIVE in the previous queue snapshot and are now cancelled
 *  (statusId 255) or GONE from the current snapshot — the cancellation signal
 *  for the driver banner. Returns the PREVIOUS snapshot rows so the caller has
 *  the pickup/vehicle context for the notice. Never fires for calls that were
 *  already cancelled (255) or finished (completed) in the previous snapshot.
 *  Pure + stateless; the caller owns once-per-call dedupe via its seen-set. */
export function diffCancelledJobIds(prev: readonly NotifyCall[], next: readonly NotifyCall[]): NotifyCall[] {
  if (!Array.isArray(prev) || prev.length === 0 || !Array.isArray(next)) return [];
  const nextById = new Map<string, NotifyCall>();
  for (const c of next) {
    if (c && typeof c.id === "string" && c.id !== "" && !nextById.has(c.id)) nextById.set(c.id, c);
  }
  const out: NotifyCall[] = [];
  const seenInBatch = new Set<string>();
  for (const c of prev) {
    if (!c || typeof c.id !== "string" || c.id === "") continue;
    if (seenInBatch.has(c.id)) continue;
    if (!LIVE_STATUS_IDS.has(c.statusId ?? -1)) continue; // only previously live jobs cancel
    const n = nextById.get(c.id);
    if (!n || n.statusId === 255) {
      seenInBatch.add(c.id);
      out.push(c);
    }
  }
  return out;
}

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
