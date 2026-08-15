import { pointInZone, zoneContainingPoint, validateZonePolygon } from './src/lib/zone-containment.ts';
const square={type:'Polygon',coordinates:[[[-73,41],[-72,41],[-72,42],[-73,42],[-73,41]]]};
const z={name:'CT-NY',sort_order:1,polygon_geojson:square,zip_codes:[],lat:0,lng:0,radius_miles:1};
let checks=0; const ok=(x,m)=>{if(!x)throw Error(m);checks++};
ok(pointInZone(z,41.5,-72.5),'inside'); ok(!pointInZone(z,40,-72.5),'outside');
const edge=pointInZone(z,41,-72.5); ok(typeof edge==='boolean','edge behavior'); ok(typeof pointInZone(z,41,-73)==='boolean','vertex behavior');
try{validateZonePolygon({type:'Polygon',coordinates:[[[0,0],[1,0],[0,0]]]});throw Error('accepted degenerate')}catch(e){ok(String(e).includes('4 positions'),'degenerate rejected')}
ok(pointInZone(z,41.5,-72.1),'cross-state polygon authoritative');
const zip={...z,polygon_geojson:null,zip_codes:['10001'],lat:0,lng:0,radius_miles:1}; ok(pointInZone(zip,0,0,'10001'),'zip'); ok(!pointInZone(zip,10,10,'99999'),'zip mismatch');
const circle={...zip,zip_codes:[],lat:0,lng:0,radius_miles:10}; ok(pointInZone(circle,0,0),'circle'); ok(!pointInZone(circle,1,1),'circle outside');
ok(zoneContainingPoint([{...circle,name:'later',sort_order:2},{...circle,name:'first',sort_order:1}],0,0)?.name==='first','sort precedence'); ok(zoneContainingPoint([{...circle,lat:50}],0,0)===null,'no match');
console.log(`ALL PASSED / ${checks} checks`);
