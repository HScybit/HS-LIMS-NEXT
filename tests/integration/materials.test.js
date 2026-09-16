import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveMaterialCategory, retireMaterialCategory } from '../../src/masters/material-categories.js';
import { createMaterialTransaction, loadMaterial, loadMaterialTransaction, retireMaterial, saveMaterial } from '../../src/materials/service.js';
import { checkIncomingMaterialBatch, listMaterials, listMaterialTransactions, materialChoices } from '../../src/materials/listing.js';

const owner = ownerPool();
const work = (actor, callback) => withSession(actor.token, callback, { csrfToken: actor.csrfToken });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function setup({ actor, expirable = false, initialQuantity = '0', maximumQuantity } = {}) {
  actor ??= await account();
  const categoryInput = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: `Synthetic material category ${randomUUID()}`, expirable };
  const category = await work(actor, (client, identity) => saveMaterialCategory(client, identity, categoryInput));
  const unit = (await owner.query(`INSERT INTO measurement_units(organization_id,code,name,symbol) VALUES($1,$2,'Grams','g') RETURNING id`, [actor.organizationId, randomUUID()])).rows[0];
  const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic material', code: randomUUID(), description: '', categoryId: category.id,
    measurementUnitId: unit.id, initialQuantity, minimumQuantity: '0', ...(maximumQuantity === undefined ? {} : { maximumQuantity }) };
  const material = await save(actor, input);
  return { actor, category, categoryInput, unit, input, material };
}
const save = (actor, input) => work(actor, (client, identity) => saveMaterial(client, identity, input));
const load = (actor, id, options) => work(actor, (client, identity) => loadMaterial(client, identity, id, options));
const remove = (actor, input) => work(actor, (client, identity) => retireMaterial(client, identity, input));
const transaction = (materialId, changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), materialId, type: 'in', quantity: '1', cost: '0', supplier: 'Supplier', batchSerialNumber: randomUUID(), ...changes });
const post = (actor, input) => work(actor, (client, identity) => createMaterialTransaction(client, identity, input));
const count = async (table, materialId) => Number((await owner.query(`SELECT count(*) FROM ${table} WHERE material_id=$1`, [materialId])).rows[0].count);
after(async () => { await closePool(); await owner.end(); });

test('materials preserve precise opening quantities, actual history, omitted maxima and original retries after retirement', async () => {
  const { actor, input, material } = await setup({ initialQuantity: '1.2500000001' });
  assert.equal(material.initialQuantity, '1.2500000001'); assert.equal(material.currentQuantity, '1.2500000001');
  assert.equal(material.initialStockCreatedBy, actor.userId); assert.equal(material.createdBy, actor.userId); assert.ok(material.initialStockId);
  const update = { ...input, requestId: randomUUID(), revision: 1, maximumQuantity: '5.0000000001', description: 'Updated' };
  const second = await save(actor, update); assert.equal(second.revision, 2); assert.equal(second.initialStockId, material.initialStockId);
  const third = await save(actor, { ...input, requestId: randomUUID(), revision: 2, description: 'Retained maximum' });
  assert.equal(third.maximumQuantity, '5.0000000001'); assert.deepEqual(third.createdAt, material.createdAt);
  assert.equal((await save(actor, { ...input, initialQuantity: '12500000001e-10' })).revision, 1);
  await assert.rejects(save(actor, { ...update, maximumQuantity: undefined }), { code: 'save_request_reused' });
  await assert.rejects(save(actor, { ...input, revision: 1, requestId: randomUUID() }), { code: 'stale_material' });
  const retirement = { id: material.id, revision: 3, requestId: randomUUID() };
  assert.deepEqual(await remove(actor, retirement), { id: material.id, revision: 4 }); assert.deepEqual(await remove(actor, retirement), { id: material.id, revision: 4 });
  await assert.rejects(load(actor, material.id), { code: 'material_not_found' });
  const original = await save(actor, input); assert.equal(original.revision, 1); assert.equal(original.savedBy, actor.userId); assert.equal(original.maximumProvided, false);
  const history = await load(actor, material.id, { atRevision: 2 }); assert.equal(history.maximumProvided, true); assert.equal(history.unitName, 'Grams'); assert.equal(history.categoryName.startsWith('Synthetic material category'), true);
  await save(actor, { ...input, id: randomUUID(), requestId: randomUUID() });
});

