import fs from 'node:fs';

const states = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);
const path = new URL('../src/data/national-zones.json', import.meta.url);
const zones = JSON.parse(fs.readFileSync(path, 'utf8'));
const zips = JSON.parse(fs.readFileSync(new URL('../src/data/us-zips.json', import.meta.url), 'utf8'));
const hav = (lat1, lng1, lat2, lng2) => { const r=Math.PI/180, x=(lat2-lat1)*r, y=(lng2-lng1)*r; const q=Math.sin(x/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(y/2)**2; return 3958.8*2*Math.asin(Math.sqrt(q)); };
for (const state of states) {
  const leaf = zones.filter(z => z.state === state && z.zone_type !== 'coverage' && z.zone_type !== 'corridor');
  if (!leaf.length) continue;
  for (const z of leaf) z.zip_codes = [];
  for (const [zip, v] of Object.entries(zips)) {
    if (v[1] !== state) continue;
    leaf.reduce((a,b) => hav(v[2],v[3],a.lat,a.lng) <= hav(v[2],v[3],b.lat,b.lng) ? a : b).zip_codes.push(zip);
  }
  for (const z of leaf) {
    const others = leaf.filter(x => x !== z).map(x => hav(z.lat,z.lng,x.lat,x.lng));
    const nearest = others.length ? Math.min(...others) : Infinity;
    z.radius_miles = Math.round(Math.max(10, Number.isFinite(nearest) ? nearest / 2 : 10) * 10) / 10;
    z.parent = `${state}|coverage|STATE`;
  }
}
for (const z of zones) if (z.zone_type === 'coverage') z.zip_codes = [];
fs.writeFileSync(path, JSON.stringify(zones, null, 2) + '\n');
const leaves = zones.filter(z => z.zone_type !== 'coverage' && z.zone_type !== 'corridor');
const assigned = new Set(leaves.flatMap(z => z.zip_codes));
console.log(JSON.stringify({ zips:Object.keys(zips).length, zones:zones.length, noncoverage:leaves.length, assigned:assigned.size, zero:leaves.filter(z=>!z.zip_codes.length).length, max:Math.max(...zones.map(z=>z.zip_codes?.length||0)) }));
if (assigned.size !== Object.keys(zips).length || leaves.some(z=>!z.zip_codes.length)) process.exit(1);
