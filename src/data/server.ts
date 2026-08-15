import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { sql, sqlWithTimeout } from "~/db";
import { encryptSession } from "./towbook-key";
import { towbookDetail, towbookLogin, TOWBOOK_ORIGIN, type TowbookFacts } from "./towbook-login";
import { getOrgSettings, etaProviderStatus } from "./ai-dispatcher";
import type { AuthUser } from "./auth-server";
import type { LiveMapData } from "./live-map-core";
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
    // The 3s background loop (Towbook sync + auto-dispatch) is NOT started here
    // on purpose: it lives in the server-only src/data/background-sync.ts and is
    // started at server boot by serve.ts. A dynamic import here would pull that
    // module into the client bundle (its chain: ai-dispatcher → node:crypto,
    // syncForOrg → towbook-recovery → node:fs) — client-graph leak. Boot start
    // covers the running system; tests call the loop's pieces directly.
  })();
  return schemaInit;
}

// The production handler is imported when the server boots. Running initialization
// here fixes the old request-only wiring while the handler-level awaits remain a
// fallback for runtimes that load modules lazily.

function mapJob(r: Record<string,unknown>): Job { return {id:String(r.id),...(r.towbook_job_id != null && String(r.towbook_job_id) !== "" ? {towbookJobId:String(r.towbook_job_id)} : {}),customerName:String(r.customer_name),phone:String(r.phone),location:{lat:Number(r.lat),lng:Number(r.lng),area:String(r.area)},serviceType:r.service_type as Job["serviceType"],status:r.status as JobStatus,createdAt:new Date(String(r.created_at)).toISOString(),assignedAt:r.assigned_at?new Date(String(r.assigned_at)).toISOString():undefined,arrivedAt:r.arrived_at?new Date(String(r.arrived_at)).toISOString():undefined,completedAt:r.completed_at?new Date(String(r.completed_at)).toISOString():undefined,assignedContractorId:r.assigned_contractor_id?String(r.assigned_contractor_id):undefined,assignedDriverName:r.assigned_driver_name?String(r.assigned_driver_name):undefined,assignedDriverTowbookId:r.assigned_driver_towbook_id?String(r.assigned_driver_towbook_id):undefined,note:String(r.note||"")}; }

/** The org's ACTIVE roster for the dispatch surface — ANY active org user
 *  (deactivated_at IS NULL) with a non-null towbook_driver_id, regardless of
 *  membership role: role 'contractor' always qualifies; owner/admin/dispatcher
 *  roles qualify ONLY when they carry a Towbook driver id (so the owner's own
 *  driver-linked account — e.g. "Ai Dispatch GB", owner-directed 2026-08-12 —
 *  appears on the map / drivers list / dispatch console / AI-dispatcher
 *  candidate pool, while pure owner/admin logins like lightroad29@gmail.com
 *  NEVER appear). The Contractors tab (listContractorsCore) stays
 *  contractors-only. The legacy dispatch_contractors table is NEVER read: it
 *  is empty for every real org (BUG 1 root cause 2026-08-11 — it made the
 *  owner dashboard read "Contractors online 0/0", the Performance tab show 0
 *  contractors, and the dispatch console crash on an undefined
 *  recommendation).
 *
 *  Derived fields (one query, real data only):
 *  - status: 'online' when the contractor has ANY live signal — a stored
 *    per-driver Towbook session (session_kind='driver' keyed by
 *    towbook_driver_id; includes the OWNER-kind session when it is linked to
 *    their driver id, so the owner's own roster row reads online while they use
 *    the portal) or a live LD portal session (sessions.expires_at > NOW()) —
 *    the same definition listContractorsCore uses for "signed in".
 *  - location: the latest GPS ping (0,0 until the driver's first ping).
 *  - completedJobCount: real completed jobs assigned to them, by Towbook driver
 *    id (the AI dispatcher / Towbook assignment) or the legacy contractor link.
 *  Exported for the hermetic roster-source test. */
export async function listRosterContractors(orgId: string, contractorId?: string): Promise<Contractor[]> {
  const q = sql();
  const rows = await q`
    SELECT u.id, u.name, u.towbook_driver_id,
      ts.session_updated_at, ls.last_login,
      dl.latitude, dl.longitude,
      (SELECT COUNT(*)::int FROM dispatch_jobs j
        WHERE j.org_id=${orgId} AND j.status='completed'
          AND ((u.towbook_driver_id IS NOT NULL AND j.assigned_driver_towbook_id = u.towbook_driver_id)
               OR j.assigned_contractor_id = u.id)) AS completed_job_count
    FROM users u
    LEFT JOIN LATERAL (
      SELECT MAX(heartbeat_at) AS session_updated_at FROM driver_availability_log ts
      WHERE ts.org_id = ${orgId} AND ts.user_id = u.id
        AND ts.session_started_at IS NOT NULL
        AND ts.heartbeat_at > NOW() - INTERVAL '90 seconds'
    ) ts ON TRUE
    LEFT JOIN LATERAL (
      SELECT MAX(created_at) AS last_login FROM sessions s
      WHERE s.user_id = u.id AND s.expires_at > NOW()
    ) ls ON TRUE
    LEFT JOIN LATERAL (
      SELECT latitude, longitude FROM driver_locations dl
      WHERE dl.org_id = ${orgId} AND dl.driver_id = u.id
      ORDER BY captured_at DESC LIMIT 1
    ) dl ON TRUE
    WHERE u.deactivated_at IS NULL
      AND EXISTS (
        SELECT 1 FROM organization_memberships m
        WHERE m.user_id = u.id AND m.org_id = ${orgId}
          AND (m.role = 'contractor' OR (m.role IN ('owner','admin','dispatcher') AND u.towbook_driver_id IS NOT NULL))
      )
    ${contractorId ? q`AND u.id = ${contractorId}` : q``}
    ORDER BY LOWER(u.name), u.created_at`;
  return (rows as Record<string, unknown>[]).map((r) => {
    const sessionAt = r.session_updated_at != null ? new Date(String(r.session_updated_at)).getTime() : null;
    const loginAt = r.last_login != null ? new Date(String(r.last_login)).getTime() : null;
    return {
      id: String(r.id),
      name: String(r.name ?? ""),
      status: (sessionAt != null || loginAt != null ? "online" : "offline") as ContractorStatus,
      location: { lat: r.latitude != null ? Number(r.latitude) : 0, lng: r.longitude != null ? Number(r.longitude) : 0, area: "" },
      vehicleTypes: [],
      rating: 0,
      completedJobCount: Number(r.completed_job_count ?? 0),
      responseTimeHistoryMinutes: [],
    };
  });
}

/** Derived availability for one roster contractor — the same definition as
 *  listRosterContractors (any live session signal). Private; used by assignJob
 *  so the "offline_contractor" guard reads the REAL roster, never the empty
 *  legacy dispatch_contractors table. */
async function contractorOnline(orgId: string, userId: string): Promise<boolean> {
  const q = sql();
  const rows = await q`SELECT COUNT(*)::int AS active
    FROM driver_availability_log
    WHERE org_id=${orgId} AND user_id=${userId}
      AND session_started_at IS NOT NULL
      AND heartbeat_at > NOW() - INTERVAL '90 seconds'`;
  return Number((rows[0] as Record<string, unknown>).active ?? 0) > 0;
}

async function dataFor(u: AuthUser): Promise<DispatchData> { const cs=await listRosterContractors(u.orgId, u.role==="contractor" ? u.contractorId || undefined : undefined); const q=sql(); const js=await q`SELECT id,towbook_job_id,customer_name,phone,lat,lng,area,service_type,status,created_at,assigned_at,arrived_at,completed_at,assigned_contractor_id,assigned_driver_name,assigned_driver_towbook_id,note FROM dispatch_jobs WHERE org_id=${u.orgId} ${u.role==="contractor" ? q`AND (assigned_contractor_id=${u.contractorId||""} OR assigned_driver_towbook_id=(SELECT towbook_driver_id FROM users WHERE id=${u.contractorId||""}))` : q``} ORDER BY created_at DESC`; return {contractors:cs,jobs:js.map(mapJob)}; }
async function result(u: AuthUser): Promise<CommandResult> { return {ok:true,data:await dataFor(u)}; }
function can(u:AuthUser, roles:AuthUser["role"][]) { return roles.includes(u.role); }
/** Portal → Towbook push for owner/admin/dispatcher job status changes
 *  (bidirectional sync, owner-directed 2026-08-11): after the local transition
 *  commits, mirror it to Towbook via PUT /api/calls/{callId} (status-push-core).
 *  Never throws and never fails the command — the push is idempotent
 *  (GET-first no-op), refuses to clobber a newer Towbook status, retries once,
 *  verifies the write, and escalates to ops "Needs attention" on failure. */
