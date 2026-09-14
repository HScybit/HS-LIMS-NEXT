import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { hashToken } from '../../src/auth/tokens.js';
import { updateRole, retireRole } from '../../src/roles/service.js';
import { updateUserProfile, loadUserProfile, listUserProfileHistory, listUserProfileReferences } from '../../src/users/profiles.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const account = async (options) => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const save = (actor, userId, input) => withSession(actor.token, (client, identity) => updateUserProfile(client, identity, userId, input));
const load = (actor, userId, options) => withSession(actor.token, (client, identity) => loadUserProfile(client, identity, userId, options), { readOnly: true });
const patch = (revision, value) => ({ requestId: randomUUID(), revision, ...value });
async function fixture() {
  const admin = await account({ permissions: ['users.manage', 'roles.manage'] });
  const person = await account({ organizationId: admin.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); const unit = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Original laboratory')", [admin.organizationId, lab]);
  await owner.query("INSERT INTO business_units(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Original unit')", [admin.organizationId, unit]);
  const initial = (value = {}) => patch(0, { defaultRoleId: person.roleId, laboratoryId: lab, ...value });
  return { admin, person, lab, unit, initial };
}
async function rollbackDenied(client, action, expected) {
  await client.query('SAVEPOINT denied'); await assert.rejects(action, expected); await client.query('ROLLBACK TO SAVEPOINT denied'); await client.query('RELEASE SAVEPOINT denied');
}

test('initial profile recording is explicit and scoped; shared global identity and other membership stay unchanged', async () => {
  const { admin, person, lab, unit, initial } = await fixture(); const foreign = await account({ permissions: ['users.manage', 'roles.manage'] });
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, person.userId]);
  await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) VALUES($1,$2,$3)', [foreign.organizationId, person.userId, foreign.roleId]);
  const globalBefore = (await owner.query('SELECT username,email,display_name,active,revision FROM users WHERE id=$1', [person.userId])).rows[0];
  const credentialBefore = (await owner.query('SELECT revision,updated_at FROM credentials WHERE user_id=$1', [person.userId])).rows[0];
  assert.deepEqual(await load(admin, person.userId), { id: person.userId, revision: 0, profile: null });
  await assert.rejects(save(admin, person.userId, patch(0, { phone: '123' })), { status: 422, code: 'user_profile_references_required' });
  await save(admin, person.userId, initial({ employeeCode: ' 007 ', phone: ' +91 0123 ', businessUnitId: unit, reportingManagerId: admin.userId, canManagePeople: true }));
  const profile = await load(person, person.userId); assert.equal(profile.employeeCode, '007'); assert.equal(profile.phone, '+91 0123'); assert.equal(profile.laboratoryId, lab);
  assert.equal(profile.savedBy, admin.userId); assert.equal(profile.previousRevision, null); assert(profile.savedAt instanceof Date);
  assert.deepEqual(profile.roles.map((role) => role.id), [person.roleId]); assert.equal(profile.roles[0].recordedRevision, null);
  assert.deepEqual(await load(foreign, person.userId), { id: person.userId, revision: 0, profile: null });
  assert.deepEqual((await owner.query('SELECT username,email,display_name,active,revision FROM users WHERE id=$1', [person.userId])).rows[0], globalBefore);
  assert.deepEqual((await owner.query('SELECT revision,updated_at FROM credentials WHERE user_id=$1', [person.userId])).rows[0], credentialBefore);
  assert.deepEqual((await owner.query('SELECT role_id FROM membership_roles WHERE organization_id=$1 AND user_id=$2', [foreign.organizationId, person.userId])).rows, [{ role_id: foreign.roleId }]);
  await assert.rejects(load(foreign, admin.userId), { status: 404 });
});

