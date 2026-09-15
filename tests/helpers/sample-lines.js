import { editTemplate } from '../../src/templates/authoring.js';
import { sampleLineAttributes } from '../../src/templates/sample-line.js';
import { withSession } from '../../src/auth/service.js';
import { prepareReportFlow } from './report-flow.js';

export async function addSampleLineWidgets(client, identity, template, sectionId, attributes = sampleLineAttributes.map((attribute) => attribute.value), { repeat = false, prefix = 'line' } = {}) {
  let revision = template.revision ?? 1; let model; const fieldIds = {};
  for (const attribute of attributes) {
    let changed = await editTemplate(client, identity, template.versionId, revision, { type: 'addRow', sectionId });
    const rowId = changed.model.sectionsById[sectionId].rowIds.at(-1);
    if (repeat) changed = await editTemplate(client, identity, template.versionId, changed.model.version.revision, { type: 'repeatRow', id: rowId, enabled: true });
    changed = await editTemplate(client, identity, template.versionId, changed.model.version.revision, {
      type: 'configureField', columnId: changed.model.rowsById[rowId].columnIds[0], widget: 'sample_line_item_data_widget',
      alias: `${prefix}_${attribute ?? 'empty'}`, sourceField: attribute, attributeKey: 'Unused source config attr', defaultValue: 'Unused source default' });
    model = changed.model; revision = model.version.revision;
    fieldIds[attribute ?? 'empty'] = model.columnsById[model.rowsById[rowId].columnIds[0]].fieldId;
  }
  return { ...template, revision, model, fieldIds };
}

export async function prepareSampleLineFlow(owner, account, { complete = true, secondLine = true, printRoleId } = {}) {
  const work = (action) => withSession(account.token, action, { csrfToken: account.csrfToken });
  let datasheetTemplate;
  const flow = await prepareReportFlow(owner, account, { complete, finalSection: true, printRoleId,
    prepareProduct: async (_client, _identity, fixture) => {
      Object.assign(fixture.registration.products[0], { description: 'First captured line', quantity: '1.00000000000000001',
        sampleSize: '2 L', quality: 'Clear', identificationMark: 'LINE-A', condition: 'Sealed' });
      if (secondLine) fixture.registration.products.push({ ...structuredClone(fixture.registration.products[0]), description: 'Second captured line', identificationMark: 'LINE-B', quantity: '2' });
    },
    prepareDatasheet: async (client, identity, template) => { datasheetTemplate = await addSampleLineWidgets(client, identity, template, template.records.sections[0].id, undefined, { repeat: true }); },
  });
  let reportTemplate = await work((client, identity) => addSampleLineWidgets(client, identity, flow.template,
    flow.template.records.sections.find((section) => section.name === 'Certificate Details').id, ['custom_description', 'custom_product', 'custom_category'], { prefix: 'outside' }));
  reportTemplate = await work((client, identity) => addSampleLineWidgets(client, identity, reportTemplate,
    flow.template.records.sections.find((section) => section.isParameterLoop).id, ['custom_description'], { prefix: 'loop' }));
  return { ...flow, datasheetTemplate, reportTemplate };
}
