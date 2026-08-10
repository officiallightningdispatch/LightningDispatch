import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { sql } from "~/db";
import { decryptSession, encryptSession } from "./towbook-key";
import { runAutoDispatch } from "./ai-dispatcher";
import { contractors as seedContractors, jobs as seedJobs } from "./seed";
import type { AuthUser } from "./auth-server";
import type { ContractorStatus, JobStatus, Contractor, Job, ServiceType } from "./seed";

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
    startBackgroundSync();
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

export const getDispatchData=createServerFn({method:"GET"}).handler(async()=>{ if(!configured())return {mode:"demo" as const,data:{contractors:seedContractors,jobs:seedJobs}}; const { currentUser } = await import("./auth-server"); const u=await currentUser(); if(!u)return {mode:"database" as const,data:{contractors:[],jobs:[]},error:{code:"unauthorized" as const,message:"Sign in required."}}; try {await prepare(); void maybeAutoSync(u.orgId); return {mode:"database" as const,data:await dataFor(u)};} catch { return {mode:"database" as const,data:{contractors:[],jobs:[]},error:{code:"database_unavailable" as const,message:"Database unavailable."}};} });

export const assignJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id,contractorId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — assign works in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");if(!can(u,["owner","admin","dispatcher"]))return fail("unauthorized","You cannot assign jobs.");try{await prepare();const q=sql();const c=await q`SELECT status FROM dispatch_contractors WHERE id=${(data as {contractorId:string}).contractorId} AND org_id=${u.orgId}`;if(!c.length)return fail("not_found","Contractor not found.");if(c[0].status!=="online")return fail("offline_contractor","Contractor is offline.");const job=(data as {jobId:string}).jobId, con=(data as {contractorId:string}).contractorId, actor=u.id;const rows=await q.transaction([q`WITH changed AS (UPDATE dispatch_jobs SET status='offered',assigned_contractor_id=${con},assigned_at=NOW() WHERE id=${job} AND org_id=${u.orgId} AND status='new' RETURNING id,org_id,'new'::text AS old_status,'offered'::text AS new_status) INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role) SELECT gen_random_uuid()::text,org_id,id,old_status,new_status,${actor},${u.role} FROM changed RETURNING job_id` ,q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${actor},${u.role},'assign','job',${job},jsonb_build_object('contractorId',${con}) WHERE EXISTS (SELECT 1 FROM status_events WHERE org_id=${u.orgId} AND job_id=${job} AND from_status='new' AND to_status='offered' AND actor_user_id=${actor})`]); if(!rows[0]?.length)return fail("conflict","Job is no longer available for assignment.");return result(u);}catch{return unavailable("Unable to assign job.");}});

export const advanceJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — advancing works in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");try{await prepare();const job=(data as {jobId:string}).jobId;const rows=await sql().transaction([sql() `WITH current AS (SELECT id,status FROM dispatch_jobs WHERE id=${job} AND org_id=${u.orgId}), changed AS (UPDATE dispatch_jobs j SET status=CASE j.status WHEN 'offered' THEN 'accepted' WHEN 'accepted' THEN 'en_route' WHEN 'en_route' THEN 'arrived' WHEN 'arrived' THEN 'completed' END,arrived_at=CASE WHEN j.status='en_route' THEN NOW() ELSE j.arrived_at END,completed_at=CASE WHEN j.status='arrived' THEN NOW() ELSE j.completed_at END FROM current c WHERE j.id=c.id AND ((${u.role} IN ('owner','admin','dispatcher')) OR (${u.role}='contractor' AND j.assigned_contractor_id=${u.contractorId||''})) AND j.status IN ('offered','accepted','en_route','arrived') RETURNING j.id,j.org_id,c.status AS old_status,j.status AS new_status) INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role) SELECT gen_random_uuid()::text,org_id,id,old_status,new_status,${u.id},${u.role} FROM changed RETURNING job_id` ,sql() `INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${u.id},${u.role},'advance','job',${job},'{}'::jsonb WHERE EXISTS (SELECT 1 FROM status_events WHERE org_id=${u.orgId} AND job_id=${job} AND actor_user_id=${u.id} AND to_status IN ('accepted','en_route','arrived','completed') ORDER BY occurred_at DESC LIMIT 1)`]);if(!rows[0]?.length)return fail("invalid_state","Job cannot be advanced from its current state or you are not allowed.");return result(u);}catch{return unavailable("Unable to advance job.");}});

export const declineJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id,contractorId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — declining works in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");if(!can(u,["owner","admin","dispatcher"]) && !(u.role==="contractor" && u.contractorId===(data as {contractorId:string}).contractorId))return fail("unauthorized","You cannot decline this offer.");try{await prepare();const d=data as {jobId:string;contractorId:string};const rows=await sql().transaction([sql()`WITH changed AS (UPDATE dispatch_jobs SET status='new',assigned_contractor_id=NULL,assigned_at=NULL WHERE id=${d.jobId} AND org_id=${u.orgId} AND status='offered' AND assigned_contractor_id=${d.contractorId} RETURNING id,org_id,'offered'::text AS old_status,'new'::text AS new_status) INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role) SELECT gen_random_uuid()::text,org_id,id,old_status,new_status,${u.id},${u.role} FROM changed RETURNING job_id`,sql()`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${u.id},${u.role},'decline','job',${d.jobId},'{}'::jsonb WHERE EXISTS (SELECT 1 FROM status_events WHERE org_id=${u.orgId} AND job_id=${d.jobId} AND actor_user_id=${u.id} AND from_status='offered' AND to_status='new' ORDER BY occurred_at DESC LIMIT 1)`]);if(!rows[0]?.length)return fail("invalid_state","Only an offered job assigned to that contractor can be declined.");return result(u);}catch{return unavailable("Unable to decline job.");}});

