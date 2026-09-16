import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveMaterialCategory, loadMaterialCategory, listMaterialCategories, retireMaterialCategory } from '../../src/masters/material-categories.js';

const owner = ownerPool();
const work = (actor, callback) => withSession(actor.token, callback, { csrfToken: actor.csrfToken });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
const command = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: `Synthetic category ${randomUUID()}`, description: '', reusable: false, expirable: false, ...changes });
const save = (actor, input) => work(actor, (client, identity) => saveMaterialCategory(client, identity, input));
const load = (actor, id, options) => work(actor, (client, identity) => loadMaterialCategory(client, identity, id, options));
const list = (actor, input) => work(actor, (client, identity) => listMaterialCategories(client, identity, input));
const retire = (actor, input) => work(actor, (client, identity) => retireMaterialCategory(client, identity, input));
after(async () => { await closePool(); await owner.end(); });

test('material category authoring records actual editors and preserves creation metadata', async () => {
  const creator = await account(); const input = command({ name: '  Reference materials  ', description: '  Calibration  ', reusable: true });
  const created = await save(creator, input);
  assert.equal(created.name, 'Reference materials'); assert.equal(created.description, 'Calibration');
  assert.equal(created.revision, 1); assert.equal(created.createdBy, creator.userId); assert.equal(created.updatedBy, creator.userId);
  const editor = await account({ organizationId: creator.organizationId });
  const updated = await save(editor, { ...input, requestId: randomUUID(), revision: 1, name: 'Reference materials', description: '', reusable: false, expirable: true });
  assert.equal(updated.revision, 2); assert.equal(updated.createdBy, creator.userId); assert.equal(updated.updatedBy, editor.userId);
  assert.deepEqual(updated.createdAt, created.createdAt); assert.equal(updated.description, ''); assert.equal(updated.expirable, true);
  const first = await load(editor, created.id, { atRevision: 1 }); const second = await load(editor, created.id, { atRevision: 2 });
  assert.equal(first.savedBy, creator.userId); assert.equal(first.operation, 'create'); assert.equal(first.previousRevision, null); assert.equal(first.reusable, true);
  assert.equal(second.savedBy, editor.userId); assert.equal(second.operation, 'update'); assert.equal(second.previousRevision, 1); assert.equal(second.reusable, false);
});

test('material category retries return the original version and reject a changed payload or actor', async () => {
  const actor = await account(); const input = command(); const created = await save(actor, input);
  await save(actor, { ...input, requestId: randomUUID(), revision: 1, description: 'Later revision' });
  const retried = await save(actor, { ...input, id: input.id.toUpperCase(), requestId: input.requestId.toUpperCase() });
  assert.equal(retried.revision, 1); assert.equal(retried.description, '');
  for (const changes of [{ description: 'Changed' }, { id: randomUUID() }, { revision: 1 }]) await assert.rejects(save(actor, { ...input, ...changes }), { code: 'save_request_reused' });
  const other = await account({ organizationId: actor.organizationId });
  await assert.rejects(save(other, input), { code: 'save_request_reused' });
  assert.equal((await load(actor, created.id)).revision, 2);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM material_category_versions WHERE organization_id=$1 AND category_id=$2', [actor.organizationId, created.id])).rows[0].count, 2);
});

