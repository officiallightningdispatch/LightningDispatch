/**
 * Contractor management + Towbook driver import (plan milestone 2, backlog
 * "Driver import + Towbook credentials" / "Contractor management") —
 * SERVER-ONLY core.
 *
 * The owner sees every contractor account in Lightning Dispatch (users with
 * role 'contractor' in the org), can add one manually (name + Towbook driver
 * id + optional email), and can bulk-import the REAL contractor list from
 * Towbook using the owner's already-connected session — the same session the
 * AI dispatcher uses (towbook_sessions session_kind='owner', decrypted via
 * towbook-key.ts) and the same GET-only Towbook roster endpoint driver-auth's
 * identifyDriver already calls: GET /api/drivers (roster; `endDate` present =
 * inactive). No writes to Towbook ever.
 *
 * A manually added / imported user is exactly the shape driver-auth's
 * upsertDriverUser expects to find: a users row carrying towbook_driver_id (so
 * the driver's existing Towbook login links to it on first sign-in), a unique
 * login_handle derived from the driver id + name (never the Towbook password —
 * the LD password hash is random and unusable; drivers authenticate through
 * Towbook), and a unique email. Status is DERIVED from existing tables — no
 * new columns: signed in at least once ⇔ a towbook_sessions row with
 * session_kind='driver' keyed to that driver; last activity is the newest of
 * the driver-session refresh and the last GPS ping (driver_locations).
 *
 * Every add/import is recorded in audit_log (entity_type 'contractor', actions
 * 'contractor_added' / 'contractor_imported').
 *
 * Testability (same split as completion-core): every handler is a thin auth
 * wrapper over a `*Core` function that takes an explicit actor + injectable
 * fetchImpl — hermetic tests call the cores directly with mock Towbook fetches
 * and real Neon QA orgs.
 *
 * Imported ONLY by the client-safe facade (src/data/contractor-management.ts,
 * whose createServerFn handlers dynamic-import this module) and by hermetic
 * tests. Every exported function RE-CHECKS the actor role (owner/admin) so the
 * role gate is enforced at the core, not just the handler.
 */
import { z } from "zod";
import { decryptSession } from "./towbook-key";

const configured = () => Boolean(process.env.DATABASE_URL);
let schemaInit: Promise<void> | undefined;
function ensure() {
  if (!configured()) return Promise.resolve();
  schemaInit ??= (async () => {
    const { ensureAuthSchema } = await import("./auth-server");
    await ensureAuthSchema();
    const { ensureSchema } = await import("./migrations");
    await ensureSchema();
  })();
  return schemaInit;
}
const db = () => import("~/db").then((m) => m.sql());

/** The actor context every core takes (mirrors the AuthUser subset we need). */
export type ContractorMgmtActor = { orgId: string; id: string; role: string };
const ALLOWED_ROLES = ["owner", "admin"];
const canManage = (a: ContractorMgmtActor) => ALLOWED_ROLES.includes(a.role);

/* --------------------------------- types --------------------------------- */

export type ContractorStatus = "signed_in" | "not_signed_in";
/** Seroval-safe row: every property defined (null, never undefined).
 *  removedAt set ⇒ the contractor was removed (soft-deactivated): excluded from
 *  dispatch, cannot sign in, historical records kept. */
export type ContractorRow = {
  id: string;
  name: string;
  email: string;
  loginHandle: string | null;
  towbookDriverId: string | null;
  towbookUserId: string | null;
  status: ContractorStatus;
  lastActivityAt: string | null;
  createdAt: string | null;
  removedAt: string | null;
};

export type ImportSkip = { towbookDriverId: string; name: string | null; reason: string };
export type ImportSummary = { imported: number; updated: number; skipped: ImportSkip[] };

/** Outcome of the best-effort Towbook write after a local edit/remove. Every
 *  property defined (Seroval-safe). `pushed` true only when the write was
 *  verified against Towbook; `escalated` true only for genuine failures
 *  (rejected / session expired / verify failed) — "unsupported" (404/405) and
 *  "skipped" (no session / no driver id) are notices, not escalations. */
export type TowbookPushOutcome = {
  pushed: boolean;
  status: "verified" | "skipped" | "unsupported" | "failed";
  notice: string;
  escalated: boolean;
  attempts: string[];
};

export type ContractorManagementResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "unauthorized" | "invalid_input" | "duplicate" | "not_found" | "towbook_not_connected" | "towbook_failed" | "database_error"; message: string };

/* ------------------------------- helpers ------------------------------- */

/** Deterministic login handle: slugged name + Towbook driver id suffix. Unique
 *  per driver (each towbook_driver_id is unique), human-readable, and never
 *  the driver's Towbook password — drivers authenticate through Towbook and
 *  driver-auth links this row by towbook_driver_id on first sign-in. */
export function deriveLoginHandle(name: string, driverId: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 48);
  return `${slug || "driver"}-${driverId}`;
}

