import assert from 'node:assert/strict';
import { isTireChange, tirePlugCompletionGate, tirePlugRateCents } from './src/data/tire-plug-core.ts';

assert.equal(isTireChange('tire_change'), true);
assert.equal(isTireChange('Tire Change'), true);
assert.equal(isTireChange('jump_start'), false);
assert.deepEqual(tirePlugCompletionGate('approved'), { allowed: false, reason: 'Customer accepted the tire plug; charge it before completing.' });
for (const status of [null, 'offered', 'charged', 'paid', 'voided', 'declined']) assert.equal(tirePlugCompletionGate(status).allowed, true);
assert.equal(tirePlugRateCents(undefined), 4500);
assert.equal(tirePlugRateCents(6500), 6500);
assert.equal(tirePlugRateCents(-1), 4500);
assert.equal(tirePlugRateCents(1.5), 4500);
console.log('tire-plug: 10 assertions passed');
