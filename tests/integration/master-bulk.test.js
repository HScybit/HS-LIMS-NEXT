import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { hashToken } from '../../src/auth/tokens.js';
import { closePool } from '../../src/db/pool.js';
import { parseMasterBulkCsv } from '../../src/masters/bulk-csv.js';
import { decodeMasterXlsx } from '../../src/masters/bulk-xlsx.js';
import { masterWorkbook } from '../helpers/master-workbooks.js';
import { stageMasterBulk, loadMasterBulkPreview, loadMasterBulkCells, correctMasterBulkRow, listMasterBulk } from '../../src/masters/bulk-store.js';
import { reviewMasterBulk, processMasterBulk } from '../../src/masters/bulk-service.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveProduct, loadProduct, retireProduct } from '../../src/masters/products.js';
import { saveTestParameter, loadTestParameter, retireTestParameter } from '../../src/masters/test-parameters.js';
import { saveMethod, loadMethod, retireMethod } from '../../src/masters/methods.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
const preview = (actor, id) => work(actor, (client, identity) => loadMasterBulkPreview(client, identity, id), true);
async function stage(actor, resource, source, fileName = 'Synthetic masters.csv') {
  const input = { id: randomUUID(), resource, fileName, format: 'csv',
    sourceSha256: createHash('sha256').update(source).digest('hex'), timeZone: 'Asia/Kolkata' };
  const decoded = parseMasterBulkCsv(source);
  const result = await work(actor, (client, identity) => stageMasterBulk(client, identity, input, decoded));
  return { ...result, input, decoded };
}
async function review(actor, id) {
  const state = await preview(actor, id);
  const input = { rows: state.rowStates.filter(row => !row.committed).map(row => ({ id: row.id, revision: row.revision, requestId: randomUUID() })) };
  const result = await work(actor, (client, identity) => reviewMasterBulk(client, identity, id, input));
  return { ...result, input, preview: await preview(actor, id) };
}
function processInput(state) {
  return { rows: state.rowStates.filter(row => !row.committed && row.valid).map(row => ({ id: row.id, revision: row.revision, reviewId: row.reviewId, requestId: randomUUID() })) };
}
const process = (actor, id, input) => work(actor, (client, identity) => processMasterBulk(client, identity, id, input));
const field = (actor, association, key, extra = {}) => work(actor, (client, identity) => saveCustomField(client, identity, {
  id: randomUUID(), requestId: randomUUID(), revision: 0, associatedWith: association, key, label: key, fieldType: 'text', ...extra,
}));

test('Product XLSX Date cells retain typed instants and date provenance through native capture', async () => {
  const actor = await account(); await field(actor, 'product', 'date', { fieldType: 'date_time' });
  const bytes = await masterWorkbook([['name', 'key', 'project_field.date'], ['Dated', 'D', new Date('2026-09-17T00:00:00Z')]]);
  const decoded = await decodeMasterXlsx(bytes); const id = randomUUID();
  await work(actor, (client, identity) => stageMasterBulk(client, identity, { id, resource: 'products', fileName: 'Date.xlsx', format: 'xlsx',
    sourceSha256: createHash('sha256').update(bytes).digest('hex'), timeZone: 'Asia/Kolkata' }, decoded));
  const state = await review(actor, id); assert.equal(state.preview.summary.ready, 1);
  assert.equal(state.preview.rows[0].cellMetadata[0].type, 'date');
  assert.equal(state.preview.rows[0].values[2].toISOString(), '2026-09-17T00:00:00.000Z');
  const result = await process(actor, id, processInput(state.preview)); assert.equal(result.committed, 1);
  const product = await work(actor, (client, identity) => loadProduct(client, identity, result.rows[0].resultId), true);
  assert.equal(product.customFields[0].value, '2026-09-17T00:00:00.000Z'); assert.equal(product.customFields[0].timeZone, 'Asia/Kolkata');
});

