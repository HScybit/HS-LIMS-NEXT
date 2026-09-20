import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createReportTemplate } from '../helpers/reports.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate, freezeTemplate, createDraft } from '../../src/templates/authoring.js';
import { loadDefinition, loadCapture } from '../../src/templates/loader.js';
import { contextWidgetValue } from '../../src/templates/context-widgets.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { enqueueReportPdf, reportPdfFile } from '../../src/reports/jobs.js';
import { processNextReportJob, createReportWorkerPool } from '../../src/reports/worker.js';
import { createAnalyticalTemplate } from '../helpers/templates.js';
import { createCapture, saveCapture, recalculateCapture, changeRepeat } from '../../src/templates/capture.js';
import { loadDatasheet } from '../../src/datasheets/service.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (user, action, readOnly = false) => withSession(user.token, action, { csrfToken: user.csrfToken, readOnly });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions: ['templates.manage'], ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}

test('TR Data configuration creates no captured defaults or required input errors and SQL rejects forged values', async () => {
  const user = await account({ permissions: ['templates.manage', 'datasheets.execute'] });
  const template = await work(user, createAnalyticalTemplate);
  const added = await work(user, (client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'addColumn', rowId: template.records.rows[0].id }));
  const configured = await work(user, (client, identity) => editTemplate(client, identity, template.versionId, added.model.version.revision,
    { type: 'configureField', columnId: added.model.rowsById[template.records.rows[0].id].columnIds.at(-1), widget: 'tr_data_widget', alias: 'tr_metadata',
      sourceField: 'requestNumber', label: 'Request title', required: true, defaultValue: '0' }));
  const field = Object.values(configured.model.fieldsById).find((field) => field.alias === 'tr_metadata');
  await work(user, (client, identity) => freezeTemplate(client, identity, template.versionId, configured.model.version.revision));
  const created = await work(user, (client, identity) => createCapture(client, identity, template.versionId));
  let capture = await work(user, (client, identity) => loadCapture(client, identity.organization_id, created.instanceId), true);
  assert(!capture.values.some((value) => value.fieldId === field.id));
  const occurrence = capture.occurrences.find((row) => row.groupId === field.repeatGroupId);
  for (const origin of ['entered', 'default']) await assert.rejects(work(user, async (client, identity) => {
    const recalculated = await recalculateCapture(client, identity, created.instanceId, capture.revision);
    assert.deepEqual(recalculated.validation[`${field.id}:${occurrence.id}`].errors, []);
    await client.query(`INSERT INTO template_values(organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,text_value,saved_by)
      VALUES($1,$2,$3,$4,$5,$6,'text','present',$7,'0',$8)`,
    [user.organizationId, created.instanceId, template.versionId, field.id, occurrence.id, recalculated.revision, origin, user.userId]);
  }), { code: '23514', constraint: 'tr_data_readonly' });
  await assert.rejects(work(user, (client, identity) => saveCapture(client, identity, created.instanceId, capture.revision,
    [{ fieldId: field.id, occurrenceId: occurrence.id, state: 'present', value: '0' }])), { code: 'readonly_field' });
  for (const withData of [true, false]) {
    capture = await work(user, (client, identity) => changeRepeat(client, identity, created.instanceId, capture.revision, { type: 'clone', occurrenceId: occurrence.id, withData }));
    assert(!capture.values.some((value) => value.fieldId === field.id));
    for (const row of capture.occurrences.filter((row) => row.groupId === field.repeatGroupId)) assert.deepEqual(capture.validation[`${field.id}:${row.id}`].errors, []);
  }
  const first = await work(user, (client, identity) => loadCapture(client, identity.organization_id, created.instanceId, 1), true);
  assert(!first.values.some((value) => value.fieldId === field.id));
});

test('TR Data controls preserve exact defaults, omission, old source selectors and isolated frozen clones', async () => {
  const user = await account(); const template = await work(user, createReportTemplate);
  const original = template.records.fields.find((field) => field.widget === 'tr_data_widget'); let revision = 1;
  const command = { type: 'configureField', columnId: original.columnId, widget: original.widget, alias: original.alias,
    label: 'Request parameter title', required: true };
  async function configure(extra) {
    let calls = 0;
    const result = await work(user, (client, identity) => editTemplate({ query: (...args) => { calls++; return client.query(...args); } }, identity,
      template.versionId, revision, { ...command, ...extra }));
    revision = result.model.version.revision; assert.equal(result.metrics.queryCount, 9);
    return { field: result.model.fieldsById[original.id], calls };
  }
  const baseline = await configure({});
  for (const value of ['0', 'false', '-', '  exact default  ', '<b>Default</b>', 'x'.repeat(16000)]) {
    const saved = await configure({ defaultValue: value }); assert.equal(saved.calls, baseline.calls, 'defaults add no per-field SQL calls');
    assert.equal(saved.field.defaultText, value); assert.equal(saved.field.defaultState, 'present');
    assert.equal(saved.field.sourceField, original.sourceField); assert.equal(saved.field.label, command.label); assert.equal(saved.field.required, true);
    assert.equal(contextWidgetValue(saved.field, { results: [{ parameterName: 'Actual parameter' }] }), 'Actual parameter');
    assert.equal(contextWidgetValue(saved.field, { results: [] }), '');
    assert.equal((await configure({})).field.defaultText, value);
  }
  const cleared = await configure({ defaultValue: '' }); assert.equal(cleared.field.defaultState, 'absent'); assert.equal(cleared.field.defaultText, null);
  const saved = await configure({ defaultValue: '-' });
  await work(user, (client, identity) => freezeTemplate(client, identity, template.versionId, revision));
  const frozen = await work(user, (client, identity) => loadDefinition(client, identity.organization_id, template.versionId), true);
  assert.deepEqual(frozen.model.fieldsById[original.id], saved.field);
  const draft = await work(user, (client, identity) => createDraft(client, identity, template.versionId));
  const copied = await work(user, (client, identity) => loadDefinition(client, identity.organization_id, draft.versionId), true);
  assert.equal(copied.model.fieldsById[original.id].defaultText, '-'); assert.equal(copied.model.fieldsById[original.id].sourceField, original.sourceField);
  await work(user, (client, identity) => editTemplate(client, identity, draft.versionId, 1, { ...command, label: 'Later title', defaultValue: null }));
  const old = await work(user, (client, identity) => loadDefinition(client, identity.organization_id, template.versionId), true);
  assert.deepEqual(old.model.fieldsById[original.id], frozen.model.fieldsById[original.id]);
});

