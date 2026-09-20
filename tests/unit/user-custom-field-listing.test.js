import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { userListInput } from '../../src/users/input.js';
import { loadUserListingValues } from '../../src/users/custom-field-listing.js';
import { customFieldListDisplay, userCustomFieldColumnKey } from '../../src/custom-fields/listing-values.js';

const identity = { organization_id: randomUUID() };
const definition = changes => ({ id: randomUUID(), key: 'saved_key', fieldType: 'text', showInList: true, showInFilter: true, options: [], ...changes });
const captured = changes => ({ recordId: randomUUID(), revision: 3, fieldId: randomUUID(), key: 'saved_key', isArray: false, valueCount: 1,
  displayKind: 'text', displayText: 'Captured label', displayNumber: null, displayBoolean: null, ...changes });

test('user-list column and filter keys survive definition replacement and keep base names separate', () => {
  const first = definition(); const replacement = definition();
  assert.equal(userCustomFieldColumnKey(first), userCustomFieldColumnKey(replacement));
  assert.equal(userCustomFieldColumnKey(definition({ key: 'displayName' })), 'pf:displayName');
  const query = { filters: { 'pf:saved_key': { type: 'text', value: '  %_\\.* false  ' } }, sort: { key: 'pf:saved_key', dir: 'desc' } };
  assert.deepEqual(userListInput(query, [first]), userListInput(query, [replacement]));
  assert.deepEqual(userListInput(query, [replacement]).filters, { 'pf:saved_key': { type: 'text', value: '%_\\.* false' } });
  const special = definition({ key: '__proto__' });
  assert.deepEqual(userListInput({ filters: { 'pf:__proto__': { type: 'text', value: 'safe' } } }, [special]).filters, { 'pf:__proto__': { type: 'text', value: 'safe' } });
});

test('custom filter controls and visibility are validated against actual supplied listing definitions', () => {
  const field = definition({ fieldType: 'select', options: [{ key: 'A', label: 'Original label' }] });
  assert.deepEqual(userListInput({ filters: { 'pf:saved_key': { type: 'select', value: 'Original label' } } }, [field]).filters,
    { 'pf:saved_key': { type: 'select', value: 'Original label' } });
  assert.throws(() => userListInput({ filters: { 'pf:saved_key': { type: 'text', value: 'A' } } }, [field]), { code: 'invalid_user_filter' });
  assert.deepEqual(userListInput({ filters: { 'pf:saved_key': { type: 'text', value: '' } } }, [definition()]).filters, {});
  for (const fields of [[], [definition({ key: 'renamed' })], [definition({ showInFilter: false })]]) {
    assert.throws(() => userListInput({ filters: { 'pf:saved_key': { type: 'text', value: 'A' } } }, fields), { code: 'invalid_input' });
  }
  const hidden = definition({ showInList: false });
  assert.equal(userListInput({ filters: { 'pf:saved_key': { type: 'text', value: 'A' } } }, [hidden]).filters['pf:saved_key'].value, 'A');
  assert.throws(() => userListInput({ sort: { key: 'pf:saved_key', dir: 'asc' } }, [hidden]), { code: 'invalid_user_sort' });
});

test('custom list filters reject malformed transports and sort fragments before becoming SQL', () => {
  const fields = [definition()];
  for (const filter of [null, [], {}, { type: 'relation', value: [] }, { type: 'text', value: [] }, { type: 'text', value: 'x\0y' },
    { type: 'text', value: '\ud800' }, { type: 'text', value: 'x'.repeat(501) }, { type: 'text', value: 'x', organizationId: randomUUID() }]) {
    assert.throws(() => userListInput({ filters: { 'pf:saved_key': filter } }, fields));
  }
  for (const sort of [{ key: 'pf:saved_key', dir: 'asc; SELECT 1' }, { key: 'pf:saved_key; SELECT 1', dir: 'asc' },
    { key: ['pf:saved_key'], dir: 'asc' }, { key: 'pf:saved_key', dir: 'asc', extra: true }]) assert.throws(() => userListInput({ sort }, fields));
});

test('empty pages and filter-only columns do not load listing values', async () => {
  const client = { async query() { assert.fail('No value query is needed.'); } }; const rows = [{ id: randomUUID() }]; const empty = [];
  assert.equal(await loadUserListingValues(client, identity, empty, [definition()]), empty);
  assert.equal(await loadUserListingValues(client, identity, rows, []), rows);
  assert.equal(await loadUserListingValues(client, identity, rows, [definition({ showInList: false })]), rows);
});

