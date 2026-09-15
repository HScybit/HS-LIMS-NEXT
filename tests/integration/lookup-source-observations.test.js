import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { loadLookupSourceObservation, saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { saveCustomField, loadCustomField, retireCustomField, userCustomFields } from '../../src/masters/custom-fields.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const input = changes => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, sourceId: 'Master-' + randomUUID(),
  name: 'Observed source', lines: [{ id: 'Root_ID', label: 'Root' }, { id: 'child-id', label: 'Child' }], ...changes });
async function account(options) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function fixture() {
  const author = await account({ permissions: ['masters.manage'] });
  const reader = await account({ organizationId: author.organizationId, permissions: ['masters.read'] });
  const users = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  return { author, reader, users, save: value => work(author, (c, i) => saveLookupSourceObservation(c, i, value)),
    load: (id, options) => work(reader, (c, i) => loadLookupSourceObservation(c, i, id, options), true) };
}

test('observations retain typed flat identities, ordering and historical labels after replacement and clear', async () => {
  const f = await fixture(); const original = input({ lines: [{ id: 'Root_ID', label: 0 }, { id: 'root_id', label: false }, { id: '__proto__', label: '' }, { id: 'child-id', label: '  Exact\n' }] });
  const first = await f.save(original); assert.equal(first.revision, 1); assert.equal(first.sourceId, original.sourceId); assert.equal(first.observedBy, f.author.userId);
  assert.deepEqual(first.lines, original.lines); assert(first.observedAt instanceof Date); assert.deepEqual(await f.load(original.id), first);
  const second = await f.save({ ...original, requestId: randomUUID(), revision: 1, lines: [{ id: 'child-id', label: 'Changed' }] });
  assert.equal(second.previousRevision, 1); assert.deepEqual(second.lines, [{ id: 'child-id', label: 'Changed' }]);
  assert.deepEqual(await f.load(original.id, { atRevision: 1 }), first);
  await f.save({ ...original, requestId: randomUUID(), revision: 2, lines: [] });
  assert.deepEqual((await f.load(original.id)).lines, []); assert.deepEqual(await f.load(original.id, { atRevision: 2 }), second);
  await assert.rejects(f.load(original.id, { atRevision: 4 }), { code: 'lookup_source_not_found' });
});

test('exact observation retries survive later revisions and reject payload, actor and source identity changes', async () => {
  const f = await fixture(); const original = input(); const first = await f.save(original);
  await f.save({ ...original, revision: 1, requestId: randomUUID(), name: 'Later', lines: [] });
  assert.deepEqual(await f.save(original), first); assert.equal((await f.load(original.id)).revision, 2);
  for (const changes of [{ name: 'Wrong' }, { lines: [...original.lines].reverse() }, { sourceId: original.sourceId.toLowerCase() }, { id: randomUUID() }, { revision: 1 }]) {
    await assert.rejects(f.save({ ...original, ...changes }), { code: 'save_request_reused' });
  }
  const other = await account({ organizationId: f.author.organizationId, permissions: ['masters.manage'] });
  await assert.rejects(work(other, (c, i) => saveLookupSourceObservation(c, i, original)), { code: 'save_request_reused' });
  await assert.rejects(f.save({ ...original, requestId: randomUUID(), revision: 2, sourceId: 'changed' }), { code: 'lookup_source_identity_changed' });
  await assert.rejects(f.save({ ...original, id: randomUUID(), requestId: randomUUID() }), { code: 'duplicate_lookup_source' });
  const concurrent = await Promise.allSettled([f.save({ ...original, revision: 2, requestId: randomUUID(), name: 'A' }), f.save({ ...original, revision: 2, requestId: randomUUID(), name: 'B' })]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'stale_lookup_source');
});

test('lookup scope does not give user managers, foreign tenants or workers master catalog access', async () => {
  const f = await fixture(); const original = input(); await f.save(original);
  const foreign = await account({ permissions: ['masters.manage'] });
  await assert.rejects(work(foreign, (c, i) => loadLookupSourceObservation(c, i, original.id), true), { code: 'lookup_source_not_found' });
  await assert.rejects(work(f.users, (c, i) => loadLookupSourceObservation(c, i, original.id), true), { code: 'forbidden' });
  await assert.rejects(work(f.reader, (c, i) => saveLookupSourceObservation(c, i, input())), { code: 'forbidden' });
  for (const actor of [f.users, foreign]) await work(actor, async c => {
    for (const table of ['custom_field_lookup_sources', 'custom_field_lookup_versions', 'custom_field_lookup_lines']) {
      assert.equal((await c.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [f.author.organizationId])).rowCount, 0);
    }
  }, true);
  assert.equal((await getPool().query('SELECT * FROM custom_field_lookup_sources')).rowCount, 0);
  const worker = (await owner.query(`SELECT has_table_privilege('sampleify_report_worker','custom_field_lookup_sources','SELECT') AS sources,
    has_table_privilege('sampleify_report_worker','custom_field_lookup_versions','SELECT') AS versions,
    has_table_privilege('sampleify_report_worker','custom_field_lookup_lines','SELECT') AS lines,
    has_function_privilege('sampleify_app','masters_assert_lookup_lines(uuid,uuid,integer)','EXECUTE') AS helper`)).rows[0];
  assert.deepEqual(worker, { sources: false, versions: false, lines: false, helper: false });
  await assert.rejects(work(foreign, (c, i) => saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0,
    key: 'lookup', label: 'Lookup', associatedWith: 'users', fieldType: 'lookup', lookupSourceId: original.id })), { code: 'invalid_custom_field_lookup_source' });
});

