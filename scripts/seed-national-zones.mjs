#!/usr/bin/env bun
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
const ORG='89e15ce587651cc47c3bc45b1c612a220955';
if(!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const q=neon(process.env.DATABASE_URL), data=JSON.parse(fs.readFileSync(new URL('../src/data/national-zones.json',import.meta.url)));
const org=await q`SELECT id FROM organizations WHERE id=${ORG}`;
const remove=process.argv.includes('--remove');
if(org.length!==1) throw Error(`Refusing seed: production org ${ORG} was not verified`);
if(remove){ for(const z of data) await q`DELETE FROM dispatch_zones WHERE id=${'national-zone-'+z.key.replace(/[^A-Za-z0-9]+/g,'-').toLowerCase()} AND org_id=${ORG}`; console.log(JSON.stringify({removed:data.length})); process.exit(0); }
const ids=new Map(); const idFor=k=>'national-zone-'+k.replace(/[^A-Za-z0-9]+/g,'-').toLowerCase();
for(const z of data) ids.set(z.key,idFor(z.key));
for(const z of data){const id=ids.get(z.key), parent=z.parent?ids.get(z.parent):null; if(z.parent&&!parent) throw Error('missing parent '+z.parent);
 await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,parent_zone_id,lat,lng,radius_miles,tz,active,sort_order) VALUES(${id},${ORG},${z.name},${z.state},${z.market},${z.zone_type},${z.zip_codes??[]},${parent},${z.lat},${z.lng},${z.radius_miles},${z.tz},TRUE,${data.indexOf(z)}) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state,market=EXCLUDED.market,zone_type=EXCLUDED.zone_type,zip_codes=EXCLUDED.zip_codes,parent_zone_id=EXCLUDED.parent_zone_id,lat=EXCLUDED.lat,lng=EXCLUDED.lng,radius_miles=EXCLUDED.radius_miles,tz=EXCLUDED.tz,active=TRUE,sort_order=EXCLUDED.sort_order,updated_at=NOW() WHERE dispatch_zones.org_id=${ORG}`;
}
const c=await q`SELECT state,zone_type,count(*)::int n FROM dispatch_zones WHERE org_id=${ORG} GROUP BY state,zone_type ORDER BY state,zone_type`; console.log(JSON.stringify({seedRows:data.length,counts:c},null,2));
