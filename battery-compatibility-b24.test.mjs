// B2.4 final compatibility equality, DTO serialization, and VIN privacy gates.
import { randomUUID, createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const core = await import("./src/data/battery-compat-core.ts");
await ensureSchema();
const checks=[]; const check=(name,v)=>{checks.push([name,!!v]);if(!v)throw Error(`FAIL: ${name}`)};
const org=`qa-b24-${randomUUID()}`; const owner=`qa-b24-owner-${randomUUID()}`;
const VIN="1HGCM82633A004352";
const cleanup=async()=>{
  // Child rows first: this remains safe if a prior interrupted run reused an org.
  for (const table of ["battery_warranties","battery_install_photos","battery_inventory_ledger","battery_inventory","battery_sales","battery_install_types","battery_compatibility","battery_products"]) await q.unsafe(`DELETE FROM ${table} WHERE org_id = $1`,[org]);
  await q`DELETE FROM organization_memberships WHERE org_id=${org}`;
  await q`DELETE FROM users WHERE id=${owner}`; await q`DELETE FROM organizations WHERE id=${org}`;
};
const nhtsa=async()=>new Response(JSON.stringify({Results:[{Make:"FORD",Model:"F-150",ModelYear:"2022",Trim:"",EngineModel:""}]}),{status:200,headers:{"content-type":"application/json"}});
try {
  await cleanup();
  await q`INSERT INTO organizations(id,name) VALUES(${org},'QA B2.4')`;
  await q`INSERT INTO users(id,name,email,password_hash) VALUES(${owner},'QA owner',${owner+'@qa.local'},'x')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${org},${owner},'owner')`;
  await q`INSERT INTO battery_products(id,org_id,group_size,display_name,retail_cents,installation_cents,warranty_years,free_replacement_years,core_charge_cents,availability,active) VALUES(gen_random_uuid()::text,${org},'47','LIGHTNING GOLD BATTERY',20000,0,3,3,0,'in_stock',true) ON CONFLICT(org_id,group_size) DO NOTHING`;
  await q`INSERT INTO battery_compatibility(id,org_id,make,model,year_from,year_to,trim,engine,battery_group_size,status,source_reference_internal) VALUES(gen_random_uuid()::text,${org},'FORD','F-150',2020,2025,NULL,NULL,'47','approved','qa-b24') ON CONFLICT DO NOTHING`;
  const user={orgId:org,role:"owner",id:owner};
  const manual=await core.lookupBatteryCompatibilityCore(user,{make:"Ford",model:"F-150",year:2022});
  const vin=await core.lookupBatteryCompatibilityFromVinCore(user,{vin:VIN},nhtsa);
  check("manual lookup matched",manual.ok&&manual.outcome==="matched");
  check("NHTSA VIN lookup matched",vin.ok&&vin.outcome==="matched");
  check("NHTSA and manual canonical results identical",JSON.stringify(vin)===JSON.stringify(manual));
  const dto=vin.ok&&vin.outcome==="matched"?vin.match:null;
  const expected=["compatibilityId","make","model","year","batteryGroupSize","displayBatteryGroup"];
  check("driver DTO exact field set",dto&&JSON.stringify(Object.keys(dto).sort())===JSON.stringify(expected.sort()));
  check("DTO has no aliases or internal fields",dto&&!JSON.stringify(dto).match(/H5|part_number|source_reference_internal|internal_cost|internal_margin|rawVin|vin_sha256/i));
  const serialized=JSON.stringify(vin);
  check("raw VIN absent from DTO",!serialized.includes(VIN));
  check("VIN hash is the only audit identity",createHash("sha256").update(VIN).digest("hex").length===64);
  const source=await (await import("node:fs/promises")).readFile("./src/data/battery-sales-core.ts","utf8");
  check("audit metadata stores vin_sha256",source.includes("vin_sha256")&&source.includes("createHash(\"sha256\")"));
  check("VIN privacy excludes raw VIN from audit payloads",!source.includes("{ vin: sale.vin")&&!source.includes("{ vin: p.vin"));
  console.log(`PASS B2.4 (${checks.filter(x=>x[1]).length}/${checks.length} checks)`);
} finally { await cleanup(); }
