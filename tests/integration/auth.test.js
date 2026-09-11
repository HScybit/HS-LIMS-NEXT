import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getPool, closePool } from '../../src/db/pool.js';
import { signIn, withSession, updateProfile, changePassword, requestPasswordReset, completePasswordReset } from '../../src/auth/service.js';
import { hashToken } from '../../src/auth/tokens.js';
import { encryptSecret, totpAt } from '../../src/auth/totp.js';
import { ownerPool, createAccount } from '../helpers/database.js';

const owner = ownerPool();
const login = (account, extra = {}) => signIn({ identifier: account.username, password: account.password, ...extra });
const identity = (session) => withSession(session.token, (_client, value) => value, { readOnly: true, accountAction: true });
after(async () => { await closePool(); await owner.end(); });

test('application role is non-owner, cannot read credentials and sees no tenant without context', async () => {
  const result = await getPool().query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(result.rows[0], { rolsuper: false, rolbypassrls: false });
  await assert.rejects(getPool().query('SELECT * FROM credentials'), { code: '42501' });
  await assert.rejects(getPool().query('SELECT * FROM sessions'), { code: '42501' });
  assert.equal((await getPool().query('SELECT * FROM organizations')).rowCount, 0);
  const jsonColumns = await owner.query("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')");
  assert.equal(jsonColumns.rowCount, 0);
});

test('real sign-in resolves identity, permissions and only its tenant; context clears on pool reuse', async () => {
  const account = await createAccount(owner);
  const other = await createAccount(owner);
  const session = await login(account);
  const value = await identity(session);
  assert.equal(value.user_id, account.userId);
  assert.deepEqual(value.permission_codes, ['templates.read']);
  await withSession(session.token, async (client) => {
    assert.equal((await client.query('SELECT * FROM organizations')).rowCount, 1);
    assert.equal((await client.query('SELECT * FROM memberships WHERE organization_id = $1', [other.organizationId])).rowCount, 0);
  }, { permission: 'templates.read', readOnly: true });
  assert.equal((await getPool().query('SELECT * FROM organizations')).rowCount, 0);
  const stored = (await owner.query('SELECT token_hash, csrf_hash FROM sessions WHERE token_hash = $1', [hashToken(session.token)])).rows[0];
  assert.notEqual(stored.token_hash, session.token);
  assert.notEqual(stored.csrf_hash, session.csrfToken);
});

test('CSRF and permission checks apply to direct services', async () => {
  const session = await login(await createAccount(owner));
  await assert.rejects(withSession(session.token, () => null, { csrfToken: 'wrong' }), { status: 403, code: 'invalid_csrf' });
  await assert.rejects(withSession(session.token, () => null, { permission: 'templates.manage' }), { status: 403, code: 'forbidden' });
});

test('cross-tenant role references fail at the composite foreign key', async () => {
  const first = await createAccount(owner);
  const second = await createAccount(owner);
  await assert.rejects(owner.query('INSERT INTO membership_roles(organization_id, user_id, role_id) VALUES($1, $2, $3)', [first.organizationId, first.userId, second.roleId]), { code: '23503' });
});

test('ambiguous email and ambiguous membership do not select an arbitrary identity or tenant', async () => {
  const email = `shared-${randomUUID()}@example.invalid`;
  const first = await createAccount(owner, { email, isDefault: false });
  const second = await createAccount(owner, { email });
  await assert.rejects(signIn({ identifier: email, password: first.password }), { code: 'invalid_credentials' });
  await owner.query('INSERT INTO memberships(organization_id, user_id) VALUES($1, $2)', [second.organizationId, first.userId]);
  await assert.rejects(login(first), { code: 'invalid_credentials' });
  await owner.query('UPDATE memberships SET is_default = true WHERE organization_id = $1 AND user_id = $2', [first.organizationId, first.userId]);
  assert.equal((await identity(await login(first))).organization_id, first.organizationId);
});

test('disabled membership, user, organization and expired or revoked sessions stop authenticating', async () => {
  for (const target of ['membership', 'user', 'organization', 'expired', 'revoked']) {
    const account = await createAccount(owner);
    const session = await login(account);
    if (target === 'membership') await owner.query('UPDATE memberships SET active = false WHERE user_id = $1', [account.userId]);
    if (target === 'user') await owner.query('UPDATE users SET active = false WHERE id = $1', [account.userId]);
    if (target === 'organization') await owner.query('UPDATE organizations SET active = false WHERE id = $1', [account.organizationId]);
    if (target === 'expired') await owner.query("UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE user_id = $1", [account.userId]);
    if (target === 'revoked') await withSession(session.token, (client) => client.query('SELECT auth_revoke_session()'));
    await assert.rejects(identity(session), { status: 401 });
  }
});

