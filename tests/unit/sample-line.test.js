import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleLineAttributes, sampleLineSelection, sampleLineValue, assertSampleLineCaptureSize, assertSampleLineCounts, MAX_SAMPLE_LINE_BYTES } from '../../src/templates/sample-line.js';
import { contextWidgetValue } from '../../src/templates/context-widgets.js';
import { assembleDefinition } from '../../src/templates/model.js';
import { assertReportSize, assertReportLineSize } from '../../src/reports/render-model.js';
import { reportRecords } from '../helpers/reports.js';
import { analyticalRecords } from '../helpers/templates.js';
import { finalResultSectionRoots } from '../../src/datasheets/final-result.js';

test('line-item selectors preserve source spelling, clearing, whitespace and truthiness', () => {
  assert.equal(sampleLineAttributes.length, 8);
  for (const { value, property } of sampleLineAttributes) {
    assert.equal(sampleLineSelection(` ${value} `), value);
    for (const raw of [null, undefined, 0, false, '', '0', ' ', true, '1.00000000000000001']) {
      assert.equal(sampleLineValue({ sourceField: value }, { [property]: raw }), raw ? String(raw) : '');
    }
  }
  for (const value of [null, undefined, '', ' -1 ']) assert.equal(sampleLineSelection(value), null);
  for (const value of [0, {}, [], 'custom_identification_mark', '__proto__']) assert.throws(() => sampleLineSelection(value), { code: 'invalid_context_field' });
  assert.equal(sampleLineValue({ sourceField: '__proto__' }, {}), '');
  assert.equal(sampleLineValue({ sourceField: 'custom_description' }, Object.create({ description: 'inherited' })), '');
  assert.equal(sampleLineValue({ sourceField: 'custom_description', attributeKey: 'quality', defaultText: 'default' }, null), '');
});

test('every report parameter uses the captured child line and a cleared selection can freeze', () => {
  const field = { widget: 'sample_line_item_data_widget', sourceField: 'custom_description' };
  const report = { lineItem: { description: 'First child line' }, sample: { description: 'Wrong sample' }, results: [{ description: 'Wrong parameter' }] };
  assert.equal(contextWidgetValue(field, report, { sampleProductId: 'other', description: 'Wrong loop' }), 'First child line');
  const records = { ...reportRecords(), version: { kind: 'report' } };
  Object.assign(records.fields.find((item) => item.widget === 'tr_data_widget'), { widget: field.widget, sourceField: null });
  assert.doesNotThrow(() => assembleDefinition(records, { forFreeze: true }));
  records.fields.find((item) => item.widget === field.widget).sourceField = 'unknown';
  assert.throws(() => assembleDefinition(records, { forFreeze: true }), /Select a data field/);
});

test('line-item byte admission counts Unicode, only matching occurrences and the exact boundary', () => {
  const lineItem = { description: '😀'.repeat(1000) };
  const fieldsById = { line: { widget: 'sample_line_item_data_widget', sourceField: 'custom_description', repeatGroupId: 'line' },
    other: { widget: 'text_widget', sourceField: 'custom_description', repeatGroupId: 'other' } };
  assert.equal(assertSampleLineCaptureSize({ fieldsById }, [{ groupId: null }, { groupId: 'line' }, { groupId: 'line' }, { groupId: 'other' }], lineItem), 8000);
  assert.equal(assertSampleLineCounts({ custom_description: MAX_SAMPLE_LINE_BYTES / 4 }, { description: '😀' }), MAX_SAMPLE_LINE_BYTES);
  assert.throws(() => assertSampleLineCounts({ custom_description: MAX_SAMPLE_LINE_BYTES / 4 + 1 }, { description: '😀' }), { code: 'sample_line_size_limit' });
});

test('report line admission counts repeated final sections using each submitted datasheet context', () => {
  const records = reportRecords();
  const loopField = records.fields.find((field) => field.alias === 'moa');
  Object.assign(loopField, { widget: 'sample_line_item_data_widget', sourceField: 'custom_description' });
  const model = assembleDefinition({ ...records, version: { kind: 'report' } });
  const captured = analyticalRecords({ rowCount: 1 }); captured.sections[0].isFinalResult = true;
  captured.expressions = [];
  for (const field of captured.fields) { field.widget = 'sample_line_item_data_widget'; field.valueType = 'text'; field.sourceField = 'custom_description'; delete field.numeric; }
  const capturedModel = assembleDefinition({ ...captured, version: { id: 'sheet' } });
  const occurrences = [{ id: 'root', groupId: null, parentId: null, position: 0 }, ...[1, 2, 3].map((id) => ({ id: `r${id}`, groupId: captured.groups[0].id, parentId: 'root', position: id }))];
  const captures = { capture: { versionId: 'sheet', occurrences, sectionRoots: finalResultSectionRoots(capturedModel, occurrences) } };
  const results = [1, 2].map((id) => ({ id, source: 'section', instanceId: 'capture' }));
  const size = assertReportSize(model, results, captures, { sheet: capturedModel });
  assert.deepEqual(size.lineItemCounts, { custom_description: 2 });
  assert.deepEqual(size.finalLineItemCounts, { capture: { custom_description: 12 } });
  assert.throws(() => assertReportLineSize(size, { description: 'Report line' }), { code: 'incomplete_sample_line_history' });
  captures.capture.lineItem = { description: 'x'.repeat(Math.floor(MAX_SAMPLE_LINE_BYTES / 12) + 1) };
  assert.throws(() => assertReportSize(model, results, captures, { sheet: capturedModel }, { lineItem: { description: 'Short report line' } }), { code: 'sample_line_size_limit' });
  captures.capture.lineItem = { description: 'x'.repeat(100) };
  assert.throws(() => assertReportSize(model, results, captures, { sheet: capturedModel }, { lineItem: { description: 'x'.repeat(MAX_SAMPLE_LINE_BYTES / 2 + 1) } }), { code: 'sample_line_size_limit' });
  capturedModel.sectionsById[captured.sections[0].id].visible = false;
  assert.deepEqual(assertReportSize(model, results, captures, { sheet: capturedModel }).lineItemCounts, { custom_description: 2 });
});

test('direct and submitted line text share one exact UTF-8 budget', () => {
  const size = { lineItemCounts: { custom_description: 1 }, finalLineItemCounts: { a: { custom_quality: 1 }, b: { custom_description: 2 } } };
  const finalLines = { a: { quality: '😀' }, b: { description: 'x'.repeat(1000) } };
  assert.equal(assertReportLineSize(size, { description: 'x'.repeat(MAX_SAMPLE_LINE_BYTES - 2004) }, finalLines), MAX_SAMPLE_LINE_BYTES);
  assert.throws(() => assertReportLineSize(size, { description: 'x'.repeat(MAX_SAMPLE_LINE_BYTES - 2003) }, finalLines), { code: 'sample_line_size_limit' });
});
