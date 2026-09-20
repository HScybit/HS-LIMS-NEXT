import { randomUUID } from 'node:crypto';
import { createLaboratoryFixture } from './laboratory.js';
import { createReportTemplate } from './reports.js';
import { withSession } from '../../src/auth/service.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';
import { loadCapture, loadDefinition } from '../../src/templates/loader.js';
import { saveCapture } from '../../src/templates/capture.js';
import { loadWorkflowRun } from '../../src/workflows/load.js';
import { submitDatasheetTransition } from '../../src/workflows/requests.js';

export async function prepareReportFlow(owner, account, { complete = true, printRoleId, finalSection = false, finalContext = false, productLines = null, sampleCanWork = true, cancelTestRequest = false, prepareDatasheet, prepareProduct, enableReissue = false, showSampleReissue = false } = {}) {
  const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: finalSection, printRoleId, sampleCanWork, cancelTestRequest, enableReissue, showSampleReissue });
  if (prepareProduct) await work((client, identity) => prepareProduct(client, identity, fixture));
  let draft = await work((client, identity) => editTemplate(client, identity, fixture.template.versionId, 1,
    { type: 'configureColumn', id: fixture.template.records.columns.at(-1).id, span: 6, isFinalResult: true }));
  if (finalSection) draft = await work((client, identity) => editTemplate(client, identity, fixture.template.versionId, 2,
    { type: 'configureSection', id: fixture.template.records.sections[0].id, name: 'Final results', isFinalResult: true }));
  if (finalContext) {
    const edit = async (command) => { draft = await work((client, identity) => editTemplate(client, identity, fixture.template.versionId, draft.model.version.revision, command)); };
    const sectionId = fixture.template.records.sections[0].id;
    await edit({ type: 'addRow', sectionId });
    const rowId = draft.model.sectionsById[sectionId].rowIds.at(-1);
    await edit({ type: 'configureField', columnId: draft.model.rowsById[rowId].columnIds[0], widget: 'tr_data_widget', alias: 'frozen_parameter', sourceField: 'parameterName' });
    await edit({ type: 'addColumn', rowId });
    await edit({ type: 'configureField', columnId: draft.model.rowsById[rowId].columnIds.at(-1), widget: 'tr_result_widget', alias: 'frozen_result' });
  }
  if (prepareDatasheet) await work((client, identity) => prepareDatasheet(client, identity, { ...fixture.template, revision: draft.model.version.revision }));
  const template = await work(createReportTemplate);
  const sample = await work((client, identity) => registerSample(client, identity, { ...fixture.registration,
    products: productLines === null ? fixture.registration.products : Array.from({ length: productLines }, () => structuredClone(fixture.registration.products[0])) }));
  const requests = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  const completed = [];
  for (const request of requests.items) {
    const requestId = request.id;
    const allocation = await work((client, identity) => allocateTestRequest(client, identity, requestId, { revision: 1, assignedUserId: account.userId, assignmentType: 'analyst' }));
    const sheet = (await owner.query('SELECT * FROM datasheets WHERE organization_id=$1 AND id=$2', [account.organizationId, allocation.datasheetId])).rows[0];
    let submission;
    if (complete) {
      const capture = await work((client, identity) => loadCapture(client, identity.organization_id, sheet.template_instance_id), { readOnly: true });
      const definition = await work((client, identity) => loadDefinition(client, identity.organization_id, capture.instance.version_id), { readOnly: true });
      const inputs = Object.values(definition.model.fieldsById).filter((field) => field.widget === 'number_widget')
        .flatMap((field) => capture.occurrences.filter((row) => row.groupId === field.repeatGroupId).map((row) => ({ fieldId: field.id, occurrenceId: row.id, state: 'present', value: '0' })));
      const saved = await work((client, identity) => saveCapture(client, identity, sheet.template_instance_id, capture.revision, inputs));
      const run = await work((client, identity) => loadWorkflowRun(client, identity, allocation.workflowRunId), { readOnly: true });
      submission = await work((client, identity) => submitDatasheetTransition(client, identity, run.id, { datasheetId: sheet.id,
        datasheet: { revision: 1, captureRevision: saved.revision }, transition: { revision: run.revision, transitionId: run.transitions[0].id, comment: 'Synthetic report result completed', checklistItemIds: [] } }));
    }
    const selected = (await owner.query('SELECT sample_test_id FROM test_requests WHERE organization_id=$1 AND id=$2', [account.organizationId, requestId])).rows[0];
    completed.push({ requestId, sheet, submission, sampleTestId: selected.sample_test_id });
  }
  const input = { requestId: randomUUID(), revision: 1, reportType: 'consolidated', templateSelections: [{ key: 'consolidated', templateId: template.templateId }], selectedSampleTestIds: completed.map((item) => item.sampleTestId) };
  return { fixture, template, sample, ...completed[0], completed, input };
}