test('sparse edits preserve hidden roles and inactive references while exact historical labels and revisions stay immutable', async () => {
  const { admin, person, lab, unit, initial } = await fixture();
  const hidden = randomUUID();
  await owner.query("INSERT INTO roles(organization_id,id,name) VALUES($1,$2,'Hidden role')", [admin.organizationId, hidden]);
  await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) VALUES($1,$2,$3)', [admin.organizationId, person.userId, hidden]);
  await save(admin, person.userId, initial({ businessUnitId: unit, reportingManagerId: admin.userId, designation: 'Analyst' }));
  const before = await load(admin, person.userId, { atRevision: 1 });
  await owner.query("UPDATE roles SET active=false,name='Hidden renamed' WHERE organization_id=$1 AND id=$2", [admin.organizationId, hidden]);
  await owner.query("UPDATE laboratories SET active=false,name='Laboratory renamed',revision=revision+1 WHERE organization_id=$1 AND id=$2", [admin.organizationId, lab]);
  await owner.query("UPDATE business_units SET active=false,name='Unit renamed',revision=revision+1 WHERE organization_id=$1 AND id=$2", [admin.organizationId, unit]);
  await save(admin, person.userId, patch(1, { phone: ' ', canManagePeople: false }));
  const current = await load(admin, person.userId); assert.equal(current.phone, null); assert.equal(current.designation, 'Analyst'); assert.equal(current.businessUnitId, unit);
  assert.deepEqual(current.roles.map((role) => role.id), [hidden, person.roleId].sort()); assert.equal(current.roles.find((role) => role.id === hidden).active, false);
  assert.deepEqual(await load(admin, person.userId, { atRevision: 1 }), before);
  for (const [input, code] of [[{ laboratoryId: lab }, 'invalid_laboratory'], [{ businessUnitId: unit }, 'invalid_business_unit'], [{ roleIds: [person.roleId, hidden] }, 'invalid_user_roles']]) {
    await assert.rejects(save(admin, person.userId, patch(2, input)), { status: 422, code });
  }
  await save(admin, person.userId, patch(2, { businessUnitId: null, reportingManagerId: null }));
  assert.equal((await load(admin, person.userId)).businessUnitId, null);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await rollbackDenied(client, () => client.query("UPDATE user_profile_versions SET phone='rewrite' WHERE organization_id=$1", [admin.organizationId]), { code: '55000' });
    await rollbackDenied(client, () => client.query('DELETE FROM user_profile_version_roles WHERE organization_id=$1', [admin.organizationId]), { code: '55000' });
    await rollbackDenied(client, async () => {
      await client.query('DELETE FROM membership_roles WHERE organization_id=$1 AND user_id=$2 AND role_id=$3', [admin.organizationId, person.userId, hidden]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    }, { code: '23514' });
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('exact request retries survive later changes, but different sparse commands, actors and stale revisions fail', async () => {
  const { admin, person, initial } = await fixture(); const other = await account({ organizationId: admin.organizationId, permissions: ['users.manage'] });
  const first = initial({ phone: '123', roleIds: [person.roleId] }); await save(admin, person.userId, first);
  await save(admin, person.userId, patch(1, { phone: null }));
  assert.deepEqual(await save(admin, person.userId, { ...first, requestId: first.requestId.toUpperCase(), roleIds: [person.roleId.toUpperCase()] }), { id: person.userId, revision: 1 });
  for (const changed of [{ ...first, phone: null }, { ...first, employeeCode: null }, { ...first, roleIds: undefined }]) {
    if (changed.roleIds === undefined) delete changed.roleIds;
    await assert.rejects(save(admin, person.userId, changed), { status: 409, code: 'save_request_reused' });
  }
  await assert.rejects(save(other, person.userId, first), { status: 409, code: 'save_request_reused' });
  await assert.rejects(save(admin, person.userId, patch(0, { phone: 'stale' })), { status: 409, code: 'stale_user_profile' });
  assert.equal((await load(admin, person.userId)).revision, 2);
});

test('explicit role sets add the chosen default, preserve real recorded role versions, and support larger omitted legacy sets', async () => {
  const { admin, person, initial } = await fixture();
  const ids = (await owner.query("INSERT INTO roles(organization_id,id,name) SELECT $1,gen_random_uuid(),'Role '||n||' '||$2 FROM generate_series(1,101) n RETURNING id", [admin.organizationId, randomUUID()])).rows.map((row) => row.id);
  await withSession(admin.token, (client, identity) => updateRole(client, identity, { id: ids[0], revision: 0, requestId: randomUUID(), name: 'Versioned role', permissionCodes: [], capabilityKeys: [] }));
  const first = initial({ roleIds: ids.slice(0, 100) }); await save(admin, person.userId, first);
  const profile = await load(admin, person.userId); assert.equal(profile.roles.length, 101); assert(profile.roles.some((role) => role.id === person.roleId));
  assert.equal(profile.roles.find((role) => role.id === ids[0]).recordedRevision, 1);
  const retry = { ...first, roleIds: [...first.roleIds].reverse() }; assert.equal((await save(admin, person.userId, retry)).revision, 1);
  await save(admin, person.userId, patch(1, { designation: 'Preserve 101 roles' })); assert.equal((await load(admin, person.userId)).roles.length, 101);
  await save(admin, person.userId, patch(2, { defaultRoleId: ids[100] })); assert.equal((await load(admin, person.userId)).roles.length, 102);
  await save(admin, person.userId, patch(3, { defaultRoleId: ids[0], roleIds: [ids[100]] }));
  assert.deepEqual((await load(admin, person.userId)).roles.map((role) => role.id), [ids[0], ids[100]].sort());
  assert.equal((await load(admin, person.userId, { atRevision: 1 })).roles.length, 101);
  await withSession(admin.token, (client, identity) => retireRole(client, identity, { id: person.roleId, revision: 0, requestId: randomUUID() }));
  assert.equal((await save(admin, person.userId, first)).revision, 1, 'Exact retries must precede current availability checks even after the old default is retired');
});

test('the stored revision constraint rejects missing prior revisions rather than accepting SQL UNKNOWN', async () => {
  const expression = (await owner.query("SELECT pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint WHERE conrelid='user_profile_versions'::regclass AND conname='user_profile_version_revision'")).rows[0].expression;
  const result = await owner.query(`SELECT (${expression}) AS allowed FROM (VALUES(1,NULL::integer),(2,NULL::integer),(2,1),(3,0),(4,2)) AS user_profile_versions(revision,previous_revision)`);
  assert.deepEqual(result.rows.map((row) => row.allowed), [true, false, true, false, false]);
});

test('new foreign, inactive and self-manager references are rejected without partial profile history', async () => {
  const { admin, person, initial } = await fixture(); const foreign = await fixture();
  const inactive = await account({ organizationId: admin.organizationId, permissions: [] });
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [admin.organizationId, inactive.userId]);
  for (const [value, code] of [[{ defaultRoleId: foreign.person.roleId }, 'invalid_user_roles'], [{ roleIds: [randomUUID()] }, 'invalid_user_roles'],
    [{ laboratoryId: foreign.lab }, 'invalid_laboratory'], [{ businessUnitId: foreign.unit }, 'invalid_business_unit'],
    [{ reportingManagerId: foreign.person.userId }, 'invalid_reporting_manager'], [{ reportingManagerId: inactive.userId }, 'invalid_reporting_manager'], [{ reportingManagerId: person.userId }, 'user_own_manager']]) {
    await assert.rejects(save(admin, person.userId, initial(value)), { status: 422, code });
  }
  assert.equal((await load(admin, person.userId)).revision, 0);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM user_profile_versions WHERE organization_id=$1', [admin.organizationId])).rows[0].count, 0);
});

test('readers have bounded history and reference queries, including selected inactive labels and literal wildcard search', async () => {
  const { admin, person, lab, unit, initial } = await fixture(); await save(admin, person.userId, initial());
  for (let revision = 1; revision < 4; revision++) await save(admin, person.userId, patch(revision, { phone: `${revision}` }));
  await owner.query("UPDATE business_units SET name='Literal %_ unit',revision=revision+1 WHERE organization_id=$1 AND id=$2", [admin.organizationId, unit]);
  await withSession(person.token, async (client, identity) => {
    let queries = 0; const measured = { query(...args) { queries++; return client.query(...args); } };
    await loadUserProfile(measured, identity, person.userId); assert.equal(queries, 1);
    const history = await listUserProfileHistory(measured, identity, person.userId, { pageSize: 2 }); assert.equal(queries, 3);
    assert.deepEqual(history.rows.map((row) => row.revision), [4, 3]); assert.equal(history.hasMore, true);
    assert.deepEqual((await listUserProfileHistory(client, identity, person.userId, { beforeRevision: history.nextBeforeRevision })).rows.map((row) => row.revision), [2, 1]);
    assert.deepEqual((await listUserProfileReferences(measured, identity, { kind: 'businessUnits', search: '%_' })).rows.map((row) => row.id), [unit]); assert.equal(queries, 4);
    assert.deepEqual(await listUserProfileReferences(client, identity, { kind: 'laboratories', selectedIds: [] }), { rows: [], hasMore: false });
    assert.deepEqual((await listUserProfileReferences(client, identity, { kind: 'laboratories', selectedIds: [lab, randomUUID()] })).rows.map((row) => row.id), [lab]);
    assert(!(await listUserProfileReferences(client, identity, { kind: 'managers', excludeUserId: person.userId })).rows.some((row) => row.id === person.userId));
  }, { readOnly: true });
});

test('actual session and permission checks defeat forged service identities and deny raw tables and worker access', async () => {
  const { admin, person, initial } = await fixture(); const unrelated = await account({ organizationId: admin.organizationId, permissions: ['samples.read'] });
  await withSession(person.token, async (client, identity) => {
    await rollbackDenied(client, () => updateUserProfile(client, { ...identity, permission_codes: ['users.manage'] }, person.userId, initial()), { status: 403 });
    for (const relation of ['user_profiles', 'user_profile_versions', 'user_profile_version_roles', 'business_units']) {
      await rollbackDenied(client, () => client.query(`SELECT * FROM ${relation}`), { code: '42501' });
      for (const permission of ['INSERT', 'UPDATE', 'DELETE']) assert.equal((await client.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [relation, permission])).rows[0].allowed, false);
    }
  });
  await withSession(unrelated.token, async (client, identity) => {
    await assert.rejects(loadUserProfile(client, { ...identity, permission_codes: ['users.read'] }, person.userId), { status: 404 });
    assert.deepEqual(await listUserProfileReferences(client, { ...identity, permission_codes: ['users.read'] }, { kind: 'roles' }), { rows: [], hasMore: false });
  }, { readOnly: true });
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE sampleify_report_worker');
    for (const relation of ['user_profile_heads', 'user_profile_history', 'user_profile_role_history', 'user_profile_references']) await rollbackDenied(client, () => client.query(`SELECT * FROM ${relation}`), { code: '42501' });
    await rollbackDenied(client, () => client.query('SELECT users_require_manager()'), { code: '42501' });
    await client.query('RESET ROLE'); await client.query('SET LOCAL ROLE sampleify_app');
    const identity = (await client.query('SELECT * FROM auth_session_context($1)', [hashToken(admin.token)])).rows[0];
    await client.query("SELECT set_config('app.user_id',$1,true)", [person.userId]);
    await rollbackDenied(client, () => updateUserProfile(client, identity, person.userId, initial()), { status: 403 });
    assert.equal((await client.query('SELECT * FROM user_profile_references')).rowCount, 0);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('profile and role commands preserve final administration permissions without changing self-service credentials', async () => {
  const { admin, person, lab } = await fixture();
  await assert.rejects(save(admin, admin.userId, patch(0, { defaultRoleId: person.roleId, laboratoryId: lab, roleIds: [person.roleId] })), { status: 409, code: 'last_user_administrator' });
  await assert.rejects(withSession(admin.token, (client, identity) => updateRole(client, identity, {
    id: admin.roleId, revision: 0, requestId: randomUUID(), name: `Admin ${randomUUID()}`, permissionCodes: ['roles.manage'], capabilityKeys: [],
  })), { status: 409, code: 'last_user_administrator' });
  assert.equal((await load(admin, admin.userId)).revision, 0);
  const second = await account({ organizationId: admin.organizationId, permissions: ['users.manage', 'roles.manage'] });
  await save(admin, admin.userId, patch(0, { defaultRoleId: person.roleId, laboratoryId: lab, roleIds: [person.roleId] }));
  assert.equal((await load(second, admin.userId)).revision, 1);
  await assert.rejects(save(admin, person.userId, patch(0, { phone: 'now forbidden' })), { status: 403 });
});

async function queuedSave(f, target, input, mutate, lock) {
  const blocker = await owner.connect(); let pending;
  try {
    await blocker.query('BEGIN');
    if (lock) await lock(blocker);
    else await blocker.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [f.admin.organizationId]);
    let reportPid; const started = new Promise((resolve) => { reportPid = resolve; });
    pending = withSession(f.admin.token, async (client, identity) => {
      reportPid((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return updateUserProfile(client, identity, target, input);
    }).then((value) => ({ value }), (error) => ({ error }));
    const pid = await started; let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
      if (waiting) break; await delay(10);
    }
    assert.equal(waiting, true, 'The profile must actually wait for the locked row');
    await mutate(blocker); await blocker.query('COMMIT'); return await pending;
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
}

test('omitted manager and laboratory labels are observed consistently after concurrent reference edits', async () => {
  const f = await fixture(); const manager = await account({ organizationId: f.admin.organizationId, permissions: [] });
  await save(f.admin, f.person.userId, f.initial({ reportingManagerId: manager.userId }));
  const first = await load(f.admin, f.person.userId);
  const renamedManager = await queuedSave(f, f.person.userId, patch(1, { designation: 'After manager edit' }),
    (blocker) => blocker.query("UPDATE users SET display_name='Renamed manager',revision=revision+1 WHERE id=$1", [manager.userId]),
    (blocker) => blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [manager.userId]));
  assert.equal(renamedManager.value.revision, 2); assert.equal((await load(f.admin, f.person.userId)).reportingManagerName, 'Renamed manager');
  const renamedLab = await queuedSave(f, f.person.userId, patch(2, { phone: 'After laboratory edit' }),
    (blocker) => blocker.query("UPDATE laboratories SET name='Renamed while waiting',revision=revision+1 WHERE organization_id=$1 AND id=$2", [f.admin.organizationId, f.lab]),
    (blocker) => blocker.query('SELECT id FROM laboratories WHERE organization_id=$1 AND id=$2 FOR UPDATE', [f.admin.organizationId, f.lab]));
  assert.equal(renamedLab.value.revision, 3); assert.equal((await load(f.admin, f.person.userId)).laboratoryName, 'Renamed while waiting');
  assert.deepEqual(await load(f.admin, f.person.userId, { atRevision: 1 }), first);
});

test('session revocation and role retirement are rechecked after the actual organization-lock wait', async () => {
  const f = await fixture();
  const revoked = await queuedSave(f, f.person.userId, f.initial(), (blocker) => blocker.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(f.admin.token)]));
  assert.equal(revoked.error.status, 403); assert.equal((await load(f.person, f.person.userId)).revision, 0);
  const other = await fixture(); const candidate = randomUUID();
  await owner.query("INSERT INTO roles(organization_id,id,name) VALUES($1,$2,'To retire')", [other.admin.organizationId, candidate]);
  const retired = await queuedSave(other, other.person.userId, other.initial({ defaultRoleId: candidate }), async (blocker) => {
    await blocker.query('SET LOCAL ROLE sampleify_app');
    const identity = (await blocker.query('SELECT * FROM auth_session_context($1)', [hashToken(other.admin.token)])).rows[0];
    await retireRole(blocker, identity, { id: candidate, revision: 0, requestId: randomUUID() });
  });
  assert.equal(retired.error.code, 'invalid_user_roles'); assert.equal((await load(other.admin, other.person.userId)).revision, 0);
});

