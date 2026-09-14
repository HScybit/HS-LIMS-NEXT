import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { hashToken } from '../../src/auth/tokens.js';
import { closePool } from '../../src/db/pool.js';
import { listUsers, loadUser } from '../../src/users/directory.js';

const owner = ownerPool(); let reader; let manager; let foreign; let unrelated;
const account = async (options) => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const work = (actor, action) => withSession(actor.token, action, { readOnly: true });
const load = (actor, id) => work(actor, (client, identity) => loadUser(client, identity, id));
const list = (actor, input) => work(actor, (client, identity) => listUsers(client, identity, input));
before(async () => {
  reader = await account({ permissions: ['users.read'] });
  manager = await account({ organizationId: reader.organizationId, permissions: ['users.manage'] });
  unrelated = await account({ organizationId: reader.organizationId, permissions: ['samples.read'] });
  foreign = await account({ permissions: ['users.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

test('user directory readers and managers get bounded typed identities with two list queries and one detail query', async () => {
  await work(reader, async (client, identity) => {
    let count = 0; const measured = { query(...args) { count++; return client.query(...args); } };
    const result = await listUsers(measured, identity, { pageSize: 1 });
    assert.equal(count, 2); assert.equal(result.totalCount, 3); assert.equal(result.rows.length, 1);
    const person = await loadUser(measured, identity, manager.userId.toUpperCase()); assert.equal(count, 3);
    assert.deepEqual(Object.keys(person).sort(), ['active', 'createdAt', 'displayName', 'email', 'id', 'identityActive', 'lastLoginAt', 'lastLogoutAt', 'membershipActive', 'organizationName', 'roles', 'statusRevision', 'username',
      'identityCreatedAt', 'defaultRoleId', 'defaultRoleName', 'defaultRoleDescription', 'businessUnitId', 'businessUnitName'].sort());
    assert.equal(person.email, manager.email); assert.equal(person.active, true); assert(person.lastLoginAt instanceof Date); assert.equal(person.lastLogoutAt, null);
    assert.deepEqual(person.roles.map((role) => role.id), [manager.roleId]); assert.equal(person.roles[0].active, true);
  });
  assert.equal((await list(manager, {})).totalCount, 3);
  assert.deepEqual((await list(reader, { page: 1_000_000 })).rows, []);
  assert.deepEqual(await list(reader, { search: 'no-synthetic-person-has-this-name' }), { rows: [], totalCount: 0 });
});

test('directory search treats wildcard characters literally and preserves independent identity and membership availability', async () => {
  const person = await createAccount(owner, { organizationId: reader.organizationId, permissions: [] });
  const label = `Directory %_\\ ${randomUUID()}`;
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [person.userId, label]);
  assert.deepEqual((await list(reader, { search: '%_\\' })).rows.map((row) => row.id), [person.userId]);
  assert.deepEqual((await list(reader, { search: person.username })).rows.map((row) => row.id), [person.userId]);
  assert.deepEqual((await list(reader, { search: person.email })).rows.map((row) => row.id), [person.userId]);
  await owner.query('UPDATE roles SET name=$3 WHERE organization_id=$1 AND id=$2', [reader.organizationId, person.roleId, label]);
  assert.deepEqual((await list(reader, { search: label })).rows.map((row) => row.id), [person.userId]);
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [reader.organizationId, person.userId]);
  assert.equal((await load(reader, person.userId)).active, false);
  assert.deepEqual((await list(reader, { status: 'active', search: label })).rows, []);
  assert.equal((await list(reader, { status: 'disabled', search: label })).rows.length, 1);
  await owner.query('UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2', [reader.organizationId, person.userId]);
  await owner.query('UPDATE users SET active=false WHERE id=$1', [person.userId]);
  assert.equal((await load(reader, person.userId)).active, false);
});

test('shared identities expose only their current-tenant roles and actual sign-in or sign-out events', async () => {
  const shared = await createAccount(owner, { organizationId: reader.organizationId, permissions: [] });
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, shared.userId]);
  await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) VALUES($1,$2,$3)', [foreign.organizationId, shared.userId, foreign.roleId]);
  assert.equal((await load(reader, shared.userId)).lastLoginAt, null);
  assert.equal((await load(reader, shared.userId)).lastLogoutAt, null);
  const signedIn = new Date('2025-02-03T04:05:06.789Z'); const signedOut = new Date('2025-02-03T05:06:07.890Z');
  for (const [org, kind, at] of [[reader.organizationId, 'sign_in', signedIn], [reader.organizationId, 'sign_out', signedOut],
    [reader.organizationId, 'password_changed', new Date('2025-03-04T00:00:00Z')], [foreign.organizationId, 'sign_in', new Date('2025-04-05T00:00:00Z')]]) {
    await owner.query('INSERT INTO account_events(user_id,organization_id,kind,occurred_at) VALUES($1,$2,$3,$4)', [shared.userId, org, kind, at]);
  }
  const here = await load(reader, shared.userId); const there = await load(foreign, shared.userId);
  assert.deepEqual(here.roles.map((role) => role.id), [shared.roleId]); assert.deepEqual(there.roles.map((role) => role.id), [foreign.roleId]);
  assert.equal(here.lastLoginAt.toISOString(), signedIn.toISOString()); assert.equal(here.lastLogoutAt.toISOString(), signedOut.toISOString());
  assert.equal(there.lastLoginAt.toISOString(), '2025-04-05T00:00:00.000Z'); assert.equal(there.lastLogoutAt, null);
  assert.deepEqual((await list(reader, { search: there.roles[0].name })).rows, []);
  const session = await signIn({ identifier: shared.username, password: shared.password });
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(session.token)]);
  assert.equal((await load(reader, shared.userId)).lastLogoutAt.toISOString(), signedOut.toISOString());
});

