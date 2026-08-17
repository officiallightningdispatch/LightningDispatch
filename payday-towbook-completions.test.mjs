// Hermetic payday completion timestamp regression coverage. Sequential by design; run with:
//   bun payday-towbook-completions.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
const { normalizeTowbookCompletionTime } = await import('./src/data/server.ts');
const samples = [
  [{ completionTime: '2026-08-12T11:16:00' }, '2026-08-12T15:16:00.000Z'],
  [{ completionTime: '2026-01-12T11:16:00' }, '2026-01-12T16:16:00.000Z'],
  [{ completionTime: '2026-08-12T11:16:00-04:00' }, '2026-08-12T15:16:00.000Z'],
  [{ completionTime: '  ' }, null], [null, null], ['x', null], [{ completionTime: 'garbage' }, null],
];
test('Towbook completionTime normalizes ET wall-clock and rejects garbage', () => {
  for (const [raw, expected] of samples) assert.equal(normalizeTowbookCompletionTime(raw), expected);
});
test('migration 72 is an idempotent NULL-only authoritative backfill', async () => {
  const source = await Bun.file('./src/data/migrations.ts').text();
  const at = source.indexOf('// 72: repair Towbook completion instants');
  assert.ok(at > source.indexOf('[71,'));
  const block = source.slice(at, source.indexOf('  }],', at));
  assert.match(block, /completed_at = .*AT TIME ZONE 'America\/New_York'/);
  assert.match(block, /completed_at IS NULL/);
  assert.match(block, /completionTime/);
  assert.equal((source.match(/\[72, async/g) || []).length, 1);
});
test('payday semantics are status, org, and normalized completion timestamp scoped', () => {
  const rows = [
    { org: 'a', status: 'completed', driver: 'levi', completed: '2026-08-12T15:16:00.000Z' },
    { org: 'a', status: 'cancelled', driver: 'levi', completed: '2026-08-12T15:16:00.000Z' },
    { org: 'b', status: 'completed', driver: 'levi', completed: '2026-08-12T15:16:00.000Z' },
  ];
  const start = Date.parse('2026-08-10T04:00:00Z'), end = Date.parse('2026-08-17T03:59:59.999Z');
  const counts = rows.filter(r => r.org === 'a' && r.status === 'completed' && Date.parse(r.completed) >= start && Date.parse(r.completed) <= end).length;
  assert.equal(counts, 1);
});
