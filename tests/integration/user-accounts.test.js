import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession, updateProfile, changePassword } from '../../src/auth/service.js';
import { hashToken, newToken } from '../../src/auth/tokens.js';
import { verifyPassword } from '../../src/auth/passwords.js';
import { closePool } from '../../src/db/pool.js';
import { updateUserAccount, loadUserAccount, loadUserAccountHistory } from '../../src/users/accounts.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const account = async (options) => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const command = (person, extra = {}) => ({ requestId: randomUUID(), revision: 1, username: person.username, email: person.email, displayName: 'Changed Analyst', ...extra });
const save = (actor, target, input) => withSession(actor.token, (client, identity) => updateUserAccount(client, identity, target, input));
const read = (actor, target) => withSession(actor.token, (client, identity) => loadUserAccount(client, identity, target), { readOnly: true });
const history = (actor, target, input) => withSession(actor.token, (client, identity) => loadUserAccountHistory(client, identity, target, input), { readOnly: true });
const grant = (actor) => owner.query('INSERT INTO platform_administrators(organization_id,user_id,granted_at,granted_by) VALUES($1,$2,clock_timestamp(),$3)', [actor.organizationId, actor.userId, 'Synthetic test operator']);
async function fixture() {
  const admin = await account({ permissions: ['users.manage', 'roles.manage'] }); const person = await account({ organizationId: admin.organizationId, permissions: ['users.read'] });
  return { admin, person };
}
async function rejected(client, action, expected) {
  await client.query('SAVEPOINT denied'); await assert.rejects(action, expected); await client.query('ROLLBACK TO SAVEPOINT denied'); await client.query('RELEASE SAVEPOINT denied');
}

test('ordinary account identity changes preserve credentials, memberships and actual immutable before/after labels', async () => {
  const { admin, person } = await fixture(); const before = (await owner.query('SELECT * FROM credentials WHERE user_id=$1', [person.userId])).rows[0];
  const membership = (await owner.query('SELECT * FROM memberships WHERE user_id=$1', [person.userId])).rows;
  assert.deepEqual(await history(admin, person.userId), { rows: [], nextBeforeRevision: null });
  assert.equal((await read(admin, person.userId)).canEditIdentity, true); assert.equal((await read(person, person.userId)).canEditIdentity, false);
  const input = command(person, { username: `edited-${person.userId}`, email: `edited-${person.email}`, password: '' });
  assert.deepEqual(await save(admin, person.userId, input), { id: person.userId, revision: 2, passwordChanged: false });
  assert.deepEqual((await owner.query('SELECT * FROM credentials WHERE user_id=$1', [person.userId])).rows[0], before);
  assert.deepEqual((await owner.query('SELECT * FROM memberships WHERE user_id=$1', [person.userId])).rows, membership);
  await withSession(person.token, (_client, identity) => assert.equal(identity.username, input.username));
  const rows = (await history(admin, person.userId)).rows; assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].previousRevision, rows[0].revision, rows[0].previousUsername, rows[0].previousEmail, rows[0].username, rows[0].email], [1, 2, person.username, person.email, input.username, input.email]);
  assert.equal(rows[0].savedBy, admin.userId); assert.equal(rows[0].savedByUsername, admin.username); assert.equal(rows[0].savedByName, 'Synthetic Analyst'); assert(rows[0].savedAt instanceof Date);
  assert.equal(Object.hasOwn(rows[0], 'fingerprint'), false); assert.equal(Object.hasOwn(rows[0], 'credentialRevision'), false);
});

test('shared identities and all platform principals resist ordinary manager takeover; current platform grants and the actual owner retain authority', async () => {
  const { admin, person } = await fixture(); const foreign = await account({ permissions: ['users.manage'] });
  await owner.query('INSERT INTO memberships(organization_id,user_id,active) VALUES($1,$2,false)', [foreign.organizationId, person.userId]);
  assert.equal((await read(admin, person.userId)).canEditIdentity, false);
  await assert.rejects(save(admin, person.userId, command(person)), { code: 'protected_user_identity' });
  await assert.rejects(save(admin, person.userId, command(person, { displayName: 'Synthetic Analyst', password: 'New password!' })), { code: 'protected_user_identity' });
  await save(admin, person.userId, command(person, { displayName: 'Synthetic Analyst' }));
  await grant(admin); assert.equal((await read(admin, person.userId)).canEditIdentity, true);
  await save(admin, person.userId, command(person, { revision: 2 }));
  assert.deepEqual(await history(foreign, person.userId), { rows: [], nextBeforeRevision: null });
  await owner.query('DELETE FROM platform_administrators WHERE user_id=$1', [admin.userId]);
  const privileged = await account({ organizationId: admin.organizationId, permissions: ['users.manage'] }); await grant(privileged);
  await assert.rejects(save(admin, privileged.userId, command(privileged)), { code: 'protected_user_identity' });
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [admin.organizationId, privileged.userId]);
  await assert.rejects(save(admin, privileged.userId, command(privileged)), { code: 'protected_user_identity' });
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, admin.userId]);
  assert.equal((await read(admin, admin.userId)).canEditIdentity, true); await save(admin, admin.userId, command(admin));
});

