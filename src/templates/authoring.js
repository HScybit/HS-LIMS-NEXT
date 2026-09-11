import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import * as t from '../db/template-schema.js';
import { loadDefinition } from './loader.js';
import { assembleDefinition, referenceScope, resolveAlias } from './model.js';
import { parseExpression } from './expressions.js';
import { cloneLayout, layoutSelection } from './layout.js';
import { widgetTypes, requirePermission, uuid, revision, text, integer, bool, decimal, ownRecord, fieldsOnly } from './input.js';

const scope = (table, org, versionId) => and(eq(table.organizationId, org), eq(table.versionId, versionId));
const identityColumns = (identity, versionId) => ({ organizationId: identity.organization_id, versionId });

export async function insertBatch(db, table, records) {
  for (let start = 0; start < records.length; start += 500) await db.insert(table).values(records.slice(start, start + 500));
}

export async function createTemplate(client, identity, input) {
  requirePermission(identity, 'templates.manage');
  fieldsOnly(input, ['name', 'description', 'code', 'kind', 'templateType']);
  const name = text(input.name, 'Name');
  const description = text(input.description, 'Description', 10000, { optional: true });
  const code = text(input.code, 'UUID', 200, { optional: true }).trim() || randomUUID();
  if (!['sample', 'datasheet', 'report', 'label', 'equipment_service_log'].includes(input.kind)) throw new HttpError(400, 'invalid_type', 'Select a template type.');
  const templateType = input.templateType || null;
  if (templateType && (!['sample_coa', 'job_template', 'test_request'].includes(templateType) || input.kind !== (templateType === 'sample_coa' ? 'report' : 'datasheet'))) throw new HttpError(400, 'invalid_type', 'Template type does not match its use.');
  const templateId = randomUUID();
  const versionId = randomUUID();
  const db = database(client);
  try {
    await db.insert(t.templates).values({ organizationId: identity.organization_id, id: templateId, code, createdBy: identity.user_id });
  } catch (error) {
    if ((error.cause ?? error).code === '23505') throw new HttpError(409, 'template_code_taken', 'A template with this UUID already exists.');
    throw error;
  }
  await db.insert(t.templateVersions).values({ organizationId: identity.organization_id, id: versionId, templateId, number: 1, name, description, kind: input.kind, templateType, createdBy: identity.user_id });
  return { templateId, versionId, revision: 1 };
}

async function nextRevision(client, identity, versionId, expected, details) {
  requirePermission(identity, 'templates.manage');
  uuid(versionId, 'Template version'); revision(expected);
  const changed = await client.query(`UPDATE template_versions SET revision = revision + 1, name = coalesce($4, name), description = coalesce($5, description)
    WHERE organization_id = $1 AND id = $2 AND revision = $3 AND status = 'draft' RETURNING revision`, [identity.organization_id, versionId, expected, details?.name ?? null, details?.description ?? null]);
  if (!changed.rowCount) throw new HttpError(409, 'stale_template', 'This template changed or was frozen. Reload before saving.');
  return changed.rows[0].revision;
}

function expressionRecords(base, expressionId, nodes) {
  return nodes.map((node) => ({ ...base, expressionId, nodeIndex: node.index, parentIndex: node.parentIndex, operandOrder: node.operandOrder,
    kind: node.kind, numberLiteral: node.number ?? null, textLiteral: node.text ?? null, booleanLiteral: node.boolean ?? null,
    referenceFieldId: node.fieldId ?? null, referenceScope: node.scope ?? null, operator: node.operator ?? null, functionName: node.functionName ?? null }));
}

