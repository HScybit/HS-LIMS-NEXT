import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveBusinessUnit, loadBusinessUnit, listBusinessUnits } from '../../src/masters/business-units.js';
import { updateUserProfile, loadUserProfile, listUserProfileReferences } from '../../src/users/profiles.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['users.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
const work = (actor, action) => withSession(actor.token, action, { csrfToken: actor.csrfToken });
const command = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, code: 'UNIT-' + randomUUID(), name: 'Synthetic Unit', description: null, active: true, ...changes });
const save = (actor, input) => work(actor, (client, identity) => saveBusinessUnit(client, identity, input));
const load = (actor, id, options) => work(actor, (client, identity) => loadBusinessUnit(client, identity, id, options));
const list = (actor, input) => work(actor, (client, identity) => listBusinessUnits(client, identity, input));

test('unit authoring records actual editors, retains creation metadata and exact earlier retry', async () => {
  const actor = await account(); const input = command({ name: '  Quality  ', description: '  Testing  ' });
  const first = await save(actor, input); const created = await load(actor, first.id);
  assert.equal(first.revision, 1); assert.equal(first.name, 'Quality'); assert.equal(first.description, 'Testing');
  assert.equal(first.savedBy, actor.userId); assert.equal(first.previousRevision, null);
  const editor = await account({ organizationId: actor.organizationId });
  const second = await save(editor, { ...input, revision: 1, requestId: randomUUID(), name: 'Renamed', active: false });
  assert.equal(second.savedBy, editor.userId); assert.equal(second.previousRevision, 1);
  assert.deepEqual((await load(actor, first.id)).createdAt, created.createdAt);
  const retry = await save(actor, { ...input, id: input.id.toUpperCase(), requestId: input.requestId.toUpperCase() });
  assert.deepEqual(retry, first); assert.equal((await load(actor, first.id)).revision, 2);
  for (const change of [{ name: 'Changed' }, { id: randomUUID() }, { revision: 1 }, { active: false }]) await assert.rejects(save(actor, { ...input, ...change }), { code: 'save_request_reused' });
  await assert.rejects(save(editor, input), { code: 'save_request_reused' });
  await save(editor, { ...input, revision: 2, requestId: randomUUID() }); assert.equal((await load(actor, input.id)).active, true);
});

test('legacy supporting rows acquire only actual edit history without guessing the old editor', async () => {
  const actor = await account(); const id = randomUUID();
  await owner.query("INSERT INTO business_units(organization_id,id,code,name,created_at,updated_at) VALUES($1,$2::uuid,$2::text,'Legacy','2001-01-01','2001-01-02')", [actor.organizationId, id]);
  const before = await load(actor, id); const result = await save(actor, command({ id, revision: 1, code: before.code, name: before.name }));
  assert.equal(result.revision, 2); assert.equal(result.previousRevision, 1); assert.equal(result.savedBy, actor.userId);
  assert.deepEqual((await load(actor, id)).createdAt, before.createdAt);
  await assert.rejects(load(actor, id, { atRevision: 1 }), { status: 404 });
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM business_unit_versions WHERE organization_id=$1 AND unit_id=$2', [actor.organizationId, id])).rows[0].count, 1);
});

test('duplicate active and retired codes, missing records and stale edits roll back atomically', async () => {
  const actor = await account(); const input = command({ code: 'Case-01' }); await save(actor, input);
  await assert.rejects(save(actor, command({ code: 'case-01' })), { code: 'business_unit_code_exists' });
  await save(actor, { ...input, revision: 1, requestId: randomUUID(), active: false });
  await assert.rejects(save(actor, command({ code: 'CASE-01' })), { code: 'business_unit_code_exists' });
  await assert.rejects(save(actor, { ...input, revision: 1, requestId: randomUUID() }), { code: 'stale_business_unit' });
  await assert.rejects(save(actor, command({ revision: 1 })), { status: 404 });
  assert.equal((await load(actor, input.id)).revision, 2);
  assert.equal((await list(actor, {})).totalCount, 1);
});

