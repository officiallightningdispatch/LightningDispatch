/** Server-only assignment nudges and conservative headed detection (Feature 1/2). */
import { sql } from "~/db";
import { haversineMiles, chooseBestDriverByRoad, loadOrgDriverQueues, loadDriverGpsFixes, loadDriverAnchors, loadZoneMatches, loadRegionalPreferenceMatches, resolveRouter, loadLightningAvailableDrivers, type StateGuardOutcome } from "./ai-dispatcher";
import { decryptSession } from "./towbook-key";
import { resolveStateFromAddress, reverseGeocodeState } from "./state-guard-core";
import { resolveTomtomKey } from "./tomtom-key";

export type GpsFix = { latitude:number; longitude:number; capturedAt:Date|string; speedMph?:number|null };
export type HeadedCheck = { headed:boolean; arrived:boolean; reason:"arrived"|"movement"|"speed"|"no_fix"|"no_meaningful_movement" };
export function isDriverHeaded(fixes: readonly GpsFix[], jobLat:number, jobLng:number, assignedAt:Date|string, now:Date = new Date()): HeadedCheck {
  const start = new Date(assignedAt).getTime(); const end = now.getTime();
  const usable = fixes.filter(f => { const t=new Date(f.capturedAt).getTime(); return Number.isFinite(t) && t>=start && t<=end && Number.isFinite(f.latitude) && Number.isFinite(f.longitude); }).sort((a,b)=>new Date(a.capturedAt).getTime()-new Date(b.capturedAt).getTime());
  if (!usable.length) return {headed:false,arrived:false,reason:"no_fix"};
  if (usable.some(f=>haversineMiles(f.latitude,f.longitude,jobLat,jobLng)<=0.3)) return {headed:true,arrived:true,reason:"arrived"};
  const first=haversineMiles(usable[0].latitude,usable[0].longitude,jobLat,jobLng), last=haversineMiles(usable[usable.length-1].latitude,usable[usable.length-1].longitude,jobLat,jobLng);
  if (first-last>=0.5) return {headed:true,arrived:false,reason:"movement"};
  if (usable.filter(f=>Number(f.speedMph)>=10).length>=2) return {headed:true,arrived:false,reason:"speed"};
  return {headed:false,arrived:false,reason:"no_meaningful_movement"};
}
export async function recordNudge(orgId:string, jobId:string, driverId:string|null, kind:"assignment"|"warning"|"reassigned"|"reassign_attempted", reason:string):Promise<void> {
  try { await sql()`INSERT INTO dispatch_nudge_events(id,org_id,job_id,driver_towbook_id,kind,reason) VALUES(gen_random_uuid()::text,${orgId},${jobId},${driverId},${kind},${reason}) ON CONFLICT (org_id,job_id,kind) DO NOTHING`; } catch { /* ledger is best effort */ }
}
async function sendPush(orgId:string, driverId:string, jobId:string, message:string):Promise<void> {
  try { const {sendAssignmentPushByTowbookDriver}=await import("./push-core"); await sendAssignmentPushByTowbookDriver(orgId,driverId,{callId:jobId,callRequestId:null,jobType:"Dispatch",location:"",etaMinutes:null,jobUrl:"/driver",message,tag:`nudge-${message}-${jobId}`}); } catch { /* best effort */ }
}
async function sendWarningPush(orgId:string, driverId:string, jobId:string):Promise<void> { return sendPush(orgId,driverId,jobId,"You haven't left yet — the job will be reassigned shortly"); }

/** Select and execute one reassignment. All Towbook writes go through the proven
 * reassign core, which reads back the call and preserves its lifecycle status. */
