import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { sql } from "~/db";
export type Role = "owner" | "admin" | "dispatcher" | "contractor";
/** The resolved driver identity behind a session (owner↔contractor view toggle,
 *  2026-08-12). userRowId is the LD users row that OWNS the driver identity:
 *  a contractor's own row, a shape-(a) staff row that itself carries
 *  towbook_driver_id, or the linked contractor's row (shape b). deactivated is
 *  true only for shape-b links whose linked driver was later removed — the
 *  toggle/banner must not render and driver entry must be blocked. */
export type DriverIdentityInfo = {
  userRowId: string;
  towbookDriverId: string;
  driverName: string;
  deactivated: boolean;
};
export type AuthUser = { id: string; name: string; email: string; role: Role; orgId: string; contractorId?: string; towbookDriverId?: string; linkedDriverUserId?: string; driverIdentity: DriverIdentityInfo | null };
/** Legacy role normalization (owner batch 2026-08-12): very old memberships may
 *  carry role 'manager' (pre-dating the current role enum). All managers get
 *  owner access per owner direction — normalize at every read so a legacy row
 *  behaves as 'owner' even before the one-time migration UPDATE lands. */
export const normalizeRole = (r: unknown): Role => (r === "manager" ? "owner" : (r as Role));
// v2 session cookie. Old `lightning_session` cookies accumulated in browsers
// across earlier builds (same name, different path/domain attributes) can shadow
// a fresh session: browsers send same-name cookies oldest-first, and h3's cookie
// parser keeps the FIRST duplicate, so a dead cookie that precedes the live one
// makes every auth check resolve to signed-out — the owner's flash-then-bounce.
// The rename makes every accumulated cookie inert (we never read the old name);
// startSession also actively deletes the old name so the browser self-heals.
export const cookieName = "ld_session_v2";
export const legacyCookieNames = ["lightning_session"];
const cookieOpts = (maxAge: number) => ({
  path: "/", httpOnly: true, sameSite: "lax" as const, maxAge,
  ...(process.env.NODE_ENV === "production" ? { secure: true } : {}),
});
const writeCookie = async (name: string, value: string, maxAge: number) => {
  const { setCookie } = await import("@tanstack/start-server-core");
  setCookie(name, value, cookieOpts(maxAge));
};
const configured = () => Boolean(process.env.DATABASE_URL);
const hash = (password: string, salt = randomBytes(16).toString("hex")) => `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const verify = (password: string, stored: string) => { const [salt, hex] = stored.split(":"); if (!salt || !hex) return false; try { return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hex, "hex")); } catch { return false; } };
export async function ensureAuthSchema() {
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await q`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  // Soft-deactivate flag (migration 14 also adds it; adding here keeps
  // currentUser's deactivated_at filter safe even when ensureSchema has not run).
  await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`;
  // Owner↔contractor view toggle (migration 24): the linked-driver column.
  // Added here so currentUser's driverIdentity resolution stays safe even when
  // ensureAuthSchema runs before the migrations table (idempotent).
  await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_driver_user_id TEXT`;
  await q`CREATE TABLE IF NOT EXISTS organization_memberships (org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('owner','admin','dispatcher','contractor')), contractor_id TEXT, PRIMARY KEY(org_id,user_id))`;
  await q`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  // One-time idempotent migration (owner batch 2026-08-12): legacy 'manager'
  // memberships become 'owner' — every manager gets owner access. Safe to run
  // repeatedly (idempotent); no-op when no 'manager' rows exist.
  await q`UPDATE organization_memberships SET role='owner' WHERE role='manager'`;
}

const id = () => randomBytes(18).toString("hex");

/** Every value for a cookie name in the raw Cookie header, in send order.
 *  h3's getCookie() collapses duplicates to the FIRST match — which is exactly
 *  the failure mode we are closing — so parse the header ourselves and try each
 *  value; a stale cookie can no longer shadow a valid one. */
export async function cookieValues(name: string): Promise<string[]> {
  const { getRequestHeader } = await import("@tanstack/start-server-core");
  const header = getRequestHeader("cookie") || "";
  const out: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}
export async function cookieValue(): Promise<string | undefined> {
  const values = await cookieValues(cookieName);
  return values[0];
}

/** The unified effective-driver resolver (owner↔contractor view toggle,
 *  2026-08-12 — the heart of the feature). Every driver-facing server fn
 *  resolves the driver identity through THIS instead of role-guarding, so an
 *  owner/admin with a driver identity can drive the full contractor flow:
 *   - contractor            → their own row (today's behavior)
 *   - staff w/ own towbook_driver_id (shape a) → their own row (e.g. Ai
 *     Dispatch GB, owner-role on the dispatch roster)
 *   - staff w/ linked_driver_user_id (shape b) → the linked contractor's row
 *     (deactivated: true when that driver was later removed — callers must
 *     refuse)
 *   - everyone else → null
 *  Returns explicit nulls only (seroval-safe). */
export async function effectiveDriverIdentity(u: AuthUser): Promise<DriverIdentityInfo | null> {
  const own = u.towbookDriverId;
  if (u.role === "contractor" || own) {
    if (!own) return null; // contractor row without a driver id — no identity yet
    return { userRowId: u.id, towbookDriverId: own, driverName: u.name, deactivated: false };
  }
  if (u.linkedDriverUserId) {
    const rows = await sql()`SELECT name, towbook_driver_id, deactivated_at FROM users WHERE id=${u.linkedDriverUserId} LIMIT 1`;
    if (!rows.length) return null;
    const r = rows[0] as Record<string, unknown>;
    if (r.towbook_driver_id == null) return null;
    return {
      userRowId: u.linkedDriverUserId,
      towbookDriverId: String(r.towbook_driver_id),
      driverName: String(r.name ?? "Driver"),
      deactivated: r.deactivated_at != null,
    };
  }
  return null;
}

export async function currentUser(): Promise<AuthUser | null> {
  if (!configured()) return null;
  await ensureAuthSchema();
  const tokens = await cookieValues(cookieName);
  if (!tokens.length) return null;
  const q = sql();
  for (const token of tokens) {
    const rows = await q`SELECT u.id,u.name,u.email,u.towbook_driver_id,u.linked_driver_user_id,m.org_id,m.role,m.contractor_id FROM sessions s JOIN users u ON u.id=s.user_id JOIN organization_memberships m ON m.user_id=u.id WHERE s.id=${token} AND s.expires_at > NOW() AND u.deactivated_at IS NULL`;
    if (!rows.length) continue;
    const r = rows[0] as Record<string, unknown>;
    // Seroval rejects object properties whose value is undefined. Owner/admin
    // memberships have no contractor_id, so only include this optional field
    // when the database actually returned one.
    const user: AuthUser = { id: String(r.id), name: String(r.name), email: String(r.email), role: normalizeRole(r.role), orgId: String(r.org_id), driverIdentity: null };
    if (r.contractor_id != null && r.contractor_id !== "") user.contractorId = String(r.contractor_id);
    if (r.towbook_driver_id != null && r.towbook_driver_id !== "") user.towbookDriverId = String(r.towbook_driver_id);
    if (r.linked_driver_user_id != null && r.linked_driver_user_id !== "") user.linkedDriverUserId = String(r.linked_driver_user_id);
    user.driverIdentity = await effectiveDriverIdentity(user);
    return user;
  }
  return null;
}
export async function requireRole(roles: Role[]) { const user = await currentUser(); return user && roles.includes(user.role) ? user : null; }

export { configured, hash, verify, writeCookie };
export const makeId = id;

/** Clear the legacy cookie name both host-only (path=/) and domain-scoped
 *  (`.parent`), covering cookies older builds left on either scope. */
async function clearLegacyCookies() {
  for (const legacy of legacyCookieNames) {
    await writeCookie(legacy, "", 0);
    try {
      const { getRequestHost, setCookie } = await import("@tanstack/start-server-core");
      const host = getRequestHost();
      const parts = host ? host.split(".") : [];
      if (parts.length > 2) {
        const parent = parts.slice(1).join(".");
        if (parent && parent.includes(".")) setCookie(legacy, "", { ...cookieOpts(0), domain: `.${parent}` });
      }
    } catch { /* host unavailable: the host-only deletion still applies */ }
  }
}

export async function startSession(userId: string) {
  const token = id();
  await sql()`INSERT INTO sessions(id,user_id,expires_at) VALUES(${token},${userId},NOW()+INTERVAL '30 days')`;
  await writeCookie(cookieName, token, 60 * 60 * 24 * 30);
  await clearLegacyCookies();
}

/* ----------------------- owner↔driver link (view toggle) ----------------------- */
/** The staff roles that may hold a driver identity (owner-confirmed Q1: admins
 *  included). Dispatchers never get the toggle. */
const DRIVER_LINK_ROLES: Role[] = ["owner", "admin"];

export type LinkableDriverRow = {
  id: string;
  name: string;
  towbookDriverId: string;
  signedIn: boolean;
  lastActivityAt: string | null;
};
export type DriverLinkStatusResult =
  | { ok: true; ownDriverId: string | null; linked: (LinkableDriverRow & { deactivated: boolean }) | null; candidates: LinkableDriverRow[] }
  | { ok: false; error: string };

/** The Settings "My driver account" card payload (owner/admin-only):
 *  ownDriverId — the actor's own Towbook driver id (shape a; when set the link
 *  UI is hidden entirely); linked — the shape-b link row (name/driver id/
 *  sign-in/last activity + deactivated flag when the linked driver was later
 *  removed); candidates — active org contractors with a Towbook driver id that
 *  are NOT already linked by another account (the picker list). */
export async function listLinkableDriversCore(): Promise<DriverLinkStatusResult> {
  const u = await requireRole(DRIVER_LINK_ROLES);
  if (!u) return { ok: false, error: "Owner access required." };
  const q = sql();
  const linkedRow = u.linkedDriverUserId
    ? (await q`SELECT id, name, towbook_driver_id, deactivated_at FROM users WHERE id=${u.linkedDriverUserId} LIMIT 1`)[0] as Record<string, unknown> | undefined
    : undefined;
  const linked = linkedRow && linkedRow.towbook_driver_id != null
    ? {
        id: String(linkedRow.id),
        name: String(linkedRow.name ?? "Driver"),
        towbookDriverId: String(linkedRow.towbook_driver_id),
        signedIn: false,
        lastActivityAt: null as string | null,
        deactivated: linkedRow.deactivated_at != null,
      }
    : null;
  if (linked) {
    const act = await q`SELECT
        (SELECT COUNT(*)::int FROM towbook_sessions ts WHERE ts.org_id=${u.orgId} AND ts.towbook_driver_id=${linked.towbookDriverId} AND ts.session_kind='driver') AS sessions,
        (SELECT MAX(updated_at) FROM towbook_sessions ts WHERE ts.org_id=${u.orgId} AND ts.towbook_driver_id=${linked.towbookDriverId} AND ts.session_kind='driver') AS last_session,
        (SELECT MAX(captured_at) FROM driver_locations dl WHERE dl.org_id=${u.orgId} AND dl.driver_id=${linked.id}) AS last_ping,
        (SELECT MAX(created_at) FROM sessions s WHERE s.user_id=${linked.id} AND s.expires_at > NOW()) AS last_login`;
    const a = act[0] as Record<string, unknown>;
    linked.signedIn = Number(a?.sessions ?? 0) > 0;
    const stamps = [a?.last_session, a?.last_ping, a?.last_login].filter((v) => v != null).map((v) => new Date(String(v)).getTime());
    linked.lastActivityAt = stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
  }
  const rows = await q`SELECT u.id, u.name, u.towbook_driver_id,
      (SELECT COUNT(*)::int FROM towbook_sessions ts WHERE ts.org_id=${u.orgId} AND ts.towbook_driver_id=u.towbook_driver_id AND ts.session_kind='driver') AS sessions,
      (SELECT MAX(updated_at) FROM towbook_sessions ts WHERE ts.org_id=${u.orgId} AND ts.towbook_driver_id=u.towbook_driver_id AND ts.session_kind='driver') AS last_session,
      (SELECT MAX(captured_at) FROM driver_locations dl WHERE dl.org_id=${u.orgId} AND dl.driver_id=u.id) AS last_ping
    FROM users u
    JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${u.orgId} AND m.role='contractor'
    WHERE u.deactivated_at IS NULL AND u.towbook_driver_id IS NOT NULL
      -- drivers already linked to ANY account are not linkable (one owner per
      -- driver, partial unique index) — the link column lives on the SOURCE
      -- row, so exclude via NOT EXISTS on users.linked_driver_user_id
      AND NOT EXISTS (SELECT 1 FROM users src WHERE src.linked_driver_user_id = u.id)
    ORDER BY LOWER(u.name)`;
  const candidates: LinkableDriverRow[] = (rows as Record<string, unknown>[]).map((r) => {
    const stamps = [r.last_session, r.last_ping].filter((v) => v != null).map((v) => new Date(String(v)).getTime());
    return {
      id: String(r.id),
      name: String(r.name ?? "Driver"),
      towbookDriverId: String(r.towbook_driver_id),
      signedIn: Number(r.sessions ?? 0) > 0,
      lastActivityAt: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
    };
  });
  return { ok: true, ownDriverId: u.towbookDriverId ?? null, linked, candidates };
}

/** Link the actor's account to an active org contractor (shape b). Validation
 *  (spec §3): target is same org, role 'contractor', active, with a Towbook
 *  driver id; source is owner/admin with NO own towbook_driver_id (shape a and
 *  b are mutually exclusive — the link UI is hidden for shape a). One driver
 *  per owner (column); one owner per driver (partial unique index). Audited
 *  'driver_link_set' (best-effort). */
export async function linkDriverAccountCore(driverUserId: unknown): Promise<{ ok: true; linked: LinkableDriverRow & { deactivated: boolean } } | { ok: false; error: string }> {
  const u = await requireRole(DRIVER_LINK_ROLES);
  if (!u) return { ok: false, error: "Owner access required." };
  if (typeof driverUserId !== "string" || !driverUserId.trim()) return { ok: false, error: "Choose a driver to link." };
  const q = sql();
  if (u.towbookDriverId) return { ok: false, error: "Your account is already a driver — the Driver view switch is on in your header." };
  const target = (await q`SELECT id, name, towbook_driver_id, deactivated_at FROM users WHERE id=${driverUserId} LIMIT 1`)[0] as Record<string, unknown> | undefined;
  if (!target) return { ok: false, error: "That driver isn't on this account." };
  const member = await q`SELECT 1 FROM organization_memberships m WHERE m.org_id=${u.orgId} AND m.user_id=${driverUserId} AND m.role='contractor' LIMIT 1`;
  if (!member.length) return { ok: false, error: "That driver isn't on this account." };
  if (target.deactivated_at != null) return { ok: false, error: "This driver was removed — reactivate them first." };
  if (target.towbook_driver_id == null) return { ok: false, error: "That driver has no dispatch id yet — have them sign in once from their phone." };
  if (u.linkedDriverUserId) return { ok: false, error: "You're already linked to a driver — unlink first." };
  try {
    await q`UPDATE users SET linked_driver_user_id=${driverUserId} WHERE id=${u.id} AND linked_driver_user_id IS NULL`;
  } catch {
    return { ok: false, error: "That driver is already linked to another account." };
  }
  const still = await q`SELECT linked_driver_user_id FROM users WHERE id=${u.id} LIMIT 1`;
  if (!still.length || String(still[0].linked_driver_user_id ?? "") !== driverUserId) {
    return { ok: false, error: "That driver is already linked to another account." };
  }
  await writeLinkAudit(u, "driver_link_set", driverUserId, { driverUserId, driverName: String(target.name ?? "") });
  const signedInRow = await q`SELECT (SELECT COUNT(*)::int FROM towbook_sessions ts WHERE ts.org_id=${u.orgId} AND ts.towbook_driver_id=${target.towbook_driver_id} AND ts.session_kind='driver') AS sessions`;
  return {
    ok: true,
    linked: {
      id: driverUserId,
      name: String(target.name ?? "Driver"),
      towbookDriverId: String(target.towbook_driver_id),
      signedIn: Number(signedInRow[0]?.sessions ?? 0) > 0,
      lastActivityAt: null,
      deactivated: false,
    },
  };
}

/** Clear the shape-b link. Audited 'driver_link_unset' (best-effort). */
export async function unlinkDriverAccountCore(): Promise<{ ok: true } | { ok: false; error: string }> {
  const u = await requireRole(DRIVER_LINK_ROLES);
  if (!u) return { ok: false, error: "Owner access required." };
  const q = sql();
  const before = (await q`SELECT linked_driver_user_id FROM users WHERE id=${u.id} LIMIT 1`)[0] as Record<string, unknown> | undefined;
  if (!before || before.linked_driver_user_id == null) return { ok: false, error: "No driver account is linked." };
  await q`UPDATE users SET linked_driver_user_id=NULL WHERE id=${u.id}`;
  await writeLinkAudit(u, "driver_link_unset", String(before.linked_driver_user_id), { driverUserId: String(before.linked_driver_user_id) });
  return { ok: true };
}

async function writeLinkAudit(u: AuthUser, action: string, entityId: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await sql()`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${u.orgId}, ${u.id}, ${u.role}, ${action}, 'user', ${entityId}, ${JSON.stringify(detail)}::jsonb, 'auth-server'`;
  } catch { /* audit is best-effort — never mask the outcome */ }
}