export const setContractorStatus=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({contractorId:id,status:z.enum(["online","offline"])}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — status changes work in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");const d=data as {contractorId:string;status:ContractorStatus};if(u.role==="contractor"&&u.contractorId!==d.contractorId)return fail("unauthorized","You can only change your own status.");if(!can(u,["owner","admin","dispatcher","contractor"]))return fail("unauthorized","You cannot change contractor status.");try{await prepare();const rows=await sql().transaction([sql()`WITH changed AS (UPDATE dispatch_contractors SET status=${d.status} WHERE id=${d.contractorId} AND org_id=${u.orgId} RETURNING id) INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${u.id},${u.role},'set_contractor_status','contractor',id,jsonb_build_object('status',${d.status}) FROM changed RETURNING entity_id`,sql()`SELECT 1`]);if(!rows[0]?.length)return fail("not_found","Contractor not found.");return result(u);}catch{return unavailable("Unable to change contractor status.");}});

export type StatusEvent = { jobId: string; fromStatus: string | null; toStatus: string; actorRole: string | null; note: string | null; occurredAt: string };
/** Org-scoped status timeline (real history only). Powers the history tab and
 *  the performance tab's avg time-to-complete. */
export const getStatusEvents=createServerFn({method:"GET"}).handler(async()=>{ if(!configured())return []; const { currentUser } = await import("./auth-server"); const u=await currentUser(); if(!u)return []; if(!can(u,["owner","admin","dispatcher"]))return []; try { await prepare(); const q=sql(); const rows=await q`SELECT job_id,from_status,to_status,actor_role,note,occurred_at FROM status_events WHERE org_id=${u.orgId} ORDER BY occurred_at DESC LIMIT 1000`; return rows.map((r: Record<string,unknown>)=>({jobId:String(r.job_id),fromStatus:r.from_status?String(r.from_status):null,toStatus:String(r.to_status),actorRole:r.actor_role?String(r.actor_role):null,note:r.note?String(r.note):null,occurredAt:new Date(String(r.occurred_at)).toISOString()})); } catch { return []; } });

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
export const towbookStatus=createServerFn({method:"GET"}).handler(async()=>{ if(!configured()) return {ok:true as const,connected:false,lastSyncAt:null,lastResult:null}; const {currentUser}=await import("./auth-server"); const u=await currentUser(); if(!u)return towbookFail("towbook_unreachable","Sign in required."); if(!can(u,["owner","admin"]))return towbookFail("towbook_blocked","You cannot view Towbook status."); try { await prepare(); const r=await sql()`SELECT status,last_sync_at,last_result FROM towbook_sessions WHERE org_id=${u.orgId}`; const row=r[0] as Record<string,unknown>|undefined; let lastResult: TowbookSyncResult | null = null; if(row?.last_result){ try { const p=row.last_result as Record<string,unknown>; lastResult={ok:String(p.code)==="ok",code:p.code as TowbookSyncCode,message:String(p.message??""),added:Number(p.added??0),updated:Number(p.updated??0),failed:Number(p.failed??0),diagnostics:Array.isArray(p.diagnostics)?p.diagnostics as TowbookSyncDiag[]:[],ranAt:String(p.ranAt??""),...(Array.isArray(p.sample)?{sample:p.sample as Record<string, unknown>[]}:{}),...(Array.isArray(p.statusShapes)?{statusShapes:p.statusShapes as string[]}:{}),...(p.sampleByStatus&&typeof p.sampleByStatus==="object"&&!Array.isArray(p.sampleByStatus)?{sampleByStatus:p.sampleByStatus as Record<string, Record<string, unknown>>}:{})}; } catch { lastResult=null; } } return {ok:true as const,connected:Boolean(row && row.status==='connected'),lastSyncAt:row&&row.last_sync_at?new Date(String(row.last_sync_at)).toISOString():null,lastResult}; } catch { return towbookFail("towbook_unreachable","Towbook status unavailable."); }});
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

/* ============================ Towbook job puller (slice 2) ============================
 * Self-discovering authenticated sync: uses the org's stored Towbook session cookie jar
 * (encrypted at rest via towbook-key.ts) to fetch likely job-list surfaces, parse job
 * rows out of HTML tables and/or JSON payloads, and upsert them into dispatch_jobs
 * deduped by towbook_job_id (org-scoped unique). Status changes write status_events +
 * audit_log. Diagnostics are rich (URLs tried + statuses + truncated body hints) so the
 * first live run pinpoints the one thing to adjust. Session cookies/passwords are NEVER
 * included in any response, diagnostic, or log.
 *
 * Safety rails: no session row / not connected → clean error; undecryptable session →
 * clean error (reconnect); login-page response → session_expired; unknown statuses are
 * skipped and counted (failed) with the raw values surfaced in diagnostics; per-org
 * in-flight guard prevents overlapping syncs.
 * ---------------------------------------------------------------------------------- */

export type TowbookSyncCode = "ok" | "not_connected" | "session_unavailable" | "session_expired" | "no_jobs" | "unauthorized" | "error";
export type TowbookSyncDiag = { url: string; status: number | null; contentType: string | null; hint: string };
export type TowbookSyncResult = { ok: boolean; code: TowbookSyncCode; message: string; added: number; updated: number; failed: number; diagnostics: TowbookSyncDiag[]; ranAt: string; sample?: Record<string, unknown>[]; statusShapes?: string[]; sampleByStatus?: Record<string, Record<string, unknown>> };
const syncResult = (code: TowbookSyncCode, message: string, extra?: Partial<TowbookSyncResult>): TowbookSyncResult => ({ ok: code === "ok", code, message, added: 0, updated: 0, failed: 0, diagnostics: [], ranAt: new Date().toISOString(), ...extra });

/** Sync result message with EXACT arithmetic: found = added + updated +
 *  unchanged + failed. (Bug fixed 2026-08-10: the message used the normalized
 *  count as "Synced N" while failed also included skipped jobs, so N did not
 *  reconcile with A+U+F — e.g. "Synced 20 … 21 failed".) */
export function buildSyncMessage(found: number, added: number, updated: number, unchanged: number, failed: number): string {
  return `Synced ${found} Towbook job(s): ${added} added, ${updated} updated, ${unchanged} unchanged, ${failed} failed.`;
}

/** Data-driven Towbook status → dispatch lifecycle mapping (first match wins; order
 *  matters — specific negations before the generic bucket). Unmapped statuses are
 *  skipped, not silently coerced. */
export const TOWBOOK_STATUS_TO_LIFECYCLE: ReadonlyArray<{ match: RegExp; to: JobStatus }> = [
  { match: /not dispatched|unassigned|incoming|new|pending|queued|unscheduled/i, to: "new" },
  { match: /assigned|offered|offer sent|offer/i, to: "offered" },
  { match: /dispatched|accepted|accept/i, to: "accepted" },
  { match: /en\s?route|enroute|on the way|heading/i, to: "en_route" },
  { match: /arrived|on scene|on-scene|at scene/i, to: "arrived" },
  { match: /completed|complete|done|closed|finished|paid|billed/i, to: "completed" },
];
export function mapTowbookStatus(raw: string): JobStatus | null {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return null;
  for (const { match, to } of TOWBOOK_STATUS_TO_LIFECYCLE) if (match.test(s)) return to;
  return null;
}

/** Numeric Towbook status id → dispatch lifecycle (the /api/calls JSON surface).
 *  CONFIRMED mapping (2026-08-10): 0..5 map 1:1 onto our own lifecycle
 *  (new → offered → accepted → en_route → arrived → completed) — the real call
 *  objects carry status as an OBJECT ({id}) plus a per-call allowed-status list
 *  [0,1,2,3,4,5]. 255 = CANCELLED (lead-verified 2026-08-10 from the owner's
 *  real run): the captured 255 call has the FULL workflow chain statuses
 *  [0,1,2,3,4,5], a set completionTime, and availableActions incl. UNDO_CANCEL
 *  and DELETE — i.e. a completed call that was subsequently cancelled. 255
 *  imports as the terminal 'cancelled' state (belongs in the system for
 *  PO/invoice reconciliation, never active, never counted as a completion).
 *  252 = COMPLETED (owner-verified 2026-08-10, real-data evidence): the live
 *  call 279656932 carried status {"id":252} with the FULL chain statuses
 *  [0,1,2,3,4,5], a set completionTime (2026-08-10T20:33), and availableActions
 *  incl. ACKNOWLEDGE_COMPLETE/UPDATE_STATUS/CANCEL/DELETE (vs status-5 calls'
 *  UNDO_COMPLETE/LOCK/PUSH_TO_QUICKBOOKS/AUDIT) — 252 is Towbook's
 *  completed-awaiting-acknowledgement terminal, 5 is the fully-closed terminal;
 *  both import as our terminal 'completed'. (The call flip-flopped 252→2→252
 *  across syncs — Towbook-side reopen/acknowledge — and our upsert simply
 *  follows whatever Towbook says, which is correct.) */
export const TOWBOOK_STATUS_ID_TO_LIFECYCLE: Readonly<Record<number, JobStatus>> = {
  0: "new", // workflow start — call created / not yet dispatched
  1: "offered", // dispatched to a driver (observed next.statusId = 2)
  2: "accepted", // driver accepted
  3: "en_route", // driver heading to the scene
  4: "arrived", // on scene
  5: "completed", // workflow end (observed; terminal)
  252: "completed", // completed-awaiting-acknowledgement (owner-verified 2026-08-10)
  255: "cancelled", // completed-then-cancelled / cancelled call (terminal, import-only)
};
/** Known ids that are deliberately NOT mapped (documented so the next run knows
 *  they were considered). Currently empty: every observed id (0..5, 252, 255)
 *  now maps. Any id that shows up later lands here only after the sampleByStatus
 *  evidence proves it is NOT a lifecycle state. */
export const TOWBOOK_STATUS_ID_UNMAPPED: ReadonlySet<number> = new Set<number>();

const numericStatusId = (v: unknown): number | null =>
  typeof v === "number" ? (Number.isInteger(v) ? v : null)
  : typeof v === "string" && v.trim() !== "" ? (Number.isInteger(Number(v.trim())) ? Number(v.trim()) : null)
  : null;

/** Defensively derive a numeric Towbook status id from a call's status field,
 *  which may be an object ({id}, {id,next:{statusId}}, {next:{waypointId,statusId}}),
 *  a plain number, a numeric string, an array ([] / [id]), or null. Prefers
 *  status.id, then status.next.statusId, then status.statusId/stateId, then any
 *  single small numeric field of the status object. Returns null when no numeric
 *  id can be derived — callers must then SKIP the call (never guess a status). */
export function extractTowbookStatusId(status: unknown): number | null {
  if (status == null) return null;
  if (typeof status === "number" || typeof status === "string") return numericStatusId(status);
  if (Array.isArray(status)) return status.length === 1 ? extractTowbookStatusId(status[0]) : null;
  if (typeof status === "object") {
    const o = status as Record<string, unknown>;
    const byId = numericStatusId(o.id);
    if (byId != null) return byId;
    const next = o.next && typeof o.next === "object" && !Array.isArray(o.next) ? (o.next as Record<string, unknown>) : null;
    if (next) {
      const byNext = numericStatusId(next.statusId);
      if (byNext != null) return byNext;
    }
    const byField = numericStatusId(o.statusId) ?? numericStatusId(o.stateId);
    if (byField != null) return byField;
    // Last resort: status objects are tiny and shape-known — a lone small
    // numeric field is the status id. (Never applied to whole call objects.)
    for (const v of Object.values(o)) {
      const n = numericStatusId(v);
      if (n != null && n >= 0 && n <= 10000) return n;
    }
  }
  return null;
}

/** Compact, bounded stringification of a raw status value for diagnostics and
 *  the persisted statusShapes — never rendered raw in the UI. */
const stringifyStatus = (s: unknown): string => {
  if (s == null) return "";
  const j = typeof s === "string" ? s : JSON.stringify(s);
  return (j ?? String(s)).slice(0, 200);
};

/** Data-driven Towbook service text → dispatch service type. Anything unrecognized
 *  falls back to flatbed_tow (generic roadside/tow) rather than breaking the UI,
 *  which only renders the five canonical service types. */
const TOWBOOK_SERVICE_TO_TYPE: ReadonlyArray<{ match: RegExp; to: ServiceType }> = [
  { match: /jump|battery|boost|dead batt|start/i, to: "jump_start" },
  { match: /tire|tyre/i, to: "tire_change" },
  { match: /lock|key|unlock/i, to: "lockout" },
  { match: /fuel|gas|diesel|petrol|gasoline/i, to: "fuel_delivery" },
  { match: /tow|wrecker|rollback|flatbed|transport|recover|winch/i, to: "flatbed_tow" },
];
export function mapTowbookService(raw: string): ServiceType {
  const s = (raw || "").toLowerCase();
  for (const { match, to } of TOWBOOK_SERVICE_TO_TYPE) if (match.test(s)) return to;
  return "flatbed_tow";
}

/** Candidate job-list surfaces. The puller tries them in order with the stored
 *  session and records what each returns (URL, status, contentType, hint).
 *
 *  Recon (2026-08-10, see /home/team/shared/towbook-recon.md): every MVC path
 *  below 302s to /Security/Login?ReturnUrl=… when unauthenticated, i.e. they all
 *  EXIST as authenticated routes — with the owner's real session cookie they
 *  should render 200 + job rows. The app's own terminology is "Calls" (support
 *  KB: "How to Complete a Call", "out-of-network-calls"), hence the /Calls/*
 *  family. The /api/* family is the "Extric-Towbook/5.0 Service Platform API"
 *  (x-powered-by + x-twbk-version headers observed) — every /api/* path returns
 *  401 "Invalid Security Token. Please re-authenticate" when unauthenticated
 *  (catch-all middleware, so 401 ≠ endpoint exists), so with a valid session
 *  cookie those same paths may return JSON job payloads. The diagnostics of the
 *  first live run show which family actually returns 200 content.
 */
const TOWBOOK_JOB_PATHS = [
  // HTML/MVC surfaces (server-rendered grids)
  "", "/Dispatch", "/Dispatch/Index", "/Dispatch/Active", "/Dispatch/History",
  "/Dispatch/Completed", "/Dispatch/Board", "/DispatchBoard", "/Board",
  "/Jobs", "/Jobs/Index", "/Job", "/Job/Index",
  "/Calls", "/Calls/Index", "/Calls/Active", "/Calls/History", "/Calls/Open",
  "/Calls/Closed", "/Calls/Completed", "/Calls/Today", "/Calls/All", "/Calls/List",
  "/Call", "/Call/Index", "/Call/Get", "/Calls/GetCalls", "/Calls/Grid",
  "/Orders", "/Order", "/Orders/Index", "/Agero", "/Agero/Index",
  "/MotorClub", "/MotorClubs", "/MotorClub/Index", "/Incoming", "/History",
  "/Completed", "/CompletedJobs", "/Today", "/TodaysJobs", "/Dashboard",
  // Service-Platform API (JSON). 401-with-cookie in diagnostics tells us the
  // session cookie is NOT the API token; 200/JSON is the jackpot.
  "/api/jobs", "/api/calls", "/api/orders", "/api/dispatch", "/api/dispatches",
  "/api/jobs/current", "/api/jobs/open", "/api/jobs/active", "/api/jobs/completed",
  "/api/Calls", "/api/Job/Get", "/api/jobs/list",
];

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** Compact, tag-stripped, lowercased body fingerprint — truncated so a response can
 *  never smuggle the full page (or PII) into the UI; it exists to identify the page. */
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

/* ------------------------------- HTML table parsing ------------------------------- */

type RawJob = Record<string, string>;
const HEADER_FIELD_MAP: ReadonlyArray<{ match: RegExp; field: string }> = [
  { match: /job\s*type|work\s*type|service|category|reason|type of|job\s*kind/i, field: "service" },
  { match: /job|order|ticket|ref|number|^id$|call\s*id/i, field: "id" },
  { match: /customer|member|caller|account|party|^name$/i, field: "customer" },
  { match: /phone|tel|mobile/i, field: "phone" },
  { match: /vehicle|unit|car|truck|year|make|model|vin|color|plate/i, field: "vehicle" },
  { match: /pickup|from|origin|source|address|street|location/i, field: "pickup" },
  { match: /dropoff|drop\s*off|to\s*:|dest|destination|deliver/i, field: "dropoff" },
  { match: /status|state|stage/i, field: "status" },
  { match: /date|created|opened|time/i, field: "date" },
  { match: /note|comment|description|details|memo/i, field: "note" },
];
const fieldForHeader = (h: string): string => {
  const hh = h.toLowerCase();
  for (const { match, field } of HEADER_FIELD_MAP) if (match.test(hh)) return field;
  return "";
};
const cellTexts = (row: string) => [...row.matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((m) => stripHtml(m[0]));
/** Extract job-ish records from every <table> that has a recognizable header row. */
export function parseTables(html: string): RawJob[] {
  const out: RawJob[] = [];
  for (const tbl of [...html.matchAll(/<table[\s\S]*?<\/table>/gi)]) {
    const rows = [...tbl[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
    if (rows.length < 2) continue;
    const first = cellTexts(rows[0]);
    const hasTh = /<th/i.test(rows[0]);
    const headers = first.map((c, i) => {
      if (hasTh) return c;
      const f = fieldForHeader(c);
      return f || (i < 8 ? `col${i}` : "");
    });
    if (!hasTh && !headers.some(Boolean)) continue;
    for (let i = 1; i < rows.length; i++) {
      const cells = cellTexts(rows[i]);
      const rec: RawJob = {};
      cells.forEach((c, idx) => {
        const field = fieldForHeader(headers[idx] || "");
        if (!field || !c) return;
        rec[field] = rec[field] ? `${rec[field]} ${c}` : c;
      });
      if (Object.values(rec).some((v) => v)) out.push(rec);
    }
  }
  return out;
}

/* ---------------------------------- JSON parsing ---------------------------------- */

const JSON_FIELD_MAP: ReadonlyArray<{ match: RegExp; field: string }> = [
  { match: /job_?type|work_?type|service|category|reason|kind/i, field: "service" },
  { match: /job_?id|job_?number|order_?id|order_?number|ticket|reference|^id$|call_?id/i, field: "id" },
  { match: /customer|member|caller|account|party|client/i, field: "customer" },
  { match: /phone|tel|mobile/i, field: "phone" },
  { match: /vehicle|unit|car|truck|year|make|model|vin|plate/i, field: "vehicle" },
  { match: /pickup|origin|source|from_?address|location|street/i, field: "pickup" },
  { match: /dropoff|destination|dest|to_?address/i, field: "dropoff" },
  { match: /status|state|stage/i, field: "status" },
  { match: /created|opened|date|time/i, field: "date" },
  { match: /note|comment|description|details|memo/i, field: "note" },
];
const fieldForJsonKey = (k: string): string => {
  for (const { match, field } of JSON_FIELD_MAP) if (match.test(k)) return field;
  return "";
};
const scalar = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : v == null ? "" : JSON.stringify(v));
function objToRawJob(o: Record<string, unknown>): RawJob | null {
  const rec: RawJob = {};
  for (const [k, v] of Object.entries(o)) {
    const field = fieldForJsonKey(k.toLowerCase());
    const s = scalar(v).trim();
    if (!field || !s) continue;
    rec[field] = rec[field] ? `${rec[field]} ${s}` : s;
  }
  return Object.keys(rec).length ? rec : null;
}
/** Recursively harvest job-ish objects from an arbitrary JSON payload. */
export function parseJsonJobs(payload: string): RawJob[] {
  let data: unknown;
  try { data = JSON.parse(payload); } catch { return []; }
  const out: RawJob[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const rec = objToRawJob(item as Record<string, unknown>);
          if (rec) out.push(rec);
          else walk(item);
        } else walk(item);
      }
    } else if (node && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(data);
  return out;
}

/** Recursively harvest call-like objects (any object with an `id` field) from a
 *  JSON payload — the /api/calls surface returns a flat array of call objects, but
 *  this also tolerates wrappers like {"calls":[...]}. Once an object with an id is
 *  found it is collected WITHOUT recursing into it, so nested DTOs (account,
 *  vehicle, …) can never be mistaken for calls. */
export function parseJsonObjects(payload: string): Record<string, unknown>[] {
  let data: unknown;
  try { data = JSON.parse(payload); } catch { return []; }
  const out: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const o = item as Record<string, unknown>;
          if (o.id != null || o.callNumber != null) { out.push(o); continue; }
          walk(item);
        } else walk(item);
      }
    } else if (node && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(data);
  return out;
}