test('bulk staging/review do not write masters; corrections, partial processing and exact retries retain accurate outcomes', async () => {
  const actor = await account(); const batch = await stage(actor, 'products', 'name,key,description\nWater,W, source text \n,B,');
  assert.deepEqual(await work(actor, (client, identity) => stageMasterBulk(client, identity, batch.input, batch.decoded)), { id: batch.id, rowCount: 2 });
  await assert.rejects(work(actor, (client, identity) => stageMasterBulk(client, identity, { ...batch.input, fileName: 'Different.csv' }, batch.decoded)), { code: 'bulk_request_reused' });
  const reviewed = await review(actor, batch.id);
  assert.equal(reviewed.preview.summary.ready, 1); assert.equal(reviewed.preview.summary.rejected, 1);
  assert.equal((await owner.query('SELECT 1 FROM products WHERE organization_id=$1', [actor.organizationId])).rowCount, 0);
  const input = processInput(reviewed.preview); const result = await process(actor, batch.id, input);
  assert.equal(result.committed, 1); assert.equal(result.rejected, 0);
  assert.deepEqual(await process(actor, batch.id, input), result);
  const fixed = reviewed.preview.rows.find(row => row.valid === false);
  const correction = { id: fixed.id, revision: fixed.revision, requestId: randomUUID(), cells: [{ columnNumber: 1, value: 'Corrected' }] };
  const saved = await work(actor, (client, identity) => correctMasterBulkRow(client, identity, batch.id, correction));
  assert.equal(saved.revision, 2);
  assert.deepEqual(await work(actor, (client, identity) => correctMasterBulkRow(client, identity, batch.id, correction)), saved);
  await assert.rejects(work(actor, (client, identity) => correctMasterBulkRow(client, identity, batch.id, { ...correction, cells: [{ columnNumber: 1, value: 'Different' }] })), { code: 'bulk_request_reused' });
  const original = await work(actor, (client, identity) => loadMasterBulkCells(client, identity, batch.id, [{ id: fixed.id, revision: 2 }], { original: true }), true);
  assert.equal(original[0].values[0], '');
  const corrected = await review(actor, batch.id); assert.equal(corrected.preview.summary.ready, 1);
  await process(actor, batch.id, processInput(corrected.preview));
  const done = await preview(actor, batch.id); assert.equal(done.summary.committed, 2); assert.equal(done.summary.rejected, 0);
  const completedRow = done.rows[0];
  await assert.rejects(work(actor, (client, identity) => correctMasterBulkRow(client, identity, batch.id, { id: completedRow.id, revision: completedRow.revision, requestId: randomUUID(), cells: [{ columnNumber: 1, value: 'No' }] })), { code: 'bulk_row_committed' });
  assert.equal((await owner.query('SELECT 1 FROM product_versions WHERE organization_id=$1', [actor.organizationId])).rowCount, 2);
  const listed = await work(actor, (client, identity) => listMasterBulk(client, identity, 'products'), true);
  assert.equal(listed.rows[0].id, batch.id);
});

