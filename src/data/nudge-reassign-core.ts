/** Server-only assignment nudges and conservative headed detection (Feature 1/2). */
import { sql } from "~/db";
import { haversineMiles } from "./ai-dispatcher";

export type GpsFix = { latitude:number; longitude:number; capturedAt:Date|string; speedMph?:number|null };
export type HeadedCheck = { headed:boolean; arrived:boolean; reason:"arrived"|"movement"|"speed"|"no_fix"|"no_meaningful_movement" };
/** Conservative: only fixes captured after assignment count; no GPS is never headed. */
export function isDriverHeaded(fixes: readonly GpsFix[], jobLat:number, jobLng:number, assignedAt:Date|string, now:Date = new Date()): HeadedCheck {
  const start = new Date(assignedAt).getTime(); const end = now.getTime();
  const usable = fixes.filter(f => { const t=new Date(f.capturedAt).getTime(); return Number.isFinite(t) && t>=start && t<=end && Number.isFinite(f.latitude) && Number.isFinite(f.longitude); }).sort((a,b)=>new Date(a.capturedAt).getTime()-new Date(b.capturedAt).getTime());
  if (!usable.length) return {headed:false,arrived:false,reason:"no_fix"};
  if (usable.some(f=>haversineMiles(f.latitude,f.longitude,jobLat,jobLng)<=0.3)) return {headed:true,arrived:true,reason:"arrived"};
  const first=haversineMiles(usable[0].latitude,usable[0].longitude,jobLat,jobLng);
  const last=haversineMiles(usable[usable.length-1].latitude,usable[usable.length-1].longitude,jobLat,jobLng);
  if (first-last>=0.5) return {headed:true,arrived:false,reason:"movement"};
  const toward = usable.filter(f=>Number(f.speedMph)>=10);
  if (toward.length>=2) return {headed:true,arrived:false,reason:"speed"};
  return {headed:false,arrived:false,reason:"no_meaningful_movement"};
}
export async function recordNudge(orgId:string, jobId:string, driverId:string|null, kind:"assignment"|"warning"|"reassigned", reason:string):Promise<void> {
  try { await sql()`INSERT INTO dispatch_nudge_events(id,org_id,job_id,driver_towbook_id,kind,reason) VALUES(gen_random_uuid()::text,${orgId},${jobId},${driverId},${kind},${reason}) ON CONFLICT (org_id,job_id,kind) DO NOTHING`; } catch { /* notifications never block dispatch */ }
}
/** Periodic warning ledger pass. Reassignment is deliberately delegated to the existing candidate pipeline. */
export async function processAssignmentNudges(orgId:string, now:Date = new Date()):Promise<void> {
  const settings=await sql()`SELECT nudge_enabled,reassign_not_headed_minutes FROM org_settings WHERE org_id=${orgId}`;
  if (settings.length && settings[0].nudge_enabled === false) return;
  const rows=await sql()`SELECT id,assigned_driver_towbook_id,assigned_at,pickup_lat,pickup_lng,status FROM dispatch_jobs WHERE org_id=${orgId} AND assigned_driver_towbook_id IS NOT NULL AND assigned_at IS NOT NULL AND status IN ('offered','accepted','en_route') AND assigned_at <= ${new Date(now.getTime()-4*60*1000).toISOString()} AND assigned_at > ${new Date(now.getTime()-6*60*1000).toISOString()}`;
  for (const r of rows as Array<Record<string,unknown>>) {
    const already=await sql()`SELECT 1 FROM dispatch_nudge_events WHERE org_id=${orgId} AND job_id=${String(r.id)} AND kind='warning' LIMIT 1`;
    if (already.length) continue;
    const fixes=await sql()`SELECT latitude,longitude,captured_at FROM driver_locations WHERE org_id=${orgId} AND towbook_driver_id=${String(r.assigned_driver_towbook_id)} AND captured_at >= ${String(r.assigned_at)} ORDER BY captured_at`;
    const check=isDriverHeaded((fixes as Array<Record<string,unknown>>).map(f=>({latitude:Number(f.latitude),longitude:Number(f.longitude),capturedAt:String(f.captured_at)})),Number(r.pickup_lat),Number(r.pickup_lng),String(r.assigned_at),now);
    if (!check.headed) { await recordNudge(orgId,String(r.id),String(r.assigned_driver_towbook_id),"warning","not_headed_4m"); }
  }
}
