import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareProductContextFlow, productSelectors } from '../helpers/product-context.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool, transaction } from '../../src/db/pool.js';
import { loadSampleProductContext } from '../../src/samples/product-context.js';
import { registerSample } from '../../src/samples/register.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { saveProduct, retireProduct } from '../../src/masters/products.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { contextWidgetValue } from '../../src/templates/context-widgets.js';
import { createReportWorkerPool } from '../../src/reports/worker.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { recalculateCapture, saveCapture } from '../../src/templates/capture.js';
import { editTemplate } from '../../src/templates/authoring.js';

process.loadEnvFile('.env.worker.local');
const workerUrl = new URL(process.env.WORKER_DATABASE_URL);
const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? 'sampleify_local';
if (databaseName !== 'sampleify_local' && !/^sampleify_verify_[a-f0-9]{32}$/.test(databaseName)
  || workerUrl.hostname !== '127.0.0.1' || workerUrl.port !== '55442' || workerUrl.pathname !== `/${databaseName}`) throw new Error('Product context worker tests require the synthetic local database.');
const owner = ownerPool(); const worker = createReportWorkerPool();
after(async () => { await closePool(); await worker.end(); await owner.end(); });
const permissions = ['masters.manage', 'samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute', 'settings.manage'];
const work = (account, action, options = {}) => withSession(account.token, action, { csrfToken: account.csrfToken, ...options });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions, ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
const widget = (alias) => ({ widget: 'product_detail_widget', alias });
const metadata = (context) => ({ productDetailsByLineId: context.productDetailsByLineId, primaryProductLineId: context.primaryProductLineId });

