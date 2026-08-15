// Hermetic nudge/reassignment acceptance suite. QA-only rows; run sequentially.
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 17).toString("base64");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { processAssignmentNudges } = await import("./src/data/nudge-reassign-core.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const S = suffix();
const ORG = `qa-nudge-${S}`;
const uid = (n) => `qa-nudge-${n}-${S}`;
const tb = (n) => 900000000 + Math.floor(Math.random()*9000000) + n;
const OWNER=uid("owner"), OLD=uid("old"), NEAR=uid("near"), BUSY=uid("busy"), BAD=uid("bad"), FAR=uid("far");
const IDS={old:tb(1),near:tb(2),busy:tb(3),bad:tb(4),far:tb(5)};
const now = new Date("2026-08-15T18:00:00.000Z"), assignedAt = new Date(now.getTime()-6*60000);
const checks=[]; const check=(name,ok,extra="")=>{ checks.push([name,!!ok,extra]); if(!ok) throw new Error(`FAIL: ${name} ${extra}`); };
const json=(status,body)=>({status,ok:status>=200&&status<300,async text(){return JSON.stringify(body)},async json(){return body},headers:new Headers({"content-type":"application/json"})});
function mockFetch(drivers, {putFail=false}={}) { let call={id:279000000+Math.floor(Math.random()*999999),status:{id:2},assets:[{id:4242,driver:{id:IDS.old}}]}; const calls=[]; const f=async(url,init={})=>{ const u=String(url), method=init.method||"GET"; calls.push({u,method,body:init.body?JSON.parse(init.body):null}); if(u.includes("nearestDrivers")) return json(200,drivers); const rg=u.match(/reverseGeocode\/(-?[\d.]+),(-?[\d.]+)/); if(rg) return json(200,{addresses:[{address:{countryCode:"US",adminDistrict:"CT"}}]}); if(u.includes("/api/calls/")&&method==="GET") return json(200,call); if(u.includes("/api/calls/")&&method==="PUT"){if(putFail)return json(500,{error:"failed"});const id=calls.at(-1).body?.assets?.[0]?.drivers?.[0]?.driver?.id;call={...call,assets:[{id:4242,drivers:[{driver:{id,name:"replacement"}}]}]};return json(200,{ok:true});} return json(404,{}); }; return {f,calls}; }
const drv=(id,name,opts={})=>({driverId:id,driverName:name,latitude:opts.lat??41.2,longitude:opts.lng??-73.2,isCheckedIn:opts.checkedIn??true,estimatedTimeSeconds:opts.etaSec??300,estimatedDistanceMiles:opts.dist??1,calls:opts.calls??[],...(opts.serviceExclusions?{serviceExclusions:opts.serviceExclusions}: {})});
async function job(label, oldId=IDS.old, service="jump_start"){const id=uid(`job-${label}`);await q`INSERT INTO dispatch_jobs(id,org_id,customer_name,phone,lat,lng,area,service_type,status,created_at,note,towbook_job_id,raw_json,pickup,pickup_lat,pickup_lng,assigned_driver_towbook_id,assigned_driver_name,assigned_at) VALUES(${id},${ORG},'QA','',41.2,-73.2,'Bridgeport CT',${service},'accepted',${assignedAt.toISOString()},'',${String(279000000+Math.floor(Math.random()*999999))},'{}'::jsonb,'BRIDGEPORT CT',41.2,-73.2,${String(oldId)},'Old',${assignedAt.toISOString()})`;return id;}
async function events(id){return q`SELECT kind,reason FROM dispatch_nudge_events WHERE org_id=${ORG} AND job_id=${id} ORDER BY kind`}
async function decisions(id){return q`SELECT reason,escalated FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND call_request_id=${id}`}
await ensureSchema();
try {
 await q`INSERT INTO organizations(id,name) VALUES(${ORG},'QA nudge')`;
 await q`INSERT INTO users(id,name,email,password_hash,towbook_driver_id) VALUES(${OWNER},'Owner',${OWNER+'@qa.local'},'x',NULL),(${OLD},'Old',${OLD+'@qa.local'},'x',${String(IDS.old)}),(${NEAR},'Near',${NEAR+'@qa.local'},'x',${String(IDS.near)}),(${BUSY},'Busy',${BUSY+'@qa.local'},'x',${String(IDS.busy)}),(${BAD},'Bad',${BAD+'@qa.local'},'x',${String(IDS.bad)}),(${FAR},'Far',${FAR+'@qa.local'},'x',${String(IDS.far)})`;
 await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG},${OWNER},'owner'),(${ORG},${OLD},'contractor'),(${ORG},${NEAR},'contractor'),(${ORG},${BUSY},'contractor'),(${ORG},${BAD},'contractor'),(${ORG},${FAR},'contractor')`;
 await q`INSERT INTO contractor_profiles(org_id,user_id,vehicle_type) VALUES(${ORG},${OLD},'car'),(${ORG},${NEAR},'car'),(${ORG},${BUSY},'car'),(${ORG},${BAD},'car'),(${ORG},${FAR},'car')`;
 await q`INSERT INTO towbook_sessions(org_id,encrypted_session,status) VALUES(${ORG},${await encryptSession(JSON.stringify({cookies:'qa',baseUrl:'https://app.towbook.com'}))},'connected')`;
 await q`INSERT INTO org_settings(org_id,nudge_enabled,reassign_not_headed_minutes,qualification_gate_enabled) VALUES(${ORG},TRUE,5,FALSE)`;
 await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,lat,lng,radius_miles,tz,active,sort_order,zip_codes) VALUES(${uid('zone')},${ORG},'QA CT','CT','QA','market',41.208862,-73.207253,30,'America/New_York',TRUE,1,ARRAY['06606'])`;
 const realFetch=globalThis.fetch;
 const gps=async(label,driverId,towbookId,latitude,longitude)=>q`INSERT INTO driver_locations(id,org_id,driver_id,towbook_driver_id,latitude,longitude,captured_at) VALUES(${uid(`gps-${label}`)},${ORG},${driverId},${String(towbookId)},${latitude},${longitude},${new Date(now.getTime()-60000).toISOString()})`;
 const run=async(id,drivers,opts={})=>{const f=mockFetch(drivers,opts).f; globalThis.fetch=(url,init)=>String(url).includes("app.towbook.com")?f(url,init):realFetch(url,init); await processAssignmentNudges(ORG,now);};
 // a
 {const id=await job('headed');await q`INSERT INTO driver_locations(id,org_id,driver_id,towbook_driver_id,latitude,longitude,captured_at) VALUES(${uid('gps1')},${ORG},${OLD},${String(IDS.old)},41.3,-73.3,${new Date(now.getTime()-120000).toISOString()}),(${uid('gps2')},${ORG},${OLD},${String(IDS.old)},41.2,-73.2,${new Date(now.getTime()-60000).toISOString()})`;await run(id,[drv(IDS.near,'Near')]);check('a headed at threshold: no reassignment/no ledger',(await events(id)).length===0);}
 // b
 {const id=await job('nearest');await gps('b-near',NEAR,IDS.near,41.201,-73.201);await gps('b-far',FAR,IDS.far,41.3,-73.3);await run(id,[drv(IDS.old,'Old'),drv(IDS.near,'Near',{lat:41.201,lng:-73.201}),drv(IDS.far,'Far',{lat:41.3,lng:-73.3})]);const r=(await q`SELECT assigned_driver_towbook_id FROM dispatch_jobs WHERE id=${id}`)[0];check('b not headed reassigns nearest and excludes current',String(r.assigned_driver_towbook_id)===String(IDS.near),JSON.stringify({r,IDS}));}
 // c
 {const id=await job('busy');await gps('c-busy',BUSY,IDS.busy,41.2,-73.2);await q`INSERT INTO dispatch_jobs(id,org_id,customer_name,phone,lat,lng,area,service_type,status,created_at,note,pickup,pickup_lat,pickup_lng,assigned_driver_towbook_id,assigned_at) VALUES(${uid('active')},${ORG},'active','',41.2,-73.2,'CT','jump_start','accepted',${assignedAt.toISOString()},'','CT',41.2,-73.2,${String(IDS.busy)},${assignedAt.toISOString()})`;await run(id,[drv(IDS.near,'Near'),drv(IDS.busy,'Busy',{calls:[{status:3}]})]);const r=(await q`SELECT assigned_driver_towbook_id FROM dispatch_jobs WHERE id=${id}`)[0];check('c no free driver uses busy fallback',String(r.assigned_driver_towbook_id)===String(IDS.busy));}
 // d
 {const id=await job('empty');await run(id,[drv(IDS.near,'offline',{checkedIn:false}),drv(IDS.far,'out',{lat:40,lng:-74})]);const d=await decisions(id),r=(await q`SELECT assigned_driver_towbook_id FROM dispatch_jobs WHERE id=${id}`)[0];check('d empty pool escalates and retains old',d.some(x=>x.escalated&&x.reason==='reassigned_no_candidate')&&String(r.assigned_driver_towbook_id)===String(IDS.old));}
 // e
 {const id=await job('capability',''+IDS.old,'tire');await gps('e-far',FAR,IDS.far,41.3,-73.3);await run(id,[drv(IDS.near,'bad',{serviceExclusions:['tire']}),drv(IDS.far,'good',{lat:41.3,lng:-73.3})]);const r=(await q`SELECT assigned_driver_towbook_id FROM dispatch_jobs WHERE id=${id}`)[0];check('e capability mismatch never selected',String(r.assigned_driver_towbook_id)===String(IDS.far));}
 // f
 {const id=await job('idem');await gps('f-idem-near',NEAR,IDS.near,41.201,-73.201);await run(id,[drv(IDS.near,'Near')]);const before=(await events(id)).length;await run(id,[drv(IDS.near,'Near')]);check('f second scan does not double reassign',(await events(id)).length===before);const id2=await job('failed');await gps('f-failed-near',NEAR,IDS.near,41.201,-73.201);await run(id2,[drv(IDS.near,'Near')],{putFail:true});const n=(await events(id2)).filter(x=>x.kind==='reassign_attempted').length;await run(id2,[drv(IDS.far,'Far')]);check('f failed attempt marker blocks retry',(await events(id2)).filter(x=>x.kind==='reassign_attempted').length===n);}
 // g
 {const id=await job('cycle');await gps('g-near',NEAR,IDS.near,41.201,-73.201);await run(id,[drv(IDS.near,'Near')]);await run(id,[drv(IDS.far,'Far')]);const d=await decisions(id);check('g replacement not headed escalates without second auto-reassignment',d.some(x=>x.reason==='reassigned_not_headed_again')&&d.filter(x=>x.reason==='reassigned_not_headed').length===1);}
 // h
 {await q`UPDATE org_settings SET nudge_enabled=FALSE WHERE org_id=${ORG}`;const id=await job('off');await run(id,[drv(IDS.near,'Near')]);check('h nudge disabled turns everything off',(await events(id)).length===0&&(await decisions(id)).length===0);}
 console.log(`ALL NUDGE-REASSIGN CHECKS PASSED (${checks.length})`);for(const [n] of checks)console.log(`PASS ${n}`);
} finally { assertQaOrg(ORG); await q`DELETE FROM organizations WHERE id=${ORG}`.catch(()=>{}); for(const id of [OWNER,OLD,NEAR,BUSY,BAD,FAR]) await q`DELETE FROM users WHERE id=${id}`.catch(()=>{}); }
