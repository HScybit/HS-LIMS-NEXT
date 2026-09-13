import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareParameterTitleFlow } from '../helpers/parameter-titles.js';
import { prepareParameterTitleRegistration } from '../helpers/parameter-title-fields.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveTestParameter, retireTestParameter } from '../../src/masters/test-parameters.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { registerSample } from '../../src/samples/register.js';
import { enqueueReportPdf, reportPdfFile } from '../../src/reports/jobs.js';
import { createReportWorkerPool, processNextReportJob } from '../../src/reports/worker.js';
import { saveCapture, changeRepeat } from '../../src/templates/capture.js';
import { loadWorkflowRun } from '../../src/workflows/load.js';
import { submitDatasheetTransition } from '../../src/workflows/requests.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const permissions = ['masters.manage', 'templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'];
const work = (user, action) => withSession(user.token, action, { csrfToken: user.csrfToken });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions, ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}

test('parameter custom-field titles preserve captured primitives, arrays, dates and definition metadata in frozen reports', async () => {
  const user = await account(); const definitions = []; const commands = [];
  const raw = [0, false, ['old', 'second'], '2026-03-08T02:30', ''];
  const keys = ['zero', 'flag', 'options', 'date', 'blank'];
  const titles = keys.map((key) => [`custom_${key}`, `any.prefix.${key}`, 'text_widget', false]);
  titles.push(['vertical_zero', 'project_field_data.zero', 'vertical_text_widget', false],
    ['vertical_false', 'project_field_data.flag', 'vertical_text_widget', false], ['whole_map', 'project_field_data', 'text_widget', false]);
  const flow = await prepareParameterTitleFlow(owner, user, { titles, literalTitle: 'literal.zero',
    prepareParameter: async (client, identity) => {
      for (const [index, fieldType] of ['number', 'checkbox', 'select', 'date_time', 'text'].entries()) {
        const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), key: keys[index], label: keys[index],
          associatedWith: 'parameter', fieldType, displayOrder: index, allowsMultiple: index === 2,
          ...(index === 2 ? { options: ['old', 'second'].map((key) => ({ id: randomUUID(), key, label: `Captured ${key}` })) } : {}) };
        commands.push(command); definitions.push(await saveCustomField(client, identity, command));
      }
      return { customFields: definitions.map((field, index) => ({ fieldId: field.id, fieldRevision: field.revision, value: raw[index] })),
        customFieldTimeZone: 'America/New_York' };
    } });
  const reader = await account({ organizationId: user.organizationId, permissions: ['samples.read'] });
  const sheet = await work(reader, (client, identity) => loadDatasheet(client, identity, flow.sheet.id));
  const fields = sheet.dataContext.parametersByRequestId[flow.requestId].parameterTitleValues.project_field_data;
  assert.ok(fields, 'Captured Custom Fields are available to actual parameter-bound titles');
  assert.deepEqual(keys.map((key) => fields[key].value), raw);
  assert.deepEqual(keys.map((key) => fields[key].display_value), [0, false, 'Captured old, Captured second', '08/03/2026 03:30:00', '']);
  assert.equal(fields.options.name, 'options'); assert.equal(fields.options.type, 'select');
  assert.equal(fields.date.datetime_format, 'DD/MM/YYYY HH:mm:ss');
  assert.equal(sheet.metrics.parameters.queryCount, 3);
  const generated = await work(user, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const reportId = generated.items[0].id;
  await assert.rejects(work(reader, (client, identity) => loadReport(client, identity, reportId)), { code: 'workflow_action_denied' });
  const original = await work(user, (client, identity) => loadReport(client, identity, reportId));
  assert.deepEqual(original.results[0].parameterTitleValues.project_field_data, fields);
  const renderer = await loadReportRenderer(); const html = renderer.renderReportDocument(original, renderer.stylesheet);
  assert.match(html, /Captured old, Captured second/); assert.match(html, /08\/03\/2026 03:30:00/);
  assert.match(html, /writing-mode:vertical-rl[^>]*>0<\/p>/);
  assert.match(html, /<div>literal.zero<\/div>/);
  for (const [index, field] of definitions.entries()) {
    const changed = await work(user, (client, identity) => saveCustomField(client, identity,
      { ...commands[index], revision: field.revision, requestId: randomUUID(), label: `Later ${field.label}` }));
    await work(user, (client, identity) => retireCustomField(client, identity, { id: field.id, revision: changed.revision, requestId: randomUUID() }));
  }
  const { customFields: _fields, customFieldTimeZone: _zone, ...omitted } = flow.parameterCommand;
  const changed = await work(user, (client, identity) => saveTestParameter(client, identity, { ...omitted, name: 'Later parameter', revision: 2, requestId: randomUUID() }));
  await work(user, (client, identity) => retireTestParameter(client, identity, { id: changed.id, revision: changed.revision, requestId: randomUUID() }));
  const later = await work(user, (client, identity) => loadReport(client, identity, reportId));
  assert.equal(renderer.renderReportDocument(later, renderer.stylesheet), html);
  assert.deepEqual((await work(reader, (client, identity) => loadDatasheet(client, identity, flow.sheet.id))).dataContext, sheet.dataContext);
  process.loadEnvFile('.env.worker.local'); const worker = createReportWorkerPool();
  try {
    const queued = await work(user, (client, identity) => enqueueReportPdf(client, identity, reportId));
    assert.deepEqual(await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() }), { jobId: queued.job.id, status: 'succeeded' });
    assert.equal((await work(user, (client, identity) => reportPdfFile(client, identity, reportId))).content.subarray(0, 5).toString(), '%PDF-');
  } finally { await worker.end(); }
});