test('material keys remain case-sensitive, tenant-scoped and atomic under concurrent create and update', async () => {
  const { actor, input, material } = await setup(); const key = `Key-${randomUUID()}`;
  const outcomes = await Promise.allSettled([1, 2].map(() => save(actor, { ...input, id: randomUUID(), requestId: randomUUID(), code: key })));
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1); assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'material_code_exists');
  await save(actor, { ...input, id: randomUUID(), requestId: randomUUID(), code: key.toLowerCase() });
  const edits = await Promise.allSettled(['A', 'B'].map(description => save(actor, { ...input, revision: 1, requestId: randomUUID(), description })));
  assert.equal(edits.filter(item => item.status === 'fulfilled').length, 1); assert.equal(edits.find(item => item.status === 'rejected').reason.code, 'stale_material');
  assert.equal((await load(actor, material.id)).revision, 2);
});

test('opening stock retains its identity while positive and cannot be reduced below issued stock', async () => {
  const { actor, material, input } = await setup({ initialQuantity: '2' });
  const zero = await save(actor, { ...input, requestId: randomUUID(), revision: 1, initialQuantity: '0' }); assert.equal(zero.initialStockId, null);
  const restored = await save(actor, { ...input, requestId: randomUUID(), revision: 2 }); assert.notEqual(restored.initialStockId, material.initialStockId);
  await post(actor, transaction(material.id, { type: 'out', quantity: '1.25', batchSerialNumber: 'Initial Stock' }));
  await assert.rejects(save(actor, { ...input, requestId: randomUUID(), revision: 3, initialQuantity: '1.2499999999' }), { code: 'initial_stock_below_issued' });
  assert.equal((await load(actor, material.id)).currentQuantity, '0.75');
  assert.equal((await save(actor, { ...input, requestId: randomUUID(), revision: 3, initialQuantity: '1.25' })).currentQuantity, '0.00');
  assert.equal((await load(actor, material.id, { atRevision: 1 })).initialStockId, material.initialStockId);
});

