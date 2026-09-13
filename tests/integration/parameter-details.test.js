import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareParameterTitleFlow } from '../helpers/parameter-titles.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { refreshParameterDetails, saveCapture, changeRepeat } from '../../src/templates/capture.js';
import { parameterDetailPayload } from '../../src/templates/parameter-detail.js';
import { saveTestParameter } from '../../src/masters/test-parameters.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { prepareParameterDetailJob } from '../helpers/parameter-details.js';
import { createTestRequestJobs } from '../../src/test-requests/jobs.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { createReportWorkerPool, processNextReportJob } from '../../src/reports/worker.js';
import { enqueueReportPdf, reportPdfFile } from '../../src/reports/jobs.js';
import { prepareParameterTitleRegistration } from '../helpers/parameter-title-fields.js';
import { loadDefinition } from '../../src/templates/loader.js';
import { registerSample } from '../../src/samples/register.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const permissions = ['masters.manage', 'templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'];
const work = (user, action) => withSession(user.token, action, { csrfToken: user.csrfToken });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions, ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
const titles = ['name', 'order', 'moa_applicable', 'project_field_data.zero', 'project_field_data.flag', 'project_field_data', ''].map((title, index) =>
  [`detail_${index}`, title, 'parameter_detail_widget', false]);

