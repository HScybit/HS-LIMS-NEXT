import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOccurrencePosition, valuePayload } from '../../src/templates/calculations.js';
import { dateOnly, decimal } from '../../src/templates/input.js';

test('repeat insertion ordering retains distinctions beyond binary floating point precision', () => {
  const positions = ['1', '0.50000000000000000000000000000002', '0', '0.50000000000000000000000000000001', '12', '9'];
  assert.deepEqual(positions.map((position) => ({ id: position, position })).sort(compareOccurrencePosition).map((row) => row.position),
    ['0', '0.50000000000000000000000000000001', '0.50000000000000000000000000000002', '1', '9', '12']);
});

test('value payloads keep present zero and false separate from absent, empty and invalid states', () => {
  assert.equal(valuePayload({ state: 'present', valueType: 'numeric', numberValue: '0' }), '0');
  assert.equal(valuePayload({ state: 'present', valueType: 'boolean', booleanValue: false }), false);
  for (const state of ['absent', 'empty', 'invalid', 'not_applicable']) assert.equal(valuePayload({ state, valueType: 'numeric', numberValue: '12' }), null);
});

test('calendar and decimal input validation reject normalized dates and malformed numeric payloads', () => {
  assert.equal(dateOnly('2024-02-29'), '2024-02-29');
  for (const date of ['0000-01-01', '2025-02-29', '2024-04-31', '2024-02-29T00:00:00Z', null]) assert.throws(() => dateOnly(date), { code: 'invalid_date' });
  assert.equal(decimal('1.005', 'Value'), '1.005');
  assert.equal(decimal('0', 'Value'), '0');
  for (const value of [null, false, '', '1 mg', 'NaN', 'Infinity', {}, []]) assert.throws(() => decimal(value, 'Value'), { code: 'invalid_number' });
});
