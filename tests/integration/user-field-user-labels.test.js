import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession, updateProfile } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadUserFieldUserLabels, saveUserCustomFields, loadUserCustomFields } from '../../src/users/custom-fields.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, operation, readOnly = true) => withSession(actor.token, operation, { readOnly });
async function account(options) { const person = await createAccount(owner, options); return { ...person, ...await signIn({ identifier: person.username, password: person.password }) }; }
const labels = (actor, ids) => work(actor, (client, identity) => loadUserFieldUserLabels(client, identity, { ids }));

test('selected labels preserve request order, deduplicate IDs and include inactive members without disclosing foreign or missing users', async () => {
  const reader = await account({ permissions: ['users.read'] });
  const first = await createAccount(owner, { organizationId: reader.organizationId, permissions: [] });
  const second = await createAccount(owner, { organizationId: reader.organizationId, permissions: [] });
  const foreign = await createAccount(owner, { permissions: [] });
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [reader.organizationId, first.userId]);
  await owner.query('UPDATE users SET active=false WHERE id=$1', [second.userId]);
  const result = await labels(reader, [second.userId.toUpperCase(), foreign.userId, first.userId, randomUUID(), second.userId]);
  assert.deepEqual(result, { rows: [{ id: second.userId, name: 'Synthetic Analyst' }, { id: first.userId, name: 'Synthetic Analyst' }] });
  assert.deepEqual(await labels(reader, [reader.userId]), { rows: [{ id: reader.userId, name: 'Synthetic Analyst' }] });
});

test('current selected names refresh after an actual profile edit while captured user observations remain frozen', async () => {
  const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] }); const selected = await account({ organizationId: author.organizationId, permissions: [] });
  const field = await work(author, (client, identity) => saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
    key: 'selected_people', label: 'Selected people', fieldType: 'multi_user_select', associatedWith: 'users' }), false);
  await work(manager, (client, identity) => saveUserCustomFields(client, identity, person.userId, { requestId: randomUUID(), revision: 0,
    customFields: [{ fieldId: field.id, fieldRevision: 1, value: [selected.userId] }] }), false);
  const captured = await work(manager, (client, identity) => loadUserCustomFields(client, identity, person.userId));
  assert.equal(captured.customFields[0].items[0].userName, 'Synthetic Analyst');
  await work(selected, client => updateProfile(client, { displayName: 'Current_selected/name', username: selected.username, revision: 1 }), false);
  assert.deepEqual(await labels(manager, [selected.userId]), { rows: [{ id: selected.userId, name: 'Current_selected/name' }] });
  assert.deepEqual(await work(manager, (client, identity) => loadUserCustomFields(client, identity, person.userId)), captured);
});

test('selected labels require actual user authority and retain the native organization and worker boundaries', async () => {
  const manager = await account({ permissions: ['users.manage'] });
  for (const permissions of [[], ['masters.read'], ['masters.manage']]) {
    const actor = await account({ organizationId: manager.organizationId, permissions });
    for (const ids of [[], [manager.userId]]) await assert.rejects(labels(actor, ids), { code: 'forbidden' });
  }
  const foreign = await account({ permissions: ['users.read'] }); assert.deepEqual(await labels(foreign, [manager.userId]), { rows: [] });
  assert.deepEqual(await work(manager, (client, identity) => loadUserFieldUserLabels(client, { ...identity, organization_id: foreign.organizationId }, { ids: [foreign.userId] })), { rows: [] });
  assert.equal((await owner.query("SELECT has_table_privilege('sampleify_report_worker','user_directory','SELECT') AS allowed")).rows[0].allowed, false);
});

test('empty and populated selected-label reads use a consistent read-only transaction and a revoked session cannot read either', async () => {
  const reader = await account({ permissions: ['users.read'] });
  for (const ids of [[], [reader.userId]]) await work(reader, async (client, identity) => {
    assert.deepEqual((await client.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only")).rows[0], { isolation: 'repeatable read', read_only: 'on' });
    let queries = 0; const result = await loadUserFieldUserLabels({ query(...args) { queries++; return client.query(...args); } }, identity, { ids });
    assert.equal(queries, ids.length ? 1 : 0); assert.equal(result.rows.length, ids.length);
  });
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [reader.userId]);
  for (const ids of [[], [reader.userId]]) await assert.rejects(labels(reader, ids), { code: 'unauthenticated' });
});