async function pushJobStatus(orgId: string, jobId: string, actor: { id: string; role: AuthUser["role"] }) {
  try {
    const { pushJobStatusToTowbook } = await import("./status-push-core");
    return await pushJobStatusToTowbook({ orgId, jobId, actor: { id: actor.id, role: actor.role } });
  } catch (err) {
    return { ok: false as const, code: "error" as const, message: err instanceof Error ? err.message : "Towbook write failed.", escalated: true };
  }
}
const towbookStatusFailure = () => fail("database_unavailable", "Towbook did not acknowledge this status change. Local status was not committed; retry.");
async function rollbackJob(jobId: string, orgId: string, prior: Record<string, unknown>) {
  const q = sql();
  await q`UPDATE dispatch_jobs SET status=${String(prior.status)}, assigned_contractor_id=${prior.assigned_contractor_id ?? null}, assigned_driver_name=${prior.assigned_driver_name ?? null}, assigned_driver_towbook_id=${prior.assigned_driver_towbook_id ?? null}, assigned_at=${prior.assigned_at ?? null}, arrived_at=${prior.arrived_at ?? null}, completed_at=${prior.completed_at ?? null}, duration_seconds=${prior.duration_seconds ?? null} WHERE id=${jobId} AND org_id=${orgId}`;
}

export const getDispatchData=createServerFn({method:"GET"}).handler(async()=>{ if(!configured())return {mode:"unavailable" as const,data:{contractors:[],jobs:[]},error:{code:"database_unavailable" as const,message:"Database is not configured."}}; const { currentUser } = await import("./auth-server"); const u=await currentUser(); if(!u)return {mode:"database" as const,data:{contractors:[],jobs:[]},error:{code:"unauthorized" as const,message:"Sign in required."}}; try {await prepare(); const { maybeAutoSync } = await import("./sync-engine"); void maybeAutoSync(u.orgId); return {mode:"database" as const,data:await dataFor(u)};} catch { return {mode:"database" as const,data:{contractors:[],jobs:[]},error:{code:"database_unavailable" as const,message:"Database unavailable."}};} });

export const assignJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id,contractorId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — assign works in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");if(!can(u,["owner","admin","dispatcher"]))return fail("unauthorized","You cannot assign jobs.");try{await prepare();const q=sql();const con=(data as {contractorId:string}).contractorId;const c=await q`SELECT u.name,u.towbook_driver_id FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${u.orgId} AND m.role='contractor' WHERE u.id=${con} AND u.deactivated_at IS NULL LIMIT 1`;if(!c.length)return fail("not_found","Contractor not found.");if(!(await contractorOnline(u.orgId,con)))return fail("offline_contractor","Contractor is offline.");const job=(data as {jobId:string}).jobId, actor=u.id;const priorRows=await q`SELECT status,assigned_contractor_id,assigned_driver_name,assigned_driver_towbook_id,assigned_at,arrived_at,completed_at,duration_seconds FROM dispatch_jobs WHERE id=${job} AND org_id=${u.orgId}`;if(!priorRows.length)return fail("not_found","Job not found.");const prior=priorRows[0] as Record<string,unknown>;const tbId=c[0].towbook_driver_id!=null?String(c[0].towbook_driver_id):null;const rows=await q.transaction([q`WITH changed AS (UPDATE dispatch_jobs SET status='offered',assigned_contractor_id=NULL,assigned_driver_name=${String(c[0].name)},assigned_driver_towbook_id=${tbId},assigned_at=NOW() WHERE id=${job} AND org_id=${u.orgId} AND status='new' RETURNING id,org_id,'new'::text AS old_status,'offered'::text AS new_status) INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role) SELECT gen_random_uuid()::text,org_id,id,old_status,new_status,${actor},${u.role} FROM changed RETURNING job_id` ,q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${actor},${u.role},'assign','job',${job},jsonb_build_object('contractorId',${con}) WHERE EXISTS (SELECT 1 FROM status_events WHERE org_id=${u.orgId} AND job_id=${job} AND from_status='new' AND to_status='offered' AND actor_user_id=${actor})`]); if(!rows[0]?.length)return fail("conflict","Job is no longer available for assignment.");const push=await pushJobStatus(u.orgId,job,{id:u.id,role:u.role});if(!push.ok){await rollbackJob(job,u.orgId,prior);return towbookStatusFailure();}try{const{fireAssignmentPush}=await import("./push-core");void fireAssignmentPush(u.orgId,con,job);
    try { const { recordNudge } = await import("./nudge-reassign-core"); void recordNudge(u.orgId, job, String(tbId), "assignment", "manual_assign"); } catch {}}catch{/* push never fails the assignment */}return result(u);}catch{return unavailable("Unable to assign job.");}});

export const advanceJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — advancing works in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");try{await prepare();const job=(data as {jobId:string}).jobId;const priorRows=await sql()`SELECT status,assigned_contractor_id,assigned_driver_name,assigned_driver_towbook_id,assigned_at,arrived_at,completed_at,duration_seconds FROM dispatch_jobs WHERE id=${job} AND org_id=${u.orgId}`;if(!priorRows.length)return fail("not_found","Job not found.");const prior=priorRows[0] as Record<string,unknown>;const rows=await sql().transaction([sql() `WITH current AS (SELECT id,status FROM dispatch_jobs WHERE id=${job} AND org_id=${u.orgId}), changed AS (UPDATE dispatch_jobs j SET status=CASE j.status WHEN 'offered' THEN 'accepted' WHEN 'accepted' THEN 'en_route' WHEN 'en_route' THEN 'arrived' WHEN 'arrived' THEN 'completed' END,arrived_at=CASE WHEN j.status='en_route' THEN NOW() ELSE j.arrived_at END,completed_at=CASE WHEN j.status='arrived' THEN NOW() ELSE j.completed_at END,duration_seconds=CASE WHEN j.status='arrived' THEN EXTRACT(EPOCH FROM (NOW() - COALESCE(j.arrived_at, j.assigned_at)))::integer ELSE j.duration_seconds END FROM current c WHERE j.id=c.id AND ((${u.role} IN ('owner','admin','dispatcher')) OR (${u.role}='contractor' AND j.assigned_contractor_id=${u.contractorId||''})) AND j.status IN ('offered','accepted','en_route','arrived') RETURNING j.id,j.org_id,c.status AS old_status,j.status AS new_status) INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role) SELECT gen_random_uuid()::text,org_id,id,old_status,new_status,${u.id},${u.role} FROM changed RETURNING job_id` ,sql() `INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${u.id},${u.role},'advance','job',${job},'{}'::jsonb WHERE EXISTS (SELECT 1 FROM status_events WHERE org_id=${u.orgId} AND job_id=${job} AND actor_user_id=${u.id} AND to_status IN ('accepted','en_route','arrived','completed') ORDER BY occurred_at DESC LIMIT 1)`]);if(!rows[0]?.length)return fail("invalid_state","Job cannot be advanced from its current state or you are not allowed.");const push=await pushJobStatus(u.orgId,job,{id:u.id,role:u.role});if(!push.ok){await rollbackJob(job,u.orgId,prior);return towbookStatusFailure();}return result(u);}catch{return unavailable("Unable to advance job.");}});

export const declineJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id,contractorId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — declining works in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");if(!can(u,["owner","admin","dispatcher"]) && !(u.role==="contractor" && u.contractorId===(data as {contractorId:string}).contractorId))return fail("unauthorized","You cannot decline this offer.");try{await prepare();const d=data as {jobId:string;contractorId:string};const priorRows=await sql()`SELECT status,assigned_contractor_id,assigned_driver_name,assigned_driver_towbook_id,assigned_at,arrived_at,completed_at,duration_seconds FROM dispatch_jobs WHERE id=${d.jobId} AND org_id=${u.orgId}`;if(!priorRows.length)return fail("not_found","Job not found.");const prior=priorRows[0] as Record<string,unknown>;const rows=await sql().transaction([sql()`WITH changed AS (UPDATE dispatch_jobs SET status='new',assigned_contractor_id=NULL,assigned_driver_name=NULL,assigned_driver_towbook_id=NULL,assigned_at=NULL WHERE id=${d.jobId} AND org_id=${u.orgId} AND status='offered' AND assigned_contractor_id=${d.contractorId} RETURNING id,org_id,'offered'::text AS old_status,'new'::text AS new_status) INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role) SELECT gen_random_uuid()::text,org_id,id,old_status,new_status,${u.id},${u.role} FROM changed RETURNING job_id`,sql()`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${u.id},${u.role},'decline','job',${d.jobId},'{}'::jsonb WHERE EXISTS (SELECT 1 FROM status_events WHERE org_id=${u.orgId} AND job_id=${d.jobId} AND actor_user_id=${u.id} AND from_status='offered' AND to_status='new' ORDER BY occurred_at DESC LIMIT 1)`]);if(!rows[0]?.length)return fail("invalid_state","Only an offered job assigned to that contractor can be declined.");const push=await pushJobStatus(u.orgId,d.jobId,{id:u.id,role:u.role});if(!push.ok){await rollbackJob(d.jobId,u.orgId,prior);return towbookStatusFailure();}return result(u);}catch{return unavailable("Unable to decline job.");}});

