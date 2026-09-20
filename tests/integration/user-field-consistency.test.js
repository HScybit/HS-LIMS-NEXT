import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveUserCustomFields, loadUserCustomFields } from '../../src/users/custom-fields.js';
import { createUser } from '../../src/users/create.js';
import { uploadUserFieldAttachment, readUserFieldAttachment } from '../../src/users/custom-field-attachments.js';
import { uploadCustomFieldAttachment } from '../../src/custom-fields/attachments.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options) { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; }
const definition = (key, changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, key, label: key,
  associatedWith: 'users', fieldType: 'text', validateUniqueness: true, ...changes });
const entry = (field, value) => ({ fieldId: field.id, fieldRevision: field.revision, value });
const command = (customFields, revision = 0) => ({ requestId: randomUUID(), revision, customFields });
async function fixture() {
  const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Field consistency lab')", [author.organizationId, lab]);
  return { author, manager, reader, lab, define: input => work(author, (client, identity) => saveCustomField(client, identity, input)),
    person: () => createAccount(owner, { organizationId: author.organizationId, permissions: [] }),
    save: (userId, input) => work(manager, (client, identity) => saveUserCustomFields(client, identity, userId, input)),
    load: (userId, options) => work(reader, (client, identity) => loadUserCustomFields(client, identity, userId, options), true) };
}
const head = async (f, userId) => (await owner.query('SELECT custom_field_revision FROM memberships WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, userId])).rows[0]?.custom_field_revision;
async function noAccount(id) {
  for (const [table, column] of [['users', 'id'], ['credentials', 'user_id'], ['memberships', 'user_id'], ['membership_roles', 'user_id'], ['user_profiles', 'user_id'],
    ['user_profile_versions', 'user_id'], ['user_creation_commands', 'user_id'], ['user_field_value_versions', 'subject_user_id']]) assert.equal((await owner.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [id])).rowCount, 0, table);
}

test('a renamed unique field does not reinterpret existing user data under its new key', async () => {
  const f = await fixture(); const original = definition('original_key'); const first = await f.define(original); const a = await f.person(); const b = await f.person();
  const firstSave = command([entry(first, 'SAME')]); await f.save(a.userId, firstSave);
  const renamed = await f.define({ ...original, key: 'renamed_key', requestId: randomUUID(), revision: 1 });
  await f.save(b.userId, command([entry(renamed, 'SAME')]));
  assert.equal((await f.load(a.userId)).customFields[0].key, 'original_key'); assert.equal((await f.load(b.userId)).customFields[0].key, 'renamed_key');
  assert.equal((await f.save(a.userId, firstSave)).revision, 1);
  const c = await f.person(); await assert.rejects(f.save(c.userId, command([entry(renamed, 'SAME')])), { code: 'duplicate_user_custom_field' });
  assert.equal(await head(f, c.userId), 0);
});

test('reusing a saved key under another definition UUID checks current raw data including inactive memberships', async () => {
  const f = await fixture(); const original = definition('saved_key'); const first = await f.define(original); const a = await f.person(); const b = await f.person();
  await f.save(a.userId, command([entry(first, 'SAME')]));
  const renamed = await f.define({ ...original, key: 'renamed_key', requestId: randomUUID(), revision: 1 }); const replacement = await f.define(definition('saved_key'));
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, a.userId]);
  await assert.rejects(f.save(b.userId, command([entry(renamed, 'NEW'), entry(replacement, 'SAME')])), { code: 'duplicate_user_custom_field' });
  await f.save(b.userId, command([entry(renamed, 'NEW'), entry(replacement, 'same')]));
  assert.equal((await f.load(a.userId)).customFields[0].fieldId, first.id);
  assert.equal((await f.load(b.userId)).customFields[1].fieldId, replacement.id);
});

test('retired definitions retain their saved key while obsolete capture revisions do not reserve historical values', async () => {
  const f = await fixture(); const original = definition('retired_key'); const first = await f.define(original); const a = await f.person(); const b = await f.person();
  await f.save(a.userId, command([entry(first, 'historical')])); await f.save(a.userId, command([entry(first, 'current')], 1));
  await work(f.author, (client, identity) => retireCustomField(client, identity, { id: first.id, revision: 1, requestId: randomUUID() }));
  const replacement = await f.define(definition('retired_key'));
  await assert.rejects(f.save(b.userId, command([entry(replacement, 'current')])), { code: 'duplicate_user_custom_field' });
  await f.save(b.userId, command([entry(replacement, 'historical')]));
  const past = await f.load(a.userId, { atRevision: 1 }); assert.equal(past.customFields[0].key, 'retired_key'); assert.equal(past.customFields[0].value, 'historical');
  assert.equal(past.customFields[0].fieldId, first.id); assert.equal((await f.load(a.userId)).revision, 2);
});

