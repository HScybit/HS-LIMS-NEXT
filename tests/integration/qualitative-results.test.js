import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareSubjectJob } from '../helpers/job-subjects.js';
import { createReportTemplate } from '../helpers/reports.js';
import { pdfPageText } from '../helpers/pdf-page-text.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { saveCapture, changeRepeat, createCapture } from '../../src/templates/capture.js';
import { requireCaptureWrite } from '../../src/templates/access.js';
import { createTemplate, editTemplate, createDraft, freezeTemplate } from '../../src/templates/authoring.js';
import { loadDefinition, loadCapture } from '../../src/templates/loader.js';
import { loadWorkflowRun } from '../../src/workflows/load.js';
import { submitDatasheetTransition } from '../../src/workflows/requests.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';

const owner = ownerPool(); let account; let outsider;
const permissions = ['samples.read', 'samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute', 'settings.manage'];
const work = (callback, options = {}, user = account) => withSession(user.token, callback, { csrfToken: user.csrfToken, ...options });
const load = (id, options) => work((client, identity) => loadDatasheet(client, identity, id, options), { readOnly: true });
const fieldOf = (sheet) => Object.values(sheet.model.fieldsById).find((field) => field.widget === 'result_widget');
const input = (field, row, value) => ({ fieldId: field.id, occurrenceId: row.id, state: value === null ? 'empty' : 'present', ...(value === null ? {} : { value }) });
const prepare = (options) => prepareSubjectJob(owner, account, account, { resultWidget: true, resultValueType: 'result', ...options });
before(async () => {
  account = await createAccount(owner, { permissions }); outsider = await createAccount(owner, { permissions });
  for (const user of [account, outsider]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

test('new authoring uses the result contract while copying and editing old numeric definitions preserves their contract', async () => {
  const template = await work((client, identity) => createTemplate(client, identity, { name: 'Synthetic qualitative authoring', kind: 'datasheet' }));
  const section = await work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'addSection' }));
  const initial = await work((client, identity) => editTemplate(client, identity, template.versionId, section.model.version.revision,
    { type: 'addRow', sectionId: section.model.rootSectionIds[0] }));
  const column = Object.values(initial.model.columnsById)[0];
  const authored = await work((client, identity) => editTemplate(client, identity, template.versionId, initial.model.version.revision,
    { type: 'configureField', columnId: column.id, widget: 'result_widget', alias: 'qualitative', displayScale: 2 }));
  assert.equal(Object.values(authored.model.fieldsById)[0].valueType, 'result');
  assert.equal(Object.values(authored.model.fieldsById)[0].numeric.valueType, 'result');
  const flow = await prepare({ resultValueType: 'numeric' }); const frozen = await load(flow.job.datasheetId);
  const oldField = fieldOf(frozen);
  const edited = await work((client, identity) => editTemplate(client, identity, flow.template.versionId, flow.template.revision,
    { type: 'configureField', columnId: oldField.columnId, widget: 'result_widget', alias: oldField.alias, label: 'Changed draft title' }));
  assert.equal(edited.model.fieldsById[oldField.id].valueType, 'numeric');
  assert.equal(fieldOf(await load(flow.job.datasheetId)).valueType, 'numeric');
});

