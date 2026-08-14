import { sql } from "~/db";
import { randomUUID } from "node:crypto";
export type ZoneActor={orgId:string;id:string;role:string};
const qdb=()=>sql();
function localDate(tz:string, d=new Date()){ return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d); }
function hour(tz:string,d=new Date()){ return Number(new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',hour12:false}).format(d))%24; }
function can(a:ZoneActor){return a.role==='owner'||a.role==='admin';}
export async function selectZoneCore(a:ZoneActor, zoneId:string){
 const q=qdb(); const z=await q`SELECT id,name,tz FROM dispatch_zones WHERE id=${zoneId} AND org_id=${a.orgId} AND active=TRUE LIMIT 1`;
 if(!z.length)return {ok:false as const,message:'That zone is not available.'};
 if(hour(String(z[0].tz))<6)return {ok:false as const,message:'Zone selection opens at 6:00 AM local'};
 const day=localDate(String(z[0].tz));
 const rows=await q`SELECT zone_change_count FROM driver_availability_log WHERE org_id=${a.orgId} AND user_id=${a.id} AND day=${day} LIMIT 1`;
 const count=rows.length?Number(rows[0].zone_change_count):0;
 if(count>=2)return {ok:false as const,message:'You can change your zone only once per day.'};
 await q`INSERT INTO driver_availability_log(org_id,user_id,day,zone_id,zone_changed_at,zone_change_count) VALUES(${a.orgId},${a.id},${day},${zoneId},NOW(),1) ON CONFLICT(org_id,user_id,day) DO UPDATE SET zone_id=${zoneId},zone_changed_at=NOW(),zone_change_count=driver_availability_log.zone_change_count+1,updated_at=NOW()`;
 return {ok:true as const,zoneId};
}
export async function getZonesCore(a:ZoneActor){
 const q=qdb(); const zones=await q`SELECT id,name,lat,lng,radius_miles,tz FROM dispatch_zones WHERE org_id=${a.orgId} AND active=TRUE ORDER BY sort_order,name`;
 const out=[]; for(const z of zones){ const id=String(z.id); const drivers=await q`SELECT COUNT(*)::int n FROM driver_availability_log WHERE org_id=${a.orgId} AND day=${localDate(String(z.tz))} AND session_started_at IS NOT NULL AND zone_id=${id}`; const jobs=await q`SELECT status,lat,lng,pickup_lat,pickup_lng FROM dispatch_jobs WHERE org_id=${a.orgId} AND ((pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL) OR (lat IS NOT NULL AND lng IS NOT NULL)) AND (pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL OR lat IS NOT NULL AND lng IS NOT NULL) AND created_at>=NOW()-INTERVAL '24 hours'`;
 const inside=(j:any)=>{const la=Number(j.pickup_lat??j.lat),ln=Number(j.pickup_lng??j.lng); const x=(la-Number(z.lat))*69,y=(ln-Number(z.lng))*69*Math.cos(Number(z.lat)*Math.PI/180); return Math.sqrt(x*x+y*y)<=Number(z.radius_miles)};
 const inJobs=jobs.filter(inside), active=inJobs.filter((j:any)=>['offered','assigned','in_progress'].includes(String(j.status))).length, unassigned=inJobs.filter((j:any)=>j.status==='new').length, av=Number(drivers[0]?.n??0), ratio=(active+unassigned)/Math.max(av,1); const busy=av===0&&(active+unassigned)>0?'Busy':ratio>=2?'Busy':ratio>=1?'Moderate':'Low'; out.push({id,name:String(z.name),busyness:busy,availableDrivers:av,activeJobs:active,unassignedJobs:unassigned,recentVolume24h:inJobs.length,demandRatio:Number(ratio.toFixed(1))}); }
 return out;
}
export async function ownerSetZoneCore(a:ZoneActor,userId:string,zoneId:string|null,day?:string){ if(!can(a))return {ok:false as const,message:'Owner access required.'}; const d=day??new Date().toISOString().slice(0,10); if(zoneId){const q=qdb(); const z=await q`SELECT id FROM dispatch_zones WHERE id=${zoneId} AND org_id=${a.orgId} AND active=TRUE`;if(!z.length)return {ok:false as const,message:'Zone not found.'};} const q=qdb(); await q`INSERT INTO driver_availability_log(org_id,user_id,day,zone_id,zone_changed_at,zone_change_count) VALUES(${a.orgId},${userId},${d},${zoneId},NOW(),0) ON CONFLICT(org_id,user_id,day) DO UPDATE SET zone_id=${zoneId},zone_changed_at=NOW(),updated_at=NOW()`; await q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) VALUES(${randomUUID()},${a.orgId},${a.id},${a.role},'driver_zone_override','driver',${userId},${JSON.stringify({zoneId,day:d,reason:'owner/admin override'})}::jsonb)`; return {ok:true as const}; }
export async function upsertZoneCore(a:ZoneActor,v:any){if(!can(a))return {ok:false as const,message:'Owner access required.'};const q=qdb();const id=String(v.id??randomUUID());await q`INSERT INTO dispatch_zones(id,org_id,name,lat,lng,radius_miles,tz,active,sort_order) VALUES(${id},${a.orgId},${v.name},${v.lat},${v.lng},${v.radiusMiles??20},${v.tz??'America/New_York'},${v.active??true},${v.sortOrder??0}) ON CONFLICT(id) DO UPDATE SET name=${v.name},lat=${v.lat},lng=${v.lng},radius_miles=${v.radiusMiles??20},tz=${v.tz??'America/New_York'},active=${v.active??true},sort_order=${v.sortOrder??0},updated_at=NOW() WHERE dispatch_zones.org_id=${a.orgId}`;return {ok:true as const,id};}