async function reassignNotHeaded(orgId:string, job:Record<string,unknown>, oldId:string, now:Date):Promise<void> {
  const jobId=String(job.id), lat=Number(job.pickup_lat), lng=Number(job.pickup_lng);
  if (!Number.isFinite(lat)||!Number.isFinite(lng)) return escalate(orgId,jobId,oldId,"reassigned_no_candidate", "missing pickup coordinates");
  const sessionRows=await sql()`SELECT encrypted_session FROM towbook_sessions WHERE org_id=${orgId} AND session_kind='owner' AND status='connected'`;
  if (!sessionRows.length) return escalate(orgId,jobId,oldId,"reassigned_no_candidate","Towbook session unavailable");
  let session:{cookies:string;baseUrl:string};
  try { const p=JSON.parse(await decryptSession(String(sessionRows[0].encrypted_session))); session={cookies:p.cookies||"",baseUrl:p.baseUrl||"https://app.towbook.com"}; } catch { return escalate(orgId,jobId,oldId,"reassigned_no_candidate","Towbook session unavailable"); }
  let drivers:unknown[]=[];
  try { const r=await fetch(`${session.baseUrl}/api/nearestDrivers?latitude=${lat}&longitude=${lng}&checkInForAllDrivers=true`,{headers:{cookie:session.cookies,accept:"application/json"}}); const b=await r.json(); drivers=Array.isArray(b)?b:[]; } catch { return escalate(orgId,jobId,oldId,"reassigned_no_candidate","Towbook driver list unavailable"); }
  drivers=drivers.filter(d=>Number((d as Record<string,unknown>)?.driverId)!==Number(oldId));
  const queues=await loadOrgDriverQueues(orgId), gps=await loadDriverGpsFixes(orgId), anchors=await loadDriverAnchors(orgId);
  const serviceQualification={serviceType:job.service_type?String(job.service_type):null,assessed:Boolean(job.service_type),excluded:[] as Array<{driverId:number;reason:string}>};
  const resolution=resolveStateFromAddress(String(job.pickup ?? ""));
  const state=resolution.state;
  const router=resolveRouter(process.env).router;
  const stateGuard={jobState:state,resolveDriverState:async(_id:number,la:number,lo:number)=>reverseGeocodeState(la,lo,resolveTomtomKey(process.env) || "",fetch)};
  const areaBase={anchors,gpsFixes:gps,serviceType:serviceQualification.serviceType,serviceQualification,stateGuard};
  const zoneMatches=await loadZoneMatches(orgId,drivers,lat,lng,state ?? undefined);
  const regionalPreference=await loadRegionalPreferenceMatches(orgId,drivers,lat,lng,queues);
  const area={...areaBase,zoneMatches,regionalPreference};
  const activeCount=(d:unknown) => {
    const o=d as Record<string,unknown>;
    const db=Number(queues.get(String(o.driverId))?.activeCount ?? 0);
    const calls=Array.isArray(o.calls) ? o.calls.length : 0;
    return Math.max(db,calls);
  };
  const available=drivers.filter(d=>activeCount(d)===0);
  const guard:StateGuardOutcome={active:false,jobState:state,blocked:false,blockedReason:null,checked:0,inState:0,excluded:[]};
  let chosen=await chooseBestDriverByRoad(available,lat,lng,router,queues,area,{stateGuard:guard});
  // If no free candidate survives all rails, use the same chooser on the busy pool.
  if (!chosen) {
    guard.blocked=false; guard.blockedReason=null; guard.checked=0; guard.inState=0; guard.excluded=[];
    const busy=drivers.filter(d=>!available.includes(d) && Number(queues.get(String((d as Record<string,unknown>).driverId))?.activeCount??0)>0);
    chosen=await chooseBestDriverByRoad(busy,lat,lng,router,queues,area,{stateGuard:guard});
  }
  if (!chosen || guard.blocked) return escalate(orgId,jobId,oldId,"reassigned_no_candidate",guard.blockedReason||"no eligible available driver");
  const newId=String(chosen.driver.driverId);
  const roster=await sql()`SELECT u.id,u.name,u.towbook_driver_id FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${orgId} WHERE u.towbook_driver_id=${newId} AND u.deactivated_at IS NULL LIMIT 1`;
  if (!roster.length) return escalate(orgId,jobId,oldId,"reassigned_no_candidate","selected Towbook driver is not on the contractor roster");
  const owner=await sql()`SELECT u.id FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${orgId} WHERE m.role IN ('owner','admin') AND u.deactivated_at IS NULL LIMIT 1`;
  if (!owner.length) return escalate(orgId,jobId,oldId,"reassigned_no_candidate","no owner actor available");
  const {reassignDriverCore}=await import("./reassign-core");
  const result=await reassignDriverCore({jobId,contractorId:String(roster[0].id),orgId,actor:{id:String(owner[0].id),role:"owner"},opts:{now,fetchImpl:globalThis.fetch}});
  if (!result.ok) return escalate(orgId,jobId,oldId,"reassigned_no_candidate",`Towbook reassignment failed: ${result.message}`);
  await recordNudge(orgId,jobId,oldId,"reassigned","reassigned_not_headed");
  await sendPush(orgId,oldId,jobId,"Job reassigned");
  await sql() `INSERT INTO ai_dispatcher_decisions(id,org_id,call_request_id,call_id,decision,escalated,driver_id,driver_name,eta_minutes,reason,raw_response) VALUES(gen_random_uuid()::text,${orgId},${jobId},${job.towbook_job_id??null},'auto_accept_with_driver',false,${newId},${String(chosen.driver.driverName??"")},${Math.ceil(chosen.baseMinutes)},'reassigned_not_headed',${JSON.stringify({oldDriverId:oldId,newDriverId:newId})}::jsonb) ON CONFLICT DO NOTHING`;
}
async function escalate(orgId:string,jobId:string,driverId:string,reason:string,detail:string):Promise<void> { await sql() `INSERT INTO ai_dispatcher_decisions(id,org_id,call_request_id,call_id,decision,escalated,driver_id,reason,raw_response) VALUES(gen_random_uuid()::text,${orgId},${jobId},${jobId},'escalated_dispatch_failed',true,${driverId},${reason},${JSON.stringify({detail})}::jsonb) ON CONFLICT DO NOTHING`; }

