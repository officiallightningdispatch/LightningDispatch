import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
const q = neon(process.env.DATABASE_URL);
const ORG = "89e15ce587651cc47c3bc45b1c612a220955";
const hav = (a,b,c,d) => { const R=3958.7613, p=Math.PI/180, x=(c-a)*p, y=(d-b)*p; const h=Math.sin(x/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(y/2)**2; return 2*R*Math.asin(Math.sqrt(h)); };
const cases = [
  ["Bridgeport CT",41.1792,-73.1894,"Bridgeport","America/New_York"],
  ["Austin-Georgetown corridor",30.6327,-97.6772,"Austin–Georgetown Corridor",null],
  ["Phoenix AZ",33.4484,-112.0740,"Phoenix","America/Phoenix"],
  ["Seattle WA",47.6062,-122.3321,"Seattle",null],
  ["rural ND",47.5,-100.0,null,null],
];
const rows = await q`SELECT id,name,state,zone_type,tz,lat,lng,radius_miles,parent_zone_id FROM dispatch_zones WHERE org_id=${ORG} AND active=true`;
assert.equal(rows.length,279,"expected 279 active production zones");
for (const [label,lat,lng,expected,tz] of cases) {
  const state = label.includes("CT") ? "CT" : label.includes("corridor") ? "TX" : label.includes("AZ") ? "AZ" : label.includes("WA") ? "WA" : "ND";
  const candidates = rows.filter(z => z.state===state && z.zone_type!=="coverage").map(z=>({...z,distance:hav(lat,lng,Number(z.lat),Number(z.lng))})).filter(z=>z.distance<=Number(z.radius_miles)).sort((a,b)=>a.distance-b.distance);
  const coverage = rows.filter(z=>z.state===state && z.zone_type==="coverage").sort((a,b)=>hav(lat,lng,Number(a.lat),Number(a.lng))-hav(lat,lng,Number(b.lat),Number(b.lng)))[0];
  const hit = candidates[0] ?? coverage;
  assert.ok(hit,`${label} resolved null`);
  if (expected) assert.equal(hit.name,expected,`${label} wrong zone`);
  if (tz) assert.equal(hit.tz,tz,`${label} wrong timezone`);
  console.log(JSON.stringify({input:label,lat,lng,resolved:{id:hit.id,name:hit.name,state:hit.state,zoneType:hit.zone_type,tz:hit.tz,distanceMiles:Number(hit.distance?.toFixed?.(3)??0),parentZoneId:hit.parent_zone_id},fallback:!candidates.length}));
}
console.log("resolution sanity: 5/5 PASS (read-only; no dispatch_jobs touched)");
