import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadUser, listUsers } from '../../src/users/directory.js';
import { updateUserProfile, listUserProfileReferences } from '../../src/users/profiles.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
async function fixture() {
  const admin = await createAccount(owner, { permissions: ['users.manage'] });
  Object.assign(admin, await signIn({ identifier: admin.username, password: admin.password }));
  const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: [] });
  const read = (action) => withSession(admin.token, action, { readOnly: true });
  return { admin, person, load: () => read((client, identity) => loadUser(client, identity, person.userId)),
    list: (value) => read((client, identity) => listUsers(client, identity, value)) };
}

test('screen dates distinguish global identity birth from membership joining and leave unrecorded profile labels null', async () => {
  const f = await fixture(); const born = '2020-02-29T00:00:00.000Z'; const joined = '2025-01-02T03:04:05.000Z';
  await owner.query('UPDATE users SET created_at=$2 WHERE id=$1', [f.person.userId, born]);
  await owner.query('UPDATE memberships SET created_at=$3 WHERE organization_id=$1 AND user_id=$2', [f.admin.organizationId, f.person.userId, joined]);
  const row = await f.load(); assert.equal(row.identityCreatedAt.toISOString(), born); assert.equal(row.createdAt.toISOString(), joined);
  for (const key of ['defaultRoleId', 'defaultRoleName', 'defaultRoleDescription', 'businessUnitId', 'businessUnitName']) assert.equal(row[key], null);
  assert.equal(row.roles.length, 1); assert.equal((await f.list({ sort: { key: 'identityCreatedAt', dir: 'asc' } })).rows[0].id, f.person.userId);
});

test('screen uses saved default-role and unit labels, live role description and the whole current assigned-role set', async () => {
  const f = await fixture(); const org = f.admin.organizationId; const lab = randomUUID(); const unit = randomUUID(); const hidden = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Lab')", [org, lab]);
  await owner.query("INSERT INTO business_units(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Saved %_\\ Unit')", [org, unit]);
  await owner.query("UPDATE roles SET name='Saved %_\\ Role',description='Original description' WHERE organization_id=$1 AND id=$2", [org, f.person.roleId]);
  await owner.query("INSERT INTO roles(organization_id,id,name) VALUES($1,$2,'Alphabetically first hidden role')", [org, hidden]);
  await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) VALUES($1,$2,$3)', [org, f.person.userId, hidden]);
  await withSession(f.admin.token, (client, identity) => updateUserProfile(client, identity, f.person.userId,
    { revision: 0, requestId: randomUUID(), defaultRoleId: f.person.roleId, laboratoryId: lab, businessUnitId: unit }));
  await owner.query("UPDATE roles SET name='Current role',description='Current description',active=false WHERE organization_id=$1 AND id=$2", [org, f.person.roleId]);
  await owner.query("UPDATE business_units SET name='Current unit',revision=revision+1,active=false WHERE organization_id=$1 AND id=$2", [org, unit]);
  const row = await f.load(); assert.equal(row.defaultRoleName, 'Saved %_\\ Role'); assert.equal(row.businessUnitName, 'Saved %_\\ Unit');
  assert.equal(row.defaultRoleDescription, 'Current description'); assert.deepEqual(row.roles.map(role => role.id).sort(), [hidden, f.person.roleId].sort());
  await withSession(f.admin.token, async (client, identity) => {
    assert.equal((await listUserProfileReferences(client, identity, { kind: 'roles', search: 'Current role' })).rows.length, 0);
    const references = await listUserProfileReferences(client, identity, { kind: 'roles', search: 'Current role', includeInactive: true });
    assert.deepEqual(references.rows.map(role => role.id), [f.person.roleId]); assert.equal(references.rows[0].active, false);
  }, { readOnly: true });
  const filters = { defaultRoleName: { type: 'text', value: '%_\\' }, businessUnitName: { type: 'text', value: '%_\\' },
    defaultRoleDescription: { type: 'relation', value: [f.person.roleId] } };
  assert.deepEqual((await f.list({ filters })).rows.map(row => row.id), [f.person.userId]);
  assert.equal((await f.list({ filters: { ...filters, defaultRoleDescription: { type: 'relation', value: [hidden] } } })).totalCount, 0);
  assert.equal((await f.list({ search: 'Saved %_\\ Unit', page: 100 })).totalCount, 1);
  assert.deepEqual((await f.list({ search: 'Saved %_\\ Unit', page: 100 })).rows, []);
});

