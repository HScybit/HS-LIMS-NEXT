import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareMasterCustomFieldValues } from '../../src/masters/master-custom-field-values.js';

const identity = { organization_id: randomUUID() };
const client = { query() { throw new Error('Dropdown capture must not query reference catalogs.'); } };
const definition = changes => ({ id: randomUUID(), revision: 2, key: 'saved_key', label: 'Saved choice', fieldType: 'select',
  options: [{ id: randomUUID(), key: 'B', label: 'Current B' }], ...changes });
const previous = (field, value = 'A', changes = {}) => ({ fieldId: field.id, fieldRevision: 1, key: field.key,
  items: [{ value, optionId: randomUUID(), optionRevision: 1 }], ...changes });
const prepare = (kind, field, value, saved) => prepareMasterCustomFieldValues(kind, client, identity,
  { definitions: [field], entries: [{ fieldId: field.id, fieldRevision: field.revision, value }], previousFields: saved ? [saved] : [], timeZone: null });

for (const kind of ['product', 'parameter']) {
  test(`${kind} replacement dropdown keeps the previous key value without a foreign option reference`, async () => {
    const field = definition(); const saved = previous(definition()); const before = structuredClone(saved);
    const result = await prepare(kind, field, 'A', saved); const item = result.items[0];
    assert.equal(item.rawText, 'A'); assert.equal(item.interpretationState, 'invalid'); assert.equal(item.optionId, null); assert.equal(item.optionRevision, null);
    assert.equal(result.fields[0].displayText, 'A'); assert.deepEqual(saved, before);
  });
  test(`${kind} unresolved choices survive repeat captures and resolve a current option`, async () => {
    const field = definition(); const saved = previous(field, 'A', { items: [{ value: 'A', optionId: null, optionRevision: null }] });
    assert.equal((await prepare(kind, field, 'A', saved)).items[0].interpretationState, 'invalid');
    const option = { id: randomUUID(), key: 'A', label: 'Current A' };
    const result = await prepare(kind, { ...field, options: [option] }, 'A', saved);
    assert.equal(result.items[0].optionId, option.id); assert.equal(result.items[0].optionRevision, 2); assert.equal(result.fields[0].displayText, 'Current A');
  });
  test(`${kind} same-definition older choices require the same saved key`, async () => {
    const field = definition(); const saved = previous(field); const result = await prepare(kind, field, 'A', saved);
    assert.equal(result.items[0].optionId, saved.items[0].optionId); assert.equal(result.items[0].optionRevision, 1);
    await assert.rejects(prepare(kind, { ...field, key: 'renamed' }, 'A', saved), { code: `invalid_${kind}_custom_field_option` });
  });
  test(`${kind} dropdown continuity distinguishes raw types and retains ordered duplicates from another field type`, async () => {
    const field = definition({ allowsMultiple: true });
    const saved = previous(definition({ fieldType: 'text' }), '', { items: [{ value: 0 }, { value: false }, { value: 'A' }] });
    const result = await prepare(kind, field, [false, 0, 'A', 'A'], saved);
    assert.deepEqual(result.items.map(item => [item.rawKind, item.rawBoolean, item.rawNumber, item.rawText]),
      [['boolean', false, null, null], ['number', null, 0, null], ['text', null, null, 'A'], ['text', null, null, 'A']]);
    assert(result.items.every(item => item.interpretationState === 'invalid' && item.optionId === null));
    assert.equal(result.fields[0].displayText, 'A, A');
    for (const value of ['false', '0', 'new']) await assert.rejects(prepare(kind, field, [value], saved), { code: `invalid_${kind}_custom_field_option` });
  });
  test(`${kind} new unknown choices and missing or cleared history are rejected`, async () => {
    const field = definition();
    for (const saved of [undefined, previous(field, ''), previous(field, 'other'), previous(field, 'A', { key: 'another_key' })]) {
      await assert.rejects(prepare(kind, field, 'A', saved), { code: `invalid_${kind}_custom_field_option` });
    }
    assert.equal((await prepare(kind, field, '', undefined)).items[0].interpretationState, 'empty');
  });
}
