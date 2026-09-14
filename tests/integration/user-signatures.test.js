import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession, updateProfile } from '../../src/auth/service.js';
import { hashToken } from '../../src/auth/tokens.js';
import { closePool } from '../../src/db/pool.js';
import { uploadUserSignature, removeUserSignature, loadUserSignature, loadUserSignatureHistory, readUserSignatureFile, userSignatureFileHeaders } from '../../src/users/signatures.js';
import { userSignatureByteLimit, userSignatureUploadInput } from '../../src/users/signature-input.js';
import { updateUserStatus } from '../../src/users/status.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const account = async (options) => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const uploadInput = (revision = 0, extra = {}) => ({ requestId: randomUUID(), revision, originalName: '本人署名.txt', mediaType: 'text/plain', content: Buffer.from('Original attachment\0'), ...extra });
const removalInput = (revision) => ({ requestId: randomUUID(), revision });
const upload = (actor, target, input) => withSession(actor.token, (client, identity) => uploadUserSignature(client, identity, target, input));
const remove = (actor, target, input) => withSession(actor.token, (client, identity) => removeUserSignature(client, identity, target, input));
const read = (actor, target) => withSession(actor.token, (client, identity) => loadUserSignature(client, identity, target), { readOnly: true });
const history = (actor, target, input) => withSession(actor.token, (client, identity) => loadUserSignatureHistory(client, identity, target, input), { readOnly: true });
const file = (actor, id) => withSession(actor.token, (client, identity) => readUserSignatureFile(client, identity, id), { readOnly: true });
async function fixture() {
  const admin = await account({ permissions: ['users.manage', 'roles.manage'] }); const person = await account({ organizationId: admin.organizationId, permissions: ['users.read'] });
  return { admin, person };
}
async function rejected(client, action, expected) {
  await client.query('SAVEPOINT denied'); await assert.rejects(action, expected); await client.query('ROLLBACK TO SAVEPOINT denied'); await client.query('RELEASE SAVEPOINT denied');
}
const sameBytes = (actual, expected) => assert.equal(actual.equals(expected), true, 'Original bytes must match without normalization');

test('original arbitrary and empty files are preserved, including the complete 20 MiB upload/download boundary', async () => {
  const { admin, person } = await fixture(); assert.deepEqual(await read(admin, person.userId), { id: person.userId, revision: 0, file: null });
  assert.deepEqual(await history(admin, person.userId), { rows: [], nextBeforeRevision: null });
  let revision = 0;
  for (const [content, originalName, mediaType] of [[Buffer.alloc(0), 'empty.bin', 'application/octet-stream'],
    [Buffer.from('<html><script>void 0</script></html>'), 'signed.html', 'text/html'],
    [Buffer.from('%PDF-1.7\nsynthetic passive file'), 'passive.pdf', 'application/pdf'],
    [Buffer.alloc(userSignatureByteLimit, 65), 'maximum.bin', 'application/octet-stream']]) {
    const input = uploadInput(revision, { content, originalName, mediaType }); const saved = await upload(admin, person.userId, input); revision++;
    assert.deepEqual(saved, { id: person.userId, revision, fileId: input.requestId });
    const current = await read(admin, person.userId); assert.equal(current.revision, revision); assert.equal(current.file.byteLength, content.length); assert.equal(current.file.mediaType, mediaType);
    assert.equal(Object.hasOwn(current.file, 'content'), false);
    const stored = await file(person, input.requestId); sameBytes(stored.content, content); assert.equal(stored.sha256, createHash('sha256').update(content).digest('hex'));
    const headers = userSignatureFileHeaders(stored); assert.match(headers['Content-Disposition'], /^attachment;/); assert.equal(headers['Cache-Control'], 'private, no-store');
    assert.equal(headers['Content-Security-Policy'], "default-src 'none'; sandbox"); assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  }
  await assert.rejects(upload(admin, person.userId, uploadInput(revision, { content: Buffer.alloc(userSignatureByteLimit + 1) })), { status: 413 });
  assert.equal((await history(admin, person.userId)).rows.length, 4);
});

