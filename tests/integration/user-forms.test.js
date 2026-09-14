import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession, updateProfile } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { updateUserForm, loadUserForm } from '../../src/users/forms.js';
import { updateUserProfile } from '../../src/users/profiles.js';
import { updateUserAccount } from '../../src/users/accounts.js';
import { uploadUserSignature } from '../../src/users/signatures.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const account = async options => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const save = (actor, target, input) => withSession(actor.token, (client, identity) => updateUserForm(client, identity, target, input));
const read = (actor, target) => withSession(actor.token, (client, identity) => loadUserForm(client, identity, target), { readOnly: true });
async function fixture() {
  const admin = await account({ permissions: ['users.manage', 'roles.manage'] }); const person = await account({ organizationId: admin.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Synthetic form laboratory')", [admin.organizationId, lab]);
  const input = { requestId: randomUUID(), revision: 1, profileRevision: 0, username: person.username, email: person.email,
    displayName: 'Form analyst', defaultRoleId: person.roleId, laboratoryId: lab, phone: '+91 123' };
  return { admin, person, lab, input };
}
async function unchanged(f, action, error) {
  assert.equal(typeof action, 'function');
  const before = await read(f.admin, f.person.userId);
  const credential = (await owner.query('SELECT * FROM credentials WHERE user_id=$1', [f.person.userId])).rows[0];
  await assert.rejects(action, error); assert.deepEqual(await read(f.admin, f.person.userId), before);
  assert.deepEqual((await owner.query('SELECT * FROM credentials WHERE user_id=$1', [f.person.userId])).rows[0], credential);
  assert.equal((await owner.query('SELECT 1 FROM user_profile_versions WHERE user_id=$1', [f.person.userId])).rowCount, 0);
  assert.equal((await owner.query('SELECT 1 FROM user_account_commands WHERE user_id=$1', [f.person.userId])).rowCount, 0);
}

test('a source user form saves identity and the first laboratory profile together, while metadata reads stay bounded and omit file bytes', async () => {
  const f = await fixture(); let queries = 0;
  const saved = await withSession(f.admin.token, (client, identity) => updateUserForm({ query(...args) { queries++; return client.query(...args); } }, identity, f.person.userId, f.input));
  assert.equal(queries, 3); assert.deepEqual(saved, { id: f.person.userId, revision: 2, passwordChanged: false, profileRevision: 1 });
  const content = Buffer.from('Original signature file that is not form metadata');
  await withSession(f.admin.token, (client, identity) => uploadUserSignature(client, identity, f.person.userId,
    { requestId: randomUUID(), revision: 0, originalName: 'signature.txt', mediaType: 'text/plain', content }));
  queries = 0;
  const form = await withSession(f.admin.token, (client, identity) => loadUserForm({ query(...args) { queries++; return client.query(...args); } }, identity, f.person.userId), { readOnly: true });
  assert.equal(queries, 5); assert.equal(form.account.displayName, 'Form analyst'); assert.equal(form.profile.phone, '+91 123'); assert.equal(form.profile.laboratoryId, f.lab);
  assert.equal(form.signature.file.byteLength, content.length); assert.equal(JSON.stringify(form).includes(content.toString()), false); assert.equal(Object.hasOwn(form.signature.file, 'content'), false);
});

test('invalid profile references and invalid input prevent any account, credential or profile changes', async () => {
  const f = await fixture();
  await unchanged(f, () => save(f.admin, f.person.userId, { ...f.input, laboratoryId: randomUUID(), password: 'Not committed password' }), { code: 'invalid_laboratory' });
  await unchanged(f, () => save(f.admin, f.person.userId, { ...f.input, password: 'short' }), { status: 400 });
});

test('an identity collision or protected shared identity rolls back the preceding profile, role assignments and its history', async () => {
  const f = await fixture(); const foreign = await account();
  await unchanged(f, () => save(f.admin, f.person.userId, { ...f.input, email: foreign.email, roleIds: [f.admin.roleId], defaultRoleId: f.admin.roleId }), { code: 'sign_in_identifier_taken' });
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, f.person.userId]);
  await unchanged(f, () => save(f.admin, f.person.userId, { ...f.input, password: 'Protected change password' }), { code: 'protected_user_identity' });
});

test('stale global and profile revisions cannot leave a partially saved user form', async () => {
  const f = await fixture();
  await withSession(f.admin.token, (client, identity) => updateUserAccount(client, identity, f.person.userId,
    { requestId: randomUUID(), revision: 1, username: f.person.username, email: f.person.email, displayName: 'Earlier account change' }));
  const before = await read(f.admin, f.person.userId);
  await assert.rejects(save(f.admin, f.person.userId, f.input), { code: 'stale_user_account' }); assert.deepEqual(await read(f.admin, f.person.userId), before);
  assert.equal((await owner.query('SELECT 1 FROM user_profile_versions WHERE user_id=$1', [f.person.userId])).rowCount, 0);
  await save(f.admin, f.person.userId, { ...f.input, requestId: randomUUID(), revision: 2 });
  const after = await read(f.admin, f.person.userId);
  await assert.rejects(save(f.admin, f.person.userId, { ...f.input, requestId: randomUUID(), revision: 3 }), { code: 'stale_user_profile' }); assert.deepEqual(await read(f.admin, f.person.userId), after);
});

