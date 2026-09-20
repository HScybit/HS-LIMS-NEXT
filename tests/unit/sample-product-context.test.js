import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSampleProductContext } from '../../src/samples/product-context.js';
import { productDetailValue, productDetailProjection, productDetailSelector } from '../../src/templates/product-context.js';
import { contextWidgetValue } from '../../src/templates/context-widgets.js';
import { calculateCapture } from '../../src/templates/calculations.js';
import { validateSubmissionValues } from '../../src/datasheets/final-result.js';

const header = (sampleProductId = 'line-a') => ({ sampleProductId, productId: 'product', organizationId: 'organization', productRevision: 2,
  historyAvailable: true, code: 'CODE', name: 'Original name', description: 'Original description', abbreviation: null, jobTemplateId: null,
  tagIds: [], tagCount: 0, actualFieldCount: 2, customFieldCount: 2, createdBy: 'creator',
  createdAt: new Date('2026-09-01T12:34:56.789Z'), updatedAt: new Date('2026-09-02T01:02:03.004Z') });
const field = (key, isArray = false, valueCount = 1) => ({ sampleProductId: 'line-a', fieldId: key, fieldRevision: 1, key, label: key,
  isArray, valueCount, displayKind: 'text', displayText: ' ', displayNumber: null, displayBoolean: null });
const raw = (fieldId, value, position = 0) => ({ sampleProductId: 'line-a', fieldId, position,
  rawKind: typeof value === 'string' ? 'text' : typeof value, rawText: typeof value === 'string' ? value : null,
  rawNumber: typeof value === 'number' ? value : null, rawBoolean: typeof value === 'boolean' ? value : null });

test('Product runtime assembly preserves ordered primitive arrays, prototype-safe keys and date text through JSON transport', () => {
  const { productsByLineId, primaryProductLineId } = assembleSampleProductContext([header()], [field('__proto__'), field('constructor', true, 3)],
    [raw('__proto__', false), raw('constructor', 0), raw('constructor', ' ', 1), raw('constructor', false, 2)]);
  assert.equal(primaryProductLineId, 'line-a'); const product = productsByLineId[primaryProductLineId];
  assert.equal(Object.getPrototypeOf(product.customFieldsByKey), null);
  assert.equal(productDetailValue(product, 'project_field__splitter____proto__'), 'false');
  assert.equal(productDetailValue(product, 'project_field__splitter__constructor'), '0,  , false');
  const transported = JSON.parse(JSON.stringify(product));
  for (const selected of [product, transported]) {
    assert.equal(productDetailValue(selected, 'created_at'), '"2026-09-01T12:34:56.789Z"');
    assert.equal(productDetailValue(selected, 'updated_at'), '"2026-09-02T01:02:03.004Z"');
    assert.equal(productDetailValue(selected, 'user_id'), 'creator');
  }
});

test('incomplete or ambiguous historical Product children fail instead of displaying partial data', () => {
  const cases = [
    [[header(), header()], [], []],
    [[{ ...header(), historyAvailable: false }], [], []],
    [[{ ...header(), tagCount: 1 }], [], []],
    [[{ ...header(), customFieldCount: 3 }], [], []],
    [[header()], [field('one'), field('one')], []],
    [[header()], [field('one'), { ...field('one'), fieldId: 'different' }], []],
    [[header()], [field('one')], []],
    [[header()], [field('one', true, 2)], [raw('one', 0, 1)]],
    [[header()], [field('one')], [raw('one', 0), raw('one', false)]],
    [[header()], [field('one')], [raw('different', 0)]],
    [[header()], [field('one', false, 0)], []],
    [[header()], [field('one')], [raw('one', Infinity)]],
    [[header()], [{ ...field('one'), displayKind: 'boolean', displayBoolean: null }], [raw('one', '')]],
  ];
  for (const args of cases) assert.throws(() => assembleSampleProductContext(...args), { code: 'incomplete_sample_product_history' });
  const empty = assembleSampleProductContext([header()], [field('empty', true, 0)], []);
  assert.deepEqual(empty.productsByLineId['line-a'].customFieldsByKey.empty.value, []);
});

test('unversioned Product lines expose only their actual capture and never infer a master description or dates', () => {
  const result = assembleSampleProductContext([{ ...header(), productRevision: null, historyAvailable: false }]);
  const product = result.productsByLineId['line-a'];
  assert.equal(product.name, 'Original name'); assert.equal(product.code, 'CODE');
  for (const key of ['description', 'created_at', 'updated_at', 'user_id', 'tags']) assert.equal(productDetailValue(product, key), '');
  assert.equal(productDetailValue(product, 'organization_id'), 'organization');
  assert.deepEqual({ ...assembleSampleProductContext([]).productsByLineId }, {});
  assert.equal(assembleSampleProductContext([]).primaryProductLineId, null);
});

test('Product display projection computes canonical requested keys once and omits empty and unknown selectors', () => {
  const product = assembleSampleProductContext([header()], [field('flag')], [raw('flag', false)]).productsByLineId['line-a'];
  const selectors = new Set(['name', 'unknown', 'constructor', 'project_field__splitter__missing', 'project_field__splitter__flag__splitter__ignored'].map(productDetailSelector));
  const values = productDetailProjection(product, selectors);
  assert.deepEqual({ ...values }, { name: 'Original name', project_field__splitter__flag: 'false' });
  assert.equal(Object.getPrototypeOf(values), null);
});

test('Product widgets select the actual request/row line, document line and sample fallback in order', () => {
  const report = { productDetailsByLineId: { primary: { name: 'Primary Product' }, document: { name: 'Document Product' }, request: { name: 'Request Product', project_field__splitter__flag: 'false' } },
    primaryProductLineId: 'primary', productLineId: 'document' };
  const selected = { widget: 'product_detail_widget', alias: 'name', label: 'Hidden widget title' };
  assert.equal(contextWidgetValue(selected, report, { sampleProductId: 'request' }), 'Request Product');
  assert.equal(contextWidgetValue(selected, report), 'Document Product');
  assert.equal(contextWidgetValue(selected, { ...report, productLineId: null }), 'Primary Product');
  assert.equal(contextWidgetValue(selected, report, { sampleProductId: 'missing' }), '');
  assert.equal(contextWidgetValue({ ...selected, alias: 'project_field__splitter__flag__splitter__ignored' }, report, { sampleProductId: 'request' }), 'false');
  assert.equal(contextWidgetValue({ ...selected, alias: 'constructor' }, report), '');
  assert.equal(contextWidgetValue(selected, null), '');
});

test('Product Required and Default Value settings do not require an entered value or replace domain output', () => {
  const field = { id: 'product', widget: 'product_detail_widget', valueType: 'text', alias: 'name', required: true,
    repeatGroupId: null, defaultState: 'present', defaultText: 'Configured default' };
  const model = { fieldsById: { product: field }, calculationOrder: [], expressions: {} };
  const result = calculateCapture(model, [{ id: 'root', groupId: null, parentId: null, position: 0 }], []);
  assert.equal(result.validation['product:root'].required, true);
  assert.deepEqual(result.validation['product:root'].errors, []);
  assert.deepEqual(result.values, []);
  assert.doesNotThrow(() => validateSubmissionValues(model, { values: [] }, result));
  assert.equal(contextWidgetValue(field, {}), '');
});