test('concurrent attempts reserve an atomic rate limit before expensive verification', async () => {
  const identifier = `missing-${randomUUID()}`;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => signIn({ identifier, password: 'wrong synthetic password' })));
  assert.equal(results.filter((result) => result.reason?.status === 429).length, 3);
  assert.equal(results.filter((result) => result.reason?.status === 401).length, 5);
});

test('the five-session cap revokes the oldest sign-in without revoking the newest', async () => {
  const account = await createAccount(owner);
  const sessions = [];
  for (let index = 0; index < 6; index += 1) sessions.push(await login(account));
  await assert.rejects(identity(sessions[0]), { status: 401 });
  for (const session of sessions.slice(1)) assert.equal((await identity(session)).user_id, account.userId);
  const result = await owner.query('SELECT count(*)::integer AS active FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [account.userId]);
  assert.equal(result.rows[0].active, 5);
});

test('profile revisions reject concurrent lost updates and record one successful change', async () => {
  const account = await createAccount(owner);
  const session = await login(account);
  const results = await Promise.allSettled(['First', 'Second'].map((displayName) => withSession(session.token,
    (client) => updateProfile(client, { displayName, username: account.username, revision: 1 }), { csrfToken: session.csrfToken })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.reason?.code === 'stale_profile').length, 1);
  assert.equal((await owner.query("SELECT * FROM account_events WHERE user_id = $1 AND kind = 'profile_changed'", [account.userId])).rowCount, 1);
});

test('profile edits cannot shadow another account email or silently overwrite its identity', async () => {
  const account = await createAccount(owner);
  const other = await createAccount(owner);
  const session = await login(account);
  await assert.rejects(withSession(session.token, (client) => updateProfile(client, {
    displayName: 'Collision attempt', username: other.email, revision: 1,
  })), { code: 'username_taken' });
  assert.equal((await identity(session)).username, account.username);
  assert.ok(await login(other, { identifier: other.email }));
});

test('forced password change blocks domain access and preserves current session while revoking others', async () => {
  const account = await createAccount(owner, { mustChangePassword: true });
  const session = await login(account);
  const otherSession = await login(account);
  await assert.rejects(withSession(session.token, () => null, { permission: 'templates.read' }), { code: 'password_change_required' });
  await assert.rejects(withSession(session.token, (client) => changePassword(client, { currentPassword: 'wrong', newPassword: 'New-Password-Test!', confirmPassword: 'New-Password-Test!' }), { accountAction: true }), { code: 'invalid_password' });
  await withSession(session.token, (client) => changePassword(client, { currentPassword: account.password, newPassword: 'New-Password-Test!', confirmPassword: 'New-Password-Test!' }), { csrfToken: session.csrfToken, accountAction: true });
  assert.equal((await identity(session)).must_change_password, false);
  await assert.rejects(identity(otherSession), { status: 401 });
  await assert.rejects(login(account), { status: 401 });
  assert.ok(await login(account, { password: 'New-Password-Test!' }));
});

test('reset delivery is local, token is single use under concurrency and old sessions are revoked', async () => {
  const account = await createAccount(owner);
  const session = await login(account);
  assert.equal(await requestPasswordReset({ email: `missing-${randomUUID()}@example.invalid` }), undefined);
  await requestPasswordReset({ email: account.email });
  const reset = (await owner.query('SELECT id, token_hash FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [account.userId])).rows[0];
  const mail = await readFile(`.local/mail/${reset.id}.txt`, 'utf8');
  const token = /token=([\w-]+)/.exec(mail)[1];
  assert.equal(hashToken(token), reset.token_hash);
  const input = { token, newPassword: 'Reset-Synthetic-Password!', confirmPassword: 'Reset-Synthetic-Password!' };
  const results = await Promise.allSettled([completePasswordReset(input), completePasswordReset(input)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.reason?.code === 'invalid_reset').length, 1);
  await assert.rejects(identity(session), { status: 401 });
  assert.ok(await login(account, { password: input.newPassword }));
});

test('MFA requires a valid code and prevents reuse of a successfully consumed time step', async () => {
  const account = await createAccount(owner);
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  await owner.query('INSERT INTO user_mfa(user_id, encrypted_secret, enabled) VALUES($1, $2, true)', [account.userId, encryptSecret(secret)]);
  await assert.rejects(login(account), { code: 'mfa_required' });
  await assert.rejects(login(account, { mfaCode: 'bad' }), { code: 'invalid_credentials' });
  const mfaCode = totpAt(secret, Date.now());
  assert.ok(await login(account, { mfaCode }));
  await assert.rejects(login(account, { mfaCode }), { code: 'invalid_credentials' });
});