const stores = [
  { resource: 'products', association: 'product', save: saveProduct, load: loadProduct, retire: retireProduct,
    base: { name: 'Before', key: 'B', abbreviation: 'KEEP' }, headers: 'name,key', values: 'After,B', activeAfter: true, operation: 'reactivate' },
  { resource: 'test-parameters', association: 'parameter', save: saveTestParameter, load: loadTestParameter, retire: retireTestParameter,
    base: { name: 'Before', key: 'B', schemeAbbreviation: 'BX', order: 7 }, headers: 'name,key,scheme_abbr', values: 'After,B,BX', activeAfter: false, operation: 'update_retired' },
  { resource: 'methods', association: 'method_of_analysis', save: saveMethod, load: loadMethod, retire: retireMethod,
    base: { name: 'Before', uuid: 'B', decimalScale: 0, parseNumber: false }, headers: 'name,uuid,parse_num', values: 'After,B,false', activeAfter: false, operation: 'update_retired' },
];
for (const store of stores) {
  test(`${store.resource} bulk updates retain omitted fields, clear supplied blanks and preserve creation history`, async () => {
    const actor = await account(); const kept = await field(actor, store.association, 'kept'); const cleared = await field(actor, store.association, 'cleared');
    const command = { ...store.base, id: randomUUID(), requestId: randomUUID(), revision: 0, description: 'Keep description',
      customFields: [{ fieldId: kept.id, fieldRevision: 1, value: 'Keep this' }, { fieldId: cleared.id, fieldRevision: 1, value: 'Clear this' }] };
    const before = await work(actor, (client, identity) => store.save(client, identity, command));
    const batch = await stage(actor, store.resource, `${store.headers},project_field.cleared\n${store.values},`);
    const reviewed = await review(actor, batch.id); assert.equal(reviewed.preview.rows[0].operation, 'update');
    const result = await process(actor, batch.id, processInput(reviewed.preview)); assert.equal(result.committed, 1);
    const after = await work(actor, (client, identity) => store.load(client, identity, before.id), true);
    assert.equal(after.id, before.id); assert.equal(after.revision, 2); assert.equal(after.description, 'Keep description'); assert.equal(after.name, 'After');
    assert.deepEqual(new Map(after.customFields.map(value => [value.key, value.value])), new Map([['kept', 'Keep this'], ['cleared', '']]));
    if (store.resource === 'methods') assert.equal(after.decimalScale, 0);
    if (store.resource === 'products') assert.equal(after.abbreviation, 'KEEP');
    if (store.resource === 'test-parameters') assert.equal(after.order, 7);
    const history = await work(actor, (client, identity) => store.load(client, identity, before.id, { atRevision: 1 }), true);
    assert.equal(history.name, 'Before'); assert.equal(history.operation, 'create'); assert.equal(history.savedBy, actor.userId);
  });

  test(`${store.resource} retired bulk matches follow source status while manual saves still reject them`, async () => {
    const actor = await account(); const configured = await field(actor, store.association, 'kept');
    const command = { ...store.base, id: randomUUID(), requestId: randomUUID(), revision: 0,
      customFields: [{ fieldId: configured.id, fieldRevision: 1, value: 'Retain' }] };
    await work(actor, (client, identity) => store.save(client, identity, command));
    await work(actor, (client, identity) => store.retire(client, identity, { id: command.id, requestId: randomUUID(), revision: 1 }));
    await assert.rejects(work(actor, (client, identity) => store.save(client, identity, { ...command, revision: 2, requestId: randomUUID() })), error => error.status === 404);
    const batch = await stage(actor, store.resource, `${store.headers}\n${store.values}`);
    const reviewed = await review(actor, batch.id); assert.equal(reviewed.preview.rows[0].operation, store.operation);
    const result = await process(actor, batch.id, processInput(reviewed.preview));
    assert.equal(result.committed, 1, JSON.stringify(result));
    const after = await work(actor, (client, identity) => store.load(client, identity, command.id, { atRevision: 3 }), true);
    assert.equal(after.active, store.activeAfter); assert.equal(after.name, 'After'); assert.equal(after.customFields[0].value, 'Retain');
    const retired = await work(actor, (client, identity) => store.load(client, identity, command.id, { atRevision: 2 }), true);
    assert.equal(retired.active, false); assert.equal(retired.name, 'Before'); assert.equal(retired.operation, 'retire');
  });
}

test('changed master revisions and definitions reject the reviewed operation until explicit revalidation', async () => {
  const actor = await account(); const command = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Before', key: 'B', description: 'Original' };
  await work(actor, (client, identity) => saveProduct(client, identity, command));
  const batch = await stage(actor, 'products', 'name,key\nBulk,B'); const reviewed = await review(actor, batch.id);
  await work(actor, (client, identity) => saveProduct(client, identity, { ...command, revision: 1, requestId: randomUUID(), description: 'Concurrent edit' }));
  const input = processInput(reviewed.preview); const failed = await process(actor, batch.id, input);
  assert.equal(failed.rejected, 1); assert.equal(failed.rows[0].error.code, 'stale_bulk_review'); assert.deepEqual(await process(actor, batch.id, input), failed);
  const updatedReview = await review(actor, batch.id);
  await field(actor, 'product', 'new_field');
  assert.equal((await process(actor, batch.id, processInput(updatedReview.preview))).rows[0].error.code, 'stale_bulk_review');
  const finalReview = await review(actor, batch.id); assert.equal((await process(actor, batch.id, processInput(finalReview.preview))).committed, 1);
  const saved = await work(actor, (client, identity) => loadProduct(client, identity, command.id), true);
  assert.equal(saved.description, 'Concurrent edit'); assert.equal(saved.name, 'Bulk'); assert.equal(saved.revision, 3);
});

