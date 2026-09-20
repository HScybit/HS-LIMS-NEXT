import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareMasterCustomFieldValues } from '../../src/masters/master-custom-field-values.js';

const identity = { organization_id: randomUUID() };
const field = changes => ({ id: randomUUID(), revision: 1, key: 'place', label: 'Place', fieldType: 'lookup', lookupSourceId: randomUUID(), options: [], ...changes });
const entry = (definition, value) => ({ fieldId: definition.id, fieldRevision: definition.revision, value });
function observed(sourceId, lineId, label, revision = 3) {
  return { sourceId, lineId, revision, labelKind: typeof label === 'string' ? 'text' : typeof label,
    labelText: typeof label === 'string' ? label : null, labelNumber: typeof label === 'number' ? label : null, labelBoolean: typeof label === 'boolean' ? label : null };
}
function client(rows = []) {
  const calls = [];
  return { calls, async query(sql, args) { assert.match(sql, /JOIN user_custom_field_lookup_lines/); calls.push({ sql, args }); return { rows }; } };
}
const prepare = (c, definitions, entries, previousFields = []) => prepareMasterCustomFieldValues('user', c, identity, { definitions, entries, previousFields });

test('user lookup captures batch shared source selections once and preserve raw order, duplicates and current labels', async () => {
  const first = field({ allowsMultiple: true }); const second = field({ lookupSourceId: first.lookupSourceId, key: 'other' });
  const c = client([observed(first.lookupSourceId, 'A', 'Current A'), observed(first.lookupSourceId, 'b', 'Current B')]);
  const result = await prepare(c, [first, second], [entry(first, ['b', 'A', 'b']), entry(second, 'A')]);
  assert.equal(c.calls.length, 1); assert.deepEqual(c.calls[0].args, [identity.organization_id, [first.lookupSourceId, first.lookupSourceId], ['b', 'A']]);
  assert.deepEqual(result.fields.map(row => row.displayText), ['Current B, Current A, Current B', 'Current A']);
  assert.deepEqual(result.items.map(item => [item.rawText, item.lookupSourceId, item.lookupRevision, item.lookupLineId]),
    ['b', 'A', 'b', 'A'].map(value => [value, first.lookupSourceId, 3, value]));
  assert(result.items.every(item => item.interpretationState === 'valid' && item.optionId === null));
});

test('identical raw IDs in separate sources keep their actual independent labels and observation references', async () => {
  const first = field(); const second = field({ key: 'second' });
  const c = client([observed(second.lookupSourceId, 'same', 'Second', 7), observed(first.lookupSourceId, 'same', 'First', 2)]);
  const result = await prepare(c, [first, second], [entry(first, 'same'), entry(second, 'same')]);
  assert.deepEqual(result.fields.map(row => row.displayText), ['First', 'Second']);
  assert.deepEqual(result.items.map(row => row.lookupRevision), [2, 7]); assert.equal(c.calls.length, 1);
});

test('lookup String matching retains raw numeric and boolean values and source array display cleanup', async () => {
  const multiple = field({ allowsMultiple: true }); const scalar = field({ key: 'scalar', lookupSourceId: multiple.lookupSourceId });
  const c = client([observed(multiple.lookupSourceId, '0', 0), observed(multiple.lookupSourceId, 'false', false), observed(multiple.lookupSourceId, 'other', 'Other')]);
  const result = await prepare(c, [multiple, scalar], [entry(multiple, [0, '0', false, 'other']), entry(scalar, 0)]);
  assert.deepEqual(result.items.map(item => item.rawKind), ['number', 'text', 'boolean', 'text', 'number']);
  assert.deepEqual(result.items.map(item => item.lookupLineId), ['0', '0', 'false', 'other', '0']);
  assert.equal(result.fields[0].displayText, 'Other'); assert.equal(result.fields[1].displayKind, 'number'); assert.equal(result.fields[1].displayNumber, 0);
});

test('unavailable lookups retain only matching previous saved-key raw values without fabricated references', async () => {
  const current = field(); const previous = { fieldId: randomUUID(), key: current.key, items: [{ value: 'retired' }] };
  const result = await prepare(client(), [current], [entry(current, 'retired')], [previous]);
  assert.equal(result.items[0].interpretationState, 'invalid'); assert.equal(result.fields[0].displayText, 'retired');
  assert.equal(result.items[0].lookupSourceId, null); assert.equal(result.items[0].lookupRevision, null); assert.equal(result.items[0].lookupLineId, null);
  for (const previousFields of [[], [{ ...previous, key: 'unrelated' }], [{ ...previous, items: [{ value: 'different' }] }]]) {
    await assert.rejects(prepare(client(), [current], [entry(current, 'retired')], previousFields), { code: 'invalid_user_custom_field_lookup' });
  }
  const unconfigured = { ...current, lookupSourceId: null }; const c = client();
  assert.equal((await prepare(c, [unconfigured], [entry(unconfigured, 'retired')], [previous])).items[0].interpretationState, 'invalid'); assert.equal(c.calls.length, 0);
});

test('reappearing choices use the actual current observation and new labels instead of old capture labels', async () => {
  const current = field(); const previous = { fieldId: current.id, key: current.key, displayValue: 'Old label', items: [{ value: 'again', lookupRevision: 1 }] };
  const result = await prepare(client([observed(current.lookupSourceId, 'again', 'New label', 5)]), [current], [entry(current, 'again')], [previous]);
  assert.equal(result.fields[0].displayText, 'New label'); assert.equal(result.items[0].lookupRevision, 5); assert.equal(result.items[0].interpretationState, 'valid');
});

test('empty and non-lookup user fields add no lookup query and retain explicit emptiness', async () => {
  for (const [definition, value] of [[field(), ''], [field({ allowsMultiple: true }), []], [field({ fieldType: 'text' }), 'text']]) {
    const c = client(); const result = await prepare(c, [definition], [entry(definition, value)]); assert.equal(c.calls.length, 0);
    assert(result.items.every(item => item.lookupSourceId === null && item.lookupRevision === null && item.lookupLineId === null));
  }
  const required = field({ isRequired: true }); await assert.rejects(prepare(client(), [required], [entry(required, '')]), { code: 'invalid_custom_field_value' });
});

test('inconsistent current selection rows fail without accepting foreign or duplicated references', async () => {
  const current = field(); const expected = observed(current.lookupSourceId, 'id', 'Label');
  for (const rows of [[expected, expected], [observed(randomUUID(), 'id', 'Foreign')], [observed(current.lookupSourceId, 'unrequested', 'Wrong')]]) {
    await assert.rejects(prepare(client(rows), [current], [entry(current, 'id')]), { code: 'incomplete_user_custom_fields' });
  }
});
