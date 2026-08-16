// Hermetic B1 Lightning battery price-book regression tests.
// Run sequentially with DATABASE_URL=... bun battery-pricebook.test.mjs
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { listBatteryProductsCore, upsertBatteryProductCore, INTERNAL_FIELDS } = await import("./src/data/battery-pricebook-core.ts");
await ensureSchema();
const checks=[];
const check=(name, cond, extra="")=>{checks.push([name,Boolean(cond)]);if(!cond)throw new Error(`FAIL: ${name} ${extra}`)};
const PROD="89e15ce587651cc47c3bc45b1c612a220955";
const ORG=`qa-b1-pricebook-${randomUUID()}`;
const OWNER=`qa-b1-owner-${randomUUID()}`;
const DRIVER=`qa-b1-driver-${randomUUID()}`;
const cleanup=async()=>{
  await q`DELETE FROM audit_log WHERE org_id=${ORG} OR actor_user_id=${OWNER} OR actor_user_id=${DRIVER}`;
  await q`DELETE FROM battery_products WHERE org_id=${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`;
  await q`DELETE FROM users WHERE id=${OWNER} OR id=${DRIVER}`;
  await q`DELETE FROM organizations WHERE id=${ORG}`;
};
const seedRows=[
  ["24",23399,23499,"[]","24-DLG"],["24F",20899,20999,"[]","24F-DLG"],["27",22399,22499,"[]","27-DLG"],["34",20899,20999,"[]","34-DLG"],["35",21399,21499,"[]","35-DLG"],["47",21399,21499,"[\"H5\"]","H5-DLG"],["48",20899,20999,"[\"H6\"]","H6-DLG"],["49",23899,23999,"[\"H8\"]","H8-DLG"],["51R",21399,21499,"[]","51R-DLG"],["59",22399,22499,"[]","59-DLG"],["65",21399,21499,"[]","65-DLG"],["75",21399,21499,"[]","75-DLG"],["78",20899,20999,"[]","78-DLG"],["86",23399,23499,"[]","86FT-DLG"],["90",23899,23999,"[\"T5\"]","T5-DLG"],["94R",21399,21499,"[\"H7\"]","H7-DLG"],["95R",23899,23999,"[\"H9\"]","H9-DLG"],["96R",22899,22999,"[]","96R-DLG"],["101",22399,22499,"[\"Type S\"]","101-DLG"],["102R",23399,23499,"[\"V4\"]","V4-DLG"],["121R",22399,22499,"[]","121R-DLG"],["124R",21399,21499,"[]","124R-DLG"],["140R",22899,22999,"[\"H4\"]","H4-DLG"],["151R",22399,22499,"[]","151R-DLG"]
];
const seed=async(org)=>{
  for(const [g,ret,cost,aliases,part] of seedRows){
    await q`INSERT INTO battery_products(id,org_id,group_size,alternate_group_sizes,display_name,retail_cents,installation_cents,warranty_years,free_replacement_years,core_charge_cents,availability,active,source_reference_internal,source_brand,source_line,source_part_number,internal_cost_cents) VALUES(gen_random_uuid()::text,${org},${g},${aliases}::jsonb,'LIGHTNING GOLD BATTERY',${ret},0,3,3,0,'in_stock',true,'owner-csv','Duralast','Gold',${part},${cost}) ON CONFLICT(org_id,group_size) DO UPDATE SET retail_cents=EXCLUDED.retail_cents,alternate_group_sizes=EXCLUDED.alternate_group_sizes`;
  }
};
try {
  // A) authoritative migration-73 spot checks, read-only against the seeded org.
  const rows=await q`SELECT group_size,alternate_group_sizes,retail_cents,internal_cost_cents,warranty_years,free_replacement_years,core_charge_cents,availability,active,source_reference_internal,display_name,source_part_number FROM battery_products WHERE org_id=${PROD} AND group_size IN ('24','47','94R','101','51R','86') ORDER BY group_size`;
  const by=Object.fromEntries(rows.map(r=>[r.group_size,r]));
  check("csv: seeded spot-check groups exist",rows.length===6);
  check("csv: 24 retail/internal",by["24"]?.retail_cents===23399&&by["24"]?.internal_cost_cents===23499);
  check("csv: 47 retail/internal + H5",by["47"]?.retail_cents===21399&&by["47"]?.internal_cost_cents===21499&&JSON.stringify(by["47"]?.alternate_group_sizes)==='["H5"]');
  check("csv: 94R alias H7",JSON.stringify(by["94R"]?.alternate_group_sizes)==='["H7"]');
  check("csv: 101 alias Type S",JSON.stringify(by["101"]?.alternate_group_sizes)==='["Type S"]');
  check("csv: 51R has no alias",JSON.stringify(by["51R"]?.alternate_group_sizes)==='[]');
  check("csv: 86 part source",by["86"]?.source_part_number==="86FT-DLG");
  check("csv: shared defaults",rows.every(r=>r.warranty_years===3&&r.free_replacement_years===3&&r.core_charge_cents===0&&r.availability==='in_stock'&&r.active===true&&r.source_reference_internal==='owner-csv'&&r.display_name==='LIGHTNING GOLD BATTERY'));
  // B) QA-only replay of migration's idempotent upsert shape.
  await q`INSERT INTO organizations(id,name) VALUES(${ORG},'qa b1 pricebook')`;
  await seed(ORG); await seed(ORG);
  const count=await q`SELECT COUNT(*)::int AS n FROM battery_products WHERE org_id=${ORG}`;
  check("import: replay remains exactly 24 rows",count[0].n===24,String(count[0].n));
  check("import: groups 25 and 31 absent",(await q`SELECT COUNT(*)::int AS n FROM battery_products WHERE org_id=${ORG} AND group_size IN ('25','31')`)[0].n===0);
  // C) safe DTO and query leak guards.
  const safe=await listBatteryProductsCore(ORG);
  check("leak: safe DTO contains no internal keys",safe.every(x=>INTERNAL_FIELDS.every(k=>!Object.prototype.hasOwnProperty.call(x,k))));
  check("leak: safe DTO contains no supplier strings/parts",!JSON.stringify(safe).match(/Duralast|AutoZone|24-DLG/i));
  const core=await readFile("./src/data/battery-pricebook-core.ts","utf8");
  check("leak: list SELECT excludes internal columns",!core.match(/SELECT[^`]*?(source_reference_internal|internal_cost_cents|internal_margin_cents|source_brand|source_line|source_part_number)/s));
  // D) explicit owner edit is audited; contractor is rejected.
  const owner={orgId:ORG,id:OWNER,role:"owner"}; const driver={orgId:ORG,id:DRIVER,role:"contractor"};
  await q`INSERT INTO users(id,name,email,password_hash) VALUES(${OWNER},'QA owner',${OWNER+'@qa.local'},'x'),(${DRIVER},'QA driver',${DRIVER+'@qa.local'},'x')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG},${OWNER},'owner'),(${ORG},${DRIVER},'contractor')`;
  const edited=await upsertBatteryProductCore(owner,{groupSize:"24",retailCents:24000,availability:"in_stock",active:true,imageKey:null,warrantyYears:3,freeReplacementYears:3});
  check("owner: retail edit succeeds",edited.ok&&edited.product.retailCents===24000);
  const audit=await q`SELECT action,entity_id FROM audit_log WHERE org_id=${ORG} AND actor_user_id=${OWNER} ORDER BY occurred_at DESC LIMIT 1`;
  check("owner: audit action and entity",audit[0]?.action==='battery_product_upsert'&&String(audit[0]?.entity_id)===String(edited.product.id));
  const denied=await upsertBatteryProductCore(driver,{groupSize:"24",retailCents:1,availability:"in_stock",active:true,warrantyYears:3,freeReplacementYears:3});
  check("owner: contractor rejected",denied.ok===false);
  const added=await upsertBatteryProductCore(owner,{groupSize:"25",retailCents:25000,availability:"special_order",active:false,warrantyYears:3,freeReplacementYears:3});
  check("owner: explicit action can add group 25",added.ok&&added.product.groupSize==='25');
  check("import: group 25 only appears after explicit owner action",(await q`SELECT COUNT(*)::int AS n FROM battery_products WHERE org_id=${ORG} AND group_size='25'`)[0].n===1);
  console.log(`PASS B1 PRICE BOOK (${checks.filter(x=>x[1]).length}/${checks.length} checks)`);
} finally { await cleanup(); }