async function saveExpression(db, base, model, field, purpose, formula) {
  const existing = model.expressions[`${field.id}:${purpose}`];
  const expressionId = existing?.id ?? randomUUID();
  if (existing) await db.delete(t.templateExpressionNodes).where(and(scope(t.templateExpressionNodes, base.organizationId, base.versionId), eq(t.templateExpressionNodes.expressionId, expressionId)));
  if (!formula.trim()) {
    if (existing) await db.delete(t.templateExpressions).where(and(scope(t.templateExpressions, base.organizationId, base.versionId), eq(t.templateExpressions.id, expressionId)));
    return;
  }
  const nodes = parseExpression(formula, (alias) => resolveAlias(model, field, alias));
  if (!existing) await db.insert(t.templateExpressions).values({ ...base, id: expressionId, fieldId: field.id, purpose });
  await insertBatch(db, t.templateExpressionNodes, expressionRecords(base, expressionId, nodes));
}

async function configureField(db, base, model, command) {
  fieldsOnly(command, ['type', 'columnId', 'widget', 'alias', 'label', 'placeholder', 'required', 'editable', 'displayScale', 'padDecimals', 'minimum', 'maximum', 'formula', 'visibleFormula', 'requiredFormula', 'options']);
  const column = ownRecord(model.columnsById, command.columnId, 'Column');
  if (column.childSectionIds.length) throw new HttpError(400, 'column_has_children', 'Remove the nested container before adding a widget.');
  if (!Object.hasOwn(widgetTypes, command.widget)) throw new HttpError(400, 'unsupported_widget', 'This widget type is not supported.');
  const previous = model.fieldsById[column.fieldId];
  if (previous && previous.widget !== command.widget) throw new HttpError(400, 'widget_type_change', 'Remove the current widget before changing its type.');
  const alias = text(command.alias, 'Identifier', 200, { optional: true }).trim();
  if (!/^[A-Za-z0-9_]*$/.test(alias)) throw new HttpError(400, 'invalid_alias', 'Identifier can contain only letters, numbers and underscores.');
  if (alias && Object.values(model.fieldsById).some((field) => field.id !== previous?.id && field.alias === alias)) throw new HttpError(400, 'duplicate_alias', 'Key already exist!');
  const field = {
    ...base, id: previous?.id ?? randomUUID(), columnId: column.id, repeatGroupId: model.rowsById[column.rowId].repeatGroupId,
    widget: command.widget, valueType: widgetTypes[command.widget], alias, label: text(command.label, 'Title', 16000, { optional: true }),
    placeholder: text(command.placeholder, 'Placeholder', 1000, { optional: true }), required: bool(command.required ?? false, 'Required'), editable: bool(command.editable ?? false, 'Editable'),
  };
  if (previous) await db.update(t.templateFields).set(field).where(and(scope(t.templateFields, base.organizationId, base.versionId), eq(t.templateFields.id, field.id)));
  else await db.insert(t.templateFields).values(field);
  model.fieldsById[field.id] = { ...previous, ...field };
  if (field.valueType === 'numeric') {
    const config = { ...base, fieldId: field.id, displayScale: command.displayScale == null || command.displayScale === '' ? null : integer(command.displayScale, 'Decimal points', 0, 100),
      padDecimals: bool(command.padDecimals ?? false, 'Show decimal points'), minimum: decimal(command.minimum, 'Minimum', { optional: true }), maximum: decimal(command.maximum, 'Maximum', { optional: true }) };
    if (config.minimum !== null && config.maximum !== null && Number(config.minimum) > Number(config.maximum)) throw new HttpError(400, 'invalid_bounds', 'Minimum cannot exceed maximum.');
    await db.insert(t.templateNumericConfig).values(config).onConflictDoUpdate({ target: [t.templateNumericConfig.organizationId, t.templateNumericConfig.versionId, t.templateNumericConfig.fieldId], set: config });
  }
  if (field.valueType === 'option') {
    if (!Array.isArray(command.options) || command.options.length > 1000) throw new HttpError(400, 'invalid_options', 'Provide at most 1,000 dropdown options.');
    const options = command.options.map((value, position) => ({ ...base, fieldId: field.id, id: previous?.options?.find((option) => option.value === value)?.id ?? randomUUID(), position,
      label: text(value, 'Option', 1000), value: text(value, 'Option', 1000) }));
    if (new Set(options.map((option) => option.value)).size !== options.length) throw new HttpError(400, 'duplicate_options', 'Dropdown options must be distinct.');
    await db.delete(t.templateOptions).where(and(scope(t.templateOptions, base.organizationId, base.versionId), eq(t.templateOptions.fieldId, field.id)));
    await insertBatch(db, t.templateOptions, options);
  }
  for (const [purpose, key] of [['calculate', 'formula'], ['visible', 'visibleFormula'], ['required', 'requiredFormula']]) {
    if (command[key] === undefined) continue;
    if (purpose === 'calculate' && field.widget !== 'formula_widget') throw new HttpError(400, 'invalid_formula_target', 'Only a formula widget can calculate a result.');
    await saveExpression(db, base, model, field, purpose, text(command[key], 'Formula', 16000, { optional: true }));
  }
}

