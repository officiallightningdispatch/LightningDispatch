import { sql } from "~/db";
import { randomUUID, createHash } from "node:crypto";
import nationalZones from "./national-zones.json";
export type ZoneActor={orgId:string;id:string;role:string};

type NationalNode={state:string;name:string;zone_type:string;lat:number;lng:number;radius_miles:number;tz:string;parent:string|null};
const nationalNodes=nationalZones as NationalNode[];
function stableZoneId(key:string){const h=createHash("sha256").update(`dispatch-zone:${key}`).digest("hex");return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${((parseInt(h.slice(16,18),16)&0x3f)|0x80).toString(16).padStart(2,"0")}${h.slice(18,20)}-${h.slice(20,32)}`;}

/** Ensure the org-local US → State hierarchy exists before a new zone is saved. */
export async function ensureStateNode(orgId:string,stateInput:string){
 const state=stateInput.trim().toUpperCase(); if(!/^[A-Z]{2}$/.test(state)) throw new Error("Invalid state.");
 const q=qdb();
 const rootSpec=nationalNodes.find(n=>n.state==="US"&&n.zone_type==="coverage");
 const stateSpec=nationalNodes.find(n=>n.state===state&&n.zone_type==="coverage");
 if(!rootSpec||!stateSpec) throw new Error(`No national zone definition for ${state}.`);
 let root=await q`SELECT id FROM dispatch_zones WHERE org_id=${orgId} AND state='US' AND zone_type='coverage' AND parent_zone_id IS NULL AND active=TRUE ORDER BY id LIMIT 1`;
 if(!root.length){const rootId=stableZoneId(`${orgId}|US|coverage|ROOT`);await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,updated_at) VALUES(${rootId},${orgId},${rootSpec.name},'US',${rootSpec.name},'coverage',${[]},NULL,${rootSpec.lat},${rootSpec.lng},${rootSpec.radius_miles},${rootSpec.tz},TRUE,-100000,NOW()) ON CONFLICT(id) DO NOTHING`;root=await q`SELECT id FROM dispatch_zones WHERE id=${rootId} AND org_id=${orgId} LIMIT 1`;}
 if(!root.length) throw new Error("Unable to ensure US zone root.");
 let node=await q`SELECT id FROM dispatch_zones WHERE org_id=${orgId} AND state=${state} AND zone_type='coverage' AND parent_zone_id=${root[0].id} AND active=TRUE ORDER BY id LIMIT 1`;
 if(!node.length){const nodeId=stableZoneId(`${orgId}|${state}|coverage|STATE`);await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,updated_at) VALUES(${nodeId},${orgId},${stateSpec.name},${state},${stateSpec.name},'coverage',${[]},${root[0].id},${stateSpec.lat},${stateSpec.lng},${stateSpec.radius_miles},${stateSpec.tz},TRUE,-99999,NOW()) ON CONFLICT(id) DO NOTHING`;node=await q`SELECT id FROM dispatch_zones WHERE id=${nodeId} AND org_id=${orgId} LIMIT 1`;}
 if(!node.length) throw new Error(`Unable to ensure ${state} zone node.`);
 return {rootId:String(root[0].id),stateId:String(node[0].id)};
}
const qdb=()=>sql();
function localDate(tz:string, d=new Date()){ return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d); }
export function zoneSelectionOpenAt(nowIso:string|Date, tz:string){ return Number(new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',hour12:false}).format(new Date(nowIso)))%24 >= 6; }
function can(a:ZoneActor){return a.role==='owner'||a.role==='admin';}
export async function selectZoneCore(a:ZoneActor, zoneId:string, now=new Date()){
 const q=qdb(); const z=await q`SELECT id,name,tz FROM dispatch_zones WHERE id=${zoneId} AND org_id=${a.orgId} AND active=TRUE LIMIT 1`;
 if(!z.length)return {ok:false as const,message:'That zone is not available.'};
 if(!zoneSelectionOpenAt(now, String(z[0].tz)))return {ok:false as const,message:'Zone selection opens at 6:00 AM local'};
 const day=localDate(String(z[0].tz),now); const rows=await q`SELECT zone_change_count FROM driver_availability_log WHERE org_id=${a.orgId} AND user_id=${a.id} AND day=${day} LIMIT 1`;
 const count=rows.length?Number(rows[0].zone_change_count):0; if(count>=2)return {ok:false as const,message:'You can change your zone only once per day.'};
 await q`INSERT INTO driver_availability_log(org_id,user_id,day,zone_id,zone_changed_at,zone_change_count) VALUES(${a.orgId},${a.id},${day},${zoneId},NOW(),1) ON CONFLICT ON CONSTRAINT driver_availability_log_pkey DO UPDATE SET zone_id=${zoneId},zone_changed_at=NOW(),zone_change_count=driver_availability_log.zone_change_count+1,updated_at=NOW()`;
 return {ok:true as const,zoneId};
}
type ZoneMetrics={busyness:string;availableDrivers:number;activeJobs:number;unassignedJobs:number;recentVolume24h:number;demandRatio:number};
async function batchMetrics(q:any, orgId:string, zones:any[]):Promise<Map<string,ZoneMetrics & {assignedDriverCount:number}>>{
 const availability=await q`SELECT zone_id, user_id, day::text AS day FROM driver_availability_log WHERE org_id=${orgId} AND session_started_at IS NOT NULL AND heartbeat_at > NOW() - INTERVAL '90 seconds' AND zone_id IS NOT NULL`;
 const jobs=await q`SELECT status,lat,lng,pickup_lat,pickup_lng FROM dispatch_jobs WHERE org_id=${orgId} AND created_at>=NOW()-INTERVAL '24 hours' AND (pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL OR lat IS NOT NULL AND lng IS NOT NULL)`;
 const out=new Map<string,ZoneMetrics & {assignedDriverCount:number}>();
 for(const z of zones){ const zid=String(z.id), day=localDate(String(z.tz)); const drivers=availability.filter((r:any)=>String(r.zone_id)===zid&&String(r.day)===day); const users=new Set(drivers.map((r:any)=>String(r.user_id)));
  const inside=(j:any)=>{const la=Number(j.pickup_lat??j.lat),ln=Number(j.pickup_lng??j.lng);const x=(la-Number(z.lat))*69,y=(ln-Number(z.lng))*69*Math.cos(Number(z.lat)*Math.PI/180);return Math.sqrt(x*x+y*y)<=Number(z.radius_miles)};
  const inJobs=jobs.filter(inside), active=inJobs.filter((j:any)=>['offered','assigned','in_progress'].includes(String(j.status))).length, unassigned=inJobs.filter((j:any)=>j.status==='new').length, av=users.size, ratio=(active+unassigned)/Math.max(av,1), busyness=av===0&&(active+unassigned)>0?'Busy':ratio>=2?'Busy':ratio>=1?'Moderate':'Low';
  out.set(zid,{busyness,availableDrivers:av,activeJobs:active,unassignedJobs:unassigned,recentVolume24h:inJobs.length,demandRatio:Number(ratio.toFixed(1)),assignedDriverCount:users.size}); }
 return out;
}
export async function getZonesCore(a:ZoneActor){ const q=qdb(); const zones=await q`SELECT id,org_id,name,lat,lng,radius_miles,tz FROM dispatch_zones WHERE org_id=${a.orgId} AND active=TRUE AND zone_type IN ('market','corridor') AND zone_type <> 'coverage' ORDER BY sort_order,name`; const metrics=await batchMetrics(q,a.orgId,zones); return zones.map((z:any)=>({id:String(z.id),name:String(z.name),lat:Number(z.lat),lng:Number(z.lng),radiusMiles:Number(z.radius_miles),tz:String(z.tz),...metrics.get(String(z.id))!})); }
export async function getMyZoneStateCore(a:ZoneActor, now=new Date()){
 const q=qdb(); const zones=await q`SELECT id,name,tz FROM dispatch_zones WHERE org_id=${a.orgId} AND active=TRUE ORDER BY sort_order,name`;
 const fallback=zones[0];
 const today=localDate(String(fallback?.tz??'America/New_York'),now);
 const logs=await q`SELECT zone_id,zone_changed_at,zone_change_count,day::text AS day FROM driver_availability_log WHERE org_id=${a.orgId} AND user_id=${a.id} ORDER BY updated_at DESC`;
 // Today's selection only (day-keyed): a new day means no zone until the driver
 // picks again at GO. Owner overrides write today's row, so they surface here.
 const todayLog=logs.find((r:any)=>String(r.day)===today);
 const zid=todayLog?.zone_id?String(todayLog.zone_id):null;
 const z=zones.find((x:any)=>String(x.id)===zid);
 const count=todayLog?Number(todayLog.zone_change_count??0):0;
 return {ok:true as const,zoneId:zid,zoneName:zid&&z?String(z.name):null,zoneChangedAt:todayLog?.zone_changed_at?new Date(todayLog.zone_changed_at).toISOString():null,zoneChangeCount:count,canChangeToday:!todayLog||count<2,selectionOpen:(z??fallback)?zoneSelectionOpenAt(now,String((z??fallback).tz)):false};
}
export async function getDispatchZonesForOwnerCore(a:ZoneActor, state?:string){
 if(!can(a))return {ok:false as const,message:'Owner access required.'}; const q=qdb();
 const zones=await q`SELECT id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,polygon_geojson,capacity FROM dispatch_zones WHERE org_id=${a.orgId} AND (zone_type IN ('market','corridor') OR zone_type='coverage' AND state='US') ${state ? q`AND state=${state.toUpperCase()}` : q``} ORDER BY sort_order,name`;
 const metrics=await batchMetrics(q,a.orgId,zones); const out=zones.map((z:any)=>{const s=metrics.get(String(z.id))!;return {id:String(z.id),name:String(z.name),state:String(z.state??''),market:String(z.market??''),zoneType:String(z.zone_type??''),zipCodes:Array.isArray(z.zip_codes)?z.zip_codes.map(String):[],parentZoneId:z.parent_zone_id?String(z.parent_zone_id):null,lat:Number(z.lat),lng:Number(z.lng),radiusMiles:Number(z.radius_miles),tz:String(z.tz),active:Boolean(z.active),sortOrder:Number(z.sort_order),polygonGeojson:z.polygon_geojson??null,capacity:z.capacity==null?null:Number(z.capacity),jobsByZone:s.recentVolume24h,availableDriversByZone:s.availableDrivers,...s};});
 return {ok:true as const,zones:out};
}
export async function zoneContainingPointCore(a:ZoneActor, lat:number, lng:number, zip?:string){
 const q=qdb(); const rows=await q`SELECT id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,polygon_geojson,capacity FROM dispatch_zones WHERE org_id=${a.orgId} AND active=TRUE ORDER BY sort_order,name`;
 const {zoneContainingPoint}=await import('../lib/zone-containment'); const match=zoneContainingPoint(rows as any,lat,lng,zip);
 if(!match)return null; return {id:String(match.id),orgId:String(match.org_id),name:String(match.name),state:String(match.state??''),market:String(match.market??''),zoneType:String(match.zone_type??''),zipCodes:Array.isArray(match.zip_codes)?match.zip_codes.map(String):[],parentZoneId:match.parent_zone_id?String(match.parent_zone_id):null,lat:Number(match.lat),lng:Number(match.lng),radiusMiles:Number(match.radius_miles),tz:String(match.tz),active:Boolean(match.active),sortOrder:Number(match.sort_order),polygonGeojson:match.polygon_geojson??null,capacity:match.capacity==null?null:Number(match.capacity)};
}
export async function getOwnerZoneDriverRosterCore(a:ZoneActor){if(!can(a))return {ok:false as const,message:'Owner access required.'};const q=qdb();const rows=await q`SELECT u.id user_id,u.name,(u.deactivated_at IS NULL) active,l.session_started_at,l.heartbeat_at,l.zone_id,z.name zone_name,l.zone_changed_at FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${a.orgId} LEFT JOIN LATERAL (SELECT * FROM driver_availability_log x WHERE x.org_id=${a.orgId} AND x.user_id=u.id ORDER BY x.day DESC,x.updated_at DESC LIMIT 1) l ON TRUE LEFT JOIN dispatch_zones z ON z.id=l.zone_id WHERE m.role='contractor' ORDER BY u.name`;return {ok:true as const,drivers:rows.map((r:any)=>({userId:String(r.user_id),name:String(r.name??''),active:Boolean(r.active),online:Boolean(r.session_started_at && r.heartbeat_at && new Date(r.heartbeat_at).getTime() > Date.now() - 90_000),zoneId:r.zone_id?String(r.zone_id):null,zoneName:r.zone_name?String(r.zone_name):null,zoneChangedAt:r.zone_changed_at?new Date(r.zone_changed_at).toISOString():null}))};}
export async function ownerSetZoneCore(a:ZoneActor,userId:string,zoneId:string|null,day?:string){ if(!can(a))return {ok:false as const,message:'Owner access required.'}; const d=day??new Date().toISOString().slice(0,10); if(zoneId){const q=qdb(); const z=await q`SELECT id FROM dispatch_zones WHERE id=${zoneId} AND org_id=${a.orgId} AND active=TRUE`;if(!z.length)return {ok:false as const,message:'Zone not found.'};} const q=qdb(); await q`INSERT INTO driver_availability_log(org_id,user_id,day,zone_id,zone_changed_at,zone_change_count) VALUES(${a.orgId},${userId},${d},${zoneId},NOW(),0) ON CONFLICT ON CONSTRAINT driver_availability_log_pkey DO UPDATE SET zone_id=${zoneId},zone_changed_at=NOW(),updated_at=NOW()`; await q`INSERT INTO audit_log(id,org_id,actor_user_id,actor_role,action,entity_type,entity_id,detail) VALUES(${randomUUID()},${a.orgId},${a.id},${a.role},'driver_zone_override','driver',${userId},${JSON.stringify({zoneId,day:d,reason:'owner/admin override'})}::jsonb)`; return {ok:true as const}; }
export async function upsertZoneCore(a:ZoneActor,v:any){if(!can(a))return {ok:false as const,message:'Owner access required.'};const q=qdb();const id=String(v.id??randomUUID());if(v.state==null||String(v.state).trim()==='')throw new Error('State is required.');const state=String(v.state).toUpperCase();await ensureStateNode(a.orgId,state);const parentId=v.parentZoneId==null?null:String(v.parentZoneId);if(parentId===id)return {ok:false as const,message:'A zone cannot be its own parent.'};if(parentId){const p=await q`SELECT id,state FROM dispatch_zones WHERE id=${parentId} AND org_id=${a.orgId} LIMIT 1`;if(!p.length)return {ok:false as const,message:'Parent zone not found in this organization.'};if(p[0].state&&v.state&&String(p[0].state)!=='US'&&String(p[0].state)!==String(v.state).toUpperCase())return {ok:false as const,message:'Parent and child must share a state.'};let cursor=parentId;for(let i=0;i<32;i++){const r=await q`SELECT parent_zone_id FROM dispatch_zones WHERE id=${cursor} AND org_id=${a.orgId} LIMIT 1`;if(!r.length)break;cursor=r[0].parent_zone_id?String(r[0].parent_zone_id):'';if(cursor===id)return {ok:false as const,message:'Zone hierarchy cycle detected.'};if(!cursor)break;} }const zoneState=state;const zoneType=v.zoneType??'market';const zips=Array.isArray(v.zipCodes)?v.zipCodes.map(String):[];const defaultActive=zoneType==='coverage'||zoneType==='US'||zoneType==='state';const active=v.active??defaultActive;await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order,polygon_geojson,capacity,updated_at) VALUES(${id},${a.orgId},${v.name},${zoneState},${v.market??''},${zoneType},${zips},${parentId},${v.lat},${v.lng},${v.radiusMiles??20},${v.tz??'America/New_York'},${active},${v.sortOrder??0},${v.polygonGeojson??null},${v.capacity??null},NOW()) ON CONFLICT(id) DO UPDATE SET name=${v.name},state=${zoneState},market=${v.market??''},zone_type=${zoneType},zip_codes=${zips},parent_zone_id=${parentId},lat=${v.lat},lng=${v.lng},radius_miles=${v.radiusMiles??20},tz=${v.tz??'America/New_York'},active=${active},sort_order=${v.sortOrder??0},polygon_geojson=${v.polygonGeojson??null},capacity=${v.capacity??null},updated_at=NOW() WHERE dispatch_zones.org_id=${a.orgId}`;return {ok:true as const,id};}
