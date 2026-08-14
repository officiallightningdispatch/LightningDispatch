/**
 * Seen-set persistence (backlog #1): the in-memory ref + localStorage backing
 * for notification dedupe. A module-level Map is the fast path (shared by
 * every mounted notification layer in the tab); localStorage keeps the set
 * across a full reload so old items never re-fire mid-session. Bounded by
 * mergeSeen (SEEN_CAP) in notify.ts — this module only reads/writes arrays.
 *
 * Keys are per role + kind so the owner jobs/decisions and driver jobs never
 * collide:
 *   ld-seen-owner-jobs · ld-seen-owner-decisions · ld-seen-driver-jobs
 */
import type { SoundRole } from "./sound";
import { parseSeen } from "./notify";

const cache = new Map<string, string[]>();

export function seenKey(role: SoundRole, kind: "jobs" | "decisions" | "cancelled" | "cashouts"): string {
  return `ld-seen-${role}-${kind}`;
}

/** Current seen ids for a key — seeded from localStorage on first access. */
export function getSeenIds(key: string): string[] {
  let v = cache.get(key);
  if (!v) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { /* storage unavailable */ }
    v = parseSeen(raw);
    cache.set(key, v);
  }
  return v;
}

/** Replace the seen ids for a key (module ref + localStorage). */
export function setSeenIds(key: string, ids: string[]): void {
  cache.set(key, ids);
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* best-effort */ }
}