test('manual receipts and issues retain precise quantities, zero costs, expiry and actual unit snapshots', async () => {
  const { actor, material, unit } = await setup({ expirable: true });
  const receipt = await post(actor, transaction(material.id, { quantity: '1.0000000001', expiryDate: '2099-12-31', batchSerialNumber: 'Batch A' }));
  assert.equal(receipt.quantity, '1.0000000001'); assert.equal(receipt.cost, '0'); assert.equal(receipt.expiryDate, '2099-12-31'); assert.equal(receipt.createdBy, actor.userId);
  const issued = await post(actor, transaction(material.id, { type: 'out', quantity: '0.0000000001', batchSerialNumber: 'Batch A', supplier: 'Forged client supplier' }));
  assert.equal(issued.supplier, 'Supplier'); assert.equal(issued.cost, null); assert.equal(issued.expiryDate, null);
  await post(actor, transaction(material.id, { type: 'out_damaged', quantity: '1', batchSerialNumber: 'Batch A' }));
  assert.equal(Number((await load(actor, material.id)).currentQuantity), 0);
  await owner.query("UPDATE measurement_units SET name='Renamed grams',revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, unit.id]);
  const history = await work(actor, (client, identity) => loadMaterialTransaction(client, identity, receipt.id)); assert.equal(history.unitName, 'Grams');
  await assert.rejects(post(actor, transaction(material.id, { type: 'out', quantity: '1', batchSerialNumber: 'Batch A' })), { code: 'insufficient_material_stock' });
});

test('receipt retries precede changed category rules and retirement, while duplicate incoming batches are serialized', async () => {
  const { actor, material, category, categoryInput } = await setup(); const input = transaction(material.id, { batchSerialNumber: 'Mixed Batch', expiryDate: 'invalid' });
  const results = await Promise.all([post(actor, input), post(actor, input)]); assert.equal(results[0].id, results[1].id); assert.equal(await count('material_transactions', material.id), 1);
  const duplicates = await Promise.allSettled(['Same', 'same'].map(batchSerialNumber => post(actor, transaction(material.id, { batchSerialNumber }))));
  assert.equal(duplicates.filter(item => item.status === 'fulfilled').length, 1); assert.equal(duplicates.find(item => item.status === 'rejected').reason.code, 'material_batch_exists');
  await work(actor, (client, identity) => saveMaterialCategory(client, identity, { ...categoryInput, revision: category.revision, requestId: randomUUID(), expirable: true }));
  await remove(actor, { id: material.id, revision: 1, requestId: randomUUID() });
  assert.equal((await post(actor, input)).id, input.id);
  for (const changes of [{ quantity: '2' }, { id: randomUUID() }, { batchSerialNumber: 'Changed' }]) await assert.rejects(post(actor, { ...input, ...changes }), { code: 'save_request_reused' });
  const other = await account({ organizationId: actor.organizationId }); await assert.rejects(post(other, input), { code: 'save_request_reused' });
});

test('concurrent OUT transactions cannot oversell and three-decimal presentation never inflates batch availability', async () => {
  const { actor, material } = await setup();
  await post(actor, transaction(material.id, { quantity: '0.0006', batchSerialNumber: 'Tiny' }));
  await post(actor, transaction(material.id, { quantity: '1', batchSerialNumber: 'Other' }));
  await assert.rejects(post(actor, transaction(material.id, { type: 'out', quantity: '0.001', batchSerialNumber: 'Tiny' })), { code: 'insufficient_material_stock' });
  const outcomes = await Promise.allSettled([1, 2].map(() => post(actor, transaction(material.id, { type: 'out', quantity: '0.6', batchSerialNumber: 'Other' }))));
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1); assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'insufficient_material_stock');
  assert.equal((await load(actor, material.id)).currentQuantity, '0.4006');
});