test('mixed child inputs retain text, zero, clears and actual history across clones, stale saves and reload', async () => {
  const flow = await prepare({ manualParent: true }); let sheet = await load(flow.job.datasheetId);
  assert.equal(sheet.metrics.definition.queryCount, 9); assert.equal(sheet.metrics.capture.queryCount, 3);
  const field = fieldOf(sheet); const rows = sheet.capture.occurrences.filter((row) => row.subject);
  const first = rows[0]; const second = rows.find((row) => row.subject.testRequestId !== first.subject.testRequestId);
  const saved = await work((client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision,
    [input(field, first, 'Not detected'), input(field, second, '0')]));
  await assert.rejects(work((client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision, [input(field, first, 'Stale')])), { code: 'stale_capture' });
  sheet = await load(flow.job.datasheetId);
  assert.equal(sheet.dataContext.parametersByRequestId[first.subject.testRequestId].finalResult, 'Not detected');
  assert.equal(sheet.dataContext.parametersByRequestId[second.subject.testRequestId].finalResult, '0');
  const cloned = await work((client, identity) => changeRepeat(client, identity, sheet.capture.instance.id, sheet.capture.revision, { type: 'clone', occurrenceId: first.parentId, withData: true }));
  assert.equal(cloned.values.filter((value) => value.textValue === 'Not detected').length, 2);
  const count = await owner.query('SELECT count(*)::integer AS count FROM job_result_entries WHERE organization_id=$1 AND datasheet_id=$2', [account.organizationId, flow.job.datasheetId]);
  assert.equal(count.rows[0].count, 2);
  await work((client, identity) => saveCapture(client, identity, sheet.capture.instance.id, cloned.revision, [input(field, first, null)]));
  const cleared = await load(flow.job.datasheetId);
  assert.equal(cleared.dataContext.parametersByRequestId[first.subject.testRequestId].finalResult, null);
  assert.equal((await load(flow.job.datasheetId, { atRevision: saved.revision })).dataContext.parametersByRequestId[first.subject.testRequestId].finalResult, 'Not detected');
  const history = await owner.query('SELECT value_type,state,number_value,text_value,saved_by FROM template_values WHERE organization_id=$1 AND instance_id=$2 AND field_id=$3 AND occurrence_id=$4 ORDER BY revision',
    [account.organizationId, sheet.capture.instance.id, field.id, first.id]);
  assert.deepEqual(history.rows.map((value) => [value.value_type, value.state, value.number_value, value.text_value]), [['result', 'present', null, 'Not detected'], ['result', 'empty', null, null]]);
  assert.ok(history.rows.every((value) => value.saved_by === account.userId));
  assert.equal((await work((client) => client.query('SELECT * FROM template_values WHERE instance_id=$1', [sheet.capture.instance.id]), { readOnly: true }, outsider)).rowCount, 0);
});

test('database boundaries reject disguised numbers, conflicting payloads and forged qualitative entries atomically', async () => {
  const flow = await prepare(); const sheet = await load(flow.job.datasheetId); const field = fieldOf(sheet);
  const row = sheet.capture.occurrences.find((item) => item.subject);
  for (const [text, number, lexical] of [['12abc', null, null], ['1.234', null, null], ['\u00a0Absent', null, null], ['Absent', '0', '0'], ['Absent', null, '0'], ['', null, null], ['Absent', null, null]]) {
    await assert.rejects(work(async (client) => {
      await requireCaptureWrite(client, sheet.capture.instance.id);
      await client.query('UPDATE template_instances SET revision=revision+1 WHERE organization_id=$1 AND id=$2', [account.organizationId, sheet.capture.instance.id]);
      await client.query(`INSERT INTO template_values(organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,text_value,number_value,lexical,saved_by)
        VALUES($1,$2,$3,$4,$5,$6,'result','present','entered',$7,$8,$9,$10)`,
      [account.organizationId, sheet.capture.instance.id, sheet.model.version.id, field.id, row.id, sheet.capture.revision + 1, text, number, lexical, account.userId]);
      // The valid final text case deliberately omits the actual child receipt.
    }), { code: '23514' });
  }
  assert.equal((await load(flow.job.datasheetId)).capture.revision, sheet.capture.revision);
});