test('paging has stable ties and does not duplicate or omit identities when sorting', async () => {
  const label = `Directory paging ${randomUUID()}`;
  const people = (await owner.query(`INSERT INTO users(id,username,email,display_name)
    SELECT gen_random_uuid(),$1||n,$1||n||'@example.invalid',$1 FROM generate_series(1,105) n RETURNING id`, [label])).rows;
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [reader.organizationId, people.map((person) => person.id)]);
  const first = await list(reader, { search: label, pageSize: 100, sort: { key: 'displayName', dir: 'desc' } });
  const second = await list(reader, { search: label, pageSize: 100, page: 2, sort: { key: 'displayName', dir: 'desc' } });
  assert.equal(first.totalCount, 105); assert.equal(first.rows.length, 100); assert.equal(second.rows.length, 5);
  assert.deepEqual([...first.rows, ...second.rows].map((person) => person.id), people.map((person) => person.id).sort());
  assert(first.rows.every((person) => person.roles.length === 0 && person.lastLoginAt === null && person.lastLogoutAt === null));
});

test('foreign users, forged service identities and unrelated permissions cannot cross the directory boundary', async () => {
  await assert.rejects(load(reader, foreign.userId), { status: 404, code: 'user_not_found' });
  await assert.rejects(load(reader, randomUUID()), { status: 404, code: 'user_not_found' });
  await assert.rejects(load(reader, 'invalid'), { status: 400 });
  await assert.rejects(list(unrelated, {}), { status: 403 });
  await work(unrelated, async (client, identity) => {
    assert.deepEqual(await listUsers(client, { ...identity, permission_codes: ['users.read'] }, {}), { rows: [], totalCount: 0 });
  });
  await work(reader, async (client, identity) => {
    assert.deepEqual(await listUsers(client, { ...identity, organization_id: foreign.organizationId }, {}), { rows: [], totalCount: 0 });
    for (const table of ['users', 'credentials', 'sessions', 'user_mfa', 'account_events']) {
      await client.query('SAVEPOINT private_table'); await assert.rejects(client.query(`SELECT * FROM ${table}`), { code: '42501' }); await client.query('ROLLBACK TO SAVEPOINT private_table');
    }
  });
});

test('directory views revalidate the actual session and do not grant application writes or worker reads', async () => {
  const actor = await account({ permissions: ['users.read'] }); const client = await owner.connect();
  const emptyViews = async () => { for (const relation of ['user_directory', 'user_directory_roles', 'user_directory_activity']) assert.equal((await client.query(`SELECT * FROM ${relation}`)).rowCount, 0); };
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE sampleify_app'); await emptyViews();
    await client.query('SELECT * FROM auth_session_context($1)', [hashToken(actor.token)]);
    assert.equal((await client.query('SELECT * FROM user_directory')).rowCount, 1);
    await client.query("SELECT set_config('app.user_id',$1,true)", [foreign.userId]); await emptyViews();
    await client.query('SELECT * FROM auth_session_context($1)', [hashToken(actor.token)]);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      assert.equal((await client.query("SELECT has_table_privilege(current_user,'user_directory',$1) AS allowed", [privilege])).rows[0].allowed, false);
    }
    for (const query of ["UPDATE user_directory SET display_name='denied'", 'DELETE FROM user_directory', 'INSERT INTO user_directory(id) VALUES(gen_random_uuid())']) {
      // PostgreSQL can reject this joined view during rewrite before checking its grants.
      await client.query('SAVEPOINT denied'); await assert.rejects(client.query(query), (error) => ['42501', '55000'].includes(error.code)); await client.query('ROLLBACK TO SAVEPOINT denied');
    }
    await client.query('RESET ROLE'); await client.query('UPDATE users SET must_change_password=true WHERE id=$1', [actor.userId]);
    await client.query('SET LOCAL ROLE sampleify_app'); await emptyViews();
    await client.query('RESET ROLE'); await client.query('UPDATE users SET must_change_password=false WHERE id=$1', [actor.userId]);
    await client.query('UPDATE credentials SET revision=revision+1 WHERE user_id=$1', [actor.userId]);
    await client.query('SET LOCAL ROLE sampleify_app'); await emptyViews();
    await client.query('RESET ROLE'); await client.query('UPDATE credentials SET revision=revision-1 WHERE user_id=$1', [actor.userId]);
    await client.query("UPDATE sessions SET expires_at=created_at+interval '1 microsecond' WHERE token_hash=$1", [hashToken(actor.token)]);
    await client.query('SET LOCAL ROLE sampleify_app'); await emptyViews();
    await client.query('RESET ROLE'); await client.query('SET LOCAL ROLE sampleify_report_worker');
    for (const query of ['SELECT * FROM user_directory', 'SELECT * FROM user_directory_roles', 'SELECT * FROM user_directory_activity', 'SELECT users_directory_organization()']) {
      await client.query('SAVEPOINT denied'); await assert.rejects(client.query(query), { code: '42501' }); await client.query('ROLLBACK TO SAVEPOINT denied');
    }
  } finally { await client.query('ROLLBACK'); client.release(); }
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [actor.organizationId, actor.roleId]);
  await assert.rejects(list(actor, {}), { status: 403 });
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(actor.token)]);
  await assert.rejects(list(actor, {}), { status: 401 });
});
