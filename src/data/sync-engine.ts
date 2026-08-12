/**
 * SERVER-ONLY Towbook sync engine (moved out of src/data/server.ts on
 * 2026-08-12 to fix a client-graph leak: exporting syncForOrg from the
 * client-reachable server.ts pulled towbook-key (node:crypto/node:url/
 * node:path/node:fs) into the client bundle — "dirname is not exported by
 * __vite-browser-external").
 *
 * This module is imported ONLY by server-side code (serve.ts → background-sync.ts,
 * serverFn handlers via dynamic import, and tests). It may statically import
 * the client-safe exports of ./server (pure parsers + db-touching helpers),
 * but NOTHING client-reachable may ever import this module.
 */
import { sqlWithTimeout } from "~/db";
import { decryptSession } from "./towbook-key";
import { towbookBrowserHeaders, TOWBOOK_ORIGIN } from "./towbook-login";
import type { AuthUser } from "./auth-server";
import {
  SYNC_TICK_TIMEOUT_MS,
  TOWBOOK_STATUS_ID_TO_LIFECYCLE,
  buildSyncMessage,
  buildTowbookSample,
  callLevelStatusId,
  extractTowbookStatusId,
  normalizeJsonCall,
  normalizeRawJob,
  parseJsonObjects,
  parseTables,
  resolveOrgActor,
  upsertPulledJobs,
  type NormalizedJob,
  type RawJob,
  type TowbookSyncCode,
  type TowbookSyncDiag,
  type TowbookSyncResult,
} from "./server";

const configured = () => Boolean(process.env.DATABASE_URL);

const syncResult = (code: TowbookSyncCode, message: string, extra?: Partial<TowbookSyncResult>): TowbookSyncResult => ({ ok: code === "ok", code, message, added: 0, updated: 0, failed: 0, diagnostics: [], ranAt: new Date().toISOString(), ...extra });

const TOWBOOK_JOB_PATHS = [
  // Service-Platform API (JSON) FIRST — the authoritative, status-complete
  // surface. The ?status=N variants guarantee every bucket is pulled even
  // when a bucket is empty (a 200-empty array is NOT a stop): 0 = Received
  // (where a freshly accepted offer's call lands — the 2026-08-12 dispatch
  // gap), 1 = Dispatched, 2 = En Route; the base list is the complete surface
  // (3/4/5/252/255 included). (2026-08-12: the old list started with the HTML
  // home page, discovery stopped at its 200 dashboard, and the queue imported
  // NOTHING from 14:52 on — the sync only ever saw the home page.)
  "/api/calls?status=0", "/api/calls?status=1", "/api/calls?status=2",
  "/api/calls", "/api/callRequests/",
  "/api/jobs", "/api/orders", "/api/dispatch", "/api/dispatches",
  "/api/jobs/current", "/api/jobs/open", "/api/jobs/active", "/api/jobs/completed",
  "/api/Calls", "/api/Job/Get", "/api/jobs/list",
  // HTML/MVC surfaces (server-rendered grids) — FALLBACK only: walked only
  // when the JSON surface produced no jobs (see discoverJobPages).
  "", "/Dispatch", "/Dispatch/Index", "/Dispatch/Active", "/Dispatch/History",
  "/Dispatch/Completed", "/Dispatch/Board", "/DispatchBoard", "/Board",
  "/Jobs", "/Jobs/Index", "/Job", "/Job/Index",
  "/Calls", "/Calls/Index", "/Calls/Active", "/Calls/History", "/Calls/Open",
  "/Calls/Closed", "/Calls/Completed", "/Calls/Today", "/Calls/All", "/Calls/List",
  "/Call", "/Call/Index", "/Call/Get", "/Calls/GetCalls", "/Calls/Grid",
  "/Orders", "/Order", "/Orders/Index", "/Agero", "/Agero/Index",
  "/MotorClub", "/MotorClubs", "/MotorClub/Index", "/Incoming", "/History",
  "/Completed", "/CompletedJobs", "/Today", "/TodaysJobs", "/Dashboard",
];

const pageHint = (html: string, ct: string | null) => {
  if (ct && ct.includes("json")) return html.replace(/\s+/g, " ").slice(0, 160);
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 160) || `(${html.length} bytes)`;
};

