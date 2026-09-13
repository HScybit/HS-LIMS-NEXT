import test from 'node:test';
import assert from 'node:assert/strict';
import { parameterDetailKey, parameterDetailCustomFieldKey, resolveParameterDetail, parameterDetailValue, parameterDetailPayload, parameterDetailLimits, parameterDetailBytes } from '../../src/templates/parameter-detail.js';
import { assembleDefinition } from '../../src/templates/model.js';
import { parseExpression } from '../../src/templates/expressions.js';
import { calculateCapture } from '../../src/templates/calculations.js';
import { analyticalRecords } from '../helpers/templates.js';
import { reportParameterDetailFallback } from '../../src/reports/parameter-details.js';
import { assertReportSize } from '../../src/reports/render-model.js';

test('Parameter Detail resolves normalized Title with the source RPC dot and truthy-display behavior', () => {
  const parameter = { name: 'Captured parameter', order: 0, flag: false, alias_name: 'Underscored attribute',
    project_field_data: { zero: { display_value: 0 }, flag: { display_value: false }, text: { display_value: 'Captured value' }, list: { display_value: [0, false, ''] } } };
  for (const [title, expected] of [['name', 'Captured parameter'], ['order', 0], ['flag', false], ['alias.name', 'Underscored attribute'],
    ['project_field_data.zero', ''], ['project_field_data.flag', ''], ['project_field_data.text', 'Captured value'],
    ['prefixproject_field_data.text', 'Captured value'], ['project_field_data.list', [0, false, '']],
    ['project_field_data.text.nested', ''], ['prefix.project_field_data.text', ''], ['missing', ''], ['', '']]) {
    assert.deepEqual(resolveParameterDetail(title, parameter), expected, title);
  }
  assert.equal(parameterDetailKey('project_field_data.text.nested'), 'project_field_data_text_nested');
  assert.equal(parameterDetailCustomFieldKey('project_field_data.text'), 'text');
  assert.equal(parameterDetailCustomFieldKey('project_field_data.text.nested'), null);
  assert.equal(parameterDetailCustomFieldKey('name'), null);
  assert.equal(resolveParameterDetail('name', null), '');
  assert.equal(resolveParameterDetail('name', Object.create({ name: 'Inherited value' })), '');
  assert.equal(resolveParameterDetail('constructor', parameter), '');
  assert.equal(resolveParameterDetail('project_field_data.text', { project_field_data: Object.create(parameter.project_field_data) }), '');
  assert.equal(resolveParameterDetail('project_field_data.text', { project_field_data: { text: Object.create({ display_value: 'Inherited value' }) } }), '');
});

test('Parameter Detail capture preserves zero, false, numeric-looking text, ordered primitives and empty arrays', () => {
  for (const value of [0, -1.25, 1e100, false, true, '0', ' false ', ' H₂O ', [], [0, false, '', null, '12', 12]]) {
    assert.deepEqual(parameterDetailPayload(parameterDetailValue(value)), value);
  }
  assert.deepEqual(parameterDetailValue(false), { valueType: 'parameter_detail', origin: 'parameter', state: 'present', parameterDetailKind: 'boolean', parameterDetailItemCount: 0, booleanValue: false });
  for (const value of ['', null, undefined]) {
    const capture = parameterDetailValue(value);
    assert.equal(capture.state, 'empty'); assert.equal(parameterDetailPayload(capture), null);
  }
  assert.deepEqual(parameterDetailPayload(parameterDetailValue(new Array(2))), [null, null]);
});

test('Parameter Detail refuses objects, nested arrays, invalid numbers and malformed or oversized data before capture', () => {
  for (const value of [{ name: 'object' }, [[1]], Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 1, '\0', '\ud800', 'a'.repeat(parameterDetailLimits.text + 1)]) {
    assert.throws(() => parameterDetailValue(value), { code: 'unsupported_parameter_detail' });
  }
  assert.throws(() => parameterDetailValue(new Array(parameterDetailLimits.items + 1)), { code: 'parameter_detail_limit' });
  assert.throws(() => parameterDetailValue(Array.from({ length: 600 }, () => '界'.repeat(16000))), { code: 'parameter_detail_limit' });
  assert.throws(() => parameterDetailKey(null), { code: 'invalid_parameter_detail_key' });
});

