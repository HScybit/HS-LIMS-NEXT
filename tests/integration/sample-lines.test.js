import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { addSampleLineWidgets, prepareSampleLineFlow } from '../helpers/sample-lines.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { prepareSubjectJob } from '../helpers/job-subjects.js';
import { createAlternateMethod } from '../helpers/methods.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool, transaction } from '../../src/db/pool.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { saveProduct } from '../../src/masters/products.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadSampleLineContexts } from '../../src/samples/line-context.js';
import { sampleLineAttributes, sampleLineValue } from '../../src/templates/sample-line.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { saveCapture, recalculateCapture, changeRepeat } from '../../src/templates/capture.js';
import { editTemplate, freezeTemplate } from '../../src/templates/authoring.js';
import { loadDefinition } from '../../src/templates/loader.js';
import { addTestRequestMethod } from '../../src/test-requests/methods.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';
import { createReportWorkerPool } from '../../src/reports/worker.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const permissions = ['masters.manage', 'templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'settings.manage'];
const work = (user, action, options) => withSession(user.token, action, { csrfToken: user.csrfToken, ...options });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions, ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
const runtime = (user, id) => work(user, (client, identity) => loadDatasheet(client, identity, id), { readOnly: true });

test('line widgets retain creation observations and report child selection across repeated final sections, edits and exact retries', async () => {
  const user = await account(); const flow = await prepareSampleLineFlow(owner, user);
  const sheets = await Promise.all(flow.completed.map((item) => runtime(user, item.sheet.id)));
  assert.deepEqual((await runtime(user, flow.sheet.id.toUpperCase())).dataContext, sheets[0].dataContext);
  assert.equal(sheets[0].dataContext.lineItem.quantity, '1.00000000000000001');
  assert.deepEqual(sheets[0].dataContext.results, []);
  assert.deepEqual(sheets[0].dataContext.parametersByRequestId, {});
  for (const [index, sheet] of sheets.entries()) {
    assert.equal(sheet.dataContext.lineItem.description, index ? 'Second captured line' : 'First captured line');
    assert.equal(sheet.metrics.lineItems.queryCount, 1); assert.equal(sheet.metrics.metadataQueryCount, 1);
    for (const { value, property } of sampleLineAttributes) assert.equal(sampleLineValue({ sourceField: value }, sheet.dataContext.lineItem), String(sheet.dataContext.lineItem[property]));
    assert.equal(sheet.capture.values.some((value) => sheet.model.fieldsById[value.fieldId].widget === 'sample_line_item_data_widget'), false);
  }
  await work(user, (client, identity) => saveProduct(client, identity, { id: flow.fixture.product.id, revision: 1, requestId: randomUUID(),
    key: flow.fixture.product.code, name: 'Product observed at report generation' }));
  await owner.query('UPDATE sample_categories SET name=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [user.organizationId, flow.fixture.category.id, 'Category observed at report generation']);
  const attempts = await Promise.all([1, 2].map(() => work(user, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input))));
  assert.equal(attempts.filter((result) => result.replayed).length, 1);
  assert.equal(attempts[0].items[0].id, attempts[1].items[0].id);
  const reportId = attempts[0].items[0].id;
  const original = await work(user, (client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  assert.deepEqual((await work(user, (client, identity) => loadReport(client, identity, reportId.toUpperCase()))).lineItem, original.lineItem);
  assert.equal(original.lineItem.sampleProductId, sheets[0].datasheet.sampleProductId);
  assert.equal(original.lineItem.productName, 'Product observed at report generation');
  assert.equal(original.lineItem.categoryName, 'Category observed at report generation');
  assert.equal(original.metrics.lineItems.queryCount, 1);
  const renderer = await loadReportRenderer(); const html = renderer.renderReportDocument(original, renderer.stylesheet);
  assert.match(html, /First captured line/); assert.match(html, /Product observed at report generation/);
  assert.equal(html.includes('Second captured line'), false, 'Nested final sections use the child report line, not their original datasheet line');
  assert.equal(html.includes('Unused source'), false);
  for (const type of ['product_wise', 'parameter_wise']) {
    const generated = await work(user, (client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID(), reportType: type,
      templateSelections: [{ key: sheets[1].datasheet.sampleProductId, templateId: flow.template.templateId }], selectedSampleTestIds: [flow.completed[1].sampleTestId] }));
    const child = await work(user, (client, identity) => loadReport(client, identity, generated.items[0].id));
    assert.equal(child.report.sampleProductId, sheets[1].datasheet.sampleProductId);
    assert.equal(child.lineItem.sampleProductId, sheets[0].datasheet.sampleProductId);
  }
  await work(user, (client) => client.query('UPDATE sample_products SET description=$3,quality=$4,display_order=display_order+10 WHERE organization_id=$1 AND id=$2',
    [user.organizationId, sheets[0].datasheet.sampleProductId, 'Later line text', 'Later quality']));
  await work(user, (client, identity) => saveProduct(client, identity, { id: flow.fixture.product.id, revision: 2, requestId: randomUUID(), key: flow.fixture.product.code, name: 'Later Product' }));
  await owner.query('UPDATE sample_categories SET name=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [user.organizationId, flow.fixture.category.id, 'Later Category']);
  const later = await work(user, (client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  assert.deepEqual(later.lineItem, original.lineItem); assert.equal(renderer.renderReportDocument(later, renderer.stylesheet), html);
  assert.deepEqual((await runtime(user, flow.sheet.id)).dataContext.lineItem, sheets[0].dataContext.lineItem);
  await assert.rejects(work(user, (client) => client.query('SELECT sample_line_snapshot_reports($1::uuid[])', [[reportId]])), { constraint: 'sample_line_creation' });
  await assert.rejects(owner.query('UPDATE sample_line_contexts SET description=$2 WHERE report_id=$1', [reportId, 'Forged history']), { code: '55000' });
});

test('canvas selection changes only its source attribute and enforces revision, frozen, type and permission boundaries', async () => {
  const user = await account(); const fixture = await createLaboratoryFixture(owner, user, { repeated: false });
  const added = await work(user, (client, identity) => addSampleLineWidgets(client, identity, fixture.template, fixture.template.records.sections[0].id, ['custom_description']));
  const fieldId = added.fieldIds.custom_description; const before = added.model.fieldsById[fieldId];
  let model = added.model;
  for (const [sourceField, expected] of [[' custom_quality ', 'custom_quality'], [' -1 ', null], ['', null]]) {
    model = (await work(user, (client, identity) => editTemplate(client, identity, added.versionId, model.version.revision, { type: 'selectSampleLineAttribute', fieldId, sourceField }))).model;
    assert.deepEqual({ ...model.fieldsById[fieldId], sourceField: before.sourceField }, before);
    assert.equal(model.fieldsById[fieldId].sourceField, expected);
  }
  await assert.rejects(work(user, (client, identity) => editTemplate(client, identity, added.versionId, added.revision, { type: 'selectSampleLineAttribute', fieldId, sourceField: 'custom_product' })), { code: 'stale_template' });
  for (const command of [
    { type: 'selectSampleLineAttribute', fieldId, sourceField: '__proto__' },
    { type: 'selectSampleLineAttribute', fieldId: fixture.template.records.fields[0].id, sourceField: 'custom_product' },
    { type: 'configureField', columnId: before.columnId, widget: before.widget, editable: true },
  ]) await assert.rejects(work(user, (client, identity) => editTemplate(client, identity, added.versionId, model.version.revision, command)), { status: 400 });
  assert.equal((await work(user, (client, identity) => loadDefinition(client, identity.organization_id, added.versionId))).model.version.revision, model.version.revision);
  const denied = await account({ organizationId: user.organizationId, permissions: ['templates.read'] });
  await assert.rejects(work(denied, (client, identity) => editTemplate(client, identity, added.versionId, model.version.revision, { type: 'selectSampleLineAttribute', fieldId, sourceField: 'custom_product' })), { code: 'forbidden' });
  await work(user, (client, identity) => freezeTemplate(client, identity, added.versionId, model.version.revision));
  await assert.rejects(work(user, (client, identity) => editTemplate(client, identity, added.versionId, model.version.revision + 1, { type: 'selectSampleLineAttribute', fieldId, sourceField: 'custom_product' })), { code: 'stale_template' });
});

test('consolidated child line filtering includes the same selected parameter on another parent Product', async () => {
  const user = await account(); const secondProductId = randomUUID();
  await work(user, (client, identity) => saveProduct(client, identity, { id: secondProductId, revision: 0, requestId: randomUUID(), key: `SECOND_${secondProductId.slice(0, 8)}`, name: 'Second Product with the same parameter' }));
  const flow = await prepareReportFlow(owner, user, { prepareProduct: async (_client, _identity, fixture) => {
    // Product-category association is fixture setup, as in product-context.js;
    // runtime Product history writes do not grant direct association editing.
    await owner.query('INSERT INTO product_sample_categories(organization_id,product_id,sample_category_id) VALUES($1,$2,$3)', [user.organizationId, secondProductId, fixture.category.id]);
    fixture.registration.products[0].description = 'Earlier parent Product line';
    fixture.registration.products.push({ ...structuredClone(fixture.registration.products[0]), productId: secondProductId, description: 'Selected second Product line',
      tests: fixture.registration.products[0].tests.map((selected) => ({ ...selected, decisionRuleId: null })) });
  } });
  await work(user, (client, identity) => addSampleLineWidgets(client, identity, flow.template, flow.template.records.sections.find((section) => section.isParameterLoop).id, ['custom_description']));
  const input = { ...flow.input, selectedSampleTestIds: [flow.completed[1].sampleTestId] };
  const generated = await work(user, (client, identity) => generateReports(client, identity, flow.sample.id, input));
  const report = await work(user, (client, identity) => loadReport(client, identity, generated.items[0].id));
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].productName, 'Second Product with the same parameter');
  assert.equal(report.lineItem.description, 'Earlier parent Product line');
  assert.equal(report.lineItem.productId, flow.fixture.product.id);
  const productId = report.results[0].sampleProductId;
  const productReport = await work(user, (client, identity) => generateReports(client, identity, flow.sample.id, { ...input, requestId: randomUUID(), reportType: 'product_wise',
    templateSelections: [{ key: productId, templateId: flow.template.templateId }] }));
  assert.equal((await work(user, (client, identity) => loadReport(client, identity, productReport.items[0].id))).lineItem.description, 'Selected second Product line');
});

test('line widgets reject entered/default history while clones and alternate methods keep the proper creation line', async () => {
  const user = await account(); const flow = await prepareSampleLineFlow(owner, user, { complete: false, secondLine: false });
  let sheet = await runtime(user, flow.sheet.id);
  const fieldId = flow.datasheetTemplate.fieldIds.custom_description;
  const field = sheet.model.fieldsById[fieldId]; const occurrence = sheet.capture.occurrences.find((row) => row.groupId === field.repeatGroupId);
  await assert.rejects(work(user, (client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision,
    [{ fieldId, occurrenceId: occurrence.id, state: 'present', value: 'Forged line' }])), { code: 'readonly_field' });
  for (const origin of ['default', 'entered']) await assert.rejects(work(user, async (client, identity) => {
    const saved = await recalculateCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision);
    await client.query(`INSERT INTO template_values(organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,text_value,saved_by)
      VALUES($1,$2,$3,$4,$5,$6,'text','present',$7,'Forged line',$8)`, [user.organizationId, sheet.capture.instance.id, sheet.model.version.id, fieldId, occurrence.id, saved.revision, origin, user.userId]);
  }), { constraint: 'sample_line_readonly' });
  for (const withData of [false, true]) {
    await work(user, (client, identity) => changeRepeat(client, identity, sheet.capture.instance.id, sheet.capture.revision, { type: 'clone', occurrenceId: occurrence.id, withData }));
    sheet = await runtime(user, flow.sheet.id);
    assert.equal(sheet.capture.values.some((value) => value.fieldId === fieldId), false);
    assert.equal(sheet.dataContext.lineItem.description, 'First captured line');
  }
  await work(user, (client) => client.query('UPDATE sample_products SET description=$3 WHERE organization_id=$1 AND id=$2', [user.organizationId, sheet.datasheet.sampleProductId, 'Alternate creation line']));
  const method = await createAlternateMethod(owner, user, flow.fixture);
  const added = await work(user, (client, identity) => addTestRequestMethod(client, identity, flow.requestId, { revision: 2, methodId: method.id }));
  assert.equal((await runtime(user, added.datasheetId)).dataContext.lineItem.description, 'Alternate creation line');
  assert.equal((await runtime(user, flow.sheet.id)).dataContext.lineItem.description, 'First captured line');
});

test('expanded line text rejects an oversized clone and initial allocation atomically', async () => {
  const user = await account();
  for (const minimum of [524, 525]) {
    const fixture = await createLaboratoryFixture(owner, user, { repeated: false });
    const template = await work(user, (client, identity) => addSampleLineWidgets(client, identity, fixture.template, fixture.template.records.sections[0].id, ['custom_description'], { repeat: true }));
    const field = template.model.fieldsById[template.fieldIds.custom_description]; const rowId = template.model.columnsById[field.columnId].rowId;
    let edited = await work(user, (client, identity) => editTemplate(client, identity, template.versionId, template.revision, { type: 'addColumn', rowId }));
    edited = await work(user, (client, identity) => editTemplate(client, identity, template.versionId, edited.model.version.revision, {
      type: 'configureField', columnId: edited.model.rowsById[rowId].columnIds.at(-1), widget: field.widget, alias: 'another_description', sourceField: 'custom_description' }));
    await owner.query('UPDATE template_repeat_groups SET minimum=$3 WHERE organization_id=$1 AND version_id=$2 AND id=$4', [user.organizationId, template.versionId, minimum, field.repeatGroupId]);
    const sample = await work(user, (client, identity) => registerSample(client, identity, fixture.registration));
    await work(user, (client) => client.query('UPDATE sample_products SET description=$3 WHERE organization_id=$1 AND sample_id=$2', [user.organizationId, sample.id, 'x'.repeat(16000)]));
    const requests = await work(user, (client, identity) => generateTestRequests(client, identity, sample.id));
    const allocate = () => work(user, (client, identity) => allocateTestRequest(client, identity, requests.items[0].id, { revision: 1, assignedUserId: user.userId, assignmentType: 'analyst' }));
    if (minimum === 525) {
      await assert.rejects(allocate(), { constraint: 'sample_line_size_limit' });
      assert.equal((await owner.query('SELECT 1 FROM datasheets WHERE organization_id=$1 AND test_request_id=$2', [user.organizationId, requests.items[0].id])).rowCount, 0);
      assert.equal((await owner.query('SELECT revision FROM test_requests WHERE organization_id=$1 AND id=$2', [user.organizationId, requests.items[0].id])).rows[0].revision, 1);
    } else {
      const allocation = await allocate(); const sheet = await runtime(user, allocation.datasheetId);
      const occurrence = sheet.capture.occurrences.find((row) => row.groupId === field.repeatGroupId);
      await assert.rejects(work(user, (client, identity) => changeRepeat(client, identity, sheet.capture.instance.id, sheet.capture.revision, { type: 'clone', occurrenceId: occurrence.id, withData: false })), { constraint: 'sample_line_size_limit' });
      const unchanged = await runtime(user, allocation.datasheetId);
      assert.equal(unchanged.capture.revision, sheet.capture.revision); assert.equal(unchanged.capture.occurrences.length, sheet.capture.occurrences.length);
    }
  }
});

test('job summaries use their actual job product line independently of bound parameter rows', async () => {
  const user = await account();
  const flow = await prepareSubjectJob(owner, user, user, { prepareTemplate: async (client, identity, template, fixture) => {
    fixture.registration.products[0].description = 'The job product line';
    await addSampleLineWidgets(client, identity, template, template.parameterSectionId, ['custom_description']);
  } });
  const sheet = await runtime(user, flow.job.datasheetId);
  assert.equal(sheet.dataContext.lineItem.description, 'The job product line');
  assert.equal(sheet.metrics.lineItems.queryCount, 1);
  assert.equal(sheet.dataContext.results.length, 2);
  for (const item of sheet.dataContext.results) assert.equal(item.sampleProductId, sheet.dataContext.lineItem.sampleProductId);
});

test('typed line contexts require active consumer authority and a worker can read only its leased report', async () => {
  const user = await account(); const flow = await prepareSampleLineFlow(owner, user);
  const reportId = (await work(user, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input))).items[0].id;
  const secondReportId = (await work(user, (client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID() }))).items[0].id;
  const denied = await account({ organizationId: user.organizationId, permissions: ['samples.create'] });
  const foreign = await account({ permissions: ['samples.manage'] });
  assert.equal((await getPool().query('SELECT * FROM sample_line_contexts')).rowCount, 0);
  for (const actor of [denied, foreign]) assert.equal((await work(actor, (client) => client.query('SELECT * FROM sample_line_contexts'))).rowCount, 0);
  await assert.rejects(work(user, (client) => client.query('DELETE FROM sample_line_contexts WHERE report_id=$1', [reportId])), { code: '42501' });
  await assert.rejects(work(user, (client, identity) => loadSampleLineContexts(client, identity.organization_id, { reportIds: [randomUUID()] })), { code: 'incomplete_sample_line_history' });
  const rendererId = createHash('sha256').update(randomUUID()).digest('hex');
  await work(user, (client) => client.query('SELECT report_pdf_enqueue($1,$2)', [reportId, rendererId]));
  process.loadEnvFile('.env.worker.local'); const worker = createReportWorkerPool(); let job;
  try {
    assert.equal((await worker.query('SELECT * FROM sample_line_contexts')).rowCount, 0);
    job = await transaction(async (client) => (await client.query('SELECT * FROM report_pdf_claim($1,$2)', [rendererId, randomUUID()])).rows[0], { pool: worker });
    await transaction(async (client) => {
      const identity = (await client.query('SELECT * FROM report_pdf_begin_read($1,$2,$3)', [job.organization_id, job.job_id, job.lease_token])).rows[0];
      const report = await loadReport(client, identity, reportId); assert.equal(report.lineItem.description, 'First captured line');
      assert.equal((await client.query('SELECT * FROM sample_line_contexts WHERE datasheet_id IS NOT NULL')).rowCount, 0);
      assert.equal((await client.query('SELECT * FROM sample_line_contexts WHERE report_id=$1', [secondReportId])).rowCount, 0);
      assert.equal((await client.query('SELECT * FROM sample_line_contexts')).rowCount, 1);
      await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [user.organizationId, user.userId]);
      assert.equal((await client.query('SELECT * FROM sample_line_contexts')).rowCount, 0, 'Revoking the actor invalidates the line read inside an existing lease');
      await owner.query('UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2', [user.organizationId, user.userId]);
    }, { pool: worker });
    await assert.rejects(worker.query('SELECT sample_line_snapshot_reports($1::uuid[])', [[reportId]]), { code: '42501' });
    await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [user.organizationId, user.userId]);
    await transaction(async (client) => {
      await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [user.organizationId, user.userId]);
      assert.equal((await client.query('SELECT * FROM sample_line_contexts')).rowCount, 0);
    }, { pool: getPool() });
    await owner.query('UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2', [user.organizationId, user.userId]);
  } finally {
    if (job) await transaction((client) => client.query('SELECT report_pdf_fail($1,$2,$3,$4,$5,false)', [job.organization_id, job.job_id, job.lease_token, 'synthetic_line_complete', 'Synthetic line scope verification complete']), { pool: worker });
    await worker.end();
  }
});