/* --------------------------- JSON call normalization --------------------------- */

const pickString = (o: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = o[k];
    if (v == null) continue;
    if (typeof v === "string") { const t = v.trim(); if (t) return t; }
    if (typeof v === "number") return String(v);
  }
  return "";
};
/** Find the first non-empty text at o[k] (string/number), recursing into object
 *  values with nestedKeys. Used to read call fields that may be flat strings or
 *  nested DTOs (e.g. account → account.company). */
const findText = (o: Record<string, unknown>, keys: string[], nestedKeys: string[] = []): string => {
  for (const k of keys) {
    const v = o[k];
    if (v == null) continue;
    if (typeof v === "string") { const t = v.trim(); if (t) return t; }
    if (typeof v === "number") return String(v);
    if (typeof v === "object" && !Array.isArray(v) && nestedKeys.length) {
      const t = findText(v as Record<string, unknown>, nestedKeys);
      if (t) return t;
    }
  }
  return "";
};
/** Best-effort human vehicle description from whatever shape the call uses. */
const vehicleText = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v).trim();
  if (typeof v === "object" && !Array.isArray(v)) {
    const parts: string[] = [];
    for (const k of ["year", "make", "model", "color", "plate", "description", "name", "label"]) {
      const s = pickString(v as Record<string, unknown>, k);
      if (s) parts.push(s);
    }
    return parts.join(" ");
  }
  return "";
};
/** Derive a status id from the CALL OBJECT itself (fallback when call.status is
 *  missing). Only explicit status keys — never a numeric sweep of the whole call,
 *  whose type/companyId/version fields would poison the guess. */
