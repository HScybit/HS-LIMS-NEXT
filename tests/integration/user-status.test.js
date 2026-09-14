import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession, updateProfile } from '../../src/auth/service.js';
import { hashToken, newToken } from '../../src/auth/tokens.js';
import { closePool } from '../../src/db/pool.js';
import { updateUserStatus, loadUserStatus, loadUserStatusHistory } from '../../src/users/status.js';
import { loadUser } from '../../src/users/directory.js';
import { updateRole } from '../../src/roles/service.js';
import { updateUserProfile } from '../../src/users/profiles.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const account = async (options) => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const command = (revision = 0, membershipActive = false) => ({ requestId: randomUUID(), revision, membershipActive });
const save = (actor, target, input) => withSession(actor.token, (client, identity) => updateUserStatus(client, identity, target, input));
const read = (actor, target) => withSession(actor.token, (client, identity) => loadUserStatus(client, identity, target), { readOnly: true });
const history = (actor, target, input) => withSession(actor.token, (client, identity) => loadUserStatusHistory(client, identity, target, input), { readOnly: true });
const directory = (actor, target) => withSession(actor.token, (client, identity) => loadUser(client, identity, target), { readOnly: true });
async function fixture() {
  const admin = await account({ permissions: ['users.manage', 'roles.manage'] });
  const person = await account({ organizationId: admin.organizationId, permissions: ['users.read'] });
  return { admin, person };
}
async function rejected(client, action, expected) {
  await client.query('SAVEPOINT denied'); await assert.rejects(action, expected); await client.query('ROLLBACK TO SAVEPOINT denied'); await client.query('RELEASE SAVEPOINT denied');
}

test('deactivation is membership-specific, records actual transitions and never revives old sessions or invents logout', async () => {
  const { admin, person } = await fixture(); const before = await directory(admin, person.userId);
  assert.deepEqual(await read(admin, person.userId), { id: person.userId, revision: 0, membershipActive: true, identityActive: true, active: true });
  assert.deepEqual(await history(admin, person.userId), { rows: [], nextBeforeRevision: null });
  const identityBefore = (await owner.query('SELECT * FROM users WHERE id=$1', [person.userId])).rows[0];
  const credentialsBefore = (await owner.query('SELECT * FROM credentials WHERE user_id=$1', [person.userId])).rows[0];
  const rolesBefore = (await owner.query('SELECT * FROM membership_roles WHERE organization_id=$1 AND user_id=$2', [admin.organizationId, person.userId])).rows;
  const off = command(); assert.deepEqual(await save(admin, person.userId, off), { id: person.userId, revision: 1, membershipActive: false });
  await assert.rejects(withSession(person.token, () => {}), { status: 401 });
  await assert.rejects(signIn({ identifier: person.username, password: person.password }), { code: 'invalid_credentials' });
  assert.deepEqual(await read(admin, person.userId), { id: person.userId, revision: 1, membershipActive: false, identityActive: true, active: false });
  const disabled = await directory(admin, person.userId); assert.equal(disabled.statusRevision, 1); assert.equal(disabled.membershipActive, false);
  assert.equal(disabled.lastLogoutAt, before.lastLogoutAt); assert.deepEqual(disabled.lastLoginAt, before.lastLoginAt);
  assert.deepEqual((await owner.query('SELECT * FROM users WHERE id=$1', [person.userId])).rows[0], identityBefore);
  assert.equal(JSON.stringify((await owner.query('SELECT * FROM credentials WHERE user_id=$1', [person.userId])).rows[0]) === JSON.stringify(credentialsBefore), true, 'Status must not change credentials');
  assert.deepEqual((await owner.query('SELECT * FROM membership_roles WHERE organization_id=$1 AND user_id=$2', [admin.organizationId, person.userId])).rows, rolesBefore);
  await save(admin, person.userId, command(1, true));
  await assert.rejects(withSession(person.token, () => {}), { status: 401 });
  const freshSession = await signIn({ identifier: person.username, password: person.password });
  await withSession(freshSession.token, (_client, identity) => assert.equal(identity.user_id, person.userId));
  const versions = await history(admin, person.userId);
  assert.deepEqual(versions.rows.map((row) => [row.revision, row.previousRevision, row.membershipActive, row.previousMembershipActive]), [[2, 1, true, false], [1, 0, false, true]]);
  assert(versions.rows.every((row) => row.savedBy === admin.userId && row.savedByUsername === admin.username && row.username === person.username && row.savedAt instanceof Date));
});

