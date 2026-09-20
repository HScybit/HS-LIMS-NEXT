import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { customFieldAttachmentByteLimit, uploadCustomFieldAttachment, readCustomFieldAttachment } from '../../src/custom-fields/attachments.js';

const owner = ownerPool(); let manager; let viewer; let colleague; let outsider; let noAccess;
const work = (callback, user = manager, readOnly = false) => withSession(user.token, callback, { csrfToken: user.csrfToken, readOnly });
const definitionInput = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, key: `file_${randomUUID().replaceAll('-', '')}`,
  label: 'Synthetic attachment', associatedWith: 'product', fieldType: 'attachment', ...changes });
const field = (changes = {}, user = manager) => work((client, identity) => saveCustomField(client, identity, definitionInput(changes)), user);
const input = (definition, changes = {}) => ({ requestId: randomUUID(), fieldId: definition.id, fieldRevision: definition.revision,
  originalName: 'Synthetic विश्लेषण.txt', mediaType: 'text/plain', content: Buffer.from([0, 1, 255, 10]), ...changes });
const hash = (content) => createHash('sha256').update(content).digest('hex');
async function rawInsert(client, identity, definition, changes = {}) {
  const bytes = changes.content ?? Buffer.from('Synthetic');
  return client.query(`INSERT INTO custom_field_attachments(organization_id,id,field_id,field_revision,original_name,media_type,
    content,byte_length,sha256,uploaded_by,uploaded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz,transaction_timestamp()))`,
  [changes.organizationId ?? identity.organization_id, randomUUID(), definition.id, changes.fieldRevision ?? definition.revision,
    changes.originalName ?? 'Synthetic file', changes.mediaType ?? 'text/plain', bytes, changes.byteLength ?? bytes.length,
    changes.sha256 ?? hash(bytes), changes.uploadedBy ?? identity.user_id, changes.uploadedAt ?? null]);
}
before(async () => {
  manager = await createAccount(owner, { permissions: ['masters.manage'] });
  viewer = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['masters.read'] });
  colleague = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['masters.manage'] });
  noAccess = await createAccount(owner, { organizationId: manager.organizationId, permissions: [] });
  outsider = await createAccount(owner, { permissions: ['masters.manage', 'masters.read'] });
  for (const user of [manager, viewer, colleague, noAccess, outsider]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

test('attachment uploads preserve binary, empty and maximum-size files with actual tenant, actor, time and checksums', async () => {
  const definition = await field();
  for (const content of [Buffer.alloc(0), Buffer.from([0, 255, 1, 10]), Buffer.alloc(customFieldAttachmentByteLimit, 17)]) {
    const command = input(definition, { content });
    const saved = await work((client, identity) => uploadCustomFieldAttachment(client, identity, command));
    assert.equal(saved.id, command.requestId); assert.equal(saved.replayed, false); assert.equal(saved.uploadedBy, manager.userId);
    assert.equal(saved.fieldId, definition.id); assert.equal(saved.fieldRevision, 1); assert.equal(saved.byteLength, content.length);
    assert.equal(saved.sha256, hash(content)); assert.equal(saved.originalName, command.originalName);
    assert.equal(Object.hasOwn(saved, 'content'), false); assert.ok(saved.uploadedAt instanceof Date);
    const loaded = await work((client, identity) => readCustomFieldAttachment(client, identity, saved.id), viewer, true);
    assert.deepEqual(loaded.content, content); assert.equal(loaded.sha256, saved.sha256);
    assert.equal(Object.hasOwn(loaded, 'encodedContent'), false);
    const sql = (await owner.query('SELECT organization_id,uploaded_by,uploaded_at,sha256 FROM custom_field_attachments WHERE organization_id=$1 AND id=$2', [manager.organizationId, saved.id])).rows[0];
    assert.equal(sql.organization_id, manager.organizationId); assert.equal(sql.uploaded_by, manager.userId);
    assert.deepEqual(sql.uploaded_at, saved.uploadedAt); assert.equal(sql.sha256, saved.sha256);
  }
});

test('concurrent exact attachment retries commit one identity and reject changed field, revision, actor, filename, media type or bytes', async () => {
  const definition = await field(); const other = await field(); const command = input(definition);
  const results = await Promise.all([0, 1].map(() => work((client, identity) => uploadCustomFieldAttachment(client, identity, command))));
  assert.deepEqual(results.map((row) => row.replayed).sort(), [false, true]);
  assert.deepEqual({ ...results[0], replayed: true }, { ...results[1], replayed: true });
  for (const changes of [{ fieldId: other.id }, { fieldRevision: 2 }, { originalName: 'Another.txt' }, { mediaType: 'application/octet-stream' }, { content: Buffer.from('different') }]) {
    await assert.rejects(work((client, identity) => uploadCustomFieldAttachment(client, identity, { ...command, ...changes })), { code: 'attachment_request_reused' });
  }
  await assert.rejects(work((client, identity) => uploadCustomFieldAttachment(client, identity, command), colleague), { code: 'attachment_request_reused' });
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM custom_field_attachments WHERE organization_id=$1 AND id=$2', [manager.organizationId, command.requestId])).rows[0].count, 1);
});

test('definition changes and retirement prevent new uploads while existing attachment history and exact retries remain reproducible', async () => {
  const initial = definitionInput(); const definition = await work((client, identity) => saveCustomField(client, identity, initial));
  const command = input(definition); const saved = await work((client, identity) => uploadCustomFieldAttachment(client, identity, command));
  await work((client, identity) => saveCustomField(client, identity, { ...initial, revision: 1, requestId: randomUUID(), label: 'Changed label' }));
  await assert.rejects(work((client, identity) => uploadCustomFieldAttachment(client, identity, { ...command, requestId: randomUUID() })), { code: 'stale_custom_field' });
  await work((client, identity) => saveCustomField(client, identity, { ...initial, revision: 2, requestId: randomUUID(), fieldType: 'text', associatedWith: 'customer' }));
  await assert.rejects(work((client, identity) => uploadCustomFieldAttachment(client, identity, { ...command, requestId: randomUUID(), fieldRevision: 3 })), { code: 'customer_module_access_required' });
  await work((client, identity) => retireCustomField(client, identity, { id: definition.id, revision: 3, requestId: randomUUID() }));
  assert.deepEqual((await work((client, identity) => readCustomFieldAttachment(client, identity, saved.id), viewer, true)).content, command.content);
  assert.deepEqual(await work((client, identity) => uploadCustomFieldAttachment(client, identity, command)), { ...saved, replayed: true });
});

test('attachment service and RLS enforce tenant, role and Product field boundaries', async () => {
  const definition = await field(); const foreign = await field({}, outsider); const wrongType = await field({ fieldType: 'text' });
  const customerField = await field({ associatedWith: 'customer' }); const command = input(definition);
  const saved = await work((client, identity) => uploadCustomFieldAttachment(client, identity, command));
  for (const invalid of [foreign, wrongType, { id: randomUUID(), revision: 1 }]) {
    await assert.rejects(work((client, identity) => uploadCustomFieldAttachment(client, identity, input(invalid))), { code: 'attachment_field_not_found' });
  }
  await assert.rejects(work((client, identity) => uploadCustomFieldAttachment(client, identity, input(customerField))), { code: 'customer_module_access_required' });
  for (const user of [viewer, noAccess]) await assert.rejects(work((client, identity) => uploadCustomFieldAttachment(client, identity, input(definition)), user), { code: 'forbidden' });
  await assert.rejects(work((client, identity) => readCustomFieldAttachment(client, identity, saved.id), noAccess, true), { code: 'forbidden' });
  await assert.rejects(work((client, identity) => readCustomFieldAttachment(client, identity, saved.id), outsider, true), { code: 'attachment_not_found' });
  assert.equal((await work((client) => client.query('SELECT 1 FROM custom_field_attachments'), noAccess, true)).rowCount, 0);
  assert.equal((await getPool().query('SELECT 1 FROM custom_field_attachments')).rowCount, 0);
  assert.equal((await owner.query("SELECT has_table_privilege('sampleify_report_worker','custom_field_attachments','SELECT') AS allowed")).rows[0].allowed, false);
});

test('restricted SQL cannot forge attachment ownership, timestamps, bytes, media, filenames or field versions', async () => {
  const definition = await field();
  for (const changes of [{ uploadedBy: colleague.userId }, { uploadedAt: '2020-01-01T00:00:00Z' }, { organizationId: outsider.organizationId }]) {
    await assert.rejects(work((client, identity) => rawInsert(client, identity, definition, changes)), { code: '42501' });
  }
  for (const changes of [{ sha256: 'a'.repeat(64) }, { byteLength: 0 }, { fieldRevision: 2 }, { originalName: '../bad' },
    { originalName: 'bad\nfile' }, { originalName: 'x'.repeat(501) }, { mediaType: 'text/html; bad' }, { content: Buffer.alloc(customFieldAttachmentByteLimit + 1) }]) {
    await assert.rejects(work((client, identity) => rawInsert(client, identity, definition, changes)), { code: '23514' });
  }
  const wrongType = await field({ fieldType: 'text' });
  await assert.rejects(work((client, identity) => rawInsert(client, identity, wrongType)), { code: '23514' });
  await assert.rejects(work((client, identity) => rawInsert(client, identity, definition), viewer), { code: '42501' });
});

test('attachment bytes and metadata cannot be changed or physically removed, including through the owner connection', async () => {
  const definition = await field(); const command = input(definition);
  const saved = await work((client, identity) => uploadCustomFieldAttachment(client, identity, command));
  for (const sql of ['UPDATE custom_field_attachments SET original_name=original_name WHERE organization_id=$1 AND id=$2',
    'DELETE FROM custom_field_attachments WHERE organization_id=$1 AND id=$2']) {
    await assert.rejects(work((client) => client.query(sql, [manager.organizationId, saved.id])), { code: '42501' });
    await assert.rejects(owner.query(sql, [manager.organizationId, saved.id]), { code: '55000' });
  }
  assert.deepEqual((await work((client, identity) => readCustomFieldAttachment(client, identity, saved.id), viewer, true)).content, command.content);
});

test('a new upload serializes behind a definition edit and rejects its obsolete revision after that edit commits', async () => {
  const initial = definitionInput(); const definition = await work((client, identity) => saveCustomField(client, identity, initial));
  let editingReady; const editing = new Promise((resolve) => { editingReady = resolve; });
  let finishEdit; const release = new Promise((resolve) => { finishEdit = resolve; });
  let uploadReady; const uploading = new Promise((resolve) => { uploadReady = resolve; });
  const edit = work(async (client, identity) => {
    await saveCustomField(client, identity, { ...initial, revision: 1, requestId: randomUUID(), label: 'Updated while upload waits' });
    editingReady(); await release;
  });
  await Promise.race([editing, edit.then(() => { throw new Error('Edit finished before the upload test began.'); })]);
  let uploadPid;
  const upload = work(async (client, identity) => {
    uploadPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    uploadReady(); return uploadCustomFieldAttachment(client, identity, input(definition));
  });
  const checked = assert.rejects(upload, { code: 'stale_custom_field' });
  try {
    await Promise.race([uploading, upload]);
    let waiting = false;
    for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
      const activity = (await owner.query('SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=$1', [uploadPid])).rows[0];
      waiting = activity?.wait_event_type === 'Lock' && activity.query.includes('custom_field_definitions');
      if (!waiting) await delay(10);
    }
    assert.equal(waiting, true, 'Upload must wait for the definition edit lock.');
  } finally { finishEdit(); await edit; await checked; }
  assert.equal((await owner.query('SELECT 1 FROM custom_field_attachments WHERE organization_id=$1 AND field_id=$2', [manager.organizationId, definition.id])).rowCount, 0);
});