test('supplied passwords clear the forced-change gate, consume resets and revoke every target membership session while preserving other identities', async () => {
  const { admin, person } = await fixture(); const foreign = await account({ permissions: ['users.manage'] }); await grant(admin);
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, person.userId]);
  const credential = (await owner.query('SELECT * FROM credentials WHERE user_id=$1', [person.userId])).rows[0];
  const token = newToken(); const csrf = newToken();
  assert((await owner.query('SELECT auth_create_session($1,$2,$3,NULL,-1,$4,$5) AS expiry', [person.userId, foreign.organizationId, credential.password_hash, hashToken(token), hashToken(csrf)])).rows[0].expiry);
  await owner.query('INSERT INTO password_resets(user_id,token_hash,credential_revision,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')', [person.userId, hashToken(newToken()), credential.revision]);
  await owner.query('UPDATE users SET must_change_password=true WHERE id=$1', [person.userId]);
  const input = command(person, { password: ' Exact replacement password ' }); await save(admin, person.userId, input);
  const next = (await owner.query('SELECT * FROM credentials WHERE user_id=$1', [person.userId])).rows[0]; assert.equal(next.revision, credential.revision + 1); assert(await verifyPassword(input.password, next.password_hash));
  assert.equal((await owner.query('SELECT must_change_password FROM users WHERE id=$1', [person.userId])).rows[0].must_change_password, false);
  assert.equal((await owner.query('SELECT 1 FROM password_resets WHERE user_id=$1 AND used_at IS NULL', [person.userId])).rowCount, 0);
  for (const old of [person.token, token]) await assert.rejects(withSession(old, () => {}), { status: 401 });
  await withSession(admin.token, () => {}); await withSession(foreign.token, () => {});
  assert((await signIn({ identifier: person.username, password: input.password })).token);
  assert.equal((await history(admin, person.userId)).rows[0].passwordChanged, true);
  assert.equal((await owner.query("SELECT count(*)::integer AS count FROM account_events WHERE user_id=$1 AND kind='sign_out'", [person.userId])).rows[0].count, 0);
});

test('self administrative password changes end the current session; a fresh session can replay without revoking itself', async () => {
  const { admin } = await fixture(); const input = command(admin, { password: 'New administrator password' });
  const first = await save(admin, admin.userId, input); await assert.rejects(withSession(admin.token, () => {}), { status: 401 });
  const fresh = { ...admin, ...await signIn({ identifier: admin.username, password: input.password }) };
  assert.deepEqual(await save(fresh, admin.userId, input), first); await withSession(fresh.token, () => {});
});

test('exact account retries preserve later My Account identity and password changes; changed requests and actors are rejected', async () => {
  const { admin, person } = await fixture(); const input = command(person, { password: 'First replacement password' });
  const first = await save(admin, person.userId, input); const current = await signIn({ identifier: person.username, password: input.password });
  await withSession(current.token, client => updateProfile(client, { username: `later-${person.userId}`, displayName: 'Later owner name', revision: 2 }), { accountAction: true });
  await withSession(current.token, client => changePassword(client, { currentPassword: input.password, newPassword: 'Later owner password', confirmPassword: 'Later owner password' }), { accountAction: true });
  assert.deepEqual(await save(admin, person.userId, input), first); assert.equal((await read(admin, person.userId)).revision, 4);
  await withSession(current.token, () => {}); assert((await signIn({ identifier: `later-${person.userId}`, password: 'Later owner password' })).token);
  for (const change of [{ password: 'Different password' }, { password: '' }, { revision: 2 }, { displayName: 'Changed again' }]) await assert.rejects(save(admin, person.userId, { ...input, ...change }), { code: 'save_request_reused' });
  const another = await account({ organizationId: admin.organizationId, permissions: ['users.manage'] });
  await assert.rejects(save(another, person.userId, input), { code: 'save_request_reused' });
  await assert.rejects(save(admin, person.userId, command(person)), { code: 'stale_user_account' });
  assert.equal((await history(admin, person.userId)).rows.length, 1);
});

