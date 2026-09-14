import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadUserFieldUserOptions } from '../../src/users/custom-fields.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
async function account(options) { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; }
const work = (actor, action) => withSession(actor.token, action, { readOnly: true });
const search = (actor, value = '') => work(actor, (client, identity) => loadUserFieldUserOptions(client, identity, { search: value }));
async function members(actor, names) {
  const prefix = randomUUID();
  const rows = (await owner.query(`INSERT INTO users(id,username,email,display_name)
    SELECT ($1||'-0000-4000-8000-'||lpad(position::text,12,'0'))::uuid,$2||position,$2||position||'@example.invalid',name
    FROM unnest($3::text[]) WITH ORDINALITY AS selected(name,position) RETURNING id,display_name AS name`, [prefix.slice(0, 8), prefix, names])).rows.sort((a, b) => a.id.localeCompare(b.id));
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [actor.organizationId, rows.map(row => row.id)]);
  return rows;
}

test('user choices apply source name and ID filtering, preserve raw names and include inactive users', async () => {
  const reader = await account({ permissions: ['users.read'] });
  const people = await members(reader, [' Élodie_Straße/Åsa-\tJOSÉ ', '100% [literal] \\ É', 'Distinct_Name']);
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [reader.organizationId, people[0].id]);
  await owner.query('UPDATE users SET active=false WHERE id=$1', [people[1].id]);
  for (const query of ['ELODIE', 'strase', '  asa jose  ', people[0].id.toUpperCase()]) assert.deepEqual(await search(reader, query), { rows: [people[0]], hasMore: false });
  for (const query of ['strasse', 'asa  jose', 'Élodie_', '@example.invalid']) assert.deepEqual(await search(reader, query), { rows: [], hasMore: false });
  assert.deepEqual(await search(reader, '% [literal] \\ e'), { rows: [people[1]], hasMore: false });
  assert.deepEqual(await search(reader, 'distinct name'), { rows: [people[2]], hasMore: false });
});

test('fixed batches find late matches and retain exact50 and51 match boundaries without a directory cap', async () => {
  const reader = await account({ permissions: ['users.read'] });
  const people = await members(reader, Array.from({ length: 1050 }, (_, i) => i >= 999 ? 'Late_choice' : 'Other person'));
  await work(reader, async (client, identity) => {
    let queries = 0;
    const result = await loadUserFieldUserOptions({ async query(...args) { queries++; return client.query(...args); } }, identity, { search: 'late choice' });
    assert.deepEqual(result, { rows: people.slice(999, 1049), hasMore: true }); assert.equal(queries, 3);
  });
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [people[1049].id, 'Other person']);
  assert.deepEqual(await search(reader, 'late choice'), { rows: people.slice(999, 1049), hasMore: false });
  await work(reader, async (client, identity) => {
    let queries = 0; const clientWithCount = { async query(...args) { queries++; return client.query(...args); } };
    assert.deepEqual(await loadUserFieldUserOptions(clientWithCount, identity, { search: 'missing!' }), { rows: [], hasMore: false }); assert.equal(queries, 3);
    queries = 0; const result = await loadUserFieldUserOptions(clientWithCount, identity, {});
    const expected = [...people, { id: reader.userId, name: 'Synthetic Analyst' }].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 50);
    assert.deepEqual(result, { rows: expected, hasMore: true }); assert.equal(queries, 1);
  });
});

test('all user search batches observe one readonly snapshot while later requests see committed changes', async () => {
  const reader = await account({ permissions: ['users.read'] });
  const people = await members(reader, Array.from({ length: 1001 }, (_, i) => i === 1000 ? 'Original_tail' : 'Other person'));
  await work(reader, async (client, identity) => {
    assert.deepEqual((await client.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly")).rows[0], { isolation: 'repeatable read', readonly: 'on' });
    let queries = 0;
    const result = await loadUserFieldUserOptions({ async query(...args) {
      const result = await client.query(...args); queries++;
      if (queries === 1) await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [people[1000].id, 'Changed tail']);
      return result;
    } }, identity, { search: 'original tail' });
    assert.equal(queries, 3); assert.deepEqual(result, { rows: [people[1000]], hasMore: false });
  });
  assert.deepEqual(await search(reader, 'original tail'), { rows: [], hasMore: false });
  assert.deepEqual(await search(reader, 'changed tail'), { rows: [{ ...people[1000], name: 'Changed tail' }], hasMore: false });
});

test('user search requires actual user authority, stays tenant scoped and rejects revoked sessions', async () => {
  const manager = await account({ permissions: ['users.manage'] }); const foreign = await account({ permissions: ['users.read'] });
  assert.deepEqual(await search(foreign, manager.userId), { rows: [], hasMore: false });
  assert.deepEqual(await work(manager, (client, identity) => loadUserFieldUserOptions(client, { ...identity, organization_id: foreign.organizationId }, {})), { rows: [], hasMore: false });
  for (const permissions of [[], ['masters.read'], ['masters.manage']]) {
    const actor = await account({ organizationId: manager.organizationId, permissions });
    await assert.rejects(search(actor), { code: 'forbidden' });
    assert.deepEqual(await work(actor, (client, identity) => loadUserFieldUserOptions(client, { ...identity, permission_codes: ['users.read'] }, {})), { rows: [], hasMore: false });
  }
  assert.equal((await search(manager)).rows.some(row => row.id === manager.userId), true);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [manager.userId]);
  await assert.rejects(search(manager), { code: 'unauthenticated' });
});
