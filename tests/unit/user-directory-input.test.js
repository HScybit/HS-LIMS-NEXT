import test from 'node:test';
import assert from 'node:assert/strict';
import { userListInput } from '../../src/users/input.js';

test('user list input preserves literal search and bounds paging, availability and explicit sorting', () => {
  assert.deepEqual(userListInput(), { page: 1, pageSize: 25, search: '', status: 'all', sort: { key: 'displayName', dir: 'asc' }, filters: {}, timeZone: 'UTC' });
  assert.deepEqual(userListInput({ page: 1_000_000, pageSize: 100, search: ' %_\\ ', status: 'disabled', sort: { key: 'createdAt', dir: 'desc' } }),
    { page: 1_000_000, pageSize: 100, search: '%_\\', status: 'disabled', sort: { key: 'createdAt', dir: 'desc' }, filters: {}, timeZone: 'UTC' });
  assert.equal(userListInput({ search: null, status: 'active' }).search, '');
});

test('screen filters preserve literal labels, explicit calendar zones and separate membership status', () => {
  const id = 'A1234567-1234-4234-8234-123456789ABC';
  const result = userListInput({ timeZone: 'America/New_York', filters: { displayName: { type: 'text', value: ' %_\\ ' },
    defaultRoleDescription: { type: 'relation', value: [id] }, identityCreatedAt: { type: 'date', from: '2024-02-29', to: '' },
    businessUnitName: { type: 'text', value: ' ' }, membershipActive: { type: 'boolean', value: 'false' } } });
  assert.equal(result.timeZone, 'America/New_York');
  assert.deepEqual(result.filters, { displayName: { type: 'text', value: '%_\\' }, defaultRoleDescription: { type: 'relation', value: [id.toLowerCase()] },
    identityCreatedAt: { type: 'date', from: '2024-02-29', to: null }, membershipActive: { type: 'boolean', value: false } });
  for (const timeZone of ['UTC', 'Asia/Kolkata', 'Etc/GMT+9']) assert.equal(userListInput({ timeZone }).timeZone, timeZone);
});

test('screen filters reject invalid days, ranges, zones, arrays, duplicate roles and injected properties', () => {
  const id = 'a1234567-1234-4234-8234-123456789abc';
  for (const input of [{ filters: [] }, { filters: { lastLoginAt: { type: 'text', value: 'today' } } },
    { filters: { identityCreatedAt: { type: 'date', from: '2025-02-29' } } }, { filters: { identityCreatedAt: { type: 'date', from: null } } },
    { filters: { identityCreatedAt: { type: 'date', from: '2026-01-02', to: '2026-01-01' } } },
    { filters: { defaultRoleDescription: { type: 'relation', value: [id, id.toUpperCase()] } } },
    { filters: { defaultRoleDescription: { type: 'relation', value: Array(101).fill(id) } } },
    { filters: { defaultRoleDescription: { type: 'relation', value: ['invalid'] } } },
    { filters: { displayName: { type: 'text', value: '\0' } } }, { filters: { displayName: { type: 'text', value: '\ud800' } } },
    { filters: { displayName: { type: 'text', value: 'x'.repeat(501) } } },
    { filters: { membershipActive: { type: 'boolean', value: false } } }, { filters: { membershipActive: { type: 'text', value: 'true' } } },
    { timeZone: {} }, { timeZone: 'invalid/zone' }, { timeZone: "UTC'; SELECT 1" }, { timeZone: '+05:30' }]) assert.throws(() => userListInput(input), { status: 400 });
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