test('identity aliases reject every username/email collision direction and preserve unchanged imported ambiguous emails', async () => {
  const { admin, person } = await fixture(); const foreign = await account({ email: 'shared-legacy@example.invalid' });
  await owner.query('UPDATE users SET username=$2 WHERE id=$1', [foreign.userId, `alias-${foreign.userId}@example.invalid`]);
  const foreignUsername = `alias-${foreign.userId}@example.invalid`;
  for (const changes of [{ username: foreignUsername.toUpperCase() }, { username: foreign.email.toUpperCase() }, { email: foreignUsername.toUpperCase() }, { email: foreign.email.toUpperCase() }]) {
    await assert.rejects(save(admin, person.userId, command(person, changes)), { code: 'sign_in_identifier_taken' });
  }
  await owner.query('UPDATE users SET email=$2 WHERE id=$1', [person.userId, foreign.email]);
  await save(admin, person.userId, command(person, { email: foreign.email }));
  assert.equal((await read(admin, person.userId)).email, foreign.email);
});

test('concurrent account commands have one result for exact retries and one winner for competing revisions', async () => {
  const { admin, person } = await fixture(); const input = command(person, { password: 'Concurrent password change' });
  const results = await Promise.all([save(admin, person.userId, input), save(admin, person.userId, input)]); assert.deepEqual(results[0], results[1]);
  const competing = await Promise.allSettled([save(admin, person.userId, command(person, { revision: 2 })), save(admin, person.userId, command(person, { revision: 2, displayName: 'Competing name' }))]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1); assert.equal(competing.find(result => result.status === 'rejected').reason.code, 'stale_user_account');
  assert.equal((await history(admin, person.userId)).rows.length, 2);
});

test('account history uses stable revision pagination and freezes labels across later editor changes', async () => {
  const { admin, person } = await fixture();
  for (let revision = 1; revision <= 4; revision++) await save(admin, person.userId, command(person, { revision, displayName: `Name ${revision}` }));
  await withSession(admin.token, client => updateProfile(client, { username: `renamed-${admin.userId}`, displayName: 'Renamed editor', revision: 1 }), { accountAction: true });
  const first = await history(admin, person.userId, { limit: 2 }); const second = await history(admin, person.userId, { limit: 2, beforeRevision: first.nextBeforeRevision });
  assert.deepEqual(first.rows.map(row => row.revision), [5, 4]); assert.deepEqual(second.rows.map(row => row.revision), [3, 2]); assert.equal(second.nextBeforeRevision, null);
  assert(first.rows.every(row => row.savedByUsername === admin.username && row.savedByName === 'Synthetic Analyst'));
  for (const input of [{ limit: 0 }, { beforeRevision: 0 }, { limit: 101 }, { unknown: true }]) await assert.rejects(history(admin, person.userId, input), { status: 400 });
});

test('actual permission, tenant, session and worker boundaries protect account commands, platform grants and history', async () => {
  const { admin, person } = await fixture(); const foreign = await account({ permissions: ['users.manage'] }); await grant(admin);
  await assert.rejects(read(foreign, person.userId), { status: 404 }); await assert.rejects(save(foreign, person.userId, command(person)), { status: 404 });
  await withSession(person.token, async (client, identity) => {
    assert.equal((await client.query('SELECT auth_is_platform_administrator() AS granted')).rows[0].granted, false);
    await rejected(client, () => updateUserAccount(client, { ...identity, permission_codes: ['users.manage'], isPlatformAdministrator: true }, person.userId, command(person)), { status: 403 });
    for (const query of ['SELECT * FROM platform_administrators', 'DELETE FROM platform_administrators', 'SELECT * FROM user_account_commands', 'UPDATE users SET display_name=\'Forged\'', 'DELETE FROM user_account_history']) {
      await rejected(client, () => client.query(query), { code: '42501' });
    }
    await client.query("SELECT set_config('app.user_id',$1,true)", [admin.userId]);
    assert.equal((await client.query('SELECT auth_is_platform_administrator() AS granted')).rows[0].granted, false);
  });
  await save(admin, person.userId, command(person));
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    for (const query of ['DELETE FROM user_account_commands WHERE user_id=$1', 'UPDATE user_account_commands SET display_name=\'Forged\' WHERE user_id=$1']) await rejected(client, () => client.query(query, [person.userId]), { code: '55000' });
    await client.query('SET LOCAL ROLE sampleify_report_worker');
    for (const query of ['SELECT * FROM user_account_history', 'SELECT * FROM user_account_heads', 'SELECT * FROM platform_administrators', 'SELECT auth_is_platform_administrator()']) await rejected(client, () => client.query(query), { code: '42501' });
  } finally { await client.query('ROLLBACK'); client.release(); }
});