test('current uniqueness settings inspect saved-key values even when they were captured with uniqueness disabled', async () => {
  const f = await fixture(); const original = definition('toggle_key', { validateUniqueness: false }); const first = await f.define(original); const a = await f.person(); const b = await f.person();
  await f.save(a.userId, command([entry(first, 'duplicate')])); await f.save(b.userId, command([entry(first, 'duplicate')]));
  const required = await f.define({ ...original, requestId: randomUUID(), revision: 1, validateUniqueness: true });
  await assert.rejects(f.save(a.userId, command([entry(required, 'duplicate')], 1)), { code: 'duplicate_user_custom_field' });
  await f.save(a.userId, command([entry(required, 'different')], 1));
  const disabled = await f.define({ ...original, requestId: randomUUID(), revision: 2, validateUniqueness: false });
  await f.save(a.userId, command([entry(disabled, 'duplicate')], 2)); assert.equal((await f.load(a.userId)).revision, 3);
});

test('a new organization captures 500 unique fields before ANALYZE and still rejects an inactive member duplicate', async () => {
  const f = await fixture(); const ids = Array.from({ length: 500 }, () => randomUUID());
  await work(f.author, (client, identity) => client.query(`INSERT INTO custom_field_definitions
    (organization_id,id,key,label,associated_with,field_type,validate_uniqueness,save_request_id,display_order)
    SELECT $1,id,'bulk_'||position,'Bulk field '||position,'users','text',true,gen_random_uuid(),position
    FROM unnest($2::uuid[]) WITH ORDINALITY AS fields(id,position)`, [identity.organization_id, ids]));
  const a = await f.person(); const b = await f.person();
  const fields = value => ids.map(fieldId => ({ fieldId, fieldRevision: 1, value }));
  await f.save(a.userId, command(fields('one'))); await f.save(b.userId, command(fields('two')));
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, a.userId]);
  await assert.rejects(f.save(b.userId, command(fields('one'), 1)), { code: 'duplicate_user_custom_field' });
  const current = await f.load(b.userId); assert.equal(current.revision, 1); assert.equal(current.customFields.length, 500);
  assert(current.customFields.every(field => field.value === 'two'));
});

function signal() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
async function waitForAdvisory(pid) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = (await owner.query('SELECT wait_event_type,wait_event,cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock' && row.wait_event === 'advisory' && row.blockers > 0) return;
    await delay(10);
  }
  throw new Error('Expected the operation to wait on the actual definition advisory lock.');
}
async function assertRowsUnlocked(f) {
  const probe = await owner.connect();
  try { await probe.query('BEGIN'); await probe.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE NOWAIT', [f.manager.userId]);
    await probe.query('SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE NOWAIT', [f.author.organizationId]);
  } finally { await probe.query('ROLLBACK'); probe.release(); }
}
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const awaitReady = (notice, pending) => Promise.race([notice.promise, pending.then(result => { throw result.error ?? new Error('Operation ended before reaching its synchronization point.'); })]);
function operation(f, kind, target, field) {
  const fields = command([entry(field, 'captured')]);
  const creation = { id: target, requestId: randomUUID(), revision: 0, username: `consistency-${target}`, email: `${target}@example.invalid`, displayName: 'Consistency user',
    password: 'Synthetic field consistency password', defaultRoleId: f.reader.roleId, laboratoryId: f.lab, ...(kind === 'creation' ? { customFields: fields.customFields } : {}) };
  return (client, identity) => kind === 'capture' ? saveUserCustomFields(client, identity, target, fields) : createUser(client, identity, creation);
}

test('definition insertion completes while capture and creation wait before taking account or organization locks', async () => {
  for (const kind of ['capture', 'creation', 'omitted creation']) {
    const f = await fixture(); const field = await f.define(definition('existing_key')); const target = kind === 'capture' ? (await f.person()).userId : randomUUID();
    const writerReady = signal(); const readerReady = signal(); const insert = signal(); const run = operation(f, kind, target, field); let writer; let reader; let written; let read;
    try {
      writer = settle(work(f.author, async (client, identity) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-field-definitions:'||$1::text,0))", [identity.organization_id]); writerReady.resolve(); await insert.promise;
        return saveCustomField(client, identity, definition('added_key'));
      }));
      await awaitReady(writerReady, writer);
      reader = settle(work(f.manager, async (client, identity) => { readerReady.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return run(client, identity); }));
      await waitForAdvisory(await awaitReady(readerReady, reader)); await assertRowsUnlocked(f); insert.resolve();
    } finally { insert.resolve(); if (writer) written = await writer; if (reader) read = await reader; }
    assert.equal(written.error, undefined); assert(written.value.id);
    if (kind === 'omitted creation') { assert.equal(read.error, undefined); assert.equal(await head(f, target), 0); }
    else { assert.equal(read.error?.code, 'user_custom_fields_changed'); if (kind === 'creation') await noAccount(target); else assert.equal(await head(f, target), 0); }
  }
});