const isLoginPage = (html: string) => /<form/i.test(html) && /RequestVerificationToken/i.test(html);
const isLoginRedirect = (loc: string | null) => Boolean(loc && /login/i.test(loc));

/* ------------------------------ self-discovering fetch ------------------------------ */

/** Whole-discovery hard budget (resilience, owner-directed 2026-08-12): a slow
 *  Towbook period must never let discovery walk all ~45 paths (worst case
 *  45×12s — this wedged the 3s loop on 2026-08-12). With a valid session the
 *  FIRST working primary path already returns the job page, so discovery stops
 *  there and the entire walk is capped at DISCOVERY_TIMEOUT_MS. */
const DISCOVERY_TIMEOUT_MS = 10_000;
const PER_PATH_TIMEOUT_MS = 12_000;
async function discoverJobPages(cookieJar: string, baseUrl: string): Promise<{ diagnostics: TowbookSyncDiag[]; pages: { url: string; body: string; contentType: string | null }[]; sessionExpired: boolean }> {
  const diagnostics: TowbookSyncDiag[] = [];
  const pages: { url: string; body: string; contentType: string | null }[] = [];
  let sessionExpired = false;
  const origin = new URL(baseUrl).origin;
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  let jsonGotJobs = false; // a JSON page yielded ≥1 job (authoritative pull covered the queue)
  for (const path of TOWBOOK_JOB_PATHS) {
    if (sessionExpired) break; // don't hammer a dead session
    const isJsonPath = path.startsWith("/api/");
    // JSON API section: walked EVERY tick — a 200-empty array (e.g. no status-0
    // calls right now) is NOT a stop; every status bucket + the base list must
    // be pulled so the queue always mirrors Towbook. HTML/MVC section: FALLBACK
    // only — walked when the JSON surface produced no jobs, and then stopped at
    // the first page that actually carries jobs (a 200 dashboard with no
    // parseable table is NOT a stop — 2026-08-12: the home page 200 stopped
    // discovery and the queue imported nothing for hours).
    if (!isJsonPath && jsonGotJobs) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 250) {
      diagnostics.push({ url: "<discovery-cap>", status: null, contentType: null, hint: `discovery stopped at the ${Math.round(DISCOVERY_TIMEOUT_MS / 1000)}s budget` });
      break;
    }
    const url = origin + path;
    try {
      const res = await fetch(url, { headers: towbookBrowserHeaders(cookieJar), redirect: "manual", signal: AbortSignal.timeout(Math.min(PER_PATH_TIMEOUT_MS, remainingMs)) });
      const text = await res.text();
      const ct = res.headers.get("content-type");
      diagnostics.push({ url, status: res.status, contentType: ct, hint: pageHint(text, ct) });
      let pushedBody: string | null = null;
      let pushedCt: string | null = null;
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (loc) {
          const target = new URL(loc, origin);
          if (target.origin === origin) {
            const r2 = await fetch(target.toString(), { headers: towbookBrowserHeaders(cookieJar), redirect: "manual", signal: AbortSignal.timeout(Math.min(PER_PATH_TIMEOUT_MS, remainingMs)) });
            const t2 = await r2.text();
            const ct2 = r2.headers.get("content-type");
            diagnostics.push({ url: target.toString(), status: r2.status, contentType: ct2, hint: pageHint(t2, ct2) });
            if (isLoginPage(t2) || isLoginRedirect(r2.headers.get("location"))) { sessionExpired = true; break; }
            if (r2.status === 200) { pages.push({ url: target.toString(), body: t2, contentType: ct2 }); pushedBody = t2; pushedCt = ct2; }
          }
        }
      } else if (res.status === 200) {
        if (isLoginPage(text)) { sessionExpired = true; break; }
        pages.push({ url, body: text, contentType: ct });
        pushedBody = text; pushedCt = ct;
      }
      // Cheap "does this page carry jobs" check — decides whether discovery may
      // stop early. JSON: a non-empty array. HTML: a <table> (parseTables only
      // reads tables; the 200 dashboard has none).
      if (pushedBody != null) {
        const looksJson = isJsonPath || (pushedCt != null && pushedCt.includes("json"));
        if (looksJson) {
          try {
            const arr = JSON.parse(pushedBody);
            if (Array.isArray(arr) && arr.length) jsonGotJobs = true;
          } catch { /* not a JSON array — keep walking */ }
        } else if (!isJsonPath && /<table/i.test(pushedBody)) {
          break; // HTML grid page found — parseTables will read it
        }
      }
    } catch (err) {
      diagnostics.push({ url, status: null, contentType: null, hint: String(err).slice(0, 80) });
    }
  }
  return { diagnostics, pages, sessionExpired };
}

