import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { sql } from "~/db";
import { encryptSession } from "./towbook-key";
import { contractors as seedContractors, jobs as seedJobs } from "./seed";
import type { AuthUser } from "./auth-server";
import type { ContractorStatus, JobStatus, Contractor, Job } from "./seed";

export type DispatchData = { contractors: Contractor[]; jobs: Job[] };
export type CommandErrorCode = "validation"|"not_found"|"invalid_state"|"conflict"|"offline_contractor"|"database_unavailable"|"unauthorized";
export type CommandError = { code: CommandErrorCode; message: string; field?: string };
export type CommandResult = { ok: true; data: DispatchData } | { ok: false; error: CommandError };
const configured = () => Boolean(process.env.DATABASE_URL);
const passthrough = (x: unknown) => x;
const id = z.string().min(1).max(64);
const fail = (code: CommandErrorCode, message: string, field?: string): CommandResult => ({ ok:false, error:{code,message,field} });
function invalid(input: unknown, schema: z.ZodTypeAny): CommandResult|null { const p=schema.safeParse(input); if(p.success)return null; const i=p.error.issues[0]; return fail("validation",i.message,i.path[0] ? String(i.path[0]) : undefined); }
const unavailable = (message="Database command unavailable.") => fail("database_unavailable",message);

let schemaInit: Promise<void> | undefined;
/** Initialize auth + dispatch schemas once per server process. Startup invokes this;
 * command handlers retain the awaited promise as a first-request safety net. */
function prepare() {
  if (!configured()) return Promise.resolve();
  schemaInit ??= (async () => {
    const { ensureAuthSchema } = await import("./auth-server");
    await ensureAuthSchema();
    const { ensureSchema } = await import("./migrations");
    await ensureSchema();
  })();
  return schemaInit;
}

// The production handler is imported when the server boots. Running initialization
// here fixes the old request-only wiring while the handler-level awaits remain a
// fallback for runtimes that load modules lazily.

function mapContractor(r: Record<string,unknown>): Contractor { return {id:String(r.id),name:String(r.name),status:r.status as ContractorStatus,location:{lat:Number(r.lat),lng:Number(r.lng),area:String(r.area)},vehicleTypes:(r.vehicle_types as string[])||[],rating:Number(r.rating),completedJobCount:Number(r.completed_job_count),responseTimeHistoryMinutes:(r.response_time_history_minutes as number[])||[]}; }
function mapJob(r: Record<string,unknown>): Job { return {id:String(r.id),customerName:String(r.customer_name),phone:String(r.phone),location:{lat:Number(r.lat),lng:Number(r.lng),area:String(r.area)},serviceType:r.service_type as Job["serviceType"],status:r.status as JobStatus,createdAt:new Date(String(r.created_at)).toISOString(),assignedAt:r.assigned_at?new Date(String(r.assigned_at)).toISOString():undefined,arrivedAt:r.arrived_at?new Date(String(r.arrived_at)).toISOString():undefined,completedAt:r.completed_at?new Date(String(r.completed_at)).toISOString():undefined,assignedContractorId:r.assigned_contractor_id?String(r.assigned_contractor_id):undefined,note:String(r.note||"")}; }
async function dataFor(u: AuthUser): Promise<DispatchData> { const q=sql(); const cs=await q`SELECT id,name,status,lat,lng,area,vehicle_types,rating,completed_job_count,response_time_history_minutes FROM dispatch_contractors WHERE org_id=${u.orgId} ${u.role==="contractor" ? q`AND id=${u.contractorId||""}` : q``}`; const js=await q`SELECT id,customer_name,phone,lat,lng,area,service_type,status,created_at,assigned_at,arrived_at,completed_at,assigned_contractor_id,note FROM dispatch_jobs WHERE org_id=${u.orgId} ${u.role==="contractor" ? q`AND assigned_contractor_id=${u.contractorId||""}` : q``} ORDER BY created_at DESC`; return {contractors:cs.map(mapContractor),jobs:js.map(mapJob)}; }
async function result(u: AuthUser): Promise<CommandResult> { return {ok:true,data:await dataFor(u)}; }
function can(u:AuthUser, roles:AuthUser["role"][]) { return roles.includes(u.role); }

