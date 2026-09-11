// The runtime browser renders stored results; calculation trees and authoring
// defaults stay on the server. All original definition/value history remains in SQL.
const sectionKeys = ['id', 'name', 'parentColumnId', 'repeatGroupId', 'ownRepeatGroupId', 'cssClass', 'visible', 'isHeader', 'isFooter', 'isFinalResult', 'rowIds'];
const rowKeys = ['id', 'sectionId', 'repeatGroupId', 'ownRepeatGroupId', 'cssClass', 'columnIds'];
const columnKeys = ['id', 'rowId', 'span', 'cssClass', 'isFinalResult', 'fieldId', 'childSectionIds'];
const fieldKeys = ['id', 'columnId', 'repeatGroupId', 'widget', 'valueType', 'alias', 'label', 'placeholder', 'required', 'editable'];
const numericKeys = ['displayScale', 'padDecimals', 'minimum', 'maximum'];
const groupKeys = ['id', 'parentGroupId', 'sectionId', 'rowId', 'source', 'minimum', 'maximum'];
const valueKeys = ['fieldId', 'occurrenceId', 'revision', 'valueType', 'state', 'origin', 'numberValue', 'textValue', 'booleanValue', 'dateValue', 'optionId', 'lexical', 'errorCode', 'errorMessage'];

function select(record, keys) {
  const result = {};
  for (const key of keys) if (record[key] !== null && record[key] !== undefined) result[key] = record[key];
  return result;
}

export function datasheetTemplateView(model) {
  const map = (records, keys) => Object.fromEntries(Object.entries(records).map(([id, record]) => [id, select(record, keys)]));
  return {
    version: model.version, rootSectionIds: model.rootSectionIds, calculationOrder: model.calculationOrder,
    sectionsById: map(model.sectionsById, sectionKeys), rowsById: map(model.rowsById, rowKeys),
    columnsById: map(model.columnsById, columnKeys), groupsById: map(model.groupsById, groupKeys),
    fieldsById: Object.fromEntries(Object.entries(model.fieldsById).map(([id, field]) => [id, {
      ...select(field, fieldKeys), numeric: field.numeric ? select(field.numeric, numericKeys) : null,
      options: field.options.map((option) => select(option, ['id', 'label', 'value'])),
    }])),
  };
}

export function datasheetCaptureView(capture) {
  return { ...capture, values: capture.values.map((value) => select(value, valueKeys)) };
}
