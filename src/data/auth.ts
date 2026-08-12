import { createServerFn } from "@tanstack/react-start";
export type Role = "owner" | "admin" | "dispatcher" | "contractor";
/** Client mirror of auth-server's DriverIdentityInfo (seroval-safe, explicit
 *  nulls). Present on every session user: null when the user has no driver
 *  identity; otherwise the driver row behind the session (own row for
 *  contractors and shape-a staff, the linked contractor's row for shape b). */
export type DriverIdentityInfo = { userRowId: string; towbookDriverId: string; driverName: string; deactivated: boolean };
export type AuthUser = { id: string; name: string; email: string; role: Role; contractorId?: string; driverIdentity: DriverIdentityInfo | null };
// Resolve the Node-only implementation at request time. Keep the specifier literal
// so Rollup rewrites it to the emitted hashed server chunk in production.
const server=()=>import("./auth-server");
export const authStatus=createServerFn({method:"GET"}).handler(async()=>{const s=await server();if(!process.env.DATABASE_URL)return {mode:"demo" as const,user:null};await s.ensureAuthSchema();const q=(await import("~/db")).sql();const count=await q`SELECT count(*)::int AS count FROM users WHERE id IN (SELECT user_id FROM organization_memberships WHERE role='owner')`;return {mode:"database" as const,needsOwner:Number((count[0] as Record<string,unknown>).count)===0,user:await s.currentUser()};});
const credentials=(x:unknown)=>{const v=x as Record<string,unknown>;if(typeof v.email!=="string"||typeof v.password!=="string"||v.password.length<10)return null;return {email:v.email.trim().toLowerCase(),password:v.password,name:typeof v.name==="string"?v.name.trim():""};};
// Sign-in takes a plain username OR an email (the AI dispatcher logs in with a
// username). Non-empty identifier; emails are matched case-insensitively on the
// lowercase value, handles are unique and stored lowercase. Password min is 1
// (not 10): drivers' Towbook dispatch passwords may be short, and a short LD
// password simply fails verification below — never force a Towbook attempt on
// input shape alone. Max 256 mirrors driverLogin.
const loginCredentials=(x:unknown)=>{const v=x as Record<string,unknown>;if(typeof v.identifier!=="string"||!v.identifier.trim()||typeof v.password!=="string"||!v.password||v.password.length>256)return null;return {identifier:v.identifier.trim().toLowerCase(),password:v.password};};
export type LoginFailureReason = "invalid_input" | "unknown_identifier" | "contractor_account" | "invalid_password" | "deactivated" | "no_workspace";
/** Decision helper for the login form (owner bug 2026-08-12): may the sign-in
 *  fall through to the Towbook driver login after an LD failure? ONLY unknown
 *  identifiers (likely a Towbook driver) and contractor accounts (drivers
 *  authenticate via Towbook) fall through — an LD owner/admin/dispatcher with a
 *  wrong password must NEVER hit Towbook (it surfaced a misleading "Towbook
 *  could not be connected" error instead of "wrong password"). */
export const shouldFallThroughToDriverLogin=(r:{ok:false;error:string;reason?:string}):boolean=>
  r.reason==="unknown_identifier"||r.reason==="contractor_account";
export const createOwner=createServerFn({method:"POST"}).validator(x=>x).handler(async({data})=>{const s=await server();if(!process.env.DATABASE_URL)return {ok:false,error:"Database mode is not active."};const c=credentials(data);if(!c||!c.name||c.name.length<2)return {ok:false,error:"Enter a name and a password of at least 10 characters."};await s.ensureAuthSchema();const q=(await import("~/db")).sql();if((await q`SELECT 1 FROM organization_memberships WHERE role='owner' LIMIT 1`).length)return {ok:false,error:"An owner account already exists. Please sign in."};const uid=s.makeId(),oid=s.makeId();await q`INSERT INTO organizations(id,name) VALUES(${oid},'Lightning Roadside Assistants LLC')`;await q`INSERT INTO users(id,name,email,password_hash) VALUES(${uid},${c.name},${c.email},${s.hash(c.password)})`;await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${oid},${uid},'owner')`;await s.startSession(uid);return {ok:true};});
export const login=createServerFn({method:"POST"}).validator(x=>x).handler(async({data})=>{const s=await server();if(!process.env.DATABASE_URL)return {ok:false,error:"Database mode is not active."};const c=loginCredentials(data);if(!c)return {ok:false,error:"Invalid username or password.",reason:"invalid_input" as const};// Username OR email resolution + verify + role classification live in
// auth-server.loginCore (server-only). The failure carries a machine-readable
// reason so the login form can decide whether the Towbook driver fallback is
// allowed (owner/admin/dispatcher wrong-password must NOT fall through).
const r=await s.loginCore(c.identifier,c.password);if(!r.ok)return {ok:false,error:r.error,reason:r.reason};await s.startSession(r.userId);return {ok:true,role:r.role};});
export const logout=createServerFn({method:"POST"}).handler(async()=>{const s=await server();const tokens=await s.cookieValues(s.cookieName);if(process.env.DATABASE_URL&&tokens.length){const q=(await import("~/db")).sql();for(const t of tokens)await q`DELETE FROM sessions WHERE id=${t}`;}await s.writeCookie(s.cookieName,"",0);for(const legacy of s.legacyCookieNames)await s.writeCookie(legacy,"",0);return {ok:true};});
/* ---------- owner↔contractor view toggle (owner-directed 2026-08-12) ---------- */
/** Settings card payload + link picker (owner/admin only). See
 *  auth-server.listLinkableDriversCore for the shape. */
export type LinkableDriverRow = { id: string; name: string; towbookDriverId: string; signedIn: boolean; lastActivityAt: string | null };
export type DriverLinkStatus = { ok: true; ownDriverId: string | null; linked: (LinkableDriverRow & { deactivated: boolean }) | null; candidates: LinkableDriverRow[] } | { ok: false; error: string };
export const driverLinkStatus=createServerFn({method:"GET"}).handler(async():Promise<DriverLinkStatus>=>{const s=await server();if(!process.env.DATABASE_URL)return {ok:false as const,error:"Database mode is not active."};await s.ensureAuthSchema();return s.listLinkableDriversCore();});
export const linkDriverAccount=createServerFn({method:"POST"}).validator((x:unknown)=>x).handler(async({data}):Promise<{ok:true;linked:LinkableDriverRow & {deactivated:boolean}}|{ok:false;error:string}>=>{const s=await server();if(!process.env.DATABASE_URL)return {ok:false as const,error:"Database mode is not active."};await s.ensureAuthSchema();return s.linkDriverAccountCore((data as Record<string,unknown>|undefined)?.driverUserId);});
export const unlinkDriverAccount=createServerFn({method:"POST"}).handler(async():Promise<{ok:true}|{ok:false;error:string}>=>{const s=await server();if(!process.env.DATABASE_URL)return {ok:false as const,error:"Database mode is not active."};await s.ensureAuthSchema();return s.unlinkDriverAccountCore();});
