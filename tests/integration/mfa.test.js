import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../helpers/database.js';
import { getPool, closePool } from '../../src/db/pool.js';
import { signIn, withSession, changePassword } from '../../src/auth/service.js';
import { loadMfaStatus, startMfaSetup, cancelMfaSetup, verifyMfaSetup, disableMfa } from '../../src/auth/mfa.js';
import { decryptSecret, totpAt, verifiedTotpStep } from '../../src/auth/totp.js';
import { hashToken } from '../../src/auth/tokens.js';

const owner = ownerPool();
const login = (account, extra = {}) => signIn({ identifier: account.username, password: account.password, ...extra });
const own = (session, work) => withSession(session.token, work, { csrfToken: session.csrfToken, accountAction: true });
const status = (session) => own(session, loadMfaStatus);
const start = (session) => own(session, startMfaSetup);
const cancel = (session, setup) => own(session, (client) => cancelMfaSetup(client, setup));
const disable = (session, input) => own(session, (client) => disableMfa(client, input));
async function verify(session, input) {
  const result = await own(session, (client, identity) => verifyMfaSetup(client, identity, input));
  if (result.error) throw result.error;
  return result;
}
async function fixture() {
  const account = await createAccount(owner, { permissions: [] });
  return { account, session: await login(account) };
}
const codeFor = (setup) => ({ setupId: setup.setupId, code: totpAt(setup.secret, Date.now()) });
const events = async (account) => (await owner.query("SELECT kind FROM account_events WHERE user_id=$1 AND kind IN ('mfa_enabled','mfa_disabled') ORDER BY occurred_at,id", [account.userId])).rows;
after(async () => { await closePool(); await owner.end(); });

test('MFA setup stays private, encrypted, session-bound and disabled until verification; a repeated start keeps its QR/key/expiry', async () => {
  const { account, session } = await fixture();
  assert.deepEqual(await status(session), { enabled: false, revision: 0 });
  const setup = await start(session);
  assert.deepEqual(await start(session), setup);
  const stored = (await owner.query('SELECT p.* FROM user_mfa_setups p JOIN sessions s ON s.id=p.session_id WHERE s.user_id=$1', [account.userId])).rows[0];
  assert.notEqual(stored.encrypted_secret, setup.secret);
  assert.equal(decryptSecret(stored.encrypted_secret), setup.secret);
  assert.equal(stored.expires_at - stored.created_at, 600_000);
  const uri = new URL(setup.uri);
  assert.equal(uri.searchParams.get('secret'), setup.secret);
  assert.equal(decodeURIComponent(uri.pathname), `/SampleifyLIMS:${account.username}`);
  const png = await sharp(Buffer.from(setup.qrDataUrl.split(',')[1], 'base64')).metadata();
  assert.equal(png.format, 'png'); assert.equal(png.width, 320); assert.equal(png.height, 320);
  assert.deepEqual(await status(session), { enabled: false, revision: 0 });
  assert.ok(await login(account));
  for (const table of ['user_mfa_setups', 'user_mfa']) await assert.rejects(getPool().query(`SELECT * FROM ${table}`), { code: '42501' });
  for (const role of ['sampleify_app', 'sampleify_report_worker']) {
    assert.equal((await owner.query("SELECT has_function_privilege($1,'auth_mfa_locked_session()','EXECUTE') AS allowed", [role])).rows[0].allowed, false);
    assert.equal((await owner.query("SELECT has_table_privilege($1,'user_mfa_setups','SELECT,INSERT,UPDATE,DELETE') AS allowed", [role])).rows[0].allowed, false);
  }
  assert.equal((await owner.query("SELECT has_function_privilege('sampleify_report_worker','auth_start_mfa_setup(text)','EXECUTE') AS allowed")).rows[0].allowed, false);
  assert.deepEqual(await events(account), []);
});