test('duplicate rows, missing/protected columns and Excel errors remain correctable inputs', async () => {
  const actor = await account();
  const duplicate = await stage(actor, 'products', 'name,key\nA,DUP\nB,DUP');
  const repeated = await review(actor, duplicate.id); assert.equal(repeated.preview.summary.rejected, 2);
  const row = repeated.preview.rows[1];
  await work(actor, (client, identity) => correctMasterBulkRow(client, identity, duplicate.id, { id: row.id, revision: 1, requestId: randomUUID(), cells: [{ columnNumber: 2, value: 'OTHER' }] }));
  assert.equal((await review(actor, duplicate.id)).preview.summary.ready, 2);
  for (const source of ['name,key,organization_id\nA,B,forged', 'name\nA']) {
    const batch = await stage(actor, 'products', source); assert.equal((await review(actor, batch.id)).preview.summary.rejected, 1);
  }
  const bytes = await masterWorkbook([['name', 'uuid', 'parse_num', 'decimal_places'], ['Formula', 'F', { formula: 'FALSE()', result: false }, 0], [{ formula: 'NOW()' }, 'E', false, 4]]);
  const decoded = await decodeMasterXlsx(bytes); const id = randomUUID();
  await work(actor, (client, identity) => stageMasterBulk(client, identity, { id, resource: 'methods', fileName: 'Typed.xlsx', format: 'xlsx', sourceSha256: createHash('sha256').update(bytes).digest('hex'), timeZone: 'UTC' }, decoded));
  const state = await review(actor, id); assert.equal(state.preview.rows[0].values[2], false); assert.equal(state.preview.rows[0].values[3], 0);
  assert.equal(state.preview.rows[0].cellMetadata[0].formula, 'FALSE()'); assert.equal(state.preview.summary.rejected, 1);
  assert.equal((await process(actor, id, processInput(state.preview))).committed, 1);
});

test('partial processing rolls back a duplicate unique Custom Field row without reporting it committed', async () => {
  const actor = await account(); await field(actor, 'product', 'unique_value', { validateUniqueness: true });
  const batch = await stage(actor, 'products', 'name,key,project_field.unique_value\nOne,ONE,SAME\nTwo,TWO,SAME');
  const reviewed = await review(actor, batch.id); assert.equal(reviewed.preview.summary.ready, 2);
  const result = await process(actor, batch.id, processInput(reviewed.preview)); assert.equal(result.committed, 1); assert.equal(result.rejected, 1);
  assert.equal(result.rows.find(row => !row.committed).error.code, 'duplicate_product_custom_field');
  assert.equal((await owner.query('SELECT 1 FROM products WHERE organization_id=$1', [actor.organizationId])).rowCount, 1);
  assert.equal((await owner.query('SELECT 1 FROM product_versions WHERE organization_id=$1', [actor.organizationId])).rowCount, 1);
  assert.equal((await preview(actor, batch.id)).summary.committed, 1);
  assert.equal((await preview(actor, batch.id)).summary.ready, 0);
});

test('a reference name cannot silently resolve to a different Lab after validation', async () => {
  const actor = await account(); const lab = randomUUID();
  await owner.query('INSERT INTO laboratories(organization_id,id,name,code) VALUES($1,$2,$3,$4)', [actor.organizationId, lab, 'Chosen Lab', 'LAB-A']);
  const batch = await stage(actor, 'test-parameters', 'name,key,scheme_abbr,lab\nParameter,P,P,Chosen Lab'); const reviewed = await review(actor, batch.id);
  assert.equal(reviewed.preview.summary.ready, 1);
  await owner.query('UPDATE laboratories SET name=$3,revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2', [actor.organizationId, lab, 'Renamed Lab']);
  await owner.query('INSERT INTO laboratories(organization_id,id,name,code) VALUES($1,$2,$3,$4)', [actor.organizationId, randomUUID(), 'Chosen Lab', 'LAB-B']);
  const result = await process(actor, batch.id, processInput(reviewed.preview)); assert.equal(result.rejected, 1); assert.equal(result.rows[0].error.code, 'stale_bulk_review');
});