test('qualitative child results complete through the real workflow and remain typed in frozen report and PDF output', async () => {
  const flow = await prepare(); let sheet = await load(flow.job.datasheetId); const field = fieldOf(sheet);
  const raw = Object.values(sheet.model.fieldsById).find((item) => item.alias === 'raw_0');
  const rows = sheet.capture.occurrences.filter((row) => row.subject);
  await work((client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision,
    rows.flatMap((row, index) => [input(raw, row, '0'), input(field, row, index ? '0' : 'Not detected')])));
  sheet = await load(flow.job.datasheetId);
  const run = await work((client, identity) => loadWorkflowRun(client, identity, flow.job.workflowRunId), { readOnly: true });
  const submitted = await work((client, identity) => submitDatasheetTransition(client, identity, run.id, {
    datasheetId: sheet.datasheet.id, datasheet: { revision: sheet.datasheet.revision, captureRevision: sheet.capture.revision },
    transition: { revision: run.revision, transitionId: run.transitions[0].id, comment: 'Synthetic qualitative acceptance', checklistItemIds: [] },
  }));
  assert.equal(submitted.status, 'completed');
  const template = await work(createReportTemplate);
  const sampleTests = await owner.query('SELECT sample_test_id FROM test_requests WHERE organization_id=$1 AND parent_test_request_id=$2 ORDER BY job_member_position', [account.organizationId, flow.job.id]);
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, { requestId: randomUUID(), revision: 1, reportType: 'consolidated',
    templateSelections: [{ key: 'consolidated', templateId: template.templateId }], selectedSampleTestIds: sampleTests.rows.map((row) => row.sample_test_id) }));
  const report = await work((client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true });
  assert.equal(report.metrics.definition.queryCount, 9); assert.equal(report.metrics.capture.queryCount, 0, 'Scalar submissions need no full capture reload.');
  assert.deepEqual(report.results.map((result) => [result.resultType, result.finalResult]), [['text', 'Not detected'], ['numeric', '0']]);
  const renderer = await loadReportRenderer(); const html = renderer.renderReportDocument(report, renderer.stylesheet);
  assert.match(html, />Not detected</); assert.match(html, />0</);
  const pdf = await renderer.renderReportPdf({ html, printConfig: report.printConfig, stylesheet: renderer.stylesheet });
  await writeFile('.local/m03-qualitative-results.pdf', pdf);
  assert.ok((await pdfPageText('.local/m03-qualitative-results.pdf', ['Not detected'])).flat().some((item) => item.label === 'Not detected'));
  await owner.query("UPDATE test_parameters SET name='Changed later qualitative parameter',revision=revision+1 WHERE organization_id=$1 AND id=$2", [account.organizationId, flow.source.parameter.id]);
  const later = await work((client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true });
  assert.equal(renderer.renderReportDocument(later, renderer.stylesheet), html);
});

test('configured defaults and clones retain authored zero without selecting a child result until an actual commit', async () => {
  const flow = await prepare({ manualParent: true, resultDefaultValue: '000.00' });
  let sheet = await load(flow.job.datasheetId); const field = fieldOf(sheet);
  const values = sheet.capture.values.filter((value) => value.fieldId === field.id);
  assert.equal(field.defaultLexical, '000.00'); assert.equal(values.length, 4);
  assert.ok(values.every((value) => value.origin === 'default' && value.numberValue === '0.00' && value.lexical === '000.00'));
  const count = async () => (await owner.query('SELECT count(*)::integer AS count FROM job_result_entries WHERE organization_id=$1 AND datasheet_id=$2', [account.organizationId, sheet.datasheet.id])).rows[0].count;
  assert.equal(await count(), 0);
  const row = sheet.capture.occurrences.find((item) => item.subject);
  const saved = await work((client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision, [input(field, row, null)]));
  assert.equal(await count(), 1);
  const entered = saved.values.find((value) => value.fieldId === field.id && value.occurrenceId === row.id);
  assert.equal(entered.origin, 'entered'); assert.equal(entered.lexical, '000.00');
  const cloned = await work((client, identity) => changeRepeat(client, identity, sheet.capture.instance.id, saved.revision, { type: 'clone', occurrenceId: row.parentId, withData: false }));
  const newIds = new Set(cloned.occurrences.filter((item) => !sheet.capture.occurrences.some((before) => before.id === item.id)).map((item) => item.id));
  const copied = cloned.values.filter((value) => value.fieldId === field.id && newIds.has(value.occurrenceId));
  assert.equal(copied.length, 2); assert.ok(copied.every((value) => value.origin === 'default' && value.lexical === '000.00'));
  assert.equal(await count(), 1);
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, flow.template.revision,
    { type: 'configureField', columnId: field.columnId, widget: field.widget, alias: field.alias, defaultValue: 'Not detected' }));
  sheet = await load(flow.job.datasheetId); assert.equal(fieldOf(sheet).defaultLexical, '000.00');
});

