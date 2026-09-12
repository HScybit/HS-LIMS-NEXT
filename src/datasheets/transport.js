// The runtime browser renders stored results without calculation trees. Result
// defaults are needed for the source blur fallback and hint; history stays in SQL.
const sectionKeys = ['id', 'name', 'parentColumnId', 'repeatGroupId', 'ownRepeatGroupId', 'cssClass', 'visible', 'isHeader', 'isFooter', 'isFinalResult', 'isParameterLoop', 'isParameterLoopHeader', 'rowIds'];
const rowKeys = ['id', 'sectionId', 'repeatGroupId', 'ownRepeatGroupId', 'cssClass', 'columnIds', 'serialNumber'];
const columnKeys = ['id', 'rowId', 'span', 'cssClass', 'isFinalResult', 'fieldId', 'childSectionIds'];
const fieldKeys = ['id', 'columnId', 'repeatGroupId', 'widget', 'valueType', 'alias', 'label', 'placeholder', 'required', 'editable', 'sourceField', 'serialPadding'];
const resultDefaultKeys = ['defaultState', 'defaultNumber', 'defaultText', 'defaultLexical'];
const numericKeys = ['displayScale', 'padDecimals', 'minimum', 'maximum'];
const groupKeys = ['id', 'parentGroupId', 'sectionId', 'rowId', 'source', 'minimum', 'maximum'];
const valueKeys = ['fieldId', 'occurrenceId', 'revision', 'valueType', 'state', 'origin', 'numberValue', 'textValue', 'booleanValue', 'dateValue', 'optionId', 'imageId', 'lexical', 'errorCode', 'errorMessage'];

function select(record, keys) {
  const result = {};
  for (const key of keys) if (record[key] !== null && record[key] !== undefined) result[key] = record[key];
  return result;
}

export function datasheetTemplateView(model) {
  const map = (records, keys) => Object.fromEntries(Object.entries(records).map(([id, record]) => [id, select(record, keys)]));
  return {
    version: model.version, rootSectionIds: model.rootSectionIds, calculationOrder: model.calculationOrder,
    ...(model.imageSources ? { imageSources: model.imageSources } : {}),
    sectionsById: map(model.sectionsById, sectionKeys), rowsById: map(model.rowsById, rowKeys),
    columnsById: map(model.columnsById, columnKeys), groupsById: map(model.groupsById, groupKeys),
    fieldsById: Object.fromEntries(Object.entries(model.fieldsById).map(([id, field]) => [id, {
      ...select(field, fieldKeys), numeric: field.numeric ? select(field.numeric, numericKeys) : null,
      ...(field.widget === 'result_widget' ? select(field, resultDefaultKeys) : {}),
      ...(field.widget === 'template_image_widget' ? { ...select(field, ['defaultState', 'defaultImageId']), image: select(field.image ?? {}, ['widthPercent', 'marginTop', 'marginBottom', 'marginRight', 'marginLeft', 'alignment']) } : {}),
      options: field.options.map((option) => select(option, ['id', 'label', 'value'])),
    }])),
  };
}

export function datasheetCaptureView(capture) {
  const { pinnedValues: _pinnedValues, ...runtime } = capture;
  return { ...runtime, values: capture.values.map((value) => select(value, valueKeys)) };
}
