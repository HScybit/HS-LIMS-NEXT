import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField, userCustomFields } from '../../src/masters/custom-fields.js';
import { saveUserCustomFields, loadUserCustomFields } from '../../src/users/custom-fields.js';
import { listUsers } from '../../src/users/directory.js';
import { customFieldListDisplay } from '../../src/custom-fields/listing-values.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (actor, fn, readOnly = false) => withSession(actor.token, fn, { readOnly });
const account = async options => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
async function fixture() {
  const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] }); const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] });
  const define = input => work(author, (c, i) => saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0,
    key: 'field', label: 'Field', fieldType: 'text', associatedWith: 'users', showInList: true, showInFilter: true, ...input }));
  const update = (field, changes) => define({ ...Object.fromEntries(['id', 'key', 'label', 'fieldType', 'options', 'showInList', 'showInFilter', 'allowsMultiple', 'dateFormat', 'datetimeFormat'].map(key => [key, field[key]])),
    revision: field.revision, ...changes });
  const save = (values, revision = 0, subject = person, timeZone) => work(manager, async (c, i) => {
    const fields = await userCustomFields(c, i);
    return saveUserCustomFields(c, i, subject.userId, { requestId: randomUUID(), revision,
      customFields: fields.map(field => ({ fieldId: field.id, fieldRevision: field.revision, value: values[field.key] ?? '' })), ...(timeZone ? { customFieldTimeZone: timeZone } : {}) });
  });
  const list = (query = {}, actor = reader) => work(actor, (c, i) => listUsers(c, i, query), true);
  const row = async (subject = person) => (await list({ search: subject.username })).rows[0];
  const retire = field => work(author, (c, i) => retireCustomField(c, i, { id: field.id, revision: field.revision, requestId: randomUUID() }));
  return { author, manager, reader, person, define, update, save, list, row, retire };
}

test('user list values follow saved keys through replacement and renaming without inventing uncaptured values', async () => {
  const f = await fixture(); const text = await f.define({ key: 'saved', label: 'Original' });
  const zero = await f.define({ key: 'zero', fieldType: 'number' }); const flag = await f.define({ key: 'flag', fieldType: 'checkbox' });
  const value = `Saved-${randomUUID()}`; await f.save({ saved: value, zero: 0, flag: false });
  assert.deepEqual((await f.row()).customFields, { [text.key]: { displayValue: value }, [zero.key]: { displayValue: 0 }, [flag.key]: { displayValue: false } });
  assert.deepEqual((await f.row(f.reader)).customFields, {});
  await f.retire(text); const replacement = await f.define({ key: 'saved', label: 'Replacement' });
  assert.equal((await f.row()).customFields[replacement.key].displayValue, value); assert(!Object.hasOwn((await f.row()).customFields, text.id));
  assert.equal((await f.list({ filters: { 'pf:saved': { type: 'text', value } }, sort: { key: 'pf:saved', dir: 'asc' } })).rows[0].id, f.person.userId);
  await f.update(replacement, { key: 'renamed' }); assert.equal((await f.row()).customFields.renamed, undefined);
  assert.equal((await f.list({ search: value })).totalCount, 0);
  const reused = await f.define({ key: 'saved', label: 'Reused again' }); assert.equal((await f.row()).customFields[reused.key].displayValue, value);
  await f.save({ saved: '', renamed: '', zero: '', flag: false }, 1); assert.equal((await f.row()).customFields[reused.key].displayValue, '');
  assert.equal((await f.list({ search: value })).totalCount, 0);
});