test('default history cannot be forged at a later revision or disagree with a new occurrence frozen default', async () => {
  const flow = await prepare({ resultDefaultValue: 'Not detected' }); const sheet = await load(flow.job.datasheetId); const field = fieldOf(sheet);
  const row = sheet.capture.occurrences.find((item) => item.subject);
  for (const newOccurrence of [false, true]) {
    await assert.rejects(work(async (client) => {
      await requireCaptureWrite(client, sheet.capture.instance.id);
      await client.query('UPDATE template_instances SET revision=revision+1 WHERE organization_id=$1 AND id=$2', [account.organizationId, sheet.capture.instance.id]);
      const occurrenceId = newOccurrence ? randomUUID() : row.id;
      if (newOccurrence) await client.query(`INSERT INTO template_occurrences(organization_id,id,instance_id,version_id,group_id,parent_id,position,created_revision)
        VALUES($1,$2,$3,$4,$5,$6,2,$7)`, [account.organizationId, occurrenceId, sheet.capture.instance.id, sheet.model.version.id, row.groupId, row.parentId, sheet.capture.revision + 1]);
      await client.query(`INSERT INTO template_values(organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,text_value,saved_by)
        VALUES($1,$2,$3,$4,$5,$6,'result','present','default',$7,$8)`,
      [account.organizationId, sheet.capture.instance.id, sheet.model.version.id, field.id, occurrenceId, sheet.capture.revision + 1, newOccurrence ? 'Forged default' : 'Not detected', account.userId]);
    }), { code: '23514', message: 'Default history must match its frozen field and new occurrence' });
  }
  assert.equal((await load(flow.job.datasheetId)).capture.revision, sheet.capture.revision);
});

test('default authoring survives frozen version copying, stale saves and clearing without rewriting earlier capture values', async () => {
  const template = await work((client, identity) => createTemplate(client, identity, { name: 'Synthetic controlled result defaults', kind: 'datasheet' }));
  let edited = await work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'addSection' }));
  edited = await work((client, identity) => editTemplate(client, identity, template.versionId, edited.model.version.revision, { type: 'addRow', sectionId: edited.model.rootSectionIds[0] }));
  const columnId = Object.keys(edited.model.columnsById)[0];
  edited = await work((client, identity) => editTemplate(client, identity, template.versionId, edited.model.version.revision,
    { type: 'configureField', columnId, widget: 'result_widget', alias: 'controlled_result', defaultValue: 'Not detected' }));
  await work((client, identity) => freezeTemplate(client, identity, template.versionId, edited.model.version.revision));
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  const draft = await work((client, identity) => createDraft(client, identity, template.versionId));
  const copied = await work((client, identity) => loadDefinition(client, identity.organization_id, draft.versionId), { readOnly: true });
  assert.equal(Object.values(copied.model.fieldsById)[0].defaultText, 'Not detected');
  const command = { type: 'configureField', columnId, widget: 'result_widget', alias: 'controlled_result', defaultValue: '-' };
  edited = await work((client, identity) => editTemplate(client, identity, draft.versionId, 1, command));
  assert.equal(Object.values(edited.model.fieldsById)[0].defaultState, 'absent');
  await assert.rejects(work((client, identity) => editTemplate(client, identity, draft.versionId, 1, command)), { code: 'stale_template' });
  await work((client, identity) => freezeTemplate(client, identity, draft.versionId, edited.model.version.revision));
  const next = await work((client, identity) => createCapture(client, identity, draft.versionId));
  const [oldValues, newValues] = await Promise.all([
    work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId), { readOnly: true }),
    work((client, identity) => loadCapture(client, identity.organization_id, next.instanceId), { readOnly: true }),
  ]);
  assert.equal(oldValues.values[0].textValue, 'Not detected'); assert.equal(oldValues.values[0].origin, 'default');
  assert.equal(newValues.values.length, 0);
});
