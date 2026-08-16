// B2.2 DB-backed compatibility lookup gates. QA orgs only; cleanup is scoped.
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { lookupBatteryCompatibilityCore } = await import("./src/data/battery-compat-core.ts");
await ensureSchema();
const checks=[]; const check=(name,v)=>{checks.push([name,!!v]);if(!v)throw Error(`FAIL: ${name}`)};
const org=`qa-b22-${randomUUID()}`, other=`qa-b22-other-${randomUUID()}`;
const owner=`qa-b22-owner-${randomUUID()}`;
const cleanup=async()=>{for (const table of ["battery_warranties","battery_install_photos","battery_inventory_ledger","battery_inventory","battery_sales","battery_install_types","battery_compatibility","battery_products"]) { await q.unsafe(`DELETE FROM ${table} WHERE org_id = $1 OR org_id = $2`,[org,other]); } await q`DELETE FROM organization_memberships WHERE org_id=${org} OR org_id=${other}`;await q`DELETE FROM users WHERE id=${owner}`;await q`DELETE FROM organizations WHERE id=${org} OR id=${other}`};
const product=async(o,g="47",active=true)=>q`INSERT INTO battery_products(id,org_id,group_size,display_name,retail_cents,installation_cents,warranty_years,free_replacement_years,core_charge_cents,availability,active) VALUES(gen_random_uuid()::text,${o},${g},'LIGHTNING GOLD BATTERY',20000,0,3,3,0,'in_stock',${active}) ON CONFLICT (org_id,group_size) DO NOTHING`;
const compat=async(o,{group="47",status="approved",trim=null,engine=null,from=2020,to=2025}={})=>{const insert=q`INSERT INTO battery_compatibility(id,org_id,make,model,year_from,year_to,trim,engine,battery_group_size,status,source_reference_internal) VALUES(gen_random_uuid()::text,${o},'FORD','F-150',${from},${to},${trim},${engine},${group},${status},'qa-source') RETURNING id`;return q.transaction([q`DELETE FROM battery_compatibility WHERE org_id=${o} AND lower(make)='ford' AND lower(model)='f-150' AND year_from=${from} AND year_to=${to} AND battery_group_size=${group} AND lower(COALESCE(trim,''))=lower(COALESCE(${trim},'')) AND lower(COALESCE(engine,''))=lower(COALESCE(${engine},''))`,insert]);};
try {
 await q`INSERT INTO organizations(id,name) VALUES(${org},'QA B2.2'),(${other},'QA B2.2 other')`; await q`INSERT INTO users(id,name,email,password_hash) VALUES(${owner},'QA owner',${owner+'@qa.local'},'x')`; await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${org},${owner},'owner')`; await product(org); await product(other);
 let r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022}); check('empty table review',r.ok&&r.outcome==='review'&&r.reason==='not_found');
 await compat(org,{status:'review'}); r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022}); check('review never matches',r.outcome==='review');
 await q`UPDATE battery_compatibility SET status='rejected' WHERE org_id=${org}`; r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022}); check('rejected never matches',r.outcome==='review');
 await compat(other); r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022}); check('wrong org never matches',r.outcome==='review');
 await compat(org); r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022}); check('one approved matches',r.ok&&r.outcome==='matched'&&r.match.batteryGroupSize==='47'&&Object.values(r.match).every(v=>v!==undefined));
 await compat(org,{group:'47',from:2021,to:2024}); r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022}); check('multiple same-group matches fail closed',r.outcome==='review'&&r.reason==='ambiguous');
 await q`DELETE FROM battery_compatibility WHERE org_id=${org}`; await compat(org,{trim:'XL'}); r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022}); check('missing trim fail closed',r.outcome==='review');
 await q`DELETE FROM battery_compatibility WHERE org_id=${org}`; await compat(org,{engine:'3.5L'}); r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022}); check('missing engine fail closed',r.outcome==='review');
 await q`DELETE FROM battery_compatibility WHERE org_id=${org}`; await compat(org,{from:2023,to:2025}); r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022}); check('year containment',r.outcome==='review'&&r.reason==='not_found');
 r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022,batteryGroupSize:'25'}); check('unsupported group review',r.outcome==='review'&&r.reason==='unsupported_group');
 await q`DELETE FROM battery_compatibility WHERE org_id=${org}`; await product(org,'48'); await compat(org,{group:'47'}); await compat(org,{group:'48'}); r=await lookupBatteryCompatibilityCore({orgId:org,role:'owner'},{make:'Ford',model:'F-150',year:2022}); check('multiple groups conflict fail closed',r.outcome==='review'&&r.reason==='conflict');
 let fk=false; try {await q`INSERT INTO battery_compatibility(id,org_id,make,model,year_from,year_to,battery_group_size,status) VALUES(gen_random_uuid()::text,${org},'X','Y',2020,2020,'25','approved')`} catch {fk=true} check('active product FK enforcement',fk);
 console.log(`PASS B2.2 (${checks.filter(x=>x[1]).length}/${checks.length} checks)`);
} finally {await cleanup()}