test('management permission and session loss during the early definition wait prevent all capture or creation writes', async () => {
  for (const kind of ['capture', 'creation']) for (const loss of ['permission', 'session']) {
    const f = await fixture(); const field = await f.define(definition('existing_key')); const target = kind === 'capture' ? (await f.person()).userId : randomUUID();
    const held = signal(); const release = signal(); const ready = signal(); let holder; let pending; let result; let heldResult;
    try {
      holder = settle(work(f.author, async (client, identity) => { await client.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-field-definitions:'||$1::text,0))", [identity.organization_id]); held.resolve(); await release.promise; }));
      await awaitReady(held, holder); const run = operation(f, kind, target, field);
      pending = settle(work(f.manager, async (client, identity) => { ready.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return run(client, identity); }));
      await waitForAdvisory(await awaitReady(ready, pending)); await assertRowsUnlocked(f);
      if (loss === 'permission') await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.author.organizationId, f.manager.roleId]);
      else await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.manager.userId]);
    } finally { release.resolve(); if (holder) heldResult = await holder; if (pending) result = await pending; }
    assert.equal(heldResult.error, undefined); assert.equal(result.error?.code, 'forbidden'); if (kind === 'creation') await noAccount(target); else assert.equal(await head(f, target), 0);
  }
});

test('captures that obtain the shared definition lock first commit a frozen version and retain exact retries after the waiting writer', async () => {
  for (const kind of ['capture', 'creation']) {
    const f = await fixture(); const field = await f.define(definition('existing_key')); const target = kind === 'capture' ? (await f.person()).userId : randomUUID();
    const captured = signal(); const commit = signal(); const writerReady = signal(); const run = operation(f, kind, target, field); let reader; let writer; let saved; let written;
    try {
      reader = settle(work(f.manager, async (client, identity) => { const result = await run(client, identity); captured.resolve(); await commit.promise; return result; }));
      await awaitReady(captured, reader);
      writer = settle(work(f.author, async (client, identity) => { writerReady.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return saveCustomField(client, identity, definition('later_key')); }));
      await waitForAdvisory(await awaitReady(writerReady, writer)); commit.resolve();
    } finally { commit.resolve(); if (reader) saved = await reader; if (writer) written = await writer; }
    assert.equal(saved.error, undefined); assert.equal(written.error, undefined); assert.deepEqual(await work(f.manager, run), saved.value);
    const capture = await f.load(target); assert.equal(capture.revision, 1); assert.equal(capture.customFields.length, 1); assert.equal(capture.customFields[0].key, 'existing_key');
  }
});

const uploadInput = field => ({ requestId: randomUUID(), fieldId: field.id, fieldRevision: field.revision,
  originalName: 'consistency.txt', mediaType: 'text/plain', content: Buffer.from('Synthetic upload consistency') });
const uploadLock = (client, organizationId, requestId) => client.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-field-upload:'||$1::text||':'||$2::text,0))", [organizationId, requestId]);
const definitionLock = (client, organizationId, shared = false) => client.query(`SELECT pg_advisory_xact_lock${shared ? '_shared' : ''}(hashtextextended('custom-field-definitions:'||$1::text,0))`, [organizationId]);
const fileCount = async id => (await owner.query('SELECT 1 FROM custom_field_attachments WHERE id=$1', [id])).rowCount;

