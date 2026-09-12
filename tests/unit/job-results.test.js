import test from 'node:test';
import assert from 'node:assert/strict';
import { agreedResultNumber } from '../../src/datasheets/job-results.js';

test('result entry preserves agreed zero and decimal values without choosing unresolved parsing or rounding policies', () => {
  const field = { numeric: { displayScale: 2, minimum: '-10', maximum: '20' } };
  for (const value of [0, '0', '-0', '-10', '12.30', '20']) assert.equal(agreedResultNumber(field, value), String(value));
  for (const value of ['12abc', '12.345', '12.300', ' 12', '+12', '.5', '1e1', 'NA', '', null, false, Infinity, '-10.01', '20.01', '9007199254740993']) {
    assert.throws(() => agreedResultNumber(field, value), { code: 'scientific_policy_unresolved' });
  }
});