test('categories in use cannot be retired and unavailable units can only be retained unchanged', async () => {
  const { actor, material, category, unit, input } = await setup();
  const retireCategory = () => work(actor, (client, identity) => retireMaterialCategory(client, identity, { id: category.id, requestId: randomUUID(), revision: category.revision }));
  await assert.rejects(retireCategory(), { code: 'material_category_in_use' });
  await owner.query('UPDATE measurement_units SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [actor.organizationId, unit.id]);
  await save(actor, { ...input, revision: 1, requestId: randomUUID(), description: 'Retained unavailable unit' });
  await assert.rejects(save(actor, { ...input, id: randomUUID(), requestId: randomUUID() }), { code: 'invalid_measurement_unit' });
  await remove(actor, { id: material.id, revision: 2, requestId: randomUUID() }); await retireCategory();
  assert.equal((await load(actor, material.id, { atRevision: 1 })).categoryName, category.name);
});

test('invalid expiry, missing batches, cross-tenant references and failed commands preserve all stock and history', async () => {
  const { actor, material, input } = await setup({ expirable: true }); const foreign = await setup();
  for (const changes of [{ expiryDate: '' }, { expiryDate: '2027-02-29' }, { expiryDate: '2000-01-01' }]) await assert.rejects(post(actor, transaction(material.id, changes)));
  await assert.rejects(post(actor, transaction(material.id, { type: 'out', batchSerialNumber: 'Missing' })), { code: 'insufficient_material_stock' });
  await assert.rejects(save(actor, { ...input, id: randomUUID(), requestId: randomUUID(), categoryId: foreign.category.id }), { code: 'invalid_material_category' });
  await assert.rejects(save(actor, { ...input, id: randomUUID(), requestId: randomUUID(), measurementUnitId: foreign.unit.id }), { code: 'invalid_measurement_unit' });
  const pending = transaction(material.id, { expiryDate: '2099-12-31' });
  await assert.rejects(work(actor, async (client, identity) => { await createMaterialTransaction(client, identity, pending); throw new Error('Synthetic failure'); }), /Synthetic failure/);
  assert.equal(await count('material_transactions', material.id), 0); assert.equal(await count('material_versions', material.id), 1);
  assert.equal((await post(actor, pending)).id, pending.id);
});

test('material permissions, immutable history and actual actor guards apply to service and direct SQL access', async () => {
  const { actor, material, input } = await setup({ initialQuantity: '2' });
  const receipt = await post(actor, transaction(material.id)); const reader = await account({ organizationId: actor.organizationId, permissions: ['masters.read'] });
  assert.equal((await load(reader, material.id)).id, material.id);
  await assert.rejects(save(reader, { ...input, revision: 1, requestId: randomUUID() }), { code: 'forbidden' });
  await assert.rejects(post(reader, transaction(material.id)), { code: 'forbidden' });
  const foreign = await account(); await assert.rejects(load(foreign, material.id), { code: 'material_not_found' });
  await assert.rejects(work(foreign, (client, identity) => loadMaterialTransaction(client, identity, receipt.id)), { code: 'material_transaction_not_found' });
  await assert.rejects(work(actor, client => client.query('UPDATE material_transactions SET quantity=quantity+1 WHERE id=$1', [receipt.id])), { code: '42501' });
  await assert.rejects(owner.query('UPDATE material_transactions SET quantity=quantity+1 WHERE id=$1', [receipt.id]), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM material_versions WHERE material_id=$1', [material.id]), { code: '55000' });
  await assert.rejects(work(actor, client => client.query(`INSERT INTO material_transactions(organization_id,material_id,request_id,transaction_type,quantity,cost,batch_serial_number,measurement_unit_id,unit_name,unit_symbol,category_expirable,created_by)
    VALUES($1,$2,$3,'in',1,0,'Forged',$4,'Grams','g',false,$5)`, [actor.organizationId, material.id, randomUUID(), material.measurementUnitId, reader.userId])), { code: '23514' });
  assert.equal(await count('material_transactions', material.id), 1);
});

test('material listings, transaction tabs and bounded receipt choices retain opening stock, actual actors and recent exhausted batches', async () => {
  const { actor, material, input, unit } = await setup({ initialQuantity: '2', expirable: true });
  const listing = await work(actor, (client, identity) => listMaterials(client, identity)); assert.equal(listing.totalCount, 1); assert.equal(listing.rows[0]._id, material.id);
  assert.equal(listing.rows[0].classification, material.categoryName);
  const distant = await work(actor, (client, identity) => listMaterials(client, identity, { page: 20 })); assert.equal(distant.totalCount, 1); assert.deepEqual(distant.rows, []);
  await save(actor, { ...input, id: randomUUID(), requestId: randomUUID(), code: randomUUID(), name: 'Literal %_\\ marker' });
  const literal = await work(actor, (client, identity) => listMaterials(client, identity, { search: '%_\\' })); assert.equal(literal.totalCount, 1); assert.equal(literal.rows[0].name, 'Literal %_\\ marker');
  await owner.query(`INSERT INTO material_transactions(organization_id,material_id,request_id,transaction_type,quantity,cost,supplier,batch_serial_number,expiry_date,measurement_unit_id,unit_name,unit_symbol,category_expirable,created_by,created_at)
    SELECT $1,$2,gen_random_uuid(),'in',1,0,'Supplier','Batch '||lpad(n::text,3,'0'),DATE '2099-01-01'+n,$3,'Grams','g',true,$4,
      TIMESTAMPTZ '2026-01-01T00:00:00Z'+n*interval '1 second' FROM generate_series(1,61) n`, [actor.organizationId, material.id, unit.id, actor.userId]);
  await post(actor, transaction(material.id, { type: 'out', quantity: '1', batchSerialNumber: 'Batch 061' }));
  const first = await work(actor, (client, identity) => materialChoices(client, identity, { kind: 'batch', materialId: material.id }));
  assert.equal(first.items.length, 50); assert.equal(first.hasMore, true); assert.equal(first.items[0].batchSerialNumber, 'Batch 061'); assert.equal(first.items[0].exhausted, true);
  assert.equal(first.items.find(item => item.warning).batchSerialNumber, 'Batch 001');
  const second = await work(actor, (client, identity) => materialChoices(client, identity, { kind: 'batch', materialId: material.id, page: 2 })); assert.equal(second.items.length, 12); assert.equal(second.hasMore, false);
  const choices = await work(actor, (client, identity) => materialChoices(client, identity, { kind: 'batch', materialId: material.id, search: 'Batch 061' })); assert.equal(choices.items.length, 1);
  const check = await work(actor, (client, identity) => checkIncomingMaterialBatch(client, identity, material.id, ' batch 061 ')); assert.equal(check.exists, true);
  const rows = await work(actor, (client, identity) => listMaterialTransactions(client, identity, material.id, { type: 'all', pageSize: 100 }));
  assert.equal(rows.totalCount, 63); assert.equal(rows.items.filter(item => item.initial).length, 1); assert.ok(rows.items.every(item => item.createdByName));
  const out = await work(actor, (client, identity) => listMaterialTransactions(client, identity, material.id, { type: 'out' })); assert.equal(out.totalCount, 1);
  const units = await work(actor, (client, identity) => materialChoices(client, identity, { kind: 'unit', selectedId: unit.id, search: 'Unavailable name' }));
  assert.deepEqual(units.items, []); assert.equal(units.selected.id, unit.id);
});

test('material numeric values beyond the exact database bound return validation errors without adding stock', async () => {
  const { actor, material } = await setup(); const aboveMaximum = '1.7976931348623158e308';
  assert.equal(Number(aboveMaximum), Number.MAX_VALUE, 'The lexical boundary survives the floating-point input check.');
  for (const change of [{ quantity: aboveMaximum }, { cost: aboveMaximum }]) {
    await assert.rejects(post(actor, transaction(material.id, change)), { status: 422, code: 'invalid_material_transaction_quantity' });
    assert.equal(await count('material_transactions', material.id), 0); assert.equal((await load(actor, material.id)).currentQuantity, '0');
  }
});

test('material lists and lookups reject malformed bounds and unsupported filters before querying', async () => {
  const { actor, material } = await setup();
  await work(actor, async (client, identity) => {
    const noQueries = { query() { assert.fail('Invalid input must fail before SQL.'); } };
    for (const input of [{ page: 0 }, { pageSize: 101 }, { search: 'x'.repeat(501) }, { sort: { key: 'active', dir: 'asc' } },
      { filters: { name: { type: 'number', value: '1' } } }, { filters: { created_at: { type: 'date', from: '2026-10-10', to: '2026-10-09' } } },
      { filters: { created_at: { type: 'date', from: '2026-02-29' } } }]) await assert.rejects(listMaterials(noQueries, identity, input), { status: 400 });
    for (const input of [{ kind: 'unknown' }, { kind: 'unit', page: 0 }, { kind: 'unit', selectedId: 'bad' }, { kind: 'batch', materialId: 'bad' }]) {
      await assert.rejects(materialChoices(noQueries, identity, input), { status: 400 });
    }
    await assert.rejects(listMaterialTransactions(noQueries, identity, material.id, { type: 'adjust' }), { status: 400 });
    await assert.rejects(listMaterialTransactions(noQueries, identity, material.id, { pageSize: 101 }), { status: 400 });
  });
});

for (const [before, day, afterDay] of [['2026-03-07', '2026-03-08', '2026-03-09'], ['2026-10-31', '2026-11-01', '2026-11-02']]) {
  test(`UTC material date boundaries survive a non-UTC session across ${day}`, async () => {
    const { actor, input } = await setup(); const ids = [];
    for (const [index, instant] of [`${before}T23:59:59.999999Z`, `${day}T00:00:00Z`, `${day}T23:59:59.999999Z`, `${afterDay}T00:00:00Z`].entries()) {
      const id = randomUUID(); ids.push(id);
      await owner.query(`INSERT INTO materials(organization_id,id,name,code,category_id,measurement_unit_id,created_at,updated_at)
        VALUES($1,$2::uuid,$3,$2::text,$4,$5,$6,$6)`, [actor.organizationId, id, `DST boundary ${index}`, input.categoryId, input.measurementUnitId, instant]);
    }
    const result = await work(actor, async (client, identity) => {
      await client.query("SET LOCAL TIME ZONE 'America/New_York'");
      return listMaterials(client, identity, { search: 'DST boundary', filters: { created_at: { type: 'date', from: day, to: day } }, sort: { key: 'created_at', dir: 'asc' } });
    });
    assert.deepEqual(result.rows.map(row => row._id), ids.slice(1, 3)); assert.equal(result.totalCount, 2);
  });
}

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
for (const firstOperation of ['assign', 'retire']) {
  test(`category retirement and material assignment serialize across different actors with ${firstOperation} first`, { timeout: 15000 }, async () => {
    const { actor, material, category, input } = await setup();
    const other = await account({ organizationId: actor.organizationId });
    await remove(actor, { id: material.id, revision: 1, requestId: randomUUID() });
    const next = { ...input, id: randomUUID(), code: randomUUID(), requestId: randomUUID() };
    const retire = { id: category.id, revision: category.revision, requestId: randomUUID() };
    const act = (operation, client, identity) => operation === 'assign' ? saveMaterial(client, identity, next) : retireMaterialCategory(client, identity, retire);
    const ready = deferred(); const release = deferred(); const secondStarted = deferred(); let second;
    const first = work(actor, async (client, identity) => { const value = await act(firstOperation, client, identity); ready.resolve(); await release.promise; return value; });
    let results;
    try {
      await Promise.race([ready.promise, first.then(() => assert.fail('The first writer must hold its transaction.'))]);
      second = work(other, async (client, identity) => {
        secondStarted.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return act(firstOperation === 'assign' ? 'retire' : 'assign', client, identity);
      });
      // Observe the real database wait before releasing the first command.
      const settledSecond = second.then(value => ({ value }), error => ({ error }));
      const pid = await Promise.race([secondStarted.promise, settledSecond.then(() => assert.fail('The second writer must reach SQL.'))]);
      let blocked = false; const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        blocked = Number((await owner.query('SELECT cardinality(pg_blocking_pids($1)) AS blockers', [pid])).rows[0].blockers) > 0;
        if (blocked) break; await delay(20);
      }
      assert.equal(blocked, true, 'The second actor waits for the first material/category command.');
    } finally { release.resolve(); results = await Promise.allSettled([first, ...(second ? [second] : [])]); }
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, firstOperation === 'assign' ? 'material_category_in_use' : 'invalid_material_category');
    const state = (await owner.query(`SELECT category.active,(SELECT count(*) FROM materials WHERE organization_id=$1 AND category_id=$2 AND active)::integer AS assigned
      FROM material_categories category WHERE organization_id=$1 AND id=$2`, [actor.organizationId, category.id])).rows[0];
    assert.deepEqual(state, { active: firstOperation === 'assign', assigned: firstOperation === 'assign' ? 1 : 0 });
  });
}