/** OWNER-EDITABLE ASSIGNED DRIVER (owner-directed 2026-08-13): change which
 *  contractor is on a call, straight from the owner/ops portal. The heavy
 *  lifting lives in reassign-core (server-only): the PROVEN Towbook assign path
 *  (PUT /api/calls/{id} with the driver on the call's asset, preserving the
 *  call's current status), the dispatch_jobs update + manual-reassign marker
 *  (the AI dispatcher treats a human's latest assignment as authoritative), the
 *  audit_log row (occurred_at timestamp), and the notifyAssignedDriver push for
 *  the NEW driver (online + offline). Role-gated to owner/admin members ONLY —
 *  the contractor portal must never reassign (the UI hides the control; this
 *  refuses anyway). The core result maps to the standard CommandResult shape so
 *  the store rehydrates exactly like assignJob. */
export const reassignJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id,contractorId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — reassigning works in the live demo only.");const { currentUser } = await import("./auth-server"); const u=await currentUser();if(!u)return fail("unauthorized","Sign in required.");if(!can(u,["owner","admin"]))return fail("unauthorized","Only owners and admins can change a job's assigned driver.");try{await prepare();const d=data as {jobId:string;contractorId:string};const { reassignDriverCore } = await import("./reassign-core");const r=await reassignDriverCore({jobId:d.jobId,contractorId:d.contractorId,orgId:u.orgId,actor:{id:u.id,role:u.role}});if(!r.ok){const code=(r.code==="validation"||r.code==="unauthorized"||r.code==="not_found"||r.code==="conflict"||r.code==="invalid_state")?r.code:"invalid_state";return fail(code,r.message);}return result(u);}catch{return unavailable("Unable to reassign the job.");}});

export type StatusPushOutcome = { attempted: boolean; verified: boolean; skipped: boolean; reason: string | null };
/** Statuses the exact-status selector can set (owner/admin/dispatcher) — the
 *  full forward lifecycle minus "new" (unassigned — the queue's Assign owns
 *  that transition) and minus "cancelled" (import-only terminal; Towbook-side
 *  252/255/declines are never pushed from the portal). */
export const SETTABLE_JOB_STATUSES = ["offered", "accepted", "en_route", "arrived", "completed"] as const;
const SETTABLE_ORDER = new Map<string, number>(["offered", "accepted", "en_route", "arrived", "completed"].map((s, i) => [s, i]));
/** Pure transition guard for the exact-status selector (shared by the server fn,
 *  the store's demo-mode validation, and the UI): a job can only move FORWARD in
 *  the lifecycle, or stay put for a re-push/verify. Backward moves are refused
 *  because Towbook's last-write-wins guard (status-push-core: newer-status-wins)
 *  would silently skip the push and leave the sides diverged. "new" and
 *  "cancelled" are immovable via this surface. Client-safe + pure. */
export function canSetJobStatus(current: JobStatus, target: JobStatus): boolean {
  if (current === "cancelled") return false;
  if (current === "completed") return current === target;
  const ci = SETTABLE_ORDER.get(current);
  const ti = SETTABLE_ORDER.get(target);
  if (ci == null || ti == null) return false;
  return ti >= ci;
}

