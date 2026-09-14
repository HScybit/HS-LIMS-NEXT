import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { userFormInput } from '../../src/users/form-input.js';

const id = randomUUID(); const command = () => ({ requestId: randomUUID(), revision: 1, profileRevision: 0, username: 'analyst', email: 'analyst@example.invalid', displayName: 'Analyst' });
test('user forms retain sparse profile edits, explicit clears and hidden-field absence with independent revisions', () => {
  const input = command(); const parsed = userFormInput(id, { ...input, phone: ' ', canManagePeople: false, businessUnitId: null });
  assert.deepEqual(parsed.profile, { requestId: input.requestId, revision: 0, phone: null, canManagePeople: false, businessUnitId: null });
  assert.equal(parsed.account.revision, 1); assert.equal(parsed.account.password, ''); assert.equal(Object.hasOwn(parsed.account, 'id'), false);
  assert.equal(Object.hasOwn(parsed.profile, 'roleIds'), false); assert.equal(userFormInput(id, input).profile, null);
});
test('user forms validate identity and profile fields before executing either command', () => {
  const input = command();
  for (const changes of [{ password: null }, { password: 'short' }, { profileRevision: '0' }, { profileRevision: -1 }, { revision: 0 }, { roleIds: [] }, { canManagePeople: null }, { defaultRoleId: null }, { organizationId: randomUUID() }]) {
    assert.throws(() => userFormInput(id, { ...input, ...changes }), { status: 400 });
  }
});
