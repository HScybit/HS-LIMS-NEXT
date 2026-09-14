import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createUser } from '../../src/users/create.js';
import { updateUserAccount } from '../../src/users/accounts.js';
import { updateUserProfile } from '../../src/users/profiles.js';
import { saveUserCustomFields, loadUserCustomFields } from '../../src/users/custom-fields.js';
import { uploadUserFieldAttachment } from '../../src/users/custom-field-attachments.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options) { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; }
async function fixture() {
  const author = await account({ permissions: ['masters.manage'] });
  const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Creation field lab')", [author.organizationId, lab]);
  return { author, manager, reader, lab,
    input(changes = {}) { const id = randomUUID(); return { id, requestId: randomUUID(), revision: 0, username: `field-user-${id}`, email: `${id}@example.invalid`,
      displayName: 'New field user', password: 'Synthetic creation fields password', defaultRoleId: reader.roleId, laboratoryId: lab, ...changes }; },
    field: (fieldType = 'text', changes = {}) => work(author, (client, identity) => saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key: `field_${randomUUID().replaceAll('-', '')}`, label: 'Creation field', associatedWith: 'users', fieldType, ...changes })),
    create: (input, actor = manager) => work(actor, (client, identity) => createUser(client, identity, input)),
    load: id => work(reader, (client, identity) => loadUserCustomFields(client, identity, id), true) };
}
const entry = (field, value) => ({ fieldId: field.id, fieldRevision: field.revision, value });
async function noAccount(id) {
  for (const [table, key] of [['users', 'id'], ...['credentials', 'memberships', 'membership_roles', 'user_profiles', 'user_profile_versions', 'user_creation_commands'].map(table => [table, 'user_id']),
    ...['user_field_value_versions', 'user_version_custom_fields', 'user_version_custom_field_values'].map(table => [table, 'subject_user_id'])]) {
    assert.equal((await owner.query(`SELECT 1 FROM ${table} WHERE ${key}=$1`, [id])).rowCount, 0, table);
  }
}

test('creation preserves omitted fields and records explicit empty captures without changing legacy response or retry semantics', async () => {
  const f = await fixture(); const omitted = f.input(); const empty = f.input({ customFields: [] });
  const omittedResult = await f.create(omitted); assert.equal(Object.hasOwn(omittedResult, 'customFieldRevision'), false); assert.equal((await f.load(omitted.id)).recorded, false);
  const emptyResult = await f.create(empty); assert.equal(emptyResult.customFieldRevision, 1); assert.equal((await f.load(empty.id)).recorded, true);
  const field = await f.field();
  assert.deepEqual(await f.create(omitted), omittedResult); assert.deepEqual(await f.create(empty), emptyResult);
  await assert.rejects(f.create({ ...omitted, customFields: [entry(field, 'added')] }), { code: 'save_request_reused' });
  assert.equal((await f.load(omitted.id)).revision, 0); assert.equal((await f.load(empty.id)).revision, 1);
});

test('account creation captures typed values, original attachments and actual new-user observations in its own transaction', async () => {
  const f = await fixture(); const fields = []; for (const type of ['number', 'checkbox', 'date', 'multi_user_select', 'attachment']) fields.push(await f.field(type));
  const attachment = await work(f.manager, (client, identity) => uploadUserFieldAttachment(client, identity, { requestId: randomUUID(), fieldId: fields[4].id,
    fieldRevision: 1, originalName: 'creation.txt', mediaType: 'text/plain', content: Buffer.from('Creation attachment') }));
  const input = f.input({ customFieldTimeZone: 'Asia/Kolkata' }); input.customFields = fields.map((field, index) => entry(field, [0, false, '2026-01-31', [input.id, f.reader.userId], attachment.id][index]));
  const saved = await f.create(input); assert.equal(saved.customFieldRevision, 1); const capture = await f.load(input.id);
  assert.deepEqual(capture.customFields.map(field => field.value), input.customFields.map(field => field.value));
  assert.equal(capture.customFields[2].displayValue, '31/01/2026'); assert.equal(capture.customFields[3].items[0].userName, input.displayName);
  assert.equal(capture.customFields[3].items[0].userUsername, input.username); assert.equal(capture.customFields[4].items[0].attachment.originalName, 'creation.txt');
  assert.equal(capture.savedBy, f.manager.userId); assert.equal(capture.username, input.username);
  const event = (await owner.query(`SELECT creation.created_at=fields.saved_at AS same_time,
    creation.created_transaction_id=fields.created_transaction_id AS same_transaction FROM user_creation_commands creation JOIN user_field_value_versions fields
    ON fields.organization_id=creation.organization_id AND fields.subject_user_id=creation.user_id WHERE creation.user_id=$1`, [input.id])).rows[0];
  assert.deepEqual(event, { same_time: true, same_transaction: true });
  await signIn({ identifier: input.username, password: input.password });
});

test('late requiredness, definition and reference failures roll back every provisional account and capture row', async () => {
  const f = await fixture(); const required = await f.field('text', { isRequired: true });
  for (const [customFields, code] of [[[], 'user_custom_fields_changed'], [[entry(required, '')], 'invalid_custom_field_value'],
    [[entry({ ...required, revision: 2 }, 'value')], 'user_custom_fields_changed']]) {
    const input = f.input({ customFields }); await assert.rejects(f.create(input), { code }); await noAccount(input.id);
  }
  const users = await f.field('multi_user_select'); const input = f.input({ customFields: [entry(required, 'present'), entry(users, [randomUUID()])] });
  await assert.rejects(f.create(input), { code: 'invalid_user_custom_field_user' }); await noAccount(input.id);
  input.customFields[1].value = [f.reader.userId]; assert.equal((await f.create(input)).customFieldRevision, 1);
});