test('definition edits finish while a user upload waits before locking its account and organization', async () => {
  const f = await fixture(); const original = definition('file_key', { fieldType: 'attachment' }); const field = await f.define(original); const input = uploadInput(field);
  const held = signal(); const update = signal(); const ready = signal(); let writer; let upload; let written; let uploaded;
  try {
    writer = settle(work(f.author, async (client, identity) => {
      await definitionLock(client, identity.organization_id);
      await client.query('SELECT 1 FROM custom_field_definitions WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, field.id]);
      held.resolve(); await update.promise; return saveCustomField(client, identity, { ...original, revision: 1, requestId: randomUUID(), label: 'Edited file' });
    }));
    await awaitReady(held, writer);
    upload = settle(work(f.manager, async (client, identity) => { ready.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return uploadUserFieldAttachment(client, identity, input); }));
    await waitForAdvisory(await awaitReady(ready, upload)); await assertRowsUnlocked(f); update.resolve();
  } finally { update.resolve(); if (writer) written = await writer; if (upload) uploaded = await upload; }
  assert.equal(written.error, undefined); assert.equal(written.value.revision, 2); assert.equal(uploaded.error?.code, 'stale_custom_field'); assert.equal(await fileCount(input.requestId), 0);
});

test('master and user uploads sharing a request ID serialize before organization locks in either order', async () => {
  for (const first of ['master', 'user']) {
    const f = await fixture(); const userField = await f.define(definition('user_file', { fieldType: 'attachment' }));
    const masterField = await f.define(definition('master_file', { fieldType: 'attachment', associatedWith: 'product' }));
    const userInput = uploadInput(userField); const masterInput = { ...uploadInput(masterField), requestId: userInput.requestId };
    const actors = first === 'master' ? [f.author, f.manager] : [f.manager, f.author];
    const commands = first === 'master'
      ? [(client, identity) => uploadCustomFieldAttachment(client, identity, masterInput), (client, identity) => uploadUserFieldAttachment(client, identity, userInput)]
      : [(client, identity) => uploadUserFieldAttachment(client, identity, userInput), (client, identity) => uploadCustomFieldAttachment(client, identity, masterInput)];
    const held = signal(); const proceed = signal(); const ready = signal(); let leader; let follower; let saved; let rejected;
    try {
      leader = settle(work(actors[0], async (client, identity) => { await uploadLock(client, identity.organization_id, userInput.requestId); held.resolve(); await proceed.promise; return commands[0](client, identity); }));
      await awaitReady(held, leader);
      follower = settle(work(actors[1], async (client, identity) => { ready.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return commands[1](client, identity); }));
      await waitForAdvisory(await awaitReady(ready, follower)); await assertRowsUnlocked(f); proceed.resolve();
    } finally { proceed.resolve(); if (leader) saved = await leader; if (follower) rejected = await follower; }
    assert.equal(saved.error, undefined); assert.equal(rejected.error?.code, 'attachment_request_reused'); assert.equal(await fileCount(userInput.requestId), 1);
    assert.equal(saved.value.fieldId, first === 'master' ? masterField.id : userField.id);
  }
});

test('a user upload holding the shared definition lock completes while a direct definition update holds its row', async () => {
  const f = await fixture(); const field = await f.define(definition('raw_file', { fieldType: 'attachment' })); const input = uploadInput(field);
  const held = signal(); const proceed = signal(); const ready = signal(); let upload; let writer; let uploaded; let written;
  try {
    upload = settle(work(f.manager, async (client, identity) => { await uploadLock(client, identity.organization_id, input.requestId); await definitionLock(client, identity.organization_id, true);
      held.resolve(); await proceed.promise; return uploadUserFieldAttachment(client, identity, input); }));
    await awaitReady(held, upload);
    writer = settle(work(f.author, async (client, identity) => {
      ready.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return client.query(`UPDATE custom_field_definitions SET label='Directly edited file',revision=revision+1,save_request_id=$3,updated_at=transaction_timestamp()
        WHERE organization_id=$1 AND id=$2 RETURNING revision`, [identity.organization_id, field.id, randomUUID()]);
    }));
    await waitForAdvisory(await awaitReady(ready, writer)); proceed.resolve();
  } finally { proceed.resolve(); if (upload) uploaded = await upload; if (writer) written = await writer; }
  assert.equal(uploaded.error, undefined); assert.equal(written.error, undefined); assert.equal(written.value.rows[0].revision, 2);
  assert.equal(uploaded.value.fieldRevision, 1);
  const file = await work(f.reader, (client, identity) => readUserFieldAttachment(client, identity, input.requestId), true); assert.deepEqual(file.content, input.content);
  assert.equal((await work(f.manager, (client, identity) => uploadUserFieldAttachment(client, identity, input))).replayed, true);
});

test('permission and session loss during either early upload advisory wait deny the upload without partial bytes', async () => {
  for (const lock of ['request', 'definition']) for (const loss of ['permission', 'session']) {
    const f = await fixture(); const field = await f.define(definition('blocked_file', { fieldType: 'attachment' })); const input = uploadInput(field);
    const held = signal(); const release = signal(); const ready = signal(); let holder; let upload; let heldResult; let uploaded;
    try {
      holder = settle(work(f.author, async (client, identity) => { await (lock === 'request' ? uploadLock(client, identity.organization_id, input.requestId) : definitionLock(client, identity.organization_id)); held.resolve(); await release.promise; }));
      await awaitReady(held, holder);
      upload = settle(work(f.manager, async (client, identity) => { ready.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return uploadUserFieldAttachment(client, identity, input); }));
      await waitForAdvisory(await awaitReady(ready, upload)); await assertRowsUnlocked(f);
      if (loss === 'permission') await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.author.organizationId, f.manager.roleId]);
      else await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.manager.userId]);
    } finally { release.resolve(); if (holder) heldResult = await holder; if (upload) uploaded = await upload; }
    assert.equal(heldResult.error, undefined); assert.equal(uploaded.error?.code, 'forbidden'); assert.equal(await fileCount(input.requestId), 0);
  }
});