export const getDispatchData=createServerFn({method:"GET"}).handler(async()=>{ if(!configured())return {mode:"demo" as const,data:{contractors:seedContractors,jobs:seedJobs}}; const { currentUser } = await import("./auth-server"); const u=await currentUser(); if(!u)return {mode:"database" as const,data:{contractors:[],jobs:[]},error:{code:"unauthorized" as const,message:"Sign in required."}}; try {await prepare(); return {mode:"database" as const,data:await dataFor(u)};} catch { return {mode:"database" as const,data:{contractors:[],jobs:[]},error:{code:"database_unavailable" as const,message:"Database unavailable."}};} });

export const assignJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id,contractorId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — assign works in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");if(!can(u,["owner","admin","dispatcher"]))return fail("unauthorized","You cannot assign jobs.");try{await prepare();const q=sql();const c=await q`SELECT status FROM dispatch_contractors WHERE id=${(data as {contractorId:string}).contractorId} AND org_id=${u.orgId}`;if(!c.length)return fail("not_found","Contractor not found.");if(c[0].status!=="online")return fail("offline_contractor","Contractor is offline.");const job=(data as {jobId:string}).jobId, con=(data as {contractorId:string}).contractorId, actor=u.id;const rows=await q.transaction([q`WITH changed AS (UPDATE dispatch_jobs SET status='offered',assigned_contractor_id=${con},assigned_at=NOW() WHERE id=${job} AND org_id=${u.orgId} AND status='new' RETURNING id,org_id,'new'::text AS old_status,'offered'::text AS new_status) INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role) SELECT gen_random_uuid()::text,org_id,id,old_status,new_status,${actor},${u.role} FROM changed RETURNING job_id` ,q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${actor},${u.role},'assign','job',${job},jsonb_build_object('contractorId',${con}) WHERE EXISTS (SELECT 1 FROM status_events WHERE org_id=${u.orgId} AND job_id=${job} AND from_status='new' AND to_status='offered' AND actor_user_id=${actor})`]); if(!rows[0]?.length)return fail("conflict","Job is no longer available for assignment.");return result(u);}catch{return unavailable("Unable to assign job.");}});

export const advanceJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — advancing works in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");try{await prepare();const job=(data as {jobId:string}).jobId;const rows=await sql().transaction([sql() `WITH current AS (SELECT id,status FROM dispatch_jobs WHERE id=${job} AND org_id=${u.orgId}), changed AS (UPDATE dispatch_jobs j SET status=CASE j.status WHEN 'offered' THEN 'accepted' WHEN 'accepted' THEN 'en_route' WHEN 'en_route' THEN 'arrived' WHEN 'arrived' THEN 'completed' END,arrived_at=CASE WHEN j.status='en_route' THEN NOW() ELSE j.arrived_at END,completed_at=CASE WHEN j.status='arrived' THEN NOW() ELSE j.completed_at END FROM current c WHERE j.id=c.id AND ((${u.role} IN ('owner','admin','dispatcher')) OR (${u.role}='contractor' AND j.assigned_contractor_id=${u.contractorId||''})) AND j.status IN ('offered','accepted','en_route','arrived') RETURNING j.id,j.org_id,c.status AS old_status,j.status AS new_status) INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role) SELECT gen_random_uuid()::text,org_id,id,old_status,new_status,${u.id},${u.role} FROM changed RETURNING job_id` ,sql() `INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${u.id},${u.role},'advance','job',${job},'{}'::jsonb WHERE EXISTS (SELECT 1 FROM status_events WHERE org_id=${u.orgId} AND job_id=${job} AND actor_user_id=${u.id} AND to_status IN ('accepted','en_route','arrived','completed') ORDER BY occurred_at DESC LIMIT 1)`]);if(!rows[0]?.length)return fail("invalid_state","Job cannot be advanced from its current state or you are not allowed.");return result(u);}catch{return unavailable("Unable to advance job.");}});

export const declineJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id,contractorId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — declining works in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");if(!can(u,["owner","admin","dispatcher"]) && !(u.role==="contractor" && u.contractorId===(data as {contractorId:string}).contractorId))return fail("unauthorized","You cannot decline this offer.");try{await prepare();const d=data as {jobId:string;contractorId:string};const rows=await sql().transaction([sql()`WITH changed AS (UPDATE dispatch_jobs SET status='new',assigned_contractor_id=NULL,assigned_at=NULL WHERE id=${d.jobId} AND org_id=${u.orgId} AND status='offered' AND assigned_contractor_id=${d.contractorId} RETURNING id,org_id,'offered'::text AS old_status,'new'::text AS new_status) INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role) SELECT gen_random_uuid()::text,org_id,id,old_status,new_status,${u.id},${u.role} FROM changed RETURNING job_id`,sql()`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${u.id},${u.role},'decline','job',${d.jobId},'{}'::jsonb WHERE EXISTS (SELECT 1 FROM status_events WHERE org_id=${u.orgId} AND job_id=${d.jobId} AND actor_user_id=${u.id} AND from_status='offered' AND to_status='new' ORDER BY occurred_at DESC LIMIT 1)`]);if(!rows[0]?.length)return fail("invalid_state","Only an offered job assigned to that contractor can be declined.");return result(u);}catch{return unavailable("Unable to decline job.");}});