test('source and history guards reject mutation, missing lines, fabricated observations and foreign bindings', async () => {
  const f = await fixture(); const original = input(); await f.save(original);
  for (const table of ['custom_field_lookup_lines', 'custom_field_lookup_versions']) {
    await assert.rejects(owner.query(`UPDATE ${table} SET revision=revision WHERE organization_id=$1 AND source_id=$2`, [f.author.organizationId, original.id]), { code: '55000' });
    await assert.rejects(owner.query(`DELETE FROM ${table} WHERE organization_id=$1 AND source_id=$2`, [f.author.organizationId, original.id]), { code: '55000' });
  }
  await assert.rejects(owner.query('DELETE FROM custom_field_lookup_sources WHERE organization_id=$1 AND id=$2', [f.author.organizationId, original.id]), { code: '23503', constraint: 'custom_lookup_version_source_fk' });
  await assert.rejects(work(f.author, async (c, i) => {
    await c.query(`UPDATE custom_field_lookup_sources SET revision=revision+1,request_id=$3,updated_at=transaction_timestamp(),line_count=2
      WHERE organization_id=$1 AND id=$2`, [i.organization_id, original.id, randomUUID()]);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  }), { code: '23514', constraint: 'custom_lookup_complete' });
  await assert.rejects(work(f.author, (c, i) => c.query(`UPDATE custom_field_lookup_sources SET revision=revision+1,request_id=$3,updated_at=transaction_timestamp(),original_source_id='forged'
    WHERE organization_id=$1 AND id=$2`, [i.organization_id, original.id, randomUUID()])), { code: '23514' });
  await assert.rejects(work(f.author, (c, i) => c.query(`INSERT INTO custom_field_lookup_lines(organization_id,source_id,revision,original_line_id,position,label_kind,label_text)
    VALUES($1,$2,1,'late',2,'text','Late')`, [i.organization_id, original.id])), { code: '23514' });
  await assert.rejects(work(f.author, (c, i) => c.query(`INSERT INTO custom_field_lookup_versions(organization_id,source_id,revision,previous_revision,request_id,name,line_count,observed_by)
    VALUES($1,$2,2,1,$3,'Forged',0,$4)`, [i.organization_id, original.id, randomUUID(), i.user_id])), { code: '42501' });
  const foreign = await account({ permissions: ['masters.manage'] }); const remote = input();
  await work(foreign, (c, i) => saveLookupSourceObservation(c, i, remote));
  await assert.rejects(work(f.author, (c, i) => c.query(`INSERT INTO custom_field_definitions(organization_id,id,key,label,associated_with,save_request_id,lookup_source_id)
    VALUES($1,$2,'foreign','Foreign','users',$3,$4)`, [i.organization_id, randomUUID(), randomUUID(), remote.id])), { code: '23503' });
  assert.equal((await f.load(original.id)).revision, 1);
});

test('definition observations preserve hidden bindings, old retries and historical associations without widening user reads', async () => {
  const f = await fixture(); const source = input(); await f.save(source);
  const save = value => work(f.author, (c, i) => saveCustomField(c, i, value));
  const definition = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'lookup', label: 'Lookup', associatedWith: 'users', fieldType: 'lookup', lookupSourceId: source.id };
  const first = await save(definition); assert.equal(first.lookupSourceId, source.id);
  const { lookupSourceId: _binding, ...omitted } = { ...definition, revision: 1, requestId: randomUUID(), fieldType: 'text' };
  const second = await save(omitted); assert.equal(second.lookupSourceId, source.id);
  await save({ ...omitted, revision: 2, requestId: randomUUID(), lookupSourceId: null });
  assert.deepEqual(await save(omitted), second); assert.deepEqual(await save(definition), first);
  const listed = await work(f.users, (c, i) => userCustomFields(c, i), true); assert.equal(listed[0].lookupSourceId, null);
  const third = await work(f.author, (c, i) => loadCustomField(c, i, definition.id), true); assert.equal(third.lookupSourceId, null);
  await save({ ...definition, revision: 3, requestId: randomUUID(), fieldType: 'lookup' });
  assert.equal((await work(f.users, (c, i) => userCustomFields(c, i), true))[0].lookupSourceId, source.id);
  await work(f.author, (c, i) => retireCustomField(c, i, { id: definition.id, revision: 4, requestId: randomUUID() }));
  const retired = await work(f.author, (c, i) => loadCustomField(c, i, definition.id, { atRevision: 5 }), true); assert.equal(retired.lookupSourceId, source.id);
  assert.deepEqual(await work(f.users, (c, i) => userCustomFields(c, i), true), []);
});
