import { compileExpression, expressionText, formulaOrder } from './expressions.js';
import { HttpError } from '../auth/errors.js';
import { contextWidgetFields, isContextWidget } from './context-widgets.js';

export class TemplateError extends HttpError {
  constructor(code, message) { super(400, code, message); this.name = 'TemplateError'; }
}
const invalid = (message) => { throw new TemplateError('invalid_template', message); };
const byPosition = (a, b) => a.position - b.position || a.id.localeCompare(b.id);

function indexRows(rows, label) {
  const result = {};
  for (const row of rows) {
    if (!row.id || Object.hasOwn(result, row.id)) invalid(`Duplicate ${label} identity.`);
    result[row.id] = { ...row };
  }
  return result;
}

// One linear assembly pass builds adjacency lists. Runtime rendering never rescans all fields per row.
export function assembleDefinition(records, { forFreeze = false } = {}) {
  const { version, sections, rows, columns, fields, options, expressions, groups } = records;
  if (sections.length + rows.length + columns.length + fields.length > 80_000 || fields.length > 20_000) invalid('Template exceeds the supported definition size.');
  const model = {
    version, sectionsById: indexRows(sections, 'section'), rowsById: indexRows(rows, 'row'),
    columnsById: indexRows(columns, 'column'), fieldsById: indexRows(fields, 'field'),
    groupsById: indexRows(groups, 'repeat group'), rootSectionIds: [], expressions: {}, calculationOrder: [],
  };
  for (const section of Object.values(model.sectionsById)) section.rowIds = [];
  for (const row of Object.values(model.rowsById)) {
    row.columnIds = [];
    const parent = model.sectionsById[row.sectionId];
    if (!parent) invalid('Row has a missing section.');
    parent.rowIds.push(row.id);
  }
  for (const column of Object.values(model.columnsById)) {
    column.childSectionIds = [];
    const parent = model.rowsById[column.rowId];
    if (!parent) invalid('Column has a missing row.');
    parent.columnIds.push(column.id);
  }
  for (const section of Object.values(model.sectionsById)) {
    if (section.parentColumnId) {
      const parent = model.columnsById[section.parentColumnId];
      if (!parent) invalid('Section has a missing parent column.');
      parent.childSectionIds.push(section.id);
    } else model.rootSectionIds.push(section.id);
  }
  for (const field of Object.values(model.fieldsById)) {
    const column = model.columnsById[field.columnId];
    if (!column || column.fieldId) invalid('Field placement is missing or duplicated.');
    if (column.childSectionIds.length) invalid('A column cannot contain both a widget and a nested container.');
    column.fieldId = field.id;
    field.options = [];
  }
  for (const option of options) {
    const field = model.fieldsById[option.fieldId];
    if (!field || field.valueType !== 'option') invalid('Option belongs to an incompatible field.');
    field.options.push(option);
  }
  const sectionGroups = new Map();
  const rowGroups = new Map();
  for (const group of groups) {
    const target = group.rowId ? rowGroups : sectionGroups;
    const key = group.rowId ?? group.sectionId;
    if (target.has(key) || !(group.rowId ? model.rowsById[key] : model.sectionsById[key])) invalid('Repeat placement is missing or duplicated.');
    target.set(key, group);
  }
  const visited = new Set();
  const visitedGroups = new Set();
  function enterGroup(group, inherited) {
    if (!group) return inherited;
    if ((group.parentGroupId ?? null) !== inherited) invalid('Repeat ancestry does not match the layout.');
    visitedGroups.add(group.id);
    return group.id;
  }
  function visitSection(id, inheritedGroup, depth) {
    if (visited.has(id) || depth > 64) invalid('Container layout contains a cycle or excessive nesting.');
    visited.add(id);
    const section = model.sectionsById[id];
    if (forFreeze && (section.isParameterLoop || section.isParameterLoopHeader) && version.kind !== 'report') invalid('Parameter loops currently require a report template.');
    section.ownRepeatGroupId = sectionGroups.get(id)?.id ?? null;
    section.repeatGroupId = enterGroup(sectionGroups.get(id), inheritedGroup);
    section.rowIds.sort((a, b) => byPosition(model.rowsById[a], model.rowsById[b]));
    let serialNumber = 0;
    for (const rowId of section.rowIds) {
      const row = model.rowsById[rowId];
      if (row.columnIds.some((columnId) => model.fieldsById[model.columnsById[columnId].fieldId]?.widget === 'sno_widget')) row.serialNumber = ++serialNumber;
      row.ownRepeatGroupId = rowGroups.get(rowId)?.id ?? null;
      row.repeatGroupId = enterGroup(rowGroups.get(rowId), section.repeatGroupId);
      row.columnIds.sort((a, b) => byPosition(model.columnsById[a], model.columnsById[b]));
      for (const columnId of row.columnIds) {
        const column = model.columnsById[columnId];
        const field = model.fieldsById[column.fieldId];
        if (field && (field.repeatGroupId ?? null) !== row.repeatGroupId) invalid('Field belongs to the wrong repeat group.');
        column.childSectionIds.sort((a, b) => byPosition(model.sectionsById[a], model.sectionsById[b]));
        for (const child of column.childSectionIds) visitSection(child, row.repeatGroupId, depth + 1);
      }
    }
  }
  model.rootSectionIds.sort((a, b) => byPosition(model.sectionsById[a], model.sectionsById[b]));
  for (const id of model.rootSectionIds) visitSection(id, null, 0);
  if (visited.size !== sections.length || visitedGroups.size !== groups.length) invalid('Layout contains disconnected containers or repeats.');
  const calculations = new Map();
  for (const expression of expressions) {
    const field = model.fieldsById[expression.fieldId];
    if (!field || !['calculate', 'visible', 'required'].includes(expression.purpose)) invalid('Expression target is invalid.');
    if (expression.purpose === 'calculate' && field.widget !== 'formula_widget') invalid('Only formula widgets may own calculations.');
    const key = `${expression.fieldId}:${expression.purpose}`;
    if (model.expressions[key]) invalid('Expression purpose is duplicated.');
    for (const node of expression.nodes) {
      if (node.kind !== 'field') continue;
      const reference = model.fieldsById[node.fieldId];
      if (!reference || referenceScope(model, field, reference) !== node.scope) invalid('Expression reference has an incompatible repeat scope.');
    }
    const compiled = compileExpression(expression.nodes);
    model.expressions[key] = { ...expression, compiled };
    if (expression.purpose === 'calculate') {
      calculations.set(field.id, expression.nodes);
      field.formula = expressionText(compiled, (id) => model.fieldsById[id].alias || `[${id}]`);
    }
  }
  model.calculationOrder = formulaOrder(calculations);
  const aliases = new Set();
  for (const field of Object.values(model.fieldsById)) {
    field.options.sort(byPosition);
    if (forFreeze && isContextWidget(field.widget)) {
      if (version.kind !== 'report') invalid('Report data widgets currently require a report template.');
      if (contextWidgetFields[field.widget].length && !contextWidgetFields[field.widget].includes(field.sourceField)) invalid('Select a data field for every report data widget.');
    }
    if (forFreeze && field.alias && aliases.has(field.alias)) invalid('Identifiers must be unique across the template. Rename duplicate keys before using this version.');
    if (field.alias) aliases.add(field.alias);
    if (forFreeze && field.widget === 'formula_widget' && !calculations.has(field.id)) invalid('Configure every formula before using the template.');
    if (forFreeze && field.valueType === 'option' && !field.options.length) invalid('Configure dropdown options before using the template.');
  }
  if (forFreeze && (!sections.length || !fields.length)) invalid('A usable template needs a container and at least one widget.');
  return model;
}

function isAncestor(model, possibleAncestor, groupId) {
  const visited = new Set();
  while (groupId) {
    if (visited.has(groupId)) invalid('Repeat ancestry contains a cycle.');
    visited.add(groupId);
    const group = model.groupsById[groupId];
    if (!group) invalid('Repeat ancestor is missing.');
    groupId = group.parentGroupId;
    if ((groupId ?? null) === possibleAncestor) return true;
  }
  return false;
}

export function referenceScope(model, target, reference) {
  const current = target.repeatGroupId ?? null;
  const other = reference.repeatGroupId ?? null;
  if (current === other) return 'current';
  if (isAncestor(model, other, current)) return 'ancestor';
  if (isAncestor(model, current, other)) return 'descendants';
  return null;
}

export function resolveAlias(model, target, alias) {
  const matches = Object.values(model.fieldsById).filter((field) => field.alias === alias)
    .map((field) => ({ fieldId: field.id, scope: referenceScope(model, target, field) })).filter((value) => value.scope);
  const local = matches.filter((value) => value.scope === 'current');
  const candidates = local.length ? local : matches;
  return candidates.length === 1 ? candidates[0] : null;
}
