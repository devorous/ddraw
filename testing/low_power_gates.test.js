import test from 'node:test';
import assert from 'node:assert/strict';
import { marchingAntsStep, ANTS_LOW_POWER_INTERVAL_MS } from '../src/utils/marchingAnts.js';

test('marching ants repaint every frame at normal power', () => {
  assert.equal(marchingAntsStep(false, 1000, 999), 1);
  assert.equal(marchingAntsStep(false, 1000, 0), 1);
});

test('marching ants are throttled at low power without aliasing backwards', () => {
  assert.equal(marchingAntsStep(true, 1000, 0), 2, 'first frame always paints');
  assert.equal(marchingAntsStep(true, 1000 + ANTS_LOW_POWER_INTERVAL_MS - 1, 1000), 0);
  const step = marchingAntsStep(true, 1000 + ANTS_LOW_POWER_INTERVAL_MS, 1000);
  assert.ok(step > 0 && step < 4, `step ${step} must be under the 4px dash`);
});