export async function editTemplate(client, identity, versionId, expectedRevision, command) {
  fieldsOnly(command, ['type', 'parentColumnId', 'sectionId', 'rowId', 'columnId', 'widget', 'alias', 'label', 'placeholder', 'required', 'editable', 'displayScale', 'padDecimals', 'minimum', 'maximum', 'formula', 'visibleFormula', 'requiredFormula', 'options', 'kind', 'id', 'direction', 'name', 'description', 'cssClass', 'visible', 'isHeader', 'isFooter', 'isFinalResult', 'span', 'enabled']);
  let details;
  if (command.type === 'editDetails') {
    fieldsOnly(command, ['type', 'name', 'description']);
    details = { name: text(command.name, 'Name'), description: text(command.description, 'Description', 10000, { optional: true }) };
  }
  await nextRevision(client, identity, versionId, expectedRevision, details);
  const { model, records } = await loadDefinition(client, identity.organization_id, versionId);
  const db = database(client);
  const base = identityColumns(identity, versionId);
  if (command.type === 'addSection') {
    fieldsOnly(command, ['type', 'parentColumnId']);
    const parent = command.parentColumnId ? ownRecord(model.columnsById, command.parentColumnId, 'Column') : null;
    if (parent?.fieldId) throw new HttpError(400, 'column_has_widget', 'Remove the widget before adding a nested container.');
    const siblings = parent ? parent.childSectionIds : model.rootSectionIds;
    const position = siblings.length ? Math.max(...siblings.map((id) => model.sectionsById[id].position)) + 1 : 0;
    await db.insert(t.templateSections).values({ ...base, id: randomUUID(), parentColumnId: parent?.id ?? null, position });
  } else if (command.type === 'addRow') {
    fieldsOnly(command, ['type', 'sectionId']);
    const section = ownRecord(model.sectionsById, command.sectionId, 'Container');
    const rowId = randomUUID();
    const position = section.rowIds.length ? Math.max(...section.rowIds.map((id) => model.rowsById[id].position)) + 1 : 0;
    await db.insert(t.templateRows).values({ ...base, id: rowId, sectionId: section.id, position });
    await db.insert(t.templateColumns).values({ ...base, id: randomUUID(), rowId, position: 0 });
  } else if (command.type === 'addColumn') {
    fieldsOnly(command, ['type', 'rowId']);
    const row = ownRecord(model.rowsById, command.rowId, 'Row');
    const position = row.columnIds.length ? Math.max(...row.columnIds.map((id) => model.columnsById[id].position)) + 1 : 0;
    await db.insert(t.templateColumns).values({ ...base, id: randomUUID(), rowId: row.id, position });
  } else if (command.type === 'configureField') {
    await configureField(db, base, model, command);
  } else if (command.type === 'move') {
    fieldsOnly(command, ['type', 'kind', 'id', 'direction']);
    integer(command.direction, 'Direction', -1, 1);
    if (!command.direction) throw new HttpError(400, 'invalid_move', 'Select a move direction.');
    const map = { section: [model.sectionsById, t.templateSections], row: [model.rowsById, t.templateRows], column: [model.columnsById, t.templateColumns] };
    if (!Object.hasOwn(map, command.kind)) throw new HttpError(400, 'invalid_move', 'Select a valid layout item.');
    const [items, table] = map[command.kind];
    const item = ownRecord(items, command.id, 'Layout item');
    const siblings = command.kind === 'section' ? (item.parentColumnId ? model.columnsById[item.parentColumnId].childSectionIds : model.rootSectionIds)
      : command.kind === 'row' ? model.sectionsById[item.sectionId].rowIds : model.rowsById[item.rowId].columnIds;
    const other = items[siblings[siblings.indexOf(item.id) + command.direction]];
    if (!other) throw new HttpError(400, 'invalid_move', 'The item is already at the boundary.');
    await db.update(table).set({ position: other.position }).where(and(scope(table, base.organizationId, versionId), eq(table.id, item.id)));
    await db.update(table).set({ position: item.position }).where(and(scope(table, base.organizationId, versionId), eq(table.id, other.id)));
  } else if (command.type === 'configureSection') {
    fieldsOnly(command, ['type', 'id', 'name', 'cssClass', 'visible', 'isHeader', 'isFooter', 'isFinalResult']);
    const section = ownRecord(model.sectionsById, command.id, 'Container');
    await db.update(t.templateSections).set({ name: text(command.name, 'Container name', 200, { optional: true }), cssClass: text(command.cssClass, 'CSS class', 1000, { optional: true }),
      visible: bool(command.visible ?? true, 'Visible'), isHeader: bool(command.isHeader ?? false, 'Header'), isFooter: bool(command.isFooter ?? false, 'Footer'), isFinalResult: bool(command.isFinalResult ?? false, 'Final result') })
      .where(and(scope(t.templateSections, base.organizationId, versionId), eq(t.templateSections.id, section.id)));
  } else if (command.type === 'configureColumn') {
    fieldsOnly(command, ['type', 'id', 'span', 'cssClass', 'widget']);
    const column = ownRecord(model.columnsById, command.id, 'Column');
    await db.update(t.templateColumns).set({ span: integer(command.span, 'Column span', 0, 12), cssClass: text(command.cssClass, 'CSS class', 1000, { optional: true }) })
      .where(and(scope(t.templateColumns, base.organizationId, versionId), eq(t.templateColumns.id, command.id)));
    if (command.widget && !column.fieldId) await configureField(db, base, model, { type: 'configureField', columnId: column.id, widget: command.widget, options: [] });
    else if (command.widget && model.fieldsById[column.fieldId]?.widget !== command.widget) throw new HttpError(400, 'widget_type_change', 'Remove the current widget before changing its type.');
  } else if (command.type === 'clone') {
    fieldsOnly(command, ['type', 'kind', 'id']); uuid(command.id);
    const cloned = cloneLayout(records, model, command.kind, command.id, randomUUID);
    if (command.kind === 'row') {
      const source = model.rowsById[command.id];
      await client.query('UPDATE template_rows SET position = position + 1 WHERE organization_id = $1 AND version_id = $2 AND section_id = $3 AND position > $4', [base.organizationId, versionId, source.sectionId, source.position]);
    }
    await copyDefinition(db, cloned.records, base.organizationId, versionId);
  } else if (command.type === 'repeatRow') {
    fieldsOnly(command, ['type', 'id', 'enabled']);
    const row = ownRecord(model.rowsById, command.id, 'Row');
    bool(command.enabled, 'Cloneable');
    const existing = records.groups.find((group) => group.rowId === row.id);
    if (Boolean(existing) === command.enabled) throw new HttpError(400, 'unchanged_repeat', 'This row already has the requested clone setting.');
    const selected = layoutSelection(model, 'row', row.id);
    const previousGroup = row.repeatGroupId;
    const nextGroup = command.enabled ? randomUUID() : existing.parentGroupId;
    if (command.enabled) {
      const group = { ...base, id: nextGroup, rowId: row.id, parentGroupId: previousGroup, minimum: 1, maximum: 1000 };
      await db.insert(t.templateRepeatGroups).values(group);
      records.groups.push(group);
    }
    const affectedFields = records.fields.filter((field) => selected.fields.has(field.id) && (field.repeatGroupId ?? null) === previousGroup);
    if (affectedFields.length) await db.update(t.templateFields).set({ repeatGroupId: nextGroup }).where(and(scope(t.templateFields, base.organizationId, versionId), inArray(t.templateFields.id, affectedFields.map((field) => field.id))));
    for (const field of affectedFields) field.repeatGroupId = nextGroup;
    const childGroups = records.groups.filter((group) => group.id !== existing?.id && selected.groups.has(group.id) && (group.parentGroupId ?? null) === previousGroup);
    if (childGroups.length) await db.update(t.templateRepeatGroups).set({ parentGroupId: nextGroup }).where(and(scope(t.templateRepeatGroups, base.organizationId, versionId), inArray(t.templateRepeatGroups.id, childGroups.map((group) => group.id))));
    for (const group of childGroups) group.parentGroupId = nextGroup;
    if (existing) {
      records.groups = records.groups.filter((group) => group.id !== existing.id);
      await db.delete(t.templateRepeatGroups).where(and(scope(t.templateRepeatGroups, base.organizationId, versionId), eq(t.templateRepeatGroups.id, existing.id)));
    }
    const context = { fieldsById: Object.fromEntries(records.fields.map((field) => [field.id, field])), groupsById: Object.fromEntries(records.groups.map((group) => [group.id, group])) };
    const updates = [];
    for (const expression of records.expressions) for (const node of expression.nodes) {
      if (node.kind !== 'field') continue;
      const reference = referenceScope(context, context.fieldsById[expression.fieldId], context.fieldsById[node.fieldId]);
      if (!reference) throw new HttpError(400, 'incompatible_repeat', 'This repeat would make a formula reference inaccessible.');
      if (reference !== node.scope) updates.push({ expressionId: expression.id, index: node.index, scope: reference });
    }
    if (updates.length) await client.query(`UPDATE template_expression_nodes n SET reference_scope = u.scope
      FROM unnest($3::uuid[], $4::integer[], $5::text[]) AS u(expression_id, node_index, scope)
      WHERE n.organization_id = $1 AND n.version_id = $2 AND n.expression_id = u.expression_id AND n.node_index = u.node_index`,
    [base.organizationId, versionId, updates.map((value) => value.expressionId), updates.map((value) => value.index), updates.map((value) => value.scope)]);
  } else if (command.type === 'delete') {
    fieldsOnly(command, ['type', 'kind', 'id']); uuid(command.id);
    const selection = layoutSelection(model, command.kind, command.id);
    for (const expression of records.expressions) {
      if (!selection.expressions.has(expression.id) && expression.nodes.some((node) => node.kind === 'field' && selection.fields.has(node.fieldId))) {
        throw new HttpError(400, 'referenced_field', 'This item contains a field used by another formula or condition. Update that reference first.');
      }
    }
    const remove = async (table, column, ids) => {
      if (ids.size) await db.delete(table).where(and(scope(table, base.organizationId, versionId), inArray(column, [...ids])));
    };
    await remove(t.templateExpressionNodes, t.templateExpressionNodes.expressionId, selection.expressions);
    await remove(t.templateExpressions, t.templateExpressions.id, selection.expressions);
    await remove(t.templateOptions, t.templateOptions.fieldId, selection.fields);
    await remove(t.templateNumericConfig, t.templateNumericConfig.fieldId, selection.fields);
    await remove(t.templateFields, t.templateFields.id, selection.fields);
    await remove(t.templateRepeatGroups, t.templateRepeatGroups.id, selection.groups);
    await remove(t.templateColumns, t.templateColumns.id, selection.columns);
    await remove(t.templateRows, t.templateRows.id, selection.rows);
    await remove(t.templateSections, t.templateSections.id, selection.sections);
  } else if (command.type === 'editDetails') {
    return { model };
  } else throw new HttpError(400, 'unsupported_command', 'This designer action is not supported.');
  return loadDefinition(client, identity.organization_id, versionId);
}

