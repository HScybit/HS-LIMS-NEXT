import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createAnalyticalTemplate } from '../helpers/templates.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate, freezeTemplate, createDraft } from '../../src/templates/authoring.js';
import { loadDefinition, loadCapture } from '../../src/templates/loader.js';
import { createCapture, saveCapture, changeRepeat, recalculateCapture } from '../../src/templates/capture.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (account, action, options) => withSession(account.token, action, { csrfToken: account.csrfToken, ...options });
async function account() {
  const user = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute', 'samples.create', 'samples.manage', 'test_requests.allocate'] });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}

async function addVertical(client, identity, template, label) {
  const added = await editTemplate(client, identity, template.versionId, template.revision, { type: 'addColumn', rowId: template.records.rows[0].id });
  const columnId = added.model.rowsById[template.records.rows[0].id].columnIds.at(-1);
  const configured = await editTemplate(client, identity, template.versionId, added.model.version.revision,
    { type: 'configureField', columnId, widget: 'vertical_text_widget', alias: 'vertical_title', label, defaultValue: 'Unused configured default' });
  return { ...configured, columnId, fieldId: configured.model.columnsById[columnId].fieldId };
}

test('Vertical Text preserves configuration and frozen history without creating or accepting capture values', async () => {
  const author = await account();
  const template = await work(author, createAnalyticalTemplate);
  let configured = await work(author, (client, identity) => addVertical(client, identity, template, '0'));
  const { columnId, fieldId } = configured;
  const command = { type: 'configureField', columnId, widget: 'vertical_text_widget', alias: 'vertical_title', label: '0' };
  for (const defaultValue of ['0', ' ', '-', '', 'Unused configured default']) {
    configured = await work(author, (client, identity) => editTemplate(client, identity, template.versionId, configured.model.version.revision, { ...command, defaultValue }));
    assert.equal(configured.model.fieldsById[fieldId].defaultText, defaultValue || null);
    assert.equal(configured.model.fieldsById[fieldId].defaultState, defaultValue ? 'present' : 'absent');
  }
  await assert.rejects(work(author, (client, identity) => editTemplate(client, identity, template.versionId, configured.model.version.revision, { ...command, editable: true })), { code: 'readonly_text_widget' });
  await assert.rejects(work(author, (client) => client.query('UPDATE template_fields SET editable=true WHERE organization_id=$1 AND version_id=$2 AND id=$3',
    [author.organizationId, template.versionId, fieldId])), { code: '23514', constraint: 'template_vertical_text_readonly' });
  await work(author, (client, identity) => freezeTemplate(client, identity, template.versionId, configured.model.version.revision));
  const created = await work(author, (client, identity) => createCapture(client, identity, template.versionId));
  const capture = await work(author, (client, identity) => loadCapture(client, identity.organization_id, created.instanceId));
  assert.equal(capture.values.some((value) => value.fieldId === fieldId), false);
  const occurrenceId = capture.occurrences.find((row) => row.groupId === configured.model.fieldsById[fieldId].repeatGroupId).id;
  for (const origin of ['entered', 'default', 'calculated']) await assert.rejects(work(author, async (client, identity) => {
    const changed = origin === 'default'
      ? await changeRepeat(client, identity, created.instanceId, capture.revision, { type: 'clone', occurrenceId, withData: false })
      : await recalculateCapture(client, identity, created.instanceId, capture.revision);
    const targetOccurrence = origin === 'default' ? changed.occurrences.find((row) => row.createdRevision === changed.revision).id : occurrenceId;
    await client.query(`INSERT INTO template_values(organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,text_value,saved_by)
      VALUES($1,$2,$3,$4,$5,$6,'text','present',$7,$8,$9)`,
    [author.organizationId, created.instanceId, template.versionId, fieldId, targetOccurrence, changed.revision, origin,
      origin === 'default' ? 'Unused configured default' : 'Forged title', author.userId]);
  }), { code: '23514', ...(origin !== 'calculated' ? { constraint: 'vertical_text_readonly' } : {}) });
  await assert.rejects(work(author, (client, identity) => saveCapture(client, identity, created.instanceId, capture.revision,
    [{ fieldId, occurrenceId, state: 'present', value: 'Forged title' }])), { code: 'readonly_field' });
  let repeated = capture;
  for (const withData of [false, true]) repeated = await work(author, (client, identity) => changeRepeat(client, identity, created.instanceId, repeated.revision,
    { type: 'clone', occurrenceId, withData }));
  assert.equal(repeated.values.some((value) => value.fieldId === fieldId), false);
  const draft = await work(author, (client, identity) => createDraft(client, identity, template.versionId));
  const edited = await work(author, (client, identity) => editTemplate(client, identity, draft.versionId, draft.revision, { ...command, label: '' }));
  assert.equal(edited.model.fieldsById[fieldId].label, '');
  assert.equal(edited.model.fieldsById[fieldId].defaultText, 'Unused configured default');
  const frozen = await work(author, (client, identity) => loadDefinition(client, identity.organization_id, template.versionId));
  assert.equal(frozen.model.fieldsById[fieldId].label, '0');
  assert.equal((await work(author, (client, identity) => loadCapture(client, identity.organization_id, created.instanceId))).instance.version_id, template.versionId);
});

test('Vertical Text keeps literal markup and source rotation in captured report and datasheet output after later authoring', async () => {
  const author = await account();
  const flow = await prepareReportFlow(owner, author, { finalSection: true, prepareDatasheet: (client, identity, template) => addVertical(client, identity, template, 'Vertical <b>literal</b>') });
  const configured = await work(author, (client, identity) => addVertical(client, identity, flow.template, 'Report <i>literal</i>'));
  const generated = await work(author, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const reportId = generated.items[0].id;
  const original = await work(author, (client, identity) => loadReport(client, identity, reportId));
  const renderer = await loadReportRenderer();
  const html = renderer.renderReportDocument(original, renderer.stylesheet);
  assert.match(html, /transform:rotate\(180deg\);writing-mode:vertical-rl/);
  assert.match(html, /Vertical &lt;b&gt;literal&lt;\/b&gt;/);
  assert.match(html, /Report &lt;i&gt;literal&lt;\/i&gt;/);
  assert.equal(html.includes('Unused configured default'), false);
  const draft = await work(author, (client, identity) => loadDefinition(client, identity.organization_id, flow.template.versionId));
  assert.equal(draft.model.version.status, 'draft');
  await work(author, (client, identity) => editTemplate(client, identity, flow.template.versionId, draft.model.version.revision,
    { type: 'configureField', columnId: configured.columnId, widget: 'vertical_text_widget', alias: 'vertical_title', label: 'Later title' }));
  const later = await work(author, (client, identity) => loadReport(client, identity, reportId));
  assert.equal(renderer.renderReportDocument(later, renderer.stylesheet), html);
});
