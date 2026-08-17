import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./src/data/migrations.ts', import.meta.url), 'utf8');
const versions = [...source.matchAll(/^\s*\[(\d+),\s*async\s*\(q\)\s*=>/gm)].map((m) => Number(m[1]));

test('migration catalog is unique and source-ordered', () => {
  assert.ok(versions.length > 50);
  assert.equal(Math.max(...versions), 72);
  assert.equal(new Set(versions).size, versions.length, 'duplicate migration version');
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b), 'catalog source order must be strictly ascending');
  assert.deepEqual(versions.slice(-8), [65, 66, 67, 68, 69, 70, 71, 72]);
});

test('late migration dependencies are ordered after their owners', () => {
  const at = (v) => versions.indexOf(v);
  // 51 creates zones before 54/55/56 alter them; 52 creates preferences before 53 seeds.
  assert.ok(at(51) < at(54));
  assert.ok(at(51) < at(55));
  assert.ok(at(55) < at(56));
  assert.ok(at(52) < at(53));
  // 64/65 add zone fields before 66's independent vehicle normalization is applied.
  assert.ok(at(64) < at(65));
  assert.ok(at(65) < at(66));
});

test('migration runner records only after each apply step', () => {
  const runner = source.slice(source.indexOf('export async function ensureSchema()'));
  assert.match(runner, /if \(!done\.length\) \{ await apply\(q\); await q`INSERT INTO schema_migrations/);
});
