import test from 'node:test';
import assert from 'node:assert/strict';
import { productDetailText, productDetailValue } from '../../src/templates/product-context.js';

test('Product detail selectors use explicit historical attributes and preserve source text formatting', () => {
  const product = { id: 'recorded-id', code: 'Original key', name: 'Original name', description: 'Master description',
    abbreviation: '0', jobTemplateId: 'recorded-template', tagIds: ['tag-a', 'tag-b'] };
  for (const [key, expected] of Object.entries({ _id: 'recorded-id', key: 'Original key', name: 'Original name',
    description: 'Master description', abbr: '0', job_template_id: 'recorded-template', tags: 'tag-a, tag-b' })) {
    assert.equal(productDetailValue(product, ` ${key} `), expected);
  }
  for (const key of [null, undefined, '', ' ', '-1', 'missing', 'constructor', '__proto__', 'name.length']) assert.equal(productDetailValue(product, key), '');
  assert.equal(productDetailValue(null, 'name'), '');
  assert.equal(productDetailValue(Object.create({ name: 'Inherited' }), 'name'), '');
  assert.equal(productDetailValue({ name: 0 }, 'name'), '0');
  assert.equal(productDetailValue({ name: false }, 'name'), 'false');
});

test('Product Custom Fields use meaningful captured display values before raw values, including zero and false', () => {
  const cases = [
    [undefined, undefined, ''], [null, '', ''], ['', 'Raw', 'Raw'], [' ', false, 'false'],
    [0, 'Raw', '0'], [false, 'Raw', 'false'], ['Display', 'Raw', 'Display'],
    [['A', 0, false], 'Raw', 'A, 0, false'], [[], ['Raw', false], 'Raw, false'],
    [undefined, ['', ' ', 0, false, null], ' , 0, false'], [undefined, [], ''],
    [{}, 'Raw', '{}'], [undefined, { nested: [0, false] }, '{"nested":[0,false]}'],
  ];
  for (const [displayValue, value, expected] of cases) {
    const product = { customFieldsByKey: { probe: { fieldId: 'stable-field-id', fieldRevision: 2, displayValue, value } } };
    assert.equal(productDetailValue(product, 'project_field__splitter__probe'), expected);
    assert.equal(productDetailValue(product, 'project_field__splitter__probe__splitter__ignored'), expected);
    assert.equal(productDetailValue(product, 'project_field__splitter__Probe'), '');
    assert.equal(productDetailValue(product, 'project_field__splitter__missing'), '');
  }
  assert.equal(productDetailValue({}, 'project_field__splitter__probe'), '');
  assert.equal(productDetailValue({ customFieldsByKey: Object.create({ probe: { value: 'Inherited' } }) }, 'project_field__splitter__probe'), '');
});

test('Product detail text retains nested arrays and object/date rendering from the source widget', () => {
  assert.equal(productDetailText([['A', 0], false, '', null, [' ', true]]), 'A, 0, false,  , true');
  assert.equal(productDetailText(new Date('2026-09-13T00:00:00Z')), '"2026-09-13T00:00:00.000Z"');
  assert.equal(productDetailText({ value: 0, display_value: false }), '{"value":0,"display_value":false}');
  const cyclic = {}; cyclic.value = cyclic;
  assert.equal(productDetailText(cyclic), '[object Object]');
});
