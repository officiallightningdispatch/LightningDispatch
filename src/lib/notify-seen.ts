/**
 * Seen-set persistence (backlog #1): the in-memory ref + localStorage backing
 * for notification dedupe. A module-level Map is the fast path (shared by
 * every mounted notification layer in the tab); localStorage keeps the set
 * across a full reload so old items never re-fire mid-session.
 */
import type { SoundRole } from "./sound";
import { parseSeen } from "./notify";

const cache = new Map<string, string[]>();

export function seenKey(role: SoundRole, kind: "jobs" | "decisions" | "cancelled" | "cashouts"): string {
  return `ld-seen-${role}-${kind}`;
}
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
export function setSeenIds(key: string, ids: string[]): void {
  cache.set(key, ids);
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* best-effort */ }
}