const emailLike = (handle: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(handle);
/** Unique email: the provided one when valid, else a derived address keyed by
 *  the login handle (matches driver-auth's @towbook.driver convention). */
function deriveEmail(handle: string, provided?: string): string {
  if (provided && emailLike(provided)) return provided.trim().toLowerCase();
  return `${handle.replace(/[^a-z0-9._-]/g, "") || "driver"}@towbook.driver`;
}

const toIso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/* --------------------------------- list --------------------------------- */

/** All contractor accounts in the org (role 'contractor'), with status derived
 *  from existing tables: signed_in ⇔ a driver-kind Towbook session row for that
 *  driver exists; last activity = newest of that session's refresh and the
 *  last GPS ping. One query; real data only. */
export async function listContractorsCore(actor: ContractorMgmtActor): Promise<ContractorManagementResult<ContractorRow[]>> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Owner access required." };
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT u.id, u.name, u.email, u.login_handle, u.towbook_driver_id, u.towbook_user_id, u.created_at, u.deactivated_at,
        ts.updated_at AS session_updated_at,
        dl.last_ping
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${actor.orgId} AND m.role = 'contractor'
      LEFT JOIN towbook_sessions ts
        ON ts.org_id = ${actor.orgId} AND ts.session_kind = 'driver' AND ts.towbook_driver_id = u.towbook_driver_id
      LEFT JOIN (
        SELECT driver_id, MAX(captured_at) AS last_ping
        FROM driver_locations WHERE org_id = ${actor.orgId}
        GROUP BY driver_id
      ) dl ON dl.driver_id = u.id
      ORDER BY (u.deactivated_at IS NOT NULL), LOWER(u.name), u.created_at`;
    const contractors: ContractorRow[] = (rows as Record<string, unknown>[]).map((r) => {
      const signedIn = r.session_updated_at != null;
      const lastPing = r.last_ping != null ? new Date(String(r.last_ping)) : null;
      const sessionAt = r.session_updated_at != null ? new Date(String(r.session_updated_at)) : null;
      const lastActivity = lastPing && sessionAt ? (lastPing > sessionAt ? lastPing : sessionAt) : (lastPing ?? sessionAt);
      return {
        id: String(r.id),
        name: String(r.name ?? ""),
        email: String(r.email ?? ""),
        loginHandle: r.login_handle != null ? String(r.login_handle) : null,
        towbookDriverId: r.towbook_driver_id != null ? String(r.towbook_driver_id) : null,
        towbookUserId: r.towbook_user_id != null ? String(r.towbook_user_id) : null,
        status: signedIn ? "signed_in" : "not_signed_in",
        lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
        createdAt: toIso(r.created_at),
        removedAt: r.deactivated_at != null ? toIso(r.deactivated_at) : null,
      };
    });
    return { ok: true, data: contractors };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to load contractors." };
  }
}

/* ------------------------------ manual add ------------------------------ */

const ADD_SCHEMA = z.object({
  name: z.string().trim().min(1).max(120),
  towbookDriverId: z.string().trim().min(1).max(24).regex(/^\d+$/, "Towbook driver ID must be numeric."),
  email: z.string().trim().max(200).optional().or(z.literal("")),
});

/** Owner enters name + Towbook driver ID (+ optional email) → creates the LD
 *  users row (role contractor in the org, login_handle derived, random unusable
 *  password hash) so the driver can sign in with their existing Towbook
 *  credentials (driver-auth links this row by towbook_driver_id). Clear errors
 *  on duplicate towbook_driver_id / login_handle / email — never a crash. */
export async function addContractorCore(actor: ContractorMgmtActor, data: unknown): Promise<ContractorManagementResult<ContractorRow>> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Owner access required." };
  const v = ADD_SCHEMA.safeParse(data);
  if (!v.success) {
    const issue = v.error.issues[0];
    return { ok: false, code: "invalid_input", message: issue ? issue.message : "Enter a name and a Towbook driver ID." };
  }
  const name = v.data.name;
  const driverId = v.data.towbookDriverId;
  const handle = deriveLoginHandle(name, driverId);
  const providedEmail = v.data.email && v.data.email.trim() ? v.data.email.trim() : "";
  if (providedEmail && !emailLike(providedEmail)) {
    return { ok: false, code: "invalid_input", message: "That email address doesn't look valid." };
  }
  const email = deriveEmail(handle, providedEmail || undefined);
  try {
    await ensure();
    const q = await db();
    const byDriver = await q`SELECT id FROM users WHERE towbook_driver_id = ${driverId} LIMIT 1`;
    if (byDriver.length) {
      return { ok: false, code: "duplicate", message: `A contractor with Towbook driver ID ${driverId} already exists (${String(byDriver[0].id).slice(0, 8)}…).` };
    }
    const byHandle = await q`SELECT id FROM users WHERE login_handle = ${handle} LIMIT 1`;
    if (byHandle.length) {
      return { ok: false, code: "duplicate", message: `The login handle "${handle}" is already in use — use a different name or driver ID.` };
    }
    const byEmail = await q`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
    if (byEmail.length) {
      return { ok: false, code: "duplicate", message: "That email address is already in use by another account." };
    }
    const { makeId, hash } = await import("./auth-server");
    const userId = makeId();
    const randomPassword = Math.random().toString(36).slice(2) + Date.now().toString(36);
    await q`INSERT INTO users(id, name, email, password_hash, login_handle, towbook_driver_id) VALUES(${userId}, ${name}, ${email}, ${hash(randomPassword)}, ${handle}, ${driverId})`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${actor.orgId}, ${userId}, 'contractor')`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'contractor_added', 'contractor', ${userId},
          ${JSON.stringify({ name, towbookDriverId: driverId, loginHandle: handle, email })}::jsonb, 'contractor-management'`;
    } catch { /* best-effort audit */ }
    const contractor: ContractorRow = {
      id: userId, name, email, loginHandle: handle, towbookDriverId: driverId, towbookUserId: null,
      status: "not_signed_in", lastActivityAt: null, createdAt: new Date().toISOString(), removedAt: null,
    };
    return { ok: true, data: contractor };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to add the contractor." };
  }
}

