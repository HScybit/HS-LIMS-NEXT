import test from 'node:test';
import assert from 'node:assert/strict';
import { userStatusInput } from '../../src/users/status-input.js';

const requestId = 'abcdef00-0000-4000-8000-000000000001';
const input = { requestId, revision: 0, membershipActive: false };

test('status commands require an explicit membership state and canonical request identity', () => {
  assert.deepEqual(userStatusInput({ ...input, requestId: requestId.toUpperCase() }), input);
  assert.deepEqual(userStatusInput({ ...input, revision: 2_147_483_646, membershipActive: true }), { ...input, revision: 2_147_483_646, membershipActive: true });
  for (const value of [null, [], true, {}, { ...input, active: true }, { ...input, userId: requestId }, { ...input, organizationId: requestId },
    { ...input, requestId: 'invalid' }, { ...input, revision: '0' }, { ...input, revision: -1 }, { ...input, revision: 1.5 },
    { ...input, revision: 2_147_483_647 }, { ...input, revision: NaN }]) assert.throws(() => userStatusInput(value), { status: 400 });
  for (const membershipActive of [null, undefined, 'false', 'active', 0, 1, [], {}]) assert.throws(() => userStatusInput({ ...input, membershipActive }), { status: 400 });
});