test('concurrent identical requests converge and competing revisions have one winner', async () => {
  const actor = await account(); const input = command();
  const same = await Promise.all([save(actor, input), save(actor, input)]); assert.deepEqual(same[0], same[1]);
  const results = await Promise.allSettled(['First', 'Second'].map(name => save(actor, { ...input, requestId: randomUUID(), revision: 1, name })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'stale_business_unit');
  assert.equal((await load(actor, input.id)).revision, 2);
});

test('retirement preserves saved user unit labels and unchanged assignment, preventing new inactive choices', async () => {
  const actor = await account(); const person = await account({ organizationId: actor.organizationId, permissions: ['users.read'] });
  const input = command({ code: 'QUALITY', name: 'Original Unit' }); await save(actor, input); const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Unit test laboratory')", [actor.organizationId, lab]);
  await work(actor, (client, identity) => updateUserProfile(client, identity, person.userId, { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab, businessUnitId: input.id }));
  const original = await work(actor, (client, identity) => loadUserProfile(client, identity, person.userId));
  await save(actor, { ...input, revision: 1, requestId: randomUUID(), name: 'Retired Unit', active: false });
  assert.deepEqual(await work(actor, (client, identity) => loadUserProfile(client, identity, person.userId)), original);
  await work(actor, (client, identity) => updateUserProfile(client, identity, person.userId, { requestId: randomUUID(), revision: 1, phone: '123' }));
  assert.equal((await work(actor, (client, identity) => loadUserProfile(client, identity, person.userId, { atRevision: 1 }))).businessUnitName, 'Original Unit');
  const other = await account({ organizationId: actor.organizationId, permissions: ['users.read'] });
  await assert.rejects(work(actor, (client, identity) => updateUserProfile(client, identity, other.userId, { requestId: randomUUID(), revision: 0, defaultRoleId: other.roleId, laboratoryId: lab, businessUnitId: input.id })), { code: 'invalid_business_unit' });
  const references = await work(actor, (client, identity) => listUserProfileReferences(client, identity, { kind: 'businessUnits', selectedIds: [input.id] }));
  assert(references.rows.some(item => item.id === input.id && item.active === false));
});

test('bounded listing includes retired units, literal wildcards, column filters, sort and UTC DST day bounds', async () => {
  const actor = await account();
  for (const [name, active] of [['A %_\\ literal', false], ['B normal', true], ['C normal', true]]) await save(actor, command({ name, active }));
  const page = await list(actor, { pageSize: 1, page: 2, sort: { key: 'name', dir: 'asc' } });
  assert.equal(page.totalCount, 3); assert.equal(page.rows[0].name, 'B normal');
  assert.equal((await list(actor, { search: '%_\\' })).totalCount, 1);
  assert.equal((await list(actor, { filters: { active: { type: 'boolean', value: 'false' } } })).totalCount, 1);
  assert.equal((await list(actor, { filters: { name: { type: 'text', value: 'B normal' } } })).totalCount, 1);
  for (const day of ['2026-03-08', '2026-11-01']) {
    await owner.query("INSERT INTO business_units(organization_id,code,name,created_at) VALUES($1,$2,'Day end',$3)", [actor.organizationId, day, `${day}T23:59:59.999999Z`]);
    const result = await work(actor, async (client, identity) => { await client.query("SET LOCAL TIME ZONE 'America/New_York'"); return listBusinessUnits(client, identity, { filters: { created_at: { type: 'date', from: day, to: day } } }); });
    assert.equal(result.totalCount, 1);
  }
});

test('tenant, reader, direct SQL and immutable history guards retain private grants', async () => {
  const actor = await account(); const input = command(); await save(actor, input);
  const reader = await account({ organizationId: actor.organizationId, permissions: ['users.read'] }); const foreign = await account();
  assert.equal((await load(reader, input.id)).name, input.name);
  await assert.rejects(save(reader, command()), { status: 403 }); await assert.rejects(load(foreign, input.id), { status: 404 });
  assert.equal((await list(foreign, {})).totalCount, 0);
  for (const sql of ['SELECT * FROM business_units', 'SELECT * FROM business_unit_versions', 'DELETE FROM business_unit_versions', "UPDATE business_units SET revision=revision+1"]) await assert.rejects(work(actor, client => client.query(sql)), { code: '42501' });
  for (const sql of ['UPDATE business_unit_versions SET name=name', 'DELETE FROM business_unit_versions']) await assert.rejects(owner.query(sql + ' WHERE organization_id=$1', [actor.organizationId]), { code: '23514' });
  await assert.rejects(owner.query('UPDATE business_units SET revision=revision+1 WHERE organization_id=$1 AND id=$2', [actor.organizationId, input.id]), { code: '23514' });
  const grants = (await owner.query("SELECT has_table_privilege('sampleify_report_worker','business_unit_history','SELECT') AS worker_read,has_function_privilege('sampleify_report_worker','users_write_business_unit(uuid,integer,uuid,text,text,text,boolean)','EXECUTE') AS worker_write,has_function_privilege('public','users_write_business_unit(uuid,integer,uuid,text,text,text,boolean)','EXECUTE') AS public_write")).rows[0];
  assert.deepEqual(grants, { worker_read: false, worker_write: false, public_write: false });
});

test('write guard rejects a forged session context and account revocation after session acquisition', async () => {
  const actor = await account(); const other = await account();
  for (const [key, value] of [['organization_id', other.organizationId], ['user_id', other.userId], ['session_id', randomUUID()]]) {
    await assert.rejects(work(actor, async (client, identity) => {
      await client.query('SELECT set_config($1,$2,true)', ['app.' + key, value]);
      return saveBusinessUnit(client, identity, command());
    }), { status: 403 });
  }
  await assert.rejects(work(actor, async (client, identity) => {
    await owner.query('UPDATE users SET active=false WHERE id=$1', [actor.userId]);
    return saveBusinessUnit(client, identity, command());
  }), { status: 403 });
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM business_units WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 0);
});
