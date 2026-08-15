import { aggregateZoneMetrics } from './src/lib/zone-metrics.ts';
const check = (name, value) => { if (!value) throw new Error(`FAIL: ${name}`); console.log(`ok - ${name}`); };
const square = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]] });
const zone = { id:'poly', tz:'UTC', lat:0, lng:0, radius_miles:1, polygon_geojson:square(-1,-1,1,1) };
const metrics = aggregateZoneMetrics([zone], [{zone_id:'poly',user_id:'driver',day:'2026-01-01'}], [
  {status:'assigned',lat:0,lng:0}, {status:'new',lat:0,lng:1}, {status:'new',lat:0,lng:2}
], () => '2026-01-01').get('poly');
check('inside polygon aggregates demand', metrics.activeJobs === 1 && metrics.unassignedJobs === 1 && metrics.recentVolume24h === 2);
check('outside polygon excluded despite radial center', metrics.recentVolume24h === 2);
check('boundary is contained', aggregateZoneMetrics([zone], [], [{status:'new',lat:1,lng:0}], ()=>'2026-01-01').get('poly').unassignedJobs === 1);
const crossState = { ...zone, id:'cross', polygon_geojson:square(-101,30,-99,33) };
check('cross-state polygon uses geometry', aggregateZoneMetrics([crossState], [], [{status:'new',lat:31,lng:-100}], ()=>'2026-01-01').get('cross').unassignedJobs === 1);
const invalid = { ...zone, id:'invalid', polygon_geojson:{type:'Polygon',coordinates:[]} , lat:0,lng:0,radius_miles:1 };
check('invalid geometry falls back to radius', aggregateZoneMetrics([invalid], [], [{status:'new',lat:0,lng:0.01}], ()=>'2026-01-01').get('invalid').unassignedJobs === 1);
const missing = { ...zone, id:'missing', polygon_geojson:null, lat:0,lng:0,radius_miles:1 };
check('missing geometry falls back to radius', aggregateZoneMetrics([missing], [], [{status:'new',lat:0,lng:0.01}], ()=>'2026-01-01').get('missing').unassignedJobs === 1);
check('busyness is based on real aggregate', metrics.busyness === 'Busy' && metrics.availableDrivers === 1 && metrics.demandRatio === 2);
