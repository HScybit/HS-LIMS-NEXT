import { randomUUID } from 'node:crypto';
import { prepareReportFlow } from './report-flow.js';
import { withSession } from '../../src/auth/service.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { saveTestParameter } from '../../src/masters/test-parameters.js';

export const parameterTitleSelectors = [
  ['parameter_name_title', 'name', 'text_widget', true],
  ['parameter_key_title', 'key', 'text_widget', false],
  ['parameter_order_title', 'order', 'text_widget', true],
  ['parameter_description_title', 'description', 'text_widget', false],
  ['parameter_scheme_title', 'scheme_abbr', 'text_widget', false],
  ['parameter_vertical_name', 'name', 'vertical_text_widget', false],
  ['parameter_vertical_order', 'order', 'vertical_text_widget', false],
];

async function addTitles(client, identity, template, sectionId, rowId, { datasheet = false } = {}) {
  let revision = template.revision; let model;
  const edit = async (command) => {
    ({ model } = await editTemplate(client, identity, template.versionId, revision, command));
    revision = model.version.revision;
  };
  if (datasheet) await edit({ type: 'configureSection', id: sectionId, name: 'Final parameter results', isFinalResult: true, isParameterLoop: true });
  const fields = {};
  for (const [alias, label, widget, editable] of parameterTitleSelectors) {
    await edit({ type: 'addColumn', rowId });
    const columnId = model.rowsById[rowId].columnIds.at(-1);
    await edit({ type: 'configureField', columnId, widget, alias, label, editable });
    fields[alias] = model.columnsById[columnId].fieldId;
  }
  await edit({ type: 'addSection' });
  const literalSectionId = model.rootSectionIds.at(-1);
  await edit({ type: 'addRow', sectionId: literalSectionId });
  const literalSection = model.sectionsById[literalSectionId];
  const literalRow = model.rowsById[literalSection.rowIds[0]];
  await edit({ type: 'configureField', columnId: literalRow.columnIds[0], widget: 'text_widget', alias: 'literal_name_title', label: 'name' });
  fields.literal_name_title = model.columnsById[literalRow.columnIds[0]].fieldId;
  return { fields, revision, model };
}

// Synthetic parameter data is saved through the real master command before
// request generation. A legacy fixture deliberately has no recorded revision.
export async function prepareParameterTitleFlow(owner, account, { complete = true, history = true, productLines = 1 } = {}) {
  let parameterCommand; let datasheetTitles;
  const flow = await prepareReportFlow(owner, account, {
    complete, finalSection: true, productLines,
    prepareProduct: history ? async (client, identity, fixture) => {
      parameterCommand = { id: fixture.parameter.id, revision: 1, requestId: randomUUID(),
        name: 'Captured parameter', key: 'CAPTURED-KEY', schemeAbbreviation: 'CP', order: 0,
        description: '<b>Captured H<sub>2</sub>O</b>', laboratoryId: fixture.laboratory.id, measurementUncertainty: null };
      await saveTestParameter(client, identity, parameterCommand);
    } : undefined,
    prepareDatasheet: async (client, identity, template) => {
      datasheetTitles = await addTitles(client, identity, template, template.records.sections[0].id, template.records.rows[0].id, { datasheet: true });
    },
  });
  const section = flow.template.records.sections.find((item) => item.isParameterLoop);
  const row = flow.template.records.rows.find((item) => item.sectionId === section.id);
  const reportTitles = await withSession(account.token, (client, identity) => addTitles(client, identity, flow.template, section.id, row.id), { csrfToken: account.csrfToken });
  return { ...flow, datasheetTitles, reportTitles, parameterCommand };
}
