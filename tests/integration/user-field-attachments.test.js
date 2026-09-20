import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { uploadUserFieldAttachment, readUserFieldAttachment } from '../../src/users/custom-field-attachments.js';
import { customFieldAttachmentByteLimit, uploadCustomFieldAttachment, readCustomFieldAttachment } from '../../src/custom-fields/attachments.js';

const owner = ownerPool(); let author; let manager; let reader; let colleague; let outsider;
const work = (actor, callback, readOnly = false) => withSession(actor.token, callback, { readOnly });
async function account(options) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
const fieldInput = changes => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, key: `file_${randomUUID().replaceAll('-', '')}`,
  label: 'Synthetic user attachment', associatedWith: 'users', fieldType: 'attachment', ...changes });
const save = input => work(author, (client, identity) => saveCustomField(client, identity, input));
const field = async changes => save(fieldInput(changes));
const input = (definition, changes) => ({ requestId: randomUUID(), fieldId: definition.id, fieldRevision: definition.revision,
  originalName: 'Synthetic विश्लेषण.dat', mediaType: 'application/x-synthetic', content: Buffer.from([0, 255, 1, 10]), ...changes });
const upload = (value, actor = manager) => work(actor, (client, identity) => uploadUserFieldAttachment(client, identity, value));
const read = (id, actor = reader) => work(actor, (client, identity) => readUserFieldAttachment(client, identity, id), true);
const checksum = value => createHash('sha256').update(value).digest('hex');
const count = async id => Number((await owner.query('SELECT count(*) AS count FROM custom_field_attachments WHERE organization_id=$1 AND id=$2', [author.organizationId, id])).rows[0].count);
before(async () => {
  author = await account({ permissions: ['masters.manage'] });
  manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
  colleague = await account({ organizationId: author.organizationId, permissions: ['users.manage', 'masters.manage'] });
  outsider = await account({ permissions: ['users.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

test('user field uploads retain zero, arbitrary and maximum bytes with actual metadata and bounded query counts', async () => {
  const definition = await field();
  for (const content of [Buffer.alloc(0), Buffer.from([0, 255, 1, 10]), Buffer.alloc(customFieldAttachmentByteLimit, 23)]) {
    const command = input(definition, { content }); let queries = 0;
    const saved = await work(manager, (client, identity) => uploadUserFieldAttachment({ query(...args) { queries++; return client.query(...args); } }, identity, command));
    assert.equal(queries, 2); assert.equal(saved.replayed, false); assert.equal(saved.id, command.requestId);
    assert.equal(saved.fieldId, definition.id); assert.equal(saved.fieldRevision, 1); assert.equal(saved.uploadedBy, manager.userId);
    assert.equal(saved.byteLength, content.length); assert.equal(saved.sha256, checksum(content)); assert.equal(saved.originalName, command.originalName);
    assert.equal(Object.hasOwn(saved, 'content'), false); assert.match(saved.url, /^\/api\/users\/custom-fields\/attachments\//);
    queries = 0;
    const file = await work(reader, (client, identity) => readUserFieldAttachment({ query(...args) { queries++; return client.query(...args); } }, identity, saved.id), true);
    assert.equal(queries, 1); assert.deepEqual(file.content, content);
    const stored = (await owner.query('SELECT uploaded_by,uploaded_at,sha256,byte_length FROM custom_field_attachments WHERE organization_id=$1 AND id=$2', [author.organizationId, saved.id])).rows[0];
    assert.equal(stored.uploaded_by, manager.userId); assert.equal(stored.uploaded_at.toISOString(), saved.uploadedAt.toISOString()); assert.equal(stored.sha256, saved.sha256);
  }
});

test('exact user uploads replay before stale, reassociated and retired definitions while conflicting details fail', async () => {
  const original = fieldInput(); const definition = await save(original); const command = input(definition); const saved = await upload(command);
  for (const changes of [{ content: Buffer.from([0, 255, 2, 10]) }, { originalName: 'other.dat' }, { mediaType: 'text/plain' },
    { fieldRevision: 2 }, { fieldId: (await field()).id }]) {
    await assert.rejects(upload({ ...command, ...changes }), { code: 'attachment_request_reused' });
  }
  await assert.rejects(upload(command, colleague), { code: 'attachment_request_reused' });
  await save({ ...original, requestId: randomUUID(), revision: 1, label: 'Changed' });
  await assert.rejects(upload({ ...command, requestId: randomUUID() }), { code: 'stale_custom_field' });
  await save({ ...original, requestId: randomUUID(), revision: 2, associatedWith: 'product' });
  await work(author, (client, identity) => retireCustomField(client, identity, { id: definition.id, revision: 3, requestId: randomUUID() }));
  assert.deepEqual(await upload(command), { ...saved, replayed: true }); assert.deepEqual((await read(saved.id)).content, command.content);
  await assert.rejects(upload({ ...command, requestId: randomUUID(), fieldRevision: 4 }), { code: 'attachment_field_not_found' });
  await assert.rejects(work(author, (client, identity) => readCustomFieldAttachment(client, identity, saved.id), true), { code: 'attachment_not_found' });
  assert.equal(await count(saved.id), 1);
});

test('concurrent upload retries store once, and cross-association request collisions return conflicts without disclosure', async () => {
  const definition = await field(); const command = input(definition);
  const same = await Promise.all([upload(command), upload(command)]); assert.deepEqual(same.map(value => value.replayed).sort(), [false, true]); assert.equal(await count(command.requestId), 1);
  const master = await field({ associatedWith: 'product' });
  await assert.rejects(work(author, (client, identity) => uploadCustomFieldAttachment(client, identity, input(master, { requestId: command.requestId }))), { code: 'attachment_request_reused' });
  const masterCommand = input(master); await work(author, (client, identity) => uploadCustomFieldAttachment(client, identity, masterCommand));
  await assert.rejects(upload(input(definition, { requestId: masterCommand.requestId })), { code: 'attachment_request_reused' });
  await assert.rejects(read(masterCommand.requestId), { code: 'attachment_not_found' });
  const disputed = input(definition);
  const results = await Promise.allSettled([upload(disputed), upload({ ...disputed, content: Buffer.from('different') })]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'attachment_request_reused'); assert.equal(await count(disputed.requestId), 1);
});

test('user attachment boundaries enforce actual scope, roles and definitions despite forged identities or settings', async () => {
  const definition = await field(); const command = input(definition); await upload(command);
  for (const actor of [author, reader]) await assert.rejects(upload(input(definition), actor), { code: 'forbidden' });
  await assert.rejects(read(command.requestId, author), { code: 'forbidden' }); await assert.rejects(read(command.requestId, outsider), { code: 'attachment_not_found' });
  await assert.rejects(upload(input(definition), outsider), { code: 'attachment_field_not_found' });
  for (const invalid of [await field({ fieldType: 'text' }), await field({ associatedWith: 'product' }), { id: randomUUID(), revision: 1 }]) {
    await assert.rejects(upload(input(invalid)), { code: 'attachment_field_not_found' });
  }
  await assert.rejects(work(author, (client, identity) => uploadUserFieldAttachment(client, { ...identity, permission_codes: ['users.manage'] }, input(definition))), { code: 'forbidden' });
  await work(reader, async (client, identity) => {
    await assert.rejects(readUserFieldAttachment(client, { ...identity, organization_id: outsider.organizationId }, command.requestId), { code: 'attachment_not_found' });
    assert.equal((await client.query('SELECT 1 FROM custom_field_attachments')).rowCount, 0);
    await client.query("SELECT set_config('app.organization_id',$1,true)", [outsider.organizationId]);
    assert.equal((await client.query('SELECT 1 FROM user_custom_field_attachments')).rowCount, 0);
  }, true);
  assert.equal((await getPool().query('SELECT 1 FROM user_custom_field_attachments')).rowCount, 0);
  await work(author, async client => { assert.equal((await client.query('SELECT 1 FROM user_custom_field_attachments')).rowCount, 0); }, true);
});

test('user files are immutable, direct SQL cannot bypass the command, and worker grants stay denied', async () => {
  const definition = await field(); const command = input(definition); await upload(command);
  for (const actor of [manager, colleague]) await assert.rejects(work(actor, (client, identity) => client.query(`INSERT INTO custom_field_attachments
    (organization_id,id,field_id,field_revision,original_name,media_type,content,byte_length,sha256,uploaded_by)
    VALUES($1,$2,$3,1,'file','text/plain',$4,$5,$6,$7)`, [identity.organization_id, randomUUID(), definition.id, command.content, command.content.length, checksum(command.content), identity.user_id])), { code: '42501' });
  for (const operation of ['UPDATE custom_field_attachments SET original_name=original_name', 'DELETE FROM custom_field_attachments']) {
    await assert.rejects(owner.query(`${operation} WHERE organization_id=$1 AND id=$2`, [author.organizationId, command.requestId]), { code: '55000' });
  }
  for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', ['sampleify_app', 'user_custom_field_attachments', privilege])).rows[0].allowed, false);
  assert.equal((await owner.query("SELECT has_table_privilege('sampleify_report_worker','user_custom_field_attachments','SELECT') AS allowed")).rows[0].allowed, false);
  assert.equal((await owner.query("SELECT has_function_privilege('sampleify_report_worker','users_upload_field_attachment(uuid,uuid,integer,text,text,bytea)','EXECUTE') AS allowed")).rows[0].allowed, false);
  for (const changes of [[null, 1, command.content], [definition.id, 0, command.content], [definition.id, 1, null], [definition.id, 1, Buffer.alloc(customFieldAttachmentByteLimit + 1)]]) {
    await assert.rejects(work(manager, client => client.query('SELECT users_upload_field_attachment($1,$2,$3,$4,$5,$6)', [randomUUID(), changes[0], changes[1], 'file', 'text/plain', changes[2]])), { constraint: 'user_field_attachment_invalid_input' });
  }
});

async function waitBlocked(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await owner.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked) return;
    await delay(10);
  }
  assert.fail('Upload did not reach the expected database lock');
}

test('uploads revalidate real permission, membership and session loss after waiting for actor locks', async () => {
  const definition = await field();
  for (const change of ['permission', 'membership', 'revocation', 'expiry']) {
    const actor = await account({ organizationId: author.organizationId, permissions: ['users.manage'] }); const command = input(definition);
    const blocker = await owner.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [actor.userId]);
    let reached; const ready = new Promise(resolve => { reached = resolve; });
    const pending = work(actor, async (client, identity) => {
      reached((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return uploadUserFieldAttachment(client, identity, command);
    }).then(value => ({ value }), error => ({ error }));
    let setupError;
    try {
      await waitBlocked(await ready);
      if (change === 'permission') await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [actor.organizationId, actor.roleId]);
      if (change === 'membership') await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [actor.organizationId, actor.userId]);
      if (change === 'revocation') await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId]);
      if (change === 'expiry') {
        await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE user_id=$1", [actor.userId]);
        await delay(550);
      }
    } catch (error) { setupError = error;
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    const result = await pending; if (setupError) throw setupError;
    assert.equal(result.error?.code, 'forbidden', change); assert.equal(await count(command.requestId), 0);
  }
});

test('an upload waiting for a definition edit observes the new revision and saves no stale file', async () => {
  const original = fieldInput(); const definition = await save(original); const command = input(definition);
  let release; const held = new Promise(resolve => { release = resolve; }); let edited; const ready = new Promise(resolve => { edited = resolve; });
  const edit = work(author, async (client, identity) => {
    await saveCustomField(client, identity, { ...original, requestId: randomUUID(), revision: 1, label: 'Concurrent edit' }); edited(); await held;
  }).catch(error => { edited(error); return error; });
  let pending;
  try {
    const editError = await ready; if (editError) throw editError;
    let reached; const uploadReady = new Promise(resolve => { reached = resolve; });
    pending = work(manager, async (client, identity) => {
      reached((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return uploadUserFieldAttachment(client, identity, command);
    }).then(value => ({ value }), error => ({ error }));
    await waitBlocked(await uploadReady);
  } finally { release(); const editError = await edit; if (editError) throw editError; }
  const result = await pending; assert.equal(result.error?.code, 'stale_custom_field'); assert.equal(await count(command.requestId), 0);
});
