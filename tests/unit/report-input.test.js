import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reportGenerationInput, printSettingsInput, reportGroups } from '../../src/reports/input.js';

test('COA grouping uses selected test and product identities instead of repeated parameter labels', () => {
  const productA = randomUUID(); const productB = randomUUID(); const templateId = randomUUID();
  const results = [{ sampleTestId: randomUUID(), sampleProductId: productA }, { sampleTestId: randomUUID(), sampleProductId: productB }, { sampleTestId: randomUUID(), sampleProductId: productA }];
  const input = reportGenerationInput({ requestId: randomUUID(), revision: 1, reportType: 'product_wise', selectedSampleTestIds: results.map((row) => row.sampleTestId).reverse(), templateSelections: [{ key: productA, templateId }, { key: productB, templateId }] });
  const groups = reportGroups(results, input);
  assert.deepEqual(groups.map((group) => group.results.map((row) => row.sampleTestId)), [[results[0].sampleTestId, results[2].sampleTestId], [results[1].sampleTestId]]);
  assert.equal(reportGroups(results, { ...input, reportType: 'parameter_wise' }).length, 3);
  assert.throws(() => reportGroups(results, { ...input, selectedSampleTestIds: [randomUUID()] }), { code: 'invalid_report_test' });
});

test('generation validates duplicate, empty, unknown, excessive and malformed input while preserving zero margins and false flags', () => {
  const testId = randomUUID(); const templateId = randomUUID();
  const input = { requestId: randomUUID(), revision: 1, reportType: 'consolidated', selectedSampleTestIds: [testId], templateSelections: [{ key: 'consolidated', templateId }] };
  assert.equal(printSettingsInput({ xMargin: 0, printHeader: false }).xMargin, '0');
  assert.equal(printSettingsInput({ xMargin: 0, printHeader: false }).printHeader, false);
  assert.throws(() => reportGenerationInput({ ...input, selectedSampleTestIds: [] }), { code: 'invalid_report_selection' });
  assert.throws(() => reportGenerationInput({ ...input, selectedSampleTestIds: [testId, testId.toUpperCase()] }), { code: 'duplicate_report_test' });
  assert.throws(() => reportGenerationInput({ ...input, finalResult: 'forged' }), { code: 'invalid_input' });
  assert.throws(() => reportGenerationInput({ ...input, selectedSampleTestIds: Array.from({ length: 1001 }, randomUUID) }), { code: 'invalid_report_selection' });
  assert.throws(() => printSettingsInput({ printHeader: 'false' }), { code: 'invalid_input' });
  assert.throws(() => printSettingsInput({ topMargin: -1 }), { code: 'invalid_print_setting' });
  assert.throws(() => printSettingsInput({ scale: 'NaN' }), { code: 'invalid_number' });
});
