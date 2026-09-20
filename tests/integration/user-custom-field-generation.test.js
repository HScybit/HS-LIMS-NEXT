import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveUserCustomFields, loadUserCustomFields } from '../../src/users/custom-fields.js';
import { generateUserCustomFields } from '../../src/users/custom-field-generation.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function fixture(changes = {}) {
  const author = await account({ permissions: ['masters.manage'] });
  const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] });
  const define = input => work(author, (client, identity) => saveCustomField(client, identity, input));
  const definition = { id: randomUUID(), revision: 0, requestId: randomUUID(), key: 'serial', label: 'Serial', fieldType: 'text', associatedWith: 'users',
    scheme: 'U/{{scheme_counter}}', paddedNumber: 2, splitter: '/', generatedAt: 'on_submit', displayOrder: 0, ...changes };
  const field = await define(definition);
  const input = { user: { displayName: 'Unfinished name', email: 'unfinished' }, customFields: [{ fieldId: field.id, fieldRevision: 1, value: '' }] };
  return { author, manager, person, field, definition, define, input,
    generate: (command = input, actor = manager) => work(actor, (client, identity) => generateUserCustomFields(client, identity, command), true),
    save: (value, id = person.userId, revision = 0) => work(manager, (client, identity) => saveUserCustomFields(client, identity, id,
      { requestId: randomUUID(), revision, customFields: [{ fieldId: field.id, fieldRevision: 1, value }] })) };
}

test('User generation reads current captures including inactive members, excludes the edited user, and never saves a preview', async () => {
  const f = await fixture(); const before = await owner.query('SELECT count(*) FROM user_field_value_versions WHERE organization_id=$1', [f.author.organizationId]);
  const calls = [];
  const initial = await work(f.manager, (client, identity) => generateUserCustomFields({ query: (sql, args) => { calls.push(sql); return client.query(sql, args); } }, identity, f.input), true);
  assert.deepEqual(initial.values, [{ fieldId: f.field.id, value: 'U/001' }]); assert.equal(calls.length, 3);
  assert.deepEqual((await owner.query('SELECT count(*) FROM user_field_value_versions WHERE organization_id=$1', [f.author.organizationId])).rows, before.rows);
  await f.save('U/007');
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, f.person.userId]);
  assert.equal((await f.generate()).values[0].value, 'U/008');
  assert.equal((await f.generate({ ...f.input, userId: f.person.userId })).values[0].value, 'U/001');
  const context = await work(f.manager, client => client.query('SELECT * FROM users_scheme_context(true,false)'), true);
  assert.equal(context.rows[0].userCount, 3); assert.equal(context.rows[0].sampleCount, 0);
  assert.deepEqual(Object.keys(context.rows[0]).sort(), ['currentYearDigits', 'nextYearDigits', 'separator', 'currentMonthFormat', 'nonNablStartNumber', 'userCount', 'sampleCount'].sort());
});

test('User counters follow current saved keys across replaced definitions and stop matching renamed keys', async () => {
  const f = await fixture(); await f.save('U/009');
  await work(f.author, (client, identity) => retireCustomField(client, identity, { id: f.field.id, revision: 1, requestId: randomUUID() }));
  const replacement = await f.define({ ...f.definition, id: randomUUID(), requestId: randomUUID() });
  const input = { ...f.input, customFields: [{ fieldId: replacement.id, fieldRevision: 1, value: '' }] };
  assert.equal((await f.generate(input)).values[0].value, 'U/0010');
  await assert.rejects(f.generate(), { code: 'user_custom_fields_changed' });
  await f.define({ ...f.definition, id: replacement.id, revision: 1, requestId: randomUUID(), key: 'renamed' });
  assert.equal((await f.generate({ ...input, customFields: [{ ...input.customFields[0], fieldRevision: 2 }] })).values[0].value, 'U/001');
  assert.equal((await work(f.manager, (client, identity) => loadUserCustomFields(client, identity, f.person.userId), true)).customFields[0].key, 'serial');
});

test('User counters use latest creation order with microsecond precision and only current capture revisions', async () => {
  const f = await fixture();
  const later = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  await f.save('U/099'); await f.save('U/003', later.userId);
  await owner.query("UPDATE users SET created_at=CASE WHEN id=$1 THEN '2026-01-01 00:00:00.000001+00'::timestamptz ELSE '2026-01-01 00:00:00.000002+00'::timestamptz END WHERE id=ANY($2::uuid[])",
    [f.person.userId, [f.person.userId, later.userId]]);
  assert.equal((await f.generate()).values[0].value, 'U/004');
  await f.save('U/005', later.userId, 1); assert.equal((await f.generate()).values[0].value, 'U/006');
});