const callLevelStatusId = (call: Record<string, unknown>): number | null =>
  numericStatusId(call.statusId) ?? numericStatusId(call.currentStatusId) ?? numericStatusId(call.stateId) ?? null;

type JsonCallResult = { ok: true; job: NormalizedJob } | { ok: false; reason: string };
/** Normalize one Towbook /api/calls array item (the raw JSON object) into a
 *  dispatch job. Field names are read DIRECTLY from the real call object
 *  (id/callNumber, status, account.company, vehicle, addresses, notes…) and the
 *  whole object is kept as raw_json for reconciliation. Returns ok:false with a
 *  human reason when the call must be skipped (no id, or an unmapped status id —
 *  unknown status ids are NEVER imported). */
export function normalizeJsonCall(call: Record<string, unknown>, sourceUrl: string): JsonCallResult {
  const idRaw = call.id ?? call.callNumber;
  if (idRaw == null) return { ok: false, reason: "no id/status" };
  const towbookJobId = String(idRaw).trim();
  if (!towbookJobId) return { ok: false, reason: "no id/status" };
  const statusId = extractTowbookStatusId(call.status) ?? callLevelStatusId(call);
  const status = statusId == null ? null : TOWBOOK_STATUS_ID_TO_LIFECYCLE[statusId] ?? null;
  if (statusId == null || !status) {
    return { ok: false, reason: `unmapped status ${stringifyStatus(call.status)} (statusId=${statusId ?? "none"})` };
  }
  const customer =
    findText(call, ["account", "customer", "member", "caller", "client", "customerName", "memberName"], ["company", "name"]) ||
    `Towbook job ${towbookJobId}`;
  const phone = findText(call, ["phone", "customerPhone", "callerPhone", "mobile", "telephone", "account", "accountPhone"], ["phone", "mobile", "telephone"]);
  const pickup = findText(call, ["pickup", "pickupAddress", "fromAddress", "origin", "source", "address"], ["street", "address", "city", "state", "zip", "postalCode"]);
  const dropoff = findText(call, ["dropoff", "dropoffAddress", "toAddress", "destination", "dest"], ["street", "address", "city", "state", "zip", "postalCode"]);
  // call.type is a numeric enum we do not know yet — derive service from TEXT only.
  const serviceText = findText(call, ["service", "serviceType", "workType", "jobType", "serviceDescription", "category", "reason"], ["name", "label", "description"]);
  const note = pickString(call, "notes", "note", "comment", "comments", "instructions");
  const dateTxt = pickString(call, "createdAt", "created", "createdOn", "date", "openDate", "receivedAt", "startTime", "createdDate");
  const parsed = dateTxt ? Date.parse(dateTxt) : NaN;
  return {
    ok: true,
    job: {
      towbookJobId,
      customer,
      phone,
      vehicle: vehicleText(call.vehicle),
      pickup,
      dropoff,
      status,
      towbookStatus: String(statusId),
      serviceType: mapTowbookService(serviceText || ""),
      createdAt: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
      note,
      raw: { sourceUrl, ...call },
    },
  };
}

