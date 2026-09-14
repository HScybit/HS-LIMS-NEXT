import test from 'node:test';
import assert from 'node:assert/strict';
import { userFieldUserSearch } from '../../src/users/custom-field-input.js';
import { userFieldUserOption } from '../../src/users/custom-field-options.js';
import { matchesUserFieldUserOption } from '../../src/users/custom-field-filter.js';
import { loadUserFieldUserOptions } from '../../src/users/custom-fields.js';

test('user choices sanitize labels while retaining blank names and exact source filter behavior', () => {
  const person = { id: '12345678-90ab-4cde-8fab-123456789abc', name: ' Élodie_Straße/Åsa-\tJOSÉ ' };
  assert.deepEqual(userFieldUserOption(person.id, person.name), { value: person.id, label: 'Élodie Straße Åsa JOSÉ' });
  for (const search of ['', ' ', 'ELODIE', 'strase', 'ÅSA josé', '90AB', '  asa jose  ']) assert.equal(matchesUserFieldUserOption(person, search), true, search);
  // react-select's actual table folds ß to s, not ss; only the label's whitespace is collapsed.
  for (const search of ['elodie strasse', 'asa  jose', '_', '%', '[', 'unmatched']) assert.equal(matchesUserFieldUserOption(person, search), false, search);
  assert.equal(userFieldUserOption('identity', '').label, '');
  assert.equal(userFieldUserOption('identity', null).label, 'identity');
  assert.equal(matchesUserFieldUserOption({ id: 'identity', name: '100% [literal] \\ É' }, '% [literal] \\ e'), true);
});

test('user search preserves literal input and rejects unsupported transport shapes', () => {
  assert.equal(userFieldUserSearch(), ''); assert.equal(userFieldUserSearch({ search: '  A_%  ' }), '  A_%  ');
  assert.equal(userFieldUserSearch({ search: 'x'.repeat(200) }).length, 200);
  for (const search of [null, false, 0, [], {}, 'x'.repeat(201), '\0', '\ud800']) assert.throws(() => userFieldUserSearch({ search }), { code: 'invalid_user_field_search' });
  for (const input of [null, [], { search: '', organizationId: 'foreign' }]) assert.throws(() => userFieldUserSearch(input), { code: 'invalid_input' });
});

test('user choices short-circuit after the51st match in one scoped batch', async () => {
  const people = Array.from({ length: 501 }, (_, i) => ({ id: String(i).padStart(4, '0'), name: 'Person' })); let queries = 0;
  const client = { async query(sql, args) { queries++; assert.match(sql, /LIMIT 501/); assert.deepEqual(args, ['organization']); return { rows: people }; } };
  assert.deepEqual(await loadUserFieldUserOptions(client, { organization_id: 'organization', permission_codes: ['users.read'] }, {}), { rows: people.slice(0, 50), hasMore: true });
  assert.equal(queries, 1);
});

test('user choices traverse lookahead boundaries without skipping or repeating candidates and keep exact50 hasMore false', async () => {
  const people = Array.from({ length: 551 }, (_, i) => ({ id: String(i).padStart(4, '0'), name: i >= 499 && i < 549 ? 'Late match' : 'Other' })); let queries = 0;
  const client = { async query(_sql, args) {
    queries++; const after = args[1]; if (queries === 2) assert.equal(after, people[499].id);
    return { rows: people.filter(person => !after || person.id > after).slice(0, 501) };
  } };
  const identity = { organization_id: 'organization', permission_codes: ['users.manage'] };
  assert.deepEqual(await loadUserFieldUserOptions(client, identity, { search: 'late' }), { rows: people.slice(499, 549), hasMore: false });
  assert.equal(queries, 2);
  queries = 0; assert.deepEqual(await loadUserFieldUserOptions(client, identity, { search: 'missing' }), { rows: [], hasMore: false }); assert.equal(queries, 2);
});

test('user choice errors and absent authority do not become a successful empty result', async () => {
  let queries = 0; const error = new Error('Database unavailable'); const client = { async query() { queries++; throw error; } };
  for (const permissions of [[], ['masters.read'], ['masters.manage']]) await assert.rejects(loadUserFieldUserOptions(client, { permission_codes: permissions }, {}), { code: 'forbidden' });
  assert.equal(queries, 0);
  await assert.rejects(loadUserFieldUserOptions(client, { organization_id: 'org', permission_codes: ['users.read'] }, {}), error); assert.equal(queries, 1);
});
