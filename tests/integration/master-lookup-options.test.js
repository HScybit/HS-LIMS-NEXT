import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveLookupSourceObservation, loadMasterFieldLookupOptions } from '../../src/custom-fields/lookup-sources.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
const original = [{ id: 'flat-A', label: 'Flat Alpha' }, { id: '0', label: 0 }, { id: 'false', label: false }];
async function fixture(kind, { sourceId = randomUUID(), lines = original } = {}) {
  const author = await account(); const reader = await account({ organizationId: author.organizationId, permissions: ['masters.read'] });
  const source = { id: sourceId, sourceId: 'Original-' + randomUUID(), revision: 0, requestId: randomUUID(), name: 'Configured master source', lines };
  await work(author, (c, i) => saveLookupSourceObservation(c, i, source));
  const definition = { id: randomUUID(), revision: 0, requestId: randomUUID(), associatedWith: kind, key: 'place', label: 'Place', fieldType: 'lookup', lookupSourceId: sourceId };
  const field = await work(author, (c, i) => saveCustomField(c, i, definition));
  const read = (input = {}, actor = reader) => work(actor, (c, i) => loadMasterFieldLookupOptions(kind, c, i, { sourceId, ...input }), true);
  return { author, reader, source, sourceId, definition, field, read };
}
for (const kind of ['product', 'parameter']) {
  test(`${kind} lookup catalogs require a current bound source and current master read authority`, async () => {
    const f = await fixture(kind);
    const expected = { organizationId: f.author.organizationId, sourceId: f.sourceId, revision: 1, options: original.map(line => ({ value: line.id, label: line.label })) };
    assert.deepEqual(await f.read(), expected); assert.deepEqual(await f.read({}, f.author), expected);
    assert.deepEqual(await work(f.reader, (c, i) => loadMasterFieldLookupOptions(kind === 'product' ? 'parameter' : 'product', c, i, { sourceId: f.sourceId }), true),
      { organizationId: f.author.organizationId, sourceId: f.sourceId, revision: null, options: [] });
    const userManager = await account({ organizationId: f.author.organizationId, permissions: ['users.manage'] });
    await assert.rejects(f.read({}, userManager), { status: 403 });
    await work(f.author, (c, i) => retireCustomField(c, i, { id: f.field.id, revision: 1, requestId: randomUUID() }));
    assert.deepEqual(await f.read({ revision: 1, knownOrganizationId: f.author.organizationId }), { organizationId: f.author.organizationId, sourceId: f.sourceId, revision: null, options: [] });
    await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.reader.organizationId, f.reader.roleId]);
    await assert.rejects(f.read(), { status: 403 });
    await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1', [f.author.userId]);
    await assert.rejects(f.read({}, f.author), { status: 401 });
  });
  test(`${kind} full catalog boundaries, empty observations and conditional refresh retain exact ordered choices`, async () => {
    const lines = Array.from({ length: 10000 }, (_, index) => ({ id: `original-${index}`, label: `Label ${index}` }));
    lines[0].label = 0; lines[1].label = false;
    const f = await fixture(kind, { lines });
    assert.deepEqual((await f.read()).options, lines.map(line => ({ value: line.id, label: line.label })));
    assert.deepEqual(await f.read({ revision: 1, knownOrganizationId: f.author.organizationId }), { organizationId: f.author.organizationId, sourceId: f.sourceId, revision: 1, unchanged: true });
    await work(f.author, (c, i) => saveLookupSourceObservation(c, i, { ...f.source, revision: 1, requestId: randomUUID(), lines: [] }));
    assert.deepEqual(await f.read({ revision: 1, knownOrganizationId: f.author.organizationId }), { organizationId: f.author.organizationId, sourceId: f.sourceId, revision: 2, options: [] });
    assert.deepEqual(await f.read({ revision: 2, knownOrganizationId: f.author.organizationId }), { organizationId: f.author.organizationId, sourceId: f.sourceId, revision: 2, unchanged: true });
  });
  test(`${kind} catalog identities and cached revisions cannot cross organizations`, async () => {
    const f = await fixture(kind); const other = await fixture(kind, { sourceId: f.sourceId, lines: [{ id: 'flat-A', label: 'Other organization' }] });
    const actual = await other.read({ revision: 1, knownOrganizationId: f.author.organizationId });
    assert.equal(actual.organizationId, other.author.organizationId); assert.deepEqual(actual.options, [{ value: 'flat-A', label: 'Other organization' }]);
    const foreign = await account();
    assert.deepEqual(await f.read({}, foreign), { organizationId: foreign.organizationId, sourceId: f.sourceId, revision: null, options: [] });
    assert.equal((await work(f.reader, (c, i) => c.query('SELECT 1 FROM custom_field_lookup_lines WHERE organization_id=$1', [other.author.organizationId]), true)).rowCount, 0);
  });
  test(`${kind} catalog reads keep the probed complete observation when a source changes between queries`, async () => {
    const f = await fixture(kind); let count = 0;
    const first = await work(f.reader, (client, identity) => loadMasterFieldLookupOptions(kind, { async query(...args) {
      const result = await client.query(...args);
      if (++count === 1) await work(f.author, (c, i) => saveLookupSourceObservation(c, i, { ...f.source, revision: 1, requestId: randomUUID(), lines: [{ id: 'next', label: 'Next observation' }] }));
      return result;
    } }, identity, { sourceId: f.sourceId }), true);
    assert.equal(count, 2); assert.equal(first.revision, 1); assert.deepEqual(first.options, original.map(line => ({ value: line.id, label: line.label })));
    assert.deepEqual((await f.read({ revision: 1, knownOrganizationId: f.author.organizationId })).options, [{ value: 'next', label: 'Next observation' }]);
  });
}