export const setContractorStatus=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({contractorId:id,status:z.enum(["online","offline"])}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — status changes work in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");const d=data as {contractorId:string;status:ContractorStatus};if(u.role==="contractor"&&u.contractorId!==d.contractorId)return fail("unauthorized","You can only change your own status.");if(!can(u,["owner","admin","dispatcher","contractor"]))return fail("unauthorized","You cannot change contractor status.");try{await prepare();const rows=await sql().transaction([sql()`WITH changed AS (UPDATE dispatch_contractors SET status=${d.status} WHERE id=${d.contractorId} AND org_id=${u.orgId} RETURNING id) INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${u.id},${u.role},'set_contractor_status','contractor',id,jsonb_build_object('status',${d.status}) FROM changed RETURNING entity_id`,sql()`SELECT 1`]);if(!rows[0]?.length)return fail("not_found","Contractor not found.");return result(u);}catch{return unavailable("Unable to change contractor status.");}});

const towbookFail = (code: "invalid_credentials"|"towbook_unreachable"|"towbook_blocked", message: string) => ({ok:false as const,error:{code,message}});
// --- Towbook login response interpretation (mapped against the real login page, see /home/team/shared/towbook-recon.md) ---
const TOWBOOK_LOGIN = "https://app.towbook.com/Security/Login.aspx";
const getSetCookies = (h: Headers): string[] => {
  const hd = h as Headers & { getSetCookie?: () => string[] };
  if (typeof hd.getSetCookie === "function") return hd.getSetCookie();
  const joined = h.get("set-cookie");
  return joined ? [joined] : [];
};
const jar = (cs: string[]) => cs.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
// Session/auth cookies carry the authenticated state; the excluded names are
// the non-auth cookies Towbook actually sends (antiforgery + TempData flash +
// marketing), so a fake-credential 200/302 can never be mistaken for success.
const isAuthCookie = (n: string) => /(\.ASPXAUTH|ASP\.NET_SessionId|\.AspNetCore\.Cookies|\.AspNetCore\.Identity|\.AspNet\.ApplicationCookie|ticket|session|auth)/i.test(n) && !/(TempData|Antiforgery|RequestVerificationToken|_ga|_gid|_gat|_hj|_zitok|hubspot|__cf|_hjid|_gcl)/i.test(n);
const hasAuthCookie = (cs: string[]) => cs.some(c => isAuthCookie(c.split(";")[0].split("=")[0].trim()));
// Full cookie set for later authenticated pulls: response Set-Cookie merged over
// the pre-login cookies, response winning on name collisions.
const mergeJars = (pre: string, resp: string) => {
  const m = new Map<string, string>();
  for (const part of pre.split("; ")) { const n = part.split("=")[0].trim(); if (part && n) m.set(n, part); }
  for (const part of resp.split("; ")) { const n = part.split("=")[0].trim(); if (part && n) m.set(n, part); }
  return [...m.values()].join("; ");
};
export const towbookStatus=createServerFn({method:"GET"}).handler(async()=>{ if(!configured()) return {ok:true as const,connected:false,lastSyncAt:null}; const {currentUser}=await import("./auth-server"); const u=await currentUser(); if(!u)return towbookFail("towbook_unreachable","Sign in required."); if(!can(u,["owner","admin"]))return towbookFail("towbook_blocked","You cannot view Towbook status."); try { await prepare(); const r=await sql()`SELECT status,last_sync_at FROM towbook_sessions WHERE org_id=${u.orgId}`; return {ok:true as const,connected:Boolean(r.length && r[0].status==='connected'),lastSyncAt:r.length&&r[0].last_sync_at?new Date(String(r[0].last_sync_at)).toISOString():null}; } catch { return towbookFail("towbook_unreachable","Towbook status unavailable."); }});
export const connectTowbook=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({email:z.string().email(),password:z.string().min(1).max(256)}).strict());if(e)return e;if(!configured())return towbookFail("towbook_unreachable","Towbook connection requires database mode."); const {currentUser}=await import("./auth-server"); const u=await currentUser(); if(!u)return towbookFail("towbook_blocked","Sign in required."); if(!can(u,["owner","admin"]))return towbookFail("towbook_blocked","Only owners and admins can connect Towbook."); const d=data as {email:string;password:string}; try {
  const page=await fetch(TOWBOOK_LOGIN,{signal:AbortSignal.timeout(10000)}); if(!page.ok)return towbookFail("towbook_unreachable","Towbook login is unavailable.");
  const html=await page.text(); const preJar=jar(getSetCookies(page.headers));
  const token=html.match(/name=["']RequestVerificationToken["'][^>]*value=["']([^"']+)/i)?.[1]; if(!token)return towbookFail("towbook_blocked","Towbook login requires a browser session or challenge.");
  const body=new URLSearchParams({Username:d.email,Password:d.password,bSignIn:"Log in",RequestVerificationToken:token});
  const login=await fetch(TOWBOOK_LOGIN,{method:"POST",body,redirect:"manual",headers:{"content-type":"application/x-www-form-urlencoded",...(preJar?{cookie:preJar}:{})},signal:AbortSignal.timeout(10000)});
  const respCookies=getSetCookies(login.headers); const authed=hasAuthCookie(respCookies);
  if(login.status===401||login.status===403)return towbookFail("invalid_credentials","Towbook rejected those credentials.");
  if(login.status>=300&&login.status<400) {
    // ASP.NET Core redirects on successful auth and carries the auth session
    // cookie in that response's Set-Cookie; a redirect without one is a
    // failed-login bounce back to the login page.
    if(!authed)return towbookFail("invalid_credentials","Towbook rejected those credentials.");
    const fullJar=mergeJars(preJar,jar(respCookies));
    await prepare(); await sql()`INSERT INTO towbook_sessions(org_id,encrypted_session,status,error,updated_at) VALUES(${u.orgId},${await encryptSession(JSON.stringify({cookies:fullJar,baseUrl:"https://app.towbook.com"}))},'connected',NULL,NOW()) ON CONFLICT(org_id) DO UPDATE SET encrypted_session=EXCLUDED.encrypted_session,status='connected',error=NULL,updated_at=NOW()`;
    return {ok:true as const};
  }
  if(login.status===200) {
    if(authed) { const fullJar=mergeJars(preJar,jar(respCookies)); await prepare(); await sql()`INSERT INTO towbook_sessions(org_id,encrypted_session,status,error,updated_at) VALUES(${u.orgId},${await encryptSession(JSON.stringify({cookies:fullJar,baseUrl:"https://app.towbook.com"}))},'connected',NULL,NOW()) ON CONFLICT(org_id) DO UPDATE SET encrypted_session=EXCLUDED.encrypted_session,status='connected',error=NULL,updated_at=NOW()`; return {ok:true as const}; }
    // Observed with fake credentials: 200 re-render of the login page.
    const re=await login.text();
    if(/<form/i.test(re)&&/RequestVerificationToken/i.test(re))return towbookFail("invalid_credentials","Towbook rejected those credentials.");
    return towbookFail("towbook_blocked","Towbook returned an unexpected response; reconnect from a supported browser.");
  }
  return towbookFail("towbook_unreachable","Towbook login failed.");
} catch(err) { const msg=String(err); return towbookFail(msg.includes("timeout")||msg.includes("fetch")?"towbook_unreachable":"towbook_blocked", "Towbook could not be connected. Try again or use an interactive reconnect."); }});
export const disconnectTowbook=createServerFn({method:"POST"}).handler(async()=>{if(!configured())return {ok:true as const};const {currentUser}=await import("./auth-server");const u=await currentUser();if(!u||!can(u,["owner","admin"]))return towbookFail("towbook_blocked","You cannot disconnect Towbook.");try{await prepare();await sql()`DELETE FROM towbook_sessions WHERE org_id=${u.orgId}`;return {ok:true as const};}catch{return towbookFail("towbook_unreachable","Unable to disconnect Towbook.");}});
export const resetDemo=createServerFn({method:"POST"}).validator(passthrough).handler(async()=>fail("unauthorized","Reset demo data is disabled in database mode."));