export const setJobStatus=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{
  const e=invalid(data,z.object({jobId:id,status:z.enum(SETTABLE_JOB_STATUSES)}).strict());
  if(e)return e;
  if(!configured())return unavailable("Database mode is not active — status changes work in the live demo only.");
  const { currentUser } = await import("./auth-server"); const u=await currentUser();
  if(!u)return fail("unauthorized","Sign in required.");
  if(!can(u,["owner","admin","dispatcher"]))return fail("unauthorized","You cannot change job status.");
  try{
    await prepare();
    const q=sql();
    const jobId=(data as {jobId:string}).jobId;
    const target=(data as {status:JobStatus}).status;
    const cur=await q`SELECT id,status FROM dispatch_jobs WHERE id=${jobId} AND org_id=${u.orgId} LIMIT 1`;
    if(!cur.length)return fail("not_found","Job not found.");
    const current=String(cur[0].status ?? "") as JobStatus;
    if(!canSetJobStatus(current,target))return fail("invalid_state",`This job is ${current} — it can only move forward in the lifecycle (or stay put).`);
    // EXACT status lands locally (dispatch_jobs + status_events + audit_log),
    // then the existing verified push path mirrors that exact status to Towbook.
    const rows=await q.transaction([q`WITH current AS (SELECT id,status FROM dispatch_jobs WHERE id=${jobId} AND org_id=${u.orgId}), changed AS (UPDATE dispatch_jobs j SET status=${target},arrived_at=CASE WHEN ${target}='arrived' AND j.arrived_at IS NULL THEN NOW() ELSE j.arrived_at END,completed_at=CASE WHEN ${target}='completed' AND j.completed_at IS NULL THEN NOW() ELSE j.completed_at END,duration_seconds=CASE WHEN ${target}='completed' AND j.completed_at IS NULL THEN EXTRACT(EPOCH FROM (NOW() - COALESCE(j.arrived_at, j.assigned_at)))::integer ELSE j.duration_seconds END FROM current c WHERE j.id=c.id AND j.status=c.status RETURNING j.id,j.org_id,c.status AS old_status,j.status AS new_status) INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role,note) SELECT gen_random_uuid()::text,org_id,id,old_status,new_status,${u.id},${u.role},${`exact status: ${current} → ${target} by ${u.role}`} FROM changed RETURNING job_id`,q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) SELECT gen_random_uuid()::text,${u.orgId},${u.id},${u.role},'set_status','job',${jobId},jsonb_build_object('from',${current}::text,'to',${target}::text) WHERE EXISTS (SELECT 1 FROM status_events WHERE org_id=${u.orgId} AND job_id=${jobId} AND actor_user_id=${u.id} AND to_status=${target} ORDER BY occurred_at DESC LIMIT 1)`]);
    if(!rows[0]?.length)return fail("invalid_state","The job changed status while saving — refresh and try again.");
    // Push the EXACT chosen status to Towbook via the same verified pipeline the
    // other commands use; the outcome is surfaced so the UI can confirm the sync.
    let push:StatusPushOutcome={attempted:false,verified:false,skipped:false,reason:null};
    try{
      const { pushJobStatusToTowbook } = await import("./status-push-core");
      const r=await pushJobStatusToTowbook({orgId:u.orgId,jobId,actor:{id:u.id,role:u.role}});
      if(r.ok)push={attempted:true,verified:r.changed||r.skipped,skipped:r.skipped,reason:r.reason};
      else push={attempted:true,verified:false,skipped:false,reason:r.message};
    }catch { push={attempted:true,verified:false,skipped:false,reason:"Towbook write failed."}; }
    if (!push.verified) {
      await q`UPDATE dispatch_jobs SET status=${current}, arrived_at=CASE WHEN ${current} IN ('offered','accepted','en_route') THEN NULL ELSE arrived_at END, completed_at=CASE WHEN ${current} <> 'completed' THEN NULL ELSE completed_at END WHERE id=${jobId} AND org_id=${u.orgId} AND status=${target}`;
      return fail("database_unavailable", `Towbook did not acknowledge this status change. Local status was not committed; retry.`);
    }
    return {ok:true as const,data:await dataFor(u),push};
  }catch{return unavailable("Unable to change job status.");}
});


export type StatusEvent = { jobId: string; fromStatus: string | null; toStatus: string; actorRole: string | null; note: string | null; occurredAt: string };
/** Org-scoped status timeline (real history only). Powers the history tab and
 *  the performance tab's avg time-to-complete. */
export const getStatusEvents=createServerFn({method:"GET"}).handler(async()=>{ if(!configured())return []; const { currentUser } = await import("./auth-server"); const u=await currentUser(); if(!u)return []; if(!can(u,["owner","admin","dispatcher"]))return []; try { await prepare(); const q=sql(); const rows=await q`SELECT job_id,from_status,to_status,actor_role,note,occurred_at FROM status_events WHERE org_id=${u.orgId} ORDER BY occurred_at DESC LIMIT 1000`; return rows.map((r: Record<string,unknown>)=>({jobId:String(r.job_id),fromStatus:r.from_status?String(r.from_status):null,toStatus:String(r.to_status),actorRole:r.actor_role?String(r.actor_role):null,note:r.note?String(r.note):null,occurredAt:new Date(String(r.occurred_at)).toISOString()})); } catch { return []; } });

const towbookFail = (code: "invalid_credentials"|"towbook_unreachable"|"towbook_blocked", message: string) => ({ok:false as const,error:{code,message}});
// --- Towbook session persistence ------------------------------------------
// The login ITSELF (page GET → token → form POST → redirect follow → cookie
// jar) lives in the shared towbook-login.ts helper — the SAME code path the
// driver portal uses (driver-auth.ts), so owner connect and driver login can
// never drift apart. These two functions persist/update the OWNER session row
// (session_kind='owner'); driver sessions are stored by driver-auth.ts.
async function persistTowbookSession(orgId: string, fullJar: string) {
  await prepare();
  await sql()`INSERT INTO towbook_sessions(org_id,encrypted_session,status,session_kind,error,updated_at) VALUES(${orgId},${await encryptSession(JSON.stringify({cookies:fullJar,baseUrl:TOWBOOK_ORIGIN}))},'connected','owner',NULL,NOW()) ON CONFLICT (org_id) WHERE session_kind='owner' DO UPDATE SET encrypted_session=EXCLUDED.encrypted_session,status='connected',error=NULL,updated_at=NOW()`;
}
async function persistTowbookFailure(orgId: string, f: TowbookFacts) {
  try {
    await prepare();
    await sql()`INSERT INTO towbook_sessions(org_id,encrypted_session,status,session_kind,error,updated_at) VALUES(${orgId},'','error','owner',${towbookDetail(f)},NOW()) ON CONFLICT (org_id) WHERE session_kind='owner' DO UPDATE SET status='error',error=EXCLUDED.error,updated_at=NOW(),encrypted_session=towbook_sessions.encrypted_session`;
  } catch { /* never mask the real connect result with a diagnostics-write failure */ }
}
export const towbookStatus=createServerFn({method:"GET"}).handler(async()=>{ if(!configured()) return {ok:true as const,connected:false,lastSyncAt:null,lastResult:null}; const {currentUser}=await import("./auth-server"); const u=await currentUser(); if(!u)return towbookFail("towbook_unreachable","Sign in required."); if(!can(u,["owner","admin"]))return towbookFail("towbook_blocked","You cannot view Towbook status."); try { await prepare(); const r=await sql()`SELECT status,last_sync_at,last_result FROM towbook_sessions WHERE org_id=${u.orgId} AND session_kind='owner'`; const row=r[0] as Record<string,unknown>|undefined; let lastResult: TowbookSyncResult | null = null; if(row?.last_result){ try { const p=row.last_result as Record<string,unknown>; lastResult={ok:String(p.code)==="ok",code:p.code as TowbookSyncCode,message:String(p.message??""),added:Number(p.added??0),updated:Number(p.updated??0),failed:Number(p.failed??0),diagnostics:Array.isArray(p.diagnostics)?p.diagnostics as TowbookSyncDiag[]:[],ranAt:String(p.ranAt??""),...(Array.isArray(p.sample)?{sample:p.sample as Record<string, unknown>[]}:{}),...(Array.isArray(p.statusShapes)?{statusShapes:p.statusShapes as string[]}:{}),...(p.sampleByStatus&&typeof p.sampleByStatus==="object"&&!Array.isArray(p.sampleByStatus)?{sampleByStatus:p.sampleByStatus as Record<string, Record<string, unknown>>}:{})}; } catch { lastResult=null; } } return {ok:true as const,connected:Boolean(row && row.status==='connected'),lastSyncAt:row&&row.last_sync_at?new Date(String(row.last_sync_at)).toISOString():null,lastResult}; } catch { return towbookFail("towbook_unreachable","Towbook status unavailable."); }});
export const connectTowbook=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{
  const e=invalid(data,z.object({username:z.string().min(1).max(256),password:z.string().min(1).max(256)}).strict());
  if(e)return e;
  if(!configured())return towbookFail("towbook_unreachable","Towbook connection requires database mode.");
  const {currentUser}=await import("./auth-server");
  const u=await currentUser();
  if(!u)return towbookFail("towbook_blocked","Sign in required.");
  if(!can(u,["owner","admin"]))return towbookFail("towbook_blocked","Only owners and admins can connect Towbook.");
  const d=data as {username:string;password:string};
  const result=await towbookLogin(d.username,d.password);
  if(!result.ok){ await persistTowbookFailure(u.orgId,result.facts); return towbookFail(result.error.code,result.error.message); }
  await persistTowbookSession(u.orgId,result.cookies);
  // Owner-driver link (owner-reported bug batch 2026-08-11, BUG 2): resolve the
  // Towbook DRIVER record behind this session (the owner logs in with their
  // Towbook username — which IS a driver login on this account) and store the
  // driver id on the owner-kind session row, so the Contractors roster counts
  // the owner's own driver row as signed in (the roster's session join is
  // keyed by towbook_driver_id across ALL session kinds). Best-effort: a
  // resolution failure never fails the connect itself.
  try {
    const { identifyDriver } = await import("./driver-auth");
    const identity = await identifyDriver({ cookies: result.cookies, baseUrl: TOWBOOK_ORIGIN });
    // Type mapping (2026-08-12): only a type-1 (driver) Towbook account carries
    // a roster driver id; a type-2 (manager) account has none to link.
    const driverId = identity.ok && identity.kind === "driver" ? identity.identity.driverId : null;
    if (driverId) {
      await sql()`UPDATE towbook_sessions SET towbook_driver_id=${driverId} WHERE org_id=${u.orgId} AND session_kind='owner'`;
    }
  } catch { /* best-effort — the session is stored; the link can be retried on next connect */ }
  return {ok:true as const};
});
export const disconnectTowbook=createServerFn({method:"POST"}).handler(async()=>{if(!configured())return {ok:true as const};const {currentUser}=await import("./auth-server");const u=await currentUser();if(!u||!can(u,["owner","admin"]))return towbookFail("towbook_blocked","You cannot disconnect Towbook.");try{await prepare();await sql()`DELETE FROM towbook_sessions WHERE org_id=${u.orgId} AND session_kind='owner'`;return {ok:true as const};}catch{return towbookFail("towbook_unreachable","Unable to disconnect Towbook.");}});

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

export type TowbookSyncCode = "ok" | "not_connected" | "session_unavailable" | "session_expired" | "no_jobs" | "unauthorized" | "error" | "timeout";
export type TowbookSyncDiag = { url: string; status: number | null; contentType: string | null; hint: string };
export type TowbookSyncResult = { ok: boolean; code: TowbookSyncCode; message: string; added: number; updated: number; failed: number; diagnostics: TowbookSyncDiag[]; ranAt: string; sample?: Record<string, any>[]; statusShapes?: string[]; sampleByStatus?: Record<string, Record<string, any>> };

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
  0: "new", // Received — call created / not yet dispatched
  1: "accepted", // Dispatched — a driver is assigned (LD "accepted")
  2: "en_route", // En Route — driver heading to the scene
  3: "arrived", // On Scene — driver on scene (LD "arrived")
  4: "arrived", // Towing — in-progress (tow jobs), still active
  5: "completed", // Complete — workflow end (observed; terminal)
  7: "arrived", // Arrived at destination — in-progress (tow jobs), still active
  252: "completed", // completed-awaiting-acknowledgement (owner-verified 2026-08-10)
  255: "cancelled", // completed-then-cancelled / cancelled call (terminal, import-only)
};
/** Known ids that are deliberately NOT mapped (documented so the next run knows
 *  they were considered). Currently empty: every observed id (0..5, 252, 255)
 *  now maps. Any id that shows up later lands here only after the sampleByStatus
 *  evidence proves it is NOT a lifecycle state. */
export const TOWBOOK_STATUS_ID_UNMAPPED: ReadonlySet<number> = new Set<number>();

/** Exported for the server-only sync engine (src/data/sync-engine.ts) — pure
 *  helper, never part of the client bundle's reach. */
export const numericStatusId = (v: unknown): number | null =>
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

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** Compact, tag-stripped, lowercased body fingerprint — truncated so a response can
 *  never smuggle the full page (or PII) into the UI; it exists to identify the page. */

/* ------------------------------- HTML table parsing ------------------------------- */

/** Raw HTML-table row shape. Exported for the server-only sync engine. */
export type RawJob = Record<string, string>;
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
/** Color text from a color DTO ({name:"Black"}) or a plain string. */
const colorText = (c: unknown): string => {
  if (c == null) return "";
  if (typeof c === "string") return c.trim();
  if (typeof c === "number") return String(c);
  if (typeof c === "object" && !Array.isArray(c)) return pickString(c as Record<string, unknown>, "name", "label", "value");
  return "";
};
/** Best-effort human vehicle description from whatever shape the call uses. */
const vehicleText = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v).trim();
  if (typeof v === "object" && !Array.isArray(v)) {
    const parts: string[] = [];
    for (const k of ["year", "make", "model", "plate", "description", "name", "label"]) {
      const s = pickString(v as Record<string, unknown>, k);
      if (s) parts.push(s);
    }
    const c = colorText((v as Record<string, unknown>).color);
    if (c) parts.push(c);
    return parts.join(" ");
  }
  return "";
};
/** Vehicle description from the call's `assets` array — the recon-verified
 *  Towbook shape (assets[0] = {year, make, model, color:{name}, vin, driver…}).
 *  Deliberately omits `name` (a truck/driver nickname on the asset) and `vin`
 *  (noise for a human vehicle line). */
const assetVehicleText = (assets: unknown): string => {
  if (!Array.isArray(assets) || !assets.length) return "";
  const a = assets[0];
  if (!a || typeof a !== "object" || Array.isArray(a)) return "";
  const o = a as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ["year", "make", "model"]) {
    const s = pickString(o, k);
    if (s) parts.push(s);
  }
  const c = colorText(o.color);
  if (c) parts.push(c);
  const desc = pickString(o, "description", "label");
  if (desc) parts.push(desc);
  return parts.join(" ");
};
/** Derive a status id from the CALL OBJECT itself (fallback when call.status is
 *  missing). Only explicit status keys — never a numeric sweep of the whole call,
 *  whose type/companyId/version fields would poison the guess. Exported for the
 *  server-only sync engine (src/data/sync-engine.ts) — pure, never in the client
 *  bundle's reach. */
export const callLevelStatusId = (call: Record<string, unknown>): number | null =>
  numericStatusId(call.statusId) ?? numericStatusId(call.currentStatusId) ?? numericStatusId(call.stateId) ?? null;

/** First contact (the real customer/member) on a Towbook call: `contacts` is an
 *  array of contact DTOs ({name, phone, ...}) or, in some shapes, a single object. */
const firstContact = (call: Record<string, unknown>): Record<string, unknown> | null => {
  const c = call.contacts;
  if (Array.isArray(c) && c.length) {
    const first = c[0];
    if (first && typeof first === "object" && !Array.isArray(first)) return first as Record<string, unknown>;
    return null;
  }
  if (c && typeof c === "object" && !Array.isArray(c)) return c as Record<string, unknown>;
  return null;
};
/** Address text for one waypoint DTO: full `address` string when present, else
 *  street/city/state/zip parts joined. */
const formatWaypointAddress = (o: Record<string, unknown>): string => {
  const full = pickString(o, "address", "formattedAddress", "fullAddress", "streetAddress");
  if (full) return full;
  const parts = [
    pickString(o, "street", "address1", "addressLine1"),
    pickString(o, "city"),
    pickString(o, "state", "stateCode"),
    pickString(o, "zip", "postalCode"),
  ].filter(Boolean);
  return parts.join(", ");
};
type WaypointInfo = { address: string; lat: number | null; lng: number | null };
/** Pickup/dropoff waypoint lookup: prefer the waypoint whose title names the
 *  role ("Pickup" / "Dropoff" / "Destination", case-insensitive, punctuation
 *  stripped - "Drop Off" matches too), else fall back to position order
 *  (pickup = lowest position, dropoff = a SECOND waypoint's position;
 *  single-waypoint calls have no dropoff). */
const findWaypoint = (call: Record<string, unknown>, want: "pickup" | "dropoff"): WaypointInfo | null => {
  const wps = call.waypoints;
  if (!Array.isArray(wps) || !wps.length) return null;
  const entries: Array<{ title: string; position: number; info: WaypointInfo }> = [];
  for (const w of wps) {
    if (!w || typeof w !== "object" || Array.isArray(w)) continue;
    const o = w as Record<string, unknown>;
    const latN = Number(o.latitude);
    const lngN = Number(o.longitude);
    const pos = Number(o.position);
    const title = pickString(o, "title", "name", "label", "type").toLowerCase().replace(/[^a-z0-9]/g, "");
    entries.push({
      title,
      position: Number.isFinite(pos) ? pos : 0,
      info: {
        address: formatWaypointAddress(o),
        lat: Number.isFinite(latN) && latN !== 0 ? latN : null,
        lng: Number.isFinite(lngN) && lngN !== 0 ? lngN : null,
      },
    });
  }
  for (const e of entries) {
    if (want === "pickup" && e.title.includes("pickup")) return e.info;
    if (want === "dropoff" && (e.title.includes("dropoff") || e.title.includes("destination"))) return e.info;
  }
  if (want === "pickup") {
    entries.sort((a, b) => a.position - b.position);
    return entries[0].info;
  }
  if (entries.length >= 2) {
    entries.sort((a, b) => b.position - a.position);
    return entries[0].info;
  }
  return null;
};
type JsonCallResult = { ok: true; job: NormalizedJob } | { ok: false; reason: string };
/** Normalize one Towbook /api/calls array item (the raw JSON object) into a
 *  dispatch job. Field names are read DIRECTLY from the real call object
 *  (id/callNumber, status, contacts, waypoints, assets, notes...) and the whole
 *  object is kept as raw_json for reconciliation. Returns ok:false with a human
 *  reason when the call must be skipped (no id, or an unmapped status id -
 *  unknown status ids are NEVER imported).
 *
 *  REAL-SHAPE NOTES (live /api/calls recon, 2026-08-11): `account` is the MOTOR
 *  CLUB (Agero & co) - never the member; the member is `contacts[0].name`.
 *  `owner` is the LD account owner. Pickup/dropoff live in `waypoints` (title
 *  "Pickup" position 1 with address + latitude/longitude), with `towSource` as
 *  a string fallback. The vehicle is `assets[0]` ({year, make, model,
 *  color:{name}}), NOT a top-level `vehicle` key. */
/** Driver acceptance on a raw Towbook call (owner-reported 2026-08-11; live
 *  proof job 279769283 / call #24592): a driver thumbs-up on an offer is
 *  recorded on the ASSIGNMENT entry, NOT on call.status — call.status stays
 *  {"id":1} ("offered") while assets[].drivers[].driver.responseStatusId flips
 *  0 → 1 (with a responseTime). Recon-verified semantics (api-calls-full.json,
 *  2026-08-10): every accepted/en-route/completed call carries
 *  responseStatusId=1 on its drivers[] entry (the direct assets[].driver keeps
 *  0); a call that was accepted and then re-dispatched has its response reset
 *  to 0 (live job 279769283, re-dispatched by the AI at 2026-08-11T18:56). Only
 *  EXACTLY 1 counts — anything else leaves the call-status derivation alone.
 *  Pure + client-safe (no dynamic imports). */
export function driverAcceptedOffer(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const assets = (raw as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return false;
  for (const a of assets) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const o = a as Record<string, unknown>;
    const direct = o.driver as Record<string, unknown> | undefined;
    if (direct && typeof direct === "object" && Number(direct.responseStatusId) === 1) return true;
    const drivers = o.drivers;
    if (Array.isArray(drivers)) {
      for (const d of drivers) {
        if (!d || typeof d !== "object" || Array.isArray(d)) continue;
        const sub = ((d as Record<string, unknown>).driver ?? null) as Record<string, unknown> | null;
        if (sub && typeof sub === "object" && Number(sub.responseStatusId) === 1) return true;
      }
    }
  }
  return false;
}

export function normalizeJsonCall(call: Record<string, unknown>, sourceUrl: string): JsonCallResult {
  const idRaw = call.id ?? call.callNumber;
  if (idRaw == null) return { ok: false, reason: "no id/status" };
  const towbookJobId = String(idRaw).trim();
  if (!towbookJobId) return { ok: false, reason: "no id/status" };
  const statusId = extractTowbookStatusId(call.status) ?? callLevelStatusId(call);
  let status = statusId == null ? null : TOWBOOK_STATUS_ID_TO_LIFECYCLE[statusId] ?? null;
  if (statusId == null || !status) {
    return { ok: false, reason: `unmapped status ${stringifyStatus(call.status)} (statusId=${statusId ?? "none"})` };
  }
  // Driver-response override (owner-reported 2026-08-11): a call Towbook still
  // reports as "offered" (statusId 1) whose assigned driver already thumbs-up'd
  // (assets[].drivers[].driver.responseStatusId === 1) is lifecycle "accepted".
  // The RAW call status id is preserved in towbookStatus so the pull's compare
  // never churns; when Towbook's own call status advances to 2 the normal
  // mapping takes over seamlessly. 252/255 and every other id are untouched.
  if (statusId === 1 && status === "offered" && driverAcceptedOffer(call)) {
    status = "accepted";
  }
  // Customer: the REAL member is the call's first contact (contacts[0].name,
  // e.g. "Morgan R R."), then member/customer/caller keys. `account.company` is
  // only a LAST fallback so motor-club jobs show the member, never the club.
  const contact = firstContact(call);
  const contactName = contact ? pickString(contact, "name", "fullName", "contactName", "customerName", "displayName") : "";
  const customer =
    contactName ||
    findText(call, ["member", "customer", "caller", "client", "customerName", "memberName"], ["name", "fullName"]) ||
    findText(call, ["account"], ["company", "name"]) ||
    `Towbook job ${towbookJobId}`;
  const contactPhone = contact ? pickString(contact, "phone", "mobile", "telephone", "phoneNumber", "cell") : "";
  const phone = contactPhone ||
    findText(call, ["phone", "customerPhone", "callerPhone", "mobile", "telephone", "accountPhone"], ["phone", "mobile", "telephone"]) ||
    findText(call, ["account"], ["phone"]);
  // Location: waypoints carry the real pickup/dropoff; towSource is the string
  // fallback for the pickup address when waypoints are absent.
  const pickupWp = findWaypoint(call, "pickup");
  const dropoffWp = findWaypoint(call, "dropoff");
  const pickup = pickupWp?.address || pickString(call, "towSource") ||
    findText(call, ["pickup", "pickupAddress", "fromAddress", "origin", "source", "address"], ["street", "address", "city", "state", "zip", "postalCode"]);
  const dropoff = dropoffWp?.address ||
    findText(call, ["dropoff", "dropoffAddress", "toAddress", "destination", "dest"], ["street", "address", "city", "state", "zip", "postalCode"]);
  // Vehicle: the recon-verified shape is call.assets[0]; call.vehicle only
  // exists in other shapes.
  const vehicle = vehicleText(call.vehicle) || assetVehicleText(call.assets) || "";
  // call.type is a numeric enum we do not know yet - derive service from TEXT only.
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
      vehicle,
      pickup,
      dropoff,
      pickupLat: pickupWp?.lat ?? null,
      pickupLng: pickupWp?.lng ?? null,
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

/** Normalized, lifecycle-mapped Towbook job. Exported for the server-only sync
 *  engine (src/data/sync-engine.ts) — type-only, zero client-bundle impact. */
export type NormalizedJob = {
  towbookJobId: string;
  customer: string;
  phone: string;
  vehicle: string;
  pickup: string;
  dropoff: string;
  pickupLat: number | null;
  pickupLng: number | null;
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
    pickupLat: null,
    pickupLng: null,
    status,
    towbookStatus,
    serviceType: mapTowbookService(rec.service || ""),
    createdAt: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
    note: (rec.note || "").trim(),
    raw: { sourceUrl, ...rec },
  };
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

/** Pickup waypoint coords from a raw Towbook call (waypoints[0].latitude/
 *  longitude — recon-verified 2026-08-11; the geofence auto-arrive needs them,
 *  and the sync's legacy lat/lng import stays 0,0). Null when absent. */
function pickupCoords(raw: unknown): { lat: number | null; lng: number | null } {
  if (!raw || typeof raw !== "object") return { lat: null, lng: null };
  const wp = (raw as Record<string, unknown>).waypoints;
  if (!Array.isArray(wp) || !wp.length) return { lat: null, lng: null };
  const w0 = wp[0] as Record<string, unknown> | undefined;
  if (!w0) return { lat: null, lng: null };
  const lat = Number(w0.latitude);
  const lng = Number(w0.longitude);
  return {
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
  };
}
/** Pickup coordinates for a normalized job: prefer the waypoint-derived
 *  coordinates captured during normalization (title/position-aware pickup),
 *  fall back to the raw waypoints[0] scan for HTML-table jobs that carry no
 *  waypoint info on the normalized record. */
const jobCoords = (job: NormalizedJob): { lat: number | null; lng: number | null } => {
  if (job.pickupLat != null && job.pickupLng != null) return { lat: job.pickupLat, lng: job.pickupLng };
  return pickupCoords(job.raw);
};
/** Numeric-coordinate equality: null/undefined/NaN count as "absent", so an
 *  absent stored coordinate and an absent normalized coordinate compare equal
 *  (absent -> absent is never a spurious update). */
const sameCoord = (a: unknown, b: number | null | undefined): boolean => {
  const na = a == null ? 0 : Number(a);
  const nb = b == null ? 0 : Number(b);
  return (Number.isFinite(na) ? na : 0) === (Number.isFinite(nb) ? nb : 0);
};

/** Assigned driver on a raw Towbook call (recon-verified shape, call-single.json):
 *  assets[].driver = {id, name, ...} — the currently assigned driver — and
 *  assets[].drivers[].driver the assignment mirror. Both carry the DRIVER id
 *  (the same shape callHasDriver/verifyDispatch read in ai-dispatcher.ts).
 *  Returns the Towbook driver id + display name, or nulls when the call has no
 *  assignment. Pure — shared by the sync (server.ts) and the driver-portal
 *  write-through (driver-auth.ts keeps a local copy per its module convention). */
export function assignedDriverFromRawCall(raw: unknown): { towbookId: string | null; name: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { towbookId: null, name: null };
  const assets = (raw as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return { towbookId: null, name: null };
  for (const a of assets) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const o = a as Record<string, unknown>;
    const direct = o.driver as Record<string, unknown> | undefined;
    if (direct && typeof direct === "object" && direct.id != null) {
      return {
        towbookId: String(direct.id),
        name: direct.name != null ? String(direct.name) : null,
      };
    }
    const drivers = o.drivers;
    if (Array.isArray(drivers)) {
      for (const d of drivers) {
        if (!d || typeof d !== "object" || Array.isArray(d)) continue;
        const sub = ((d as Record<string, unknown>).driver ?? null) as Record<string, unknown> | null;
        if (sub && typeof sub === "object" && sub.id != null) {
          return {
            towbookId: String(sub.id),
            name: sub.name != null ? String(sub.name) : null,
          };
        }
      }
    }
  }
  return { towbookId: null, name: null };
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
  const q = sqlWithTimeout(SYNC_TICK_TIMEOUT_MS);
  // NOTE: towbook_job_id MUST be in the select list — it is the existing-map key.
  // (Bug fixed 2026-08-10: it was omitted, so every row was keyed "undefined" and
  // re-syncs re-INSERTed → pkey violation → all counted as failed.)
  const existingRows = await q`SELECT id, status, customer_name, phone, pickup, dropoff, area, pickup_lat, pickup_lng, towbook_status, towbook_job_id, assigned_driver_towbook_id FROM dispatch_jobs WHERE org_id=${orgId} AND towbook_job_id IS NOT NULL`;
  const existing = new Map(existingRows.map((r) => [String(r.towbook_job_id), r as Record<string, unknown>]));
  let added = 0, updated = 0, unchanged = 0, failed = 0;
  for (const job of jobs) {
    const cur = existing.get(job.towbookJobId);
    try {
      if (!cur) {
        const slug = job.towbookJobId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
        const jobId = slug ? `tb-${slug}` : `tb-${Math.random().toString(36).slice(2, 10)}`;
        const coords = jobCoords(job);
        const assigned = assignedDriverFromRawCall(job.raw);
        await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, customer_phone, vehicle_desc, pickup, dropoff, towbook_status, raw_json, pickup_lat, pickup_lng, assigned_driver_towbook_id, assigned_driver_name)
          VALUES(${jobId}, ${orgId}, ${job.customer}, ${job.phone || ""}, 0, 0, ${job.pickup || "Unknown"}, ${job.serviceType}, ${job.status}, ${job.createdAt}, ${job.note}, ${job.towbookJobId}, ${job.phone || ""}, ${job.vehicle}, ${job.pickup}, ${job.dropoff}, ${job.towbookStatus}, ${JSON.stringify(job.raw)}::jsonb, ${coords.lat}, ${coords.lng}, ${assigned.towbookId}, ${assigned.name})`;
        await q`INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
          SELECT gen_random_uuid()::text, ${orgId}, ${jobId}, ${previousStatusFromHistory(job.raw, job.status)}, ${job.status}, ${actor.id}, ${actor.role}, ${`imported from Towbook (${trigger})`}`;
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${orgId}, ${actor.id}, ${actor.role}, 'towbook_import', 'job', ${jobId}, ${JSON.stringify({ towbookJobId: job.towbookJobId, towbookStatus: job.towbookStatus, status: job.status, source: job.raw.sourceUrl })}::jsonb, ${trigger}`;
        existing.set(job.towbookJobId, { id: jobId, status: job.status, customer_name: job.customer, phone: job.phone, pickup: job.pickup, dropoff: job.dropoff, area: job.pickup || "Unknown", towbook_status: job.towbookStatus });
        added++;
      } else {
        const statusChanged = String(cur.status) !== job.status;
        const curDriverId = String((cur as Record<string, unknown>).assigned_driver_towbook_id ?? "");
        const newDriver = assignedDriverFromRawCall(job.raw);
        const coords = jobCoords(job);
        const curArea = String((cur as Record<string, unknown>).area ?? "");
        const curLat = (cur as Record<string, unknown>).pickup_lat;
        const curLng = (cur as Record<string, unknown>).pickup_lng;
        const fieldsChanged =
          String(cur.customer_name ?? "") !== job.customer ||
          String(cur.phone ?? "") !== (job.phone || "") ||
          String(cur.pickup ?? "") !== job.pickup ||
          String(cur.dropoff ?? "") !== job.dropoff ||
          curArea !== (job.pickup || "Unknown") ||
          !sameCoord(curLat, coords.lat) ||
          !sameCoord(curLng, coords.lng) ||
          String(cur.towbook_status ?? "") !== job.towbookStatus ||
          curDriverId !== (newDriver.towbookId ?? "");
        if (!statusChanged && !fieldsChanged) { unchanged++; continue; } // already current — no churn
        const assigned = assignedDriverFromRawCall(job.raw);
        await q`UPDATE dispatch_jobs SET customer_name=${job.customer}, phone=${job.phone || ""}, area=${job.pickup || "Unknown"}, service_type=${job.serviceType}, status=${job.status}, note=${job.note}, towbook_status=${job.towbookStatus}, customer_phone=${job.phone || ""}, vehicle_desc=${job.vehicle}, pickup=${job.pickup}, dropoff=${job.dropoff}, raw_json=${JSON.stringify(job.raw)}::jsonb,
          pickup_lat=COALESCE(${coords.lat}, pickup_lat), pickup_lng=COALESCE(${coords.lng}, pickup_lng),
          assigned_driver_towbook_id=COALESCE(${assigned.towbookId}, assigned_driver_towbook_id),
          assigned_driver_name=COALESCE(${assigned.name}, assigned_driver_name),
          completed_at=CASE WHEN ${job.status}='completed' AND completed_at IS NULL THEN NOW() ELSE completed_at END,
          assigned_at=CASE WHEN ${job.status}='offered' AND assigned_at IS NULL THEN NOW() ELSE assigned_at END
          WHERE id=${String(cur.id)} AND org_id=${orgId}`;
        if (statusChanged) {
          await q`INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
            SELECT gen_random_uuid()::text, ${orgId}, ${String(cur.id)}, ${String(cur.status)}, ${job.status}, ${actor.id}, ${actor.role}, ${`status change from Towbook (${trigger})`}`;
          await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
            SELECT gen_random_uuid()::text, ${orgId}, ${actor.id}, ${actor.role}, 'towbook_status_change', 'job', ${String(cur.id)}, ${JSON.stringify({ towbookJobId: job.towbookJobId, from: String(cur.status), to: job.status, towbookStatus: job.towbookStatus })}::jsonb, ${trigger}`;
        }
        existing.set(job.towbookJobId, { ...cur, status: job.status, customer_name: job.customer, phone: job.phone, pickup: job.pickup, dropoff: job.dropoff, area: job.pickup || "Unknown", towbook_status: job.towbookStatus });
        updated++;
      }
    } catch {
      failed++;
    }
  }
  return { added, updated, unchanged, failed };
}


