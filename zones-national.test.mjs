// National zone system pass 2a: schema, hierarchy, CRUD, filters, isolation, stats.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { upsertZoneCore, getDispatchZonesForOwnerCore } = await import("./src/data/zones-core.ts");
const A=`qa-national-a-${randomUUID()}`, B=`qa-national-b-${randomUUID()}`;
const OWNER=`qa-national-owner-${randomUUID()}`, OTHER=`qa-national-other-${randomUUID()}`;
const actor={orgId:A,id:OWNER,role:"owner"};
const id=()=>`qa-national-zone-${randomUUID()}`;
const checks=[];
async function check(name,fn){try{await fn();checks.push([name,true]);console.log(`PASS ${name}`)}catch(e){checks.push([name,false]);console.error(`FAIL ${name}: ${e.message}`);throw e}}
let created=false;
try {
 await ensureSchema();
 await q`INSERT INTO organizations(id,name) VALUES(${A},'QA national A'),(${B},'QA national B')`;
 await q`INSERT INTO users(id,name,email,password_hash) VALUES(${OWNER},'QA national owner',${OWNER+'@qa.local'},'x'),(${OTHER},'QA other owner',${OTHER+'@qa.local'},'x')`;
 await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${A},${OWNER},'owner'),(${B},${OTHER},'owner')`; created=true;
 await check('SCHEMA: national columns, NOT NULL, CHECK, indexes, parent FK',async()=>{
  const cols=await q`SELECT column_name,is_nullable FROM information_schema.columns WHERE table_name='dispatch_zones' AND column_name IN ('state','market','zone_type','zip_codes','parent_zone_id')`;
  assert.equal(cols.length,5); assert.equal(cols.find(x=>x.column_name==='state').is_nullable,'NO');
  await assert.rejects(()=>q`INSERT INTO dispatch_zones(id,org_id,name,state,zone_type,lat,lng) VALUES(${id()},${A},'bad','TX','invalid',30,-97)`);
  const idx=await q`SELECT indexname FROM pg_indexes WHERE tablename='dispatch_zones' AND indexname IN ('dispatch_zones_org_state_active_idx','dispatch_zones_zip_codes_gin_idx','dispatch_zones_parent_idx','dispatch_zones_geo_idx')`;
  assert.equal(idx.length,4);
  const fk=await q`SELECT confdeltype FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.conrelid='dispatch_zones'::regclass AND a.attname='parent_zone_id'`;
  assert.ok(fk.some(x=>x.confdeltype==='n'));
 });
 const tx=id(),ct=id();
 await check('CRUD: TX national fields round-trip and update timestamp',async()=>{
  assert.deepEqual(await upsertZoneCore(actor,{id:tx,name:'Austin',state:'TX',market:'Austin',zoneType:'market',zipCodes:['78626','78701'],parentZoneId:null,lat:30.2672,lng:-97.7431}),{ok:true,id:tx});
  let r=await getDispatchZonesForOwnerCore(actor);let z=r.zones.find(x=>x.id===tx); assert.equal(z.state,'TX');assert.equal(z.market,'Austin');assert.equal(z.zoneType,'market');assert.deepEqual(z.zipCodes,['78626','78701']);assert.equal(z.parentZoneId,null);
  const before=(await q`SELECT updated_at FROM dispatch_zones WHERE id=${tx}`)[0].updated_at; await q`SELECT pg_sleep(1.1)`;
  await upsertZoneCore(actor,{id:tx,name:'Austin Updated',state:'TX',market:'Austin Metro',zoneType:'market',zipCodes:['78701'],parentZoneId:null,lat:30.2672,lng:-97.7431});
  const after=(await q`SELECT updated_at FROM dispatch_zones WHERE id=${tx}`)[0].updated_at; assert.notEqual(String(before),String(after));
 });
 await upsertZoneCore(actor,{id:ct,name:'Bridgeport',state:'CT',market:'Bridgeport',zoneType:'market',zipCodes:['06601'],lat:41.18,lng:-73.19});
 await check('STATE FILTER: TX only and unfiltered all',async()=>{const txs=await getDispatchZonesForOwnerCore(actor,'TX');assert.ok(txs.zones.length>0&&txs.zones.every(z=>z.state==='TX'));const all=await getDispatchZonesForOwnerCore(actor);assert.ok(all.zones.some(z=>z.id===tx)&&all.zones.some(z=>z.id===ct))});
 await check('HIERARCHY: invalid parent cases and valid US/state/market chain',async()=>{
  const self=await upsertZoneCore(actor,{id:id(),name:'self',state:'TX',lat:30,lng:-97,parentZoneId:'x'}); // replaced below with true self
  const selfId=id(); assert.equal((await upsertZoneCore(actor,{id:selfId,name:'self',state:'TX',lat:30,lng:-97,parentZoneId:selfId})).ok,false);
  const foreign=id();await upsertZoneCore({orgId:B,id:OTHER,role:'owner'},{id:foreign,name:'foreign',state:'TX',lat:30,lng:-97});
  assert.equal((await upsertZoneCore(actor,{id:id(),name:'foreign child',state:'TX',lat:30,lng:-97,parentZoneId:foreign})).ok,false);
  assert.equal((await upsertZoneCore(actor,{id:id(),name:'cross state',state:'CT',lat:30,lng:-97,parentZoneId:tx})).ok,false);
  const aa=id(),bb=id();await upsertZoneCore(actor,{id:aa,name:'A',state:'TX',lat:30,lng:-97});await upsertZoneCore(actor,{id:bb,name:'B',state:'TX',lat:30,lng:-97,parentZoneId:aa});assert.equal((await upsertZoneCore(actor,{id:aa,name:'A',state:'TX',lat:30,lng:-97,parentZoneId:bb})).ok,false);
  const us=id(), st=id(), market=id(); assert.equal((await upsertZoneCore(actor,{id:us,name:'United States',state:'US',zoneType:'coverage',lat:39,lng:-98})).ok,true); assert.equal((await upsertZoneCore(actor,{id:st,name:'Texas',state:'TX',parentZoneId:us,zoneType:'coverage',lat:31,lng:-99})).ok,true);
  assert.equal((await upsertZoneCore(actor,{id:market,name:'Austin market',state:'TX',parentZoneId:st,lat:30,lng:-97})).ok,true);
 });
 await check('ORG ISOLATION: owner B cannot list org A zones',async()=>{const r=await getDispatchZonesForOwnerCore({orgId:B,id:OTHER,role:'owner'});assert.equal(r.ok,true);assert.equal(r.zones.some(z=>z.id===tx),false)});
 await check('STATS: owner listing exposes numeric real-data fields',async()=>{const r=await getDispatchZonesForOwnerCore(actor);const z=r.zones.find(x=>x.id===tx);for(const k of ['jobsByZone','availableDriversByZone','recentVolume24h','availableDrivers'])assert.equal(typeof z[k],'number')});
 await check('STATE REQUIRED: omitted state is rejected, no CT default',async()=>{await assert.rejects(()=>upsertZoneCore(actor,{id:id(),name:'Missing state',lat:41,lng:-73}),{message:'State is required.'});await assert.rejects(()=>upsertZoneCore(actor,{id:id(),name:'Blank state',state:'  ',lat:41,lng:-73}),{message:'State is required.'})});
 await check('REGRESSION: valid upsert defaults zone type to market',async()=>{const r=await upsertZoneCore(actor,{id:id(),name:'Valid regression',state:'CT',lat:41,lng:-73});assert.equal(r.ok,true);const z=(await getDispatchZonesForOwnerCore(actor)).zones.find(x=>x.id===r.id);assert.equal(z.zoneType,'market')});
} finally { if(created){assertQaOrg(A);assertQaOrg(B);await q`DELETE FROM organizations WHERE id IN (${A},${B})`.catch(()=>{});await q`DELETE FROM users WHERE id IN (${OWNER},${OTHER})`.catch(()=>{})} }
console.log(`zones-national suite complete: ${checks.filter(x=>x[1]).length}/${checks.length}`);if(checks.some(x=>!x[1]))process.exitCode=1;