/* ----------------------------------- core sync ----------------------------------- */

/** Full Towbook sync for an org. When the stored session is detected as
 *  expired (login-page redirect on the discovered pages), the sync triggers
 *  the self-healing recovery (recoverTowbookSession — owner-directed
 *  2026-08-11: "set up Towbook and forget") so the NEXT tick starts with a
 *  fresh session: expiry is healed on ticks, not only at push time. Recovery
 *  is throttled + in-flight guarded inside towbook-recovery and never throws —
 *  a failure keeps this org's session_expired result and the caller's
 *  escalation/alert path. PRIVATE: it touches towbook-key (node:url) and
 *  towbook-recovery (node:fs), so it must never be exported from this
 *  client-reachable module — the recovery module is reached by a dynamic
 *  import inside this private function (tree-shaken out of the client bundle,
 *  same pattern as status-push-core). */
async function doSyncForOrg(orgId: string, trigger: string, actorHint?: { id: string; role: AuthUser["role"] }): Promise<TowbookSyncResult> {
  const q = sqlWithTimeout(SYNC_TICK_TIMEOUT_MS);
  const sess = await q`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${orgId} AND session_kind='owner'`;
  if (!sess.length || String(sess[0].status) !== "connected" || !String(sess[0].encrypted_session || "").length) {
    return syncResult("not_connected", "Towbook is not connected for this organization — connect it in Settings first.");
  }
  let cookies: string, baseUrl: string;
  try {
    const plain = await decryptSession(String(sess[0].encrypted_session));
    const parsed = JSON.parse(plain) as { cookies?: string; baseUrl?: string };
    cookies = parsed.cookies || "";
    baseUrl = parsed.baseUrl || TOWBOOK_ORIGIN;
  } catch {
    return syncResult("session_unavailable", "The stored Towbook session cannot be decrypted on this host — reconnect Towbook in Settings.");
  }
  const { diagnostics, pages, sessionExpired } = await discoverJobPages(cookies, baseUrl);
  if (sessionExpired) {
    await q`UPDATE towbook_sessions SET last_sync_at=NOW() WHERE org_id=${orgId} AND session_kind='owner'`;
    // Self-healing (owner-directed 2026-08-11): heal the expired session on the
    // tick itself so the NEXT tick runs with a fresh session — no owner action.
    // Best-effort + throttled inside recovery (never hammers Towbook); a
    // failure leaves this org's session_expired result + alert path intact.
    // The recovery module is server-only (node:fs/node:url) — dynamic import
    // inside this private function, never a static import from this module.
    try {
      const { recoverTowbookSession } = await import("./towbook-recovery");
      await recoverTowbookSession(orgId);
    } catch { /* recovery never throws — keep the sync result clean */ }
    return syncResult("session_expired", "The Towbook session expired or was rejected — reconnect Towbook in Settings.", { diagnostics });
  }
  if (!pages.length) {
    await q`UPDATE towbook_sessions SET last_sync_at=NOW() WHERE org_id=${orgId} AND session_kind='owner'`;
    return syncResult("no_jobs", "Synced, but no job list was found on the discovered pages. The diagnostics below show what each URL returned.", { diagnostics });
  }
  const jsonCalls: Record<string, unknown>[] = [];
  const htmlJobs: RawJob[] = [];
  for (const p of pages) {
    const looksJson = (p.contentType && p.contentType.includes("json")) || /^\s*[\[{]/.test(p.body);
    if (looksJson) jsonCalls.push(...parseJsonObjects(p.body));
    else htmlJobs.push(...parseTables(p.body));
  }
  // Dedupe JSON calls by id: /api/calls and /api/Calls return the SAME array, so
  // first occurrence wins (keeps counts, sample and statusShapes honest).
  const callsById = new Map<string, Record<string, unknown>>();
  for (const call of jsonCalls) {
    const idRaw = call.id ?? call.callNumber;
    if (idRaw == null) continue;
    const rid = String(idRaw).trim();
    if (rid && !callsById.has(rid)) callsById.set(rid, call);
  }
  const calls = [...callsById.values()];
  const normalized: NormalizedJob[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const statusIdCounts = new Map<string, number>();
  for (const call of calls) {
    const rid = String(call.id ?? call.callNumber).trim();
    const sid = extractTowbookStatusId(call.status) ?? callLevelStatusId(call);
    if (sid != null) statusIdCounts.set(String(sid), (statusIdCounts.get(String(sid)) ?? 0) + 1);
    const n = normalizeJsonCall(call, "");
    if (!n.ok) { skipped.push({ id: rid, reason: n.reason }); continue; }
    normalized.push(n.job);
  }
  // HTML tables (fallback surface): only fill ids the JSON path did not cover.
  const byId = new Map<string, RawJob>();
  for (const r of htmlJobs) { const rid = (r.id || "").trim(); if (rid && !byId.has(rid)) byId.set(rid, r); }
  for (const [rid, rec] of byId) {
    if (callsById.has(rid)) continue;
    const n = normalizeRawJob(rec, "");
    if (!n) {
      skipped.push({ id: rid, reason: (rec.status || "").trim() ? `unmapped status "${(rec.status || "").trim()}"` : "no id/status" });
      continue;
    }
    normalized.push(n);
  }
  // Self-documenting capture (persisted to last_result by persistSyncResult so
  // the next mapping pass needs no round-trip): the first 2 raw call objects,
  // every distinct status value seen across all calls, and one full raw call
  // per distinct status id (newest preferred). DB-only — never rendered.
  const capture = calls.length ? buildTowbookSample(calls) : null;
  const actor = actorHint ?? (await resolveOrgActor(orgId));
  if (!actor) {
    await q`UPDATE towbook_sessions SET last_sync_at=NOW() WHERE org_id=${orgId} AND session_kind='owner'`;
    return syncResult("error", "No organization member found to attribute the import to — add an owner to this organization.", { diagnostics });
  }
  const res = await upsertPulledJobs(orgId, actor, normalized, trigger);
  await q`UPDATE towbook_sessions SET last_sync_at=NOW() WHERE org_id=${orgId} AND session_kind='owner'`;
  if (skipped.length) {
    const sample = skipped.slice(0, 5).map((s) => `${s.id} (${s.reason})`).join(", ");
    const unmappedIds = [...statusIdCounts.keys()].filter((s) => !TOWBOOK_STATUS_ID_TO_LIFECYCLE[Number(s)]).sort();
    const seen = [...statusIdCounts.entries()].map(([id, c]) => `${id}×${c}`).join(",");
    diagnostics.push({ url: "<status-map>", status: null, contentType: null, hint: `skipped ${skipped.length} job(s): ${sample}${skipped.length > 5 ? " …" : ""} — status ids seen: ${seen || "none"}; unmapped: ${unmappedIds.join(",") || "none"}` });
  }
  const failed = res.failed + skipped.length;
  const found = normalized.length + skipped.length;
  return {
    ok: true,
    code: "ok",
    message: buildSyncMessage(found, res.added, res.updated, res.unchanged, failed),
    added: res.added,
    updated: res.updated,
    failed,
    diagnostics,
    ranAt: new Date().toISOString(),
    ...(capture ? { sample: capture.sample, statusShapes: capture.statusShapes, sampleByStatus: capture.sampleByStatus } : {}),
  };
}

/** Per-org in-flight guard: concurrent triggers (manual button, pull-on-read,
 *  interval) share one sync per org instead of overlapping. */
const syncInFlight = new Map<string, Promise<TowbookSyncResult>>();

/** Diagnostic-write deadline: persisting a sync result must itself be
 *  time-bounded, or the wedge could hide behind its own diagnostic write. */
const SYNC_DIAG_TIMEOUT_MS = 10_000;

/** Race `p` against a timer that rejects after `ms`; always clears the timer
 *  when either side settles, so timers never linger. The timed-out side becomes
 *  an ordinary error for the caller to persist + rethrow. */
export function withHardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  });
  return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Persist the result of EVERY sync run (self-documenting): counts + code +
 *  message + diagnostics, so a run that finds nothing is explainable from the
 *  DB after the fact. Diagnostics contain only URLs/statuses/hints — never
 *  cookies, passwords, or the session. Capped to keep the JSONB row small.
 *  Best-effort: a persistence failure must never mask the sync result.
 *  Exported for the fixture test (persistence wrapper check). */
export async function persistSyncResult(orgId: string, r: TowbookSyncResult): Promise<void> {
  try {
    const diagnostics = r.diagnostics.slice(0, 80);
    const payload = {
      ranAt: typeof r.ranAt === "string" && r.ranAt ? r.ranAt : new Date().toISOString(),
      code: r.code, message: r.message, added: r.added, updated: r.updated, failed: r.failed, diagnostics,
      ...(Array.isArray(r.sample) && r.sample.length ? { sample: r.sample } : {}),
      ...(r.statusShapes && r.statusShapes.length ? { statusShapes: r.statusShapes } : {}),
      ...(r.sampleByStatus && Object.keys(r.sampleByStatus).length ? { sampleByStatus: r.sampleByStatus } : {}),
    };
    // JSON round-trip before persist: guarantees the JSONB never contains an
    // undefined value (JSON.stringify drops them silently) — the 2026-08-10 bug
    // persisted a coerced "undefined" STRING; this makes that class of bug
    // impossible and keeps every field a real JSON value.
    await sqlWithTimeout(SYNC_DIAG_TIMEOUT_MS)`UPDATE towbook_sessions SET last_result=${JSON.stringify(JSON.parse(JSON.stringify(payload)))}::jsonb WHERE org_id=${orgId} AND session_kind='owner'`;
  } catch { /* never mask the sync result with a diagnostics-write failure */ }
}

export function syncForOrg(orgId: string, trigger: string, actor?: { id: string; role: AuthUser["role"] }): Promise<TowbookSyncResult> {
  const running = syncInFlight.get(orgId);
  if (running) return running;
  const tick = doSyncForOrg(orgId, trigger, actor).then(async (r) => { await persistSyncResult(orgId, r); return r; });
  const tracked = withHardTimeout(tick, SYNC_TICK_TIMEOUT_MS, `towbook sync (${trigger})`)
    .catch(async (err) => {
      // Wedge observability: a timed-out (or otherwise thrown) tick writes a
      // diagnostic to towbook_sessions.last_result so a future hang is visible
      // in the DB, never silent. The write itself is time-bounded and must
      // never block the guard clearing below.
      try {
        const msg = String((err as Error)?.message ?? err).slice(0, 280);
        await persistSyncResult(orgId, {
          ok: false,
          code: msg.includes("timed out after") ? "timeout" : "error",
          message: `${trigger}: ${msg}`,
          added: 0, updated: 0, failed: 0,
          diagnostics: [],
          ranAt: new Date().toISOString(),
        });
      } catch { /* a diagnostic write never blocks the guard clearing */ }
      throw err;
    })
    .finally(() => { syncInFlight.delete(orgId); });
  syncInFlight.set(orgId, tracked);
  return tracked;
}

/** Pull-on-read trigger: fire-and-forget refresh when the org's session is connected
 *  and the last sync is older than ~3s (replication tightened 30s→3s per
 *  owner direction 2026-08-11: "the loops should be 3s"). Matches the
 *  background-interval cadence. Never throws — the read must never fail. */
export async function maybeAutoSync(orgId: string): Promise<void> {
  try {
    if (!configured()) return;
    const rows = await sqlWithTimeout(SYNC_DIAG_TIMEOUT_MS)`SELECT last_sync_at FROM towbook_sessions WHERE org_id=${orgId} AND session_kind='owner' AND status='connected' AND encrypted_session <> ''`;
    if (!rows.length) return;
    const last = rows[0].last_sync_at ? new Date(String(rows[0].last_sync_at)).getTime() : 0;
    if (Date.now() - last > 3_000) void syncForOrg(orgId, "sync:pull-on-read");
  } catch { /* best-effort — never fail the read */ }
}