/** Hard per-tick deadline for the 3s Towbook sync + auto-dispatch loop. Sync
 *  alone can legitimately take ~12s (discovery + pull + upsert + dispatch), so
 *  30s is a generous cap that still guarantees a hung DB call cannot wedge the
 *  loop forever: the race below ALWAYS clears the in-flight guard (via .finally
 *  on a timeout that rejects), so the next interval fire starts a fresh tick. */
export const SYNC_TICK_TIMEOUT_MS = 30_000;




export const towbookSyncNow = createServerFn({ method: "POST" }).handler(async () => {
  const { syncResult, syncForOrg } = await import("./sync-engine");
  if (!configured()) return syncResult("error", "Towbook sync requires database mode.");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return syncResult("unauthorized", "Sign in required.");
  if (!can(u, ["owner", "admin"])) return syncResult("unauthorized", "Only owners and admins can sync Towbook.");
  await prepare();
  return syncForOrg(u.orgId, "sync:manual", { id: u.id, role: u.role });
});

/* ============================ AI dispatcher control panel ============================
 * Owner-facing status/toggle + decision ledger reads (owner/admin can mutate the
 * toggle; owner/admin/dispatcher can read). Every query is org-scoped from the
 * session — the client never supplies an org id. Defaults when no org_settings
 * row exists are the engine's lazy defaults (enabled, 06606 centroid, 30 mi, 45 min).
 * Seroval rule: no object ever carries an undefined-valued property (nullable
 * fields are omitted, never set to undefined).
 * ---------------------------------------------------------------------------------- */