test('signature heads are membership-specific and independent of profile, status, global identity and credentials', async () => {
  const { admin, person } = await fixture(); const foreign = await fixture();
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.admin.organizationId, person.userId]);
  const credentialBefore = (await owner.query('SELECT password_hash,revision,updated_at FROM credentials WHERE user_id=$1', [person.userId])).rows[0];
  const identityBefore = (await owner.query('SELECT revision,active FROM users WHERE id=$1', [person.userId])).rows[0];
  const input = uploadInput(); await upload(admin, person.userId, input);
  assert.deepEqual(await read(foreign.admin, person.userId), { id: person.userId, revision: 0, file: null });
  await assert.rejects(file(foreign.admin, input.requestId), { status: 404 });
  const other = uploadInput(); await upload(foreign.admin, person.userId, other); assert.equal((await read(admin, person.userId)).file.id, input.requestId);
  assert.equal((await read(foreign.admin, person.userId)).file.id, other.requestId);
  await withSession(admin.token, (client, identity) => updateUserStatus(client, identity, person.userId, { requestId: randomUUID(), revision: 0, membershipActive: false }));
  await remove(admin, person.userId, removalInput(1));
  assert.deepEqual((await owner.query('SELECT active,status_revision,signature_revision FROM memberships WHERE organization_id=$1 AND user_id=$2', [admin.organizationId, person.userId])).rows[0],
    { active: false, status_revision: 1, signature_revision: 2 });
  assert.equal((await owner.query('SELECT 1 FROM user_profiles WHERE organization_id=$1 AND user_id=$2', [admin.organizationId, person.userId])).rowCount, 0);
  assert.equal(JSON.stringify((await owner.query('SELECT password_hash,revision,updated_at FROM credentials WHERE user_id=$1', [person.userId])).rows[0]) === JSON.stringify(credentialBefore), true, 'Credential unchanged');
  assert.deepEqual((await owner.query('SELECT revision,active FROM users WHERE id=$1', [person.userId])).rows[0], identityBefore);
  assert.equal((await read(foreign.admin, person.userId)).revision, 1);
});

test('exact upload/removal retries preserve later selections and old files, while changed requests and stale writes fail', async () => {
  const { admin, person } = await fixture(); const input = uploadInput(); const first = await upload(admin, person.userId, input);
  const removal = removalInput(1); await remove(admin, person.userId, removal); sameBytes((await file(admin, input.requestId)).content, input.content);
  const later = uploadInput(2, { originalName: 'Replacement.txt', content: Buffer.from('Replacement') }); await upload(admin, person.userId, later);
  assert.deepEqual(await upload(admin, person.userId, input), first); assert.equal((await remove(admin, person.userId, removal)).revision, 2);
  assert.equal((await read(admin, person.userId)).file.id, later.requestId);
  const otherAdmin = await account({ organizationId: admin.organizationId, permissions: ['users.manage'] });
  await assert.rejects(upload(otherAdmin, person.userId, input), { code: 'save_request_reused' });
  await assert.rejects(upload(admin, otherAdmin.userId, input), { code: 'save_request_reused' });
  for (const extra of [{ content: Buffer.from('Changed original bytes') }, { originalName: 'renamed.txt' }, { mediaType: 'application/octet-stream' }, { revision: 1 }]) {
    await assert.rejects(upload(admin, person.userId, { ...input, ...extra }), { code: 'save_request_reused' });
  }
  await assert.rejects(upload(admin, person.userId, uploadInput(0)), { code: 'stale_user_signature' });
  await assert.rejects(remove(admin, admin.userId, removalInput(0)), { code: 'user_signature_empty' });
  await remove(admin, person.userId, removalInput(3));
  await assert.rejects(remove(admin, person.userId, removalInput(4)), { code: 'user_signature_empty' });
  assert.equal((await history(admin, person.userId)).rows.length, 4); sameBytes((await file(admin, later.requestId)).content, later.content);
});

test('concurrent identical uploads create one version; competing uploads and removals cannot overwrite each other', async () => {
  const { admin, person } = await fixture(); const input = uploadInput();
  const values = await Promise.all([upload(admin, person.userId, input), upload(admin, person.userId, input)]); assert.deepEqual(values[0], values[1]);
  assert.equal((await history(admin, person.userId)).rows.length, 1);
  const outcomes = await Promise.allSettled([upload(admin, person.userId, uploadInput(1)), remove(admin, person.userId, removalInput(1))]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1); assert.equal(outcomes.find((result) => result.status === 'rejected').reason.code, 'stale_user_signature');
  assert.equal((await history(admin, person.userId)).rows.length, 2);
});