/* ------------------------------ Towbook import ------------------------------ */

const TOWBOOK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const towbookHeaders = (cookie: string) => ({
  "user-agent": TOWBOOK_UA,
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  ...(cookie ? { cookie } : {}),
});
type FetchResult = { ok: boolean; status: number | null; body: unknown; error: string | null };
/** Same GET pattern the AI dispatcher uses for the owner session (headers,
 *  redirect: manual, 15s timeout, JSON-or-text body parse). GET-only. */
async function towbookGet(fetchImpl: typeof fetch, url: string, cookie: string): Promise<FetchResult> {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: towbookHeaders(cookie),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text) { try { body = JSON.parse(text); } catch { /* keep raw text */ } }
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, body, error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, body: null, error: String(err).slice(0, 200) };
  }
}

/** Load the org's owner Towbook session (the one the AI dispatcher uses) and
 *  return its cookies + baseUrl, or null with a reason when unavailable. */
async function loadOwnerSession(orgId: string): Promise<{ cookies: string; baseUrl: string } | null> {
  const q = await db();
  const sess = await q`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${orgId} AND session_kind='owner'`;
  if (!sess.length || String(sess[0].status) !== "connected" || !String(sess[0].encrypted_session || "").length) return null;
  try {
    const plain = await decryptSession(String(sess[0].encrypted_session));
    const parsed = JSON.parse(plain) as { cookies?: string; baseUrl?: string };
    return { cookies: parsed.cookies || "", baseUrl: parsed.baseUrl || "https://app.towbook.com" };
  } catch {
    return null;
  }
}

/** Normalize one roster row from GET /api/drivers: the driver id (required),
 *  the display name, and inactivity (`endDate` present = inactive, per the
 *  towbook-live-recon evidence). */
function rosterDriver(raw: unknown): { driverId: string; name: string; active: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = o.id != null ? String(o.id).trim() : "";
  if (!id) return null;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : "";
  const inactive = o.endDate != null && String(o.endDate) !== "" && String(o.endDate) !== "null";
  return { driverId: id, name, active: !inactive };
}

/** Upsert one roster driver into the org's contractor list. Returns the row's
 *  disposition: 'imported' | 'updated' | a skip reason. */
type Q = Awaited<ReturnType<typeof db>>;
async function upsertRosterDriver(
  q: Q,
  actor: ContractorMgmtActor,
  driver: { driverId: string; name: string },
  orgContractors: Map<string, { id: string; name: string; handle: string | null }>,
): Promise<"imported" | "updated" | { skip: string }> {
  const { driverId, name } = driver;
  const existing = orgContractors.get(driverId);
  if (existing) {
    if (name && name !== existing.name) {
      await q`UPDATE users SET name=${name} WHERE id=${existing.id}`;
    }
    return "updated";
  }
  const handle = deriveLoginHandle(name, driverId);
  // The login_handle unique index is global — a collision with a DIFFERENT
  // user's row means the handle is taken; skip rather than crash.
  const byHandle = await q`SELECT id FROM users WHERE login_handle = ${handle} LIMIT 1`;
  if (byHandle.length) return { skip: `login_handle_conflict` };
  const email = deriveEmail(handle);
  const byEmail = await q`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
  if (byEmail.length) return { skip: "email_conflict" };
  const { makeId, hash } = await import("./auth-server");
  const userId = makeId();
  const randomPassword = Math.random().toString(36).slice(2) + Date.now().toString(36);
  await q`INSERT INTO users(id, name, email, password_hash, login_handle, towbook_driver_id) VALUES(${userId}, ${name}, ${email}, ${hash(randomPassword)}, ${handle}, ${driverId})`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${actor.orgId}, ${userId}, 'contractor')`;
  return "imported";
}

/** Pull the REAL contractor list from Towbook via the owner's connected session
 *  (GET /api/drivers — the same roster endpoint driver-auth's identifyDriver
 *  uses, with the same session-decrypt path as the AI dispatcher) and upsert:
 *  existing towbook_driver_id rows update their name; new rows insert. Inactive
 *  drivers (endDate present) and malformed rows are skipped with reasons.
 *  GET-only against Towbook — never a write. */