test('Parameter Detail initializes typed captured values and refreshes atomically with exact retry and clone history', async () => {
  const user = await account();
  const flow = await prepareParameterTitleFlow(owner, user, { complete: false, titles,
    prepareParameter: async (client, identity) => {
      const customFields = [];
      for (const [key, fieldType, value] of [['zero', 'number', 0], ['flag', 'checkbox', false]]) {
        const field = await saveCustomField(client, identity, { id: randomUUID(), revision: 0, requestId: randomUUID(), associatedWith: 'parameter', key, label: key, fieldType });
        customFields.push({ fieldId: field.id, fieldRevision: field.revision, value });
      }
      return { customFields };
    } });
  const initial = await work(user, (client, identity) => loadDatasheet(client, identity, flow.sheet.id));
  const fieldId = (index) => flow.datasheetTitles.fields[`detail_${index}`];
  const values = (capture, index) => capture.values.filter((value) => value.fieldId === fieldId(index));
  assert.ok(values(initial.capture, 0).length);
  assert.ok(values(initial.capture, 0).every((value) => parameterDetailPayload(value) === 'Captured parameter'));
  assert.ok(values(initial.capture, 1).every((value) => parameterDetailPayload(value) === 0));
  assert.deepEqual(parameterDetailPayload(values(initial.capture, 2)[0]), [flow.fixture.method.name]);
  assert.ok(values(initial.capture, 3).every((value) => value.state === 'empty'));
  assert.ok(values(initial.capture, 4).every((value) => value.state === 'empty'));
  assert.deepEqual(values(initial.capture, 5), [], 'An unsupported raw object does not invent an initial cache');
  assert.deepEqual(values(initial.capture, 6), [], 'An unconfigured Title has no initial lookup');
  assert.equal(initial.capture.metrics.queryCount, 5);
  const target = values(initial.capture, 0)[0];
  const selection = { fieldId: target.fieldId, occurrenceId: target.occurrenceId };
  const command = { revision: initial.capture.revision, requestId: randomUUID(), fields: [selection] };
  const refreshed = await work(user, (client, identity) => refreshParameterDetails(client, identity, flow.sheet.template_instance_id, command));
  assert.equal(refreshed.revision, command.revision + 1); assert.equal(refreshed.replayed, false);
  const replayed = await work(user, (client, identity) => refreshParameterDetails(client, identity, flow.sheet.template_instance_id, command));
  assert.equal(replayed.revision, refreshed.revision); assert.equal(replayed.replayed, true);
  assert.equal(parameterDetailPayload(values(replayed, 0).find((value) => value.occurrenceId === target.occurrenceId)), 'Captured parameter');
  const evidence = (await owner.query(`SELECT revision,recorded_by,parameter_detail_field_count FROM template_capture_revisions
    WHERE organization_id=$1 AND parameter_detail_request_id=$2`, [user.organizationId, command.requestId])).rows;
  assert.deepEqual(evidence, [{ revision: refreshed.revision, recorded_by: user.userId, parameter_detail_field_count: 1 }]);
  await assert.rejects(work(user, (client, identity) => refreshParameterDetails(client, identity, flow.sheet.template_instance_id,
    { ...command, fields: [{ ...selection, fieldId: fieldId(1) }] })), { code: 'parameter_detail_request_reused' });
  await assert.rejects(work(user, (client, identity) => refreshParameterDetails(client, identity, flow.sheet.template_instance_id,
    { ...command, requestId: randomUUID() })), { code: 'stale_capture' });
  await assert.rejects(work(user, (client, identity) => saveCapture(client, identity, flow.sheet.template_instance_id, refreshed.revision,
    [{ ...selection, state: 'present', value: 'Forged' }])), { code: 'readonly_field' });
  for (const [index, code] of [[5, 'unsupported_parameter_detail'], [6, 'parameter_detail_key_required']]) {
    await assert.rejects(work(user, (client, identity) => refreshParameterDetails(client, identity, flow.sheet.template_instance_id,
      { ...command, revision: refreshed.revision, requestId: randomUUID(), fields: [selection, { ...selection, fieldId: fieldId(index) }] })), { code });
  }
  const failedRequest = randomUUID();
  await assert.rejects(work(user, async (client, identity) => {
    await refreshParameterDetails(client, identity, flow.sheet.template_instance_id, { ...command, revision: refreshed.revision, requestId: failedRequest });
    throw new Error('Synthetic failure after detail and calculation inserts');
  }), /Synthetic failure/);
  assert.equal((await owner.query('SELECT 1 FROM template_capture_revisions WHERE organization_id=$1 AND parameter_detail_request_id=$2', [user.organizationId, failedRequest])).rowCount, 0);
  await work(user, (client, identity) => saveTestParameter(client, identity, { ...flow.parameterCommand, revision: 2, requestId: randomUUID(), name: 'Later master', order: 9 }));
  const afterEdit = await work(user, (client, identity) => refreshParameterDetails(client, identity, flow.sheet.template_instance_id,
    { ...command, revision: refreshed.revision, requestId: randomUUID(), fields: [selection, { ...selection, fieldId: fieldId(1) }] }));
  assert.equal(parameterDetailPayload(values(afterEdit, 0).find((value) => value.occurrenceId === target.occurrenceId)), 'Captured parameter');
  assert.equal(parameterDetailPayload(values(afterEdit, 1).find((value) => value.occurrenceId === target.occurrenceId)), 0);
  const occurrence = initial.capture.occurrences.find((row) => row.id === target.occurrenceId);
  assert.equal(initial.model.groupsById[occurrence.groupId].source, 'manual');
  let cloned = afterEdit;
  for (const withData of [true, false]) {
    cloned = await work(user, (client, identity) => changeRepeat(client, identity, flow.sheet.template_instance_id, cloned.revision,
      { type: 'clone', occurrenceId: occurrence.id, withData }));
    const reloaded = await work(user, (client, identity) => loadDatasheet(client, identity, flow.sheet.id));
    assert.ok(values(reloaded.capture, 2).length > values(initial.capture, 2).length);
    assert.ok(values(reloaded.capture, 2).every((value) => value.origin === 'parameter' && parameterDetailPayload(value)[0] === flow.fixture.method.name));
  }
  const historical = await work(user, (client, identity) => loadDatasheet(client, identity, flow.sheet.id, { atRevision: initial.capture.revision }));
  assert.deepEqual(historical.capture.values, initial.capture.values);
  const concurrent = { ...command, revision: cloned.revision, requestId: randomUUID() };
  const raced = await Promise.all([1, 2].map(() => work(user, (client, identity) => refreshParameterDetails(client, identity, flow.sheet.template_instance_id, concurrent))));
  assert.deepEqual(raced.map((result) => result.replayed).sort(), [false, true]);
  assert.ok(raced.every((result) => result.revision === concurrent.revision + 1));
  await assert.rejects(work(user, (client) => client.query(`INSERT INTO template_parameter_detail_items
    SELECT * FROM template_parameter_detail_items WHERE organization_id=$1 AND instance_id=$2 LIMIT 1`, [user.organizationId, flow.sheet.template_instance_id])), { code: '23514' });
  for (const statement of ['UPDATE template_parameter_detail_items SET position=position WHERE false', 'DELETE FROM template_parameter_detail_items WHERE false']) {
    await assert.rejects(work(user, (client) => client.query(statement)), { code: '42501' });
  }
});

test('Parameter Detail denies unauthorized writes and preserves missing historical values', async () => {
  const user = await account();
  const flow = await prepareParameterTitleFlow(owner, user, { complete: false, history: false, titles });
  const sheet = await work(user, (client, identity) => loadDatasheet(client, identity, flow.sheet.id));
  const fieldId = flow.datasheetTitles.fields.detail_1;
  const occurrence = sheet.capture.occurrences.find((row) => row.groupId === sheet.model.fieldsById[fieldId].repeatGroupId);
  const command = { revision: sheet.capture.revision, requestId: randomUUID(), fields: [{ fieldId, occurrenceId: occurrence.id }] };
  assert.equal(sheet.capture.values.some((value) => value.fieldId === fieldId), false);
  await assert.rejects(work(user, (client, identity) => refreshParameterDetails(client, identity, flow.sheet.template_instance_id, command)), { code: 'parameter_detail_history_unavailable' });
  for (const options of [{ organizationId: user.organizationId, permissions: ['samples.read'] }, { organizationId: user.organizationId }, {}]) {
    const denied = await account(options);
    await assert.rejects(work(denied, (client, identity) => refreshParameterDetails(client, identity, flow.sheet.template_instance_id, command)),
      (error) => ['forbidden', 'capture_write_denied'].includes(error.code));
  }
  assert.equal((await owner.query('SELECT revision FROM template_instances WHERE organization_id=$1 AND id=$2', [user.organizationId, flow.sheet.template_instance_id])).rows[0].revision, sheet.capture.revision);
});

