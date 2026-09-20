import { editTemplate } from '../../src/templates/authoring.js';

export async function addSerialColumns(client, identity, template) {
  let revision = template.revision ?? 1; const fieldIds = [];
  for (const [index, row] of template.records.rows.entries()) {
    const added = await editTemplate(client, identity, template.versionId, revision, { type: 'addColumn', rowId: row.id });
    const columnId = added.model.rowsById[row.id].columnIds.at(-1);
    const configured = await editTemplate(client, identity, template.versionId, added.model.version.revision,
      { type: 'configureField', columnId, widget: 'sno_widget', alias: `datasheet_serial_${index}`, serialPadding: 2 });
    revision = configured.model.version.revision;
    fieldIds.push(configured.model.columnsById[columnId].fieldId);
  }
  return { ...template, revision, fieldIds };
}
