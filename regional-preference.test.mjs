// P0 Slice 4: DB-backed regional preference and dispatch ranking coverage.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { loadRegionalPreferenceMatches, chooseBestDriverByRoad } = await import("./src/data/ai-dispatcher.ts");
const ORG = `qa-regional-${randomUUID()}`;
const OWNER = `qa-regional-owner-${randomUUID()}`;
const driver = (id, lat, lng) => ({ driverId: id, isCheckedIn: true, latitude: lat, longitude: lng, estimatedTimeSeconds: 600 });
const offline = (id, lat, lng) => ({ ...driver(id, lat, lng), isCheckedIn: false });
const checks = [];
async function check(name, fn) { try { await fn(); checks.push([name, true]); console.log(`PASS ${name}`); } catch (e) { checks.push([name, false]); console.error(`FAIL ${name}: ${e.message}`); throw e; } }
const config = { core_centers: [{ name: "Bridgeport", lat: 41.1792, lng: -73.1894, radius_miles: 4 }, { name: "Milford", lat: 41.2307, lng: -73.064, radius_miles: 4 }], nearby_centers: [{ name: "Stratford", lat: 41.2043, lng: -73.1332, radius_miles: 3 }, { name: "Fairfield", lat: 41.1412, lng: -73.2637, radius_miles: 3 }, { name: "Orange", lat: 41.2787, lng: -73.0257, radius_miles: 3 }, { name: "Shelton", lat: 41.3165, lng: -73.0932, radius_miles: 3 }, { name: "Trumbull", lat: 41.2429, lng: -73.2007, radius_miles: 3 }, { name: "West Haven", lat: 41.2707, lng: -72.947, radius_miles: 3 }], priority_weight: 1, nearby_weight: 0.5, max_backlog_before_waive: 2, enabled: true };
const pick = (candidates, lat, lng, queues = new Map(), area = {}) => chooseBestDriverByRoad(candidates, lat, lng, null, queues, area);
let created = false;
try {
  await ensureSchema();
  await q`INSERT INTO organizations(id,name) VALUES(${ORG},'QA regional preference')`;
  await q`INSERT INTO users(id,name,email,password_hash,towbook_driver_id) VALUES(${OWNER},'QA owner',${OWNER+'@qa.local'},'x',NULL)`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG},${OWNER},'owner')`;
  await q`INSERT INTO driver_region_preferences (org_id, driver_id, config, enabled) VALUES (${ORG}, '910001', ${JSON.stringify(config)}::jsonb, TRUE)`;
  created = true;
  await check("T1 CORE WINS", async () => {
    const candidates = [driver("910001",41.2,-73.2), driver("910002",41.2,-73.2)];
    const m = await loadRegionalPreferenceMatches(ORG,candidates,41.1792,-73.1894,new Map());
    assert.equal(m.get("910001"),1); assert.equal(m.get("910002"),undefined);
    assert.equal(String((await pick(candidates,41.1792,-73.1894,new Map(),{regionalPreference:m}))?.driver?.driverId),"910001");
    const none = new Map(); const reversed = [candidates[1],candidates[0]];
    assert.equal(String((await pick(reversed,41.1792,-73.1894,new Map(),{regionalPreference:none}))?.driver?.driverId),"910001");
  });
  await check("T2 NEARBY WINS WEAKER / CORE BEATS NEARBY", async () => {
    const candidates=[driver("910001",41.2,-73.2),driver("910002",41.2,-73.2)];
    // Stratford is geographically inside the supplied 4-mile Bridgeport circle;
    // narrow the fixture core radius for this nearby-only assertion so the
    // intended weaker nearby tier is isolated without changing production code.
    await q`UPDATE driver_region_preferences SET config=${JSON.stringify({...config, core_centers: config.core_centers.map((x) => ({...x, radius_miles: 3}))})}::jsonb WHERE org_id=${ORG} AND driver_id='910001'`;
    let m=await loadRegionalPreferenceMatches(ORG,candidates,41.2043,-73.1332,new Map());
    assert.equal(m.get("910001"),0.5); assert.equal(String((await pick(candidates,41.2043,-73.1332,new Map(),{regionalPreference:m}))?.driver?.driverId),"910001");
    await q`INSERT INTO driver_region_preferences (org_id, driver_id, config, enabled) VALUES (${ORG}, '910002', ${JSON.stringify({...config,core_centers:[{name:'Stratford',lat:41.2043,lng:-73.1332,radius_miles:4}]} )}::jsonb, TRUE)`;
    m=await loadRegionalPreferenceMatches(ORG,candidates,41.2043,-73.1332,new Map()); assert.equal(m.get("910002"),1);
    assert.equal(String((await pick(candidates,41.2043,-73.1332,new Map(),{regionalPreference:m}))?.driver?.driverId),"910002");
  });
  await check("T3 OUT-OF-REGION STILL POSSIBLE", async () => {
    const c=[driver("910002",40,-75),driver("910001",40,-75)]; const m=await loadRegionalPreferenceMatches(ORG,c,40,-75,new Map());
    assert.equal(m.has("910001"),false); assert.equal(m.get("910001"),undefined); assert.equal(String((await pick(c,40,-75,new Map(),{regionalPreference:m}))?.driver?.driverId),"910001");
    assert.equal(String((await pick([c[0]],40,-75,new Map(),{regionalPreference:m}))?.driver?.driverId),"910002");
  });
  await check("T4 ETA/LOAD OVERRIDE", async () => {
    const m=new Map([["910001",1],["910002",0]]);
    assert.equal(String((await pick([driver("910002",41.2,-73.2),driver("910001",41.3,-73.3)],41.1792,-73.1894,new Map(),{regionalPreference:m}))?.driver?.driverId),"910002");
    const c=[driver("910001",41.2,-73.2),driver("910002",41.2,-73.2)]; let loaded=new Map([["910001",{activeCount:3,queuedJobs:[]}]]);
    let waived=await loadRegionalPreferenceMatches(ORG,c,41.1792,-73.1894,loaded); assert.equal(waived.has("910001"),false); assert.equal(waived.get("910001"),undefined); assert.equal(String((await pick(c,41.1792,-73.1894,loaded,{regionalPreference:waived}))?.driver?.driverId),"910002");
    loaded=new Map([["910001",{activeCount:2,queuedJobs:[]}]]); const present=await loadRegionalPreferenceMatches(ORG,c,41.1792,-73.1894,loaded); assert.equal(present.get("910001"),1);
  });
  await check("T5 RAILS NEVER WEAKENED", async () => {
    const c=[offline("910001",41.2,-73.2),driver("910002",41.2,-73.2)]; const m=new Map([["910001",1],["910002",0]]);
    assert.equal(String((await pick(c,41.1792,-73.1894,new Map(),{regionalPreference:m}))?.driver?.driverId),"910002");
  });
  await check("T6 ZONE OUTRANKS REGION + RECALC", async () => {
    const c=[driver("910001",41.2,-73.2),driver("910002",41.2,-73.2)]; const area={zoneMatches:new Map([["910002",true],["910001",false]]),regionalPreference:new Map([["910001",1],["910002",0]])};
    const a=await pick(c,41.1792,-73.1894,new Map(),area); const b=await pick(c,41.1792,-73.1894,new Map(),area);
    assert.equal(String(a?.driver?.driverId),"910002"); assert.equal(String(b?.driver?.driverId),"910002");
  });
} finally {
  if (created) { assertQaOrg(ORG); await q`DELETE FROM organizations WHERE id=${ORG}`.catch(()=>{}); await q`DELETE FROM users WHERE id=${OWNER}`.catch(()=>{}); }
  const r=(await q`SELECT (SELECT count(*) FROM organizations WHERE id=${ORG}) orgs,(SELECT count(*) FROM driver_region_preferences WHERE org_id=${ORG}) prefs`).at(0); console.log(`cleanup: organizations=${r.orgs} preferences=${r.prefs}`); if(Object.values(r).some(v=>Number(v)>0)) process.exitCode=1;
}
console.log(`regional preference suite complete: ${checks.filter(x=>x[1]).length}/${checks.length}`);
if(checks.some(x=>!x[1])) process.exitCode=1;