test('a job uses the whole sample for its fallback while explicit parameter rows and ordinary datasheets remain bound', async () => {
  for (const parameters of [1, 2]) {
    const user = await account({ permissions: [...permissions, 'settings.manage'] });
    const flow = await prepareParameterDetailJob(owner, user, { parameters });
    const job = (await work(user, (client, identity) => createTestRequestJobs(client, identity,
      { requestIds: [flow.requests[0].id], analystUserId: user.userId, reviewerUserId: null }))).items[0];
    const sheet = await work(user, (client, identity) => loadDatasheet(client, identity, job.datasheetId));
    const root = sheet.capture.occurrences.find((row) => row.groupId === null);
    assert.equal(sheet.capture.values.find((value) => value.fieldId === flow.fields.loop).textValue, 'Job parameter');
    const outside = sheet.capture.values.find((value) => value.fieldId === flow.fields.outside);
    assert.equal(outside?.textValue, parameters === 1 ? 'Job parameter' : undefined);
    const command = { revision: sheet.capture.revision, requestId: randomUUID(), fields: [{ fieldId: flow.fields.outside, occurrenceId: root.id }] };
    if (parameters === 1) await work(user, (client, identity) => refreshParameterDetails(client, identity, sheet.capture.instance.id, command));
    else await assert.rejects(work(user, (client, identity) => refreshParameterDetails(client, identity, sheet.capture.instance.id, command)), { code: 'parameter_detail_unavailable' });
    const childId = (await owner.query('SELECT id FROM datasheets WHERE organization_id=$1 AND test_request_id=$2', [user.organizationId, flow.requests[0].id])).rows[0].id;
    const child = await work(user, (client, identity) => loadDatasheet(client, identity, childId));
    assert.equal(child.capture.values.find((value) => value.fieldId === flow.fields.outside).textValue, 'Job parameter');
  }
});

