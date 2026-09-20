import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { userAccountInput, userAccountFingerprint } from '../../src/users/account-input.js';

const id = randomUUID(); const command = () => ({ requestId: randomUUID(), revision: 1, username: 'analyst', email: 'analyst@example.invalid', displayName: 'Analyst' });
test('account commands preserve blank-password semantics and exact supplied password boundaries', () => {
  const input = command();
  assert.deepEqual(userAccountInput(id, input), userAccountInput(id, { ...input, password: '' }));
  for (const password of ['        ', ' secret password ', 'a'.repeat(200)]) assert.equal(userAccountInput(id, { ...input, password }).password, password);
  for (const password of [null, false, 12, 'short', 'a'.repeat(201), '\ud800'.repeat(8)]) assert.throws(() => userAccountInput(id, { ...input, password }), { status: 400 });
});
test('account commands normalize identity text and reject malformed or unknown input without coercion', () => {
  const input = command(); const normalized = userAccountInput(id.toUpperCase(), { ...input, requestId: input.requestId.toUpperCase(), username: ' analyst ', displayName: ' Analyst ' });
  assert.equal(normalized.id, id); assert.equal(normalized.requestId, input.requestId); assert.equal(normalized.username, 'analyst'); assert.equal(normalized.displayName, 'Analyst');
  for (const changes of [{ username: '' }, { email: 'bad' }, { displayName: '\0name' }, { revision: 0 }, { revision: '1' }, { revision: 2147483647 }, { roleIds: [] }, { active: true }, { password: {} }]) {
    assert.throws(() => userAccountInput(id, { ...input, ...changes }), { status: 400 });
  }
  for (const value of [null, [], '']) assert.throws(() => userAccountInput(id, value), { status: 400 });
});
test('keyed account receipts cover identity, target, revision and exact password without an unkeyed password digest', () => {
  const input = command(); const key = 'ab'.repeat(32); const normalized = userAccountInput(id, { ...input, password: ' Secret ' });
  const fingerprint = userAccountFingerprint(normalized, key); assert.equal(fingerprint.length, 32);
  assert.deepEqual(userAccountFingerprint(userAccountInput(id, { password: ' Secret ', ...input }), key), fingerprint);
  for (const changes of [{ id: randomUUID() }, { requestId: randomUUID() }, { revision: 2 }, { username: 'other' }, { email: 'other@example.invalid' }, { displayName: 'Other' }, { password: 'Secret  ' }]) {
    assert.notDeepEqual(userAccountFingerprint({ ...normalized, ...changes }, key), fingerprint);
  }
  assert.notDeepEqual(userAccountFingerprint(normalized, 'cd'.repeat(32)), fingerprint);
  for (const invalid of ['', 'xx'.repeat(32), 'ab'.repeat(31)]) assert.throws(() => userAccountFingerprint(normalized, invalid), { status: 503 });
});
