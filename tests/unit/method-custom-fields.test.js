import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { methodInput } from '../../src/masters/methods.js';
import { methodGenerationInput } from '../../src/masters/method-custom-field-generation.js';
import { generateMethodScheme } from '../../src/custom-fields/product-generation.js';
import { runMasterGeneration } from '../../src/custom-fields/product-generation-runner.js';

test('Method input distinguishes omitted fields, empty captures and raw zero or false values', () => {
  const base = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Method', uuid: 'ISO' };
  const omitted = methodInput(base);
  assert.equal(omitted.customFieldsProvided, false); assert.equal(omitted.customFields, undefined);
  assert.deepEqual(methodInput({ ...base, customFields: [] }).customFields, []);
  assert.equal(methodInput({ ...base, customFields: [] }).customFieldsProvided, true);
  const fields = [0, false, '', null, []].map(value => ({ fieldId: randomUUID(), fieldRevision: 1, value }));
  assert.deepEqual(methodInput({ ...base, customFields: fields }).customFields.map(field => field.value), [0, false, '', '', []]);
  assert.throws(() => methodInput({ ...base, customFieldTimeZone: 'UTC' }), { code: 'invalid_custom_field_timezone' });
  assert.throws(() => methodInput({ ...base, customFields: null }), { code: 'invalid_custom_field_values' });
  assert.throws(() => methodInput({ ...base, customFields: [fields[0], fields[0]] }), { code: 'duplicate_custom_field_value' });
});

test('Method generation receives only the bounded source form draft before required-field validation', () => {
  const user = randomUUID();
  const input = { method: { uuid: 'ISO', decimalScale: 0, parseNumber: false, accessUserIds: [user.toUpperCase()] }, customFields: [] };
  const command = methodGenerationInput(input);
  assert.deepEqual(command.doc, { name: '', description: '', uuid: 'ISO', decimal_places: 0, parse_num: false, has_access: [user] });
  assert.equal(methodGenerationInput({ ...input, method: { decimalScale: '', parseNumber: 'false' } }).doc.decimal_places, '');
  for (const method of [{ decimalScale: {} }, { decimalScale: Infinity }, { name: '\0' }, { parseNumber: 'yes' }, { isNabl: true }, { accessUserIds: [user, user.toUpperCase()] }]) {
    assert.throws(() => methodGenerationInput({ ...input, method }));
  }
});

test('Method schemes preserve source entity fields, counters, padding and missing context', async () => {
  const input = { field: { id: randomUUID(), scheme: '', paddedNumber: 2, splitter: '/' },
    doc: { name: 'Method name', uuid: 'ISO', decimal_places: 0, parse_num: false, has_access: ['analyst-1', 'analyst-2'],
      project_field_data: { text: { display_value: 'saved text' }, zero: { value: 0 }, flag: { value: false } } },
    settings: { nonNablStartNumber: '7', currentMonthFormat: 'short' }, counts: { methods: 3, samples: 4 },
    clock: { year: 2026, month: 9, day: 16, timestamp: Date.UTC(2026, 8, 16, 12, 30) }, latestValue: async () => 'ISO/009' };
  for (const [scheme, expected] of [
    ['{{entity.uuid}}/{{total_counter}}', 'ISO/0010'], ['{{nabl_counter}}', '0010'],
    ['{{samples_counter}}/{{sample_category_counter}}', '005/005'], ['{{entity.uuid}}/{{scheme_counter}}', 'ISO/0010'],
    ['{{entity.uuid}}/{{scheme_category_counter}}', 'ISO/0010'],
    ['{{entity.name}}/{{entity.decimal_places}}/{{entity.parse_num}}/{{entity.has_access}}', 'Method name/0/false/analyst-1, analyst-2'],
    ['{{text}}/{{zero}}/{{flag}}/{{entity.project_field_data.zero}}', 'saved text/0/false/0'],
    ['{{product_name}}/{{product_abbr}}/{{category_name}}/{{customer_name}}/{{sample_id}}/{{nabl_term}}', '/////'],
    ['{{current_month}}/{{timestamp_date}}/{{financial_year}}', 'Sept/16-09-2026/26-27'],
    ['{{entity.constructor}}/{{entity.__proto__}}/{{missing}}', '//'],
  ]) assert.equal(await generateMethodScheme({ ...input, field: { ...input.field, scheme } }), expected, scheme);
});

test('Method generation worker resolves ordered dependencies without borrowing Product counts', async () => {
  const fields = [{ id: randomUUID(), key: 'serial', label: 'Serial', fieldType: 'text', generatedAt: 'on_init', scheme: '{{entity.uuid}}/{{total_counter}}' },
    { id: randomUUID(), key: 'copied', label: 'Copied', fieldType: 'text', generatedAt: 'on_submit', scheme: '{{serial}}/{{entity.parse_num}}' }];
  const result = await runMasterGeneration({ kind: 'method', fields, values: Object.fromEntries(fields.map(field => [field.id, ''])),
    doc: { uuid: 'ISO', parse_num: false, project_field_data: {} }, settings: {}, counts: { methods: 3, products: 500, samples: 0 },
    clock: {}, timeZone: null, fieldId: null, mode: 'create' }, async () => { throw new Error('These schemes do not need a history scan.'); });
  assert.deepEqual(result, fields.map((field, index) => ({ fieldId: field.id, value: index ? 'ISO/4/false' : 'ISO/4' })));
});
