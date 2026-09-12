import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/auth/passwords.js';
import { hashToken, matchesToken, newToken, validToken } from '../../src/auth/tokens.js';
import { localRedirect } from '../../src/auth/tokens-client.js';
import { buildTotpUri, decryptSecret, encryptSecret, generateTotpSecret, totpAt, verifiedTotpStep } from '../../src/auth/totp.js';

test('scrypt verifies correct passwords, preserves whitespace and rejects malformed encodings', async () => {
  const hash = await hashPassword(' synthetic password ');
  assert.equal(await verifyPassword(' synthetic password ', hash), true);
  assert.equal(await verifyPassword('synthetic password', hash), false);
  assert.equal(await verifyPassword('wrong password', hash), false);
  for (const encoded of [null, '', `${hash}$extra`, hash.replace('$32768$', '$999999999$'), hash.replace('$1$', '$2$')]) {
    assert.equal(await verifyPassword(' synthetic password ', encoded), false);
  }
  assert.equal(await verifyPassword(null, hash), false);
  assert.equal(await verifyPassword('x'.repeat(201), hash), false);
});

test('random password salts differ and length bounds are enforced', async () => {
  assert.notEqual(await hashPassword('test password'), await hashPassword('test password'));
  await assert.rejects(hashPassword('short'));
  await assert.rejects(hashPassword('x'.repeat(201)));
});

test('opaque token validation and constant-length digest matching reject malformed input', () => {
  const token = newToken();
  assert.equal(validToken(token), true);
  assert.equal(matchesToken(token, hashToken(token)), true);
  assert.equal(matchesToken(newToken(), hashToken(token)), false);
  for (const invalid of [null, '', 'a', `${token}=`, 'x'.repeat(1000), []]) assert.equal(validToken(invalid), false);
  assert.equal(matchesToken(token, 'invalid'), false);
});

test('post-login redirects stay on this origin, including protocol-relative and backslash attacks', () => {
  assert.equal(localRedirect('/templates?a=1#field'), '/templates?a=1#field');
  for (const invalid of [null, '//evil.invalid', '/\\evil.invalid', 'https://evil.invalid', 'javascript:alert(1)', '/\nevil', '/login', '/reset-password']) {
    assert.equal(localRedirect(invalid), '/me');
  }
});

test('six-digit TOTP agrees with RFC 6238 SHA-1 vectors and the source time window', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpAt(secret, 59_000), '287082');
  assert.equal(totpAt(secret, 1_111_111_109_000), '081804');
  assert.equal(totpAt(secret, 2_000_000_000_000), '279037');
  assert.equal(verifiedTotpStep(secret, '287082', 59_000), 1);
  assert.equal(verifiedTotpStep(secret, '287082', 89_000), 1);
  assert.equal(verifiedTotpStep(secret, '287082', 120_000), null);
  assert.equal(verifiedTotpStep(secret, 'bad', 59_000), null);
});

test('encrypted authenticator secrets detect wrong keys, tampering and malformed envelopes', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const key = 'ab'.repeat(32);
  const encoded = encryptSecret(secret, key);
  assert.equal(decryptSecret(encoded, key), secret);
  assert.notEqual(encoded, encryptSecret(secret, key));
  assert.throws(() => decryptSecret(encoded, 'cd'.repeat(32)));
  const bytes = Buffer.from(encoded, 'base64url'); bytes[30] ^= 1;
  assert.throws(() => decryptSecret(bytes.toString('base64url'), key));
  assert.throws(() => decryptSecret('bad', key));
  assert.throws(() => encryptSecret(secret, 'not-a-key'));
});

test('new authenticator keys are independent 32-character Base32 secrets accepted by existing encryption and TOTP', () => {
  const secrets = Array.from({ length: 10 }, generateTotpSecret);
  assert.equal(new Set(secrets).size, secrets.length);
  for (const secret of secrets) {
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(decryptSecret(encryptSecret(secret, 'ab'.repeat(32)), 'ab'.repeat(32)), secret);
    assert.match(totpAt(secret, 59_000), /^\d{6}$/);
  }
});

test('authenticator URI preserves the Meteor issuer and sanitized account label with unambiguous parameters', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const uri = new URL(buildTotpUri(secret, '  Lab: Analyst / अ &?=  '));
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.hostname, 'totp');
  assert.equal(decodeURIComponent(uri.pathname), '/SampleifyLIMS:Lab Analyst / अ &?=');
  assert.deepEqual(Object.fromEntries(uri.searchParams), { secret, issuer: 'SampleifyLIMS', algorithm: 'SHA1', digits: '6', period: '30' });
  assert.equal(decodeURIComponent(new URL(buildTotpUri(secret, ':', 'user-id')).pathname), '/SampleifyLIMS:user-id');
  assert.equal(decodeURIComponent(new URL(buildTotpUri(secret, 'x'.repeat(200))).pathname).length, '/SampleifyLIMS:'.length + 120);
  for (const invalid of [null, undefined, '', ' ', ':', {}, []]) assert.throws(() => buildTotpUri(secret, invalid));
  assert.throws(() => buildTotpUri('bad-secret', 'Analyst'));
});
