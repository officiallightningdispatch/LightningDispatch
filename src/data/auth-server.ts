import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { sql } from "~/db";
import { ensureSchema } from "./migrations";
import { createServerOnlyFn } from "@tanstack/react-start";
export type Role = "owner" | "admin" | "dispatcher" | "contractor";
export type AuthUser = { id: string; name: string; email: string; role: Role; orgId: string; contractorId?: string };
const cookieName = "lightning_session";
const cookieValue = createServerOnlyFn(async () => {
  const { getCookie } = await import("@tanstack/start-server-core");
  return getCookie(cookieName);
});
const writeCookie = createServerOnlyFn(async (value:string,maxAge:number) => {
  const { setCookie } = await import("@tanstack/start-server-core");
  setCookie(cookieName, value, {
    path: "/", httpOnly: true, sameSite: "lax", maxAge,
    ...(process.env.NODE_ENV === "production" ? { secure: true } : {}),
  });
});
const configured=()=>Boolean(process.env.DATABASE_URL);
const hash=(password:string,salt=randomBytes(16).toString("hex"))=>`${salt}:${scryptSync(password,salt,64).toString("hex")}`;
const verify=(password:string,stored:string)=>{const [salt,hex]=stored.split(":");if(!salt||!hex)return false;try{return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(hex,"hex"));}catch{return false;}};
export async function ensureAuthSchema() {
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await q`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await q`CREATE TABLE IF NOT EXISTS organization_memberships (org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('owner','admin','dispatcher','contractor')), contractor_id TEXT, PRIMARY KEY(org_id,user_id))`;
  await q`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
}

async function prepareAuthAndDispatchSchema() {
  await ensureAuthSchema();
  await ensureSchema();
}
const id = () => randomBytes(18).toString("hex");
export async function currentUser(): Promise<AuthUser | null> {
  if (!configured()) return null;
  await prepareAuthAndDispatchSchema(); const token = await cookieValue(); if (!token) return null;
  const q = sql(); const rows = await q`SELECT u.id,u.name,u.email,m.org_id,m.role,m.contractor_id FROM sessions s JOIN users u ON u.id=s.user_id JOIN organization_memberships m ON m.user_id=u.id WHERE s.id=${token} AND s.expires_at > NOW()`;
  if (!rows.length) return null; const r = rows[0] as Record<string, unknown>; return { id:String(r.id), name:String(r.name), email:String(r.email), role:r.role as Role, orgId:String(r.org_id), contractorId:r.contractor_id ? String(r.contractor_id) : undefined };
}
export async function requireRole(roles: Role[]) { const user = await currentUser(); return user && roles.includes(user.role) ? user : null; }

export { configured, hash, verify, cookieValue, writeCookie };
export const makeId=id; export async function startSession(userId:string){const token=id();await sql()`INSERT INTO sessions(id,user_id,expires_at) VALUES(${token},${userId},NOW()+INTERVAL '30 days')`;await writeCookie(token,60*60*24*30);}