test('bulk permission, tenant, immutable input and forged-success boundaries hold at direct SQL too', async () => {
  const actor = await account(); const foreign = await account(); const reader = await account({ organizationId: actor.organizationId, permissions: ['masters.read'] });
  const batch = await stage(actor, 'products', 'name,key\nA,A'); const reviewed = await review(actor, batch.id); const row = reviewed.preview.rows[0];
  await assert.rejects(preview(foreign, batch.id), { code: 'bulk_not_found' }); await assert.rejects(preview(reader, batch.id), { code: 'forbidden' });
  assert.equal((await work(foreign, client => client.query('SELECT 1 FROM master_bulk_cells WHERE batch_id=$1', [batch.id]), true)).rowCount, 0);
  await assert.rejects(work(actor, client => client.query('UPDATE master_bulk_cells SET text_value=$2 WHERE batch_id=$1', [batch.id, 'Forged'])), { code: '42501' });
  await assert.rejects(work(actor, client => client.query('DELETE FROM master_bulk_reviews WHERE id=$1', [row.reviewId])), { code: '42501' });
  await assert.rejects(work(actor, client => client.query(`INSERT INTO master_bulk_attempts(organization_id,id,batch_id,row_id,input_revision,review_id,committed,product_id,result_revision,saved_by)
    VALUES($1,$2,$3,$4,1,$5,true,$6,1,$7)`, [actor.organizationId, randomUUID(), batch.id, row.id, row.reviewId, row.candidateId, actor.userId])), { code: '23514' });
  await assert.rejects(work(actor, client => client.query(`INSERT INTO master_bulk_reviews(organization_id,id,batch_id,row_id,input_revision,valid,saved_by)
    VALUES($1,$2,$3,$4,1,true,$5)`, [actor.organizationId, randomUUID(), batch.id, row.id, actor.userId])), { code: '23514' });
});

test('concurrent processing and later retries commit one real master version', async () => {
  const actor = await account(); const batch = await stage(actor, 'products', 'name,key\nConcurrent,C'); const reviewed = await review(actor, batch.id);
  const first = processInput(reviewed.preview); const second = processInput(reviewed.preview);
  const results = await Promise.all([process(actor, batch.id, first), process(actor, batch.id, second)]);
  assert.deepEqual(results.map(result => result.committed), [1, 1]);
  assert.equal((await owner.query('SELECT 1 FROM product_versions WHERE organization_id=$1', [actor.organizationId])).rowCount, 1);
  assert.equal((await owner.query('SELECT 1 FROM master_bulk_attempts WHERE organization_id=$1 AND committed', [actor.organizationId])).rowCount, 1);
});

test('cell statements require their actual input actor, valid references and complete rows', async () => {
  const actor = await account(); const other = await account({ organizationId: actor.organizationId }); const foreign = await account();
  const source = 'name,key\nOne,ONE\nTwo,TWO'; const decoded = parseMasterBulkCsv(source);
  for (const [change, code] of [['actor', '55000'], ['tenant', '42501'], ['column', '23503'], ['revision', '23503'], ['incomplete', '23514']]) {
    const id = randomUUID();
    await assert.rejects(work(actor, (client, identity) => stageMasterBulk({ query: async (sql, values) => {
      if (sql.startsWith('INSERT INTO master_bulk_cells')) {
        if (change === 'actor') await client.query('SELECT * FROM auth_session_context($1)', [hashToken(other.token)]);
        if (change === 'tenant') values[0] = foreign.organizationId;
        if (change === 'column') {
          if (typeof values[4] === 'number') values[4] = 250;
          else values[4][0] = 250;
        }
        if (change === 'revision') values[3][0] = 2;
        if (change === 'incomplete') values[5] = values[5].slice(0, -1);
      }
      return client.query(sql, values);
    } }, identity, { id, resource: 'products', fileName: 'Boundary.csv', format: 'csv',
      sourceSha256: createHash('sha256').update(source).digest('hex'), timeZone: 'UTC' }, decoded)), { code }, change);
    assert.equal((await owner.query('SELECT 1 FROM master_bulk_batches WHERE organization_id=$1 AND id=$2', [actor.organizationId, id])).rowCount, 0);
  }
});