/** Keys that are large and not needed for a status-id decision; dropped first when
 *  a raw call object must be trimmed to the per-shape byte cap. */
const SAMPLE_DROP_FIRST: readonly string[] = [
  "invoiceItems", "invoiceTax", "invoiceTotal", "invoiceSubtotal", "balanceByClass",
  "statements", "contacts", "insights", "payments", "paymentsApplied", "channels",
  "assets", "groups", "tags", "attributes", "notes",
];
/** If the object is still over the cap after SAMPLE_DROP_FIRST, fall back to this
 *  diagnostic allowlist — everything needed to resolve a status id's meaning
 *  (status, statuses history, timestamps, availableActions, account, waypoints). */
const SAMPLE_ALLOWLIST: readonly string[] = [
  "id", "callNumber", "status", "statuses", "createDate", "dispatchTime", "enrouteTime",
  "arrivalTime", "completionTime", "cancelledAt", "canceledAt", "voidedAt", "closedAt",
  "availableActions", "account", "waypoints", "reason", "callType", "towSource",
  "sourceUrl", "referenceUrl", "impound", "owner", "priority", "purchaseOrderNumber",
  "version", "companyId", "type", "tags", "notes", "arrivalETA", "balanceDue",
  "invoiceStatusId", "invoiceNumber",
];

/** Cap a raw call object so its JSON form stays under ~perObjectCapBytes while
 *  keeping the fields needed to interpret its status id. Always returns a plain
 *  object (never a string, never undefined) so the value round-trips through JSONB. */