test('created-on filters include exactly the viewer calendar day across spring and autumn DST and non-hour offsets', async () => {
  const f = await fixture();
  for (const [zone, day, start, end] of [
    ['America/New_York', '2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
    ['America/New_York', '2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
    ['Asia/Kolkata', '2026-09-14', '2026-09-13T18:30:00Z', '2026-09-14T18:30:00Z'],
  ]) {
    const input = { search: f.person.username, timeZone: zone, filters: { identityCreatedAt: { type: 'date', from: day, to: day } } };
    for (const [at, expected] of [[new Date(Date.parse(start) - 1), 0], [new Date(start), 1], [new Date(Date.parse(end) - 1), 1], [new Date(end), 0]]) {
      await owner.query('UPDATE users SET created_at=$2 WHERE id=$1', [f.person.userId, at]);
      assert.equal((await f.list(input)).totalCount, expected, `${zone} ${at.toISOString()}`);
    }
  }
});

test('screen filters and activity sorting retain actual tenant scope and independent identity availability', async () => {
  const f = await fixture(); const foreign = await createAccount(owner, { permissions: [] });
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, f.person.userId]);
  for (const [org, at] of [[f.admin.organizationId, '2020-01-01T00:00:00Z'], [foreign.organizationId, '2099-01-01T00:00:00Z']]) {
    await owner.query("INSERT INTO account_events(organization_id,user_id,kind,occurred_at) VALUES($1,$2,'sign_in',$3)", [org, f.person.userId, at]);
  }
  assert.equal((await f.list({ sort: { key: 'lastLoginAt', dir: 'asc' } })).rows[0].id, f.person.userId);
  assert.equal((await f.load()).lastLoginAt.toISOString(), '2020-01-01T00:00:00.000Z');
  await owner.query('UPDATE users SET active=false WHERE id=$1', [f.person.userId]);
  const input = { search: f.person.username, filters: { membershipActive: { type: 'boolean', value: 'true' } } };
  assert.equal((await f.list(input)).totalCount, 1); assert.equal((await f.list({ ...input, status: 'active' })).totalCount, 0);
});

test('role-only search matches literal wildcard characters and inactive assignments without matching foreign or unassigned roles', async () => {
  const f = await fixture(); const other = await createAccount(owner, { organizationId: f.admin.organizationId, permissions: [] });
  const foreign = await createAccount(owner, { permissions: [] }); const roleName = 'Only role %_\\ match';
  await owner.query('UPDATE roles SET name=$3,active=false WHERE organization_id=$1 AND id=$2', [f.admin.organizationId, f.person.roleId, roleName]);
  await owner.query('UPDATE roles SET name=$3 WHERE organization_id=$1 AND id=$2', [foreign.organizationId, foreign.roleId, roleName]);
  await owner.query("UPDATE roles SET name='Only role any literal match' WHERE organization_id=$1 AND id=$2", [f.admin.organizationId, other.roleId]);
  await owner.query("INSERT INTO roles(organization_id,id,name) VALUES($1,$2,'Unassigned role needle')", [f.admin.organizationId, randomUUID()]);
  for (const search of ['%_\\', roleName]) {
    for (const sort of [{ key: 'displayName', dir: 'asc' }, { key: 'lastLoginAt', dir: 'desc' }, { key: 'lastLogoutAt', dir: 'asc' }]) {
      const result = await f.list({ search, status: 'active', sort });
      assert.deepEqual(result.rows.map(row => row.id), [f.person.userId]); assert.equal(result.totalCount, 1); assert.equal(result.rows[0].defaultRoleId, null);
      assert.equal(result.rows[0].roles[0].active, false);
    }
  }
  assert.deepEqual(await f.list({ search: 'Unassigned role needle' }), { rows: [], totalCount: 0 });
});
