import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { loadUserFieldLookupOptions } from '../../src/users/custom-fields.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options) { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; }
async function fixture(sourceId = randomUUID(), lines = [{ id: 'original-A', label: 'Alpha' }]) {
  const author = await account({ permissions: ['masters.manage'] });
  const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
  const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const input = { id: sourceId, requestId: randomUUID(), revision: 0, sourceId: 'Original-options-' + randomUUID(), name: 'User options source', lines };
  await work(author, (c, i) => saveLookupSourceObservation(c, i, input)); let revision = 1;
  const definition = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'lookup_key', label: 'Lookup field', fieldType: 'lookup', associatedWith: 'users', lookupSourceId: sourceId };
  await work(author, (c, i) => saveCustomField(c, i, definition));
  return { sourceId, author, reader, manager, definition,
    observe: async nextLines => { const result = await work(author, (c, i) => saveLookupSourceObservation(c, i, { ...input, requestId: randomUUID(), revision, lines: nextLines })); revision = result.revision; return result; },
    load: (changes = {}, actor = reader) => work(actor, (c, i) => loadUserFieldLookupOptions(c, i, { sourceId, ...changes }), true) };
}

test('current lookup choices retain full original order and exact primitive labels under user authority', async () => {
  const lines = [{ id: 'parent', label: 'Parent' }, { id: 'original-child', label: 'Élodie / 子' }, { id: '0', label: 0 }, { id: 'false', label: false }, { id: 'blank', label: '' }];
  const f = await fixture(undefined, lines); const expected = { organizationId: f.author.organizationId, sourceId: f.sourceId, revision: 1,
    options: lines.map(line => ({ value: line.id, label: line.label })) };
  assert.deepEqual(await f.load(), expected); assert.deepEqual(await f.load({}, f.manager), expected);
  assert.deepEqual(await f.load({ revision: 1, knownOrganizationId: f.author.organizationId }), { organizationId: f.author.organizationId, sourceId: f.sourceId, revision: 1, unchanged: true });
  await assert.rejects(f.load({}, f.author), { code: 'forbidden' });
});

test('cleared observations and removed bindings invalidate caches while remaining user bindings keep a catalog available', async () => {
  const f = await fixture(); const known = { revision: 1, knownOrganizationId: f.author.organizationId };
  await f.observe([]); assert.deepEqual((await f.load(known)).options, []); assert.equal((await f.load()).revision, null);
  await f.observe([{ id: 'original-A', label: 'New Alpha' }]); const restored = await f.load(known);
  assert.equal(restored.revision, 3); assert.deepEqual(restored.options, [{ value: 'original-A', label: 'New Alpha' }]);
  const second = { ...f.definition, id: randomUUID(), key: 'second_key', requestId: randomUUID() };
  await work(f.author, (c, i) => saveCustomField(c, i, second));
  await work(f.author, (c, i) => saveCustomField(c, i, { ...f.definition, revision: 1, requestId: randomUUID(), associatedWith: 'product' }));
  assert.deepEqual((await f.load()).options, restored.options);
  await work(f.author, (c, i) => retireCustomField(c, i, { id: second.id, revision: 1, requestId: randomUUID() }));
  assert.deepEqual((await f.load({ revision: 3, knownOrganizationId: f.author.organizationId })).options, []);
});

test('tenant-scoped source IDs never reuse another organization cache or bypass actual session and view authority', async () => {
  const id = randomUUID(); const a = await fixture(id); const b = await fixture(id, [{ id: 'original-A', label: 'Other organization' }]);
  const changed = await b.load({ revision: 1, knownOrganizationId: a.author.organizationId });
  assert.equal(changed.organizationId, b.author.organizationId); assert.deepEqual(changed.options, [{ value: 'original-A', label: 'Other organization' }]);
  assert.deepEqual((await a.load({ sourceId: randomUUID() })).options, []);
  await work(a.reader, async (c, i) => {
    assert.deepEqual((await loadUserFieldLookupOptions(c, { ...i, organization_id: b.author.organizationId }, { sourceId: id })).options, []);
    await c.query("SELECT set_config('app.organization_id',$1,true)", [b.author.organizationId]);
    assert.deepEqual((await loadUserFieldLookupOptions(c, i, { sourceId: id })).options, []);
  }, true);
  await work(a.author, async (c, i) => assert.deepEqual((await loadUserFieldLookupOptions(c, { ...i, permission_codes: ['users.read'] }, { sourceId: id })).options, []), true);
  assert.equal((await getPool().query('SELECT 1 FROM user_custom_field_lookup_lines')).rowCount, 0);
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [a.manager.organizationId, a.manager.roleId]);
  await assert.rejects(a.load({}, a.manager), { code: 'forbidden' });
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [a.reader.userId]); await assert.rejects(a.load(), { status: 401 });
});

test('repeatable reads keep the complete catalog at the probed observation while a source changes between statements', async () => {
  const f = await fixture(); let queries = 0;
  const original = await work(f.reader, async (c, i) => {
    assert.equal((await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read');
    assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    return loadUserFieldLookupOptions({ async query(...args) {
      const result = await c.query(...args); if (++queries === 1) await f.observe([{ id: 'replacement', label: 'Replacement' }]); return result;
    } }, i, { sourceId: f.sourceId });
  }, true);
  assert.equal(queries, 2); assert.equal(original.revision, 1); assert.deepEqual(original.options, [{ value: 'original-A', label: 'Alpha' }]);
  const current = await f.load(); assert.equal(current.revision, 2); assert.deepEqual(current.options, [{ value: 'replacement', label: 'Replacement' }]);
});