export type AiDispatcherStatus = {
  enabled: boolean;
  activeZoneCount: number;
  coveredStates: string[];
  maxEtaMinutes: number;
  etaBufferMinutes: number;
  etaFloorMinutes: number;
  /** Which ETA provider is active for this deployment: "tomtom" (live traffic)
   *  when a TomTom key is configured (env TOMTOM_API_KEY or the stable key
   *  file), "osrm" static otherwise, "factor" when routing is disabled
   *  (ETA_ROUTER=off). */
  etaProvider: "tomtom" | "osrm" | "factor";
  /** Boolean presence of a TomTom key — never the key. */
  tomtomKeyConfigured: boolean;
  lastDecisionAt: string | null;
  decisionsLast24h: number;
  escalationsOpen: number;
  lastSyncAt: string | null;
  connected: boolean;
};

/** One decision row for list views — LIGHT on purpose (raw_response is excluded;
 *  the per-row detail fetch returns it on demand). Nullable fields are omitted. */
export type AiDispatcherDecisionRow = {
  id: string;
  callRequestId: string;
  decision: string;
  escalated: boolean;
  reason: string;
  createdAt: string;
  callId?: string;
  driverName?: string;
  etaMinutes?: number;
  zoneDistanceMiles?: number;
  /** Refreshed dispatch/Towbook evidence. unknown means no trustworthy status. */
  offerStatus?: "claimed" | "expired" | "unknown";
};

