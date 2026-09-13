import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareProductCustomFieldValues } from '../../src/masters/product-custom-fields.js';
import { customFieldValuesInput } from '../../src/custom-fields/value-input.js';
import { customFieldFormDisplayValue } from '../../src/custom-fields/form-values.js';

const identity = { organization_id: randomUUID(), user_id: randomUUID(), permission_codes: ['masters.manage'] };
const field = (fieldType = 'text', changes = {}) => ({ id: randomUUID(), revision: 1, fieldType, label: 'Synthetic field', options: [],
  allowsMultiple: false, isRequired: false, dateFormat: fieldType === 'date' ? 'YYYY-MM-DD' : '', datetimeFormat: fieldType === 'date_time' ? 'YYYY-MM-DD HH:mm:ss' : '', ...changes });
const entry = (field, value) => ({ fieldId: field.id, fieldRevision: field.revision, value });
const noQueries = { query() { throw new Error('This value must not query references.'); } };
const prepare = (definition, value, extras = {}) => prepareProductCustomFieldValues(noQueries, identity,
  { definitions: [definition], entries: customFieldValuesInput([entry(definition, value)]), ...extras });

test('Product field encoding preserves raw and displayed zero/false, numeric string provenance and actual array shape', async () => {
  const text = field('text', { isRequired: true }); const multiple = await prepare(text, []);
  assert.equal(multiple.fields[0].isArray, true); assert.equal(multiple.fields[0].valueCount, 0); assert.equal(multiple.fields[0].displayText, '');
  for (const value of [false, 0, 189761652901714800, Number.MIN_VALUE, Number.MAX_VALUE, '01.00']) {
    const saved = await prepare(text, value); const row = saved.items[0];
    assert.equal(row.rawKind, typeof value === 'string' ? 'text' : typeof value);
    assert.equal(row.rawNumberText, typeof value === 'number' ? String(value) : null);
    assert.equal(saved.fields[0].displayKind, row.rawKind);
    assert.equal(row.interpretationState, 'valid'); assert.equal(row.parsedNumber, null);
  }
  assert.equal((await prepare(text, 189761652901714800)).items[0].rawNumberText, '189761652901714800');
  const checked = await prepare(field('checkbox', { isRequired: true }), false);
  assert.equal(checked.items[0].parsedBoolean, false); assert.equal(checked.fields[0].displayBoolean, false);
  assert.equal((await prepare(field('checkbox'), 'false')).items[0].parsedBoolean, true);
});

test('Product numeric and date interpretation retains invalid raw values separately from valid parsed values', async () => {
  const numbers = await prepare(field('number', { allowsMultiple: true }), ['0x10', 'bad', 'Infinity', false, 0, '01.00']);
  assert.deepEqual(numbers.items.map((item) => item.parsedNumber), [16, null, null, 0, 0, 1]);
  assert.deepEqual(numbers.items.map((item) => item.interpretationState), ['valid', 'invalid', 'invalid', 'valid', 'valid', 'valid']);
  await assert.rejects(prepare(field('number'), 'bad'), { code: 'invalid_custom_field_value' });
  const invalid = await prepare(field('date'), '2026-02-31', { timeZone: 'UTC' });
  assert.equal(invalid.items[0].interpretationState, 'invalid'); assert.equal(invalid.items[0].parsedTimestamp, null);
  assert.equal(invalid.fields[0].displayText, '2026-02-31');
  const gap = await prepare(field('date_time'), '2026-03-08T02:30', { timeZone: 'America/New_York' });
  assert.equal(gap.items[0].parsedTimestamp, '2026-03-08 07:30:00.000+00'); assert.equal(gap.fields[0].displayText, '2026-03-08 03:30:00');
  assert.equal(gap.fields[0].timeZoneDataVersion, '2026c'); assert.equal(gap.fields[0].dateParserVersion, 'moment@2.30.1;moment-timezone@0.6.3');
  const beforeCommonEra = await prepare(field('date_time'), '0000-01-01T00:00:00Z', { timeZone: 'UTC' });
  assert.equal(beforeCommonEra.items[0].parsedTimestamp, '0001-01-01 00:00:00.000+00 BC');
  assert.equal(customFieldFormDisplayValue(['2026-02-31'], field('date', { allowsMultiple: true }), [], () => { throw new Error('Repeated dates remain text controls.'); }), '2026-02-31');
});

