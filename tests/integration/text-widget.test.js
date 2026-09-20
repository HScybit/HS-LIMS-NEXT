import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createAnalyticalTemplate } from '../helpers/templates.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate, freezeTemplate } from '../../src/templates/authoring.js';
import { createCapture, saveCapture, changeRepeat } from '../../src/templates/capture.js';
import { loadCapture } from '../../src/templates/loader.js';
import { textWidgetTitle } from '../../src/templates/text.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { enqueueReportPdf, reportPdfFile } from '../../src/reports/jobs.js';
import { processNextReportJob, createReportWorkerPool } from '../../src/reports/worker.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });

test('repeated Text defaults keep source titles while copied explicit title edits retain their entered history', async () => {
  const account = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (action) => withSession(session.token, action, { csrfToken: session.csrfToken });
  const template = await work(createAnalyticalTemplate);
  let revision = 1; let model; const fields = [];
  for (const editable of [true, false]) {
    const added = await work((client, identity) => editTemplate(client, identity, template.versionId, revision,
      { type: 'addColumn', rowId: template.records.rows[0].id }));
    const configured = await work((client, identity) => editTemplate(client, identity, template.versionId, added.model.version.revision,
      { type: 'configureField', columnId: added.model.rowsById[template.records.rows[0].id].columnIds.at(-1), widget: 'text_widget',
        alias: editable ? 'editable_title' : 'static_title', label: editable ? 'Original title' : 'Conclusion', editable }));
    model = configured.model; revision = model.version.revision;
    const field = Object.values(model.fieldsById).find((field) => field.alias === (editable ? 'editable_title' : 'static_title'));
    fields.push(field);
    // Synthetic preexisting source configuration: Title and default_value may
    // differ. The target authoring UI derives Text's default from its title.
    await work((client) => client.query("UPDATE template_fields SET default_state='present',default_text='Different configured default' WHERE organization_id=$1 AND version_id=$2 AND id=$3",
      [account.organizationId, template.versionId, field.id]));
  }
  await work((client, identity) => freezeTemplate(client, identity, template.versionId, revision));
  const created = await work((client, identity) => createCapture(client, identity, template.versionId));
  const original = await work((client, identity) => loadCapture(client, identity.organization_id, created.instanceId));
  const occurrences = original.occurrences.filter((row) => row.groupId === fields[0].repeatGroupId);
  const valueFor = (capture, field, occurrenceId) => capture.values.find((value) => value.fieldId === field.id && value.occurrenceId === occurrenceId);
  for (const field of fields) for (const occurrence of occurrences) {
    const value = valueFor(original, field, occurrence.id);
    assert.equal(value.origin, 'default'); assert.equal(value.textValue, 'Different configured default');
    assert.equal(textWidgetTitle(field, value), field.label);
  }
  let saved = await work((client, identity) => saveCapture(client, identity, created.instanceId, original.revision,
    [{ fieldId: fields[0].id, occurrenceId: occurrences[0].id, state: 'present', value: 'Edited title' }]));
  for (const [occurrenceId, withData, title, origin] of [
    [occurrences[0].id, true, 'Edited title', 'entered'],
    [occurrences[1].id, true, 'Original title', 'default'],
    [occurrences[0].id, false, 'Original title', 'default'],
  ]) {
    saved = await work((client, identity) => changeRepeat(client, identity, created.instanceId, saved.revision, { type: 'clone', occurrenceId, withData }));
    const added = saved.occurrences.find((row) => row.createdRevision === saved.revision);
    assert.equal(textWidgetTitle(fields[0], valueFor(saved, fields[0], added.id)), title);
    assert.equal(valueFor(saved, fields[0], added.id).origin, origin);
    assert.equal(textWidgetTitle(fields[1], valueFor(saved, fields[1], added.id)), 'Conclusion');
    assert.equal(valueFor(saved, fields[1], added.id).origin, 'default');
  }
  const reloaded = await work((client, identity) => loadCapture(client, identity.organization_id, created.instanceId));
  assert.equal(reloaded.values.filter((value) => value.fieldId === fields[0].id && value.origin === 'entered').length, 2);
  assert.deepEqual((await work((client, identity) => loadCapture(client, identity.organization_id, created.instanceId, 1))).values, original.values);
});

test('formatted Text preserves scientific markup in captured report output after later title changes', async () => {
  const user = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute', 'samples.create', 'samples.manage', 'test_requests.allocate'] });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const work = (action) => withSession(account.token, action, { csrfToken: account.csrfToken });
  const addTitle = async (client, identity, template, label) => {
    const added = await editTemplate(client, identity, template.versionId, template.revision, { type: 'addColumn', rowId: template.records.rows[0].id });
    const columnId = added.model.rowsById[template.records.rows[0].id].columnIds.at(-1);
    const result = await editTemplate(client, identity, template.versionId, added.model.version.revision,
      { type: 'configureField', columnId, widget: 'text_widget', alias: 'formatted_title', label });
    return { ...result, columnId };
  };
  const title = '<strong>Water H<sub>2</sub>O</strong> &amp; x<sup>2</sup> = 0';
  const flow = await prepareReportFlow(owner, account, { finalSection: true, prepareDatasheet: (client, identity, template) => addTitle(client, identity, template, title) });
  const configured = await work((client, identity) => addTitle(client, identity, flow.template, '<p style="text-align:center"><b>Detailed report</b></p>'));
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const reportId = generated.items[0].id;
  const original = await work((client, identity) => loadReport(client, identity, reportId));
  const renderer = await loadReportRenderer(); const html = renderer.renderReportDocument(original, renderer.stylesheet);
  assert.ok(html.includes(title)); assert.ok(html.includes('<p style="text-align:center"><b>Detailed report</b></p>'));
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, configured.model.version.revision,
    { type: 'configureField', columnId: configured.columnId, widget: 'text_widget', alias: 'formatted_title', label: 'Later literal title' }));
  const later = await work((client, identity) => loadReport(client, identity, reportId));
  assert.equal(renderer.renderReportDocument(later, renderer.stylesheet), html);
  process.loadEnvFile('.env.worker.local'); const worker = createReportWorkerPool();
  try {
    const queued = await work((client, identity) => enqueueReportPdf(client, identity, reportId));
    assert.deepEqual(await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() }), { jobId: queued.job.id, status: 'succeeded' });
    const file = await work((client, identity) => reportPdfFile(client, identity, reportId));
    assert.equal(file.content.subarray(0, 5).toString(), '%PDF-');
    await writeFile('.local/m03-formatted-text-report.pdf', file.content);
  } finally { await worker.end(); }
});
