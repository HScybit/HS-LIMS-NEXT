import { randomUUID } from 'node:crypto';
import { withSession } from '../../src/auth/service.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveProduct } from '../../src/masters/products.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { createLaboratoryFixture } from './laboratory.js';
import { prepareReportFlow } from './report-flow.js';

export const productSelectors = ['name', 'description', 'abbr', 'created_at', 'user_id',
  'project_field__splitter__amount', 'project_field__splitter__flag', 'project_field__splitter__note'];

export async function addProductWidgets(client, identity, template, sectionId, selectors = productSelectors) {
  let revision = template.revision ?? 1; let model; const fieldIds = {};
  for (const alias of selectors) {
    const row = await editTemplate(client, identity, template.versionId, revision, { type: 'addRow', sectionId });
    const rowId = row.model.sectionsById[sectionId].rowIds.at(-1);
    const configured = await editTemplate(client, identity, template.versionId, row.model.version.revision, {
      type: 'configureField', columnId: row.model.rowsById[rowId].columnIds[0], widget: 'product_detail_widget', alias, label: `Title for ${alias}`,
      required: true, defaultValue: 'Configured default is not a captured Product value' });
    model = configured.model; revision = model.version.revision;
    fieldIds[alias] = model.columnsById[model.rowsById[rowId].columnIds[0]].fieldId;
  }
  return { ...template, revision, model, fieldIds };
}

export async function prepareProductContextFlow(owner, account, { complete = true } = {}) {
  const work = (action) => withSession(account.token, action, { csrfToken: account.csrfToken });
  const definitions = [
    { key: 'amount', fieldType: 'number', label: 'Original amount' },
    { key: 'flag', fieldType: 'checkbox', label: 'Original flag' },
    { key: 'note', fieldType: 'text', label: 'Original note', allowsMultiple: true },
  ].map((field, displayOrder) => ({ ...field, displayOrder, id: randomUUID(), revision: 0, requestId: randomUUID(), associatedWith: 'product' }));
  for (const definition of definitions) await work((client, identity) => saveCustomField(client, identity, definition));
  const captures = (values) => values.map((value, index) => ({ fieldId: definitions[index].id, fieldRevision: 1, value }));
  const other = await createLaboratoryFixture(owner, account, { repeated: true });
  const secondCommand = { id: randomUUID(), revision: 0, requestId: randomUUID(), key: `SECOND_${randomUUID().slice(0, 8)}`,
    name: 'Second captured Product', description: 'Second master description', abbreviation: 'P2', customFields: captures([12, true, ['Second', 'Note']]) };
  await work((client, identity) => saveProduct(client, identity, secondCommand));
  // Product-category management is a separate source workflow. This synthetic
  // reference link is set by the fixture owner, never an application bypass.
  await owner.query('INSERT INTO product_sample_categories(organization_id,product_id,sample_category_id) VALUES($1,$2,$3)', [account.organizationId, secondCommand.id, other.category.id]);
  let firstCommand; let datasheetTemplate;
  const flow = await prepareReportFlow(owner, account, { complete, finalSection: true,
    prepareProduct: async (client, identity, fixture) => {
      firstCommand = { id: fixture.product.id, revision: 1, requestId: randomUUID(), key: fixture.product.code,
        name: 'First captured Product', description: 'First master description', abbreviation: 'P1', customFields: captures([0, false, ['First', 'Note']]) };
      await saveProduct(client, identity, firstCommand);
      fixture.registration.products.push({ ...other.registration.products[0], productId: secondCommand.id, sampleCategoryId: other.category.id,
        tests: other.registration.products[0].tests.map((test) => ({ ...test, decisionRuleId: null })) });
    },
    prepareDatasheet: async (client, identity, template) => {
      datasheetTemplate = await addProductWidgets(client, identity, template, template.records.sections[0].id,
        ['description', 'project_field__splitter__amount', 'project_field__splitter__flag']);
    },
  });
  let reportTemplate = await work((client, identity) => addProductWidgets(client, identity, flow.template,
    flow.template.records.sections.find((section) => section.name === 'Certificate Details').id, ['key']));
  reportTemplate = await work((client, identity) => addProductWidgets(client, identity, reportTemplate,
    flow.template.records.sections.find((section) => section.isParameterLoop).id));
  return { ...flow, definitions, firstCommand, secondCommand, datasheetTemplate, reportTemplate, other };
}