test('signature history freezes actual user/editor labels and uses stable bounded revision pagination', async () => {
  const { admin, person } = await fixture(); await upload(admin, person.userId, uploadInput());
  await withSession(person.token, (client) => updateProfile(client, { username: `later-${person.userId}`, displayName: 'Later person', revision: 1 }), { accountAction: true });
  await withSession(admin.token, (client) => updateProfile(client, { username: `later-${admin.userId}`, displayName: 'Later administrator', revision: 1 }), { accountAction: true });
  for (let revision = 1; revision < 5; revision++) await upload(admin, person.userId, uploadInput(revision));
  const first = await history(admin, person.userId, { limit: 2 }); assert.deepEqual(first.rows.map((row) => row.revision), [5, 4]); assert.equal(first.nextBeforeRevision, 4);
  await remove(admin, person.userId, removalInput(5));
  const second = await history(admin, person.userId, { limit: 2, beforeRevision: 4 }); assert.deepEqual(second.rows.map((row) => row.revision), [3, 2]);
  const last = await history(admin, person.userId, { limit: 2, beforeRevision: 2 }); assert.equal(last.nextBeforeRevision, null); assert.equal(last.rows[0].username, person.username);
  assert.equal(last.rows[0].savedByUsername, admin.username); assert.equal(last.rows[0].savedByName, 'Synthetic Analyst');
  assert.equal(first.rows[0].username, `later-${person.userId}`); assert.equal(first.rows[0].savedByName, 'Later administrator');
  for (const input of [{ limit: 0 }, { limit: 101 }, { limit: '25' }, { beforeRevision: 0 }, { beforeRevision: 1.5 }, { extra: 1 }]) await assert.rejects(history(admin, person.userId, input), { status: 400 });
  assert.equal(Object.hasOwn(last.rows[0].file, 'content'), false); assert.equal(Object.hasOwn(last.rows[0].file, 'encodedContent'), false);
});