test('shared identities keep other-organization sessions and availability, including the separate global gate', async () => {
  const { admin, person } = await fixture(); const foreign = await account({ permissions: ['users.manage'] });
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, person.userId]);
  await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) VALUES($1,$2,$3)', [foreign.organizationId, person.userId, foreign.roleId]);
  const credential = (await owner.query('SELECT password_hash FROM credentials WHERE user_id=$1', [person.userId])).rows[0].password_hash;
  const token = newToken(); const csrfToken = newToken();
  assert((await owner.query('SELECT auth_create_session($1,$2,$3,NULL,-1,$4,$5) AS expiry', [person.userId, foreign.organizationId, credential, hashToken(token), hashToken(csrfToken)])).rows[0].expiry);
  await save(admin, person.userId, command());
  await withSession(token, (_client, identity) => assert.equal(identity.organization_id, foreign.organizationId));
  assert.deepEqual(await read(foreign, person.userId), { id: person.userId, revision: 0, membershipActive: true, identityActive: true, active: true });
  assert.deepEqual(await history(foreign, person.userId), { rows: [], nextBeforeRevision: null });
  await owner.query('UPDATE users SET active=false,revision=revision+1 WHERE id=$1', [person.userId]);
  await save(admin, person.userId, command(1, true));
  assert.deepEqual(await read(admin, person.userId), { id: person.userId, revision: 2, membershipActive: true, identityActive: false, active: false });
  await assert.rejects(withSession(token, () => {}), { status: 401 });
  assert.equal((await owner.query('SELECT revoked_at FROM sessions WHERE token_hash=$1', [hashToken(token)])).rows[0].revoked_at, null);
});

test('exact retries survive later transitions and identity edits; changed, stale and unchanged commands add no events', async () => {
  const { admin, person } = await fixture(); const off = command(); const first = await save(admin, person.userId, off);
  await save(admin, person.userId, command(1, true));
  const fresh = await signIn({ identifier: person.username, password: person.password });
  await withSession(fresh.token, (client) => updateProfile(client, { username: `later-${person.userId}`, displayName: 'Later person', revision: 1 }), { accountAction: true });
  await withSession(admin.token, (client) => updateProfile(client, { username: `later-${admin.userId}`, displayName: 'Later administrator', revision: 1 }), { accountAction: true });
  assert.deepEqual(await save(admin, person.userId, off), first); assert.equal((await read(admin, person.userId)).membershipActive, true);
  for (const input of [{ ...off, membershipActive: true }, { ...off, revision: 1 }]) await assert.rejects(save(admin, person.userId, input), { code: 'save_request_reused' });
  const another = await account({ organizationId: admin.organizationId, permissions: ['users.manage'] });
  await assert.rejects(save(another, person.userId, off), { code: 'save_request_reused' });
  await assert.rejects(save(admin, another.userId, off), { code: 'save_request_reused' });
  await assert.rejects(save(admin, person.userId, command(0)), { code: 'stale_user_status' });
  await assert.rejects(save(admin, person.userId, command(2, true)), { code: 'user_status_unchanged' });
  const versions = await history(admin, person.userId); assert.equal(versions.rows.length, 2);
  assert.equal(versions.rows[0].username, person.username); assert.equal(versions.rows[0].savedByUsername, admin.username); assert.equal(versions.rows[0].savedByName, 'Synthetic Analyst');
  await save(admin, person.userId, command(2));
  const latest = (await history(admin, person.userId)).rows[0]; assert.equal(latest.username, `later-${person.userId}`); assert.equal(latest.savedByName, 'Later administrator');
});