test('generation enforces User management, current definitions, tenant subjects and authenticated database reads', async () => {
  const f = await fixture(); const reader = await account({ organizationId: f.author.organizationId, permissions: ['users.read'] });
  const foreign = await account({ permissions: ['users.manage'] });
  for (const actor of [reader, f.author]) {
    await assert.rejects(f.generate(f.input, actor), { code: 'forbidden' });
    await assert.rejects(work(actor, client => client.query('SELECT * FROM users_scheme_context(true,true)'), true), { code: '42501' });
    assert.equal((await work(actor, client => client.query('SELECT * FROM user_field_generation_values'), true)).rowCount, 0);
  }
  await assert.rejects(f.generate({ ...f.input, userId: foreign.userId }), { code: 'user_not_found' });
  await assert.rejects(f.generate(f.input, foreign), { code: 'user_custom_fields_changed' });
  await assert.rejects(f.generate({ ...f.input, customFields: [] }), { code: 'user_custom_fields_changed' });
  await assert.rejects(f.generate({ ...f.input, fieldId: randomUUID() }), { code: 'invalid_scheme' });
  await f.save('U/077');
  assert.equal((await work(foreign, client => client.query('SELECT * FROM user_field_generation_values'), true)).rowCount, 0);
  await assert.rejects(work(f.manager, async client => {
    await client.query("SELECT set_config('app.organization_id',$1,true)", [foreign.organizationId]);
    assert.equal((await client.query('SELECT * FROM user_field_generation_values')).rowCount, 0);
    await client.query('SELECT * FROM users_scheme_context(true,true)');
  }, true), { code: '42501' });
  await assert.rejects(work(f.manager, client => client.query('SELECT * FROM credentials'), true), { code: '42501' });
});

test('simultaneous User previews reserve no numbers and actual saves enforce configured uniqueness', async () => {
  const f = await fixture({ validateUniqueness: true });
  const other = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  const previews = await Promise.all([f.generate(), f.generate()]); assert.deepEqual(previews[0], previews[1]);
  const saves = await Promise.allSettled([f.save(previews[0].values[0].value), f.save(previews[1].values[0].value, other.userId)]);
  assert.equal(saves.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(saves.find(item => item.status === 'rejected').reason.code, 'duplicate_user_custom_field');
});

test('database generation access rejects a revoked session in a current snapshot and on the next request', async () => {
  const f = await fixture(); await f.save('U/005');
  await work(f.manager, async client => {
    const id = (await client.query("SELECT current_setting('app.session_id') AS id")).rows[0].id;
    await owner.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [id]);
    assert.equal((await client.query('SELECT * FROM user_field_generation_values')).rowCount, 0);
    await assert.rejects(client.query('SELECT * FROM users_scheme_context(true,true)'), { code: '42501' });
  });
  await assert.rejects(f.generate(), { code: 'unauthenticated' });
});

test('User generation validates date provenance, reports invalid patterns and feeds earlier fields into later schemes', async () => {
  const f = await fixture({ scheme: '{{entity.name}}', generatedAt: 'on_init' });
  const copy = await f.define({ ...f.definition, id: randomUUID(), requestId: randomUUID(), key: 'copy', label: 'Copy', displayOrder: 1,
    scheme: '{{serial}}/{{entity.contact_number}}', generatedAt: 'on_submit' });
  const input = { ...f.input, user: { ...f.input.user, phone: '123' }, customFields: [...f.input.customFields, { fieldId: copy.id, fieldRevision: 1, value: '' }] };
  assert.deepEqual((await f.generate(input)).values.map(item => item.value), ['Unfinished name', 'Unfinished name/123']);
  assert.deepEqual((await f.generate({ ...input, userId: f.person.userId })).values.map(item => item.value), ['/123']);
  await assert.rejects(f.generate({ ...input, customFieldTimeZone: 'Asia/Kolkata' }), { code: 'invalid_custom_field_timezone' });
  await f.define({ ...f.definition, revision: 1, requestId: randomUUID(), scheme: '[{{scheme_counter}}' });
  await assert.rejects(f.generate({ ...input, customFields: [{ ...input.customFields[0], fieldRevision: 2 }, input.customFields[1]] }), { code: 'invalid_scheme' });
});

test('User generation uses current lookup labels for existing and newly generated selections with User-only authority', async () => {
  const f = await fixture({ scheme: '{{lookup}}', displayOrder: 2 });
  const source = await work(f.author, (client, identity) => saveLookupSourceObservation(client, identity,
    { id: randomUUID(), requestId: randomUUID(), revision: 0, sourceId: 'generation-' + randomUUID(), name: 'Generation lookup', lines: [{ id: 'A', label: 'Alpha' }, { id: 'B', label: 'Beta' }] }));
  const lookup = await f.define({ ...f.definition, id: randomUUID(), requestId: randomUUID(), key: 'lookup', label: 'Lookup', displayOrder: 0,
    fieldType: 'lookup', lookupSourceId: source.id, scheme: 'B' });
  const input = { ...f.input, customFields: [...f.input.customFields, { fieldId: lookup.id, fieldRevision: 1, value: 'A' }] };
  assert.deepEqual((await f.generate(input)).values, [{ fieldId: f.field.id, value: 'Alpha' }]);
  assert.deepEqual((await f.generate({ ...input, customFields: [input.customFields[0], { ...input.customFields[1], value: '' }] })).values,
    [{ fieldId: lookup.id, value: 'B' }, { fieldId: f.field.id, value: 'Beta' }]);
  assert.deepEqual((await f.generate({ ...input, customFields: [input.customFields[0], { ...input.customFields[1], value: 'missing' }] })).values,
    [{ fieldId: f.field.id, value: 'missing' }]);
});
