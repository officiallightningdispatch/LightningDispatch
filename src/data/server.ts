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
// --- Towbook login: request shape byte-matched to a real browser (see /home/team/shared/towbook-recon.md) ---
const TOWBOOK_ORIGIN = "https://app.towbook.com";
const TOWBOOK_LOGIN = "https://app.towbook.com/Security/Login.aspx";
// A real browser navigation POST sends these; a bare fetch advertises "Bun/1.x"
// and omits Origin/Referer — a bot fingerprint login WAFs can reject. Verified
// against the live page: the form submits Username, Password, bSignIn (=EMPTY —
// the button has no value attribute, so the browser submits bSignIn=), and
// RequestVerificationToken, in exactly that order.
const TOWBOOK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const towbookBrowserHeaders = (cookie?: string) => ({
  "user-agent": TOWBOOK_UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "accept-language": "en-US,en;q=0.9",
  "upgrade-insecure-requests": "1",
  "sec-ch-ua": '"Chromium";v="151", "Not=A?Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  ...(cookie ? { cookie } : {}),
});
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
const isAuthCookie = (n: string) => /(\.ASPXAUTH|ASP\.NET_SessionId|\.AspNetCore\.Cookies|\.AspNetCore\.Identity|\.AspNet\.ApplicationCookie|identity|ticket|session|auth)/i.test(n) && !/(TempData|Antiforgery|RequestVerificationToken|_ga|_gid|_gat|_hj|_zitok|hubspot|__cf|_hjid|_gcl)/i.test(n);
const hasAuthCookie = (cs: string[]) => cs.some(c => isAuthCookie(c.split(";")[0].split("=")[0].trim()));
// Full cookie set for later authenticated pulls: response Set-Cookie merged over
// the pre-login cookies, response winning on name collisions.
const mergeJars = (pre: string, resp: string) => {
  const m = new Map<string, string>();
  for (const part of pre.split("; ")) { const n = part.split("=")[0].trim(); if (part && n) m.set(n, part); }
  for (const part of resp.split("; ")) { const n = part.split("=")[0].trim(); if (part && n) m.set(n, part); }
  return [...m.values()].join("; ");
};
// --- Diagnostics: capture exactly what Towbook returned so a rejected connect is
// explainable. The classified short message goes to the UI; the full facts are
// persisted to towbook_sessions.error for post-mortem. ---
type TowbookCookieFact = { name: string; value: string; auth: boolean };
type TowbookFacts = {
  stage: string;
  status: number | null;
  location: string | null;
  bodyLen: number | null;
  contentType: string | null;
  cookies: TowbookCookieFact[];
  authCookieDetected: boolean;
  loginForm: boolean;
  bodyHint: string;
  hops: { status: number | null; location: string | null; cookies: string[] }[];
};
const truncate = (s: string, n = 26) => (s.length > n ? s.slice(0, n) + "…" : s);
const cookieFacts = (cs: string[]): TowbookCookieFact[] => cs.map((c) => {
  const eq = c.indexOf("=");
  const name = (eq > 0 ? c.slice(0, eq) : c).trim();
  const value = eq > 0 ? c.slice(eq + 1).trim() : "";
  return { name, value: truncate(value), auth: isAuthCookie(name) };
});
const hasLoginForm = (html: string) => /<form/i.test(html) && /RequestVerificationToken/i.test(html);
const botChallengeHint = /(cf-chl|challenge-platform|just a moment|attention required|captcha|verify (you are|your)|access denied|blocked by)/i;
const describeTowbookFailure = (f: TowbookFacts): { code: "invalid_credentials"|"towbook_blocked"|"towbook_unreachable"; message: string } => {
  if (f.status === 401 || f.status === 403) {
    if (f.status === 403 && botChallengeHint.test(f.bodyHint)) return { code: "towbook_blocked", message: "Towbook is blocking automated sign-in. Open Towbook in your browser once, then retry." };
    return { code: "invalid_credentials", message: "Towbook rejected those credentials." };
  }
  if (f.status !== null && f.status >= 300 && f.status < 400) {
    const names = f.cookies.map(c => c.name).join(", ") || "none";
    return { code: "invalid_credentials", message: `Towbook responded: ${f.status} redirect${f.location ? ` to ${f.location}` : ""}, cookies: [${names}], no auth cookie matched — Towbook may be blocking automated sign-in or the session cookie name is unrecognized.` };
  }
  if (f.status === 200) {
    if (f.loginForm) return { code: "invalid_credentials", message: "Towbook rejected those credentials." };
    if (f.cookies.length === 0) return { code: "towbook_blocked", message: "Towbook is blocking automated sign-in. Open Towbook in your browser once, then retry." };
    return { code: "towbook_blocked", message: `Towbook responded: 200 with an unexpected page (${f.bodyLen ?? "?"} bytes, no login form, no session cookie) — Towbook may be blocking automated sign-in. Open Towbook in your browser once, then retry.` };
  }
  return { code: "towbook_unreachable", message: `Towbook responded with an unexpected status ${f.status ?? "unknown"}. Try again or use an interactive reconnect.` };
};
const towbookDetail = (f: TowbookFacts) => JSON.stringify(f);
async function persistTowbookSession(orgId: string, fullJar: string) {
  await prepare();
  await sql()`INSERT INTO towbook_sessions(org_id,encrypted_session,status,error,updated_at) VALUES(${orgId},${await encryptSession(JSON.stringify({cookies:fullJar,baseUrl:TOWBOOK_ORIGIN}))},'connected',NULL,NOW()) ON CONFLICT(org_id) DO UPDATE SET encrypted_session=EXCLUDED.encrypted_session,status='connected',error=NULL,updated_at=NOW()`;
}
async function persistTowbookFailure(orgId: string, f: TowbookFacts) {
  try {
    await prepare();
    await sql()`INSERT INTO towbook_sessions(org_id,encrypted_session,status,error,updated_at) VALUES(${orgId},'','error',${towbookDetail(f)},NOW()) ON CONFLICT(org_id) DO UPDATE SET status='error',error=EXCLUDED.error,updated_at=NOW(),encrypted_session=towbook_sessions.encrypted_session`;
  } catch { /* never mask the real connect result with a diagnostics-write failure */ }
}
export const towbookStatus=createServerFn({method:"GET"}).handler(async()=>{ if(!configured()) return {ok:true as const,connected:false,lastSyncAt:null}; const {currentUser}=await import("./auth-server"); const u=await currentUser(); if(!u)return towbookFail("towbook_unreachable","Sign in required."); if(!can(u,["owner","admin"]))return towbookFail("towbook_blocked","You cannot view Towbook status."); try { await prepare(); const r=await sql()`SELECT status,last_sync_at FROM towbook_sessions WHERE org_id=${u.orgId}`; return {ok:true as const,connected:Boolean(r.length && r[0].status==='connected'),lastSyncAt:r.length&&r[0].last_sync_at?new Date(String(r[0].last_sync_at)).toISOString():null}; } catch { return towbookFail("towbook_unreachable","Towbook status unavailable."); }});
export const connectTowbook=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{
  const e=invalid(data,z.object({username:z.string().min(1).max(256),password:z.string().min(1).max(256)}).strict());
  if(e)return e;
  if(!configured())return towbookFail("towbook_unreachable","Towbook connection requires database mode.");
  const {currentUser}=await import("./auth-server");
  const u=await currentUser();
  if(!u)return towbookFail("towbook_blocked","Sign in required.");
  if(!can(u,["owner","admin"]))return towbookFail("towbook_blocked","Only owners and admins can connect Towbook.");
  const d=data as {username:string;password:string};
  const facts: TowbookFacts = { stage:"get",status:null,location:null,bodyLen:null,contentType:null,cookies:[],authCookieDetected:false,loginForm:false,bodyHint:"",hops:[] };
  const failWith = async (f: TowbookFacts) => { const fb=describeTowbookFailure(f); await persistTowbookFailure(u.orgId,f); return towbookFail(fb.code,fb.message); };
  try {
    // 1) GET the login page. The RequestVerificationToken and the antiforgery
    //    cookie are issued as a pair and ROTATE on every GET — the token below
    //    must pair with the cookie from THIS response (it does: both come from
    //    this same page fetch).
    const page=await fetch(TOWBOOK_LOGIN,{headers:towbookBrowserHeaders(),signal:AbortSignal.timeout(10000)});
    const html=await page.text();
    const preJar=jar(getSetCookies(page.headers));
    facts.status=page.status; facts.bodyLen=html.length;
    facts.contentType=page.headers.get("content-type"); facts.loginForm=hasLoginForm(html);
    facts.cookies=cookieFacts(getSetCookies(page.headers)); facts.bodyHint=html.slice(0,200).toLowerCase();
    if(!page.ok){ await persistTowbookFailure(u.orgId,facts); return towbookFail("towbook_unreachable","Towbook login is unavailable."); }
    const token=html.match(/name=["']RequestVerificationToken["'][^>]*value=["']([^"']+)/i)?.[1];
    if(!token){ await persistTowbookFailure(u.orgId,facts); return towbookFail("towbook_blocked","Towbook login requires a browser session or challenge. Open Towbook in your browser once, then retry."); }
    // 2) POST exactly like a browser form: same field names/order, bSignIn is an
    //    empty-valued submit button (Towbook's HTML has no value attribute), and
    //    the full browser header set (UA, Origin, Referer, sec-fetch-*).
    const body=new URLSearchParams({Username:d.username,Password:d.password,bSignIn:"",RequestVerificationToken:token});
    const login=await fetch(TOWBOOK_LOGIN,{method:"POST",body,redirect:"manual",headers:towbookBrowserHeaders(preJar),signal:AbortSignal.timeout(10000)});
    const respCookies=getSetCookies(login.headers);
    const postText=await login.text();
    facts.stage="post"; facts.status=login.status; facts.location=login.headers.get("location");
    facts.bodyLen=postText.length; facts.contentType=login.headers.get("content-type");
    facts.cookies=cookieFacts(respCookies); facts.authCookieDetected=hasAuthCookie(respCookies);
    facts.loginForm=hasLoginForm(postText); facts.bodyHint=postText.slice(0,200).toLowerCase();
    // 3) Interpret the response. ASP.NET Core cookie auth sets the session cookie
    //    in the success response's Set-Cookie; failed logins re-render the login
    //    page (200, observed with fake creds) or bounce with a redirect.
    if(login.status===401||login.status===403)return failWith(facts);
    if(login.status>=300&&login.status<400){
      if(facts.authCookieDetected){ await persistTowbookSession(u.orgId,mergeJars(preJar,jar(respCookies))); return {ok:true as const}; }
      // No auth cookie on the redirect itself: follow like a browser — the
      // session cookie may be set on the redirect target instead.
      let jarSoFar=mergeJars(preJar,jar(respCookies));
      let hop=login.headers.get("location");
      for(let i=0;i<3&&hop;i++){
        const target=new URL(hop,TOWBOOK_ORIGIN);
        if(target.origin!==TOWBOOK_ORIGIN){ facts.location=target.toString(); break; }
        const r=await fetch(target.toString(),{headers:towbookBrowserHeaders(jarSoFar),redirect:"manual",signal:AbortSignal.timeout(10000)});
        const rc=getSetCookies(r.headers);
        const rtext=await r.text();
        facts.hops.push({status:r.status,location:r.headers.get("location"),cookies:rc.map(c=>c.split(";")[0])});
        jarSoFar=mergeJars(jarSoFar,jar(rc));
        facts.status=r.status; facts.location=r.headers.get("location");
        facts.bodyLen=rtext.length; facts.contentType=r.headers.get("content-type");
        facts.cookies=cookieFacts(rc); facts.authCookieDetected=hasAuthCookie(rc);
        facts.loginForm=hasLoginForm(rtext); facts.bodyHint=rtext.slice(0,200).toLowerCase();
        if(hasAuthCookie(rc)){ await persistTowbookSession(u.orgId,jarSoFar); return {ok:true as const}; }
        if(facts.loginForm)break; // bounced back to the login page → bad credentials
        hop=r.headers.get("location");
      }
      return failWith(facts);
    }
    if(login.status===200){
      if(facts.authCookieDetected){ await persistTowbookSession(u.orgId,mergeJars(preJar,jar(respCookies))); return {ok:true as const}; }
      return failWith(facts);
    }
    return failWith(facts);
  } catch(err) {
    const msg=String(err);
    facts.stage="network"; facts.bodyHint=msg.slice(0,200);
    await persistTowbookFailure(u.orgId,facts);
    return towbookFail(msg.includes("timeout")||msg.includes("fetch")?"towbook_unreachable":"towbook_blocked", "Towbook could not be connected. Try again or use an interactive reconnect.");
  }
});
export const disconnectTowbook=createServerFn({method:"POST"}).handler(async()=>{if(!configured())return {ok:true as const};const {currentUser}=await import("./auth-server");const u=await currentUser();if(!u||!can(u,["owner","admin"]))return towbookFail("towbook_blocked","You cannot disconnect Towbook.");try{await prepare();await sql()`DELETE FROM towbook_sessions WHERE org_id=${u.orgId}`;return {ok:true as const};}catch{return towbookFail("towbook_unreachable","Unable to disconnect Towbook.");}});
export const resetDemo=createServerFn({method:"POST"}).validator(passthrough).handler(async()=>fail("unauthorized","Reset demo data is disabled in database mode."));
