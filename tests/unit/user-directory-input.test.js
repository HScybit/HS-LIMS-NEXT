import test from 'node:test';
import assert from 'node:assert/strict';
import { userListInput } from '../../src/users/input.js';

test('user list input preserves literal search and bounds paging, availability and explicit sorting', () => {
  assert.deepEqual(userListInput(), { page: 1, pageSize: 25, search: '', status: 'all', sort: { key: 'displayName', dir: 'asc' } });
  assert.deepEqual(userListInput({ page: 1_000_000, pageSize: 100, search: ' %_\\ ', status: 'disabled', sort: { key: 'createdAt', dir: 'desc' } }),
    { page: 1_000_000, pageSize: 100, search: '%_\\', status: 'disabled', sort: { key: 'createdAt', dir: 'desc' } });
  assert.equal(userListInput({ search: null, status: 'active' }).search, '');
});

test('user list rejects malformed, oversized and injected query properties', () => {
  for (const input of [null, [], 'query', { organizationId: 'other' }, { page: 0 }, { page: '1' }, { page: 1_000_001 },
    { pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.5 }, { search: 'x'.repeat(501) }, { search: '\0' }, { search: '\ud800' },
    { search: {} }, { status: 'invited' }, { status: false }, { sort: [] }, { sort: {} }, { sort: { key: 'toString', dir: 'asc' } },
    { sort: { key: ['email'], dir: 'asc' } }, { sort: { key: { toString: null }, dir: 'asc' } },
    { sort: { key: 'username; DROP TABLE users', dir: 'asc' } }, { sort: { key: 'email', dir: 'asc; SELECT 1' } },
    { sort: { key: 'active', dir: 'asc', organizationId: 'other' } }]) {
    assert.throws(() => userListInput(input), { status: 400 });
  }
});