test('reports use their own parameter membership and retain exact Title projections and frozen caches through restricted PDF rendering', async () => {
  const user = await account();
  const selectedTitles = [['report_name', 'name'], ['report_method', 'moa_applicable'], ['custom_detail', 'project_field_data.note'], ['underscored_detail', 'project_field_data_note']]
    .map(([alias, label]) => [alias, label, 'parameter_detail_widget', false]);
  const flow = await prepareParameterTitleFlow(owner, user, { titles: selectedTitles, prepareParameter: async (client, identity, fixture) => {
    const secondKey = randomUUID();
    const second = (await owner.query(`INSERT INTO test_parameters(organization_id,code,name,master_key,scheme_abbreviation,measurement_unit_id)
      VALUES($1,$2,'Second report parameter',$2,$2,$3) RETURNING id`, [user.organizationId, secondKey, fixture.unit.id])).rows[0];
    await owner.query('INSERT INTO parameter_methods(organization_id,test_parameter_id,method_id,is_default) VALUES($1,$2,$3,true)', [user.organizationId, second.id, fixture.method.id]);
    fixture.registration.products[0].tests.push({ ...fixture.registration.products[0].tests[0], testParameterId: second.id, decisionRuleId: null });
    const field = await saveCustomField(client, identity, { id: randomUUID(), revision: 0, requestId: randomUUID(), associatedWith: 'parameter', key: 'note', label: 'Note', fieldType: 'text' });
    return { customFields: [{ fieldId: field.id, fieldRevision: field.revision, value: 'Captured detail note' }] };
  } });
  const outsideField = flow.reportTitles.model.fieldsById[flow.reportTitles.fields.literal_name_title];
  const outsideRowId = flow.reportTitles.model.columnsById[outsideField.columnId].rowId;
  const added = await work(user, (client, identity) => editTemplate(client, identity, flow.template.versionId, flow.reportTitles.revision,
    { type: 'addColumn', rowId: outsideRowId }));
  await work(user, (client, identity) => editTemplate(client, identity, flow.template.versionId, added.model.version.revision,
    { type: 'configureField', columnId: added.model.rowsById[outsideRowId].columnIds.at(-1), widget: 'parameter_detail_widget', alias: 'outside_detail', label: 'name' }));
  const selectedProduct = (await owner.query('SELECT sample_product_id FROM sample_tests WHERE organization_id=$1 AND id=$2', [user.organizationId, flow.completed[0].sampleTestId])).rows[0].sample_product_id;
  const generated = await work(user, (client, identity) => generateReports(client, identity, flow.sample.id,
    { ...flow.input, reportType: 'parameter_wise', templateSelections: [{ key: selectedProduct, templateId: flow.template.templateId }], selectedSampleTestIds: [flow.completed[0].sampleTestId] }));
  const reportId = generated.items[0].id;
  const report = await work(user, (client, identity) => loadReport(client, identity, reportId));
  assert.equal(report.parameterDetailFallback?.parameterDetailValues.name, 'Captured parameter', 'The source child report owns its own parameter list');
  const combined = await work(user, (client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID() }));
  assert.equal((await work(user, (client, identity) => loadReport(client, identity, combined.items[0].id))).parameterDetailFallback, undefined);
  assert.equal(report.results[0].parameterDetailValues['project_field_data.note'], 'Captured detail note');
  assert.equal(report.results[0].parameterDetailValues.project_field_data_note, null, 'Normalized keys do not merge independent report columns');
  const renderer = await loadReportRenderer(); const before = renderer.renderReportDocument(report, renderer.stylesheet);
  assert.match(before, /Captured detail note/);
  assert.match(before, /title="Refresh detail"/);
  assert.doesNotMatch(before, /Second report parameter/);
  await work(user, (client, identity) => saveTestParameter(client, identity, { ...flow.parameterCommand, revision: 2, requestId: randomUUID(), name: 'Later parameter' }));
  const later = await work(user, (client, identity) => loadReport(client, identity, reportId));
  assert.equal(renderer.renderReportDocument(later, renderer.stylesheet), before);
  const frozen = report.finalCaptures[flow.sheet.template_instance_id];
  const nameField = Object.values(report.datasheetModels[frozen.versionId].fieldsById).find((field) => field.alias === 'report_name');
  const cached = frozen.values.find((value) => value.fieldId === nameField.id);
  await assert.rejects(work(user, (client, identity) => refreshParameterDetails(client, identity, flow.sheet.template_instance_id,
    { revision: frozen.revision, requestId: randomUUID(), fields: [{ fieldId: cached.fieldId, occurrenceId: cached.occurrenceId }] })), { code: 'capture_write_denied' });
  process.loadEnvFile('.env.worker.local'); const worker = createReportWorkerPool();
  try {
    const queued = await work(user, (client, identity) => enqueueReportPdf(client, identity, reportId));
    assert.deepEqual(await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() }), { jobId: queued.job.id, status: 'succeeded' });
    assert.equal((await work(user, (client, identity) => reportPdfFile(client, identity, reportId))).content.subarray(0, 5).toString(), '%PDF-');
  } finally { await worker.end(); }
});

test('registration-only initialization reads Detail through the actual new child and the method scope expires afterward', async () => {
  const admin = await account({ permissions: [...permissions, 'settings.manage'] });
  const fixture = await prepareParameterTitleRegistration(owner, admin);
  const fields = await work(admin, async (client, identity) => {
    let { model } = await loadDefinition(client, identity.organization_id, fixture.template.versionId);
    const fields = [];
    for (const [index, title] of ['project_field_data.creation', 'moa_applicable'].entries()) {
      const rowId = fixture.template.records.rows[0].id;
      ({ model } = await editTemplate(client, identity, fixture.template.versionId, model.version.revision, { type: 'addColumn', rowId }));
      const columnId = model.rowsById[rowId].columnIds.at(-1);
      ({ model } = await editTemplate(client, identity, fixture.template.versionId, model.version.revision,
        { type: 'configureField', columnId, widget: 'parameter_detail_widget', alias: `creation_detail_${index}`, label: title }));
      fields.push(model.columnsById[columnId].fieldId);
    }
    return fields;
  });
  const creator = await account({ organizationId: admin.organizationId, permissions: ['samples.create'] });
  const sample = await work(creator, (client, identity) => registerSample(client, identity, fixture.registration));
  const child = sample.testRequests.find((row) => row.datasheetId);
  const sheet = await work(admin, (client, identity) => loadDatasheet(client, identity, child.datasheetId));
  assert.equal(sheet.capture.values.find((value) => value.fieldId === fields[0]).textValue, 'Captured creation title');
  assert.deepEqual(parameterDetailPayload(sheet.capture.values.find((value) => value.fieldId === fields[1])), [fixture.method.name]);
  await work(creator, async (client) => {
    await client.query("SELECT set_config('app.auto_job_request_id',$1,true)", [child.id]);
    assert.equal((await client.query('SELECT * FROM laboratory_parameter_method_context')).rowCount, 0);
  });
});
