import { randomUUID } from 'node:crypto';
import { createLaboratoryFixture } from './laboratory.js';
import { analyticalRecords } from './templates.js';
import { createTemplate, copyDefinition, editTemplate } from '../../src/templates/authoring.js';
import { database } from '../../src/db/pool.js';
import { withSession } from '../../src/auth/service.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { createTestRequestJobs } from '../../src/test-requests/jobs.js';

export async function prepareSubjectJob(owner, creator, analyst, { manualParent = false, resultWidget = false, resultValueType = 'numeric', resultDefaultValue, finalSection = false, jobWorkflowId = null } = {}) {
  const source = await createLaboratoryFixture(owner, creator, { repeated: false });
  const client = await owner.connect();
  let template;
  try {
    await client.query('BEGIN');
    template = await createTemplate(client, { organization_id: creator.organizationId, user_id: creator.userId, permission_codes: ['templates.manage'] },
      { name: 'Synthetic job parameter summary', kind: 'datasheet' });
    const records = analyticalRecords({ rowCount: 1, repeated: false });
    const parameterSectionId = records.sections[0].id;
    const contextColumnId = randomUUID();
    for (const column of records.columns) column.span = 4;
    records.columns.at(-1).isFinalResult = true;
    records.columns.push({ id: contextColumnId, rowId: records.rows[0].id, position: 2, span: 4 });
    records.fields.push({ id: randomUUID(), columnId: contextColumnId, repeatGroupId: null, widget: 'tr_data_widget', valueType: 'text',
      alias: 'parameter_context', label: 'Parameter', sourceField: 'parameterName', editable: false });
    if (resultWidget) {
      const columnId = randomUUID(); const fieldId = randomUUID();
      for (const column of records.columns) { column.span = 3; column.isFinalResult = false; }
      records.columns.push({ id: columnId, rowId: records.rows[0].id, position: 3, span: 3, isFinalResult: true });
      records.fields.push({ id: fieldId, columnId, repeatGroupId: null, widget: 'result_widget', valueType: resultValueType, alias: 'entered_result', label: 'Result',
        numeric: { fieldId, displayScale: 2, padDecimals: false } });
    }
    let manualGroupId = null;
    if (manualParent) {
      const sectionId = randomUUID(); const rowId = randomUUID(); const columnId = randomUUID(); manualGroupId = randomUUID();
      records.sections[0].parentColumnId = columnId;
      records.sections.push({ id: sectionId, parentColumnId: null, position: 0, name: 'Synthetic measurement runs' });
      records.rows.push({ id: rowId, sectionId, position: 0 });
      records.columns.push({ id: columnId, rowId, position: 0, span: 12 });
      records.groups.push({ id: manualGroupId, parentGroupId: null, rowId, source: 'manual', minimum: 2, maximum: 1000 });
      for (const field of records.fields) field.repeatGroupId = manualGroupId;
    }
    await copyDefinition(database(client), records, creator.organizationId, template.versionId);
    await client.query('UPDATE decision_rules SET template_id=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [creator.organizationId, source.rule.id, template.templateId]);
    template = { ...template, records, parameterSectionId, manualGroupId };
    const code = randomUUID();
    const parameter = (await client.query(`INSERT INTO test_parameters(organization_id,code,name,master_key,scheme_abbreviation,measurement_unit_id)
      VALUES($1,$2,'Second synthetic concentration',$2,$2,$3) RETURNING id`, [creator.organizationId, code, source.unit.id])).rows[0];
    await client.query('INSERT INTO parameter_methods(organization_id,test_parameter_id,method_id,is_default) VALUES($1,$2,$3,true)', [creator.organizationId, parameter.id, source.method.id]);
    source.registration.products[0].tests.push({ ...source.registration.products[0].tests[0], testParameterId: parameter.id, decisionRuleId: null });
    await client.query('UPDATE sample_category_templates SET template_id=$3 WHERE organization_id=$1 AND sample_category_id=$2 AND purpose=\'datasheet\'', [creator.organizationId, source.category.id, template.templateId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const work = (callback) => withSession(creator.token, callback, { csrfToken: creator.csrfToken });
  const edited = await work((client, identity) => editTemplate(client, identity, template.versionId, 1,
    { type: 'configureSection', id: template.parameterSectionId, name: 'Analytical results', cssClass: '', visible: true, isHeader: false, isFooter: false, isFinalResult: finalSection, isParameterLoop: true }));
  template.revision = edited.model.version.revision;
  if (resultDefaultValue !== undefined) {
    const field = Object.values(edited.model.fieldsById).find((item) => item.widget === 'result_widget');
    const configured = await work((client, identity) => editTemplate(client, identity, template.versionId, template.revision,
      { type: 'configureField', columnId: field.columnId, widget: field.widget, alias: field.alias, defaultValue: resultDefaultValue, displayScale: 2 }));
    template.revision = configured.model.version.revision;
  }
  const settings = await work(loadLaboratorySettings);
  await work((client, identity) => saveLaboratorySettings(client, identity, { revision: settings.settings.revision,
    autoCreateJobs: false, resultSummaryTemplateId: template.templateId, jobWorkflowId }));
  const sample = await work((client, identity) => registerSample(client, identity, source.registration));
  const generated = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  const result = await work((client, identity) => createTestRequestJobs(client, identity, { requestIds: generated.items.map((item) => item.id), analystUserId: analyst.userId }));
  return { source, template, sample, requests: generated.items, job: result.items[0] };
}
