import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { loadMethod, saveMethod, retireMethod, methodUsers, listMethods } from '../../src/masters/methods.js';

const owner = ownerPool(); let account; let viewer; let outsider; let noAccess;
const work = (callback, user = account, readOnly = false) => withSession(user.token, callback, { csrfToken: user.csrfToken, readOnly });
const input = () => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, uuid: `ISO ${randomUUID()}`, name: 'Synthetic method master', description: '  Authored notes  ',
  decimalScale: 4, parseNumber: false, accessUserIds: [] });
before(async () => {
  account = await createAccount(owner, { permissions: ['masters.manage'] });
  viewer = await createAccount(owner, { organizationId: account.organizationId, permissions: ['masters.read'] });
  noAccess = await createAccount(owner, { organizationId: account.organizationId, permissions: [] });
  outsider = await createAccount(owner, { permissions: ['masters.read', 'masters.manage'] });
  for (const user of [account, viewer, outsider, noAccess]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

test('method edits preserve zero, false, raw UUID and hidden code/parameter links with actual immutable revision provenance', async () => {
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const original = await work((client, identity) => loadMethod(client, identity, fixture.method.id), account, true);
  const command = { ...input(), id: original.id, revision: original.revision, uuid: 'x'.repeat(100), decimalScale: 0, parseNumber: false, accessUserIds: [viewer.userId, account.userId] };
  const saved = await work((client, identity) => saveMethod(client, identity, command));
  assert.equal(saved.uuid, command.uuid); assert.equal(saved.decimalScale, 0); assert.equal(saved.parseNumber, false); assert.equal(saved.description, command.description);
  assert.equal(saved.code, original.code); assert.deepEqual(saved.accessUserIds, command.accessUserIds);
  assert.equal((await owner.query('SELECT 1 FROM parameter_methods WHERE organization_id=$1 AND test_parameter_id=$2 AND method_id=$3', [account.organizationId, fixture.parameter.id, original.id])).rowCount, 1);
  await assert.rejects(work((client, identity) => loadMethod(client, identity, original.id, { atRevision: 1 })), { code: 'method_not_found' });
  const history = await work((client, identity) => loadMethod(client, identity, original.id, { atRevision: 2 }), viewer, true);
  assert.equal(history.savedBy, account.userId); assert.equal(history.previousRevision, 1);
  await work((client, identity) => saveMethod(client, identity, { ...command, revision: 2, requestId: randomUUID(), name: 'Later method', accessUserIds: [] }));
  assert.deepEqual(await work((client, identity) => loadMethod(client, identity, original.id, { atRevision: 2 }), viewer, true), history);
});

test('method retries save once, changed retry content and stale saves fail, and retirement retains an inactive selected user', async () => {
  const selected = await createAccount(owner, { organizationId: account.organizationId, permissions: [] });
  const command = { ...input(), accessUserIds: [selected.userId] };
  const results = await Promise.all([0, 1].map(() => work((client, identity) => saveMethod(client, identity, command))));
  assert.deepEqual(results.map((row) => [row.id, row.revision]), [[command.id, 1], [command.id, 1]]);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM method_versions WHERE organization_id=$1 AND method_id=$2', [account.organizationId, command.id])).rows[0].count, 1);
  await assert.rejects(work((client, identity) => saveMethod(client, identity, { ...command, parseNumber: true })), { code: 'save_request_reused' });
  await work((client, identity) => saveMethod(client, identity, { ...command, revision: 1, requestId: randomUUID(), decimalScale: 0 }));
  await assert.rejects(work((client, identity) => saveMethod(client, identity, { ...command, revision: 1, requestId: randomUUID() })), { code: 'stale_method' });
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [account.organizationId, selected.userId]);
  await assert.rejects(work((client, identity) => saveMethod(client, identity, { ...command, revision: 2, requestId: randomUUID() })), { code: 'invalid_method_users' });
  const removal = { id: command.id, revision: 2, requestId: randomUUID() };
  assert.deepEqual(await work((client, identity) => retireMethod(client, identity, removal)), { id: command.id, revision: 3 });
  assert.deepEqual(await work((client, identity) => retireMethod(client, identity, removal)), { id: command.id, revision: 3 });
  await assert.rejects(work((client, identity) => loadMethod(client, identity, command.id)), { code: 'method_not_found' });
  const retired = await work((client, identity) => loadMethod(client, identity, command.id, { atRevision: 3 }), viewer, true);
  assert.deepEqual(retired.accessUserIds, [selected.userId]); assert.equal(retired.accessUsers[0].active, false); assert.equal(retired.decimalScale, 0);
});

test('method labels and history stay within tenant/permission boundaries and private credentials remain inaccessible', async () => {
  const command = { ...input(), accessUserIds: [account.userId] }; await work((client, identity) => saveMethod(client, identity, command));
  for (const options of [{}, { atRevision: 1 }]) await assert.rejects(work((client, identity) => loadMethod(client, identity, command.id, options), outsider, true), { code: 'method_not_found' });
  await assert.rejects(work((client, identity) => saveMethod(client, identity, input()), viewer), { code: 'forbidden' });
  await assert.rejects(work((client, identity) => saveMethod(client, identity, { ...input(), accessUserIds: [outsider.userId] })), { code: 'invalid_method_users' });
  assert.equal((await work((client) => client.query('SELECT * FROM method_access_user_labels'), noAccess, true)).rowCount, 0);
  assert.equal((await getPool().query('SELECT * FROM method_access_user_labels')).rowCount, 0);
  const labels = await work((client) => client.query('SELECT * FROM method_access_user_labels'), viewer, true);
  assert.ok(labels.rows.every((row) => row.organization_id === account.organizationId));
  assert.deepEqual(labels.fields.map((field) => field.name), ['organization_id', 'user_id', 'display_name', 'active']);
  await assert.rejects(work((client) => client.query('SELECT password_hash FROM credentials'), viewer, true), { code: '42501' });
  const lookup = await work((client, identity) => methodUsers(client, identity, { search: 'Synthetic' }), viewer, true);
  assert.ok(lookup.rows.some((row) => row.id === account.userId)); assert.ok(!lookup.rows.some((row) => row.id === outsider.userId));
  await assert.rejects(work((client, identity) => methodUsers(client, identity), noAccess, true), { code: 'forbidden' });
});

test('method history rejects forged children, incomplete updates, changed retirement settings and direct deletion', async () => {
  const command = { ...input(), accessUserIds: [viewer.userId] }; await work((client, identity) => saveMethod(client, identity, command));
  await assert.rejects(work((client) => client.query('INSERT INTO method_version_users(organization_id,method_id,revision,user_id,position) VALUES($1,$2,1,$3,1)',
    [account.organizationId, command.id, account.userId])), { code: '23514', message: 'Method user history requires its new version transaction' });
  await assert.rejects(work((client) => client.query('UPDATE method_versions SET name=$3 WHERE organization_id=$1 AND method_id=$2', [account.organizationId, command.id, 'Forged'])), { code: '42501' });
  await assert.rejects(work((client) => client.query('UPDATE methods_of_analysis SET revision=revision+1,save_request_id=$3 WHERE organization_id=$1 AND id=$2',
    [account.organizationId, command.id, randomUUID()])), { code: '23514', message: 'Method users require a complete ordered version' });
  await assert.rejects(work((client) => client.query("UPDATE methods_of_analysis SET active=false,name='Changed during retirement',revision=revision+1,save_request_id=$3 WHERE organization_id=$1 AND id=$2",
    [account.organizationId, command.id, randomUUID()])), { code: '23514', message: 'Method retirement preserves its last settings' });
  await assert.rejects(work((client) => client.query('DELETE FROM methods_of_analysis WHERE organization_id=$1 AND id=$2', [account.organizationId, command.id])), { code: '42501' });
  assert.equal((await work((client, identity) => loadMethod(client, identity, command.id))).revision, 1);
});

test('generated-code collisions fail explicitly while the full authored method UUID remains unchanged', async () => {
  const prefix = randomUUID() + 'x'.repeat(28);
  const first = { ...input(), uuid: `${prefix}A` }; const second = { ...input(), uuid: `${prefix}B` };
  const results = await Promise.allSettled([first, second].map((command) => work((client, identity) => saveMethod(client, identity, command))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'duplicate_method');
  const saved = results.find((result) => result.status === 'fulfilled').value;
  assert.equal(saved.uuid.length, 65); assert.equal(saved.code.length, 64);
});

test('method listing batches ordered user labels, literal searches, boolean filters and numeric sorting without tenant leaks', async () => {
  const tag = randomUUID(); const selected = await createAccount(owner, { organizationId: account.organizationId, permissions: [] });
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [selected.userId, `Selected_% ${tag}`]);
  const records = [];
  for (const scale of [10, 2, 0]) records.push(await work((client, identity) => saveMethod(client, identity,
    { ...input(), name: `List ${tag} ${scale}`, description: 'Exact_% middle match', decimalScale: scale, parseNumber: scale === 2, accessUserIds: [selected.userId, account.userId] })));
  const calls = [];
  const listing = await work((client, identity) => listMethods({ query: (...args) => { calls.push(args[0]); return client.query(...args); } }, identity,
    { search: tag, sort: { key: 'decimal_places', dir: 'asc' }, pageSize: 2 }), viewer, true);
  assert.equal(calls.length, 3, 'one field-definition batch plus the count and page queries'); assert.equal(listing.totalCount, 3);
  assert.deepEqual(listing.rows.map((row) => row.decimal_places), [0, 2]);
  assert.equal(listing.rows[0].has_access, `Selected_% ${tag}, Synthetic Analyst`);
  const last = await work((client, identity) => listMethods(client, identity, { search: tag, sort: { key: 'decimal_places', dir: 'asc' }, pageSize: 2, page: 2 }));
  assert.deepEqual(last.rows.map((row) => row.decimal_places), [10]);
  const no = await work((client, identity) => listMethods(client, identity,
    { search: tag, filters: { parse_num: { type: 'boolean', value: 'false' }, has_access: { type: 'text', value: 'Selected_%' } } }));
  assert.equal(no.totalCount, 2); assert.ok(no.rows.every((row) => row.parse_num === false));
  const yes = await work((client, identity) => listMethods(client, identity,
    { search: tag, filters: { parse_num: { type: 'boolean', value: 'true' }, description: { type: 'text', value: 'Exact_% match' } } }));
  assert.equal(yes.totalCount, 1); assert.equal(yes.rows[0].decimal_places, 2);
  assert.equal((await work((client, identity) => listMethods(client, identity,
    { search: 'Exact_% match', filters: { name: { type: 'text', value: tag } } }))).totalCount, 0);
  assert.equal((await work((client, identity) => listMethods(client, identity,
    { search: tag, filters: { has_access: { type: 'text', value: 'Selected_% Synthetic' } } }))).totalCount, 0);
  assert.equal((await work((client, identity) => listMethods(client, identity, { search: `${tag}, Synthetic` }))).totalCount, 0);
  assert.equal((await work((client, identity) => listMethods(client, identity,
    { search: 'No', filters: { uuid: { type: 'text', value: records[0].uuid } } }))).totalCount, 0);
  assert.equal((await work((client, identity) => listMethods(client, identity, { search: tag }), outsider, true)).totalCount, 0);
  assert.equal((await work((client, identity) => listMethods(client, identity, { search: tag, page: 100 }), viewer, true)).rows.length, 0);
  await work((client, identity) => retireMethod(client, identity, { id: records[0].id, revision: 1, requestId: randomUUID() }));
  assert.equal((await work((client, identity) => listMethods(client, identity, { search: tag }))).totalCount, 2);
  for (const query of [{ sort: { key: 'password_hash', dir: 'asc' } }, { sort: { key: 'name', dir: 'asc; SELECT 1' } },
    { filters: { parse_num: { type: 'text', value: 'false' } } }, { filters: { parse_num: { type: 'boolean', value: true } } },
    { filters: { uuid: { type: 'relation', value: [] } } }, { pageSize: 101 }, { search: '\0' }, null]) {
    await assert.rejects(work((client, identity) => listMethods(client, identity, query)), (error) => error.status === 400);
  }
});

test('method user search is bounded, literal and excludes both inactive memberships and inactive accounts', async () => {
  const prefix = `Lookup_% ${randomUUID()}`;
  await owner.query(`WITH people AS (
    INSERT INTO users(id,username,email,display_name)
      SELECT id,'lookup-'||id,'lookup-'||id||'@example.invalid',$2||' '||position FROM unnest($3::uuid[]) WITH ORDINALITY AS input(id,position)
      RETURNING id
  ) INSERT INTO memberships(organization_id,user_id) SELECT $1,id FROM people`, [account.organizationId, prefix, Array.from({ length: 102 }, () => randomUUID())]);
  const result = await work((client, identity) => methodUsers(client, identity, { search: prefix }), viewer, true);
  assert.equal(result.rows.length, 100); assert.equal(result.hasMore, true);
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [account.organizationId, result.rows[0].id]);
  await owner.query('UPDATE users SET active=false WHERE id=$1', [result.rows[1].id]);
  const remaining = await work((client, identity) => methodUsers(client, identity, { search: prefix }), viewer, true);
  assert.equal(remaining.rows.length, 100); assert.equal(remaining.hasMore, false);
  assert.ok(remaining.rows.every((row) => !result.rows.slice(0, 2).some((old) => old.id === row.id)));
  assert.equal((await work((client, identity) => methodUsers(client, identity, { search: prefix.replace('_%', 'XX') }))).rows.length, 0);
});