test('dropdown listing and search preserve actual captured labels while current options determine the filter control', async () => {
  const f = await fixture(); const field = await f.define({ key: 'choice', fieldType: 'select', options: [{ id: randomUUID(), key: 'raw_choice', label: 'Original captured label' }] });
  await f.save({ choice: 'raw_choice' });
  await f.update(field, { options: field.options.map(option => ({ ...option, label: 'Current replacement label' })) });
  assert.equal((await f.row()).customFields[field.key].displayValue, 'Original captured label');
  for (const value of ['Original captured label', 'raw_choice']) {
    assert.equal((await f.list({ filters: { 'pf:choice': { type: 'select', value } } })).totalCount, 1);
    assert.equal((await f.list({ search: value })).rows[0].id, f.person.userId);
  }
  assert.equal((await f.list({ filters: { 'pf:choice': { type: 'select', value: 'Current replacement label' } } })).totalCount, 0);
  await assert.rejects(f.list({ filters: { 'pf:choice': { type: 'text', value: 'raw_choice' } } }), { code: 'invalid_user_filter' });
});

test('filter-only fields participate in search without returning hidden values, and nonfilterable values stay outside search', async () => {
  const f = await fixture(); const hidden = await f.define({ key: 'hidden', showInList: false }); const visible = await f.define({ key: 'visible', showInFilter: false });
  const hiddenValue = `Hidden-${randomUUID()}`; const visibleValue = `Visible-${randomUUID()}`; await f.save({ hidden: hiddenValue, visible: visibleValue });
  assert.deepEqual((await f.row()).customFields, { [visible.key]: { displayValue: visibleValue } });
  assert(!Object.hasOwn((await f.row()).customFields, hidden.key));
  assert.equal((await f.list({ search: hiddenValue })).totalCount, 1); assert.equal((await f.list({ search: visibleValue })).totalCount, 0);
  assert.equal((await f.list({ filters: { 'pf:hidden': { type: 'text', value: hiddenValue } } })).totalCount, 1);
  await assert.rejects(f.list({ filters: { 'pf:visible': { type: 'text', value: visibleValue } } }), { code: 'invalid_input' });
  await assert.rejects(f.list({ sort: { key: 'pf:hidden', dir: 'asc' } }), { code: 'invalid_user_sort' });
});

test('custom user filters match literal raw arrays, numeric and boolean alternatives within the current capture', async () => {
  const f = await fixture(); await f.define({ key: 'literal', allowsMultiple: true }); await f.define({ key: 'zero', fieldType: 'number' }); await f.define({ key: 'flag', fieldType: 'checkbox' });
  await f.save({ literal: ['First', '  Kept %_\\.* spacing  ', 'Last'], zero: 0, flag: false });
  for (const [key, values] of [['literal', ['%_\\.*', 'Kept %_\\.* spacing', 'First']], ['zero', ['0', '0x0']], ['flag', ['false', 'NO', '0']]]) {
    for (const value of values) assert.equal((await f.list({ filters: { [`pf:${key}`]: { type: 'text', value } } })).totalCount, 1);
  }
  assert.equal((await f.list({ filters: { 'pf:literal': { type: 'text', value: 'Kept  %_\\.* spacing' } } })).totalCount, 0);
  assert.equal((await f.list({ filters: { 'pf:zero': { type: 'text', value: 'false' } } })).totalCount, 0);
  await f.save({ literal: [], zero: '', flag: true }, 1);
  assert.equal((await f.list({ filters: { 'pf:literal': { type: 'text', value: 'First' } } })).totalCount, 0);
  assert.equal((await f.list({ filters: { 'pf:flag': { type: 'text', value: 'YES' } } })).totalCount, 1);
});

test('custom display sorting preserves typed kind order, binary text order, missing values and stable paging', async () => {
  const f = await fixture(); await f.define({ key: 'mixed' }); const marker = `Sorting ${randomUUID()}`; const people = [];
  const missing = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [missing.userId, marker]);
  for (const value of [-2, 0, '', 'A', 'a', false, true]) {
    const person = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
    await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [person.userId, marker]); await f.save({ mixed: value }, 0, person); people.push(person);
  }
  const expected = [missing, ...people].map(person => person.userId);
  const ascending = await f.list({ search: marker, sort: { key: 'pf:mixed', dir: 'asc' } }); assert.equal(ascending.totalCount, 8); assert.deepEqual(ascending.rows.map(row => row.id), expected);
  assert.deepEqual((await f.list({ search: marker, sort: { key: 'pf:mixed', dir: 'desc' } })).rows.map(row => row.id), [...expected].reverse());
  const paged = [];
  for (let page = 1; page <= 3; page++) paged.push(...(await f.list({ search: marker, page, pageSize: 3, sort: { key: 'pf:mixed', dir: 'asc' } })).rows.map(row => row.id));
  assert.deepEqual(paged, expected);
});

