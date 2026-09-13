import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { customFieldValuesInput } from '../../src/custom-fields/value-input.js';

const entry = (value, changes = {}) => ({ fieldId: randomUUID(), fieldRevision: 1, value, ...changes });

test('captured field inputs retain exact primitive types, lexical strings, scalar/array shape and meaningful empty distinctions', () => {
  const values = ['', '  ', ' 01.00 ', 0, false, true, null, undefined, [], [0, false, '', null, undefined, '  ', ' A ']];
  const inputs = values.map((value) => entry(value));
  const normalized = customFieldValuesInput(inputs);
  assert.deepEqual(normalized.map((item) => item.value), ['', '  ', ' 01.00 ', 0, false, true, '', '', [], [0, false, ' A ']]);
  assert.equal(inputs[9].value.length, 7);
  assert.deepEqual(customFieldValuesInput([]), []);
  assert.equal(customFieldValuesInput([entry('x'.repeat(16000))])[0].value.length, 16000);
});

test('captured fields use stable case-normalized IDs, explicit revisions and values without accepting client metadata', () => {
  const id = randomUUID();
  assert.equal(customFieldValuesInput([entry('', { fieldId: id.toUpperCase(), fieldRevision: 2_147_483_647 })])[0].fieldId, id);
  for (const fieldRevision of [0, -1, 1.5, '1', 2_147_483_648, undefined]) assert.throws(() => customFieldValuesInput([entry('', { fieldRevision })]), { code: 'invalid_input' });
  for (const fieldId of ['', null, 'field_key', 'constructor']) assert.throws(() => customFieldValuesInput([entry('', { fieldId })]), { code: 'invalid_id' });
  for (const extra of ['displayValue', 'label', 'key', 'fieldType', 'optionId', 'savedBy']) assert.throws(() => customFieldValuesInput([entry('', { [extra]: 'forged' })]), { code: 'invalid_input' });
  assert.throws(() => customFieldValuesInput([{ fieldId: id, fieldRevision: 1 }]), { code: 'missing_custom_field_value' });
  assert.throws(() => customFieldValuesInput([entry('', { fieldId: id }), entry('other', { fieldId: id.toUpperCase() })]), { code: 'duplicate_custom_field_value' });
});

test('captured field input rejects nonprimitive, malformed, oversized or nested values instead of serializing them', () => {
  for (const value of [{ value: 'nested' }, new Date(), [['nested']], [{}], NaN, Infinity, -Infinity, 1n, Symbol('value'), 'bad\0text', '\ud800', 'x'.repeat(16001)]) {
    assert.throws(() => customFieldValuesInput([entry(value)]), { code: 'invalid_custom_field_value' });
  }
  for (const input of [null, undefined, {}, false, 'fields', Array.from({ length: 501 }, () => entry(''))]) {
    assert.throws(() => customFieldValuesInput(input), { code: 'invalid_custom_field_values' });
  }
  for (const value of [null, undefined, false, [], 'entry']) assert.throws(() => customFieldValuesInput([value]), { code: 'invalid_input' });
});

test('captured field cardinality is bounded before blank rows are removed', () => {
  assert.equal(customFieldValuesInput(Array.from({ length: 500 }, () => entry(''))).length, 500);
  assert.equal(customFieldValuesInput([entry(Array(500).fill(0))])[0].value.length, 500);
  assert.equal(customFieldValuesInput(Array.from({ length: 10 }, () => entry(Array(500).fill(false)))).length, 10);
  assert.throws(() => customFieldValuesInput([entry(Array(501).fill(''))]), { code: 'custom_field_value_limit' });
  assert.throws(() => customFieldValuesInput([...Array.from({ length: 10 }, () => entry(Array(500).fill(''))), entry('')]), { code: 'custom_field_value_limit' });
});
