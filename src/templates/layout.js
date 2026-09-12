import { TemplateError } from './model.js';

export function layoutSelection(model, kind, id) {
  const selected = { sections: new Set(), rows: new Set(), columns: new Set(), fields: new Set(), groups: new Set(), expressions: new Set() };
  function column(columnId) {
    const value = model.columnsById[columnId];
    if (!value) throw new TemplateError('missing_column', 'Column was not found.');
    selected.columns.add(columnId);
    if (value.fieldId) selected.fields.add(value.fieldId);
    for (const child of value.childSectionIds) section(child);
  }
  function row(rowId) {
    const value = model.rowsById[rowId];
    if (!value) throw new TemplateError('missing_row', 'Row was not found.');
    selected.rows.add(rowId);
    for (const child of value.columnIds) column(child);
  }
  function section(sectionId) {
    const value = model.sectionsById[sectionId];
    if (!value || selected.sections.has(sectionId)) throw new TemplateError('invalid_section', 'Container was not found or contains a cycle.');
    selected.sections.add(sectionId);
    for (const child of value.rowIds) row(child);
  }
  if (kind === 'section') section(id);
  else if (kind === 'row') row(id);
  else if (kind === 'column') column(id);
  else if (kind === 'field' && model.fieldsById[id]) selected.fields.add(id);
  else throw new TemplateError('invalid_selection', 'Select a valid layout item.');
  for (const group of Object.values(model.groupsById)) {
    if (selected.sections.has(group.sectionId) || selected.rows.has(group.rowId)) selected.groups.add(group.id);
  }
  for (const expression of Object.values(model.expressions)) if (selected.fields.has(expression.fieldId)) selected.expressions.add(expression.id);
  return selected;
}

export function cloneLayout(records, model, kind, id, newId) {
  const selection = layoutSelection(model, kind, id);
  const mapping = new Map();
  for (const ids of Object.values(selection)) for (const oldId of ids) mapping.set(oldId, newId());
  const mapped = (oldId) => mapping.get(oldId) ?? oldId;
  const result = {
    sections: records.sections.filter((row) => selection.sections.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), parentColumnId: mapped(row.parentColumnId) })),
    rows: records.rows.filter((row) => selection.rows.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), sectionId: mapped(row.sectionId) })),
    columns: records.columns.filter((row) => selection.columns.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), rowId: mapped(row.rowId) })),
    fields: records.fields.filter((row) => selection.fields.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), columnId: mapped(row.columnId), repeatGroupId: mapped(row.repeatGroupId), numeric: row.numeric ? { ...row.numeric, fieldId: mapped(row.id) } : null,
      ...(row.image ? { image: { ...row.image, fieldId: mapped(row.id) } } : {}) })),
    groups: records.groups.filter((row) => selection.groups.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), rowId: mapped(row.rowId), sectionId: mapped(row.sectionId), parentGroupId: mapped(row.parentGroupId) })),
    options: records.options.filter((row) => selection.fields.has(row.fieldId)).map((row) => ({ ...row, id: newId(), fieldId: mapped(row.fieldId) })),
    expressions: records.expressions.filter((row) => selection.expressions.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), fieldId: mapped(row.fieldId), nodes: row.nodes.map((node) => ({ ...node, fieldId: node.kind === 'field' ? mapped(node.fieldId) : node.fieldId })) })),
  };
  const table = { section: ['sections', model.sectionsById], row: ['rows', model.rowsById], column: ['columns', model.columnsById] }[kind];
  if (!table) throw new TemplateError('invalid_clone', 'Clone a container, row or column.');
  const original = table[1][id];
  const siblings = kind === 'section' ? (original.parentColumnId ? model.columnsById[original.parentColumnId].childSectionIds : model.rootSectionIds)
    : kind === 'row' ? model.sectionsById[original.sectionId].rowIds : model.rowsById[original.rowId].columnIds;
  result[table[0]].find((row) => row.id === mapped(id)).position = kind === 'row' ? original.position + 1 : Math.max(...siblings.map((siblingId) => table[1][siblingId].position)) + 1;
  return { records: result, mapping };
}