export async function freezeTemplate(client, identity, versionId, expectedRevision) {
  requirePermission(identity, 'templates.manage'); uuid(versionId); revision(expectedRevision);
  const locked = await client.query('SELECT revision, status FROM template_versions WHERE organization_id = $1 AND id = $2 FOR UPDATE', [identity.organization_id, versionId]);
  if (!locked.rowCount || locked.rows[0].revision !== expectedRevision || locked.rows[0].status !== 'draft') throw new HttpError(409, 'stale_template', 'This template changed or was frozen. Reload before continuing.');
  const loaded = await loadDefinition(client, identity.organization_id, versionId, { forFreeze: true });
  await client.query("UPDATE template_versions SET status = 'frozen', revision = revision + 1, frozen_at = now(), frozen_by = $3 WHERE organization_id = $1 AND id = $2", [identity.organization_id, versionId, identity.user_id]);
  return { versionId, revision: expectedRevision + 1, metrics: loaded.metrics };
}

export async function copyDefinition(db, records, organizationId, versionId) {
  const base = { organizationId, versionId };
  // Parent placement FKs are deferred for this transaction while nested containers are inserted.
  await insertBatch(db, t.templateSections, records.sections.map((row) => ({ ...row, ...base })));
  await insertBatch(db, t.templateRows, records.rows.map((row) => ({ ...row, ...base })));
  await insertBatch(db, t.templateColumns, records.columns.map((row) => ({ ...row, ...base })));
  await insertBatch(db, t.templateRepeatGroups, records.groups.map((row) => ({ ...row, ...base })));
  await insertBatch(db, t.templateFields, records.fields.map(({ numeric: _numeric, ...row }) => ({ ...row, ...base })));
  await insertBatch(db, t.templateNumericConfig, records.fields.filter((row) => row.numeric).map((row) => ({ ...row.numeric, ...base })));
  await insertBatch(db, t.templateOptions, records.options.map((row) => ({ ...row, ...base })));
  await insertBatch(db, t.templateExpressions, records.expressions.map(({ nodes: _nodes, ...row }) => ({ ...row, ...base })));
  await insertBatch(db, t.templateExpressionNodes, records.expressions.flatMap((row) => expressionRecords(base, row.id, row.nodes)));
}