test('current date formatting uses raw values from the pinned capture even after a type change and replacement', async () => {
  const f = await fixture(); let field = await f.define({ key: 'dates', allowsMultiple: true }); await f.save({ dates: ['2026-12-31', 'invalid date'] });
  field = await f.update(field, { fieldType: 'date', dateFormat: 'DD/MM/YYYY' });
  let entry = (await f.row()).customFields[field.key]; assert.deepEqual(entry.value, ['2026-12-31', 'invalid date']);
  assert.equal(customFieldListDisplay(entry, field), '31/12/2026, invalid date');
  await f.retire(field); const replacement = await f.define({ key: 'dates', fieldType: 'date', allowsMultiple: true, dateFormat: 'YYYY/MM/DD' });
  entry = (await f.row()).customFields[replacement.key]; assert.deepEqual(entry.value, ['2026-12-31', 'invalid date']);
  assert.equal(customFieldListDisplay(entry, replacement), '2026/12/31, invalid date');
  await f.save({ dates: [] }, 1, f.person, 'UTC'); assert.deepEqual((await f.row()).customFields[replacement.key].value, []);
});

test('multiple historical definition identities never duplicate a current list row or substitute later unsaved values', async () => {
  const f = await fixture(); let field = await f.define({ key: 'reused' }); const value = `Original-${randomUUID()}`; await f.save({ reused: value });
  for (let index = 0; index < 6; index++) { await f.retire(field); field = await f.define({ key: 'reused', label: `Revision identity ${index}` }); }
  const result = await f.list({ search: value, sort: { key: 'pf:reused', dir: 'asc' } });
  assert.equal(result.totalCount, 1); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].customFields[field.key].displayValue, value);
});

test('field listing uses actual user authority and tenant context rather than forged JavaScript identity fields', async () => {
  const f = await fixture(); await f.define({ key: 'scoped' }); const value = `Scoped-${randomUUID()}`; await f.save({ scoped: value });
  const foreign = await account({ permissions: ['users.read'] });
  assert.equal((await f.list({ search: value }, foreign)).totalCount, 0);
  await assert.rejects(f.list({}, f.author), { code: 'forbidden' });
  await work(f.author, async (c, i) => { assert.deepEqual(await listUsers(c, { ...i, permission_codes: ['users.read'] }, { search: value }), { rows: [], totalCount: 0 }); }, true);
  await work(f.reader, async (c, i) => { assert.deepEqual(await listUsers(c, { ...i, organization_id: foreign.organizationId }, { search: value }), { rows: [], totalCount: 0 }); }, true);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.reader.userId]); await assert.rejects(f.list({}), { code: 'unauthenticated' });
});

test('directory metadata, counts and field values remain in one read-only snapshot across concurrent saves', async () => {
  const f = await fixture(); const field = await f.define({ key: 'snapshot' }); await f.save({ snapshot: 'Before' });
  await work(f.reader, async (c, i) => {
    assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    const before = await listUsers(c, i, { search: f.person.username });
    await f.save({ snapshot: 'After' }, 1);
    assert.deepEqual(await listUsers(c, i, { search: f.person.username }), before);
    assert.equal(before.rows[0].customFields[field.key].displayValue, 'Before');
  }, true);
  assert.equal((await f.row()).customFields[field.key].displayValue, 'After');
  assert.equal((await work(f.reader, (c, i) => loadUserCustomFields(c, i, f.person.userId), true)).revision, 2);
});