export function trimRawCall(call: Record<string, unknown>, perObjectCapBytes = 6000): Record<string, unknown> {
  const fits = (o: Record<string, unknown>): boolean => {
    try { return JSON.stringify(o).length <= perObjectCapBytes; } catch { return false; }
  };
  if (fits(call)) return call;
  const slim: Record<string, unknown> = { ...call };
  for (const k of SAMPLE_DROP_FIRST) {
    if (k in slim) delete slim[k];
    if (fits(slim)) return slim;
  }
  const allow: Record<string, unknown> = {};
  for (const k of SAMPLE_ALLOWLIST) if (call[k] !== undefined) allow[k] = call[k];
  if (fits(allow)) return allow;
  const core: Record<string, unknown> = {};
  for (const k of ["id", "callNumber", "status", "statuses", "createDate"]) if (call[k] !== undefined) core[k] = call[k];
  return core; // tiny by construction — always under the cap
}

/** Best-effort "newness" score for a call — used to prefer the newest call per
 *  status shape in sampleByStatus. Real calls carry createDate (ISO timestamp);
 *  higher numeric ids are newer in Towbook, so the id is the fallback key. */
const callFreshness = (call: Record<string, unknown>): number => {
  for (const k of ["createDate", "createdAt", "updatedAt", "arrivalTime", "completionTime", "dispatchTime", "enrouteTime"]) {
    const v = call[k];
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  const id = Number(call.id ?? call.callNumber);
  return Number.isFinite(id) ? id : 0;
};

/** Self-documenting capture for the next sync run — DB-only (persisted to
 *  towbook_sessions.last_result by persistSyncResult), never rendered in the UI:
 *  - sample: the first 2 raw call objects (JSONB array; each object trimmed to
 *    ~perObjectCapBytes) — a small, always-parseable window into the payload.
 *  - statusShapes: deduped raw status VALUES seen across all calls (cap shapeCap),
 *    in arrival order — what the status field looks like at rest.
 *  - sampleByStatus: one full raw call object per distinct status id
 *    ({ [statusId]: callObject }, newest call preferred per shape, each trimmed
 *    to ~perObjectCapBytes) — enough to decide the MEANING of every status id
 *    (including 255) in one read: its statuses history, timestamps,
 *    availableActions, account, waypoints. Values are plain objects, so the
 *    JSONB round-trips natively.
 * Every field is guaranteed a real value (never undefined, never the string
 * "undefined") — the 2026-08-10 bug stored a coerced serialization of undefined
 * as the literal string "undefined", which this shape makes impossible. */
export function buildTowbookSample(calls: Record<string, unknown>[], perObjectCapBytes = 6000, shapeCap = 20): { sample: Record<string, unknown>[]; statusShapes: string[]; sampleByStatus: Record<string, Record<string, unknown>> } {
  const sample: Record<string, unknown>[] = [];
  const statusShapes: string[] = [];
  const sampleByStatus: Record<string, Record<string, unknown>> = {};
  for (const c of calls) {
    const s = stringifyStatus(c.status);
    if (!s) continue;
    if (!statusShapes.includes(s)) statusShapes.push(s);
    if (statusShapes.length >= shapeCap) break;
  }
  for (const c of calls.slice(0, 2)) sample.push(trimRawCall(c, perObjectCapBytes));
  const newestFirst = [...calls].sort((a, b) => callFreshness(b) - callFreshness(a));
  const shapeKeys = new Set<string>();
  for (const c of newestFirst) {
    const sid = extractTowbookStatusId(c.status) ?? callLevelStatusId(c);
    if (sid == null) continue;
    const key = String(sid);
    if (sampleByStatus[key] !== undefined) continue; // newest already captured
    sampleByStatus[key] = trimRawCall(c, perObjectCapBytes);
    shapeKeys.add(key);
    if (shapeKeys.size >= shapeCap) break;
  }
  return { sample, statusShapes, sampleByStatus };
}

/* -------------------------------- normalization -------------------------------- */

type NormalizedJob = {
  towbookJobId: string;
  customer: string;
  phone: string;
  vehicle: string;
  pickup: string;
  dropoff: string;
  status: JobStatus;
  towbookStatus: string;
  serviceType: ServiceType;
  createdAt: string;
  note: string;
  raw: Record<string, unknown>;
};
export function normalizeRawJob(rec: RawJob, sourceUrl: string): NormalizedJob | null {
  const towbookJobId = (rec.id || "").trim();
  if (!towbookJobId) return null;
  const towbookStatus = (rec.status || "").trim() || "unknown";
  const status = mapTowbookStatus(towbookStatus);
  if (!status) return null; // unmapped → skip; caller records it as failed w/ diagnostics
  const pickup = (rec.pickup || "").trim();
  const dateTxt = (rec.date || "").trim();
  const parsed = dateTxt ? Date.parse(dateTxt) : NaN;
  return {
    towbookJobId,
    customer: (rec.customer || "").trim() || `Towbook job ${towbookJobId}`,
    phone: (rec.phone || "").trim(),
    vehicle: (rec.vehicle || "").trim(),
    pickup,
    dropoff: (rec.dropoff || "").trim(),
    status,
    towbookStatus,
    serviceType: mapTowbookService(rec.service || ""),
    createdAt: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
    note: (rec.note || "").trim(),
    raw: { sourceUrl, ...rec },
  };
}

/* ------------------------------ self-discovering fetch ------------------------------ */

async function discoverJobPages(cookieJar: string, baseUrl: string): Promise<{ diagnostics: TowbookSyncDiag[]; pages: { url: string; body: string; contentType: string | null }[]; sessionExpired: boolean }> {
  const diagnostics: TowbookSyncDiag[] = [];
  const pages: { url: string; body: string; contentType: string | null }[] = [];
  let sessionExpired = false;
  const origin = new URL(baseUrl).origin;
  for (const path of TOWBOOK_JOB_PATHS) {
    if (sessionExpired) break; // don't hammer a dead session
    const url = origin + path;
    try {
      const res = await fetch(url, { headers: towbookBrowserHeaders(cookieJar), redirect: "manual", signal: AbortSignal.timeout(12000) });
      const text = await res.text();
      const ct = res.headers.get("content-type");
      diagnostics.push({ url, status: res.status, contentType: ct, hint: pageHint(text, ct) });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (loc) {
          const target = new URL(loc, origin);
          if (target.origin === origin) {
            const r2 = await fetch(target.toString(), { headers: towbookBrowserHeaders(cookieJar), redirect: "manual", signal: AbortSignal.timeout(12000) });
            const t2 = await r2.text();
            const ct2 = r2.headers.get("content-type");
            diagnostics.push({ url: target.toString(), status: r2.status, contentType: ct2, hint: pageHint(t2, ct2) });
            if (isLoginPage(t2) || isLoginRedirect(r2.headers.get("location"))) { sessionExpired = true; break; }
            if (r2.status === 200) pages.push({ url: target.toString(), body: t2, contentType: ct2 });
          }
        }
      } else if (res.status === 200) {
        if (isLoginPage(text)) { sessionExpired = true; break; }
        pages.push({ url, body: text, contentType: ct });
      }
    } catch (err) {
      diagnostics.push({ url, status: null, contentType: null, hint: String(err).slice(0, 80) });
    }
  }
  return { diagnostics, pages, sessionExpired };
}

