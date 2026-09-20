import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleReportingRowsChanged, calculateSampleReportingDate } from '../../src/samples/reporting-date.js';

const first = { id: 'test-1', sampleProductId: 'line-1', testParameterId: 'parameter-1', methodId: 'method-1' };
const second = { ...first, id: 'test-2', sampleProductId: 'line-2' };

test('reporting date needs changes to both test identities and line/parameter/method contents', () => {
  const previous = [first, second];
  for (const next of [previous, previous.toReversed(), [{ ...first, rate: '99', estimatedDurationMinutes: 4800 }, second],
    [{ ...first, testParameterId: 'parameter-2' }, second], [{ ...first, id: 'replacement' }, second]]) {
    assert.equal(sampleReportingRowsChanged(previous, next), false);
  }
  for (const next of [[first], [...previous, { ...second, id: 'test-3' }],
    [{ ...first, id: 'replacement', methodId: 'method-2' }, second], [{ ...first, id: 'replacement', sampleProductId: 'line-3' }, second]]) {
    assert.equal(sampleReportingRowsChanged(previous, next), true);
  }
  assert.equal(sampleReportingRowsChanged([], []), false);
  assert.equal(sampleReportingRowsChanged([], [first]), true);
});

test('reporting calendar uses the receiving UTC day across leap days, offsets and daylight saving', () => {
  for (const [received, days, expected] of [
    ['2024-02-28T10:30:00.123456Z', 3, '2024-03-02'],
    ['2026-03-07T23:30:00-05:00', 1, '2026-03-09'],
    ['2026-09-12T00:30:00+05:30', 1, '2026-09-12'],
    ['2026-12-31T23:59:59.999999Z', 1, '2027-01-01'],
    [new Date('2026-09-12T05:00:00Z'), '2', '2026-09-14'],
  ]) assert.equal(calculateSampleReportingDate(received, days), expected);
});

test('positive fractional estimates retain source calendar-day truncation', () => {
  for (const [days, expected] of [[0.5, '2024-02-28'], [1.5, '2024-02-29'], [2.9, '2024-03-01'], [Number.MIN_VALUE, '2024-02-28']]) {
    assert.equal(calculateSampleReportingDate('2024-02-28T23:59:59Z', days), expected);
  }
});

test('missing, nonpositive, nonfinite and unrepresentable estimates do not create a reporting date', () => {
  for (const days of [undefined, null, '', ' ', 0, -1, '1e-999', '1e999', Infinity, NaN, 1e10, 'bad']) {
    assert.equal(calculateSampleReportingDate('2026-09-12T00:00:00Z', days), '');
  }
  for (const received of [null, undefined, '', 'bad', new Date(NaN)]) assert.equal(calculateSampleReportingDate(received, 2), '');
  assert.equal(calculateSampleReportingDate('9999-12-31T00:00:00Z', 1), '');
  assert.equal(calculateSampleReportingDate('0001-01-01T00:00:00Z', 1), '0001-01-02');
});