export async function createDraft(client, identity, sourceVersionId) {
  requirePermission(identity, 'templates.manage'); uuid(sourceVersionId);
  const { records } = await loadDefinition(client, identity.organization_id, sourceVersionId, { forFreeze: true });
  if (records.version.status !== 'frozen') throw new HttpError(400, 'invalid_source_version', 'Create a new draft from a frozen version.');
  await client.query('SELECT id FROM templates WHERE organization_id = $1 AND id = $2 FOR UPDATE', [identity.organization_id, records.version.templateId]);
  const existing = await client.query('SELECT id, status, number FROM template_versions WHERE organization_id = $1 AND template_id = $2 ORDER BY number DESC LIMIT 1', [identity.organization_id, records.version.templateId]);
  if (existing.rows[0].status === 'draft') throw new HttpError(409, 'draft_exists', 'This template already has an editable draft.');
  const versionId = randomUUID();
  const db = database(client);
  await db.insert(t.templateVersions).values({ organizationId: identity.organization_id, id: versionId, templateId: records.version.templateId, number: existing.rows[0].number + 1,
    name: records.version.name, description: records.version.description, kind: records.version.kind, templateType: records.version.templateType, sourceVersionId, createdBy: identity.user_id });
  await copyDefinition(db, records, identity.organization_id, versionId);
  return { templateId: records.version.templateId, versionId, revision: 1 };
}

export { assembleDefinition };
