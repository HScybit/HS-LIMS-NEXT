import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createLaboratoryFixture } from './laboratory.js';
import { prepareSubjectJob } from './job-subjects.js';
import { createReportTemplate } from './reports.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { saveCapture } from '../../src/templates/capture.js';
import { loadWorkflowRun } from '../../src/workflows/load.js';
import { submitDatasheetTransition } from '../../src/workflows/requests.js';
import { generateReports } from '../../src/reports/service.js';
import { withSession } from '../../src/auth/service.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { saveTestParameter } from '../../src/masters/test-parameters.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';

export async function prepareParameterDetailJob(owner, user, { parameters = 1 } = {}) {
  const work = (action) => withSession(user.token, action, { csrfToken: user.csrfToken });
  const source = await createLaboratoryFixture(owner, user, { repeated: false });
  if (parameters === 2) {
    const key = randomUUID();
    const parameter = (await owner.query(`INSERT INTO test_parameters(organization_id,code,name,master_key,scheme_abbreviation,measurement_unit_id)
      VALUES($1,$2,'Another sample parameter',$2,$2,$3) RETURNING id`, [user.organizationId, key, source.unit.id])).rows[0];
    await owner.query('INSERT INTO parameter_methods(organization_id,test_parameter_id,method_id,is_default) VALUES($1,$2,$3,true)',
      [user.organizationId, parameter.id, source.method.id]);
    source.registration.products[0].tests.push({ ...source.registration.products[0].tests[0], testParameterId: parameter.id, decisionRuleId: null });
  }
  const fields = await work(async (client, identity) => {
    await saveTestParameter(client, identity, { id: source.parameter.id, revision: 1, requestId: randomUUID(), name: 'Job parameter',
      key: randomUUID(), schemeAbbreviation: randomUUID(), order: 0, laboratoryId: null, measurementUncertainty: null });
    let revision = 1; let model;
    const edit = async (command) => { ({ model } = await editTemplate(client, identity, source.template.versionId, revision, command)); revision = model.version.revision; };
    await edit({ type: 'configureSection', id: source.template.records.sections[0].id, isParameterLoop: true });
    await edit({ type: 'addColumn', rowId: source.template.records.rows[0].id });
    const columnId = model.rowsById[source.template.records.rows[0].id].columnIds.at(-1);
    await edit({ type: 'configureField', columnId, widget: 'parameter_detail_widget', alias: 'loop_detail', label: 'name' });
    const loop = model.columnsById[columnId].fieldId;
    await edit({ type: 'addSection' });
    const sectionId = model.rootSectionIds.at(-1);
    await edit({ type: 'addRow', sectionId });
    const rowId = model.sectionsById[sectionId].rowIds[0];
    const outsideColumn = model.rowsById[rowId].columnIds[0];
    await edit({ type: 'configureField', columnId: outsideColumn, widget: 'parameter_detail_widget', alias: 'outside_detail', label: 'name' });
    return { loop, outside: model.columnsById[outsideColumn].fieldId };
  });
  const current = await work(loadLaboratorySettings);
  await work((client, identity) => saveLaboratorySettings(client, identity, { revision: current.settings.revision,
    autoCreateJobs: false, resultSummaryTemplateId: source.template.templateId, jobWorkflowId: null }));
  const sample = await work((client, identity) => registerSample(client, identity, source.registration));
  const requests = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  return { source, fields, sample, requests: requests.items };
}

export async function prepareScalarParameterDetailReport(owner, user) {
  const work = (action) => withSession(user.token, action, { csrfToken: user.csrfToken });
  let detailFieldId;
  const flow = await prepareSubjectJob(owner, user, user, { resultWidget: true, prepareTemplate: async (client, identity, template, source) => {
    const parameters = (await client.query('SELECT * FROM test_parameters WHERE organization_id=$1 AND id=ANY($2::uuid[])',
      [identity.organization_id, source.registration.products[0].tests.map((test) => test.testParameterId)])).rows;
    for (const parameter of parameters) await saveTestParameter(client, identity, { id: parameter.id, revision: parameter.revision, requestId: randomUUID(),
      name: parameter.name, key: parameter.master_key, schemeAbbreviation: parameter.scheme_abbreviation, order: 0, laboratoryId: null, measurementUncertainty: null });
    const rowId = template.records.rows[0].id;
    const added = await editTemplate(client, identity, template.versionId, template.revision, { type: 'addColumn', rowId });
    const columnId = added.model.rowsById[rowId].columnIds.at(-1);
    const configured = await editTemplate(client, identity, template.versionId, added.model.version.revision,
      { type: 'configureField', columnId, widget: 'parameter_detail_widget', alias: 'cached_name', label: 'name' });
    detailFieldId = configured.model.columnsById[columnId].fieldId;
    const methods = await editTemplate(client, identity, template.versionId, configured.model.version.revision, { type: 'addColumn', rowId });
    await editTemplate(client, identity, template.versionId, methods.model.version.revision,
      { type: 'configureField', columnId: methods.model.rowsById[rowId].columnIds.at(-1), widget: 'parameter_detail_widget', alias: 'cached_methods', label: 'moa_applicable' });
  } });
  let sheet = await work((client, identity) => loadDatasheet(client, identity, flow.job.datasheetId));
  assert.equal(sheet.capture.values.filter((value) => value.fieldId === detailFieldId).length, 2);
  const raw = Object.values(sheet.model.fieldsById).find((field) => field.widget === 'number_widget');
  const result = Object.values(sheet.model.fieldsById).find((field) => field.widget === 'result_widget');
  await work((client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision,
    sheet.capture.occurrences.filter((row) => row.subject).flatMap((row) => [raw, result].map((field) => ({ fieldId: field.id, occurrenceId: row.id, state: 'present', value: '0' })))));
  sheet = await work((client, identity) => loadDatasheet(client, identity, flow.job.datasheetId));
  const run = await work((client, identity) => loadWorkflowRun(client, identity, flow.job.workflowRunId));
  await work((client, identity) => submitDatasheetTransition(client, identity, run.id, { datasheetId: sheet.datasheet.id,
    datasheet: { revision: sheet.datasheet.revision, captureRevision: sheet.capture.revision },
    transition: { revision: run.revision, transitionId: run.transitions[0].id, comment: '', checklistItemIds: [] } }));
  const template = await work(createReportTemplate);
  const selected = (await owner.query('SELECT sample_test_id FROM test_requests WHERE organization_id=$1 AND id=$2', [user.organizationId, flow.requests[0].id])).rows[0];
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, { revision: flow.sample.revision, requestId: randomUUID(),
    reportType: 'consolidated', templateSelections: [{ key: 'consolidated', templateId: template.templateId }], selectedSampleTestIds: [selected.sample_test_id] }));
  return { sheet, reportId: generated.items[0].id };
}
