import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldDefaultValue, resultDefaultFields, resolveResultInput } from '../../src/templates/defaults.js';
import { capturedInputValue, displayValue } from '../../src/templates/calculations.js';

const field = { widget: 'result_widget', valueType: 'result', numeric: { displayScale: 2 } };
test('result defaults preserve authored lexical zero and text while empty/dash configuration removes the default', () => {
  for (const value of [0, '0', '000.00', '4.20', 'Not detected', 'NA']) {
    const defaults = resultDefaultFields(field, value);
    assert.equal(defaults.defaultState, 'present');
    assert.equal(fieldDefaultValue({ ...field, ...defaults }), String(value));
    assert.equal(defaults.defaultLexical, defaults.defaultNumber != null ? String(value) : null);
  }
  for (const value of ['', '-', null]) assert.equal(fieldDefaultValue(resultDefaultFields(field, value)), null);
  for (const value of ['12abc', ' Present ', '\0']) assert.throws(() => resultDefaultFields(field, value), { code: 'invalid_result_value' });
  // Clean full numeric text with more decimal places than the configured scale is a distinct,
  // specific rejection (Q3: follow PERN), not the generic "not a valid value" bucket.
  assert.throws(() => resultDefaultFields(field, '1.234'), { code: 'result_decimal_scale' });
  assert.throws(() => resultDefaultFields({ ...field, valueType: 'numeric' }, 'Not detected'), { code: 'invalid_result_value' });
});

test('result input and view retain the recorded lexical spelling without applying formula display formatting', () => {
  const value = { state: 'present', valueType: 'result', numberValue: '0.00', lexical: '000.00' };
  assert.equal(capturedInputValue(value), '000.00');
  assert.equal(displayValue(field, value), '000.00');
  assert.equal(capturedInputValue({ ...value, state: 'empty' }), null);
  assert.equal(displayValue(field, { ...value, numberValue: '4.20', lexical: null }), '4.20');
});

test('only empty result commits use the frozen default, preserving zero, literal dash and explicit absence', () => {
  const configured = { ...field, ...resultDefaultFields(field, 'Not detected') };
  const identity = { fieldId: 'field', occurrenceId: 'row' };
  for (const input of [{ state: 'empty' }, { state: 'present', value: ' \t' }]) {
    assert.deepEqual(resolveResultInput(configured, { ...identity, ...input }), { ...identity, state: 'present', value: 'Not detected' });
  }
  for (const input of [{ state: 'present', value: '0' }, { state: 'present', value: '-' }, { state: 'absent' }]) assert.deepEqual(resolveResultInput(configured, input), input);
  assert.deepEqual(resolveResultInput({ ...configured, widget: 'input_widget' }, { state: 'empty' }), { state: 'empty' });
  assert.deepEqual(resolveResultInput({ ...field, ...resultDefaultFields(field, '0') }, { state: 'empty' }), { state: 'present', value: '0' });
});
