import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { parseMasterBulkCsv } from '../../src/masters/bulk-csv.js';
import { decodeMasterXlsx } from '../../src/masters/bulk-xlsx.js';
import { masterWorkbook } from '../helpers/master-workbooks.js';
import { stageMasterBulk, loadMasterBulkPreview, correctMasterBulkRow, listMasterBulk } from '../../src/masters/bulk-store.js';
import { reviewMasterBulk, processMasterBulk } from '../../src/masters/bulk-service.js';
import { masterBulkTemplate, masterBulkOriginal, masterBulkRejected } from '../../src/masters/bulk-export.js';
import { customerBulkHeaders } from '../../src/masters/customer-bulk-config.js';
import { saveCustomer, loadCustomer, retireCustomer } from '../../src/masters/customers.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { uploadCustomFieldAttachment } from '../../src/custom-fields/attachments.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const configure = (manager, users) => saveModuleAccessSettings(manager, emptyModuleAccess().map(module => module.moduleKey === 'customer'
  ? { ...module, enabled: true, userIds: users.map(actor => actor.userId) } : module));
async function account(options = {}, configured = true) {
  const actor = await createAccount(owner, { permissions: ['masters.manage', 'settings.manage'], ...options });
  Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
  if (configured) await configure(actor, [actor]);
  return actor;
}
const preview = (actor, id) => work(actor, (client, identity) => loadMasterBulkPreview(client, identity, id), true);
async function stage(actor, source, overrides = {}) {
  const input = { id: randomUUID(), resource: 'customers', fileName: 'Synthetic customers.csv', format: 'csv',
    sourceSha256: createHash('sha256').update(source).digest('hex'), timeZone: 'Asia/Kolkata', ...overrides };
  const decoded = parseMasterBulkCsv(source);
  const result = await work(actor, (client, identity) => stageMasterBulk(client, identity, input, decoded));
  return { ...result, input, decoded };
}
async function review(actor, id) {
  const state = await preview(actor, id);
  await work(actor, (client, identity) => reviewMasterBulk(client, identity, id, { rows: state.rowStates.filter(row => !row.committed)
    .map(row => ({ id: row.id, revision: row.revision, requestId: randomUUID() })) }));
  return preview(actor, id);
}
const processInput = state => ({ rows: state.rowStates.filter(row => !row.committed && row.valid)
  .map(row => ({ id: row.id, revision: row.revision, reviewId: row.reviewId, requestId: randomUUID() })) });