test('text staging preserves complete source rows across batches, preview pages, corrections and retries', async () => {
  const actor = await account(); const columns = 249; const count = 205;
  const decoded = { headerRowNumber: 2, sourceHeaders: ['name', 'key', ...Array.from({ length: columns - 2 }, (_, index) => `project_field.field_${index}`)],
    rows: Array.from({ length: count }, (_, index) => ({ rowNumber: index + 3,
      values: Array.from({ length: columns }, (_, column) => column % 7 === 0 ? '' : ` ${index}/${column}: éह😀,{}"\\\n\r\t `) })) };
  const input = { id: randomUUID(), resource: 'products', fileName: 'Text boundaries.csv', format: 'csv', timeZone: 'UTC',
    sourceSha256: createHash('sha256').update('synthetic decoded text boundaries').digest('hex') };
  const staged = await work(actor, (client, identity) => stageMasterBulk(client, identity, input, decoded));
  assert.deepEqual(await work(actor, (client, identity) => stageMasterBulk(client, identity, input, decoded)), staged);
  const state = await preview(actor, staged.id); assert.equal(state.summary.total, count); assert.equal(state.rows.length, 50);
  const loaded = await work(actor, (client, identity) => loadMasterBulkCells(client, identity, staged.id, state.rowStates), true);
  assert.equal(loaded.length, count);
  for (let index = 0; index < count; index++) assert.deepEqual(loaded[index].values, decoded.rows[index].values, `source row ${index}`);
  const lastPage = await work(actor, (client, identity) => loadMasterBulkPreview(client, identity, staged.id, { page: 50 }), true);
  assert.equal(lastPage.page, 5); assert.equal(lastPage.rows.length, 5); assert.equal(lastPage.rows[0].rowNumber, 203);
  const row = state.rowStates[100]; const correction = { id: row.id, revision: 1, requestId: randomUUID(), cells: [{ columnNumber: 249, value: 'Corrected' }] };
  const changed = await work(actor, (client, identity) => correctMasterBulkRow(client, identity, staged.id, correction));
  assert.equal(changed.revision, 2);
  assert.deepEqual(await work(actor, (client, identity) => correctMasterBulkRow(client, identity, staged.id, correction)), changed);
  const current = await work(actor, (client, identity) => loadMasterBulkCells(client, identity, staged.id, [{ id: row.id, revision: 2 }]), true);
  const original = await work(actor, (client, identity) => loadMasterBulkCells(client, identity, staged.id, [{ id: row.id, revision: 2 }], { original: true }), true);
  assert.equal(current[0].values[248], 'Corrected'); assert.deepEqual(original[0].values, decoded.rows[100].values);
});

test('text byte batching accepts a complete wide Unicode row and keeps following rows intact', async () => {
  const actor = await account(); const value = '😀'.repeat(8000);
  const decoded = { headerRowNumber: 1, sourceHeaders: Array.from({ length: 40 }, (_, index) => `field_${index}`),
    rows: [Array(40).fill(value), Array(40).fill(''), Array(40).fill('Tail')].map((values, index) => ({ rowNumber: index + 2, values })) };
  const input = { id: randomUUID(), resource: 'products', fileName: 'Wide Unicode.csv', format: 'csv', timeZone: 'UTC',
    sourceSha256: createHash('sha256').update('synthetic decoded Unicode boundaries').digest('hex') };
  await work(actor, (client, identity) => stageMasterBulk(client, identity, input, decoded));
  const state = await preview(actor, input.id);
  assert.deepEqual(state.rows.map(row => row.values), decoded.rows.map(row => row.values));
});

