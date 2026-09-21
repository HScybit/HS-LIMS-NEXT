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

// Whole-version copy for duplicating a template. Unlike cloneLayout this remaps
// every record at once, so a formula referencing a field in another container
// still resolves inside the copy.
export function cloneVersionLayout(records, newId) {
  const mapping = new Map();
  const mapped = (oldId) => {
    if (!oldId) return oldId ?? null;
    if (!mapping.has(oldId)) mapping.set(oldId, newId());
    return mapping.get(oldId);
  };
  return {
    sections: records.sections.map((row) => ({ ...row, id: mapped(row.id), parentColumnId: mapped(row.parentColumnId) })),
    rows: records.rows.map((row) => ({ ...row, id: mapped(row.id), sectionId: mapped(row.sectionId) })),
    columns: records.columns.map((row) => ({ ...row, id: mapped(row.id), rowId: mapped(row.rowId) })),
    fields: records.fields.map((row) => ({ ...row, id: mapped(row.id), columnId: mapped(row.columnId), repeatGroupId: mapped(row.repeatGroupId),
      numeric: row.numeric ? { ...row.numeric, fieldId: mapped(row.id) } : null,
      ...(row.image ? { image: { ...row.image, fieldId: mapped(row.id) } } : {}) })),
    groups: records.groups.map((row) => ({ ...row, id: mapped(row.id), rowId: mapped(row.rowId), sectionId: mapped(row.sectionId), parentGroupId: mapped(row.parentGroupId) })),
    options: records.options.map((row) => ({ ...row, id: newId(), fieldId: mapped(row.fieldId) })),
    expressions: records.expressions.map((row) => ({ ...row, id: mapped(row.id), fieldId: mapped(row.fieldId),
      references: row.references.map((reference) => ({ ...reference, fieldId: mapped(reference.fieldId) })) })),
  };
}

// A field's alias is the key a formula names it by, and the editor refuses a
// duplicate ("Key already exist!"), so a copy cannot keep the original's. Each
// copied key gains the lowest numeric suffix free across the whole version, and
// keys already carrying one continue from there rather than stacking a second.
const ALIAS_LIMIT = 200;

function renewedAliases(records, selection) {
  const taken = new Set(records.fields.map((field) => field.alias).filter(Boolean));
  const renamed = new Map();
  for (const field of records.fields) {
    if (!selection.fields.has(field.id) || !field.alias) continue;
    const [, stem, existing] = /^(.*?)(?:_(\d+))?$/.exec(field.alias);
    const base = (stem || field.alias).slice(0, ALIAS_LIMIT - 4);
    let suffix = Number(existing ?? 1);
    let candidate;
    do { suffix += 1; candidate = `${base}_${suffix}`; } while (taken.has(candidate));
    taken.add(candidate);
    renamed.set(field.alias, candidate);
  }
  return renamed;
}

// Rewritten in one pass so a key renamed onto another key's old name cannot be
// renamed a second time, and only whole identifiers are replaced — `assay` must
// not match inside `assay_rate`.
function renameFormulaText(formulaText, renamed) {
  if (!renamed.size) return formulaText;
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${[...renamed.keys()]
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9_])`, 'g');
  return formulaText.replace(pattern, (alias) => renamed.get(alias) ?? alias);
}

export function cloneLayout(records, model, kind, id, newId) {
  const selection = layoutSelection(model, kind, id);
  const renamed = renewedAliases(records, selection);
  const mapping = new Map();
  for (const ids of Object.values(selection)) for (const oldId of ids) mapping.set(oldId, newId());
  const mapped = (oldId) => mapping.get(oldId) ?? oldId;
  const result = {
    sections: records.sections.filter((row) => selection.sections.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), parentColumnId: mapped(row.parentColumnId) })),
    rows: records.rows.filter((row) => selection.rows.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), sectionId: mapped(row.sectionId) })),
    columns: records.columns.filter((row) => selection.columns.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), rowId: mapped(row.rowId) })),
    fields: records.fields.filter((row) => selection.fields.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), columnId: mapped(row.columnId), repeatGroupId: mapped(row.repeatGroupId), alias: renamed.get(row.alias) ?? row.alias, numeric: row.numeric ? { ...row.numeric, fieldId: mapped(row.id) } : null,
      ...(row.image ? { image: { ...row.image, fieldId: mapped(row.id) } } : {}) })),
    groups: records.groups.filter((row) => selection.groups.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), rowId: mapped(row.rowId), sectionId: mapped(row.sectionId), parentGroupId: mapped(row.parentGroupId) })),
    options: records.options.filter((row) => selection.fields.has(row.fieldId)).map((row) => ({ ...row, id: newId(), fieldId: mapped(row.fieldId) })),
    // A copied formula keeps pointing at the copies, so where a copied key was
    // renewed its name changes in the formula text and in the reference beside it.
    expressions: records.expressions.filter((row) => selection.expressions.has(row.id)).map((row) => ({ ...row, id: mapped(row.id), fieldId: mapped(row.fieldId),
      formulaText: renameFormulaText(row.formulaText, renamed),
      references: row.references.map((reference) => ({ ...reference, fieldId: mapped(reference.fieldId),
        alias: selection.fields.has(reference.fieldId) ? renamed.get(reference.alias) ?? reference.alias : reference.alias })) })),
  };
  const table = { section: ['sections', model.sectionsById], row: ['rows', model.rowsById], column: ['columns', model.columnsById] }[kind];
  if (!table) throw new TemplateError('invalid_clone', 'Clone a container, row or column.');
  const original = table[1][id];
  const siblings = kind === 'section' ? (original.parentColumnId ? model.columnsById[original.parentColumnId].childSectionIds : model.rootSectionIds)
    : kind === 'row' ? model.sectionsById[original.sectionId].rowIds : model.rowsById[original.rowId].columnIds;
  result[table[0]].find((row) => row.id === mapped(id)).position = kind === 'row' ? original.position + 1 : Math.max(...siblings.map((siblingId) => table[1][siblingId].position)) + 1;
  return { records: result, mapping };
}