const process = (actor, id, input) => work(actor, (client, identity) => processMasterBulk(client, identity, id, input));
const field = (actor, key, extra = {}) => work(actor, (client, identity) => saveCustomField(client, identity, {
  id: randomUUID(), requestId: randomUUID(), revision: 0, associatedWith: 'customer', key, label: key, fieldType: 'text', ...extra,
}));
const save = (actor, input) => work(actor, (client, identity) => saveCustomer(client, identity,
  { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Existing', legalName: 'Legal', ...input }));
const load = (actor, id, options) => work(actor, (client, identity) => loadCustomer(client, identity, id, options), true);
const correct = (actor, id, input) => work(actor, (client, identity) => correctMasterBulkRow(client, identity, id, input));

test('Customer sample, staging, correction, exports and exact retries retain real creation outcomes', async () => {
  const actor = await account(); const sample = await work(actor, (client, identity) => masterBulkTemplate(client, identity, 'customers'), true);
  assert.deepEqual(sample.headers, customerBulkHeaders); assert.equal(sample.rows.length, 1); assert.equal(sample.rows[0][0], 'Example Customer');
  const batch = await stage(actor, 'name,legal_name,igst,customer_total_balance,ship_to_address,contact_person_name,contact_person_email\nFirst,Legal,0,-12.345,Ship,Contact,contact@example.invalid\nSecond,,18,0,,,');
  assert.deepEqual(await work(actor, (client, identity) => stageMasterBulk(client, identity, batch.input, batch.decoded)), { id: batch.id, rowCount: 2 });
  let state = await review(actor, batch.id); assert.equal(state.summary.ready, 1); assert.equal(state.summary.rejected, 1);
  assert.equal((await owner.query('SELECT 1 FROM customers WHERE organization_id=$1', [actor.organizationId])).rowCount, 0);
  assert.equal((await work(actor, (client, identity) => masterBulkRejected(client, identity, batch.id), true)).rows[0][1], '');
  const input = processInput(state); const result = await process(actor, batch.id, input); assert.equal(result.committed, 1); assert.deepEqual(await process(actor, batch.id, input), result);
  const saved = await load(actor, result.rows[0].resultId, { atRevision: 1 });
  assert.equal(saved.totalBalance, '-12.35'); assert.equal(saved.igstPercent, '0.0000'); assert.equal(saved.creditDays, 0);
  assert.equal(saved.shipToAddress, 'Ship'); assert.equal(saved.contactPersonEmail, 'contact@example.invalid'); assert.equal(saved.savedBy, actor.userId);
  const row = state.rows[1]; const fix = { id: row.id, revision: 1, requestId: randomUUID(), cells: [{ columnNumber: 2, value: 'Second legal' }] };
  assert.deepEqual(await correct(actor, batch.id, fix), { id: row.id, revision: 2 }); assert.deepEqual(await correct(actor, batch.id, fix), { id: row.id, revision: 2 });
  await assert.rejects(correct(actor, batch.id, { ...fix, cells: [{ columnNumber: 2, value: 'Different' }] }), { code: 'bulk_request_reused' });
  assert.equal((await work(actor, (client, identity) => masterBulkOriginal(client, identity, batch.id), true)).rows[1][1], '');
  state = await review(actor, batch.id); assert.equal((await process(actor, batch.id, processInput(state))).committed, 1);
  state = await preview(actor, batch.id); assert.equal(state.summary.committed, 2); assert(state.rows.every(row => row.resultRevision === 1 && row.resultId));
  await assert.rejects(correct(actor, batch.id, { ...fix, revision: 2, requestId: randomUUID() }), { code: 'bulk_row_committed' });
  const outcome = (await owner.query('SELECT customer_id,result_revision FROM master_bulk_attempts WHERE organization_id=$1 AND committed ORDER BY customer_id', [actor.organizationId])).rows;
  assert.equal(outcome.length, 2); assert(outcome.every(row => row.result_revision === 1));
});

test('Customer names are create-only, file duplicates ignore case, inactive matches block and retired names can be reused', async () => {
  const actor = await account(); await save(actor, { name: 'Existing', status: 'inactive' });
  const removed = await save(actor, { name: 'Retired' });
  await work(actor, (client, identity) => retireCustomer(client, identity, { id: removed.id, revision: 1, requestId: randomUUID() }));
  const batch = await stage(actor, 'name,legal_name,abbr\nExisting,Legal,NewCode\nexisting,Legal,CaseDifferent\nRetired,Legal,Retired\nRepeated,Legal,R1\nREPEATED,Legal,R2');
  const state = await review(actor, batch.id);
  // The two Existing rows also duplicate each other within this file.
  assert.equal(state.summary.ready, 1); assert.equal(state.summary.rejected, 4);
  assert.equal((await process(actor, batch.id, processInput(state))).committed, 1);
  const exact = await stage(actor, 'name,legal_name,abbr\nExisting,Legal,Distinct');
  assert.match((await review(actor, exact.id)).rows[0].validationMessage, /already exists/);
  const differentCase = await stage(actor, 'name,legal_name,abbr\nexisting,Legal,CaseDifferent');
  const ready = await review(actor, differentCase.id); assert.equal(ready.summary.ready, 1);
  assert.equal((await process(actor, differentCase.id, processInput(ready))).committed, 1);
  const collision = await stage(actor, 'name,legal_name,abbr\nOther,Legal,EXISTING');
  assert.match((await review(actor, collision.id)).rows[0].validationMessage, /code.*already in use/);
});

test('Customer validation rejects malformed native fields and protected columns without writing masters', async () => {
  const actor = await account();
  const batch = await stage(actor, 'name,legal_name,default_credit_period,igst,isFeedback,contact_person_email\nFraction,Legal,1.5,18,false,\nNegative,Legal,-1,18,false,\nRange,Legal,0,100.0000001,false,\nFlag,Legal,0,0,maybe,\nContact,Legal,0,0,false,bad');
  assert.equal((await review(actor, batch.id)).summary.rejected, 5);
  for (const source of ['name\nMissing legal', 'name,legal_name,organization_id\nInjected,Legal,forged']) {
    const invalid = await stage(actor, source); assert.equal((await review(actor, invalid.id)).summary.rejected, 1);
  }
  assert.equal((await owner.query('SELECT 1 FROM customers WHERE organization_id=$1', [actor.organizationId])).rowCount, 0);
});

test('Customer XLSX preserves typed zero, false, date and formula provenance with correctable spreadsheet errors', async () => {
  const actor = await account(); await field(actor, 'date', { fieldType: 'date_time' });
  const bytes = await masterWorkbook([['name', 'legal_name', 'igst', 'isFeedback', 'project_field.date'],
    ['Typed', 'Legal', 0, { formula: 'FALSE()', result: false }, new Date('2026-09-17T00:00:00Z')],
    [{ formula: 'NOW()' }, 'Legal', 0, false, '']]);
  const decoded = await decodeMasterXlsx(bytes); const id = randomUUID();
  await work(actor, (client, identity) => stageMasterBulk(client, identity, { id, resource: 'customers', fileName: 'Typed.xlsx', format: 'xlsx',
    sourceSha256: createHash('sha256').update(bytes).digest('hex'), timeZone: 'Asia/Kolkata' }, decoded));
  const state = await review(actor, id); assert.equal(state.batch.hasDateFields, true); assert.equal(state.summary.ready, 1); assert.equal(state.summary.rejected, 1);
  assert.equal(state.rows[0].values[2], 0); assert.equal(state.rows[0].values[3], false); assert.equal(state.rows[0].cellMetadata[0].formula, 'FALSE()');
  const result = await process(actor, id, processInput(state)); assert.equal(result.committed, 1);
  const saved = await load(actor, result.rows[0].resultId); assert.equal(saved.feedbackApplicable, false); assert.equal(saved.customFields[0].timeZone, 'Asia/Kolkata');
  assert.equal(saved.customFields[0].value, '2026-09-17T00:00:00.000Z');
});

test('Customer uploads capture current typed required, file, user, lookup and repeated-number fields', async () => {
  const actor = await account(); const lookup = await work(actor, (client, identity) => saveLookupSourceObservation(client, identity,
    { id: randomUUID(), sourceId: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Choices', lines: [{ id: 'A', label: 'Alpha' }] }));
  const definitions = [];
  for (const [key, extra] of [['required', { isRequired: true }], ['file', { fieldType: 'attachment' }], ['users', { fieldType: 'multi_user_select' }],
    ['choice', { fieldType: 'lookup', lookupSourceId: lookup.id }], ['number', { fieldType: 'number', allowsMultiple: true }], ['flag', { fieldType: 'checkbox' }]]) definitions.push(await field(actor, key, extra));
  const attachment = await work(actor, (client, identity) => uploadCustomFieldAttachment(client, identity,
    { requestId: randomUUID(), fieldId: definitions[1].id, fieldRevision: 1, originalName: 'Synthetic.txt', mediaType: 'text/plain', content: Buffer.from('Synthetic bulk evidence') }));
  const omitted = await stage(actor, 'name,legal_name\nMissing required,Legal'); assert.equal((await review(actor, omitted.id)).summary.rejected, 1);
  const batch = await stage(actor, `name,legal_name,project_field.required,project_field.file,project_field.users,project_field.choice,project_field.number,project_field.flag\nCaptured,Legal,Present,${attachment.id},${actor.userId},A,0;2.5,false`);
  const state = await review(actor, batch.id); assert.equal(state.summary.ready, 1, JSON.stringify(state.rows));
  const result = await process(actor, batch.id, processInput(state)); assert.equal(result.committed, 1, JSON.stringify(result));
  const saved = await load(actor, result.rows[0].resultId); const values = new Map(saved.customFields.map(field => [field.key, field]));
  assert.equal(values.get('required').value, 'Present'); assert.equal(values.get('file').items[0].attachmentId, attachment.id);
  assert.deepEqual(values.get('users').value, [actor.userId]); assert.equal(values.get('choice').displayValue, 'Alpha');
  assert.deepEqual(values.get('number').value, ['0', '2.5']); assert.equal(values.get('flag').value, false);
});

test('changed definitions and concurrent names reject stale Customer reviews; unique field failures roll back only that row', async () => {
  const actor = await account(); const batch = await stage(actor, 'name,legal_name\nConcurrent,Legal');
  let state = await review(actor, batch.id); const unique = await field(actor, 'unique', { validateUniqueness: true });
  assert.equal((await process(actor, batch.id, processInput(state))).rows[0].error.code, 'stale_bulk_review');
  state = await review(actor, batch.id); await save(actor, { name: 'Concurrent', abbreviation: 'Distinct',
    customFields: [{ fieldId: unique.id, fieldRevision: unique.revision, value: '' }] });
  assert.equal((await process(actor, batch.id, processInput(state))).rows[0].error.code, 'invalid_bulk_row');
  const duplicates = await stage(actor, 'name,legal_name,project_field.unique\nOne,Legal,SAME\nTwo,Legal,SAME');
  const reviewed = await review(actor, duplicates.id); assert.equal(reviewed.summary.ready, 2);
  const result = await process(actor, duplicates.id, processInput(reviewed)); assert.equal(result.committed, 1); assert.equal(result.rejected, 1);
  assert.equal(result.rows.find(row => !row.committed).error.code, 'duplicate_custom_field_value');
  assert.equal((await owner.query('SELECT 1 FROM customer_versions WHERE organization_id=$1', [actor.organizationId])).rowCount, 2);
});

test('configured Customer access and management permission gate uploads, history, exports, retries and every child table', async () => {
  const actor = await account(); const denied = await account({ organizationId: actor.organizationId, permissions: ['masters.manage'] }, false);
  const reader = await account({ organizationId: actor.organizationId, permissions: ['masters.read'] }, false); const foreign = await account();
  await configure(actor, [actor, reader]);
  const batch = await stage(actor, 'name,legal_name\nVisible,Legal'); await review(actor, batch.id);
  for (const subject of [denied, reader]) {
    await assert.rejects(stage(subject, 'name,legal_name\nDenied,Legal'), { status: 403 });
    await assert.rejects(work(subject, (client, identity) => masterBulkTemplate(client, identity, 'customers'), true), { status: 403 });
  }
  await assert.rejects(preview(foreign, batch.id), { code: 'bulk_not_found' }); await assert.rejects(preview(denied, batch.id), { code: 'bulk_not_found' });
  for (const table of ['master_bulk_batches', 'master_bulk_columns', 'master_bulk_rows', 'master_bulk_row_versions', 'master_bulk_cells', 'master_bulk_reviews', 'master_bulk_attempts']) {
    assert.equal((await work(denied, client => client.query(`SELECT 1 FROM ${table} WHERE organization_id=$1`, [actor.organizationId]), true)).rowCount, 0);
  }
  const visible = await work(actor, (client, identity) => listMasterBulk(client, identity, 'all'), true); assert.equal(visible.totalCount, 1);
  assert.equal((await work(denied, (client, identity) => listMasterBulk(client, identity, 'all'), true)).totalCount, 0);
  await configure(actor, [reader]);
  await assert.rejects(work(actor, (client, identity) => stageMasterBulk(client, identity, batch.input, batch.decoded)), { status: 403 });
  await assert.rejects(work(actor, (client, identity) => masterBulkOriginal(client, identity, batch.id), true), { code: 'bulk_not_found' });
  await assert.rejects(work(actor, (client, identity) => listMasterBulk(client, identity, 'all', { filters: { resource: { type: 'select', value: 'customers' } } }), true), { status: 403 });
});

test('native Customer bulk guards reject updates, forged committed outcomes and direct writes without configured access', async () => {
  const actor = await account(); const denied = await account({ organizationId: actor.organizationId, permissions: ['masters.manage'] }, false);
  const batch = await stage(actor, 'name,legal_name\nNative,Legal'); const row = (await review(actor, batch.id)).rows[0];
  await assert.rejects(work(actor, client => client.query(`INSERT INTO master_bulk_reviews(organization_id,id,batch_id,row_id,input_revision,valid,candidate_id,expected_revision,operation,definitions_sha256,command_sha256,saved_by)
    SELECT organization_id,$2,batch_id,row_id,input_revision,valid,candidate_id,1,'update',definitions_sha256,command_sha256,saved_by FROM master_bulk_reviews WHERE id=$1`, [row.reviewId, randomUUID()])), { code: '23514' });
  await assert.rejects(work(actor, client => client.query(`INSERT INTO master_bulk_attempts(organization_id,id,batch_id,row_id,input_revision,review_id,committed,customer_id,result_revision,saved_by)
    VALUES($1,$2,$3,$4,1,$5,true,$6,1,$7)`, [actor.organizationId, randomUUID(), batch.id, row.id, row.reviewId, row.candidateId, actor.userId])), { code: '23514' });
  await assert.rejects(work(denied, client => client.query(`INSERT INTO master_bulk_batches(organization_id,id,resource,file_name,file_format,source_sha256,time_zone,header_row_number,column_count,row_count,saved_by)
    VALUES($1,$2,'customers','Denied.csv','csv',$3,'UTC',1,2,1,$4)`, [actor.organizationId, randomUUID(), 'a'.repeat(64), denied.userId])), { code: '42501' });
  const customer = await save(actor, { id: row.candidateId, requestId: row.reviewId, name: 'Native' });
  await assert.rejects(work(actor, client => client.query(`INSERT INTO master_bulk_attempts(organization_id,id,batch_id,row_id,input_revision,review_id,committed,customer_id,result_revision,saved_by)
    VALUES($1,$2,$3,$4,1,$5,true,$6,1,$7)`, [actor.organizationId, randomUUID(), batch.id, row.id, row.reviewId, customer.id, actor.userId])), { code: '23514' });
});

test('concurrent Customer processing and later retries create one revision and keep the original outcome', async () => {
  const actor = await account(); const batch = await stage(actor, 'name,legal_name\nOnce,Legal'); const state = await review(actor, batch.id);
  const input = processInput(state); const results = await Promise.all([process(actor, batch.id, input), process(actor, batch.id, processInput(state))]);
  assert(results.every(result => result.committed === 1)); assert.equal(results[0].rows[0].resultId, results[1].rows[0].resultId);
  await save(actor, { id: results[0].rows[0].resultId, revision: 1, name: 'Later change' });
  assert.deepEqual(await process(actor, batch.id, input), results[0]);
  assert.equal((await owner.query('SELECT 1 FROM customer_versions WHERE organization_id=$1', [actor.organizationId])).rowCount, 2);
});

test('Customer upload writes recheck module revocation after waiting on the native authorization lock', { timeout: 30000 }, async () => {
  const actor = await account(); let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const ready = new Promise(resolve => { entered = resolve; }); let pid; let failure;
  const editing = work(actor, async (client, identity) => {
    const { settings } = await loadLaboratorySettings(client, identity);
    await saveLaboratorySettings(client, identity, { revision: settings.revision, autoCreateJobs: settings.autoCreateJobs, moduleAccess: emptyModuleAccess() });
    entered(); await gate;
  });
  let pending;
  try {
    await Promise.race([ready, editing.then(() => { throw new Error('Missing revocation gate'); })]);
    const source = 'name,legal_name\nRevoked,Legal'; const decoded = parseMasterBulkCsv(source);
    pending = work(actor, async (client, identity) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return stageMasterBulk(client, identity, { id: randomUUID(), resource: 'customers', fileName: 'Revoked.csv', format: 'csv',
        sourceSha256: createHash('sha256').update(source).digest('hex'), timeZone: 'UTC' }, decoded);
    });
    void pending.catch(error => { failure = error; }); let locked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      if (pid && (await owner.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).rowCount) { locked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert(locked); release(); await editing; await assert.rejects(pending, { status: 403 });
    assert.equal((await owner.query('SELECT 1 FROM master_bulk_batches WHERE organization_id=$1', [actor.organizationId])).rowCount, 0);
  } finally { release(); await editing.catch(() => {}); if (pending) await pending.catch(() => {}); }
});
