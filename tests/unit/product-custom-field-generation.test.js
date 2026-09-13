import test from 'node:test';
import assert from 'node:assert/strict';
import { generateProductScheme, normalizeSchemeValue, padSchemeNumber, parseSchemeCounter, schemeNumber } from '../../src/custom-fields/product-generation.js';

const clock = { year: 2026, month: 3, day: 9, timestamp: 1773014400000 };
const field = { id: 'synthetic-field', paddedNumber: 2, nonNablDisplayTerm: 'N' };
const generate = (scheme, extra = {}) => generateProductScheme({ field: { ...field, scheme }, clock,
  doc: { name: 'Water', abbr: 'W', project_field_data: {} }, counts: { products: 11, samples: 24 },
  latestValue: async () => { throw new Error('Unexpected counter lookup'); }, ...extra });

test('Product schemes retain source counter parsing and leading padding semantics', () => {
  assert.equal(padSchemeNumber(123, { paddedNumber: 2 }), '00123');
  assert.equal(padSchemeNumber(7, { paddedNumber: 2.9 }), '007');
  assert.equal(padSchemeNumber(-3, { paddedNumber: 2 }), '00-3');
  assert.equal(padSchemeNumber(7, { paddedNumber: 0 }, 4), '0007');
  assert.equal(schemeNumber('1e3'), 1); assert.equal(schemeNumber('invalid', 4), 4);
  assert.equal(parseSchemeCounter('PREFIX/0007/2026', { scheme: 'PREFIX/{{scheme_counter}}/{{current_year}}', splitter: '/' }, 'scheme_counter'), 7);
  assert.equal(parseSchemeCounter('Q(1)-0012-2026', {}, 'scheme_counter', 'Q(1)-.*-2026'), 12);
  assert.equal(parseSchemeCounter('P-AB12CD34-X', {}, 'scheme_counter', 'P-.*-X'), 34);
  assert.equal(parseSchemeCounter('P-0012-2026', {}, 'scheme_counter', 'P-.*-.*'), 2026);
  assert.equal(parseSchemeCounter('-12 tail', {}, 'scheme_counter'), -12);
});

test('Product schemes use source defaults, financial-year boundaries, settings and source Product context', async () => {
  assert.equal(await generate('{{financial_year}}/{{current_year}}/{{current_month}}/{{timestamp_date}}/{{timestamp_date_day}}/{{timestamp}}'), '25-26/2026/03/09-03-2026/09/1773014400000');
  assert.equal(await generate('{{financial_year}}/{{current_month}}', { clock: { ...clock, month: 4 },
    settings: { currentYearDigits: '4', nextYearDigits: '2', separator: '/', currentMonthFormat: 'long' } }), '2026/27/April');
  assert.equal(await generate('{{current_year}}/{{current_month}}', { clock: { ...clock, month: 9 },
    settings: { currentYearDigits: '0', currentMonthFormat: 'short' } }), '2026/Sept');
  assert.equal(await generate('{{nabl_counter}}/{{total_counter}}/{{samples_counter}}/{{sample_category_counter}}'), '0012/0012/0025/0025');
  assert.equal(await generate('{{total_counter}}', { settings: { nonNablStartNumber: '9tail' } }), '0020');
  assert.equal(await generate('{{product_name}}/{{product_abbr}}/{{nabl_term}}/{{customer_name}}/{{category_abbr}}'), 'Water/W/N//');
});

test('Product schemes resolve Custom Field displays and safe own entity paths without losing zero or false', async () => {
  const doc = { name: 'Water', tags: ['A', 'B'], project_field_data: { zero: { value: 0, display_value: 0 },
    checked: { value: false, display_value: false }, choices: { value: ['A'], display_value: 'Alpha' }, empty: { value: 'raw', display_value: '' } } };
  assert.equal(await generate('{{zero}}|{{checked}}|{{choices}}|{{empty}}|{{entity.tags}}|{{entity.project_field_data.zero.value}}', { doc }), '0|false|Alpha||A, B|0');
  assert.equal(await generate('{{entity.constructor}}|{{entity.__proto__.name}}|{{entity.name-no}}|{{missing}}', { doc }), '|||');
  assert.equal(normalizeSchemeValue([0, false, '', null, { name: 'Name' }]), '0, false, Name');
  assert.equal(normalizeSchemeValue(new Date('invalid')), '');
  // String replacement, including its $ metacharacters, is observable in the source generator.
  assert.equal(await generate('A{{product_name}}B', { doc: { name: '$&', project_field_data: {} } }), 'Aproduct_nameB');
});

test('Product counter schemes pass expanded patterns to the latest-value reader and preserve failures', async () => {
  const requests = [];
  const latestValue = async (request) => { requests.push(request); return 'W/0012/2026'; };
  assert.equal(await generateProductScheme({ field: { ...field, scheme: '{{product_abbr}}/{{scheme_counter}}/{{current_year}}', splitter: '/' },
    clock, doc: { abbr: 'W' }, counts: {}, latestValue }), 'W/0013/2026');
  assert.deepEqual(requests, [{ fieldId: field.id, pattern: 'W/.*/2026' }]);
  await assert.rejects(generate('{{scheme_counter}}', { latestValue: async () => { throw new Error('Synthetic history failure'); } }), /Synthetic history failure/);
});
