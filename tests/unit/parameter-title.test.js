import test from 'node:test';
import assert from 'node:assert/strict';
import { parameterTitleProjection, resolveParameterTitle, stringifyTitleValue, verticalTitleValue } from '../../src/templates/parameter-title.js';
import { editedTextTitle, textWidgetTitle } from '../../src/templates/text.js';

test('parameter title projection exposes captured columns and never fabricates an absent historical record', () => {
  assert.equal(parameterTitleProjection({}), null);
  const row = { parameterId: 'parameter', parameterOrganizationId: 'org', parameterName: 'Frozen name', parameterKey: 'KEY',
    parameterHistoryAvailable: false, parameterDescription: 'Unavailable', parameterOrder: 99, parameterSchemeAbbreviation: 'Unavailable', parameterLaboratoryId: 'lab', secret: 'Excluded' };
  const base = { _id: 'parameter', organization_id: 'org', name: 'Frozen name', key: 'KEY' };
  assert.deepEqual(parameterTitleProjection(row), base);
  assert.deepEqual(parameterTitleProjection({ ...row, parameterHistoryAvailable: true, parameterDescription: '', parameterOrder: 0, parameterLaboratoryId: null }),
    { ...base, description: '', order: 0, scheme_abbr: 'Unavailable', lab_id: null });
});

test('titles remain literal without a bound parameter and preserve source falsy and unknown-key fallbacks', () => {
  for (const parameter of [null, undefined]) for (const title of ['', 'name', 'project_field_data.unit', '0', 0, false]) assert.equal(resolveParameterTitle(title, parameter), title);
  assert.equal(resolveParameterTitle(undefined, null, 'Fallback'), 'Fallback');
  for (const title of ['', null, undefined, 0, false]) assert.equal(resolveParameterTitle(title, {}, 'Fallback'), 'Fallback');
  assert.equal(resolveParameterTitle('Unknown literal', {}), 'Unknown literal');
  assert.equal(resolveParameterTitle('name', { name: 'Frozen parameter' }), 'Frozen parameter');
  for (const value of [0, false, '', '0']) assert.equal(resolveParameterTitle('name', { name: value }), value);
  for (const value of [null, undefined]) assert.equal(resolveParameterTitle('name', { name: value }), 'name');
});

test('dotted titles use the final custom-field display key before an exact dotted property', () => {
  const parameter = { 'project_field_data.unit': 'Exact property', project_field_data: { unit: { display_value: false } } };
  assert.equal(resolveParameterTitle('project_field_data.unit', parameter), false);
  assert.equal(resolveParameterTitle('any.other.prefix.unit', parameter), false);
  for (const value of [0, '', ['First', 'Second']]) {
    parameter.project_field_data.unit.display_value = value;
    assert.deepEqual(resolveParameterTitle('any.prefix.unit', parameter), value);
  }
  parameter.project_field_data.unit = { display_value: null, value: 'Raw value is not the dotted display fallback' };
  assert.equal(resolveParameterTitle('project_field_data.unit', parameter), 'Exact property');
  assert.equal(resolveParameterTitle('missing.unit', parameter, 'Fallback'), 'Fallback');
  assert.equal(resolveParameterTitle('missing.unit', null), 'missing.unit');
});

test('parameter titles cannot resolve inherited prototype properties at any level', () => {
  for (const title of ['constructor', 'toString', '__proto__']) assert.equal(resolveParameterTitle(title, {}), title);
  const parameter = Object.assign(Object.create({ name: 'Inherited name', 'missing.unit': 'Inherited dot' }),
    { project_field_data: Object.create({ unit: { display_value: 'Inherited custom field' } }) });
  assert.equal(resolveParameterTitle('name', parameter), 'name');
  assert.equal(resolveParameterTitle('missing.unit', parameter), '');
  parameter.project_field_data.unit = Object.create({ display_value: 'Inherited display' });
  assert.equal(resolveParameterTitle('missing.unit', parameter), '');
  Object.defineProperty(parameter, '__proto__', { value: 'Own value' });
  assert.equal(resolveParameterTitle('__proto__', parameter), 'Own value');
});

test('title display keeps LegacyHtml scalar, recursive array and nullish object precedence', () => {
  for (const [value, expected] of [[null, ''], [undefined, ''], [0, '0'], [false, 'false'], ['', ''], [' ', ' ']]) assert.equal(stringifyTitleValue(value), expected);
  assert.equal(stringifyTitleValue([null, '', 0, false, ['x', '', ['y']]]), '0, false, x, y');
  for (const value of [0, false, '']) assert.equal(stringifyTitleValue({ display_value: value, value: 'Fallback' }), String(value));
  assert.equal(stringifyTitleValue({ display_value: null, value: false }), 'false');
  assert.equal(stringifyTitleValue({ value: { display_value: ['<b>First</b>', 0] } }), '<b>First</b>, 0');
  assert.equal(stringifyTitleValue({ lower: 0, upper: false }), '{"lower":0,"upper":false}');
  assert.equal(stringifyTitleValue(Object.create({ display_value: 'Inherited value' })), '{}');
  const circular = {}; circular.self = circular;
  assert.equal(stringifyTitleValue(circular), '[object Object]');
});

test('parameter Text titles resolve entered mappings and support explicit string drafts for non-string source values', () => {
  const field = { label: 'order', editable: true }; const parameter = { order: 0, name: 'Captured name' };
  assert.equal(textWidgetTitle(field, undefined, parameter), 0);
  assert.equal(textWidgetTitle(field, { state: 'present', origin: 'default', textValue: 'name' }, parameter), 0);
  assert.equal(textWidgetTitle(field, { state: 'present', origin: 'entered', textValue: 'name' }, parameter), 'Captured name');
  assert.equal(textWidgetTitle({ ...field, editable: false }, { state: 'present', origin: 'entered', textValue: 'name' }, parameter), 0);
  for (const value of [0, false, ['First', 'Second'], { display_value: 'Display' }]) assert.equal(editedTextTitle(value, stringifyTitleValue(value)), stringifyTitleValue(value));
  assert.equal(editedTextTitle('Captured name', ' Captured name '), null);
});

test('Vertical titles preserve React primitive and array children with a literal object fallback', () => {
  assert.equal(verticalTitleValue(false), false); assert.equal(verticalTitleValue(0), 0);
  assert.equal(verticalTitleValue('<b>Literal</b>'), '<b>Literal</b>');
  assert.deepEqual(verticalTitleValue(['First', false, 0, ['Second', { display_value: 'Value' }]]), ['First', false, 0, ['Second', 'Value']]);
  assert.equal(verticalTitleValue({ raw: 'Literal' }), '{"raw":"Literal"}');
});