test('concurrent role-permission removal cannot combine with an assignment edit to remove all user managers', async () => {
  const f = await fixture(); const second = await account({ organizationId: f.admin.organizationId, permissions: ['users.manage', 'roles.manage'] });
  const result = await queuedSave(f, f.admin.userId, patch(0, { defaultRoleId: f.person.roleId, laboratoryId: f.lab, roleIds: [f.person.roleId] }), async (blocker) => {
    await blocker.query('SET LOCAL ROLE sampleify_app'); const identity = (await blocker.query('SELECT * FROM auth_session_context($1)', [hashToken(second.token)])).rows[0];
    await updateRole(blocker, identity, { id: second.roleId, revision: 0, requestId: randomUUID(), name: 'Roles manager only', permissionCodes: ['roles.manage'], capabilityKeys: [] });
  });
  assert.equal(result.error.code, 'last_user_administrator'); assert.equal((await load(f.admin, f.admin.userId)).revision, 0);
  const revoked = await fixture(); const otherAdmin = await account({ organizationId: revoked.admin.organizationId, permissions: ['users.manage', 'roles.manage'] });
  const lostPermission = await queuedSave(revoked, revoked.person.userId, revoked.initial(), async (blocker) => {
    await blocker.query('SET LOCAL ROLE sampleify_app'); const identity = (await blocker.query('SELECT * FROM auth_session_context($1)', [hashToken(otherAdmin.token)])).rows[0];
    await updateRole(blocker, identity, { id: revoked.admin.roleId, revision: 0, requestId: randomUUID(), name: 'Permission revoked', permissionCodes: ['roles.manage'], capabilityKeys: [] });
  });
  assert.equal(lostPermission.error.status, 403); assert.equal((await load(otherAdmin, revoked.person.userId)).revision, 0);
});
