import test from 'node:test';
import assert from 'node:assert/strict';
import { contextWidgetValue } from '../../src/templates/context-widgets.js';
import { assembleDefinition } from '../../src/templates/model.js';
import { reportRecords } from '../helpers/reports.js';

const field = (widget, sourceField) => ({ widget, sourceField });

test('report widgets preserve zero, false, NA and empty values without arbitrary object traversal', () => {
  const report = { sample: { sampleNumber: 'SYN-001', description: '', customerName: null }, results: [
    { id: 'first', productName: 'Water', parameterName: 'Chloride', finalResult: 0 },
    { id: 'second', productName: 'Water', parameterName: 'Clarity', finalResult: false },
    { id: 'third', productName: 'Oil', parameterName: 'Viscosity', finalResult: 'NA' },
  ] };
  assert.equal(contextWidgetValue(field('sample_details_widget_v2', 'sampleNumber'), report), 'SYN-001');
  assert.equal(contextWidgetValue(field('sample_details_widget_v2', 'productName'), report), 'Water, Oil');
  assert.equal(contextWidgetValue(field('sample_details_widget_v2', 'productName'), report, report.results[2]), 'Oil');
  assert.equal(contextWidgetValue(field('sample_details_widget_v2', 'customerName'), report), '');
  assert.equal(contextWidgetValue(field('tr_result_widget'), report, report.results[0]), '0');
  assert.equal(contextWidgetValue(field('tr_result_widget'), report, report.results[1]), 'false');
  assert.equal(contextWidgetValue(field('tr_result_widget'), report, report.results[2]), 'NA');
  assert.equal(contextWidgetValue(field('tr_data_widget', 'parameterName'), report), 'Chloride, Clarity, Viscosity');
  assert.equal(contextWidgetValue(field('tr_data_widget', '__proto__'), report), '');
  assert.equal(contextWidgetValue(field('sample_details_widget_v2', 'sampleNumber'), { sample: Object.create({ sampleNumber: 'inherited' }) }), '');
  assert.equal(contextWidgetValue(field('tr_data_widget', 'parameterName'), { results: [] }), '');
});

test('serial padding is independent of field labels and preserves a zero for an absent source row', () => {
  assert.equal(contextWidgetValue({ widget: 'sno_widget', serialPadding: 2 }, null, null, 1), '01');
  assert.equal(contextWidgetValue({ widget: 'sno_widget', serialPadding: 2 }, null, null, 101), '101');
  assert.equal(contextWidgetValue({ widget: 'sno_widget' }), '0');
});

test('publication checks typed context bindings and requires actual request repeats for datasheet parameter loops', () => {
  const records = { ...reportRecords(), version: { kind: 'report' } };
  const model = assembleDefinition(records, { forFreeze: true });
  const section = Object.values(model.sectionsById).find((section) => section.isParameterLoop);
  assert.equal(section.rowIds.length, 2);
  assert.equal(model.rowsById[section.rowIds[0]].serialNumber, 1);
  const invalid = structuredClone(records);
  invalid.fields.find((field) => field.widget === 'tr_data_widget').sourceField = 'parameter.secret';
  assert.throws(() => assembleDefinition(invalid, { forFreeze: true }), /Select a data field/);
  assert.throws(() => assembleDefinition({ ...records, version: { kind: 'datasheet' } }, { forFreeze: true }), /matching request repeat definition/);
  const datasheet = structuredClone(records);
  datasheet.version.kind = 'datasheet';
  const groupId = 'request-repeat';
  datasheet.groups.push({ id: groupId, sectionId: section.id, rowId: null, parentGroupId: null, source: 'test_requests', position: 0, minimum: 1, maximum: 500 });
  const parameterColumns = new Set(datasheet.columns.filter((column) => section.rowIds.includes(column.rowId)).map((column) => column.id));
  for (const field of datasheet.fields) if (parameterColumns.has(field.columnId)) field.repeatGroupId = groupId;
  const captureModel = assembleDefinition(datasheet, { forFreeze: true });
  assert.equal(captureModel.sectionsById[section.id].ownRepeatGroupId, groupId);
  assert.equal(captureModel.fieldsById[datasheet.fields.find((field) => field.alias === 'param').id].repeatGroupId, groupId);
  assert.throws(() => assembleDefinition({ ...datasheet, version: { kind: 'report' } }, { forFreeze: true }), /Request repeats belong to datasheet parameter loops/);
});