test('concurrent exact commands create one version; competing request identities have one winner', async () => {
  const { admin, person } = await fixture(); const off = command();
  const results = await Promise.all([save(admin, person.userId, off), save(admin, person.userId, off)]); assert.deepEqual(results[0], results[1]);
  assert.equal((await history(admin, person.userId)).rows.length, 1);
  const attempts = await Promise.allSettled([save(admin, person.userId, command(1, true)), save(admin, person.userId, command(1, true))]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.code, 'stale_user_status');
  assert.equal((await history(admin, person.userId)).rows.length, 2);
});

test('self-disable and disabling the last role administrator are rejected, including concurrent role and profile edits', async () => {
  const { admin, person } = await fixture(); await assert.rejects(save(admin, admin.userId, command()), { code: 'cannot_disable_self' });
  const userManager = await account({ organizationId: admin.organizationId, permissions: ['users.manage'] });
  await assert.rejects(save(userManager, admin.userId, command()), { code: 'last_user_administrator' });
  const target = await account({ organizationId: admin.organizationId, permissions: ['roles.manage'] });
  const attempts = await Promise.allSettled([
    save(admin, target.userId, command()),
    withSession(admin.token, (client, identity) => updateRole(client, identity, { id: admin.roleId, requestId: randomUUID(), revision: 0,
      name: `Reader ${admin.roleId}`, permissionCodes: ['users.manage'] })),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.status, 409);
  const other = await fixture(); const otherTarget = await account({ organizationId: other.admin.organizationId, permissions: ['roles.manage'] }); const lab = randomUUID();
  const observer = await account({ organizationId: other.admin.organizationId, permissions: ['users.manage'] });
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Status concurrency lab')", [other.admin.organizationId, lab]);
  const profileAttempts = await Promise.allSettled([
    save(observer, otherTarget.userId, command()),
    withSession(other.admin.token, (client, identity) => updateUserProfile(client, identity, other.admin.userId, { requestId: randomUUID(), revision: 0,
      defaultRoleId: other.person.roleId, laboratoryId: lab, roleIds: [other.person.roleId] })),
  ]);
  assert.equal(profileAttempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(profileAttempts.find((result) => result.status === 'rejected').reason.code, 'last_user_administrator');
  assert.equal((await read(admin, person.userId)).revision, 0);
});

test('history pages remain stable through later transitions and reject invalid limits/cursors', async () => {
  const { admin, person } = await fixture();
  for (let revision = 0; revision < 5; revision++) await save(admin, person.userId, command(revision, revision % 2 === 1));
  const first = await history(admin, person.userId, { limit: 2 }); assert.deepEqual(first.rows.map((row) => row.revision), [5, 4]); assert.equal(first.nextBeforeRevision, 4);
  await save(admin, person.userId, command(5, true));
  const next = await history(admin, person.userId, { limit: 2, beforeRevision: first.nextBeforeRevision }); assert.deepEqual(next.rows.map((row) => row.revision), [3, 2]);
  const end = await history(admin, person.userId, { limit: 2, beforeRevision: next.nextBeforeRevision }); assert.deepEqual(end.rows.map((row) => row.revision), [1]); assert.equal(end.nextBeforeRevision, null);
  for (const input of [{ limit: 0 }, { limit: 101 }, { limit: '25' }, { beforeRevision: 0 }, { beforeRevision: -1 }, { beforeRevision: 1.5 }, { offset: 1 }]) {
    await assert.rejects(history(admin, person.userId, input), { status: 400 });
  }
});

test('raw membership/history edits, readers, foreign scope, forged session actors and workers cannot bypass the command', async () => {
  const { admin, person } = await fixture(); const reader = await account({ organizationId: admin.organizationId, permissions: ['users.read'] }); const foreign = await fixture();
  await assert.rejects(save(reader, person.userId, command()), { status: 403 });
  await assert.rejects(save(admin, foreign.person.userId, command()), { status: 404 });
  await assert.rejects(read(admin, foreign.person.userId), { status: 404 });
  await assert.rejects(history(admin, foreign.person.userId), { status: 404 });
  await withSession(reader.token, async (client, identity) => {
    await rejected(client, () => updateUserStatus(client, { ...identity, permission_codes: ['users.manage'] }, person.userId, command()), { status: 403 });
    for (const query of ['SELECT * FROM user_status_versions', 'UPDATE memberships SET active=false', 'DELETE FROM user_status_history']) await rejected(client, () => client.query(query), { code: '42501' });
    await client.query("SELECT set_config('app.user_id',$1,true)", [admin.userId]);
    await rejected(client, () => updateUserStatus(client, { ...identity, permission_codes: ['users.manage'] }, person.userId, command()), { status: 403 });
  });
  await save(admin, person.userId, command());
  assert.equal((await history(reader, person.userId)).rows.length, 1);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    for (const query of ['UPDATE user_status_versions SET saved_at=now()', 'DELETE FROM user_status_versions']) await rejected(client, () => client.query(query), { code: '55000' });
    await rejected(client, () => client.query('UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2', [admin.organizationId, person.userId]), { code: '23514' });
    await client.query('SELECT * FROM auth_session_context($1)', [hashToken(admin.token)]);
    await rejected(client, async () => {
      await client.query('UPDATE memberships SET active=true,status_revision=2 WHERE organization_id=$1 AND user_id=$2', [admin.organizationId, person.userId]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    }, { code: '23514' });
    await client.query('SET LOCAL ROLE sampleify_report_worker');
    await rejected(client, () => client.query('SELECT users_write_status($1,1,$2,true)', [person.userId, randomUUID()]), { code: '42501' });
    await rejected(client, () => client.query('SELECT * FROM user_status_history'), { code: '42501' });
  } finally { await client.query('ROLLBACK'); client.release(); }
});

async function queuedStatus(f, mutate, { targetSessionLock = false } = {}) {
  const blocker = await owner.connect(); let pending;
  try {
    await blocker.query('BEGIN');
    if (targetSessionLock) await blocker.query('SELECT id FROM sessions WHERE token_hash=$1 FOR UPDATE', [hashToken(f.person.token)]);
    else await blocker.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [f.admin.organizationId]);
    let reportPid; const started = new Promise((resolve) => { reportPid = resolve; });
    pending = withSession(f.admin.token, async (client, identity) => {
      reportPid((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return updateUserStatus(client, identity, f.person.userId, command());
    }).then((value) => ({ value }), (error) => ({ error }));
    const pid = await started; let waiting = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      waiting = (await owner.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock';
      if (waiting) break; await delay(10);
    }
    assert.equal(waiting, true, 'Status command must actually wait on the held row');
    await mutate(blocker); await blocker.query('COMMIT'); return await pending;
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
}

test('session revocation and lost permissions during an organization lock wait reject the entire status change', async () => {
  for (const invalidation of ['session', 'permission']) {
    const f = await fixture();
    const result = await queuedStatus(f, (blocker) => invalidation === 'session'
      ? blocker.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(f.admin.token)])
      : blocker.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='users.manage'", [f.admin.organizationId, f.admin.roleId]));
    assert.equal(result.error.status, 403);
    const member = (await owner.query('SELECT active,status_revision FROM memberships WHERE organization_id=$1 AND user_id=$2', [f.admin.organizationId, f.person.userId])).rows[0];
    assert.deepEqual(member, { active: true, status_revision: 0 });
    assert.equal((await owner.query('SELECT 1 FROM user_status_versions WHERE user_id=$1', [f.person.userId])).rowCount, 0);
    await withSession(f.person.token, (_client, identity) => assert.equal(identity.user_id, f.person.userId));
  }
});

test('expiry while waiting to revoke a target session rolls back the provisional status and revocations', async () => {
  const f = await fixture(); await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=$1", [hashToken(f.admin.token)]);
  const result = await queuedStatus(f, () => delay(3_100), { targetSessionLock: true }); assert.equal(result.error.status, 403);
  assert.equal((await owner.query('SELECT status_revision FROM memberships WHERE organization_id=$1 AND user_id=$2', [f.admin.organizationId, f.person.userId])).rows[0].status_revision, 0);
  assert.equal((await owner.query('SELECT 1 FROM user_status_versions WHERE user_id=$1', [f.person.userId])).rowCount, 0);
  await withSession(f.person.token, (_client, identity) => assert.equal(identity.user_id, f.person.userId));
});