/* ----------------------------------- upsert ----------------------------------- */

/** Org's "system actor" for background attribution (AI dispatcher + sync):
 *  the org's first owner. */
export async function resolveOrgActor(orgId: string): Promise<{ id: string; role: AuthUser["role"] } | null> {
  const rows = await sql()`SELECT user_id, role FROM organization_memberships WHERE org_id=${orgId} ORDER BY (role='owner') DESC, role LIMIT 1`;
  if (!rows.length) return null;
  return { id: String(rows[0].user_id), role: String(rows[0].role) as AuthUser["role"] };
}

/** Best-effort previous lifecycle state for an IMPORT's status_event, derived
 *  from the call's own statuses field when that field is the call's JOURNEY
 *  rather than its expected workflow.
 *
 *  For in-chain statuses (0..5) the statuses array is the call's ALLOWED
 *  workflow — a first-seen status-0 call carries [0,1,2,3,4,5] without having
 *  passed through any of them, so the event stays import→<current>.
 *
 *  Only when the current status is OUTSIDE the chain — the 255=cancelled case —
 *  is the chain the journey the call actually took ([0,1,2,3,4,5] then 255), so
 *  the previous lifecycle state is its last mapped step: completed→cancelled
 *  instead of import→cancelled. Falls back to 'import' when there is no chain
 *  or no mapped step.
 *
 *  Guard: when the derived previous EQUALS the mapped current (possible once 252
 *  maps to the same lifecycle state as an in-chain id — e.g. a 252 call whose
 *  statuses history is [0,252], or any out-of-chain id sharing a state with the
 *  chain's last step), fall back to import→<current>. A first-seen job must
 *  never write a spurious completed→completed (or cancelled→cancelled) event. */
export function previousStatusFromHistory(raw: Record<string, unknown>, current: JobStatus): JobStatus | "import" {
  const statuses = Array.isArray(raw.statuses) ? (raw.statuses as unknown[]) : [];
  const chainIds: number[] = [];
  for (const s of statuses) {
    const n = numericStatusId(s);
    if (n != null) chainIds.push(n);
  }
  if (!chainIds.length) return "import";
  const currentId = (Object.entries(TOWBOOK_STATUS_ID_TO_LIFECYCLE) as [string, JobStatus][]).find(([, s]) => s === current)?.[0];
  if (currentId != null && chainIds.some((n) => String(n) === currentId)) return "import";
  let prev: JobStatus | null = null;
  for (const n of chainIds) {
    const mapped = TOWBOOK_STATUS_ID_TO_LIFECYCLE[n];
    if (mapped) prev = mapped;
  }
  if (prev === current) return "import";
  return prev ?? "import";
}

/** Org-scoped upsert of normalized Towbook jobs (exported for the fixture test;
 *  INSERT first-seen ids, UPDATE re-synced ids in place — never duplicates).
 *
 *  TRANSITION POLICY (deliberate, 2026-08-10): the UPDATE path applies ANY
 *  status change Towbook reports — including between terminal states (e.g.
 *  255=cancelled → 252=completed, or completed → cancelled). Towbook is the
 *  system of record for customer/billing records, and its statuses flip-flop
 *  (reopen/acknowledge); the sync MUST be able to correct an imported status, so
 *  sync-driven terminal→terminal transitions are allowed and always fire a
 *  status_events transition + audit row (human-driven commands still enforce
 *  their own stricter state machine elsewhere). */