test('registration-only custom-title admission is limited to the actual new child and expires with the generation transaction', async () => {
  const admin = await account({ permissions: [...permissions, 'settings.manage'] });
  const fixture = await prepareParameterTitleRegistration(owner, admin);
  const creator = await account({ organizationId: admin.organizationId, permissions: ['samples.create'] });
  let reads = 0;
  const sample = await work(creator, async (client, identity) => {
    const original = client.query.bind(client);
    client.query = async (...args) => {
      const result = await original(...args);
      if (typeof args[0] === 'string' && args[0].includes('FROM unnest($2::uuid[],$3::uuid[]) chosen')) {
        reads += 1;
        assert.equal(result.rowCount, 1);
        const scoped = (await original('SELECT parameter_name,parameter_id FROM laboratory_parameter_context')).rows;
        assert.deepEqual(scoped, [{ parameter_name: 'Creation parameter', parameter_id: fixture.parameter.id }]);
        assert.equal((await original('SELECT * FROM laboratory_parameter_field_context')).rowCount, 1);
        assert.equal((await original('SELECT * FROM parameter_version_custom_fields')).rowCount, 0);
      }
      return result;
    };
    try { return await registerSample(client, identity, fixture.registration); } finally { client.query = original; }
  });
  assert.equal(reads, 1);
  const child = sample.testRequests.find((row) => row.datasheetId); assert.ok(child);
  for (const user of [creator, await account({ permissions: ['samples.create'] })]) await work(user, async (client) => {
    await client.query("SELECT set_config('app.auto_job_request_id',$1,true)", [child.id]);
    for (const view of ['laboratory_parameter_context', 'laboratory_parameter_field_context', 'laboratory_parameter_value_context'])
      assert.equal((await client.query(`SELECT * FROM ${view}`)).rowCount, 0);
  });
  const captured = await work(admin, (client, identity) => loadDatasheet(client, identity, child.datasheetId));
  assert.equal(captured.dataContext.parametersByRequestId[child.id].parameterTitleValues.project_field_data.creation.display_value, 'Captured creation title');
});

async function largeFields(client, identity) {
  const field = await saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'large', label: 'Large synthetic title',
    fieldType: 'text', associatedWith: 'parameter', allowsMultiple: true });
  return { customFields: [{ fieldId: field.id, fieldRevision: field.revision, value: Array(400).fill('x'.repeat(16000)) }] };
}

