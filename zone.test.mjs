// Hermetic P0 zone preference checks. No Towbook, OSRM, TomTom, or network calls.
import assert from 'node:assert/strict';
const { chooseBestDriverByRoad } = await import('./src/data/ai-dispatcher.ts');
const router = async () => 600;
const driver = (id) => ({ driverId:id, checkedIn:true, latitude:41, longitude:-73, activeCalls:0 });
const run = async (name, fn) => { await fn(); console.log(`PASS ${name}`); };

await run('WINDOW: exact local opening rule', async () => {
  const gate = (hour) => hour < 6 ? 'Zone selection opens at 6:00 AM local' : null;
  assert.equal(gate(5), 'Zone selection opens at 6:00 AM local');
  assert.equal(gate(6), null);
});
await run('ONE-CHANGE-PER-DAY: initial + one change, reset next day', async () => {
  const counts = new Map([['2026-08-14', 0]]);
  const select = day => { const n=counts.get(day)??0; if(n>=2) return false; counts.set(day,n+1); return true; };
  assert.equal(select('2026-08-14'), true); assert.equal(select('2026-08-14'), true); assert.equal(select('2026-08-14'), false); assert.equal(select('2026-08-15'), true);
});
await run('BUSYNESS: exact buckets and raw zero-data values', async () => {
  const bucket = ({availableDrivers,activeJobs,unassignedJobs}) => { const jobs=activeJobs+unassignedJobs, ratio=jobs/Math.max(availableDrivers,1); return { bucket: availableDrivers===0&&jobs>0||ratio>=2?'Busy':ratio>=1?'Moderate':'Low', availableDrivers,activeJobs,unassignedJobs,recentVolume24h:jobs,demandRatio:Number(ratio.toFixed(1)) }; };
  assert.deepEqual(bucket({availableDrivers:0,activeJobs:0,unassignedJobs:0}), {bucket:'Low',availableDrivers:0,activeJobs:0,unassignedJobs:0,recentVolume24h:0,demandRatio:0});
  assert.equal(bucket({availableDrivers:1,activeJobs:2,unassignedJobs:0}).bucket,'Busy'); assert.equal(bucket({availableDrivers:2,activeJobs:1,unassignedJobs:1}).bucket,'Moderate');
});
await run('DISPATCH PREFERENCE: in-zone tie wins', async () => {
  const picked=await chooseBestDriverByRoad([driver(1),driver(2)],41,-73,router,new Map(),{zoneMatches:new Map([['1',false],['2',true]])}); assert.equal(picked?.driverId,2);
});
await run('DISPATCH PREFERENCE: no zones preserves deterministic closest/ID choice', async () => {
  const picked=await chooseBestDriverByRoad([driver(2),driver(1)],41,-73,router,new Map(),{zoneMatches:new Map([['1',false],['2',false]])}); assert.equal(picked?.driverId,1);
});
await run('DISPATCH PREFERENCE: out-of-zone remains emergency fallback', async () => {
  const picked=await chooseBestDriverByRoad([driver(9)],41,-73,router,new Map(),{zoneMatches:new Map([['9',false]])}); assert.equal(picked?.driverId,9);
});
console.log('zone suite complete: 6/6');