test('setup cancellation is exact and idempotent; an old cancel cannot remove a later key', async () => {
  const { session } = await fixture();
  const first = await start(session);
  await cancel(session, first); await cancel(session, first);
  await assert.rejects(verify(session, codeFor(first)), { code: 'mfa_setup_required' });
  const second = await start(session);
  assert.notEqual(second.setupId, first.setupId); assert.notEqual(second.secret, first.secret);
  await cancel(session, first);
  assert.deepEqual(await start(session), second);
  assert.deepEqual(await status(session), { enabled: false, revision: 0 });
});

test('concurrent exact enable retries record one event, retain current sessions and consume the login code step', async () => {
  const { account, session } = await fixture();
  const other = await login(account);
  const setup = await start(session);
  const input = codeFor(setup);
  const result = await Promise.all([verify(session, input), verify(session, input)]);
  assert.deepEqual(result, [{ enabled: true, revision: 1 }, { enabled: true, revision: 1 }]);
  assert.deepEqual(await status(other), result[0]);
  assert.deepEqual(await events(account), [{ kind: 'mfa_enabled' }]);
  assert.equal((await owner.query('SELECT count(*)::int n FROM user_mfa_setups p JOIN sessions s ON s.id=p.session_id WHERE s.user_id=$1', [account.userId])).rows[0].n, 0);
  await assert.rejects(login(account), { code: 'mfa_required' });
  await assert.rejects(login(account, { mfaCode: input.code }), { code: 'invalid_credentials' });
  await assert.rejects(start(session), { code: 'mfa_enabled' });
  await assert.rejects(verify(other, input), { code: 'mfa_setup_required' });
});

test('one session cannot consume or cancel another session or account setup, including another member of its tenant', async () => {
  const { account, session } = await fixture();
  const otherSession = await login(account);
  const otherAccount = await createAccount(owner, { organizationId: account.organizationId, permissions: [] });
  const foreignSession = await login(otherAccount);
  const setup = await start(session);
  const second = await start(otherSession);
  assert.notEqual(second.secret, setup.secret);
  for (const outsider of [otherSession, foreignSession]) {
    await assert.rejects(verify(outsider, codeFor(setup)), { code: 'mfa_setup_required' });
    await cancel(outsider, setup);
  }
  assert.deepEqual(await start(session), setup);
  await verify(session, codeFor(setup));
  await assert.rejects(verify(otherSession, codeFor(second)), { code: 'mfa_setup_required' });
  assert.deepEqual(await status(foreignSession), { enabled: false, revision: 0 });
});

test('expired setups and setups predating a password change cannot enable MFA, and starting again replaces their secrets', async () => {
  const { account, session } = await fixture();
  const expired = await start(session);
  await owner.query("UPDATE user_mfa_setups SET created_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes' WHERE id=$1", [expired.setupId]);
  await assert.rejects(verify(session, codeFor(expired)), { code: 'mfa_setup_required' });
  const oldCredential = await start(session);
  assert.notEqual(oldCredential.setupId, expired.setupId);
  await own(session, (client) => changePassword(client, { currentPassword: account.password, newPassword: 'Changed-Synthetic-Password!', confirmPassword: 'Changed-Synthetic-Password!' }));
  await assert.rejects(verify(session, codeFor(oldCredential)), { code: 'mfa_setup_required' });
  const replacement = await start(session);
  assert.notEqual(replacement.secret, oldCredential.secret);
  assert.deepEqual(await verify(session, codeFor(replacement)), { enabled: true, revision: 1 });
});

