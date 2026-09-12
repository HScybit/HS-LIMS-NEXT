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

test('publication checks typed context bindings and keeps report-only capture gaps explicit', () => {
  const records = { ...reportRecords(), version: { kind: 'report' } };
  const model = assembleDefinition(records, { forFreeze: true });
  const section = Object.values(model.sectionsById).find((section) => section.isParameterLoop);
  assert.equal(section.rowIds.length, 2);
  assert.equal(model.rowsById[section.rowIds[0]].serialNumber, 1);
  const invalid = structuredClone(records);
  invalid.fields.find((field) => field.widget === 'tr_data_widget').sourceField = 'parameter.secret';
  assert.throws(() => assembleDefinition(invalid, { forFreeze: true }), /Select a data field/);
  assert.throws(() => assembleDefinition({ ...records, version: { kind: 'datasheet' } }, { forFreeze: true }), /currently require a report template/);
});