const aiDispatcherReader = (u: AuthUser): boolean => can(u, ["owner", "admin", "dispatcher"]);
const aiDispatcherOwnerAlertReader = (u: AuthUser): boolean => can(u, ["owner", "admin"]);
const aiDispatcherWriter = (u: AuthUser): boolean => can(u, ["owner", "admin"]);

/** Engine status for the control panel: settings (defaults when no row), the
 *  last decision, 24h volume, open escalations, and Towbook sync state. */
export const getAiDispatcherStatus = createServerFn({ method: "GET" }).handler(async () => {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || !aiDispatcherReader(u)) return null;
  try {
    await prepare();
    const q = sql();
    const settings = await getOrgSettings(u.orgId);
    const agg = await q`SELECT MAX(created_at) AS last_decision_at,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last24h,
      COUNT(*) FILTER (WHERE escalated)::int AS escalations_open
      FROM ai_dispatcher_decisions WHERE org_id=${u.orgId}`;
    const coverage = await q`SELECT COUNT(*)::int AS active_zone_count, COALESCE(array_agg(DISTINCT state ORDER BY state) FILTER (WHERE state IS NOT NULL AND state <> ''), ARRAY[]::text[]) AS covered_states FROM dispatch_zones WHERE org_id=${u.orgId} AND active=TRUE AND zone_type <> 'county'`;
    const sess = await q`SELECT status, last_sync_at FROM towbook_sessions WHERE org_id=${u.orgId} AND session_kind='owner'`;
    const a = (agg[0] ?? {}) as Record<string, unknown>;
    const s = sess[0] as Record<string, unknown> | undefined;
    const c = (coverage[0] ?? {}) as Record<string, unknown>;
    // ETA provider surface for the panel (v3): tomtom when a key is configured
    // (env TOMTOM_API_KEY or the stable key file — resolveTomtomKey), else osrm
    // static, else factor. Only the boolean presence of the key is ever exposed
    // — never the key itself.
    const etaStatus = etaProviderStatus(process.env as Record<string, string | undefined>);
    const st: AiDispatcherStatus = {
      enabled: settings.aiDispatcherEnabled,
      activeZoneCount: Number(c.active_zone_count ?? 0),
      coveredStates: Array.isArray(c.covered_states) ? c.covered_states.map(String) : [],
      maxEtaMinutes: settings.maxEtaMinutes,
      etaBufferMinutes: settings.etaBufferMinutes,
      etaFloorMinutes: settings.etaFloorMinutes,
      etaProvider: etaStatus.etaProvider,
      tomtomKeyConfigured: etaStatus.tomtomKeyConfigured,
      lastDecisionAt: a.last_decision_at ? new Date(String(a.last_decision_at)).toISOString() : null,
      decisionsLast24h: Number(a.last24h ?? 0),
      escalationsOpen: Number(a.escalations_open ?? 0),
      lastSyncAt: s && s.last_sync_at ? new Date(String(s.last_sync_at)).toISOString() : null,
      connected: Boolean(s && String(s.status) === "connected"),
    };
    return st;
  } catch {
    return null;
  }
});

/** One tick row for the AI Dispatcher card's "last run" line — the newest
 *  ai_dispatcher_runs row (the engine writes one per tick at the 3s cadence).
 *  LIGHT on purpose: id/ranAt/gated/offersSeen/processed/offerIds + skipped.
 *  This answers "did the dispatcher run, what did it see, why did it skip"
 *  at a glance. Owner/admin/dispatcher (same reader gate as the ledger).
 *  Seroval: skipped is omitted when null (never undefined-valued). */
