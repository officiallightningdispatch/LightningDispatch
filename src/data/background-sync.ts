/**
 * SERVER-ONLY 3s background loop: Towbook sync + AI auto-dispatch
 * (owner-directed 2026-08-11 cadence; resilience 2026-08-12).
 *
 * Lives OUTSIDE the client-reachable server.ts so the interval and its
 * server-only dependency chain (ai-dispatcher → node:crypto, syncForOrg →
 * towbook-recovery → node:fs/node:url) can never leak into the client bundle.
 *
 * Start paths (idempotent per process via a global marker — the SOURCE module
 * is imported by serve.ts at boot while the dist bundle carries its own copy,
 * and both share one process, so both must never run two loops):
 *   1. BOOT: serve.ts imports this module and calls startBackgroundSync() after
 *      the server starts — a restart never leaves the dispatcher dead (today's
 *      failure mode was: the loop only started on the first authenticated
 *      request, so process restarts left it dead until someone logged in).
 *   2. FALLBACK: server.ts prepare() dynamic-imports this module on the first
 *      authenticated request (covers hosts where DATABASE_URL was absent at
 *      boot, Vercel-style entries, and tests).
 *
 * Tick (resilience fixes, owner-directed 2026-08-12): auto-dispatch runs
 * FIRST, INDEPENDENTLY of the Towbook job sync — a slow sync must never block
 * offer handling (it used to run after the sync and starved when a slow
 * Towbook period made every tick blow the 30s budget, wedging the loop). Both
 * halves get their own hard timeout + their own per-org in-flight guard, so a
 * hung half can never queue up (the next interval fire starts fresh).
 */
import { sqlWithTimeout } from "~/db";
import { runAutoDispatch } from "./ai-dispatcher";
import { resolveOrgActor, SYNC_TICK_TIMEOUT_MS } from "./server";
import { syncForOrg, withHardTimeout } from "./sync-engine";
import type { AuthUser } from "./auth-server";

/** Process-global dedupe marker: shared across the serve.ts-loaded SOURCE
 *  module instance and the dist bundle's own copy of this module. */
const GLOBAL_STARTED_MARKER = "__ld_background_sync_started__";

let started = false;

/** Start the 3s loop exactly once per process (across module copies).
 *  Best-effort: the interval queries the DB only when DATABASE_URL is set. */
export function startBackgroundSync(): void {
  const g = globalThis as Record<string, unknown>;
  if (started || g[GLOBAL_STARTED_MARKER]) return;
  started = true;
  g[GLOBAL_STARTED_MARKER] = true;

  const timer = globalThis.setInterval(() => {
    void (async () => {
      try {
        if (!process.env.DATABASE_URL) return;
        const rows = await sqlWithTimeout(SYNC_TICK_TIMEOUT_MS)`SELECT org_id FROM towbook_sessions WHERE session_kind='owner' AND status='connected' AND encrypted_session <> '' AND (last_sync_at IS NULL OR last_sync_at < NOW() - INTERVAL '3 seconds')`;
        for (const r of rows) {
          const orgId = String(r.org_id);
          // Fire-and-forget per org: the per-org guards inside dedupe overlap.
          void runTick(orgId);
        }
      } catch { /* best-effort — one query failure never stops the loop */ }
    })();
  }, 3_000);
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}

/** Per-org auto-dispatch in-flight guard (the sync keeps its own guard inside
 *  syncForOrg): a slow dispatch run never overlaps itself across fires. */
const dispatchInFlight = new Map<string, Promise<unknown>>();

/** One org's tick: auto-dispatch FIRST and INDEPENDENT of the Towbook job
 *  sync (resilience fix 2026-08-12 — a slow sync must never block offer
 *  handling). Each half is hard-timeout-wrapped; either timing out can never
 *  wedge the loop (the next interval fire starts a fresh tick). */
async function runTick(orgId: string): Promise<void> {
  try {
    const dispatch = (() => {
      const running = dispatchInFlight.get(orgId);
      if (running) return running;
      // Adapter: AI-dispatcher deps type the actor role loosely (string);
      // syncForOrg expects the narrow AuthUser role union — cast is safe
      // because every actor passed here comes from resolveOrgActor.
      const p = withHardTimeout(
        runAutoDispatch(orgId, {
          syncForOrg: (oid: string, trigger: string, actor?: { id: string; role: string }) =>
            syncForOrg(oid, trigger, actor as { id: string; role: AuthUser["role"] } | undefined),
          resolveOrgActor,
        }),
        SYNC_TICK_TIMEOUT_MS,
        `auto-dispatch ${orgId}`,
      ).finally(() => { dispatchInFlight.delete(orgId); });
      dispatchInFlight.set(orgId, p);
      return p;
    })();
    const sync = syncForOrg(orgId, "sync:interval");
    await Promise.allSettled([dispatch, sync]);
  } catch { /* best-effort — one org's failure never stops the loop */ }
}