test('creation retries preserve later account/profile/field changes and reject changed capture presence, values, order or zone', async () => {
  const f = await fixture(); const field = await f.field('text', { allowsMultiple: true }); const input = f.input({ customFields: [entry(field, ['first', 'second'])] });
  const original = await f.create(input);
  await work(f.manager, (client, identity) => updateUserAccount(client, identity, input.id, { requestId: randomUUID(), revision: 1,
    username: input.username, email: input.email, displayName: 'Later name', password: '' }));
  await work(f.manager, (client, identity) => updateUserProfile(client, identity, input.id, { requestId: randomUUID(), revision: 1, phone: 'Later phone' }));
  await work(f.manager, (client, identity) => saveUserCustomFields(client, identity, input.id, { requestId: randomUUID(), revision: 1, customFields: [entry(field, ['later'])] }));
  await work(f.author, (client, identity) => retireCustomField(client, identity, { id: field.id, requestId: randomUUID(), revision: 1 }));
  const session = await signIn({ identifier: input.username, password: input.password }); assert.deepEqual(await f.create(input), original); await withSession(session.token, () => {});
  const omitted = { ...input }; delete omitted.customFields;
  for (const changed of [omitted, { ...input, customFields: [] }, { ...input, customFields: [entry(field, ['second', 'first'])] },
    { ...input, customFields: [entry(field, ['changed', 'second'])] }, { ...input, customFieldTimeZone: 'UTC' }]) await assert.rejects(f.create(changed), { code: 'save_request_reused' });
  assert.equal((await f.load(input.id)).revision, 2); assert.deepEqual((await f.load(input.id)).customFields[0].value, ['later']);
  assert.equal((await owner.query('SELECT revision,display_name FROM users WHERE id=$1', [input.id])).rows[0].display_name, 'Later name');
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM user_profile_versions WHERE user_id=$1', [input.id])).rows[0].count, 2);
});

test('concurrent creations capture once for exact requests and roll back the losing account in a unique-field race', async () => {
  const f = await fixture(); const field = await f.field('text', { validateUniqueness: true }); const first = f.input({ customFields: [entry(field, 'exact')] });
  const exact = await Promise.all([f.create(first), f.create(first)]); assert.deepEqual(exact[0], exact[1]);
  assert.equal((await owner.query('SELECT 1 FROM user_field_value_versions WHERE subject_user_id=$1', [first.id])).rowCount, 1);
  const other = await account({ organizationId: f.author.organizationId, permissions: ['users.manage'] });
  const inputs = [f.input({ customFields: [entry(field, 'same')] }), f.input({ customFields: [entry(field, 'same')] })];
  const race = await Promise.allSettled([f.create(inputs[0]), f.create(inputs[1], other)]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1); const loser = race.findIndex(result => result.status === 'rejected');
  assert.equal(race[loser].reason.code, 'duplicate_user_custom_field'); await noAccount(inputs[loser].id);
});

async function waitBlocked(pid) {
  for (let attempt = 0; attempt < 100; attempt++) { if ((await owner.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked) return; await delay(10); }
  throw new Error('Expected the creation command to wait on the held target.');
}

test('a creation retry locks its existing scoped target before the organization and revalidates access after waiting', async () => {
  for (const revoke of [false, true]) {
    const f = await fixture(); const field = await f.field(); const input = f.input({ customFields: [entry(field, 'saved')] }); const original = await f.create(input);
    const blocker = await owner.connect(); const probe = await owner.connect(); let pending; let outcome;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [input.id]);
      let announced; const ready = new Promise(resolve => { announced = resolve; });
      pending = work(f.manager, async (client, identity) => {
        announced((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return createUser(client, identity, input);
      }).then(value => ({ value }), error => ({ error }));
      await waitBlocked(await ready);
      await probe.query('BEGIN'); await probe.query('SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE NOWAIT', [f.author.organizationId]); await probe.query('ROLLBACK');
      if (revoke) await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.manager.userId]);
    } finally { await probe.query('ROLLBACK'); probe.release(); await blocker.query('ROLLBACK'); blocker.release(); if (pending) outcome = await pending; }
    if (revoke) { assert.equal(outcome.error?.status, 403); assert.equal(outcome.error.code, 'forbidden'); }
    else { assert.equal(outcome.error, undefined); assert.deepEqual(outcome.value, original); }
    assert.equal((await f.load(input.id)).revision, 1);
  }
});

test('creation fields retain tenant and actual user-management authorization boundaries', async () => {
  const f = await fixture(); const foreign = await fixture(); const field = await foreign.field(); const input = f.input({ customFields: [entry(field, 'foreign')] });
  await assert.rejects(f.create(input), { code: 'user_custom_fields_changed' }); await noAccount(input.id);
  await assert.rejects(f.create(input, f.reader), { code: 'forbidden' }); await assert.rejects(f.create(input, f.author), { code: 'forbidden' });
  await assert.rejects(work(f.author, (client, identity) => createUser(client, { ...identity, permission_codes: ['users.manage'] }, input)), { code: 'forbidden' });
  await noAccount(input.id);
});
