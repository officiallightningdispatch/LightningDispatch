// P0 Slice 2A: hermetic DB-backed production zone coverage. No network/Towbook/routing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { selectZoneCore, getZonesCore, ownerSetZoneCore, upsertZoneCore, zoneSelectionOpenAt, getMyZoneStateCore, getDispatchZonesForOwnerCore, getOwnerZoneDriverRosterCore } = await import("./src/data/zones-core.ts");
const { loadZoneMatches, chooseBestDriverByRoad } = await import("./src/data/ai-dispatcher.ts");
const ORG = `qa-zone-${randomUUID()}`;
const OWNER = `qa-zone-owner-${randomUUID()}`;
const DRIVER_A = `qa-zone-driver-a-${randomUUID()}`;
const DRIVER_B = `qa-zone-driver-b-${randomUUID()}`;
const ZONE_IN = `qa-zone-in-${randomUUID()}`;
const ZONE_EMPTY = `qa-zone-empty-${randomUUID()}`;
const DAY = "2026-08-15";
const actor = { orgId: ORG, id: OWNER, role: "owner" };
const driver = (id, lat, lng) => ({ driverId: id, isCheckedIn: true, latitude: lat, longitude: lng, estimatedTimeSeconds: 600 });
const checks = [];
async function check(name, fn) { try { await fn(); checks.push([name, true]); console.log(`PASS ${name}`); } catch (e) { checks.push([name, false]); console.error(`FAIL ${name}: ${e.message}`); throw e; } }
let created = false;
try {
  await ensureSchema();
  await q`INSERT INTO organizations(id,name) VALUES(${ORG},'QA zones')`;
  await q`INSERT INTO users(id,name,email,password_hash,towbook_driver_id) VALUES(${OWNER},'QA owner',${OWNER+'@qa.local'},'x',NULL),(${DRIVER_A},'QA Driver A',${DRIVER_A+'@qa.local'},'x','910001'),(${DRIVER_B},'QA Driver B',${DRIVER_B+'@qa.local'},'x','910002')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG},${OWNER},'owner'),(${ORG},${DRIVER_A},'contractor'),(${ORG},${DRIVER_B},'contractor')`;
  await upsertZoneCore(actor,{id:ZONE_IN,name:'QA In Zone',lat:41.208862,lng:-73.207253,radiusMiles:5,tz:'America/New_York',active:true});
  await upsertZoneCore(actor,{id:ZONE_EMPTY,name:'QA Empty Zone',lat:40,lng:-75,radiusMiles:2,tz:'America/New_York',active:true});
  created = true;

  await check("MIGRATION: v51 dispatch_zones/index and availability columns", async () => {
    const t = await q`SELECT 1 FROM information_schema.tables WHERE table_name='dispatch_zones'`;
    const cols = await q`SELECT column_name FROM information_schema.columns WHERE table_name='driver_availability_log' AND column_name IN ('zone_id','zone_changed_at','zone_change_count')`;
    const idx = await q`SELECT 1 FROM pg_indexes WHERE tablename='dispatch_zones' AND indexname='dispatch_zones_org_active_idx'`;
    assert.equal(t.length,1); assert.equal(cols.length,3); assert.equal(idx.length,1);
  });
  await check("SELECTION WINDOW: helper and production core use local 6:00 rule", async () => {
    assert.equal(zoneSelectionOpenAt('2026-08-15T09:59:00Z','America/New_York'),false);
    assert.equal(zoneSelectionOpenAt('2026-08-15T10:00:00Z','America/New_York'),true);
    const before = await selectZoneCore({...actor,id:DRIVER_A},ZONE_IN,new Date('2026-08-15T09:59:00Z'));
    assert.equal(before.ok,false); assert.equal(before.message,'Zone selection opens at 6:00 AM local');
    const after = await selectZoneCore({...actor,id:DRIVER_A},ZONE_IN,new Date('2026-08-15T10:00:00Z'));
    assert.equal(after.ok,true);
  });
  await check("ONE-CHANGE-PER-DAY: production selection persists, limits, resets, STOP preserves zone", async () => {
    const a={...actor,id:DRIVER_A};
    await q`DELETE FROM driver_availability_log WHERE org_id=${ORG}`;
    assert.equal((await selectZoneCore(a,ZONE_IN,new Date('2026-08-15T10:00:00Z'))).ok,true);
    assert.equal((await selectZoneCore(a,ZONE_EMPTY,new Date('2026-08-15T11:00:00Z'))).ok,true);
    const third=await selectZoneCore(a,ZONE_IN,new Date('2026-08-15T12:00:00Z'));
    assert.equal(third.message,'You can change your zone only once per day.');
    const row=await q`SELECT zone_id,zone_change_count FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER_A} AND day=${DAY}`;
    assert.equal(String(row[0].zone_id),ZONE_EMPTY); assert.equal(Number(row[0].zone_change_count),2);
    await q`UPDATE driver_availability_log SET session_started_at=NULL WHERE org_id=${ORG} AND user_id=${DRIVER_A} AND day=${DAY}`;
    const retained=await q`SELECT zone_id FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER_A} AND day=${DAY}`; assert.equal(String(retained[0].zone_id),ZONE_EMPTY);
    assert.equal((await selectZoneCore(a,ZONE_IN,new Date('2026-08-16T10:00:00Z'))).ok,true);
  });
  await check("BUSYNESS: production getZonesCore exact buckets/raw values", async () => {
    await q`UPDATE driver_availability_log SET session_started_at=NOW(), zone_id=${ZONE_IN}, day=(CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date WHERE org_id=${ORG} AND user_id=${DRIVER_A} AND day=${DAY}`;
    await q`INSERT INTO driver_availability_log(org_id,user_id,day,session_started_at,zone_id) VALUES(${ORG},${DRIVER_B},(CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date,NOW(),${ZONE_IN}) ON CONFLICT DO NOTHING`;
    const base={org_id:ORG,customer_name:'QA',phone:'',area:'',service_type:'jump',note:''};
    await q`INSERT INTO dispatch_jobs(id,org_id,customer_name,phone,lat,lng,pickup_lat,pickup_lng,area,service_type,status,created_at,note) VALUES
      (${`j-${randomUUID()}`},${ORG},'a','',41.208862,-73.207253,41.208862,-73.207253,'','jump','assigned',NOW(),''),
      (${`j-${randomUUID()}`},${ORG},'b','',41.208862,-73.207253,41.208862,-73.207253,'','jump','new',NOW(),''),
      (${`j-${randomUUID()}`},${ORG},'old','',41.208862,-73.207253,41.208862,-73.207253,'','jump','in_progress',NOW()-INTERVAL '25 hours','')`;
    const zones=await getZonesCore(actor); const z=zones.find(x=>x.id===ZONE_IN); const e=zones.find(x=>x.id===ZONE_EMPTY);
    assert.deepEqual({busyness:z.busyness,availableDrivers:z.availableDrivers,activeJobs:z.activeJobs,unassignedJobs:z.unassignedJobs,recentVolume24h:z.recentVolume24h,demandRatio:z.demandRatio},{busyness:'Moderate',availableDrivers:2,activeJobs:1,unassignedJobs:1,recentVolume24h:2,demandRatio:1});
    assert.deepEqual({busyness:e.busyness,availableDrivers:e.availableDrivers,activeJobs:e.activeJobs,unassignedJobs:e.unassignedJobs,recentVolume24h:e.recentVolume24h,demandRatio:e.demandRatio},{busyness:'Low',availableDrivers:0,activeJobs:0,unassignedJobs:0,recentVolume24h:0,demandRatio:0});
  });
  await check("DISPATCH PREFERENCE: real loadZoneMatches + comparator uses nested driver", async () => {
    await q`DELETE FROM driver_availability_log WHERE org_id=${ORG}`;
    await q`INSERT INTO driver_availability_log(org_id,user_id,day,session_started_at,zone_id) VALUES(${ORG},${DRIVER_A},(CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date,NOW(),${ZONE_IN})`;
    const candidates=[driver('910001',41.208862,-73.207253),driver('910002',41.208862,-73.207253)];
    const matches=await loadZoneMatches(ORG,candidates,41.208862,-73.207253,new Date());
    assert.equal(matches.get('910001'),true); assert.equal(matches.get('910002'),false);
    const picked=await chooseBestDriverByRoad(candidates,41.208862,-73.207253,null,new Map(),{zoneMatches:matches}); assert.equal(String(picked?.driver?.driverId),'910001');
    const none=await loadZoneMatches(ORG,candidates,40,-75,new Date('2026-08-15T12:00:00Z')); assert.equal([...none.values()].every(v=>v===false),true);
    const unchanged=await chooseBestDriverByRoad([driver('910002',41.2,-73.2),driver('910001',41.2,-73.2)],41.208862,-73.207253,null,new Map(),{zoneMatches:none}); assert.equal(String(unchanged?.driver?.driverId),'910001');
    const emergency=await chooseBestDriverByRoad([driver('910002',41.2,-73.2)],40,-75,null,new Map(),{zoneMatches:none}); assert.equal(String(emergency?.driver?.driverId),'910002');
  });
  await check("OVERRIDE: owner production override bypasses limit, clears, audits", async () => {
    const a={...actor}; const day='2026-08-17';
    await q`INSERT INTO driver_availability_log(org_id,user_id,day,zone_id,zone_change_count) VALUES(${ORG},${DRIVER_A},${day},${ZONE_IN},2) ON CONFLICT ON CONSTRAINT driver_availability_log_pkey DO UPDATE SET zone_id=${ZONE_IN},zone_change_count=2`;
    assert.equal((await ownerSetZoneCore(a,DRIVER_A,ZONE_EMPTY,day)).ok,true);
    const row=await q`SELECT zone_id FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER_A} AND day=${day}`; assert.equal(String(row[0].zone_id),ZONE_EMPTY);
    assert.equal((await ownerSetZoneCore(a,DRIVER_A,null,day)).ok,true);
    const cleared=await q`SELECT zone_id FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER_A} AND day=${day}`; assert.equal(cleared[0].zone_id,null);
    const audit=await q`SELECT actor_user_id,actor_role,entity_id,detail->>'zoneId' zone,detail->>'day' AS "day",detail->>'reason' reason FROM audit_log WHERE org_id=${ORG} AND action='driver_zone_override' ORDER BY occurred_at DESC LIMIT 1`;
    assert.equal(String(audit[0].actor_user_id),OWNER); assert.equal(audit[0].actor_role,'owner'); assert.equal(String(audit[0].entity_id),DRIVER_A); assert.equal(audit[0].zone,null); assert.equal(audit[0].day,day); assert.equal(audit[0].reason,'owner/admin override');
  });
  await check("ZONE-STATE: getMyZoneStateCore is day-keyed, window-aware, change-allowance matches once-per-day rule", async () => {
    const b={...actor,id:DRIVER_B};
    await q`DELETE FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER_B}`;
    // Fresh day before 6 AM local: no zone yet, window closed, can change (nothing selected).
    const fresh=await getMyZoneStateCore(b,new Date('2026-08-18T09:59:00Z'));
    assert.equal(fresh.ok,true); assert.equal(fresh.zoneId,null); assert.equal(fresh.zoneName,null);
    assert.equal(fresh.canChangeToday,true); assert.equal(fresh.selectionOpen,false); assert.equal(fresh.zoneChangeCount,0);
    // After 6 AM: select once.
    assert.equal((await selectZoneCore(b,ZONE_IN,new Date('2026-08-18T10:00:00Z'))).ok,true);
    const once=await getMyZoneStateCore(b,new Date('2026-08-18T12:00:00Z'));
    assert.equal(once.zoneId,ZONE_IN); assert.equal(once.zoneName,'QA In Zone'); assert.equal(once.zoneChangeCount,1);
    assert.equal(once.canChangeToday,true); assert.equal(once.selectionOpen,true);
    assert.ok(typeof once.zoneChangedAt==='string' && !Number.isNaN(Date.parse(once.zoneChangedAt)));
    // Change once more (allowed): count 2, no more changes today.
    assert.equal((await selectZoneCore(b,ZONE_EMPTY,new Date('2026-08-18T13:00:00Z'))).ok,true);
    const twice=await getMyZoneStateCore(b,new Date('2026-08-18T14:00:00Z'));
    assert.equal(twice.zoneId,ZONE_EMPTY); assert.equal(twice.zoneChangeCount,2); assert.equal(twice.canChangeToday,false);
    // Next day resets: yesterday's selection does NOT leak as today's zone.
    const next=await getMyZoneStateCore(b,new Date('2026-08-19T12:00:00Z'));
    assert.equal(next.zoneId,null); assert.equal(next.canChangeToday,true);
  });
  await check("OWNER-ZONES: getDispatchZonesForOwnerCore lists inactive zones with full config + assigned-driver counts; guards non-owner", async () => {
    const INACTIVE=`qa-zone-off-${randomUUID()}`;
    await upsertZoneCore(actor,{id:INACTIVE,name:'QA Off Zone',lat:41.1,lng:-73.2,radiusMiles:9,tz:'America/New_York',active:false,sortOrder:9});
    const res=await getDispatchZonesForOwnerCore(actor);
    assert.equal(res.ok,true);
    const list=res.zones;
    const off=list.find(x=>x.id===INACTIVE); assert.ok(off); assert.equal(off.active,false); assert.equal(off.radiusMiles,9); assert.equal(off.sortOrder,9);
    const zin=list.find(x=>x.id===ZONE_IN);
    assert.equal(zin.active,true); assert.equal(zin.tz,'America/New_York'); assert.ok(Number(zin.assignedDriverCount)>=1); // DRIVER_A online today in ZONE_IN
    const empty=list.find(x=>x.id===ZONE_EMPTY); assert.equal(Number(empty.assignedDriverCount),0);
    const denied=await getDispatchZonesForOwnerCore({...actor,role:'contractor'});
    assert.equal(denied.ok,false); assert.equal(denied.message,'Owner access required.');
  });
  await check("ROSTER: getOwnerZoneDriverRosterCore exposes online/zone/active per contractor; guards non-owner", async () => {
    // Deterministic latest-day fixture: DRIVER_A online today (fixed future day sorts last);
    // DRIVER_B has no availability rows.
    await q`DELETE FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER_B}`;
    await q`INSERT INTO driver_availability_log(org_id,user_id,day,zone_id,session_started_at,zone_change_count) VALUES(${ORG},${DRIVER_A},'2026-08-20',${ZONE_IN},NOW(),1) ON CONFLICT ON CONSTRAINT driver_availability_log_pkey DO UPDATE SET zone_id=${ZONE_IN},session_started_at=NOW(),zone_change_count=1`;
    const res=await getOwnerZoneDriverRosterCore(actor);
    assert.equal(res.ok,true);
    const a=res.drivers.find(d=>d.userId===DRIVER_A);
    const b=res.drivers.find(d=>d.userId===DRIVER_B);
    assert.ok(a); assert.equal(a.online,true); assert.equal(a.zoneId,ZONE_IN); assert.equal(a.zoneName,'QA In Zone'); assert.equal(a.active,true);
    assert.ok(b); assert.equal(b.online,false); assert.equal(b.zoneId,null);
    const denied=await getOwnerZoneDriverRosterCore({...actor,role:'contractor'});
    assert.equal(denied.ok,false); assert.equal(denied.message,'Owner access required.');
  });
  await check("ZONE-METADATA: getZonesCore entries carry radiusMiles + tz for driver picker", async () => {
    const zones=await getZonesCore(actor);
    const z=zones.find(x=>x.id===ZONE_IN); const e=zones.find(x=>x.id===ZONE_EMPTY);
    assert.equal(z.radiusMiles,5); assert.equal(z.tz,'America/New_York');
    assert.equal(e.radiusMiles,2); assert.equal(e.tz,'America/New_York');
    // Inactive zone hidden from drivers (active=TRUE filter in getZonesCore).
    const OFF2=`qa-zone-off2-${randomUUID()}`;
    await upsertZoneCore(actor,{id:OFF2,name:'QA Off 2',lat:41.1,lng:-73.2,radiusMiles:9,tz:'America/New_York',active:false,sortOrder:9});
    assert.equal(zones.some(x=>x.id===OFF2),false);
    const again=await getZonesCore(actor); assert.equal(again.some(x=>x.id===OFF2),false);
  });
  await check("ZONE PREFERENCE IN UNDER-CAP PATH (id cannot mask it)", async () => {
    const candidates=[driver('910002',41.2,-73.2),driver('910001',41.2,-73.2)];
    const matches=new Map([['910002',true],['910001',false]]);
    const picked=await chooseBestDriverByRoad(candidates,41.208862,-73.207253,null,new Map(),{zoneMatches:matches});
    assert.equal(String(picked?.driver?.driverId),'910002');
  });
} finally {
  if(created){ assertQaOrg(ORG); await q`DELETE FROM organizations WHERE id=${ORG}`.catch(()=>{}); await q`DELETE FROM users WHERE id IN (${OWNER},${DRIVER_A},${DRIVER_B})`.catch(()=>{}); }
  const residue=await q`SELECT (SELECT count(*) FROM organizations WHERE id=${ORG}) orgs,(SELECT count(*) FROM users WHERE id IN (${OWNER},${DRIVER_A},${DRIVER_B})) users,(SELECT count(*) FROM dispatch_zones WHERE org_id=${ORG}) zones,(SELECT count(*) FROM driver_availability_log WHERE org_id=${ORG}) availability,(SELECT count(*) FROM dispatch_jobs WHERE org_id=${ORG}) jobs,(SELECT count(*) FROM audit_log WHERE org_id=${ORG}) audit`;
  const r=residue[0]; console.log(`cleanup: organizations=${r.orgs} users=${r.users} zones=${r.zones} availability=${r.availability} jobs=${r.jobs} audit=${r.audit}`);
  if(Object.values(r).some(v=>Number(v)>0)) process.exitCode=1;
}
console.log(`zone suite complete: ${checks.filter(x=>x[1]).length}/${checks.length}`);
if(checks.some(x=>!x[1])) process.exitCode=1;
