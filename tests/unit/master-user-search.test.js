import test from 'node:test';
import assert from 'node:assert/strict';
import { masterCustomFieldUsers } from '../../src/masters/custom-fields.js';

const identity = { organization_id: 'organization', permission_codes: ['masters.read'] };
test('master user search rejects malformed input and absent authority before querying', async () => {
  let queries = 0; const client = { async query() { queries++; throw new Error('Unexpected query'); } };
  for (const input of [null, [], { organizationId: 'other' }, { search: '\0' }, { search: '\ud800' }, { search: 'x'.repeat(501) }, { search: false }]) {
    await assert.rejects(masterCustomFieldUsers(client, identity, input), { code: 'invalid_input' });
  }
  for (const permission_codes of [[], ['users.read'], ['users.manage']]) await assert.rejects(masterCustomFieldUsers(client, { ...identity, permission_codes }, {}), { code: 'forbidden' });
  assert.equal(queries, 0);
});

test('master user search traverses equal-name boundaries and distinguishes100 from101 matches', async () => {
  for (const count of [100, 101]) {
    const people = Array.from({ length: 650 }, (_, index) => ({ id: String(index).padStart(4, '0'), name: index < 499 ? 'Before' : index < 499 + count ? 'Wanted' : 'ZZAfter' }));
    let queries = 0;
    const client = { async query(_sql, args) {
      queries++; const start = args.length === 1 ? 0 : people.findIndex(person => person.name === args[1] && person.id === args[2]) + 1;
      return { rows: people.slice(start, start + 501) };
    } };
    assert.deepEqual(await masterCustomFieldUsers(client, identity, { search: 'wanted' }), { rows: people.slice(499, 599), hasMore: count === 101 });
    assert.equal(queries, 2);
  }
});

test('a later master user search failure propagates instead of returning incomplete choices', async () => {
  let queries = 0; const failure = new Error('Directory unavailable');
  const client = { async query() { queries++; if (queries === 2) throw failure; return { rows: Array.from({ length: 501 }, (_, index) => ({ id: String(index), name: 'Other' })) }; } };
  await assert.rejects(masterCustomFieldUsers(client, identity, { search: 'missing' }), failure); assert.equal(queries, 2);
});