test('typed staging preserves sparse missing cells, zero, false and source metadata and rejects invalid text atomically', async () => {
  const actor = await account(); const values = ['Sparse', 'KEY', undefined, 0, false, new Date('2026-09-17T00:00:00Z'), ''];
  delete values[2];
  const decoded = { headerRowNumber: 1, sourceHeaders: ['name', 'key', 'missing', 'zero', 'false', 'date', 'blank'],
    sheetName: 'Data', sheetCount: 1, date1904: false,
    rows: [{ rowNumber: 2, values, cellMetadata: [{ columnNumber: 4, type: 'formula', formula: '1-1', hasResult: true }, { columnNumber: 6, type: 'date' }] }] };
  const input = { id: randomUUID(), resource: 'products', fileName: 'Typed.xlsx', format: 'xlsx', timeZone: 'UTC',
    sourceSha256: createHash('sha256').update('synthetic decoded typed boundaries').digest('hex') };
  await work(actor, (client, identity) => stageMasterBulk(client, identity, input, decoded));
  const state = await preview(actor, input.id);
  assert.deepEqual(state.rows[0].values, Array.from(values));
  assert.deepEqual(state.rows[0].cellMetadata, decoded.rows[0].cellMetadata);
  for (const value of ['x'.repeat(16001), '\ud800', '\0', null]) {
    const id = randomUUID();
    await assert.rejects(work(actor, (client, identity) => stageMasterBulk(client, identity, { ...input, id },
      { ...decoded, rows: [{ rowNumber: 2, values: ['Name', 'KEY', value] }] })), { code: 'invalid_bulk_input' });
    assert.equal((await owner.query('SELECT 1 FROM master_bulk_batches WHERE organization_id=$1 AND id=$2', [actor.organizationId, id])).rowCount, 0);
  }
});

test('immutable input parents cannot be changed or removed even by a privileged caller', async () => {
  const actor = await account(); const batch = await stage(actor, 'products', 'name,key\nImmutable,I'); const client = await owner.connect();
  try {
    for (const sql of [
      'UPDATE master_bulk_columns SET source_header=source_header WHERE organization_id=$1 AND batch_id=$2',
      'DELETE FROM master_bulk_columns WHERE organization_id=$1 AND batch_id=$2',
      'UPDATE master_bulk_row_versions SET saved_by=saved_by WHERE organization_id=$1 AND batch_id=$2',
      'DELETE FROM master_bulk_row_versions WHERE organization_id=$1 AND batch_id=$2',
    ]) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT * FROM auth_session_context($1)', [hashToken(actor.token)]);
        await assert.rejects(client.query(sql, [actor.organizationId, batch.id]), { code: '55000' });
      } finally { await client.query('ROLLBACK'); }
    }
  } finally { client.release(); }
  assert.deepEqual((await preview(actor, batch.id)).rows[0].values, ['Immutable', 'I']);
});

test('upload history supports literal search, column filters, date bounds, stable sorting and tenant-scoped totals', async () => {
  const actor = await account();
  const a = await stage(actor, 'products', 'name,key\nA,A', '100% pure_A.csv');
  const b = await stage(actor, 'products', 'name,key\nB,B', '100x pureBA.csv');
  await stage(actor, 'methods', 'name,uuid,parse_num\nMethod,M,false', 'Method.csv');
  await stage(await account(), 'products', 'name,key\nForeign,F', '100% pure_A.csv');
  const list = (resource, input) => work(actor, (client, identity) => listMasterBulk(client, identity, resource, input), true);
  assert.equal((await list('all', {})).totalCount, 3);
  assert.equal((await list('products', {})).totalCount, 2);
  assert.deepEqual((await list('all', { search: '%' })).rows.map(row => row.id), [a.id]);
  assert.deepEqual((await list('all', { search: '_' })).rows.map(row => row.id), [a.id]);
  assert.deepEqual((await list('all', { filters: { fileName: { type: 'text', value: '100% pure_A' } } })).rows.map(row => row.id), [a.id]);
  assert.equal((await list('all', { filters: { resource: { type: 'select', value: 'methods' } } })).totalCount, 1);
  assert.equal((await list('all', { search: 'Method of Analysis' })).totalCount, 1);
  assert.deepEqual((await list('products', { page: 2, pageSize: 1, sort: { key: 'fileName', dir: 'asc' } })).rows.map(row => row.id), [b.id]);
  const day = (await preview(actor, a.id)).batch.savedAt.toISOString().slice(0, 10);
  assert.equal((await list('all', { filters: { savedAt: { type: 'date', from: day, to: day } } })).totalCount, 3);
  assert.equal((await list('all', { filters: { savedAt: { type: 'date', to: '2000-01-01' } } })).totalCount, 0);
  for (const input of [{ filters: { savedAt: { type: 'date', from: '2026-02-30' } } }, { sort: { key: 'organization_id', dir: 'asc' } }, { search: '\0' }]) {
    await assert.rejects(list('all', input), error => error.status === 400);
  }
});