export async function importContractorsCore(actor: ContractorMgmtActor, opts: { fetchImpl?: typeof fetch } = {}): Promise<ContractorManagementResult<ImportSummary>> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Owner access required." };
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  try {
    await ensure();
    const q = await db();
    const session = await loadOwnerSession(actor.orgId);
    if (!session) return { ok: false, code: "towbook_not_connected", message: "Towbook isn't connected — connect it in Settings before importing." };
    const res = await towbookGet(fetchImpl, `${session.baseUrl}/api/drivers`, session.cookies);
    if (!res.ok) return { ok: false, code: "towbook_failed", message: `Towbook rejected the driver list (${res.error ?? "unknown error"}).` };
    if (!Array.isArray(res.body)) return { ok: false, code: "towbook_failed", message: "Towbook returned an unexpected driver list." };

    // Preload the org's current contractors by Towbook driver id (one query).
    const existingRows = await q`SELECT u.id, u.name, u.login_handle, u.towbook_driver_id
      FROM users u JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${actor.orgId} AND m.role = 'contractor'
      WHERE u.towbook_driver_id IS NOT NULL`;
    const orgContractors = new Map<string, { id: string; name: string; handle: string | null }>();
    for (const r of existingRows as Record<string, unknown>[]) {
      orgContractors.set(String(r.towbook_driver_id), { id: String(r.id), name: String(r.name ?? ""), handle: r.login_handle != null ? String(r.login_handle) : null });
    }

    const summary: ImportSummary = { imported: 0, updated: 0, skipped: [] };
    for (const raw of res.body as unknown[]) {
      const driver = rosterDriver(raw);
      if (!driver) { summary.skipped.push({ towbookDriverId: "?", name: null, reason: "missing_driver_id" }); continue; }
      if (!driver.active) { summary.skipped.push({ towbookDriverId: driver.driverId, name: driver.name, reason: "inactive_in_towbook" }); continue; }
      if (!driver.name) { summary.skipped.push({ towbookDriverId: driver.driverId, name: null, reason: "missing_name" }); continue; }
      const disposition = await upsertRosterDriver(q, actor, driver, orgContractors);
      if (disposition === "imported") summary.imported++;
      else if (disposition === "updated") summary.updated++;
      else summary.skipped.push({ towbookDriverId: driver.driverId, name: driver.name, reason: disposition.skip });
    }
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'contractor_imported', 'contractor', ${actor.orgId},
          ${JSON.stringify({ imported: summary.imported, updated: summary.updated, skipped: summary.skipped })}::jsonb, 'contractor-management'`;
    } catch { /* best-effort audit */ }
    return { ok: true, data: summary };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to import contractors." };
  }
}

/* ------------------------------ Towbook writes ------------------------------ */
/* The owner-directed edit/remove surface (recon-verified 2026-08-11 — see
 * /home/team/shared/towbook-driver-writes.md): the driver editor is
 * GET /ajax/settings/drivers/{id} (X-Requested-With) and its form saves via
 * POST /ajax/Settings/Drivers/Details (fields incl. Name/Email; hidden
 * RequestVerificationToken + the session's .AspNetCore.Antiforgery.* cookie);
 * the one-click removal is POST /api/drivers/{id}/disable (deleted drivers
 * vanish from the base GET /api/drivers roster — the import's source — and
 * show deleted:true on GET /api/drivers/full?includeDeleted=true). Every write
 * is GET-first (fresh antiforgery token), one retry, read-back verify, and on
 * genuine failure escalates with evidence (ops "Needs attention") — never
 * silently dropped. "Unsupported" (404/405) and "skipped" (no session / no
 * Towbook id) keep the local change and return a notice, not an escalation. */

type TbRes = { ok: boolean; status: number | null; location: string | null; body: unknown };
async function tbRequest(fetchImpl: typeof fetch, url: string, cookie: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<TbRes> {
  try {
    const res = await fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: {
        "user-agent": TOWBOOK_UA,
        accept: "application/json,text/plain,*/*",
        "accept-language": "en-US,en;q=0.9",
        cookie,
        ...(init?.headers ?? {}),
        ...(init?.method && init.method !== "GET" ? { "content-type": init.headers?.["content-type"] ?? "application/json" } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      ...(init?.body ? { body: init.body } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text) { try { body = JSON.parse(text); } catch { /* keep raw text */ } }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, location: res.headers.get("location"), body };
  } catch (err) {
    return { ok: false, status: null, location: null, body: String(err).slice(0, 200) };
  }
}
/** True when the response means the stored session cookie is dead: 401/403, a
 *  redirect towards the login page, or a 200 that is actually the login page
 *  (its username field is `UserName` — the driver editor uses `Username`, so
 *  the editor partial can never be mistaken for a login page). */
function isExpired(r: TbRes): boolean {
  if (r.status === 401 || r.status === 403) return true;
  if (r.status != null && r.status >= 300 && r.status < 400 && r.location) {
    if (/login|security/i.test(r.location)) return true;
  }
  return r.status === 200 && typeof r.body === "string" &&
    /name="UserName"/i.test(r.body) && /<form/i.test(r.body);
}

/** The driver editor partial — the same request the /Settings/Drivers page's
 *  own XHR makes (verified 200/36 KB with X-Requested-With). Carries the
 *  per-session antiforgery token the write POSTs must include. */
async function fetchEditorPartial(fetchImpl: typeof fetch, baseUrl: string, cookie: string, driverId: string): Promise<{ res: TbRes; token: string | null; values: Map<string, string> }> {
  const res = await tbRequest(fetchImpl, `${baseUrl}/ajax/settings/drivers/${driverId}`, cookie, {
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });
  const html = typeof res.body === "string" ? res.body : "";
  let token: string | null = null;
  const values = new Map<string, string>();
  if (res.ok && html) {
    const hidden = html.match(/<input[^>]*name="RequestVerificationToken"[^>]*value="([^"]*)"/i);
    const fn = html.match(/RequestVerificationToken'\s*:\s*'([^']+)'/);
    token = hidden?.[1] ?? fn?.[1] ?? null;
    // input[type=text|hidden|password|number|date|tel|email|url], checkbox
    // (only when checked — browsers submit checked boxes), select (selected
    // option), textarea.
    for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
      const tag = m[0];
      const name = tag.match(/name="([^"]*)"/i)?.[1];
      if (!name) continue;
      const type = (tag.match(/type="([^"]*)"/i)?.[1] ?? "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "image" || type === "reset") continue;
      if (type === "checkbox") { if (/checked/i.test(tag)) values.set(name, tag.match(/value="([^"]*)"/i)?.[1] ?? "on"); continue; }
      if (type === "radio") { if (/checked/i.test(tag)) values.set(name, tag.match(/value="([^"]*)"/i)?.[1] ?? "on"); continue; }
      values.set(name, tag.match(/value="([^"]*)"/i)?.[1] ?? "");
    }
    for (const m of html.matchAll(/<select\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)) {
      const name = m[1];
      const sel = m[2].match(/<option[^>]*selected[^>]*value="([^"]*)"|<option[^>]*value="([^"]*)"[^>]*selected/i);
      values.set(name, sel?.[1] ?? sel?.[2] ?? "");
    }
    for (const m of html.matchAll(/<textarea\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/gi)) {
      values.set(m[1], m[2].replace(/^\s+|\s+$/g, ""));
    }
  }
  return { res, token, values };
}

function outcome(status: TowbookPushOutcome["status"], notice: string, escalated: boolean, attempts: string[]): TowbookPushOutcome {
  return { pushed: status === "verified", status, notice, escalated, attempts };
}

/** Edit push: fetch the editor partial, override Name (+ Email only when the
 *  LD email is a real email — never the derived @towbook.driver addresses),
 *  POST the full form (field-preserving) with the fresh token, then read back
 *  the name via GET /api/drivers. */
async function pushDriverEdit(fetchImpl: typeof fetch, baseUrl: string, cookie: string, driverId: string, changes: { name: string; email: string | null }): Promise<TowbookPushOutcome> {
  const attempts: string[] = [];
  const editor = await fetchEditorPartial(fetchImpl, baseUrl, cookie, driverId);
  attempts.push(`GET /ajax/settings/drivers/${driverId} → ${editor.res.status ?? "network error"} (${editor.res.ok ? "ok" : "failed"})`);
  if (isExpired(editor.res)) return outcome("failed", "The Towbook session expired — reconnect Towbook in Settings.", true, attempts);
  if (!editor.res.ok) {
    if (editor.res.status === 404 || editor.res.status === 405) {
      return outcome("unsupported", "Towbook does not support editing driver details from Lightning Dispatch (HTTP " + (editor.res.status ?? "?") + ").", false, attempts);
    }
    return outcome("failed", `Towbook rejected the driver editor (HTTP ${editor.res.status ?? "error"}).`, true, attempts);
  }
  const values = editor.values;
  if (!editor.token) return outcome("failed", "Towbook did not return the form token — the edit could not be pushed.", true, attempts);
  values.set("Name", changes.name);
  if (changes.email && values.has("Email")) values.set("Email", changes.email);
  const body = [...values.entries()].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  let post = await tbRequest(fetchImpl, `${baseUrl}/ajax/Settings/Drivers/Details`, cookie, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
  });
  attempts.push(`POST /ajax/Settings/Drivers/Details → ${post.status ?? "network error"} (${post.ok ? "ok" : "failed"})`);
  if (!post.ok && !isExpired(post)) {
    const retry = await tbRequest(fetchImpl, `${baseUrl}/ajax/Settings/Drivers/Details`, cookie, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
    });
    attempts.push(`POST retry → ${retry.status ?? "network error"} (${retry.ok ? "ok" : "failed"})`);
    post = retry;
  }
  if (!post.ok || isExpired(post)) {
    if (isExpired(post)) return outcome("failed", "The Towbook session expired while saving — reconnect Towbook in Settings.", true, attempts);
    if (post.status === 404 || post.status === 405) return outcome("unsupported", "Towbook does not support editing driver details from Lightning Dispatch (HTTP " + (post.status ?? "?") + ").", false, attempts);
    return outcome("failed", `Towbook rejected the driver update (HTTP ${post.status ?? "error"}).`, true, attempts);
  }
  // Read-back verify: the driver's name on the base roster.
  const roster = await tbRequest(fetchImpl, `${baseUrl}/api/drivers`, cookie);
  attempts.push(`GET /api/drivers verify → ${roster.status ?? "network error"}`);
  const found = Array.isArray(roster.body) ? (roster.body as Record<string, unknown>[]).find((d) => d.id != null && String(d.id) === driverId) : null;
  if (roster.ok && found && String(found.name ?? "") === changes.name) {
    return outcome("verified", changes.email && values.has("Email") ? "Name and email synced to Towbook and verified." : "Name synced to Towbook and verified.", false, attempts);
  }
  return outcome("failed", `Towbook did not confirm the new name (${String(found?.name ?? "unknown")}).`, true, attempts);
}

/** Remove push: POST /api/drivers/{id}/disable (the page's "Disable Driver"
 *  action) with the fresh token header, then verify deleted:true on
 *  GET /api/drivers/full?includeDeleted=true. */
async function pushDriverDisable(fetchImpl: typeof fetch, baseUrl: string, cookie: string, driverId: string): Promise<TowbookPushOutcome> {
  const attempts: string[] = [];
  const editor = await fetchEditorPartial(fetchImpl, baseUrl, cookie, driverId);
  attempts.push(`GET /ajax/settings/drivers/${driverId} → ${editor.res.status ?? "network error"} (${editor.res.ok ? "ok" : "failed"})`);
  if (isExpired(editor.res)) return outcome("failed", "The Towbook session expired — reconnect Towbook in Settings.", true, attempts);
  if (!editor.res.ok) {
    if (editor.res.status === 404 || editor.res.status === 405) return outcome("unsupported", "Towbook does not support removing drivers from Lightning Dispatch (HTTP " + (editor.res.status ?? "?") + ").", false, attempts);
    return outcome("failed", `Towbook rejected the driver editor (HTTP ${editor.res.status ?? "error"}).`, true, attempts);
  }
  let post = await tbRequest(fetchImpl, `${baseUrl}/api/drivers/${driverId}/disable`, cookie, {
    method: "POST",
    headers: { ...(editor.token ? { RequestVerificationToken: editor.token } : {}) },
  });
  attempts.push(`POST /api/drivers/${driverId}/disable → ${post.status ?? "network error"} (${post.ok ? "ok" : "failed"})`);
  if (!post.ok && !isExpired(post)) {
    const retry = await tbRequest(fetchImpl, `${baseUrl}/api/drivers/${driverId}/disable`, cookie, {
      method: "POST",
      headers: { ...(editor.token ? { RequestVerificationToken: editor.token } : {}) },
    });
    attempts.push(`POST retry → ${retry.status ?? "network error"} (${retry.ok ? "ok" : "failed"})`);
    post = retry;
  }
  if (!post.ok || isExpired(post)) {
    if (isExpired(post)) return outcome("failed", "The Towbook session expired while removing the driver — reconnect Towbook in Settings.", true, attempts);
    if (post.status === 404 || post.status === 405) return outcome("unsupported", "Towbook does not support removing drivers from Lightning Dispatch (HTTP " + (post.status ?? "?") + ").", false, attempts);
    return outcome("failed", `Towbook rejected the driver removal (HTTP ${post.status ?? "error"}).`, true, attempts);
  }
  // Read-back verify: deleted:true on the full roster (deleted drivers are
  // excluded from the base /api/drivers, so /full?includeDeleted=true is the
  // proof; absent from both is also treated as gone).
  const full = await tbRequest(fetchImpl, `${baseUrl}/api/drivers/full?includeDeleted=true`, cookie);
  attempts.push(`GET /api/drivers/full?includeDeleted=true verify → ${full.status ?? "network error"}`);
  const found = Array.isArray(full.body) ? (full.body as Record<string, unknown>[]).find((d) => d.id != null && String(d.id) === driverId) : null;
  if (full.ok && (found?.deleted === true || found == null)) {
    return outcome("verified", "Removed from Towbook (driver disabled) and verified.", false, attempts);
  }
  return outcome("failed", `Towbook did not confirm the driver removal (deleted=${String(found?.deleted ?? "unknown")}).`, true, attempts);
}

/* ------------------------------ audit + escalation ------------------------------ */

async function recordAudit(actor: ContractorMgmtActor, action: string, entityId: string, detail: Record<string, unknown>): Promise<void> {
  try {
    const q = await db();
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, ${action}, 'contractor', ${entityId}, ${JSON.stringify(detail)}::jsonb, 'contractor-management'`;
  } catch { /* audit is best-effort — never mask the outcome */ }
}