test('SQL verifies actual content hashes on new uploads and retries, and immutable rows/complete heads cannot be forged', async () => {
  const { admin, person } = await fixture(); const input = uploadInput(); const normalized = userSignatureUploadInput(input);
  await upload(admin, person.userId, input);
  await withSession(admin.token, async (client, identity) => {
    const args = [person.userId, 0, input.requestId, 'upload', input.originalName, input.mediaType, Buffer.alloc(input.content.length, 9), input.content.length, normalized.sha256];
    await rejected(client, () => client.query('SELECT users_write_signature($1,$2,$3,$4,$5,$6,$7,$8,$9)', args), { constraint: 'user_signature_request_reused' });
    args[1] = 1; args[2] = randomUUID(); await rejected(client, () => client.query('SELECT users_write_signature($1,$2,$3,$4,$5,$6,$7,$8,$9)', args), { constraint: 'user_signature_payload' });
    assert.equal((await loadUserSignature(client, identity, person.userId)).revision, 1);
  });
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT * FROM auth_session_context($1)', [hashToken(admin.token)]);
    await rejected(client, () => client.query('UPDATE user_signature_versions SET content=decode(\'00\',\'hex\') WHERE user_id=$1', [person.userId]), { code: '55000' });
    await rejected(client, () => client.query('DELETE FROM user_signature_versions WHERE user_id=$1', [person.userId]), { code: '55000' });
    await rejected(client, async () => {
      await client.query('UPDATE memberships SET signature_revision=2 WHERE organization_id=$1 AND user_id=$2', [admin.organizationId, person.userId]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    }, { code: '23514' });
    await rejected(client, () => client.query('UPDATE memberships SET signature_revision=0 WHERE organization_id=$1 AND user_id=$2', [admin.organizationId, person.userId]), { code: '23514' });
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('read/write permissions, actual session context and worker boundaries protect signature content and membership scope', async () => {
  const { admin, person } = await fixture(); const foreign = await fixture(); const unrelated = await account({ organizationId: admin.organizationId, permissions: ['samples.read'] });
  const input = uploadInput(); await upload(admin, person.userId, input);
  await assert.rejects(upload(person, person.userId, uploadInput(1)), { status: 403 });
  await assert.rejects(read(unrelated, person.userId), { status: 403 }); await assert.rejects(file(unrelated, input.requestId), { status: 403 });
  for (const operation of [() => read(foreign.admin, person.userId), () => history(foreign.admin, person.userId), () => file(foreign.admin, input.requestId),
    () => upload(foreign.admin, person.userId, uploadInput()), () => remove(foreign.admin, person.userId, removalInput(1))]) await assert.rejects(operation, { status: 404 });
  await withSession(person.token, async (client, identity) => {
    await rejected(client, () => uploadUserSignature(client, { ...identity, permission_codes: ['users.manage'] }, person.userId, uploadInput(1)), { status: 403 });
    const grants = (await client.query("SELECT has_table_privilege(current_user,'user_signature_files','SELECT') AS read,has_table_privilege(current_user,'user_signature_files','INSERT,UPDATE,DELETE') AS write")).rows[0];
    assert.deepEqual(grants, { read: true, write: false });
    for (const query of ['SELECT * FROM user_signature_versions', 'DELETE FROM user_signature_history', 'UPDATE user_signature_heads SET revision=999', 'DELETE FROM user_signature_files']) {
      await rejected(client, () => client.query(query), { code: '42501' });
    }
    await client.query("SELECT set_config('app.user_id',$1,true)", [admin.userId]);
    await rejected(client, () => uploadUserSignature(client, { ...identity, permission_codes: ['users.manage'] }, person.userId, uploadInput(1)), { status: 403 });
    await rejected(client, () => readUserSignatureFile(client, identity, input.requestId), { status: 404 });
  });
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE sampleify_report_worker');
    for (const query of ['SELECT * FROM user_signature_history', 'SELECT * FROM user_signature_versions']) await rejected(client, () => client.query(query), { code: '42501' });
    await rejected(client, () => client.query('SELECT * FROM user_signature_files WHERE id=$1', [input.requestId]), { code: '42501' });
    await rejected(client, () => client.query("SELECT users_write_signature($1,1,$2,'remove',NULL,NULL,NULL,NULL,NULL)", [person.userId, randomUUID()]), { code: '42501' });
  } finally { await client.query('ROLLBACK'); client.release(); }
});

async function queuedUpload(f, mutate) {
  const blocker = await owner.connect(); let pending;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [f.admin.organizationId]);
    let reportPid; const started = new Promise((resolve) => { reportPid = resolve; });
    pending = withSession(f.admin.token, async (client, identity) => {
      reportPid((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return uploadUserSignature(client, identity, f.person.userId, uploadInput());
    }).then((value) => ({ value }), (error) => ({ error }));
    const pid = await started; let waiting = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      waiting = (await owner.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock';
      if (waiting) break; await delay(10);
    }
    assert.equal(waiting, true, 'Signature command must actually wait for the held organization');
    await mutate(blocker); await blocker.query('COMMIT'); return await pending;
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
}

test('revocation and permission loss during an actual organization wait prevent signature files and history', async () => {
  for (const invalidation of ['session', 'permission']) {
    const f = await fixture(); const result = await queuedUpload(f, (blocker) => invalidation === 'session'
      ? blocker.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(f.admin.token)])
      : blocker.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='users.manage'", [f.admin.organizationId, f.admin.roleId]));
    assert.equal(result.error.status, 403);
    assert.equal((await owner.query('SELECT signature_revision FROM memberships WHERE organization_id=$1 AND user_id=$2', [f.admin.organizationId, f.person.userId])).rows[0].signature_revision, 0);
    assert.equal((await owner.query('SELECT 1 FROM user_signature_versions WHERE user_id=$1', [f.person.userId])).rowCount, 0);
  }
});

test('expiry during a signature lock wait rejects without changing the membership or persisting a file', async () => {
  const f = await fixture(); await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=$1", [hashToken(f.admin.token)]);
  const result = await queuedUpload(f, () => delay(3_100)); assert.equal(result.error.status, 403);
  assert.equal((await owner.query('SELECT signature_revision FROM memberships WHERE organization_id=$1 AND user_id=$2', [f.admin.organizationId, f.person.userId])).rows[0].signature_revision, 0);
  assert.equal((await owner.query('SELECT 1 FROM user_signature_versions WHERE user_id=$1', [f.person.userId])).rowCount, 0);
});
