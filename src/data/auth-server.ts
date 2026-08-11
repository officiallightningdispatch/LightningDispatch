import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { sql } from "~/db";
export type Role = "owner" | "admin" | "dispatcher" | "contractor";
export type AuthUser = { id: string; name: string; email: string; role: Role; orgId: string; contractorId?: string };
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
  await q`CREATE TABLE IF NOT EXISTS organization_memberships (org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('owner','admin','dispatcher','contractor')), contractor_id TEXT, PRIMARY KEY(org_id,user_id))`;
  await q`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
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

export async function currentUser(): Promise<AuthUser | null> {
  if (!configured()) return null;
  await ensureAuthSchema();
  const tokens = await cookieValues(cookieName);
  if (!tokens.length) return null;
  const q = sql();
  for (const token of tokens) {
    const rows = await q`SELECT u.id,u.name,u.email,m.org_id,m.role,m.contractor_id FROM sessions s JOIN users u ON u.id=s.user_id JOIN organization_memberships m ON m.user_id=u.id WHERE s.id=${token} AND s.expires_at > NOW() AND u.deactivated_at IS NULL`;
    if (!rows.length) continue;
    const r = rows[0] as Record<string, unknown>;
    // Seroval rejects object properties whose value is undefined. Owner/admin
    // memberships have no contractor_id, so only include this optional field
    // when the database actually returned one.
    const user: AuthUser = { id: String(r.id), name: String(r.name), email: String(r.email), role: r.role as Role, orgId: String(r.org_id) };
    if (r.contractor_id != null && r.contractor_id !== "") user.contractorId = String(r.contractor_id);
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
