import { randomUUID } from 'node:crypto';
import { createLaboratoryFixture } from './laboratory.js';
import { withSession } from '../../src/auth/service.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveTestParameter } from '../../src/masters/test-parameters.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';

export async function prepareParameterTitleRegistration(owner, account) {
  const fixture = await createLaboratoryFixture(owner, account, { generateTestRequests: true });
  await withSession(account.token, async (client, identity) => {
    const field = await saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'creation',
      label: 'Captured creation', fieldType: 'text', associatedWith: 'parameter' });
    await saveTestParameter(client, identity, { id: fixture.parameter.id, requestId: randomUUID(), revision: 1, name: 'Creation parameter',
      key: randomUUID(), schemeAbbreviation: randomUUID(), customFields: [{ fieldId: field.id, fieldRevision: field.revision, value: 'Captured creation title' }] });
    let model; let revision = fixture.template.revision;
    const edit = async (command) => { ({ model } = await editTemplate(client, identity, fixture.template.versionId, revision, command)); revision = model.version.revision; };
    const sectionId = fixture.template.records.sections[0].id; const rowId = fixture.template.records.rows[0].id;
    await edit({ type: 'configureSection', id: sectionId, isParameterLoop: true });
    await edit({ type: 'addColumn', rowId });
    await edit({ type: 'configureField', columnId: model.rowsById[rowId].columnIds.at(-1), widget: 'text_widget', alias: 'creation_title', label: 'prefix.creation' });
    const { settings } = await loadLaboratorySettings(client, identity);
    await saveLaboratorySettings(client, identity, { revision: settings.revision, autoCreateJobs: true, resultSummaryTemplateId: fixture.template.templateId, jobWorkflowId: null });
  }, { csrfToken: account.csrfToken });
  return fixture;
}