test('pending setup cannot outlive its authenticated session or be verified after that session expires', async () => {
  const { session } = await fixture();
  const expiry = (await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 minutes' WHERE token_hash=$1 RETURNING expires_at", [hashToken(session.token)])).rows[0].expires_at;
  const setup = await start(session);
  assert.equal(new Date(setup.expiresAt).getTime(), expiry.getTime());
  await owner.query("UPDATE sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE token_hash=$1", [hashToken(session.token)]);
  await assert.rejects(verify(session, codeFor(setup)), { code: 'unauthenticated' });
});

test('invalid codes commit a shared atomic attempt limit; cancel/restart cannot reset it and expiry permits recovery', async () => {
  const { account, session } = await fixture();
  const setup = await start(session);
  const bad = ['111111', '222222', '333333', '444444'].find((code) => verifiedTotpStep(setup.secret, code) === null);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => verify(session, { setupId: setup.setupId, code: bad })));
  assert.equal(results.filter((result) => result.reason?.code === 'invalid_mfa_code').length, 5);
  assert.equal(results.filter((result) => result.reason?.code === 'rate_limited').length, 3);
  const attemptHash = hashToken(`mfa-enable:${account.userId}`);
  assert.equal((await owner.query('SELECT attempts FROM login_limits WHERE lookup_hash=$1', [attemptHash])).rows[0].attempts, 6);
  assert.deepEqual(await status(session), { enabled: false, revision: 0 });
  await cancel(session, setup);
  const replacement = await start(session);
  await assert.rejects(verify(session, codeFor(replacement)), { code: 'rate_limited' });
  await owner.query("UPDATE login_limits SET window_started_at=now()-interval '16 minutes' WHERE lookup_hash=$1", [attemptHash]);
  assert.deepEqual(await verify(session, codeFor(replacement)), { enabled: true, revision: 1 });
  assert.equal((await owner.query('SELECT 1 FROM login_limits WHERE lookup_hash=$1', [attemptHash])).rowCount, 0);
});

test('different concurrent enrollments cannot replace the first verified factor', async () => {
  const { account, session } = await fixture();
  const secondSession = await login(account);
  const setups = await Promise.all([start(session), start(secondSession)]);
  const results = await Promise.allSettled([verify(session, codeFor(setups[0])), verify(secondSession, codeFor(setups[1]))]);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.reason?.code === 'mfa_setup_required').length, 1);
  const stored = (await owner.query('SELECT encrypted_secret FROM user_mfa WHERE user_id=$1', [account.userId])).rows[0];
  assert.equal(decryptSecret(stored.encrypted_secret), setups[winner].secret);
  assert.deepEqual(await events(account), [{ kind: 'mfa_enabled' }]);
});

test('disable retries clear ciphertext once; an old dialog or enable retry cannot change a newer enrollment', async () => {
  const { account, session } = await fixture();
  const first = await start(session);
  const firstInput = codeFor(first);
  await verify(session, firstInput);
  const removal = { revision: 1, requestId: randomUUID() };
  assert.deepEqual(await disable(session, removal), { enabled: false, revision: 2 });
  assert.deepEqual(await disable(session, removal), { enabled: false, revision: 2 });
  assert.equal((await owner.query('SELECT encrypted_secret FROM user_mfa WHERE user_id=$1', [account.userId])).rows[0].encrypted_secret, null);
  assert.ok(await login(account));
  const second = await start(session);
  assert.deepEqual(await verify(session, codeFor(second)), { enabled: true, revision: 3 });
  await assert.rejects(disable(session, removal), { code: 'stale_mfa' });
  await assert.rejects(disable(session, { revision: 1, requestId: randomUUID() }), { code: 'stale_mfa' });
  await assert.rejects(verify(session, firstInput), { code: 'mfa_setup_required' });
  assert.deepEqual(await status(session), { enabled: true, revision: 3 });
  assert.deepEqual(await events(account), [{ kind: 'mfa_enabled' }, { kind: 'mfa_disabled' }, { kind: 'mfa_enabled' }]);
});

