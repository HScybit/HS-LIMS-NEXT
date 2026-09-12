import { randomUUID } from 'node:crypto';
import { createTemplate, copyDefinition, editTemplate } from '../../src/templates/authoring.js';
import { database } from '../../src/db/pool.js';
import { uploadTemplateImage } from '../../src/template-assets/service.js';

export async function createImageTemplate(client, identity, { kind = 'datasheet', repeated = false } = {}) {
  const created = await createTemplate(client, identity, { name: 'Synthetic template image', kind });
  const sectionId = randomUUID(); const rowId = randomUUID(); const columnId = randomUUID(); const fieldId = randomUUID();
  const groupId = repeated ? randomUUID() : null;
  const records = { sections: [{ id: sectionId, position: 0, name: 'Synthetic images' }], rows: [{ id: rowId, sectionId, position: 0 }],
    columns: [{ id: columnId, rowId, position: 0, span: 12 }],
    fields: [{ id: fieldId, columnId, repeatGroupId: groupId, widget: 'template_image_widget', valueType: 'image', alias: 'image',
      image: { fieldId, widthPercent: 50, marginTop: 0, marginBottom: 0, marginRight: 0, marginLeft: 0, alignment: 'center' } }],
    options: [], expressions: [], groups: repeated ? [{ id: groupId, parentGroupId: null, rowId, source: 'manual', minimum: 2, maximum: 1000 }] : [] };
  await copyDefinition(database(client), records, identity.organization_id, created.versionId);
  return { ...created, sectionId, rowId, columnId, fieldId, groupId };
}

export async function addImageWidget(client, identity, template, input, { rowId, sectionId } = {}) {
  let loaded = await editTemplate(client, identity, template.versionId, template.revision, rowId ? { type: 'addColumn', rowId } : { type: 'addRow', sectionId });
  if (!rowId) rowId = loaded.model.sectionsById[sectionId].rowIds.at(-1);
  const columnId = loaded.model.rowsById[rowId].columnIds.at(-1);
  loaded = await editTemplate(client, identity, template.versionId, loaded.model.version.revision, { type: 'configureField', columnId,
    widget: 'template_image_widget', alias: `image_${input.requestId.replaceAll('-', '')}`, image: { widthPercent: 50, alignment: 'center' } });
  const fieldId = loaded.model.columnsById[columnId].fieldId;
  loaded = await uploadTemplateImage(client, identity, template.versionId, fieldId, loaded.model.version.revision, input);
  return { ...loaded, fieldId, columnId, rowId };
}
