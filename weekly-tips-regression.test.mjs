import assert from 'node:assert/strict';
// Pure aggregation contract used by the server query: every roster driver is
// represented, including zero, and the half-open Mon-Sun boundary is exact.
export function aggregateWeeklyTips(drivers, tips, start, end) {
  const out = new Map(drivers.map((d) => [d.id, { ...d, tipsCents: 0, tipCount: 0 }]));
  for (const t of tips) if (t.status === 'paid' && t.createdAt >= start && t.createdAt < end && out.has(t.driverId)) { const row = out.get(t.driverId); row.tipsCents += t.amountCents; row.tipCount++; }
  return [...out.values()];
}
const rows = aggregateWeeklyTips([{id:'a',name:'A'},{id:'b',name:'B'}], [{driverId:'a',amountCents:125,status:'paid',createdAt:'2026-08-17T00:00:00Z'},{driverId:'a',amountCents:75,status:'paid',createdAt:'2026-08-23T23:59:59.999Z'},{driverId:'b',amountCents:999,status:'failed',createdAt:'2026-08-18T00:00:00Z'},{driverId:'a',amountCents:500,status:'paid',createdAt:'2026-08-24T00:00:00Z'}], '2026-08-17T00:00:00Z','2026-08-24T00:00:00Z');
assert.deepEqual(rows, [{id:'a',name:'A',tipsCents:200,tipCount:2},{id:'b',name:'B',tipsCents:0,tipCount:0}]);
console.log('weekly tips regression: 1 passed');