test('exact form retries preserve later standalone identity and sparse profile changes and do not revoke a fresh session', async () => {
  const f = await fixture(); const input = { ...f.input, password: 'Original form password' }; const original = await save(f.admin, f.person.userId, input);
  const person = { ...f.person, ...await signIn({ identifier: f.person.username, password: input.password }) };
  await withSession(person.token, client => updateProfile(client, { revision: 2, username: `later-${f.person.userId}`, displayName: 'Later owner name' }), { accountAction: true });
  await withSession(f.admin.token, (client, identity) => updateUserProfile(client, identity, f.person.userId, { requestId: randomUUID(), revision: 1, phone: 'Later contact' }));
  const before = await read(f.admin, f.person.userId); assert.deepEqual(await save(f.admin, f.person.userId, input), original);
  assert.deepEqual(await read(f.admin, f.person.userId), before); await withSession(person.token, () => {});
  await assert.rejects(save(f.admin, f.person.userId, { ...input, phone: 'Different command' }), { code: 'save_request_reused' });
  const noProfile = { requestId: randomUUID(), revision: 3, profileRevision: 0, username: `later-${f.person.userId}`, email: f.person.email, displayName: 'New identity only' };
  assert.equal((await save(f.admin, f.person.userId, noProfile)).profileRevision, null);
  const after = await read(f.admin, f.person.userId); assert.deepEqual(after.profile, before.profile); assert.deepEqual(after.signature, before.signature);
});

test('self password form saves both histories before ending the current session', async () => {
  const f = await fixture(); const input = { ...f.input, username: f.admin.username, email: f.admin.email, defaultRoleId: f.admin.roleId, password: 'Self form password' };
  assert.deepEqual(await save(f.admin, f.admin.userId, input), { id: f.admin.userId, revision: 2, passwordChanged: true, profileRevision: 1 });
  await assert.rejects(withSession(f.admin.token, () => {}), { status: 401 });
  const fresh = { ...f.admin, ...await signIn({ identifier: f.admin.username, password: input.password }) };
  assert.deepEqual(await save(fresh, f.admin.userId, input), { id: f.admin.userId, revision: 2, passwordChanged: true, profileRevision: 1 });
  const form = await read(fresh, f.admin.userId); assert.equal(form.profile.revision, 1); assert.equal(form.account.revision, 2);
});

test('concurrent exact forms save once; competing forms and My Account edits have a coherent winner', async () => {
  let f = await fixture(); const exact = await Promise.all([save(f.admin, f.person.userId, f.input), save(f.admin, f.person.userId, f.input)]); assert.deepEqual(exact[0], exact[1]);
  const competing = await Promise.allSettled([save(f.admin, f.person.userId, { ...f.input, requestId: randomUUID(), revision: 2, profileRevision: 1, phone: 'A', displayName: 'A' }),
    save(f.admin, f.person.userId, { ...f.input, requestId: randomUUID(), revision: 2, profileRevision: 1, phone: 'B', displayName: 'B' })]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1); assert.equal(competing.find(result => result.status === 'rejected').reason.status, 409);
  let form = await read(f.admin, f.person.userId); assert.equal(form.profile.phone, form.account.displayName);
  f = await fixture();
  const concurrent = await Promise.allSettled([save(f.admin, f.person.userId, f.input), withSession(f.person.token, client => updateProfile(client,
    { revision: 1, username: f.person.username, displayName: 'Own concurrent name' }), { accountAction: true })]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1); assert.equal(concurrent.find(result => result.status === 'rejected').reason.status, 409);
  form = await read(f.admin, f.person.userId); assert.equal(form.account.revision, 2);
  if (concurrent[0].status === 'fulfilled') { assert.equal(form.profile.revision, 1); assert.equal(form.account.displayName, 'Form analyst'); }
  else { assert.equal(form.profile.revision, 0); assert.equal(form.account.displayName, 'Own concurrent name'); }
});

test('combined form reads and writes retain actual tenant and permission boundaries', async () => {
  const f = await fixture(); const foreign = await account({ permissions: ['users.manage'] });
  await assert.rejects(read(foreign, f.person.userId), { status: 404 }); await assert.rejects(save(foreign, f.person.userId, f.input), { status: 404 });
  await assert.rejects(save(f.person, f.person.userId, f.input), { status: 403 });
  await withSession(f.person.token, async (client, identity) => {
    await client.query('SAVEPOINT denied');
    await assert.rejects(updateUserForm(client, { ...identity, permission_codes: ['users.manage'] }, f.person.userId, f.input), { status: 403 });
    await client.query('ROLLBACK TO SAVEPOINT denied');
  });
  assert.equal((await read(f.admin, f.person.userId)).profile.revision, 0);
});