export type AiDispatcherRunRow = {
  id: string;
  ranAt: string;
  gated: boolean;
  offersSeen: number;
  processed: number;
  /** Every offer that tick SAW (id + status), including silent skips
   *  (status!==0, already-processed) — status may be absent for offers that
   *  failed the shape rail (no usable id either; the id is a content hash). */
  offerIds: Array<{ id: string; status?: number }>;
  skipped?: string;
};
export const latestDispatcherRun = createServerFn({ method: "GET" }).handler(async () => {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || !aiDispatcherReader(u)) return null;
  try {
    await prepare();
    const rows = await sql()`SELECT id, ran_at, gated, offers_seen, processed, skipped, offer_ids
      FROM ai_dispatcher_runs WHERE org_id=${u.orgId} ORDER BY ran_at DESC, created_at DESC LIMIT 1`;
    if (!rows.length) return null;
    const r = rows[0] as Record<string, unknown>;
    const row: AiDispatcherRunRow = {
      id: String(r.id),
      ranAt: new Date(String(r.ran_at)).toISOString(),
      gated: Boolean(r.gated),
      offersSeen: Number(r.offers_seen),
      processed: Number(r.processed),
      offerIds: Array.isArray(r.offer_ids) ? (r.offer_ids as Array<{ id: string; status?: number }>) : [],
    };
    if (r.skipped != null && String(r.skipped) !== "") row.skipped = String(r.skipped);
    return row;
  } catch {
    return null;
  }
});

/** Flip the engine on/off for the org (owner/admin only). Upserts org_settings
 *  and writes an audit row so every toggle is attributable. */
export const setAiDispatcherEnabled = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const v = z.object({ enabled: z.boolean() }).strict().safeParse(data);
  if (!v.success) return { ok: false as const, error: { code: "validation" as const, message: v.error.issues[0]?.message ?? "Invalid input." } };
  if (!configured()) return { ok: false as const, error: { code: "database_unavailable" as const, message: "Database mode is not active." } };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: { code: "unauthorized" as const, message: "Sign in required." } };
  if (!aiDispatcherWriter(u)) return { ok: false as const, error: { code: "unauthorized" as const, message: "Only owners and admins can change AI dispatcher settings." } };
  try {
    await prepare();
    const q = sql();
    const enabled = v.data.enabled;
    await q`INSERT INTO org_settings(org_id, ai_dispatcher_enabled) VALUES(${u.orgId}, ${enabled})
      ON CONFLICT(org_id) DO UPDATE SET ai_dispatcher_enabled=${enabled}, updated_at=NOW()`;
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail)
      SELECT gen_random_uuid()::text, ${u.orgId}, ${u.id}, ${u.role}, 'ai_dispatcher_toggle', 'org_settings', ${u.orgId}, jsonb_build_object('enabled', ${enabled}::boolean)`;
    return { ok: true as const, enabled };
  } catch {
    return { ok: false as const, error: { code: "database_unavailable" as const, message: "Unable to update AI dispatcher settings." } };
  }
});

/** Recent decision rows, newest first, LIGHT (no raw_response). Optional filters:
 *  limit (default 20, max 100) and escalatedOnly. Owner/admin/dispatcher. */
export const listAiDispatcherDecisions = createServerFn({ method: "GET" }).validator(passthrough).handler(async ({ data }) => {
  const v = z.object({ limit: z.number().int().min(1).max(100).optional(), escalatedOnly: z.boolean().optional() }).safeParse(data ?? {});
  if (!v.success) return [];
  if (!configured()) return [];
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || (v.data.escalatedOnly ? !aiDispatcherOwnerAlertReader(u) : !aiDispatcherReader(u))) return [];
  try {
    await prepare();
    const q = sql();
    const limit = v.data.limit ?? 20;
    const rows = await q`SELECT a.id, a.call_request_id, a.call_id, a.decision, a.escalated, a.driver_name, a.eta_minutes, a.zone_distance_miles, a.reason, a.created_at, a.raw_response,
        j.status AS dispatch_status, j.towbook_status, j.assigned_driver_towbook_id
      FROM ai_dispatcher_decisions a
      LEFT JOIN dispatch_jobs j ON j.org_id=a.org_id AND (j.towbook_job_id=a.call_request_id OR j.id=a.call_request_id)
      WHERE a.org_id=${u.orgId} ${v.data.escalatedOnly ? q`AND escalated=TRUE` : q``}
      ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r: Record<string, unknown>) => {
      const row: AiDispatcherDecisionRow = {
        id: String(r.id), callRequestId: String(r.call_request_id), decision: String(r.decision),
        escalated: Boolean(r.escalated), reason: String(r.reason), createdAt: new Date(String(r.created_at)).toISOString(),
      };
      if (r.call_id != null && String(r.call_id) !== "") row.callId = String(r.call_id);
      if (r.driver_name != null && String(r.driver_name) !== "") row.driverName = String(r.driver_name);
      if (r.eta_minutes != null) row.etaMinutes = Number(r.eta_minutes);
      if (r.zone_distance_miles != null) row.zoneDistanceMiles = Number(r.zone_distance_miles);
      // Status is derived only from the refreshed dispatch_jobs row populated by
      // the Towbook sync. An assignment is claimed evidence; a Towbook 255
      // cancellation is the available expiry proxy (documented limitation).
      const assigned = r.assigned_driver_towbook_id != null && String(r.assigned_driver_towbook_id) !== "";
      const towbookStatus = String(r.towbook_status ?? "");
      const dispatchStatus = String(r.dispatch_status ?? "");
      row.offerStatus = assigned || ["accepted", "en_route", "arrived", "towing", "completed"].includes(dispatchStatus)
        ? "claimed" : towbookStatus === "255" ? "expired" : "unknown";
      // Towbook's field is preserved only when an authoritative expiry timestamp
      // is present in the captured offer response. Do not infer one here.
      const raw = r.raw_response as unknown;
      const expiryKeys = new Set(["offerExpiresAt", "offer_expires_at", "expiresAt", "expirationTime", "expiration_time"]);
      const findExpiry = (value: unknown): string | undefined => {
        if (!value || typeof value !== "object") return undefined;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (expiryKeys.has(k) && (typeof v === "string" || typeof v === "number")) {
            const date = new Date(v); if (!Number.isNaN(date.getTime())) return date.toISOString();
          }
          const nested = findExpiry(v); if (nested) return nested;
        }
        return undefined;
      };
      const expiry = findExpiry(raw); if (expiry) row.offerExpiresAt = expiry;
      return row;
    });
  } catch {
    return [];
  }
});

/** Per-row detail: the full raw_response (pretty-printed JSON text) for the
 *  collapsible viewer — kept out of the list to keep that payload light. */
export const getAiDispatcherDecisionDetail = createServerFn({ method: "GET" }).validator(passthrough).handler(async ({ data }) => {
  const v = z.object({ id: z.string().min(1).max(64) }).strict().safeParse(data ?? {});
  if (!v.success || !configured()) return { ok: false as const, error: "Invalid request." };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || !aiDispatcherReader(u)) return { ok: false as const, error: "Sign in required." };
  try {
    await prepare();
    const rows = await sql()`SELECT raw_response FROM ai_dispatcher_decisions WHERE id=${v.data.id} AND org_id=${u.orgId}`;
    if (!rows.length) return { ok: false as const, error: "Decision not found." };
    const raw = rows[0].raw_response as unknown;
    let text: string | null = null;
    if (raw != null) {
      try { text = typeof raw === "string" ? JSON.stringify(JSON.parse(raw), null, 2) : JSON.stringify(raw, null, 2); }
      catch { text = String(raw); }
    }
    return { ok: true as const, raw: text };
  } catch {
    return { ok: false as const, error: "Unable to load the raw response." };
  }
});

/* ------------------------------- live map ------------------------------- */
/** Live map feed (owner's #1 priority, 2026-08-11): driver positions from
 *  fresh GPS pings + active job pickup pins — LOCAL DB only (driver_locations
 *  + dispatch_jobs), never Towbook. Auth-gated: owner/admin/dispatcher see all
 *  drivers and all active jobs; contractors see their own position (self),
 *  their own active jobs with full customer detail, and anonymized nearby job
 *  pins. Polled by the client LiveMap at the app's 15s cadence. Query layer
 *  lives in the server-only ./live-map-core.ts (dynamic-imported here so the
 *  client bundle never touches driver-gps-core/db/auth-server). */
export type { LiveMapData, LiveMapDriverPin, LiveMapJobPin, LiveMapSelfPin } from "./live-map-core";
export const getLiveMapData = createServerFn({ method: "GET" }).validator((x: unknown) => x).handler(async ({ data }): Promise<LiveMapData | null> => {
  const core = await import("./live-map-core");
  // driverScope=true from the driver-portal pages: an owner/admin in driver
  // view (view toggle) gets the contractor-scoped feed (self pin, "mine"
  // flags, anonymized neighbors) keyed to their effective driver identity.
  const driverScope = Boolean((data as Record<string, unknown> | undefined)?.driverScope);
  return core.liveMapDataHandler(driverScope);
});