test('direct boundaries reject absent context, malformed requests, mismatched ciphertext and null/out-of-window verification', async () => {
  const { account, session } = await fixture();
  await assert.rejects(getPool().query('SELECT * FROM auth_start_mfa_setup($1)', ['A'.repeat(80)]), { code: '28000' });
  await assert.rejects(withSession(session.token, startMfaSetup, { csrfToken: '', accountAction: true }), { code: 'invalid_csrf' });
  for (const input of [null, {}, { setupId: 'invalid' }]) {
    await assert.rejects(cancel(session, input), { code: 'invalid_input' });
    await assert.rejects(verify(session, input), { code: 'invalid_input' });
  }
  for (const revision of [null, -1, 1.5, '0', 2_147_483_647]) {
    await assert.rejects(disable(session, { revision, requestId: randomUUID() }), { code: 'invalid_revision' });
  }
  const setup = await start(session);
  for (const code of [null, '', '12345', '1234567', 'ABCDEF', 123456]) {
    await assert.rejects(verify(session, { setupId: setup.setupId, code }), { code: 'invalid_mfa_code' });
  }
  const encrypted = (await owner.query('SELECT encrypted_secret FROM user_mfa_setups WHERE id=$1', [setup.setupId])).rows[0].encrypted_secret;
  await own(session, async (client) => {
    for (const [cipher, step] of [[null, 1], ['wrong', Math.floor(Date.now() / 30_000)], [encrypted, null], [encrypted, 1]]) {
      assert.equal((await client.query('SELECT auth_enable_mfa($1,$2,$3) AS revision', [setup.setupId, cipher, step])).rows[0].revision, null);
    }
    assert.equal((await client.query('SELECT auth_disable_mfa(NULL,NULL) AS revision')).rows[0].revision, null);
  });
  assert.deepEqual(await status(session), { enabled: false, revision: 0 });
  assert.deepEqual(await events(account), []);
});

test('MFA is one account factor across active organization memberships, without exposing another user credential', async () => {
  const { account, session } = await fixture();
  const other = await createAccount(owner);
  await owner.query('UPDATE memberships SET is_default=false WHERE user_id=$1', [account.userId]);
  await owner.query('INSERT INTO memberships(user_id,organization_id,is_default) VALUES($1,$2,true)', [account.userId, other.organizationId]);
  const otherMembership = await login(account);
  const setup = await start(otherMembership);
  await verify(otherMembership, codeFor(setup));
  assert.deepEqual(await status(session), { enabled: true, revision: 1 });
  assert.deepEqual(await status(await login(other)), { enabled: false, revision: 0 });
  assert.equal((await owner.query("SELECT organization_id FROM account_events WHERE user_id=$1 AND kind='mfa_enabled'", [account.userId])).rows[0].organization_id, other.organizationId);
});

test('an enrollment waiting on the account lock rechecks credential, membership, organization and session revocation', async () => {
  for (const invalidation of ['credential', 'membership', 'organization', 'session']) {
    const { account, session } = await fixture();
    const writer = await owner.connect();
    let pending;
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [account.userId]);
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = start(session).then((value) => ({ value }), (error) => ({ error }));
      let blocked = false;
      for (let attempt = 0; attempt < 200 && !blocked; attempt += 1) {
        blocked = (await owner.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [writerPid])).rows[0].blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, `observed the real ${invalidation} lock wait`);
      if (invalidation === 'credential') await writer.query('UPDATE credentials SET revision=revision+1 WHERE user_id=$1', [account.userId]);
      if (invalidation === 'membership') await writer.query('UPDATE memberships SET active=false WHERE user_id=$1', [account.userId]);
      if (invalidation === 'organization') await writer.query('UPDATE organizations SET active=false WHERE id=$1', [account.organizationId]);
      if (invalidation === 'session') await writer.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(session.token)]);
      await writer.query('COMMIT');
      assert.equal((await pending).error?.code, 'unauthenticated');
      assert.equal((await owner.query('SELECT 1 FROM user_mfa_setups p JOIN sessions s ON s.id=p.session_id WHERE s.user_id=$1', [account.userId])).rowCount, 0);
    } finally { await writer.query('ROLLBACK'); writer.release(); await pending; }
  }
});