test('listing values retain saved keys across metadata refresh and do not mutate base rows', async () => {
  const row = { id: randomUUID(), displayName: 'Actual member', roles: [] }; const empty = { id: randomUUID() }; const rows = [empty, row]; const before = structuredClone(rows);
  const field = definition(); const zero = definition({ key: 'zero' }); const flag = definition({ key: 'flag' }); const absent = definition({ key: 'absent' }); let calls = 0;
  const records = [captured({ recordId: row.id }), captured({ recordId: row.id, key: 'zero', displayKind: 'number', displayNumber: 0 }),
    captured({ recordId: row.id, key: 'flag', displayKind: 'boolean', displayBoolean: false })];
  const result = await loadUserListingValues({ async query(_sql, args) { calls++; assert.deepEqual(args, [identity.organization_id, [empty.id, row.id], ['saved_key', 'zero', 'flag', 'absent']]); return { rows: records }; } }, identity, rows, [field, zero, flag, absent]);
  assert.equal(calls, 1); assert.deepEqual(rows, before); assert.deepEqual(result[0], { ...empty, customFields: {} });
  assert.deepEqual(result[1].customFields, { saved_key: { displayValue: 'Captured label' }, zero: { displayValue: 0 }, flag: { displayValue: false } });
  assert.equal(customFieldListDisplay(result[1].customFields[zero.key], zero), '0'); assert.equal(customFieldListDisplay(result[1].customFields[flag.key], flag), 'false');
  assert(!Object.hasOwn(result[1].customFields, records[0].fieldId));
});

test('current date columns load exact old capture identities and preserve raw arrays for current formatting', async () => {
  const row = { id: randomUUID() }; const field = definition({ fieldType: 'date', dateFormat: 'YYYY/MM/DD' });
  const original = captured({ recordId: row.id, isArray: true, valueCount: 3 }); let calls = 0;
  const client = { async query(_sql, args) {
    calls++;
    if (calls === 1) return { rows: [original] };
    assert.deepEqual(args, [identity.organization_id, [row.id], [3], [original.fieldId]]);
    return { rows: [{ recordId: row.id, fieldId: original.fieldId, position: 0, kind: 'text', text: '2026-12-31' },
      { recordId: row.id, fieldId: original.fieldId, position: 1, kind: 'boolean', boolean: false },
      { recordId: row.id, fieldId: original.fieldId, position: 2, kind: 'text', text: 'invalid date' }] };
  } };
  const result = await loadUserListingValues(client, identity, [row], [field]); assert.equal(calls, 2);
  assert.deepEqual(result[0].customFields[field.key], { displayValue: 'Captured label', value: ['2026-12-31', false, 'invalid date'] });
  assert.equal(customFieldListDisplay(result[0].customFields[field.key], field), '2026/12/31, false, invalid date');
});

test('a saved key named __proto__ remains an own data property without changing the response prototype', async () => {
  const row = { id: randomUUID() }; const field = definition({ key: '__proto__' });
  const result = await loadUserListingValues({ async query() { return { rows: [captured({ recordId: row.id, key: '__proto__' })] }; } }, identity, [row], [field]);
  assert.equal(Object.getPrototypeOf(result[0].customFields), Object.prototype);
  assert(Object.hasOwn(result[0].customFields, '__proto__')); assert.deepEqual(result[0].customFields.__proto__, { displayValue: 'Captured label' });
});

test('duplicate saved keys and incomplete date history fail visibly instead of inventing list values', async () => {
  const row = { id: randomUUID() }; const field = definition({ fieldType: 'date' }); const record = captured({ recordId: row.id });
  await assert.rejects(loadUserListingValues({ async query() { return { rows: [record, { ...record, fieldId: randomUUID() }] }; } }, identity, [row], [field]), { code: 'incomplete_user_custom_fields' });
  for (const items of [[], [{ recordId: row.id, fieldId: record.fieldId, position: 1, kind: 'text', text: '2026-12-31' }],
    [{ recordId: row.id, fieldId: record.fieldId, position: 0, kind: 'number', number: null }]]) {
    let calls = 0;
    await assert.rejects(loadUserListingValues({ async query() { return { rows: calls++ === 0 ? [record] : items }; } }, identity, [row], [field]), { code: 'incomplete_user_custom_fields' });
  }
});