test('an incomplete or reordered Parameter Detail list is rejected instead of being rendered as a different value', () => {
  const value = parameterDetailValue(['a', 'b']);
  assert.throws(() => parameterDetailPayload({ ...value, parameterDetailItems: value.parameterDetailItems.slice(1) }), { code: 'invalid_parameter_detail_history' });
  assert.throws(() => parameterDetailPayload({ ...value, parameterDetailItems: [...value.parameterDetailItems].reverse() }), { code: 'invalid_parameter_detail_history' });
  assert.throws(() => parameterDetailPayload({ ...value, parameterDetailKind: 'object' }), { code: 'invalid_parameter_detail_history' });
  for (const numberValue of [null, '', false, [], [1], 'NaN', 'Infinity', '1e1000']) assert.throws(() => parameterDetailPayload({ state: 'present', parameterDetailKind: 'numeric', numberValue }), { code: 'invalid_parameter_detail_history' });
});

test('a report fallback requires its own selected membership to have one captured parameter version', () => {
  const first = { testRequestId: 'first', parameterId: 'parameter', parameterRevision: 2 };
  assert.equal(reportParameterDetailFallback([first]), first);
  assert.equal(reportParameterDetailFallback([]), null);
  for (const missing of [{ parameterId: null }, { parameterRevision: null }]) {
    assert.equal(reportParameterDetailFallback([first, { ...first, ...missing }]), null);
  }
  assert.equal(reportParameterDetailFallback([first, { ...first, parameterRevision: 3 }]), null);
  assert.equal(reportParameterDetailFallback([first, { ...first, parameterId: 'another' }]), null);
  assert.equal(reportParameterDetailFallback([first, { ...first, testRequestId: 'second' }]), first);
});

test('expanded Parameter Detail output is bounded before rendering even when repeated rows share one value', () => {
  const records = analyticalRecords({ rowCount: 1, repeated: false });
  Object.assign(records.fields[0], { widget: 'parameter_detail_widget', valueType: 'parameter_detail', numeric: null, label: 'note' });
  records.sections[0].isParameterLoop = true;
  const model = assembleDefinition(records); const raw = '界'.repeat(16000);
  const rows = Array.from({ length: 350 }, () => ({ parameterDetailValues: { note: raw } }));
  assert.doesNotThrow(() => assertReportSize(model, rows.slice(0, 300)));
  assert.throws(() => assertReportSize(model, rows), { code: 'parameter_detail_limit' });
});

test('numeric admission counts PostgreSQL decimal expansion instead of its shorter exponent notation', () => {
  for (const [value, bytes] of [[1e308, 309], [-1e308, 310], [1e-7, 9], [1.23e-7, 11], [1.23e30, 31]]) {
    assert.equal(parameterDetailBytes([parameterDetailValue(value)]), bytes);
  }
  assert.throws(() => parameterDetailBytes(Array(60_000).fill(parameterDetailValue(1e308))), { code: 'parameter_detail_limit' });
});

test('formulas read a cached Parameter Detail only when Key matches its normalized Title, keeping lists as lists', () => {
  const records = analyticalRecords({ rowCount: 1, repeated: false });
  const field = records.fields[0];
  Object.assign(field, { widget: 'parameter_detail_widget', valueType: 'parameter_detail', numeric: null, label: 'project_field_data.list', alias: 'project_field_data_list' });
  records.expressions[0].nodes = parseExpression('SUM(project_field_data_list)', () => ({ fieldId: field.id, scope: 'current' }));
  const occurrence = { id: 'root', groupId: null, parentId: null, position: 0 };
  const value = { ...parameterDetailValue([1, 2]), fieldId: field.id, occurrenceId: occurrence.id };
  assert.equal(calculateCapture(assembleDefinition(records), [occurrence], [value]).calculated[0].numberValue, '3');
  field.alias = 'different_key';
  assert.equal(calculateCapture(assembleDefinition(records), [occurrence], [value]).calculated[0].numberValue, '0');
  assert.deepEqual(parameterDetailPayload(value), [1, 2], 'Display still uses the Title-cached value');
});