/** Escalation into the decision ledger — the ops "Needs attention" banner
 *  reads ai_dispatcher_decisions with escalated=TRUE. Fixed dedupe key per
 *  (driver, operation) so the same failure never spams. */
async function recordEscalation(orgId: string, driverId: string, op: string, reason: string, evidence: Record<string, unknown>): Promise<void> {
  try {
    const q = await db();
    await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response)
      VALUES(gen_random_uuid()::text, ${orgId}, ${`contractor-push-${op}-${driverId}`}, ${driverId}, 'escalated_contractor_push_failed', TRUE, ${driverId}, NULL, NULL, NULL, ${reason}, ${JSON.stringify(evidence)}::jsonb)
      ON CONFLICT DO NOTHING`;
  } catch { /* never mask the outcome */ }
}

/* ------------------------------ edit contractor ------------------------------ */

const EDIT_SCHEMA = z.object({
  contractorId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(200).optional().or(z.literal("")),
});

export type ContractorEditResult = { contractor: ContractorRow; towbook: TowbookPushOutcome };

/** Owner edits a contractor's name (+ email) from the Contractors tab. Updates
 *  the LD users row (audit 'contractor_updated') AND pushes to Towbook via the
 *  driver editor form when supported (verified read-back; on genuine failure
 *  escalates with evidence). If Towbook rejects / doesn't support the write,
 *  the local update stands and the UI shows a clear inline notice. */
export async function editContractorCore(actor: ContractorMgmtActor, data: unknown, opts: { fetchImpl?: typeof fetch } = {}): Promise<ContractorManagementResult<ContractorEditResult>> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Owner access required." };
  const v = EDIT_SCHEMA.safeParse(data);
  if (!v.success) {
    const issue = v.error.issues[0];
    return { ok: false, code: "invalid_input", message: issue ? issue.message : "Enter a name." };
  }
  const { contractorId, name } = v.data;
  const providedEmail = v.data.email && v.data.email.trim() ? v.data.email.trim() : "";
  if (providedEmail && !emailLike(providedEmail)) {
    return { ok: false, code: "invalid_input", message: "That email address doesn't look valid." };
  }
  const email = providedEmail || "";
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT u.id, u.name, u.email, u.login_handle, u.towbook_driver_id, u.towbook_user_id, u.deactivated_at
      FROM users u JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${actor.orgId} AND m.role = 'contractor'
      WHERE u.id = ${contractorId} LIMIT 1`;
    if (!rows.length) return { ok: false, code: "not_found", message: "That contractor is not on this account." };
    const row = rows[0] as Record<string, unknown>;
    if (row.deactivated_at != null) {
      return { ok: false, code: "invalid_input", message: "This contractor was removed — they can't be edited until re-added." };
    }
    if (email) {
      const byEmail = await q`SELECT id FROM users WHERE email = ${email} AND id != ${contractorId} LIMIT 1`;
      if (byEmail.length) return { ok: false, code: "duplicate", message: "That email address is already in use by another account." };
    }
    // An empty email payload means "no change": users.email is UNIQUE, so
    // writing '' would collide once a second contractor is edited without an
    // email. Keep the stored value (usually the derived placeholder).
    const effectiveEmail = email || String(row.email ?? "");
    if (email) {
      await q`UPDATE users SET name = ${name}, email = ${email} WHERE id = ${contractorId} AND deactivated_at IS NULL`;
    } else {
      await q`UPDATE users SET name = ${name} WHERE id = ${contractorId} AND deactivated_at IS NULL`;
    }
    const before = { name: String(row.name ?? ""), email: String(row.email ?? "") };
    await recordAudit(actor, "contractor_updated", contractorId, { contractorId, from: before, to: { name, email: effectiveEmail } });

    const driverId = row.towbook_driver_id != null ? String(row.towbook_driver_id) : "";
    let towbook: TowbookPushOutcome;
    if (!driverId) {
      towbook = outcome("skipped", "Updated in Lightning Dispatch; this contractor has no Towbook driver id, so Towbook was not updated.", false, []);
    } else {
      const session = await loadOwnerSession(actor.orgId);
      if (!session) {
        towbook = outcome("skipped", "Updated in Lightning Dispatch; Towbook isn't connected, so the change was NOT pushed to Towbook.", false, []);
      } else {
        towbook = await pushDriverEdit(fetchImpl, session.baseUrl, session.cookies, driverId, {
          name,
          // Push the email only when it is a REAL address — never the derived
          // @towbook.driver placeholders (they are not the linked user's mail).
          email: email && emailLike(email) && !email.toLowerCase().endsWith("@towbook.driver") ? email : null,
        });
        if (towbook.escalated) {
          await recordEscalation(actor.orgId, driverId, "edit", towbook.notice, { contractorId, name, email, attempts: towbook.attempts });
        }
        await recordAudit(actor, "contractor_towbook_push", contractorId, { op: "edit", driverId, status: towbook.status, notice: towbook.notice, attempts: towbook.attempts });
      }
    }
    const contractor: ContractorRow = {
      id: contractorId, name, email: effectiveEmail, loginHandle: row.login_handle != null ? String(row.login_handle) : null,
      towbookDriverId: row.towbook_driver_id != null ? String(row.towbook_driver_id) : null,
      towbookUserId: row.towbook_user_id != null ? String(row.towbook_user_id) : null,
      status: "not_signed_in", lastActivityAt: null, createdAt: toIso(row.created_at), removedAt: null,
    };
    return { ok: true, data: { contractor, towbook } };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to edit the contractor." };
  }
}