export async function processAssignmentNudges(orgId:string, now:Date = new Date()):Promise<void> {
  const settings=await sql()`SELECT nudge_enabled,reassign_not_headed_minutes FROM org_settings WHERE org_id=${orgId}`;
  if (settings.length && settings[0].nudge_enabled === false) return;
  const mins=Number(settings[0]?.reassign_not_headed_minutes)||5;
  const rows=await sql()`SELECT id,assigned_driver_towbook_id,assigned_at,pickup_lat,pickup_lng,pickup,service_type,towbook_job_id,status FROM dispatch_jobs WHERE org_id=${orgId} AND assigned_driver_towbook_id IS NOT NULL AND assigned_at IS NOT NULL AND status IN ('offered','accepted','en_route') AND assigned_at <= ${new Date(now.getTime()-mins*60000).toISOString()}`;
  for (const r of rows as Array<Record<string,unknown>>) {
    const jobId=String(r.id), oldId=String(r.assigned_driver_towbook_id);
    const fixes=await sql()`SELECT latitude,longitude,captured_at,speed_mph FROM driver_locations WHERE org_id=${orgId} AND towbook_driver_id=${oldId} AND captured_at >= ${new Date(String(r.assigned_at)).toISOString()} ORDER BY captured_at`;
    const check=isDriverHeaded((fixes as Array<Record<string,unknown>>).map(f=>({latitude:Number(f.latitude),longitude:Number(f.longitude),capturedAt:String(f.captured_at),speedMph:f.speed_mph==null?null:Number(f.speed_mph)})),Number(r.pickup_lat),Number(r.pickup_lng),String(r.assigned_at),now);
    if (check.headed) continue;
    const reassigned=await sql()`SELECT 1 FROM dispatch_nudge_events WHERE org_id=${orgId} AND job_id=${jobId} AND kind='reassigned' LIMIT 1`;
    const attempted=await sql()`SELECT 1 FROM dispatch_nudge_events WHERE org_id=${orgId} AND job_id=${jobId} AND kind='reassign_attempted' LIMIT 1`;
    if (reassigned.length) {
      const alreadyAlerted=await sql()`SELECT 1 FROM ai_dispatcher_decisions WHERE org_id=${orgId} AND call_request_id=${jobId} AND reason='reassigned_not_headed_again' LIMIT 1`;
      if (!alreadyAlerted.length) await escalate(orgId,jobId,oldId,"reassigned_not_headed_again","replacement driver is not headed");
      continue;
    }
    if (attempted.length) continue;
    const warning=await sql()`SELECT 1 FROM dispatch_nudge_events WHERE org_id=${orgId} AND job_id=${jobId} AND kind='warning' LIMIT 1`;
    if (!warning.length && mins>=4) { await recordNudge(orgId,jobId,oldId,"warning","not_headed_4m"); await sendWarningPush(orgId,oldId,jobId); }
    await reassignNotHeaded(orgId,r,oldId,now);
    const completed=await sql()`SELECT 1 FROM dispatch_nudge_events WHERE org_id=${orgId} AND job_id=${jobId} AND kind='reassigned' LIMIT 1`;
    if (!completed.length) await recordNudge(orgId,jobId,oldId,"reassign_attempted","reassigned_no_candidate");
  }
}
