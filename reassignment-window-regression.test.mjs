import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const nudge = readFileSync(new URL('./src/data/nudge-reassign-core.ts', import.meta.url), 'utf8');
const dispatch = readFileSync(new URL('./src/data/ai-dispatcher.ts', import.meta.url), 'utf8');
const migrations = readFileSync(new URL('./src/data/migrations.ts', import.meta.url), 'utf8');

test('three-minute window is measured from assigned_at, with a final-minute warning', () => {
  assert.match(nudge, /reassign_not_headed_minutes\)\|\|3/);
  assert.match(nudge, /ageMinutes < mins/);
  assert.match(nudge, /assigned_at <= .*Math\.max\(0, mins-1\)/);
  assert.match(nudge, /status === "offered" \? "Accept the job — it will be reassigned shortly"/);
  assert.match(nudge, /You haven't left yet — the job will be reassigned shortly/);
});

test('headed check runs before warning and reassignment', () => {
  const headed = nudge.indexOf('if (check.headed) continue;');
  const warning = nudge.indexOf("kind='warning'");
  const reassign = nudge.indexOf('await reassignNotHeaded');
  assert.ok(headed >= 0 && warning > headed && reassign > warning);
});

test('assignment change refreshes timestamp, preserving timestamp for same driver', () => {
  assert.match(dispatch, /assigned_at=CASE WHEN dispatch_jobs\.assigned_driver_towbook_id IS DISTINCT FROM EXCLUDED\.assigned_driver_towbook_id THEN EXCLUDED\.assigned_at ELSE COALESCE\(dispatch_jobs\.assigned_at, EXCLUDED\.assigned_at\) END/);
});

test('verification miss only recalculates on concrete different Towbook driver', () => {
  assert.match(dispatch, /verificationDriver = verification\.driverOnCall == null \? null/);
  assert.match(dispatch, /offerLostRace = verificationDriver != null && verificationDriver > 0 && verificationDriver !== dispatchDriverId/);
  assert.match(dispatch, /!humanReassigned && offerLostRace/);
});

test('migration 79 sets default 3 and normalizes legacy 5', () => {
  assert.match(migrations, /\[79, async \(q\)/);
  assert.match(migrations, /SET DEFAULT 3/);
  assert.match(migrations, /reassign_not_headed_minutes=3 WHERE reassign_not_headed_minutes IS NULL OR reassign_not_headed_minutes=5/);
});