async function queuedSave(f, mutate, { password = false } = {}) {
  const blocker = await owner.connect(); let pending;
  try {
    await blocker.query('BEGIN'); const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    if (password) await blocker.query('SELECT id FROM sessions WHERE token_hash=$1 FOR UPDATE', [hashToken(f.person.token)]);
    else await blocker.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [f.admin.organizationId]);
    pending = save(f.admin, f.person.userId, command(f.person, password ? { password: 'Queued replacement password' } : {})).then(value => ({ value }), error => ({ error }));
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = (await owner.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting;
      if (waiting) break; await delay(10);
    }
    assert(waiting, 'Account command must actually wait on the locked row'); await mutate(blocker); await blocker.query('COMMIT');
    const result = await pending; assert(result.error); assert.equal(result.error.status, 403);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
  assert.equal((await owner.query('SELECT revision FROM users WHERE id=$1', [f.person.userId])).rows[0].revision, 1);
  assert.equal((await owner.query('SELECT 1 FROM user_account_commands WHERE user_id=$1', [f.person.userId])).rowCount, 0);
}

test('revocation and permission loss during an actual organization lock wait reject account changes', async () => {
  let f = await fixture(); await queuedSave(f, client => client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [hashToken(f.admin.token)]));
  f = await fixture(); await queuedSave(f, client => client.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='users.manage'", [f.admin.organizationId, f.admin.roleId]));
});

test('session expiry during a target-session lock wait prevents password, reset and identity changes', async () => {
  const f = await fixture(); await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE token_hash=$1", [hashToken(f.admin.token)]);
  const before = (await owner.query('SELECT * FROM credentials WHERE user_id=$1', [f.person.userId])).rows[0];
  await queuedSave(f, () => delay(850), { password: true });
  assert.deepEqual((await owner.query('SELECT * FROM credentials WHERE user_id=$1', [f.person.userId])).rows[0], before);
});

test('a new membership or platform grant committed during the global user lock wait prevents an ordinary manager takeover', async () => {
  for (const kind of ['membership', 'platform']) {
    const f = await fixture(); const foreign = await account(); const blocker = await owner.connect(); let pending;
    try {
      await blocker.query('BEGIN'); const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      if (kind === 'membership') await blocker.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, f.person.userId]);
      else await blocker.query('INSERT INTO platform_administrators(organization_id,user_id,granted_at,granted_by) VALUES($1,$2,clock_timestamp(),$3)', [f.admin.organizationId, f.person.userId, 'Synthetic concurrent operator']);
      pending = save(f.admin, f.person.userId, command(f.person)).then(value => ({ value }), error => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting = (await owner.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting;
        if (waiting) break; await delay(10);
      }
      assert(waiting, `Account command must wait for the new ${kind}'s user foreign key`); await blocker.query('COMMIT');
      assert.equal((await pending).error?.code, 'protected_user_identity');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
    assert.equal((await read(f.admin, f.person.userId)).revision, 1); assert.equal((await history(f.admin, f.person.userId)).rows.length, 0);
  }
});

test('platform authority is tied to the actual current membership and rechecked after revocation while a command waits', async () => {
  const f = await fixture(); const foreign = await account();
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2),($1,$3)', [foreign.organizationId, f.admin.userId, f.person.userId]);
  await owner.query('INSERT INTO platform_administrators(organization_id,user_id,granted_at,granted_by) VALUES($1,$2,clock_timestamp(),$3)', [foreign.organizationId, f.admin.userId, 'Synthetic foreign grant operator']);
  await assert.rejects(save(f.admin, f.person.userId, command(f.person)), { code: 'protected_user_identity' });
  await grant(f.admin);
  await queuedSave(f, client => client.query('DELETE FROM platform_administrators WHERE organization_id=$1 AND user_id=$2', [f.admin.organizationId, f.admin.userId]));
});