/* ------------------------------ remove contractor ------------------------------ */

const REMOVE_SCHEMA = z.object({
  contractorId: z.string().trim().min(1).max(128),
  reason: z.string().trim().max(300).optional().or(z.literal("")),
});

export type ContractorRemoveResult = { contractor: ContractorRow; towbook: TowbookPushOutcome; sessionsInvalidated: number };

/** Owner removes a contractor. NEVER a hard delete — users are referenced by
 *  jobs, sessions, pings, photos and audit rows, so the row is soft-deactivated
 *  (deactivated_at) and kept for history. The contractor's LD sessions are
 *  deleted (they can't keep using the portal) and their stored Towbook session
 *  row is removed (no re-checkin, no dispatch). Reflected on Towbook via the
 *  "Disable Driver" action when supported (verified read-back; genuine failures
 *  escalate with evidence — the local removal ALWAYS stands). */
export async function removeContractorCore(actor: ContractorMgmtActor, data: unknown, opts: { fetchImpl?: typeof fetch } = {}): Promise<ContractorManagementResult<ContractorRemoveResult>> {
  if (!canManage(actor)) return { ok: false, code: "unauthorized", message: "Owner access required." };
  const v = REMOVE_SCHEMA.safeParse(data);
  if (!v.success) {
    const issue = v.error.issues[0];
    return { ok: false, code: "invalid_input", message: issue ? issue.message : "Invalid removal request." };
  }
  const { contractorId } = v.data;
  const reason = (v.data.reason ?? "").trim();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT u.id, u.name, u.email, u.login_handle, u.towbook_driver_id, u.towbook_user_id, u.created_at, u.deactivated_at
      FROM users u JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${actor.orgId} AND m.role = 'contractor'
      WHERE u.id = ${contractorId} LIMIT 1`;
    if (!rows.length) return { ok: false, code: "not_found", message: "That contractor is not on this account." };
    const row = rows[0] as Record<string, unknown>;
    if (row.deactivated_at != null) return { ok: false, code: "invalid_input", message: "That contractor is already removed." };

    // (a) Local soft-deactivate — never a hard delete. History (jobs, audit,
    //     GPS, photos, memberships) all reference the users row and stays.
    await q`UPDATE users SET deactivated_at = NOW() WHERE id = ${contractorId} AND deactivated_at IS NULL`;
    // (b) Invalidate EVERYTHING: LD cookie sessions die immediately, and the
    //     stored per-driver Towbook session is removed so loadDriverSession
    //     returns null (no portal GPS pings / job actions) and a fresh
    //     Towbook sign-in cannot re-link.
    const sessions = await q`DELETE FROM sessions WHERE user_id = ${contractorId} RETURNING id`;
    const driverId = row.towbook_driver_id != null ? String(row.towbook_driver_id) : "";
    if (driverId) {
      await q`DELETE FROM towbook_sessions WHERE org_id = ${actor.orgId} AND session_kind = 'driver' AND towbook_driver_id = ${driverId}`;
    }

    // (c) Towbook propagation — best-effort with verified read-back.
    let towbook: TowbookPushOutcome;
    if (!driverId) {
      towbook = outcome("skipped", "Removed in Lightning Dispatch; this contractor has no Towbook driver id, so Towbook was not updated.", false, []);
    } else {
      const session = await loadOwnerSession(actor.orgId);
      if (!session) {
        towbook = outcome("skipped", "Removed in Lightning Dispatch; Towbook isn't connected, so the driver is still active on Towbook.", false, []);
      } else {
        towbook = await pushDriverDisable(fetchImpl, session.baseUrl, session.cookies, driverId);
        if (towbook.escalated) {
          await recordEscalation(actor.orgId, driverId, "remove", towbook.notice, { contractorId, reason, attempts: towbook.attempts });
        }
        await recordAudit(actor, "contractor_towbook_push", contractorId, { op: "remove", driverId, status: towbook.status, notice: towbook.notice, attempts: towbook.attempts });
      }
    }

    await recordAudit(actor, "contractor_removed", contractorId, {
      contractorId, name: String(row.name ?? ""), towbookDriverId: driverId || null, reason: reason || null,
      sessionsInvalidated: sessions.length, towbook: { status: towbook.status, pushed: towbook.pushed, notice: towbook.notice },
    });

    const contractor: ContractorRow = {
      id: contractorId, name: String(row.name ?? ""), email: String(row.email ?? ""),
      loginHandle: row.login_handle != null ? String(row.login_handle) : null,
      towbookDriverId: row.towbook_driver_id != null ? String(row.towbook_driver_id) : null,
      towbookUserId: row.towbook_user_id != null ? String(row.towbook_user_id) : null,
      status: "not_signed_in", lastActivityAt: null, createdAt: toIso(row.created_at),
      removedAt: new Date().toISOString(),
    };
    return { ok: true, data: { contractor, towbook, sessionsInvalidated: sessions.length } };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to remove the contractor." };
  }
}

/* -------------------------------- handlers -------------------------------- */

/** Thin auth wrapper shared by the facade handlers: owner/admin only. Returns
 *  the actor or a ready-made unauthorized result. */
async function resolveActor(): Promise<ContractorMgmtActor | null> {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || !ALLOWED_ROLES.includes(u.role)) return null;
  return { orgId: u.orgId, id: u.id, role: u.role };
}

export async function listContractorsHandler(): Promise<ContractorManagementResult<ContractorRow[]>> {
  if (!configured()) return { ok: false, code: "database_error", message: "Contractor management requires database mode." };
  const actor = await resolveActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Owner access required." };
  return listContractorsCore(actor);
}

export async function addContractorHandler(data: unknown): Promise<ContractorManagementResult<ContractorRow>> {
  if (!configured()) return { ok: false, code: "database_error", message: "Contractor management requires database mode." };
  const actor = await resolveActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Owner access required." };
  return addContractorCore(actor, data);
}

export async function importContractorsHandler(opts: { fetchImpl?: typeof fetch } = {}): Promise<ContractorManagementResult<ImportSummary>> {
  if (!configured()) return { ok: false, code: "database_error", message: "Contractor management requires database mode." };
  const actor = await resolveActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Owner access required." };
  return importContractorsCore(actor, opts);
}

export async function editContractorHandler(data: unknown): Promise<ContractorManagementResult<ContractorEditResult>> {
  if (!configured()) return { ok: false, code: "database_error", message: "Contractor management requires database mode." };
  const actor = await resolveActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Owner access required." };
  return editContractorCore(actor, data);
}

export async function removeContractorHandler(data: unknown): Promise<ContractorManagementResult<ContractorRemoveResult>> {
  if (!configured()) return { ok: false, code: "database_error", message: "Contractor management requires database mode." };
  const actor = await resolveActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Owner access required." };
  return removeContractorCore(actor, data);
}