test('Product capture rejects changed definition sets, required values and misplaced timezones before querying references', async () => {
  const definition = field();
  for (const entries of [undefined, [], [entry({ ...definition, revision: 2 }, '')], [entry(field(), '')]]) {
    await assert.rejects(prepareProductCustomFieldValues(noQueries, identity, { definitions: [definition], entries }), { code: 'product_custom_fields_changed' });
  }
  await assert.rejects(prepare(field('text', { isRequired: true }), ''), { code: 'invalid_custom_field_value' });
  await assert.rejects(prepare(field('text', { isRequired: true, allowsMultiple: true }), [false]), { code: 'invalid_custom_field_value' });
  await assert.rejects(prepare(definition, '', { timeZone: 'UTC' }), { code: 'invalid_custom_field_timezone' });
  await assert.rejects(prepare(field('date'), ''), { code: 'invalid_custom_field_timezone' });
  const preserved = await prepareProductCustomFieldValues(noQueries, identity, { definitions: [], entries: undefined, previousFields: [{ fieldId: randomUUID() }] });
  assert.deepEqual(preserved, { provided: false, count: 1, fields: [], items: [] });
  const cleared = await prepareProductCustomFieldValues(noQueries, identity, { definitions: [], entries: [] });
  assert.deepEqual(cleared, { provided: true, count: 0, fields: [], items: [] });
});

test('select encoding keeps primitive keys and only preserves removed options actually captured on the previous Product', async () => {
  const zero = { id: randomUUID(), key: '0', label: 'Zero' }; const falseOption = { id: randomUUID(), key: 'false', label: 'False' };
  const definition = field('select', { revision: 2, allowsMultiple: true, options: [zero, falseOption] });
  const previousId = randomUUID();
  const previousFields = [{ fieldId: definition.id, items: [{ value: 'old', optionId: previousId, optionRevision: 1 }] }];
  const saved = await prepare(definition, [0, false, 'old'], { previousFields });
  assert.deepEqual(saved.items.map((item) => [item.optionId, item.optionRevision]), [[zero.id, 2], [falseOption.id, 2], [previousId, 1]]);
  assert.equal(saved.fields[0].displayText, 'Zero, False, old');
  await assert.rejects(prepare(definition, ['old']), { code: 'invalid_product_custom_field_option' });
  await assert.rejects(prepare(definition, ['missing'], { previousFields }), { code: 'invalid_product_custom_field_option' });
  await assert.rejects(prepare(field('lookup'), 'invented-source'), { code: 'invalid_product_custom_field_lookup' });
  assert.equal((await prepare(field('lookup'), '')).items[0].interpretationState, 'empty');
});

test('user and attachment references load in two batches and reject unavailable or wrong-field references', async () => {
  const user = field('multi_user_select'); const second = field('multi_user_select'); const file = field('attachment');
  const userId = randomUUID(); const fileId = randomUUID();
  const entries = customFieldValuesInput([entry(user, [userId.toUpperCase()]), entry(second, [userId]), entry(file, fileId)]);
  const queries = [];
  const client = { async query(sql, args) {
    queries.push({ sql, args }); assert.equal(args[0], identity.organization_id);
    if (sql.includes('method_access_user_labels')) return { rows: [{ user_id: userId }] };
    return { rows: [{ id: fileId, field_id: file.id }] };
  } };
  const saved = await prepareProductCustomFieldValues(client, identity, { definitions: [user, second, file], entries });
  assert.equal(queries.length, 2); assert.deepEqual(queries[0].args[1], [userId]); assert.deepEqual(queries[1].args[1], [fileId]);
  assert.equal(saved.items[0].rawText, userId.toUpperCase()); assert.equal(saved.items[0].userId, userId);
  const missing = { query: async () => ({ rows: [] }) };
  await assert.rejects(prepareProductCustomFieldValues(missing, identity, { definitions: [user], entries: customFieldValuesInput([entry(user, [userId])]) }), { code: 'invalid_product_custom_field_user' });
  const wrongField = { query: async () => ({ rows: [{ id: fileId, field_id: randomUUID() }] }) };
  await assert.rejects(prepareProductCustomFieldValues(wrongField, identity, { definitions: [file], entries: customFieldValuesInput([entry(file, fileId)]) }), { code: 'invalid_product_custom_field_attachment' });
});
