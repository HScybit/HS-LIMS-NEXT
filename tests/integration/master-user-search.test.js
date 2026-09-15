import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { masterCustomFieldUsers } from '../../src/masters/custom-fields.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.read'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
const work = (actor, action) => withSession(actor.token, action, { readOnly: true });
const search = (actor, value = '') => work(actor, (client, identity) => masterCustomFieldUsers(client, identity, { search: value }));
async function members(actor, names) {
  const prefix = randomUUID();
  const people = (await owner.query(`INSERT INTO users(id,username,email,display_name)
    SELECT ($1||'-0000-4000-8000-'||lpad(position::text,12,'0'))::uuid,$2||position,$2||position||'@example.invalid',name
    FROM unnest($3::text[]) WITH ORDINALITY AS input(name,position) RETURNING id,display_name AS name`, [prefix.slice(0, 8), prefix, names])).rows.sort((a, b) => a.id.localeCompare(b.id));
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [actor.organizationId, people.map(person => person.id)]); return people;
}

test('master user choices use exact label and ID filtering with current raw names and inactive memberships', async () => {
  const actor = await account(); const people = await members(actor, [' Élodie_Straße/Åsa-\tJOSÉ ', '100% [literal] \\ É', '---']);
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [actor.organizationId, people[0].id]);
  await owner.query('UPDATE users SET active=false WHERE id=$1', [people[1].id]);
  for (const query of ['ELODIE', 'strase', '  asa jose  ', people[0].id.toUpperCase()]) assert.deepEqual(await search(actor, query), { rows: [people[0]], hasMore: false });
  for (const query of ['strasse', 'asa  jose', 'Élodie_', '@example.invalid']) assert.deepEqual(await search(actor, query), { rows: [], hasMore: false });
  assert.deepEqual(await search(actor, '% [literal] \\ e'), { rows: [people[1]], hasMore: false });
  assert.deepEqual(await search(actor, people[2].id.toUpperCase()), { rows: [people[2]], hasMore: false });
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [people[0].id, 'Current_name']);
  assert.deepEqual(await search(actor, 'current name'), { rows: [{ id: people[0].id, name: 'Current_name' }], hasMore: false });
});

test('master name and UUID keysets preserve100-result boundaries and find matches beyond the first1000 names', async () => {
  const actor = await account(); const people = await members(actor, Array.from({ length: 1101 }, (_, index) => index >= 1000 ? 'ZZ_Laté_choice' : 'Other person'));
  await work(actor, async (client, identity) => {
    let queries = 0;
    const result = await masterCustomFieldUsers({ query: (...args) => { queries++; return client.query(...args); } }, identity, { search: 'late choice' });
    assert.deepEqual(result, { rows: people.slice(1000, 1100), hasMore: true }); assert.equal(queries, 3);
  });
  assert.deepEqual(await search(actor, people[1100].id.toUpperCase()), { rows: [people[1100]], hasMore: false });
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [people[1100].id, 'Other person']);
  assert.deepEqual(await search(actor, 'late choice'), { rows: people.slice(1000, 1100), hasMore: false });
  await work(actor, async (client, identity) => {
    let queries = 0; const counted = { query: (...args) => { queries++; return client.query(...args); } };
    assert.deepEqual(await masterCustomFieldUsers(counted, identity, { search: 'no such choice' }), { rows: [], hasMore: false }); assert.equal(queries, 3);
    queries = 0; const expected = (await client.query('SELECT user_id AS id,display_name AS name FROM method_access_user_labels WHERE organization_id=$1 ORDER BY display_name,user_id LIMIT 100', [actor.organizationId])).rows;
    assert.deepEqual(await masterCustomFieldUsers(counted, identity, {}), { rows: expected, hasMore: true }); assert.equal(queries, 1);
  });
});

test('master user lookup retains one read snapshot if a name moves across the cursor between batches', async () => {
  const actor = await account(); const people = await members(actor, [...Array.from({ length: 600 }, () => 'Other'), 'ZZ_Old_target']); const target = people.at(-1);
  await work(actor, async (client, identity) => {
    assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read'); let queries = 0;
    const result = await masterCustomFieldUsers({ async query(...args) {
      const rows = await client.query(...args); queries++;
      if (queries === 1) await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [target.id, 'A_New_target']);
      return rows;
    } }, identity, { search: 'old target' });
    assert.deepEqual(result, { rows: [target], hasMore: false }); assert.equal(queries, 2);
  });
  assert.deepEqual(await search(actor, 'old target'), { rows: [], hasMore: false });
  assert.deepEqual(await search(actor, 'new target'), { rows: [{ id: target.id, name: 'A_New_target' }], hasMore: false });
});

test('master directory authority rejects user-only roles and cannot be forged to read another tenant', async () => {
  const actor = await account(); const person = (await members(actor, ['Only_here']))[0]; const foreign = await account();
  const userReader = await account({ organizationId: actor.organizationId, permissions: ['users.read'] });
  assert.deepEqual(await search(foreign, person.id), { rows: [], hasMore: false });
  await assert.rejects(search(userReader), { code: 'forbidden' });
  assert.deepEqual(await work(userReader, (client, identity) => masterCustomFieldUsers(client, { ...identity, permission_codes: ['masters.read'] }, { search: person.id })), { rows: [], hasMore: false });
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [actor.organizationId, actor.roleId]);
  await assert.rejects(search(actor), { code: 'forbidden' });
});
