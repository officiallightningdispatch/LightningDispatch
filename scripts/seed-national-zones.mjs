#!/usr/bin/env bun
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
const DEFAULT_ORG='89e15ce587651cc47c3bc45b1c612a220955';
const argOrg=process.argv.find((x,i)=>x==='--org' && process.argv[i+1]) ? process.argv[process.argv.indexOf('--org')+1] : process.argv.find(x=>x.startsWith('--org='))?.slice(6);
const ORG=argOrg || DEFAULT_ORG;
if(!/^[a-f0-9]{32,40}$/.test(ORG)) throw Error('Refusing seed: invalid org id');
if(!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const q=neon(process.env.DATABASE_URL), data=JSON.parse(fs.readFileSync(new URL('../src/data/national-zones.json',import.meta.url)));
const org=await q`SELECT id FROM organizations WHERE id=${ORG}`;
const remove=process.argv.includes('--remove');
if(org.length!==1) throw Error(`Refusing seed: org ${ORG} was not verified`);
const idFor=k=>'national-zone-'+k.replace(/[^A-Za-z0-9]+/g,'-').toLowerCase();
if(remove){ for(const z of data) await q`DELETE FROM dispatch_zones WHERE id=${idFor(z.key)} AND org_id=${ORG}`; console.log(JSON.stringify({removed:data.length,org:ORG})); process.exit(0); }
const ids=new Map(data.map(z=>[z.key,idFor(z.key)]));
for(const z of data){
  const parent=z.parent?ids.get(z.parent):null; if(z.parent&&!parent) throw Error('missing parent '+z.parent);
  const radius=Number.isFinite(Number(z.radius_miles)) ? Number(z.radius_miles) : 10;
  const hierarchy = z.zone_type === 'coverage' || z.zone_type === 'US' || z.zone_type === 'state' || z.zone_type === 'county';
  const active = hierarchy ? true : false;
  await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order) VALUES(${ids.get(z.key)},${ORG},${z.name},${z.state},${z.market},${z.zone_type},${z.zip_codes??[]},${parent},${z.lat},${z.lng},${radius},${z.tz},${active},${data.indexOf(z)}) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state,market=EXCLUDED.market,zone_type=EXCLUDED.zone_type,zip_codes=EXCLUDED.zip_codes,parent_zone_id=EXCLUDED.parent_zone_id,lat=EXCLUDED.lat,lng=EXCLUDED.lng,radius_miles=EXCLUDED.radius_miles,tz=EXCLUDED.tz,sort_order=EXCLUDED.sort_order,updated_at=NOW() WHERE dispatch_zones.org_id=${ORG}`;
}
const known=[...ids.values()];
const deactivated=await q`UPDATE dispatch_zones SET active=FALSE,zip_codes=ARRAY[]::text[],updated_at=NOW() WHERE org_id=${ORG} AND zone_type <> 'coverage' AND NOT (id = ANY(${known})) RETURNING id,name`;
const c=await q`SELECT state,zone_type,count(*)::int n FROM dispatch_zones WHERE org_id=${ORG} GROUP BY state,zone_type ORDER BY state,zone_type`;
console.log(JSON.stringify({org:ORG,seedRows:data.length,deactivated:deactivated.map(x=>x.name),counts:c},null,2));
