import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { userFieldUserIds } from '../../src/users/custom-field-input.js';
import { loadUserFieldUserLabels } from '../../src/users/custom-fields.js';

test('selected user IDs retain first-occurrence order after case normalization and deduplication', () => {
  const first = randomUUID(); const second = randomUUID();
  assert.deepEqual(userFieldUserIds({ ids: [first.toUpperCase(), second, first] }), [first, second]);
  assert.deepEqual(userFieldUserIds({ ids: [] }), []);
  assert.deepEqual(userFieldUserIds({ ids: Array(5000).fill(first) }), [first]);
});

test('selected user IDs reject missing arrays, excessive input, unknown fields and malformed identifiers', () => {
  for (const input of [{}, { ids: null }, { ids: '' }, { ids: {} }, { ids: Array(5001).fill(randomUUID()) }]) {
    assert.throws(() => userFieldUserIds(input), { code: 'invalid_user_field_user_ids' });
  }
  for (const input of [null, [], { ids: [], organizationId: randomUUID() }]) assert.throws(() => userFieldUserIds(input), { code: 'invalid_input' });
  for (const id of [null, 0, false, {}, '', 'invalid', ` ${randomUUID()}`, randomUUID() + '\0']) {
    assert.throws(() => userFieldUserIds({ ids: [id] }), { code: 'invalid_id' });
  }
});

test('empty label reads skip service queries while still enforcing user-read authority', async () => {
  const client = { query() { throw new Error('Empty label reads must not query.'); } };
  for (const permission of ['users.read', 'users.manage']) assert.deepEqual(await loadUserFieldUserLabels(client, { permission_codes: [permission] }, { ids: [] }), { rows: [] });
  for (const permissions of [[], ['masters.manage'], ['masters.read']]) await assert.rejects(loadUserFieldUserLabels(client, { permission_codes: permissions }, { ids: [] }), { code: 'forbidden' });
});

test('label reads pass only normalized IDs and the authenticated organization to one scoped query', async () => {
  const organization = randomUUID(); const id = randomUUID(); let calls = 0;
  const client = { async query(sql, args) { calls++; assert.match(sql, /JOIN user_directory/); assert.deepEqual(args, [organization, [id]]); return { rows: [{ id, name: 'Actual_current/name' }] }; } };
  assert.deepEqual(await loadUserFieldUserLabels(client, { organization_id: organization, permission_codes: ['users.read'] }, { ids: [id.toUpperCase(), id] }), { rows: [{ id, name: 'Actual_current/name' }] });
  assert.equal(calls, 1);
});