test('datasheets and frozen reports use their actual Product lines and retain field/master/creation history', async () => {
  const author = await account(); const flow = await prepareProductContextFlow(owner, author);
  const reader = await account({ organizationId: author.organizationId, permissions: ['samples.read'] });
  let observed = 0;
  const context = await work(reader, (client, identity) => loadSampleProductContext({ query: (...args) => { observed += 1; return client.query(...args); } }, identity, flow.sample.id, productSelectors), { readOnly: true });
  assert.equal(observed, 4); assert.equal(context.metrics.queryCount, 4);
  const products = Object.values(context.productsByLineId);
  const first = products.find((product) => product.id === flow.firstCommand.id); const second = products.find((product) => product.id === flow.secondCommand.id);
  assert.equal(products.length, 2); assert.equal(first.revision, 2); assert.equal(first.createdAt, null); assert.equal(first.createdBy, null);
  assert.equal(second.revision, 1); assert.equal(second.createdBy, author.userId); assert.equal(second.updatedAt, null);
  assert.equal(context.productDetailsByLineId[first.sampleProductId].project_field__splitter__amount, '0');
  assert.equal(context.productDetailsByLineId[first.sampleProductId].project_field__splitter__flag, 'false');
  assert.equal(context.productDetailsByLineId[second.sampleProductId].created_at, JSON.stringify(second.createdAt));
  assert.equal((await work(reader, (client) => client.query('SELECT * FROM product_versions'))).rowCount, 0);
  const sheets = await Promise.all(flow.completed.map((item) => work(reader, (client, identity) => loadDatasheet(client, identity, item.sheet.id), { readOnly: true })));
  const sheet = sheets.find((item) => item.datasheet.sampleProductId === first.sampleProductId);
  assert.equal(sheet.metrics.products.queryCount, 4);
  assert.equal(contextWidgetValue(widget('description'), sheet.dataContext), 'First master description');
  for (const occurrence of sheet.capture.occurrences.filter((row) => row.groupId)) {
    assert.equal(contextWidgetValue(widget('project_field__splitter__flag'), sheet.dataContext, occurrence.subject), 'false');
  }
  const generated = await work(author, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const reportId = generated.items[0].id;
  await assert.rejects(work(reader, (client, identity) => loadReport(client, identity, reportId), { readOnly: true }), { code: 'workflow_action_denied' });
  const original = await work(author, (client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  assert.equal(original.metrics.products.queryCount, 4);
  assert.equal(contextWidgetValue(widget('name'), original), 'First captured Product');
  for (const result of original.results) assert.equal(contextWidgetValue(widget('name'), original, result), result.sampleProductId === first.sampleProductId ? 'First captured Product' : 'Second captured Product');
  const renderer = await loadReportRenderer(); const html = renderer.renderReportDocument(original, renderer.stylesheet);
  assert.match(html, /First master description/); assert.match(html, /Second master description/);
  assert.match(html, /First, Note/); assert.match(html, /Second, Note/); assert.match(html, />false</); assert.match(html, />0</);
  assert.equal(html.includes('Title for '), false);
  assert.equal(html.includes('Configured default is not a captured Product value'), false);
  await owner.query('UPDATE sample_products SET display_order=display_order+10 WHERE organization_id=$1 AND id=$2', [author.organizationId, first.sampleProductId]);
  const reordered = await work(author, (client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  assert.equal(renderer.renderReportDocument(reordered, renderer.stylesheet), html, 'A later sample-line reorder cannot retarget the consolidated report Product');
  await work(author, (client, identity) => saveCustomField(client, identity, { ...flow.definitions[0], revision: 1, requestId: randomUUID(), key: 'later_amount', label: 'Later amount' }));
  for (const command of [flow.firstCommand, flow.secondCommand]) {
    const saved = await work(author, (client, identity) => saveProduct(client, identity, { ...command, revision: command.revision + 1, requestId: randomUUID(), name: 'Later Product', description: 'Later description',
      customFields: command.customFields.map((field, index) => index === 0 ? { ...field, fieldRevision: 2, value: 99 } : index === 1 ? { ...field, value: true } : field) }));
    await work(author, (client, identity) => retireProduct(client, identity, { id: command.id, revision: saved.revision, requestId: randomUUID() }));
  }
  const later = await work(author, (client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  assert.deepEqual(metadata(later), metadata(original));
  assert.equal(renderer.renderReportDocument(later, renderer.stylesheet), html);
  assert.equal(JSON.stringify(original).includes('customFieldsByKey'), false, 'Document transport contains shared display strings, not repeated raw field histories');
});

test('Product default and Required settings remain configuration and reject captured values at both write boundaries', async () => {
  const author = await account(); const flow = await prepareProductContextFlow(owner, author, { complete: false });
  const selected = (await owner.query(`SELECT sheet.id FROM datasheets sheet JOIN laboratory_test_request_context context
    ON context.organization_id=sheet.organization_id AND context.test_request_id=sheet.test_request_id
    WHERE sheet.organization_id=$1 AND context.product_id=$2`, [author.organizationId, flow.firstCommand.id])).rows[0];
  const sheet = await work(author, (client, identity) => loadDatasheet(client, identity, selected.id));
  const field = Object.values(sheet.model.fieldsById).find((field) => field.widget === 'product_detail_widget');
  const root = sheet.capture.occurrences.find((row) => row.groupId === null);
  assert.equal(sheet.capture.values.some((value) => value.fieldId === field.id), false);
  const configured = (await owner.query('SELECT required,default_state,default_text FROM template_fields WHERE organization_id=$1 AND version_id=$2 AND id=$3',
    [author.organizationId, sheet.datasheet.templateVersionId, field.id])).rows[0];
  assert.deepEqual(configured, { required: true, default_state: 'present', default_text: 'Configured default is not a captured Product value' });
  for (const origin of ['entered', 'default']) await assert.rejects(work(author, async (client, identity) => {
    const saved = await recalculateCapture(client, identity, sheet.datasheet.templateInstanceId, sheet.capture.revision);
    assert.deepEqual(saved.validation[`${field.id}:${root.id}`].errors, []);
    await client.query(`INSERT INTO template_values(organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,text_value,saved_by)
      VALUES($1,$2,$3,$4,$5,$6,'text','present',$7,'Forged Product value',$8)`,
    [author.organizationId, sheet.datasheet.templateInstanceId, sheet.datasheet.templateVersionId, field.id, root.id, saved.revision, origin, author.userId]);
  }), { code: '23514', constraint: 'product_detail_readonly' });
  await assert.rejects(work(author, (client, identity) => saveCapture(client, identity, sheet.datasheet.templateInstanceId, sheet.capture.revision,
    [{ fieldId: field.id, occurrenceId: root.id, state: 'present', value: 'Forged Product value' }])), { code: 'readonly_field' });
  let model = flow.reportTemplate.model;
  const reportFieldId = flow.reportTemplate.fieldIds.name;
  for (const defaultValue of ['0', ' ', '']) {
    model = (await work(author, (client, identity) => editTemplate(client, identity, flow.template.versionId, model.version.revision, {
      type: 'configureField', columnId: model.fieldsById[reportFieldId].columnId, widget: 'product_detail_widget', alias: 'name', required: true, defaultValue,
    }))).model;
    assert.equal(model.fieldsById[reportFieldId].defaultText, defaultValue || null);
    assert.equal(model.fieldsById[reportFieldId].defaultState, defaultValue ? 'present' : 'absent');
  }
  assert.equal((await work(author, (client, identity) => loadDatasheet(client, identity, selected.id))).capture.revision, sheet.capture.revision, 'Every forged save rolls back its new revision');
});

test('Product projections require active laboratory access or a live worker lease for the single report sample', async () => {
  const author = await account(); const flow = await prepareProductContextFlow(owner, author);
  const another = await work(author, (client, identity) => registerSample(client, identity, flow.fixture.registration));
  const denied = await account({ organizationId: author.organizationId, permissions: ['samples.create'] });
  const foreign = await account({ permissions: ['samples.read'] });
  const views = ['laboratory_product_context', 'laboratory_product_field_context', 'laboratory_product_value_context'];
  for (const view of views) {
    assert.equal((await owner.query(`SELECT * FROM ${view}`)).rowCount, 0);
    assert.equal((await getPool().query(`SELECT * FROM ${view}`)).rowCount, 0);
    for (const user of [denied, foreign]) assert.equal((await work(user, (client) => client.query(`SELECT * FROM ${view}`))).rowCount, 0);
    assert.equal((await work(author, (client) => client.query("SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE') AS allowed", [view]))).rows[0].allowed, false);
    await assert.rejects(work(author, (client) => client.query(`DELETE FROM ${view} WHERE false`)), { code: '55000' });
  }
  const generated = await work(author, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const rendererId = createHash('sha256').update(randomUUID()).digest('hex');
  await work(author, (client) => client.query('SELECT report_pdf_enqueue($1,$2)', [generated.items[0].id, rendererId]));
  const job = await transaction(async (client) => (await client.query('SELECT * FROM report_pdf_claim($1,$2)', [rendererId, randomUUID()])).rows[0], { pool: worker });
  const lease = [job.organization_id, job.job_id, job.lease_token];
  try {
    await transaction(async (client) => {
      await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [author.organizationId, author.userId]);
      for (const view of views) assert.equal((await client.query(`SELECT * FROM ${view}`)).rowCount, 0);
      const identity = (await client.query('SELECT * FROM report_pdf_begin_read($1,$2,$3)', lease)).rows[0];
      const report = await loadReport(client, identity, generated.items[0].id);
      assert.equal(contextWidgetValue(widget('name'), report), 'First captured Product');
      for (const view of views) {
        assert.deepEqual((await client.query(`SELECT DISTINCT sample_id FROM ${view}`)).rows, [{ sample_id: flow.sample.id }]);
        assert.equal((await client.query(`SELECT * FROM ${view} WHERE sample_id=$1`, [another.id])).rowCount, 0);
      }
      await client.query("SELECT set_config('app.report_pdf_lease_hash','invalid',true)");
      assert.equal((await client.query('SELECT * FROM laboratory_product_context')).rowCount, 0);
    }, { pool: worker });
    for (const table of ['product_versions', 'product_version_custom_fields', 'product_version_custom_field_values']) await assert.rejects(worker.query(`SELECT * FROM ${table}`), { code: '42501' });
    const leaseHash = await transaction(async (client) => {
      await client.query('SELECT * FROM report_pdf_begin_read($1,$2,$3)', lease);
      await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [author.organizationId, author.userId]);
      try { assert.equal((await client.query('SELECT * FROM laboratory_product_value_context')).rowCount, 0); }
      finally { await owner.query('UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2', [author.organizationId, author.userId]); }
      return (await client.query("SELECT current_setting('app.report_pdf_lease_hash') AS hash")).rows[0].hash;
    }, { pool: worker });
    // begin_read holds the lease row until its transaction completes. Expire
    // it afterward, then verify the earlier context cannot authorize a read.
    await owner.query('UPDATE report_pdf_jobs SET lease_expires_at=started_at+(clock_timestamp()-started_at)/2 WHERE organization_id=$1 AND id=$2', [job.organization_id, job.job_id]);
    await transaction(async (client) => {
      await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true),set_config('app.report_pdf_job_id',$3,true),set_config('app.report_pdf_lease_hash',$4,true)",
        [author.organizationId, author.userId, job.job_id, leaseHash]);
      assert.equal((await client.query('SELECT * FROM laboratory_product_field_context')).rowCount, 0);
    }, { pool: worker });
  } finally {
    // A reclaimed synthetic lease is explicitly failed so no unrelated worker
    // can consume this intentionally expired test attempt.
    const reclaimed = await transaction(async (client) => (await client.query('SELECT * FROM report_pdf_claim($1,$2)', [rendererId, randomUUID()])).rows[0], { pool: worker });
    const current = reclaimed ?? job;
    await transaction((client) => client.query('SELECT report_pdf_fail($1,$2,$3,$4,$5,false)', [current.organization_id, current.job_id, current.lease_token, 'synthetic_stop', 'Synthetic lease check complete.']), { pool: worker });
  }
});

test('Product context rejects excessive text before field transfer and never silently truncates too many sample lines', async () => {
  const author = await account(); const flow = await prepareProductContextFlow(owner, author, { complete: false });
  const command = { ...flow.firstCommand, revision: 2, requestId: randomUUID(), customFields: flow.firstCommand.customFields.map((field, index) => index === 2 ? { ...field, value: Array(500).fill('x'.repeat(16_000)) } : field) };
  await work(author, (client, identity) => saveProduct(client, identity, command));
  const sample = await work(author, (client, identity) => registerSample(client, identity, { ...flow.fixture.registration,
    products: [flow.fixture.registration.products[0], flow.fixture.registration.products[0]] }));
  let observed = 0;
  await assert.rejects(work(author, (client, identity) => loadSampleProductContext({ query: (...args) => { observed += 1; return client.query(...args); } }, identity, sample.id,
    ['project_field__splitter__note'])), { code: 'sample_product_context_limit' });
  assert.equal(observed, 2, 'Only bounded headers and aggregate byte/count metadata reached the application');
  const small = await work(author, (client, identity) => loadSampleProductContext(client, identity, sample.id, ['project_field__splitter__amount']));
  assert.equal(small.metrics.queryCount, 4);
  assert.equal(Object.values(small.productDetailsByLineId).every((values) => values.project_field__splitter__amount === '0'), true);
  await owner.query(`INSERT INTO sample_products(organization_id,id,sample_id,product_id,sample_category_id,product_revision,product_code,product_name,category_code,category_name,display_order)
    SELECT line.organization_id,gen_random_uuid(),line.sample_id,line.product_id,line.sample_category_id,line.product_revision,line.product_code,line.product_name,line.category_code,line.category_name,series+10
    FROM sample_products line CROSS JOIN generate_series(1,100) series WHERE line.organization_id=$1 AND line.id=$2`, [author.organizationId, small.primaryProductLineId]);
  observed = 0;
  await assert.rejects(work(author, (client, identity) => loadSampleProductContext({ query: (...args) => { observed += 1; return client.query(...args); } }, identity, sample.id, ['name'])), { code: 'sample_product_context_limit' });
  assert.equal(observed, 1);
});
