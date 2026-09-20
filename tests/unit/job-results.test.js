import test from 'node:test';
import assert from 'node:assert/strict';
import { agreedResultNumber, agreedResultValue } from '../../src/datasheets/job-results.js';
import { displayValue, valuePayload } from '../../src/templates/calculations.js';
import { resolveRecordedResult } from '../../src/datasheets/final-result.js';

test('result entry preserves agreed zero and decimal values without rounding or accepting a numeric prefix', () => {
  const field = { numeric: { displayScale: 2, minimum: '-10', maximum: '20' } };
  for (const value of [0, '0', '-0', '-10', '12.30', '20']) assert.equal(agreedResultNumber(field, value), String(value));
});

test('malformed or empty result text is rejected as an invalid value, not a numeric prefix extraction', () => {
  const field = { numeric: { displayScale: 2, minimum: '-10', maximum: '20' } };
  for (const value of ['12abc', ' 12', '+12', '.5', '1e1', 'NA', '', null, false, Infinity]) {
    assert.throws(() => agreedResultNumber(field, value), { code: 'invalid_result_value' });
  }
  assert.throws(() => agreedResultNumber({}, '0'.repeat(1001)), { code: 'invalid_result_value' });
});

test('a result with more decimal places than the configured scale is rejected, never rounded', () => {
  const field = { numeric: { displayScale: 2 } };
  assert.throws(() => agreedResultNumber(field, '12.345'), { code: 'result_decimal_scale' });
  assert.throws(() => agreedResultNumber(field, '12.300'), { code: 'result_decimal_scale' });
  assert.equal(agreedResultNumber(field, '12.30'), '12.30');
});

test('a result outside the configured minimum or maximum is rejected using exact decimal comparison', () => {
  const field = { numeric: { minimum: '-10', maximum: '20' } };
  assert.throws(() => agreedResultNumber(field, '-10.01'), { code: 'result_below_minimum' });
  assert.throws(() => agreedResultNumber(field, '20.01'), { code: 'result_above_maximum' });
  // A value far larger than a JS Number can represent exactly must still compare correctly.
  assert.throws(() => agreedResultNumber(field, '9007199254740993'), { code: 'result_above_maximum' });
  assert.equal(agreedResultNumber(field, '-10'), '-10'); assert.equal(agreedResultNumber(field, '20'), '20');
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
  // '1.234' and '12.300' are clean full numeric text, so they route through the numeric path and
  // are rejected there for exceeding the configured decimal scale, not as an ambiguous non-number.
  for (const input of ['1.234', '12.300']) {
    assert.throws(() => agreedResultValue({ numeric: { displayScale: 2 } }, input), { code: 'result_decimal_scale' });
  }
  for (const input of ['12abc', ' 12', '+12', '.5', '1e1', 'Infinity', '-Infinity', '', ' ', ' Absent', 'Absent\n', 'Absent\0', 'a'.repeat(16001), null, false, {}, [], NaN, Infinity]) {
    assert.throws(() => agreedResultValue({ numeric: { displayScale: 2 } }, input), { code: 'invalid_result_value' });
  }
  assert.throws(() => agreedResultNumber({}, '0'.repeat(1001)), { code: 'invalid_result_value' });
});