test('oversized title edits, either clone mode and report expansion roll back before publishing unusable history', async () => {
  const user = await account();
  const flow = await prepareParameterTitleFlow(owner, user, { complete: false, prepareParameter: largeFields,
    titles: [['large_title', 'prefix.large', 'text_widget', true]] });
  const original = await work(user, (client, identity) => loadDatasheet(client, identity, flow.sheet.id));
  const fieldId = flow.datasheetTitles.fields.large_title;
  const field = original.model.fieldsById[fieldId]; const occurrenceId = original.capture.occurrences.find((row) => row.groupId === field.repeatGroupId).id;
  assert.ok(original.metrics.parameters.renderedTextBytes > 12_000_000);
  await assert.rejects(work(user, (client, identity) => saveCapture(client, identity, flow.sheet.template_instance_id, 1,
    [{ fieldId, occurrenceId, state: 'present', value: 'project_field_data' }])), { code: 'parameter_title_size_limit' });
  for (const withData of [true, false]) await assert.rejects(work(user, (client, identity) => changeRepeat(client, identity,
    flow.sheet.template_instance_id, 1, { type: 'clone', occurrenceId, withData })), { code: 'parameter_title_size_limit' });
  const unchanged = await work(user, (client, identity) => loadDatasheet(client, identity, flow.sheet.id));
  assert.equal(unchanged.capture.revision, 1); assert.deepEqual(unchanged.capture.occurrences, original.capture.occurrences);
  assert.deepEqual(unchanged.capture.values, original.capture.values);
  const inputs = Object.values(original.model.fieldsById).filter((field) => field.widget === 'number_widget').flatMap((field) =>
    original.capture.occurrences.filter((row) => (row.groupId ?? null) === (field.repeatGroupId ?? null)).map((row) => ({ fieldId: field.id, occurrenceId: row.id, state: 'present', value: '0' })));
  const saved = await work(user, (client, identity) => saveCapture(client, identity, flow.sheet.template_instance_id, 1, inputs));
  const runId = (await owner.query('SELECT id FROM workflow_runs WHERE organization_id=$1 AND test_request_id=$2', [user.organizationId, flow.requestId])).rows[0].id;
  const run = await work(user, (client, identity) => loadWorkflowRun(client, identity, runId));
  await work(user, (client, identity) => submitDatasheetTransition(client, identity, runId, { datasheetId: flow.sheet.id,
    datasheet: { revision: 1, captureRevision: saved.revision }, transition: { revision: run.revision, transitionId: run.transitions[0].id, comment: '', checklistItemIds: [] } }));
  await assert.rejects(work(user, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input)), { code: 'parameter_title_size_limit' });
  assert.equal((await owner.query('SELECT id FROM sample_reports WHERE organization_id=$1 AND sample_id=$2', [user.organizationId, flow.sample.id])).rowCount, 0);
  assert.equal((await owner.query('SELECT id FROM sample_events WHERE organization_id=$1 AND id=$2', [user.organizationId, flow.input.requestId])).rowCount, 0);
});

test('initial custom title admission rolls back allocation while unbound dotted literals make no field reads', async () => {
  const user = await account();
  await assert.rejects(prepareParameterTitleFlow(owner, user, { complete: false, titles: [['large_title', 'prefix.large', 'text_widget', false]],
    prepareParameter: async (client, identity, fixture) => {
      await client.query('UPDATE template_repeat_groups SET minimum=3 WHERE organization_id=$1 AND version_id=$2', [identity.organization_id, fixture.template.versionId]);
      return largeFields(client, identity);
    } }), { code: 'parameter_title_size_limit' });
  assert.deepEqual((await owner.query('SELECT status FROM test_requests WHERE organization_id=$1', [user.organizationId])).rows, [{ status: 'created' }]);
  assert.equal((await owner.query('SELECT id FROM datasheets WHERE organization_id=$1', [user.organizationId])).rowCount, 0);
  const plainUser = await account();
  const plain = await prepareParameterTitleFlow(owner, plainUser, { complete: false, prepareParameter: largeFields,
    titles: [['plain_title', 'name', 'text_widget', false]], literalTitle: 'project_field_data.large' });
  const loaded = await work(plainUser, (client, identity) => loadDatasheet(client, identity, plain.sheet.id));
  assert.equal(loaded.metrics.parameters, undefined); assert.equal(loaded.dataContext.results[0].parameterTitleValues.project_field_data, undefined);
});