test('material category name uniqueness and stale revisions remain atomic under concurrent saves', async () => {
  const actor = await account(); const input = command({ name: 'Exact.Name (A)' }); const created = await save(actor, input);
  await assert.rejects(save(actor, command({ name: ' exact.name (a) ' })), { code: 'material_category_name_exists' });
  await save(actor, command({ name: 'ExactXName (A)' }));
  const other = await account(); await save(other, command({ name: input.name }));
  const results = await Promise.allSettled(['First', 'Second'].map(description => save(actor, { ...input, requestId: randomUUID(), revision: 1, description })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'stale_material_category');
  assert.equal((await load(actor, created.id)).revision, 2);
  const creates = await Promise.allSettled(['Concurrent', 'CONCURRENT'].map(name => save(actor, command({ name }))));
  assert.equal(creates.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(creates.find(result => result.status === 'rejected').reason.code, 'material_category_name_exists');
});

test('material category retirement preserves history, supports retries and permits a new category with the old name', async () => {
  const actor = await account(); const input = command({ reusable: true, expirable: true }); const created = await save(actor, input);
  const request = { id: created.id, revision: created.revision, requestId: randomUUID() };
  const removed = await retire(actor, request); assert.equal(removed.revision, 2); assert.deepEqual(await retire(actor, request), removed);
  await assert.rejects(load(actor, created.id), { code: 'material_category_not_found' }); assert.equal((await list(actor)).totalCount, 0);
  const history = await load(actor, created.id, { atRevision: 2 }); assert.equal(history.operation, 'retire'); assert.equal(history.active, false);
  assert.equal(history.name, input.name); assert.equal(history.reusable, true); assert.equal(history.expirable, true);
  assert.equal((await save(actor, input)).revision, 1);
  const replacement = await save(actor, command({ name: input.name })); assert.notEqual(replacement.id, created.id); assert.equal((await list(actor)).totalCount, 1);
  await assert.rejects(save(actor, { ...input, revision: 2, requestId: randomUUID() }), { code: 'material_category_not_found' });
});

test('material category read and write permissions isolate current and historical data', async () => {
  const manager = await account(); const category = await save(manager, command());
  const reader = await account({ organizationId: manager.organizationId, permissions: ['masters.read'] });
  assert.equal((await load(reader, category.id)).id, category.id); assert.equal((await load(reader, category.id, { atRevision: 1 })).id, category.id);
  assert.equal((await list(reader)).totalCount, 1);
  await assert.rejects(save(reader, command()), { code: 'forbidden' });
  await assert.rejects(retire(reader, { id: category.id, revision: 1, requestId: randomUUID() }), { code: 'forbidden' });
  const foreign = await account(); assert.equal((await list(foreign)).totalCount, 0);
  for (const options of [undefined, { atRevision: 1 }]) await assert.rejects(load(foreign, category.id, options), { code: 'material_category_not_found' });
  assert.equal((await work(foreign, client => client.query('SELECT * FROM material_categories WHERE id=$1', [category.id]))).rowCount, 0);
  assert.equal((await work(foreign, client => client.query('SELECT * FROM material_category_versions WHERE category_id=$1', [category.id]))).rowCount, 0);
  await assert.rejects(work(reader, client => client.query('INSERT INTO material_categories(organization_id,name) VALUES($1,$2)', [reader.organizationId, 'Forbidden'])), { code: '42501' });
  await assert.rejects(work(manager, client => client.query('DELETE FROM material_categories WHERE organization_id=$1 AND id=$2', [manager.organizationId, category.id])), { code: '42501' });
});

test('material category guards reject forged metadata, revision gaps, retired changes and historical rewrites', async () => {
  const actor = await account(); const other = await account({ organizationId: actor.organizationId }); const category = await save(actor, command());
  for (const overrides of [{ revision: 'category.revision+2' }, { updated_at: "'2001-01-01'::timestamptz" },
    { created_by: 'supplied.other_actor' }, { updated_by: 'supplied.other_actor' }, { save_request_id: 'NULL' }, { active: 'false', name: "category.name||'changed'" }]) {
    const assignments = { revision: 'category.revision+1', updated_at: 'transaction_timestamp()', updated_by: 'supplied.actor', save_request_id: 'supplied.request_id', ...overrides };
    await assert.rejects(work(actor, client => client.query(`WITH supplied AS (SELECT $1::uuid AS organization_id,$2::uuid AS category_id,$3::uuid AS actor,$4::uuid AS request_id,$5::uuid AS other_actor)
      UPDATE material_categories category SET ${Object.entries(assignments).map(([key, value]) => `${key}=${value}`).join(',')}
      FROM supplied WHERE category.organization_id=supplied.organization_id AND category.id=supplied.category_id`,
    [actor.organizationId, category.id, actor.userId, randomUUID(), other.userId])), { code: '23514' });
  }
  await assert.rejects(work(actor, client => client.query('UPDATE material_category_versions SET name=$3 WHERE organization_id=$1 AND category_id=$2', [actor.organizationId, category.id, 'Forged'])), { code: '42501' });
  await assert.rejects(owner.query('UPDATE material_category_versions SET name=$3 WHERE organization_id=$1 AND category_id=$2', [actor.organizationId, category.id, 'Owner rewrite']), { code: '55000' });
  assert.equal((await load(actor, category.id)).revision, 1);
  await retire(actor, { id: category.id, revision: 1, requestId: randomUUID() });
  await assert.rejects(work(actor, client => client.query('UPDATE material_categories SET active=true,revision=revision+1,updated_at=transaction_timestamp(),updated_by=$3,save_request_id=$4 WHERE organization_id=$1 AND id=$2',
    [actor.organizationId, category.id, actor.userId, randomUUID()])), { code: '23514' });
});

test('material category listing keeps literal search, filters, stable paging and an empty-page total', async () => {
  const actor = await account();
  for (const input of [command({ name: 'Alpha 100%_unit', description: 'First long label', reusable: true }),
    command({ name: 'Beta', description: 'Second label', expirable: true }), command({ name: 'Gamma', description: 'First separate long label' })]) await save(actor, input);
  assert.equal((await list(actor, { search: '%_unit' })).totalCount, 1);
  assert.equal((await list(actor, { search: "' OR true --" })).totalCount, 0);
  assert.equal((await list(actor, { filters: { description: { type: 'text', value: 'First long' } } })).totalCount, 2);
  assert.equal((await list(actor, { filters: { reusable: { type: 'boolean', value: 'true' }, expirable: { type: 'boolean', value: 'false' } } })).totalCount, 1);
  const first = await list(actor, { page: 1, pageSize: 2, sort: { key: 'name', dir: 'asc' } });
  const second = await list(actor, { page: 2, pageSize: 2, sort: { key: 'name', dir: 'asc' } });
  assert.deepEqual([...first.rows, ...second.rows].map(row => row.name), ['Alpha 100%_unit', 'Beta', 'Gamma']);
  const empty = await list(actor, { page: 999, pageSize: 10 }); assert.equal(empty.rows.length, 0); assert.equal(empty.totalCount, 3);
});

test('material category date filtering includes the full UTC day and preserves historical microseconds', async () => {
  const actor = await account(); const ids = [];
  for (const [index, date] of ['2026-09-15T23:59:59.999999Z', '2026-09-16T00:00:00Z', '2026-09-16T23:59:59.999999Z', '2026-09-17T00:00:00Z'].entries()) {
    const id = randomUUID(); ids.push(id);
    await owner.query('INSERT INTO material_categories(organization_id,id,name,created_at,updated_at) VALUES($1,$2,$3,$4,$4)', [actor.organizationId, id, `Date ${index}`, date]);
  }
  const result = await list(actor, { filters: { created_at: { type: 'date', from: '2026-09-16', to: '2026-09-16' } }, sort: { key: 'created_at', dir: 'asc' } });
  assert.deepEqual(result.rows.map(row => row._id), ids.slice(1, 3));
  assert.equal((await owner.query("SELECT to_char(created_at AT TIME ZONE 'UTC','US') AS microseconds FROM material_categories WHERE organization_id=$1 AND id=$2", [actor.organizationId, ids[2]])).rows[0].microseconds, '999999');
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM material_category_versions WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 0);
});

for (const [before, day, afterDay] of [['2026-03-07', '2026-03-08', '2026-03-09'], ['2026-10-31', '2026-11-01', '2026-11-02']]) {
  test(`UTC category date boundaries survive a non-UTC session across ${day}`, async () => {
    const actor = await account(); const ids = [];
    for (const [index, instant] of [`${before}T23:59:59.999999Z`, `${day}T00:00:00Z`, `${day}T23:59:59.999999Z`, `${afterDay}T00:00:00Z`].entries()) {
      const id = randomUUID(); ids.push(id);
      await owner.query('INSERT INTO material_categories(organization_id,id,name,created_at,updated_at) VALUES($1,$2,$3,$4,$4)', [actor.organizationId, id, `DST boundary ${index}`, instant]);
    }
    const result = await work(actor, async (client, identity) => {
      await client.query("SET LOCAL TIME ZONE 'America/New_York'");
      return listMaterialCategories(client, identity, { filters: { created_at: { type: 'date', from: day, to: day } }, sort: { key: 'created_at', dir: 'asc' } });
    });
    assert.deepEqual(result.rows.map(row => row._id), ids.slice(1, 3));
    assert.equal(result.totalCount, 2);
  });
}