export async function upsertPulledJobs(
  orgId: string,
  actor: { id: string; role: AuthUser["role"] },
  jobs: NormalizedJob[],
  trigger: string,
): Promise<{ added: number; updated: number; unchanged: number; failed: number }> {
  const q = sql();
  // NOTE: towbook_job_id MUST be in the select list — it is the existing-map key.
  // (Bug fixed 2026-08-10: it was omitted, so every row was keyed "undefined" and
  // re-syncs re-INSERTed → pkey violation → all counted as failed.)
  const existingRows = await q`SELECT id, status, customer_name, phone, pickup, dropoff, towbook_status, towbook_job_id FROM dispatch_jobs WHERE org_id=${orgId} AND towbook_job_id IS NOT NULL`;
  const existing = new Map(existingRows.map((r) => [String(r.towbook_job_id), r as Record<string, unknown>]));
  let added = 0, updated = 0, unchanged = 0, failed = 0;
  for (const job of jobs) {
    const cur = existing.get(job.towbookJobId);
    try {
      if (!cur) {
        const slug = job.towbookJobId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
        const jobId = slug ? `tb-${slug}` : `tb-${Math.random().toString(36).slice(2, 10)}`;
        await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, customer_phone, vehicle_desc, pickup, dropoff, towbook_status, raw_json)
          VALUES(${jobId}, ${orgId}, ${job.customer}, ${job.phone || ""}, 0, 0, ${job.pickup || "Unknown"}, ${job.serviceType}, ${job.status}, ${job.createdAt}, ${job.note}, ${job.towbookJobId}, ${job.phone || ""}, ${job.vehicle}, ${job.pickup}, ${job.dropoff}, ${job.towbookStatus}, ${JSON.stringify(job.raw)}::jsonb)`;
        await q`INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
          SELECT gen_random_uuid()::text, ${orgId}, ${jobId}, ${previousStatusFromHistory(job.raw, job.status)}, ${job.status}, ${actor.id}, ${actor.role}, ${`imported from Towbook (${trigger})`}`;
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${orgId}, ${actor.id}, ${actor.role}, 'towbook_import', 'job', ${jobId}, ${JSON.stringify({ towbookJobId: job.towbookJobId, towbookStatus: job.towbookStatus, status: job.status, source: job.raw.sourceUrl })}::jsonb, ${trigger}`;
        existing.set(job.towbookJobId, { id: jobId, status: job.status, customer_name: job.customer, phone: job.phone, pickup: job.pickup, dropoff: job.dropoff, towbook_status: job.towbookStatus });
        added++;
      } else {
        const statusChanged = String(cur.status) !== job.status;
        const fieldsChanged =
          String(cur.customer_name ?? "") !== job.customer ||
          String(cur.phone ?? "") !== (job.phone || "") ||
          String(cur.pickup ?? "") !== job.pickup ||
          String(cur.dropoff ?? "") !== job.dropoff ||
          String(cur.towbook_status ?? "") !== job.towbookStatus;
        if (!statusChanged && !fieldsChanged) { unchanged++; continue; } // already current — no churn
        await q`UPDATE dispatch_jobs SET customer_name=${job.customer}, phone=${job.phone || ""}, area=${job.pickup || "Unknown"}, service_type=${job.serviceType}, status=${job.status}, note=${job.note}, towbook_status=${job.towbookStatus}, customer_phone=${job.phone || ""}, vehicle_desc=${job.vehicle}, pickup=${job.pickup}, dropoff=${job.dropoff}, raw_json=${JSON.stringify(job.raw)}::jsonb,
          completed_at=CASE WHEN ${job.status}='completed' AND completed_at IS NULL THEN NOW() ELSE completed_at END,
          assigned_at=CASE WHEN ${job.status}='offered' AND assigned_at IS NULL THEN NOW() ELSE assigned_at END
          WHERE id=${String(cur.id)} AND org_id=${orgId}`;
        if (statusChanged) {
          await q`INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
            SELECT gen_random_uuid()::text, ${orgId}, ${String(cur.id)}, ${String(cur.status)}, ${job.status}, ${actor.id}, ${actor.role}, ${`status change from Towbook (${trigger})`}`;
          await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
            SELECT gen_random_uuid()::text, ${orgId}, ${actor.id}, ${actor.role}, 'towbook_status_change', 'job', ${String(cur.id)}, ${JSON.stringify({ towbookJobId: job.towbookJobId, from: String(cur.status), to: job.status, towbookStatus: job.towbookStatus })}::jsonb, ${trigger}`;
        }
        existing.set(job.towbookJobId, { ...cur, status: job.status, customer_name: job.customer, phone: job.phone, pickup: job.pickup, dropoff: job.dropoff, towbook_status: job.towbookStatus });
        updated++;
      }
    } catch {
      failed++;
    }
  }
  return { added, updated, unchanged, failed };
}

/* ----------------------------------- core sync ----------------------------------- */

async function doSyncForOrg(orgId: string, trigger: string, actorHint?: { id: string; role: AuthUser["role"] }): Promise<TowbookSyncResult> {
  const q = sql();
  const sess = await q`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${orgId}`;
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
    await q`UPDATE towbook_sessions SET last_sync_at=NOW() WHERE org_id=${orgId}`;
    return syncResult("session_expired", "The Towbook session expired or was rejected — reconnect Towbook in Settings.", { diagnostics });
  }
  if (!pages.length) {
    await q`UPDATE towbook_sessions SET last_sync_at=NOW() WHERE org_id=${orgId}`;
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
    await q`UPDATE towbook_sessions SET last_sync_at=NOW() WHERE org_id=${orgId}`;
    return syncResult("error", "No organization member found to attribute the import to — add an owner to this organization.", { diagnostics });
  }
  const res = await upsertPulledJobs(orgId, actor, normalized, trigger);
  await q`UPDATE towbook_sessions SET last_sync_at=NOW() WHERE org_id=${orgId}`;
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
    await sql()`UPDATE towbook_sessions SET last_result=${JSON.stringify(JSON.parse(JSON.stringify(payload)))}::jsonb WHERE org_id=${orgId}`;
  } catch { /* never mask the sync result with a diagnostics-write failure */ }
}

function syncForOrg(orgId: string, trigger: string, actor?: { id: string; role: AuthUser["role"] }): Promise<TowbookSyncResult> {
  const running = syncInFlight.get(orgId);
  if (running) return running;
  const p = doSyncForOrg(orgId, trigger, actor).then(async (r) => { await persistSyncResult(orgId, r); return r; }).finally(() => { syncInFlight.delete(orgId); });
  syncInFlight.set(orgId, p);
  return p;
}

/** Pull-on-read trigger: fire-and-forget refresh when the org's session is connected
 *  and the last sync is older than ~30s (replication tightened 60s→30s per
 *  owner direction: "whatever happens on Towbook should replicate on the portal").
 *  Never throws — the read must never fail. */
async function maybeAutoSync(orgId: string): Promise<void> {
  try {
    if (!configured()) return;
    const rows = await sql()`SELECT last_sync_at FROM towbook_sessions WHERE org_id=${orgId} AND status='connected' AND encrypted_session <> ''`;
    if (!rows.length) return;
    const last = rows[0].last_sync_at ? new Date(String(rows[0].last_sync_at)).getTime() : 0;
    if (Date.now() - last > 30_000) void syncForOrg(orgId, "sync:pull-on-read");
  } catch { /* best-effort — never fail the read */ }
}

/** Background interval (lives inside the served bundle's process, which is the same
 *  process that hosts the port-3000 server — serve.ts only wraps the built handler).
 *  Every 30s, sync every connected org whose last sync is stale, then run the AI
 *  dispatcher for that org (auto-accept in-zone offers; gated on
 *  ai_dispatcher_enabled in the engine itself); the per-org in-flight guard
 *  prevents overlap. */
let backgroundSyncStarted = false;
function startBackgroundSync() {
  if (backgroundSyncStarted) return;
  backgroundSyncStarted = true;
  const timer = globalThis.setInterval(() => {
    void (async () => {
      try {
        if (!configured()) return;
        const rows = await sql()`SELECT org_id FROM towbook_sessions WHERE status='connected' AND encrypted_session <> '' AND (last_sync_at IS NULL OR last_sync_at < NOW() - INTERVAL '30 seconds')`;
        for (const r of rows) {
          const orgId = String(r.org_id);
          void (async () => {
            try {
              await syncForOrg(orgId, "sync:interval");
              // Adapter: AI-dispatcher deps type the actor role loosely (string);
              // syncForOrg expects the narrow AuthUser role union — cast is safe
              // because every actor passed here comes from resolveOrgActor.
              await runAutoDispatch(orgId, {
                syncForOrg: (oid: string, trigger: string, actor?: { id: string; role: string }) =>
                  syncForOrg(oid, trigger, actor as { id: string; role: AuthUser["role"] } | undefined),
                resolveOrgActor,
              });
            } catch { /* best-effort — one org's failure never stops the loop */ }
          })();
        }
      } catch { /* best-effort */ }
    })();
  }, 30_000);
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}

export const towbookSyncNow = createServerFn({ method: "POST" }).handler(async () => {
  if (!configured()) return syncResult("error", "Towbook sync requires database mode.");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return syncResult("unauthorized", "Sign in required.");
  if (!can(u, ["owner", "admin"])) return syncResult("unauthorized", "Only owners and admins can sync Towbook.");
  await prepare();
  return syncForOrg(u.orgId, "sync:manual", { id: u.id, role: u.role });
});