test('invalid TR Data edits roll back without losing previous defaults or bypassing access', async () => {
  const user = await account(); const template = await work(user, createReportTemplate);
  const original = template.records.fields.find((field) => field.widget === 'tr_data_widget');
  const command = { type: 'configureField', columnId: original.columnId, widget: original.widget, alias: original.alias, label: 'Keep title', defaultValue: '0' };
  const saved = await work(user, (client, identity) => editTemplate(client, identity, template.versionId, 1, command));
  for (const [changes, code] of [[{ defaultValue: '\0' }, 'invalid_input'], [{ defaultValue: '\ud800' }, 'invalid_input'], [{ defaultValue: 'x'.repeat(16001) }, 'invalid_input'],
    [{ defaultValue: false }, 'invalid_input'], [{ alias: 'moa' }, 'duplicate_alias'], [{ alias: 'not valid' }, 'invalid_alias'], [{ editable: true }, 'readonly_context_widget']]) {
    await assert.rejects(work(user, (client, identity) => editTemplate(client, identity, template.versionId, saved.model.version.revision, { ...command, ...changes })), { code });
  }
  const reader = await account({ organizationId: user.organizationId, permissions: ['templates.read'] }); const foreign = await account();
  await assert.rejects(work(reader, (client, identity) => editTemplate(client, identity, template.versionId, saved.model.version.revision, command)), { code: 'forbidden' });
  await assert.rejects(work(foreign, (client, identity) => editTemplate(client, identity, template.versionId, saved.model.version.revision, command)), { code: 'stale_template' });
  const current = await work(user, (client, identity) => loadDefinition(client, identity.organization_id, template.versionId), true);
  assert.deepEqual(current.model, saved.model);
});

test('TR Data title and default revisions remain frozen while browser and worker output use recorded source values', async () => {
  const user = await account({ permissions: ['templates.manage', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const flow = await prepareReportFlow(owner, user, { finalSection: true, finalContext: true, prepareDatasheet: async (client, identity, template) => {
    const { model } = await loadDefinition(client, identity.organization_id, template.versionId);
    const field = Object.values(model.fieldsById).find((field) => field.widget === 'tr_data_widget');
    await editTemplate(client, identity, template.versionId, model.version.revision, { type: 'configureField', columnId: field.columnId,
      widget: field.widget, alias: field.alias, label: 'Hidden datasheet title', required: true, defaultValue: 'Never capture this default' });
  } });
  const sheet = await work(user, (client, identity) => loadDatasheet(client, identity, flow.sheet.id), true);
  const sheetField = Object.values(sheet.model.fieldsById).find((field) => field.widget === 'tr_data_widget');
  assert(!sheet.capture.values.some((value) => value.fieldId === sheetField.id));
  const field = flow.template.records.fields.find((field) => field.widget === 'tr_data_widget');
  const command = { type: 'configureField', columnId: field.columnId, widget: field.widget, alias: field.alias, label: 'Hidden config title', defaultValue: 'Never display this default', required: true };
  const configured = await work(user, (client, identity) => editTemplate(client, identity, flow.template.versionId, 1, command));
  const generated = await work(user, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input)); const reportId = generated.items[0].id;
  const original = await work(user, (client, identity) => loadReport(client, identity, reportId), true);
  const renderer = await loadReportRenderer(); const html = renderer.renderReportDocument(original, renderer.stylesheet);
  assert(!html.includes(command.label)); assert(!html.includes(command.defaultValue));
  assert(!html.includes('Never capture this default')); assert(!html.includes('Hidden datasheet title'));
  assert(html.includes(original.results[0].parameterName));
  await work(user, (client, identity) => editTemplate(client, identity, flow.template.versionId, configured.model.version.revision,
    { ...command, label: 'Later config title', defaultValue: '-' }));
  const reloaded = await work(user, (client, identity) => loadReport(client, identity, reportId), true);
  assert.equal(renderer.renderReportDocument(reloaded, renderer.stylesheet), html);
  assert.equal(reloaded.model.fieldsById[field.id].label, command.label); assert.equal(reloaded.model.fieldsById[field.id].defaultText, command.defaultValue);
  process.loadEnvFile('.env.worker.local'); const worker = createReportWorkerPool();
  try {
    const queued = await work(user, (client, identity) => enqueueReportPdf(client, identity, reportId));
    assert.deepEqual(await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() }), { jobId: queued.job.id, status: 'succeeded' });
    const file = await work(user, (client, identity) => reportPdfFile(client, identity, reportId), true);
    assert.equal(file.content.subarray(0, 5).toString(), '%PDF-');
  } finally { await worker.end(); }
});
