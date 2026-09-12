import test from 'node:test';
import assert from 'node:assert/strict';
import { agreedResultNumber, agreedResultValue } from '../../src/datasheets/job-results.js';
import { displayValue, valuePayload } from '../../src/templates/calculations.js';
import { resolveRecordedResult } from '../../src/datasheets/final-result.js';

test('result entry preserves agreed zero and decimal values without choosing unresolved parsing or rounding policies', () => {
  const field = { numeric: { displayScale: 2, minimum: '-10', maximum: '20' } };
  for (const value of [0, '0', '-0', '-10', '12.30', '20']) assert.equal(agreedResultNumber(field, value), String(value));
  for (const value of ['12abc', '12.345', '12.300', ' 12', '+12', '.5', '1e1', 'NA', '', null, false, Infinity, '-10.01', '20.01', '9007199254740993']) {
    assert.throws(() => agreedResultNumber(field, value), { code: 'scientific_policy_unresolved' });
  }
});

test('qualitative result payloads retain exact text, zero and typed final results without coercing qualifiers', () => {
  const field = { id: 'result', valueType: 'result', numeric: { displayScale: 2, padDecimals: true } };
  for (const text of ['Not detected', 'Absent', 'NA', '<0.10 mg/L', 'Pass — नमूना', 'false', 'a'.repeat(16000)]) {
    const value = { state: 'present', valueType: 'result', revision: 2, ...agreedResultValue(field, text) };
    assert.equal(value.numberValue, undefined);
    assert.equal(valuePayload(value), text); assert.equal(displayValue(field, value), text);
    assert.equal(resolveRecordedResult(field, value, 'occurrence', 'result_widget').textValue, text);
  }
  for (const input of ['0', '-0', '4.20']) {
    const value = { state: 'present', valueType: 'result', revision: 2, ...agreedResultValue(field, input) };
    assert.equal(value.textValue, undefined); assert.equal(valuePayload(value), input);
    assert.equal(resolveRecordedResult(field, value, 'occurrence', 'result_widget').numberValue, input);
  }
  assert.equal(displayValue(field, { state: 'present', valueType: 'result', numberValue: '0' }), '0.00');
  assert.equal(valuePayload({ state: 'empty', valueType: 'result', textValue: 'Prior result' }), null);
});

test('qualitative entry cannot disguise numeric prefixes, unresolved precision, whitespace or invalid payloads as text', () => {
  for (const input of ['12abc', '1.234', '12.300', ' 12', '+12', '.5', '1e1', 'Infinity', '-Infinity', '', ' ', '\u00a0Absent', 'Absent\n', 'Absent\0', 'a'.repeat(16001), null, false, {}, [], NaN, Infinity]) {
    assert.throws(() => agreedResultValue({ numeric: { displayScale: 2 } }, input), { code: 'scientific_policy_unresolved' });
  }
  assert.throws(() => agreedResultNumber({}, '0'.repeat(1001)), { code: 'scientific_policy_unresolved' });
});