test('blocked-row pages clamp after corrections while all-row commands and file errors remain available', async () => {
  const actor = await account(); const batch = await stage(actor, 'products', ['name,key', ...Array.from({ length: 51 }, (_, i) => `,K${i}`)].join('\n'));
  const state = await preview(actor, batch.id);
  for (let offset = 0; offset < state.rowStates.length; offset += 25) {
    await work(actor, (client, identity) => reviewMasterBulk(client, identity, batch.id, { rows: state.rowStates.slice(offset, offset + 25).map(row => ({ id: row.id, revision: 1, requestId: randomUUID() })) }));
  }
  const filtered = input => work(actor, (client, identity) => loadMasterBulkPreview(client, identity, batch.id, input), true);
  const last = await filtered({ page: 2, status: 'rejected' });
  assert.equal(last.filteredTotal, 51); assert.equal(last.rows.length, 1); assert.equal(last.rowStates.length, 51);
  const row = last.rows[0];
  await work(actor, (client, identity) => correctMasterBulkRow(client, identity, batch.id, { id: row.id, revision: 1, requestId: randomUUID(), cells: [{ columnNumber: 1, value: 'Fixed' }] }));
  const clamped = await filtered({ page: 2, status: 'rejected' });
  assert.equal(clamped.page, 1); assert.equal(clamped.filteredTotal, 50); assert.equal(clamped.rows.length, 50); assert.equal(clamped.summary.unvalidated, 1);
  const invalid = await stage(actor, 'products', 'name\nA'); const checked = await review(actor, invalid.id);
  assert.equal(checked.preview.fileErrors.length, 1);
  await assert.rejects(filtered({ status: 'committed' }), { code: 'invalid_bulk_input' });
});

test('omitting the last retired Custom Field retains its archived capture through the normal omitted-capture command', async () => {
  const actor = await account(); const definition = await field(actor, 'product', 'archived');
  const command = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Before', key: 'ARCHIVED',
    customFields: [{ fieldId: definition.id, fieldRevision: 1, value: 'Keep the archived value' }] };
  await work(actor, (client, identity) => saveProduct(client, identity, command));
  await work(actor, (client, identity) => retireCustomField(client, identity, { id: definition.id, revision: 1, requestId: randomUUID() }));
  const batch = await stage(actor, 'products', 'name,key\nAfter,ARCHIVED'); const reviewed = await review(actor, batch.id);
  assert.equal((await process(actor, batch.id, processInput(reviewed.preview))).committed, 1);
  const saved = await work(actor, (client, identity) => loadProduct(client, identity, command.id), true);
  assert.equal(saved.name, 'After'); assert.equal(saved.customFields[0].value, 'Keep the archived value'); assert.equal(saved.customFieldsProvided, false);
});

test('a correction cannot hide a nonblank value in an unheaded source column', async () => {
  const actor = await account(); const batch = await stage(actor, 'products', 'name,key,\nA,A,'); const state = await preview(actor, batch.id);
  const row = state.rows[0];
  await work(actor, (client, identity) => correctMasterBulkRow(client, identity, batch.id, { id: row.id, revision: 1, requestId: randomUUID(), cells: [{ columnNumber: 3, value: false }] }));
  const result = await review(actor, batch.id); assert.equal(result.preview.summary.rejected, 1);
  assert.match(result.preview.rows[0].validationMessage, /without a header/);
});
