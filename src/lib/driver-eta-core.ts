/**
 * Pure, testable ETA helpers for the driver portal (SUB B defect 4). The driver
 * countdown runs from a DURATION (the AI dispatcher's quoted ETA in minutes)
 * when one exists — not a possibly-stale absolute Towbook `arrivalETA` — and
 * re-anchors its progress bar when the quote changes. No React here so the
 * math is unit-testable without a component render.
 */

/** The subset of a DriverCall the ETA helpers need (ldEtaMinutes optional so
 *  notification/push payloads with only arrivalETA remain assignable). */
export type EtaLike = { arrivalETA: string | null; ldEtaMinutes?: number | null };

/** The quote key that identifies a re-quote: `ld:<minutes>` for a duration
 *  quote, else the Towbook absolute arrivalETA. null when neither exists. */
export function etaQuoteKey(eta: EtaLike | null | undefined): string | null {
  if (!eta) return null;
  if (eta.ldEtaMinutes != null && Number.isFinite(eta.ldEtaMinutes) && eta.ldEtaMinutes >= 0) {
    return `ld:${eta.ldEtaMinutes}`;
  }
  return eta.arrivalETA ?? null;
}

/** Absolute target timestamp (ms) for the ETA. A duration-based LD quote is
 *  anchored from `anchorMs` (now + ldEtaMinutes); an absolute Towbook
 *  arrivalETA is returned unchanged. null when no ETA exists. */
export function etaTargetMs(eta: EtaLike, anchorMs: number): number | null {
  if (eta.ldEtaMinutes != null && Number.isFinite(eta.ldEtaMinutes) && eta.ldEtaMinutes >= 0) {
    return anchorMs + Math.round(eta.ldEtaMinutes * 60000);
  }
  if (eta.arrivalETA) {
    const t = new Date(eta.arrivalETA).getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** Whole seconds remaining until the target (floored, ≥0); null when no target. */
export function etaRemainingSeconds(targetMs: number | null, nowMs: number): number | null {
  if (targetMs == null || !Number.isFinite(targetMs)) return null;
  const t = targetMs - nowMs;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor(t / 1000));
}

/** mm:ss for a whole number of seconds (never negative). */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Pure re-anchor: return a fresh anchor when the quote key changed, else keep
 *  the previous anchor (so a stable quote keeps ticking without resetting). */
export function anchorEta(
  prev: { key: string | null; at: number } | null,
  eta: EtaLike,
  nowMs: number,
): { key: string | null; at: number } {
  const key = etaQuoteKey(eta);
  if (!prev || prev.key !== key) return { key, at: nowMs };
  return prev;
}

/** Preferred ETA clock for queue/sheet labels: the LD duration (now + N min) as
 *  an ISO timestamp, else Towbook's absolute arrivalETA. null when neither. */
export function preferredEtaIso(eta: EtaLike, nowMs = Date.now()): string | null {
  if (eta.ldEtaMinutes != null && Number.isFinite(eta.ldEtaMinutes) && eta.ldEtaMinutes >= 0) {
    return new Date(nowMs + Math.round(eta.ldEtaMinutes * 60000)).toISOString();
  }
  return eta.arrivalETA ?? null;
}
