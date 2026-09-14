import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession, updateProfile, changePassword } from '../../src/auth/service.js';
import { hashToken } from '../../src/auth/tokens.js';
import { closePool } from '../../src/db/pool.js';
import { createUser } from '../../src/users/create.js';
import { loadUserProfile, updateUserProfile } from '../../src/users/profiles.js';
import { retireRole } from '../../src/roles/service.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const account = async (options) => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const create = (actor, input) => withSession(actor.token, (client, identity) => createUser(client, identity, input));
const load = (actor, id, options) => withSession(actor.token, (client, identity) => loadUserProfile(client, identity, id, options), { readOnly: true });
async function fixture() {
  const admin = await account({ permissions: ['users.manage', 'roles.manage'] });
  const reader = await account({ organizationId: admin.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); const unit = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Creation test lab')", [admin.organizationId, lab]);
  await owner.query("INSERT INTO business_units(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Creation test unit')", [admin.organizationId, unit]);
  const input = (extra = {}) => { const id = randomUUID(); return { id, requestId: randomUUID(), revision: 0, username: `new-${id}`, email: `New-${id}@example.invalid`,
    displayName: 'New synthetic person', password: '  Exact creation password  ', defaultRoleId: reader.roleId, laboratoryId: lab, ...extra }; };
  return { admin, reader, lab, unit, input };
}
async function noAccount(id) {
  for (const [relation, key] of [['users', 'id'], ['credentials', 'user_id'], ['memberships', 'user_id'], ['membership_roles', 'user_id'],
    ['user_profiles', 'user_id'], ['user_profile_versions', 'user_id'], ['user_creation_commands', 'user_id']]) {
    assert.equal((await owner.query(`SELECT count(*)::integer AS count FROM ${relation} WHERE ${key}=$1`, [id])).rows[0].count, 0, relation);
  }
}
async function rejected(client, action, expected) {
  await client.query('SAVEPOINT denied'); await assert.rejects(action, expected); await client.query('ROLLBACK TO SAVEPOINT denied'); await client.query('RELEASE SAVEPOINT denied');
}

test('native account creation records the actual creator, complete profile and exact usable password without exposing credentials', async () => {
  const f = await fixture(); const input = f.input({ employeeCode: '007', phone: '+91 0123', businessUnitId: f.unit, reportingManagerId: f.admin.userId, canManagePeople: true });
  const result = await create(f.admin, input);
  assert.deepEqual(result, { user: { id: input.id, username: input.username, email: input.email, displayName: input.displayName }, profileRevision: 1 });
  const session = await signIn({ identifier: input.username, password: input.password });
  await withSession(session.token, async (_client, identity) => {
    assert.equal(identity.user_id, input.id); assert.equal(identity.organization_id, f.admin.organizationId); assert.equal(identity.must_change_password, false); assert.deepEqual(identity.permission_codes, ['users.read']);
  });
  await assert.rejects(signIn({ identifier: input.username, password: input.password.trim() }), { code: 'invalid_credentials' });
  const profile = await load(f.admin, input.id); assert.equal(profile.employeeCode, '007'); assert.equal(profile.businessUnitId, f.unit); assert.equal(profile.savedBy, f.admin.userId);
  assert.equal(profile.previousRevision, null); assert.deepEqual(profile.roles.map((role) => role.id), [f.reader.roleId]);
  const event = (await owner.query('SELECT user_id,created_by,created_at,profile_revision,username,email,display_name,octet_length(fingerprint) AS bytes FROM user_creation_commands WHERE user_id=$1', [input.id])).rows[0];
  assert.equal(event.created_by, f.admin.userId); assert.equal(event.username, input.username); assert.equal(event.bytes, 32); assert.equal(event.profile_revision, 1); assert(event.created_at instanceof Date);
  assert.equal(event.created_at.toISOString(), profile.savedAt.toISOString());
});

test('invalid profile references roll back every provisional identity, credential, assignment and history row', async () => {
  const f = await fixture(); const foreign = await fixture();
  for (const [extra, code] of [[{ laboratoryId: foreign.lab }, 'invalid_laboratory'], [{ defaultRoleId: foreign.reader.roleId }, 'invalid_user_roles'],
    [{ businessUnitId: foreign.unit }, 'invalid_business_unit'], [{ reportingManagerId: foreign.reader.userId }, 'invalid_reporting_manager'], [{ roleIds: [randomUUID()] }, 'invalid_user_roles']]) {
    const input = f.input(extra); await assert.rejects(create(f.admin, input), { status: 422, code }); await noAccount(input.id);
  }
  const input = f.input(); await assert.rejects(create(f.admin, { ...input, id: foreign.reader.userId }), { status: 409, code: 'user_already_exists' });
  assert.equal((await load(foreign.admin, foreign.reader.userId)).revision, 0);
});

test('all four global username/email collisions and case variants are rejected while observed legacy duplicates remain intact', async () => {
  const f = await fixture(); const foreign = await fixture(); const alias = `Username-${randomUUID()}@example.invalid`;
  await owner.query('UPDATE users SET username=$2,revision=revision+1 WHERE id=$1', [foreign.reader.userId, alias]);
  for (const extra of [{ username: alias }, { username: foreign.reader.email }, { email: alias }, { email: foreign.reader.email }, { email: alias.toUpperCase() }, { username: foreign.reader.email.toUpperCase() }]) {
    const input = f.input(extra); await assert.rejects(create(f.admin, input), { status: 409, code: 'sign_in_identifier_taken' }); await noAccount(input.id);
  }
  const email = `shared-${randomUUID()}@example.invalid`;
  const first = await createAccount(owner, { email }); const second = await createAccount(owner, { email });
  await assert.rejects(signIn({ identifier: email, password: first.password }), { code: 'invalid_credentials' });
  await assert.rejects(create(f.admin, f.input({ email })), { code: 'sign_in_identifier_taken' });
  assert.equal((await owner.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) AND email=$2', [[first.userId, second.userId], email])).rowCount, 2);
  const same = f.input(); same.username = same.email;
  await create(f.admin, same); assert(await signIn({ identifier: same.email, password: same.password }));
});

test('exact creation retries return the original outcome after identity, password, profile, reference and alias ownership changes', async () => {
  const f = await fixture(); const input = f.input({ employeeCode: 'Initial employee code' }); const original = await create(f.admin, input);
  const session = await signIn({ identifier: input.username, password: input.password });
  await withSession(session.token, (client) => updateProfile(client, { displayName: 'Later name', username: `later-${input.id}`, revision: 1 }), { accountAction: true });
  await withSession(session.token, (client) => changePassword(client, { currentPassword: input.password, newPassword: 'A later exact password', confirmPassword: 'A later exact password' }), { accountAction: true });
  await withSession(f.admin.token, (client, identity) => updateUserProfile(client, identity, input.id, { requestId: randomUUID(), revision: 1, phone: 'Changed profile' }));
  const reusedAlias = f.input({ username: input.username }); await create(f.admin, reusedAlias);
  await owner.query('UPDATE laboratories SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [f.admin.organizationId, f.lab]);
  assert.deepEqual(await create(f.admin, input), original);
  assert.equal((await load(f.admin, input.id)).revision, 2); assert.equal((await load(f.admin, reusedAlias.id)).revision, 1);
  for (const changed of [{ ...input, password: 'Different replay password' }, { ...input, employeeCode: null }, { ...input, id: randomUUID() }, { ...input, roleIds: [f.reader.roleId] }]) {
    await assert.rejects(create(f.admin, changed), { status: 409, code: 'save_request_reused' });
  }
  const otherAdmin = await account({ organizationId: f.admin.organizationId, permissions: ['users.manage'] });
  await assert.rejects(create(otherAdmin, input), { code: 'save_request_reused' });
  const event = (await owner.query('SELECT username,display_name FROM user_creation_commands WHERE user_id=$1', [input.id])).rows[0];
  assert.deepEqual(event, { username: input.username, display_name: input.displayName });
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await rejected(client, () => client.query("UPDATE user_creation_commands SET display_name='Forged' WHERE user_id=$1", [input.id]), { code: '55000' });
    await rejected(client, () => client.query('DELETE FROM user_creation_commands WHERE user_id=$1', [input.id]), { code: '55000' });
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('concurrent exact requests commit one account and different creators cannot take over a creation request', async () => {
  const f = await fixture(); const input = f.input(); const results = await Promise.all([create(f.admin, input), create(f.admin, input)]);
  assert.deepEqual(results[0], results[1]);
  for (const table of ['user_creation_commands', 'user_profile_versions']) assert.equal((await owner.query(`SELECT count(*)::integer AS count FROM ${table} WHERE user_id=$1`, [input.id])).rows[0].count, 1);
  const other = await account({ organizationId: f.admin.organizationId, permissions: ['users.manage'] }); const competing = f.input();
  const attempts = await Promise.allSettled([create(f.admin, competing), create(other, competing)]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.code, 'save_request_reused');
});

test('concurrent creations in different organizations cannot introduce duplicate or crossed sign-in aliases', async () => {
  const first = await fixture(); const second = await fixture();
  for (const crossed of [false, true]) {
    const alias = `alias-${randomUUID()}@example.invalid`;
    const a = first.input({ username: alias }); const b = second.input(crossed ? { email: alias } : { username: alias.toUpperCase() });
    const results = await Promise.allSettled([create(first.admin, a), create(second.admin, b)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'sign_in_identifier_taken');
    assert.equal((await owner.query('SELECT id FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1)', [alias])).rowCount, 1);
    await noAccount(results[0].status === 'rejected' ? a.id : b.id);
  }
});

test('My Account username edits and native account creation share the global alias boundary', async () => {
  const f = await fixture(); const other = await fixture(); const alias = `concurrent-${randomUUID()}@example.invalid`;
  const input = other.input({ email: alias });
  const results = await Promise.allSettled([
    withSession(f.reader.token, (client) => updateProfile(client, { username: alias, displayName: 'Renamed account', revision: 1 }), { accountAction: true }),
    create(other.admin, input),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.status, 409);
  assert.equal((await owner.query('SELECT id FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1)', [alias])).rowCount, 1);
  await assert.rejects(withSession(f.reader.token, (client) => updateProfile(client, { username: 'stale', displayName: 'Stale', revision: 100 }), { accountAction: true }), { code: 'stale_profile' });
});

test('actual permissions and session identities protect creation and My Account edits; private receipts stay inaccessible', async () => {
  const f = await fixture(); const foreign = await fixture(); const input = f.input();
  await assert.rejects(create(f.reader, input), { status: 403 }); await noAccount(input.id);
  await withSession(f.reader.token, async (client, identity) => {
    await rejected(client, () => createUser(client, { ...identity, permission_codes: ['users.manage'] }, input), { status: 403 });
    await rejected(client, () => client.query('SELECT * FROM user_creation_commands'), { code: '42501' });
    await client.query("SELECT set_config('app.user_id',$1,true)", [foreign.reader.userId]);
    await rejected(client, () => updateProfile(client, { username: 'forged', displayName: 'Forged', revision: 1 }), { status: 401 });
  });
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE sampleify_report_worker');
    await rejected(client, () => client.query('SELECT * FROM user_creation_commands'), { code: '42501' });
    for (const name of ['users_create_account', 'users_guard_creation_history', 'auth_lock_login_aliases']) {
      assert.equal((await client.query('SELECT has_function_privilege(current_user,oid,\'EXECUTE\') AS allowed FROM pg_proc WHERE pronamespace=\'public\'::regnamespace AND proname=$1', [name])).rows[0].allowed, false);
    }
  } finally { await client.query('ROLLBACK'); client.release(); }
});

async function queuedCreation(f, input, mutate, { aliasLock = false } = {}) {
  const blocker = await owner.connect(); let pending;
  try {
    await blocker.query('BEGIN');
    if (aliasLock) await blocker.query('SELECT auth_lock_login_aliases(ARRAY[$1]::text[])', [input.username]);
    else await blocker.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [f.admin.organizationId]);
    let reportPid; const started = new Promise((resolve) => { reportPid = resolve; });
    pending = withSession(f.admin.token, async (client, identity) => {
      reportPid((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return createUser(client, identity, input);
    }).then((value) => ({ value }), (error) => ({ error }));
    const pid = await started; let waiting = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = (await owner.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
      waiting = state?.wait_event_type === 'Lock' && (!aliasLock || state.wait_event === 'advisory');
      if (waiting) break; await delay(10);
    }
    assert.equal(waiting, true, 'The creation must actually wait for the requested row/alias lock');
    await mutate(blocker); await blocker.query('COMMIT'); return await pending;
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
}

test('session revocation and role retirement during an organization-lock wait prevent creation without orphan records', async () => {
  const f = await fixture(); const input = f.input();
  const revoked = await queuedCreation(f, input, (blocker) => blocker.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(f.admin.token)]));
  assert.equal(revoked.error.status, 403); await noAccount(input.id);
  const other = await fixture(); const role = randomUUID(); await owner.query("INSERT INTO roles(organization_id,id,name) VALUES($1,$2,'Retire before creation')", [other.admin.organizationId, role]);
  const next = other.input({ defaultRoleId: role });
  const retired = await queuedCreation(other, next, async (blocker) => {
    await blocker.query('SET LOCAL ROLE sampleify_app'); const identity = (await blocker.query('SELECT * FROM auth_session_context($1)', [hashToken(other.admin.token)])).rows[0];
    await retireRole(blocker, identity, { id: role, requestId: randomUUID(), revision: 0 });
  });
  assert.equal(retired.error.code, 'invalid_user_roles'); await noAccount(next.id);
});

test('expiry during an actual global-alias wait is revalidated before any new identity is written', async () => {
  const f = await fixture(); const input = f.input();
  await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=$1", [hashToken(f.admin.token)]);
  const result = await queuedCreation(f, input, async () => { await delay(3_100); }, { aliasLock: true });
  assert.equal(result.error.status, 403); await noAccount(input.id);
});
