import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import { roles as rolesTable } from '../db/schema.js';
import * as t from '../db/template-schema.js';
import { loadDefinition } from './loader.js';
import { assembleDefinition, referenceScope, resolveAlias } from './model.js';
import { parseExpression } from './expressions.js';
import { cloneLayout, cloneVersionLayout, layoutSelection } from './layout.js';
import { widgetTypes, requirePermission, uuid, revision, text, integer, bool, decimal, ownRecord, fieldsOnly } from './input.js';
import { contextWidgetFields, isContextWidget } from './context-widgets.js';
import { fieldDefaultValue, resultDefaultFields } from './defaults.js';
import { imageLayout, imageLayoutLabels } from './image-config.js';
import { sampleLineSelection } from './sample-line.js';

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

function expressionRecords(base, expressionId, references) {
  return references.map((reference) => ({ ...base, expressionId, alias: reference.alias, referenceFieldId: reference.fieldId, referenceScope: reference.scope }));
}

async function saveExpression(db, base, model, field, purpose, formula) {
  const existing = model.expressions[`${field.id}:${purpose}`];
  const expressionId = existing?.id ?? randomUUID();
  if (existing) await db.delete(t.templateExpressionReferences).where(and(scope(t.templateExpressionReferences, base.organizationId, base.versionId), eq(t.templateExpressionReferences.expressionId, expressionId)));
  if (!formula.trim()) {
    if (existing) await db.delete(t.templateExpressions).where(and(scope(t.templateExpressions, base.organizationId, base.versionId), eq(t.templateExpressions.id, expressionId)));
    return;
  }
  const stored = parseExpression(formula, (alias) => resolveAlias(model, field, alias));
  if (existing) await db.update(t.templateExpressions).set({ formulaText: stored.formulaText }).where(and(scope(t.templateExpressions, base.organizationId, base.versionId), eq(t.templateExpressions.id, expressionId)));
  else await db.insert(t.templateExpressions).values({ ...base, id: expressionId, fieldId: field.id, purpose, formulaText: stored.formulaText });
  await insertBatch(db, t.templateExpressionReferences, expressionRecords(base, expressionId, stored.references));
}

async function setFieldRoleAccess(db, base, model, field, editRoleIds, viewRoleIds) {
  if (editRoleIds !== undefined && !Array.isArray(editRoleIds)) throw new HttpError(400, 'invalid_input', 'Provide edit access as a list of roles.');
  if (viewRoleIds !== undefined && !Array.isArray(viewRoleIds)) throw new HttpError(400, 'invalid_input', 'Provide view access as a list of roles.');
  const edit = (editRoleIds ?? field.editRoleIds ?? []).map((id) => uuid(id, 'Role'));
  const view = (viewRoleIds ?? field.viewRoleIds ?? []).map((id) => uuid(id, 'Role'));
  if (new Set(edit).size !== edit.length || new Set(view).size !== view.length) throw new HttpError(400, 'duplicate_role', 'A role cannot be selected twice for the same list.');
  const requested = [...new Set([...edit, ...view])];
  if (requested.length) {
    const valid = await db.select({ id: rolesTable.id }).from(rolesTable)
      .where(and(eq(rolesTable.organizationId, base.organizationId), inArray(rolesTable.id, requested), eq(rolesTable.active, true)));
    if (valid.length !== requested.length) throw new HttpError(400, 'invalid_role', 'Select an active role from this organization.');
  }
  await db.delete(t.templateFieldRoleAccess).where(and(scope(t.templateFieldRoleAccess, base.organizationId, base.versionId), eq(t.templateFieldRoleAccess.fieldId, field.id)));
  await insertBatch(db, t.templateFieldRoleAccess, [
    ...edit.map((roleId) => ({ ...base, fieldId: field.id, roleId, access: 'edit' })),
    ...view.map((roleId) => ({ ...base, fieldId: field.id, roleId, access: 'view' })),
  ]);
  model.fieldsById[field.id].editRoleIds = edit;
  model.fieldsById[field.id].viewRoleIds = view;
}

async function configureField(db, base, model, command) {
  fieldsOnly(command, ['type', 'columnId', 'widget', 'alias', 'label', 'placeholder', 'required', 'editable', 'displayScale', 'padDecimals', 'minimum', 'maximum', 'formula', 'visibleFormula', 'requiredFormula', 'options', 'sourceField', 'serialPadding', 'attributeKey', 'defaultValue', 'image', 'formulaOnMissingValue', 'formulaOnError', 'editRoleIds', 'viewRoleIds']);
  const column = ownRecord(model.columnsById, command.columnId, 'Column');
  if (column.childSectionIds.length) throw new HttpError(400, 'column_has_children', 'Remove the nested container before adding a widget.');
  if (!Object.hasOwn(widgetTypes, command.widget)) throw new HttpError(400, 'unsupported_widget', 'This widget type is not supported.');
  const previous = model.fieldsById[column.fieldId];
  if (previous && previous.widget !== command.widget) throw new HttpError(400, 'widget_type_change', 'Remove the current widget before changing its type.');
  const contextual = isContextWidget(command.widget);
  let sourceField = command.sourceField === undefined ? previous?.sourceField ?? null : command.sourceField === '' ? null : command.sourceField;
  if (command.widget === 'sample_line_item_data_widget') sourceField = sampleLineSelection(sourceField);
  const attributeKey = command.attributeKey === undefined ? previous?.attributeKey ?? null : command.attributeKey === null ? null : text(command.attributeKey, 'Attribute Name/Key', 16000, { optional: true });
  if (attributeKey !== null && (command.widget !== 'sample_line_item_data_widget' || attributeKey.includes('\0'))) throw new HttpError(400, 'invalid_attribute_key', 'Attribute Name/Key belongs to a line-item widget and cannot contain null characters.');
  const serialPadding = command.serialPadding === undefined ? previous?.serialPadding ?? null : command.serialPadding;
  if (sourceField !== null && (!contextual || !contextWidgetFields[command.widget].includes(sourceField))) throw new HttpError(400, 'invalid_context_field', 'Select a supported data field for this widget.');
  if (serialPadding !== null && (command.widget !== 'sno_widget' || !Number.isSafeInteger(serialPadding) || serialPadding < 0 || serialPadding > 100)) throw new HttpError(400, 'invalid_serial_padding', 'Serial number padding must be between 0 and 100.');
  if (contextual && command.editable === true) throw new HttpError(400, 'readonly_context_widget', 'This widget displays its recorded source value.');
  if (command.widget === 'template_image_widget' && command.editable === true) throw new HttpError(400, 'readonly_image_widget', 'Template images can only be changed in the designer.');
  if (command.widget === 'vertical_text_widget' && command.editable === true) throw new HttpError(400, 'readonly_text_widget', 'Vertical Text displays its configured title.');
  if (command.widget === 'parameter_detail_widget' && command.editable === true) throw new HttpError(400, 'readonly_parameter_detail', 'Parameter Detail values are fetched from the captured parameter.');
  if (command.image !== undefined && command.widget !== 'template_image_widget') throw new HttpError(400, 'invalid_image_config', 'Image configuration belongs to an image widget.');
  if (command.formulaOnMissingValue !== undefined && !['zero', 'blank', 'error'].includes(command.formulaOnMissingValue)) throw new HttpError(400, 'invalid_input', 'Select a supported behavior for a missing formula input.');
  if (command.formulaOnError !== undefined && !['show_error', 'blank'].includes(command.formulaOnError)) throw new HttpError(400, 'invalid_input', 'Select a supported behavior for a formula error.');
  if ((command.formulaOnMissingValue !== undefined || command.formulaOnError !== undefined) && command.widget !== 'formula_widget') throw new HttpError(400, 'invalid_input', 'Error handling only applies to a formula widget.');
  const alias = text(command.alias, 'Identifier', 200, { optional: true }).trim();
  if (!/^[A-Za-z0-9_]*$/.test(alias)) throw new HttpError(400, 'invalid_alias', 'Identifier can contain only letters, numbers and underscores.');
  if (alias && Object.values(model.fieldsById).some((field) => field.id !== previous?.id && field.alias === alias)) throw new HttpError(400, 'duplicate_alias', 'Key already exist!');
  const field = {
    ...base, id: previous?.id ?? randomUUID(), columnId: column.id, repeatGroupId: model.rowsById[column.rowId].repeatGroupId,
    widget: command.widget, valueType: previous?.valueType ?? widgetTypes[command.widget], alias, label: text(command.label, 'Title', 16000, { optional: true }),
    placeholder: text(command.placeholder, 'Placeholder', 1000, { optional: true }), required: bool(command.required ?? false, 'Required'), editable: bool(command.editable ?? false, 'Editable'),
    sourceField, serialPadding, attributeKey,
    formulaOnMissingValue: command.widget === 'formula_widget' ? command.formulaOnMissingValue ?? previous?.formulaOnMissingValue ?? 'error' : 'error',
    formulaOnError: command.widget === 'formula_widget' ? command.formulaOnError ?? previous?.formulaOnError ?? 'show_error' : 'show_error',
  };
  let config;
  if (['numeric', 'result'].includes(field.valueType)) {
    config = { ...base, fieldId: field.id, valueType: field.valueType, displayScale: command.displayScale == null || command.displayScale === '' ? null : integer(command.displayScale, 'Decimal points', 0, 100),
      padDecimals: bool(command.padDecimals ?? false, 'Show decimal points'), minimum: decimal(command.minimum, 'Minimum', { optional: true }), maximum: decimal(command.maximum, 'Maximum', { optional: true }) };
    if (config.minimum !== null && config.maximum !== null && Number(config.minimum) > Number(config.maximum)) throw new HttpError(400, 'invalid_bounds', 'Minimum cannot exceed maximum.');
  }
  if (command.defaultValue !== undefined) {
    if (['product_detail_widget', 'sample_line_item_data_widget', 'vertical_text_widget', 'parameter_detail_widget', 'tr_data_widget'].includes(field.widget)) {
      const configured = text(command.defaultValue, 'Default Value', 16000, { optional: true });
      if (configured.includes('\0') || !configured.isWellFormed()) throw new HttpError(400, 'invalid_input', 'Default Value must be valid text without null characters.');
      Object.assign(field, { defaultState: configured === '' ? 'absent' : 'present', defaultText: configured === '' ? null : configured });
    } else {
      if (field.widget !== 'result_widget') throw new HttpError(400, 'unsupported_default', 'Default configuration is not available for this widget.');
      Object.assign(field, resultDefaultFields({ ...field, numeric: config }, command.defaultValue));
    }
  } else if (['product_detail_widget', 'sample_line_item_data_widget', 'vertical_text_widget', 'parameter_detail_widget', 'tr_data_widget'].includes(field.widget) && previous) {
    Object.assign(field, { defaultState: previous.defaultState, defaultText: previous.defaultText });
  } else if (field.widget === 'result_widget' && previous?.defaultState === 'present') {
    // A bounds/precision edit cannot publish a default that the new field rejects.
    resultDefaultFields({ ...field, numeric: config }, fieldDefaultValue(previous));
  }
  if (previous) await db.update(t.templateFields).set(field).where(and(scope(t.templateFields, base.organizationId, base.versionId), eq(t.templateFields.id, field.id)));
  else await db.insert(t.templateFields).values(field);
  model.fieldsById[field.id] = { ...previous, ...field };
  if (config) {
    await db.insert(t.templateNumericConfig).values(config).onConflictDoUpdate({ target: [t.templateNumericConfig.organizationId, t.templateNumericConfig.versionId, t.templateNumericConfig.fieldId], set: config });
  }
  if (field.widget === 'template_image_widget') {
    const previousLayout = Object.fromEntries(Object.keys(imageLayoutLabels).map((key) => [key, previous?.image?.[key]]));
    const image = { ...base, fieldId: field.id, ...imageLayout(command.image ?? previousLayout) };
    await db.insert(t.templateImageConfig).values(image).onConflictDoUpdate({ target: [t.templateImageConfig.organizationId, t.templateImageConfig.versionId, t.templateImageConfig.fieldId], set: image });
  }
  if (field.valueType === 'option') {
    if (!Array.isArray(command.options) || command.options.length > 1000) throw new HttpError(400, 'invalid_options', 'Provide at most 1,000 dropdown options.');
    const options = command.options.map((value, position) => ({ ...base, fieldId: field.id, id: previous?.options?.find((option) => option.value === value)?.id ?? randomUUID(), position,
      label: text(value, 'Option', 1000), value: text(value, 'Option', 1000) }));
    if (new Set(options.map((option) => option.value)).size !== options.length) throw new HttpError(400, 'duplicate_options', 'Dropdown options must be distinct.');
    await db.delete(t.templateOptions).where(and(scope(t.templateOptions, base.organizationId, base.versionId), eq(t.templateOptions.fieldId, field.id)));
    await insertBatch(db, t.templateOptions, options);
  }
  if (command.editRoleIds !== undefined || command.viewRoleIds !== undefined) {
    await setFieldRoleAccess(db, base, model, model.fieldsById[field.id], command.editRoleIds, command.viewRoleIds);
  }
  for (const [purpose, key] of [['calculate', 'formula'], ['visible', 'visibleFormula'], ['required', 'requiredFormula']]) {
    if (command[key] === undefined) continue;
    if (purpose === 'calculate' && field.widget !== 'formula_widget') throw new HttpError(400, 'invalid_formula_target', 'Only a formula widget can calculate a result.');
    await saveExpression(db, base, model, field, purpose, text(command[key], 'Formula', 16000, { optional: true }));
  }
}

async function changeRepeatGroup(client, db, base, records, model, { kind, id, enabled, source = 'manual' }) {
  const versionId = base.versionId;
  const target = kind === 'row' ? model.rowsById[id] : model.sectionsById[id];
  const existing = records.groups.find((group) => kind === 'row' ? group.rowId === id : group.sectionId === id);
  if (Boolean(existing) === enabled) {
    if (existing && existing.source !== source) {
      await db.update(t.templateRepeatGroups).set({ source }).where(and(scope(t.templateRepeatGroups, base.organizationId, versionId), eq(t.templateRepeatGroups.id, existing.id)));
    }
    return;
  }
  const selected = layoutSelection(model, kind, target.id);
  const previousGroup = target.repeatGroupId;
  const nextGroup = enabled ? randomUUID() : existing.parentGroupId;
  if (enabled) {
    const group = { ...base, id: nextGroup, [kind === 'row' ? 'rowId' : 'sectionId']: target.id, source, parentGroupId: previousGroup, minimum: 1, maximum: 1000 };
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
  for (const expression of records.expressions) for (const node of expression.references) {
    const reference = referenceScope(context, context.fieldsById[expression.fieldId], context.fieldsById[node.fieldId]);
    if (!reference) throw new HttpError(400, 'incompatible_repeat', 'This repeat would make a formula reference inaccessible.');
    if (reference !== node.scope) updates.push({ expressionId: expression.id, alias: node.alias, scope: reference });
  }
  if (updates.length) await client.query(`UPDATE template_expression_references n SET reference_scope = u.scope
    FROM unnest($3::uuid[], $4::text[], $5::text[]) AS u(expression_id, alias, scope)
    WHERE n.organization_id = $1 AND n.version_id = $2 AND n.expression_id = u.expression_id AND n.alias = u.alias`,
  [base.organizationId, versionId, updates.map((value) => value.expressionId), updates.map((value) => value.alias), updates.map((value) => value.scope)]);
}

export async function editTemplate(client, identity, versionId, expectedRevision, command) {
  fieldsOnly(command, ['type', 'parentColumnId', 'sectionId', 'rowId', 'columnId', 'fieldId', 'widget', 'alias', 'label', 'placeholder', 'required', 'editable', 'displayScale', 'padDecimals', 'minimum', 'maximum', 'formula', 'visibleFormula', 'requiredFormula', 'options', 'kind', 'id', 'ids', 'direction', 'name', 'description', 'cssClass', 'visible', 'isHeader', 'isFooter', 'isFinalResult', 'span', 'enabled', 'sourceField', 'serialPadding', 'attributeKey', 'isParameterLoop', 'isParameterLoopHeader', 'headerDocumentId', 'footerDocumentId', 'nablHeaderDocumentId', 'nablFooterDocumentId', 'defaultValue', 'image', 'sourceVersionId', 'sourceSectionId', 'showInNabl', 'showInNonNabl', 'formulaOnMissingValue', 'formulaOnError', 'editRoleIds', 'viewRoleIds', 'keepTogether', 'columns', 'indexValue', 'masterValue', 'widthMm', 'heightMm', 'showInCoa', 'showInTemplate']);
  if (command.type === 'setReportAssets') {
    requirePermission(identity, 'templates.manage'); uuid(versionId, 'Template version'); revision(expectedRevision);
    const keys = ['headerDocumentId', 'footerDocumentId', 'nablHeaderDocumentId', 'nablFooterDocumentId'];
    fieldsOnly(command, ['type', ...keys]);
    const values = Object.fromEntries(keys.map((key) => [key, command[key] == null ? null : uuid(command[key], 'Report asset').toLowerCase()]));
    const options = (await client.query('SELECT * FROM report_document_options()')).rows;
    for (const key of keys) if (values[key] && !options.some((option) => option.id === values[key] && option.type === (key.toLowerCase().includes('header') ? 'header' : 'footer'))) {
      throw new HttpError(422, 'report_asset_unavailable', 'Select an available header or footer from this organization.');
    }
    const updated = await client.query(`UPDATE template_versions SET revision=revision+1,header_document_id=$4,footer_document_id=$5,nabl_header_document_id=$6,nabl_footer_document_id=$7
      WHERE organization_id=$1 AND id=$2 AND revision=$3 AND status='draft' RETURNING id`,
    [identity.organization_id, versionId, expectedRevision, ...keys.map((key) => values[key])]);
    if (!updated.rowCount) throw new HttpError(409, 'stale_template', 'This template changed or was frozen. Reload before saving.');
    return loadDefinition(client, identity.organization_id, versionId);
  }
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
  } else if (command.type === 'configureRow') {
    fieldsOnly(command, ['type', 'id', 'name', 'cssClass', 'keepTogether']);
    const row = ownRecord(model.rowsById, command.id, 'Row');
    await db.update(t.templateRows).set({ name: command.name === undefined ? row.name : text(command.name, 'Row name', 200, { optional: true }) || null,
      cssClass: text(command.cssClass, 'CSS class', 1000, { optional: true }),
      keepTogether: command.keepTogether === undefined ? row.keepTogether : bool(command.keepTogether, 'Keep together') })
      .where(and(scope(t.templateRows, base.organizationId, versionId), eq(t.templateRows.id, command.id)));
  } else if (command.type === 'configureRowLayout') {
    fieldsOnly(command, ['type', 'id', 'columns']);
    const row = ownRecord(model.rowsById, command.id, 'Row');
    if (!Array.isArray(command.columns) || !command.columns.length || command.columns.length > 12) throw new HttpError(400, 'invalid_layout', 'A row must contain between 1 and 12 columns.');
    const existingIds = new Set(row.columnIds);
    const suppliedIds = command.columns.filter((column) => column.id !== undefined).map((column) => uuid(column.id, 'Column'));
    if (new Set(suppliedIds).size !== suppliedIds.length || suppliedIds.length !== existingIds.size || suppliedIds.some((id) => !existingIds.has(id))) {
      throw new HttpError(400, 'invalid_layout', 'The saved layout must include each existing column exactly once.');
    }
    const values = command.columns.map((column, position) => {
      fieldsOnly(column, ['id', 'name', 'gridSpan', 'widthMm']);
      const span = integer(column.gridSpan, 'Column span', 1, 12);
      const widthMm = decimal(column.widthMm, 'Print width', { optional: true });
      if (widthMm !== null && (Number(widthMm) < 0.001 || Number(widthMm) > 1000)) throw new HttpError(400, 'invalid_layout', 'Print width must be between 0.001 and 1000 mm.');
      return { id: column.id ?? randomUUID(), name: text(column.name, 'Column name', 200, { optional: true }) || null, span, widthMm, position };
    });
    if (values.reduce((sum, column) => sum + column.span, 0) !== 12) throw new HttpError(400, 'invalid_layout', 'Column spans must total exactly 12 grid units.');
    for (const value of values) {
      if (existingIds.has(value.id)) await db.update(t.templateColumns).set(value).where(and(scope(t.templateColumns, base.organizationId, versionId), eq(t.templateColumns.id, value.id)));
      else await db.insert(t.templateColumns).values({ ...base, ...value, rowId: row.id });
    }
  } else if (command.type === 'moveRowToSection') {
    fieldsOnly(command, ['type', 'id', 'sectionId']);
    const row = ownRecord(model.rowsById, command.id, 'Row');
    const target = ownRecord(model.sectionsById, command.sectionId, 'Container');
    if (target.id === row.sectionId) throw new HttpError(400, 'unchanged_move', 'Select a different container.');
    const position = target.rowIds.length ? Math.max(...target.rowIds.map((id) => model.rowsById[id].position)) + 1 : 0;
    await db.update(t.templateRows).set({ sectionId: target.id, position }).where(and(scope(t.templateRows, base.organizationId, versionId), eq(t.templateRows.id, row.id)));
  } else if (command.type === 'bulkConfigureColumns') {
    fieldsOnly(command, ['type', 'ids', 'cssClass']);
    if (!Array.isArray(command.ids) || !command.ids.length || command.ids.length > 500) throw new HttpError(400, 'invalid_selection', 'Select between 1 and 500 columns.');
    const ids = command.ids.map((id) => ownRecord(model.columnsById, id, 'Column').id);
    const cssClass = text(command.cssClass, 'CSS class', 1000, { optional: true });
    await db.update(t.templateColumns).set({ cssClass }).where(and(scope(t.templateColumns, base.organizationId, versionId), inArray(t.templateColumns.id, ids)));
  } else if (command.type === 'pasteSection') {
    fieldsOnly(command, ['type', 'sourceVersionId', 'sourceSectionId', 'parentColumnId']);
    const sourceVersionId = uuid(command.sourceVersionId, 'Source template version').toLowerCase();
    const sourceSectionId = uuid(command.sourceSectionId, 'Source container').toLowerCase();
    const source = await loadDefinition(client, identity.organization_id, sourceVersionId);
    if (!source.model?.sectionsById[sourceSectionId]) throw new HttpError(404, 'section_not_found', 'The copied container was not found.');
    const parent = command.parentColumnId ? ownRecord(model.columnsById, command.parentColumnId, 'Column') : null;
    if (parent?.fieldId) throw new HttpError(400, 'column_has_widget', 'Remove the widget before pasting a container here.');
    const selection = layoutSelection(source.model, 'section', sourceSectionId);
    for (const expression of source.records.expressions) {
      if (selection.expressions.has(expression.id) && expression.references.some((reference) => !selection.fields.has(reference.fieldId))) {
        throw new HttpError(400, 'external_reference', 'This container has a formula referencing a field outside it and cannot be pasted alone.');
      }
    }
    const pasted = cloneLayout(source.records, source.model, 'section', sourceSectionId, randomUUID);
    const siblings = parent ? parent.childSectionIds : model.rootSectionIds;
    const position = siblings.length ? Math.max(...siblings.map((id) => model.sectionsById[id].position)) + 1 : 0;
    const root = pasted.records.sections.find((row) => row.id === pasted.mapping.get(sourceSectionId));
    root.parentColumnId = parent?.id ?? null;
    root.position = position;
    await copyDefinition(db, pasted.records, base.organizationId, versionId);
  } else if (command.type === 'configureSection') {
    fieldsOnly(command, ['type', 'id', 'name', 'cssClass', 'visible', 'isHeader', 'isFooter', 'isFinalResult', 'isParameterLoop', 'isParameterLoopHeader', 'showInNabl', 'showInNonNabl']);
    const section = ownRecord(model.sectionsById, command.id, 'Container');
    const parameterLoop = bool(command.isParameterLoop ?? section.isParameterLoop ?? false, 'Parameter loop');
    if (model.version.kind === 'datasheet' && Boolean(section.isParameterLoop) !== parameterLoop) {
      await changeRepeatGroup(client, db, base, records, model, { kind: 'section', id: section.id, enabled: parameterLoop, source: 'test_requests' });
    }
    await db.update(t.templateSections).set({ name: text(command.name, 'Container name', 200, { optional: true }), cssClass: text(command.cssClass, 'CSS class', 1000, { optional: true }),
      visible: bool(command.visible ?? true, 'Visible'), isHeader: bool(command.isHeader ?? false, 'Header'), isFooter: bool(command.isFooter ?? false, 'Footer'), isFinalResult: bool(command.isFinalResult ?? false, 'Final result'),
      isParameterLoop: bool(command.isParameterLoop ?? section.isParameterLoop ?? false, 'Parameter loop'), isParameterLoopHeader: bool(command.isParameterLoopHeader ?? section.isParameterLoopHeader ?? false, 'Parameter loop header'),
      showInNabl: bool(command.showInNabl ?? false, 'Show in NABL'), showInNonNabl: bool(command.showInNonNabl ?? false, 'Show in Non-NABL') })
      .where(and(scope(t.templateSections, base.organizationId, versionId), eq(t.templateSections.id, section.id)));
  } else if (command.type === 'selectSampleLineAttribute') {
    fieldsOnly(command, ['type', 'fieldId', 'sourceField']);
    const field = ownRecord(model.fieldsById, command.fieldId, 'Field');
    if (field.widget !== 'sample_line_item_data_widget') throw new HttpError(400, 'invalid_context_field', 'This field is not a line-item widget.');
    await db.update(t.templateFields).set({ sourceField: sampleLineSelection(command.sourceField) })
      .where(and(scope(t.templateFields, base.organizationId, versionId), eq(t.templateFields.id, field.id)));
  } else if (command.type === 'configureColumn') {
    fieldsOnly(command, ['type', 'id', 'span', 'cssClass', 'widget', 'indexValue', 'masterValue', 'widthMm', 'heightMm', 'showInCoa', 'showInTemplate', 'isFinalResult', 'showInNabl', 'showInNonNabl', 'editRoleIds', 'viewRoleIds']);
    const column = ownRecord(model.columnsById, command.id, 'Column');
    const widthMm = command.widthMm === undefined ? column.widthMm : decimal(command.widthMm, 'Print width', { optional: true });
    const heightMm = command.heightMm === undefined ? column.heightMm : decimal(command.heightMm, 'Minimum height', { optional: true });
    if (widthMm !== null && (Number(widthMm) < 0.001 || Number(widthMm) > 1000)) throw new HttpError(400, 'invalid_layout', 'Print width must be between 0.001 and 1000 mm.');
    if (heightMm !== null && (Number(heightMm) < 0.001 || Number(heightMm) > 1000)) throw new HttpError(400, 'invalid_layout', 'Minimum height must be between 0.001 and 1000 mm.');
    const indexValue = command.indexValue === undefined ? column.indexValue : text(command.indexValue, 'Index', 3, { optional: true });
    if (!['', ...Array.from({ length: 12 }, (_, index) => String(-(index + 1)))].includes(indexValue)) throw new HttpError(400, 'invalid_layout', 'Select a supported column index.');
    await db.update(t.templateColumns).set({ span: command.span === undefined ? column.span : integer(command.span, 'Column span', 0, 12), cssClass: text(command.cssClass, 'CSS class', 1000, { optional: true }),
      indexValue, masterValue: command.masterValue === undefined ? column.masterValue : text(command.masterValue, 'Master', 200, { optional: true }), widthMm, heightMm,
      showInCoa: command.showInCoa === undefined ? column.showInCoa : bool(command.showInCoa, 'Show in CoA'),
      showInTemplate: command.showInTemplate === undefined ? column.showInTemplate : bool(command.showInTemplate, 'Show in Data Template'),
      isFinalResult: command.isFinalResult === undefined ? column.isFinalResult : bool(command.isFinalResult, 'Final result'),
      showInNabl: command.showInNabl === undefined ? column.showInNabl : bool(command.showInNabl, 'Show in NABL'),
      showInNonNabl: command.showInNonNabl === undefined ? column.showInNonNabl : bool(command.showInNonNabl, 'Show in Non-NABL') })
      .where(and(scope(t.templateColumns, base.organizationId, versionId), eq(t.templateColumns.id, command.id)));
    if (command.widget && !column.fieldId) await configureField(db, base, model, { type: 'configureField', columnId: column.id, widget: command.widget, options: [] });
    else if (command.widget && model.fieldsById[column.fieldId]?.widget !== command.widget) throw new HttpError(400, 'widget_type_change', 'Remove the current widget before changing its type.');
    if (column.fieldId && (command.editRoleIds !== undefined || command.viewRoleIds !== undefined)) {
      await setFieldRoleAccess(db, base, model, model.fieldsById[column.fieldId], command.editRoleIds, command.viewRoleIds);
    }
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
    await changeRepeatGroup(client, db, base, records, model, { kind: 'row', id: row.id, enabled: command.enabled });
  } else if (command.type === 'delete') {
    fieldsOnly(command, ['type', 'kind', 'id']); uuid(command.id);
    const selection = layoutSelection(model, command.kind, command.id);
    for (const expression of records.expressions) {
      if (!selection.expressions.has(expression.id) && expression.references.some((reference) => selection.fields.has(reference.fieldId))) {
        throw new HttpError(400, 'referenced_field', 'This item contains a field used by another formula or condition. Update that reference first.');
      }
    }
    const remove = async (table, column, ids) => {
      if (ids.size) await db.delete(table).where(and(scope(table, base.organizationId, versionId), inArray(column, [...ids])));
    };
    await remove(t.templateExpressionReferences, t.templateExpressionReferences.expressionId, selection.expressions);
    await remove(t.templateExpressions, t.templateExpressions.id, selection.expressions);
    await remove(t.templateOptions, t.templateOptions.fieldId, selection.fields);
    await remove(t.templateNumericConfig, t.templateNumericConfig.fieldId, selection.fields);
    await remove(t.templateImageConfig, t.templateImageConfig.fieldId, selection.fields);
    await remove(t.templateFieldRoleAccess, t.templateFieldRoleAccess.fieldId, selection.fields);
    await remove(t.templateFields, t.templateFields.id, selection.fields);
    await remove(t.templateRepeatGroups, t.templateRepeatGroups.id, selection.groups);
    await remove(t.templateColumns, t.templateColumns.id, selection.columns);
    await remove(t.templateRows, t.templateRows.id, selection.rows);
    await remove(t.templateSections, t.templateSections.id, selection.sections);
  } else if (command.type === 'editDetails') {
    return { model };
  } else if (command.type === 'grantAllRoleAccess') {
    fieldsOnly(command, ['type']);
    const roles = (await db.select({ id: rolesTable.id }).from(rolesTable).where(and(eq(rolesTable.organizationId, base.organizationId), eq(rolesTable.active, true)))).map((row) => row.id);
    await db.delete(t.templateFieldRoleAccess).where(scope(t.templateFieldRoleAccess, base.organizationId, versionId));
    const fieldIds = Object.keys(model.fieldsById);
    await insertBatch(db, t.templateFieldRoleAccess, fieldIds.flatMap((fieldId) => roles.flatMap((roleId) => [
      { ...base, fieldId, roleId, access: 'edit' }, { ...base, fieldId, roleId, access: 'view' },
    ])));
  } else if (command.type === 'sanitizeFieldKeys') {
    fieldsOnly(command, ['type']);
    const used = new Set(Object.values(model.fieldsById).map((field) => field.alias).filter(Boolean));
    for (const field of Object.values(model.fieldsById)) {
      if (!field.alias || /^[A-Za-z0-9_]+$/.test(field.alias)) continue;
      const stripped = field.alias.replace(/[^A-Za-z0-9_]/g, '_');
      used.delete(field.alias);
      let candidate = stripped || 'field'; let suffix = 1;
      while (used.has(candidate)) { candidate = `${stripped || 'field'}_${suffix}`; suffix += 1; }
      used.add(candidate);
      await db.update(t.templateFields).set({ alias: candidate }).where(and(scope(t.templateFields, base.organizationId, versionId), eq(t.templateFields.id, field.id)));
    }
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
  await insertBatch(db, t.templateFields, records.fields.map(({ numeric: _numeric, image: _image, editRoleIds: _editRoleIds, viewRoleIds: _viewRoleIds, ...row }) => ({ ...row, ...base })));
  await insertBatch(db, t.templateNumericConfig, records.fields.filter((row) => row.numeric).map((row) => ({ ...row.numeric, valueType: row.valueType, ...base })));
  await insertBatch(db, t.templateImageConfig, records.fields.filter((row) => row.image).map((row) => ({ ...row.image, ...base })));
  await insertBatch(db, t.templateOptions, records.options.map((row) => ({ ...row, ...base })));
  await insertBatch(db, t.templateFieldRoleAccess, records.fields.flatMap((field) => [
    ...(field.editRoleIds ?? []).map((roleId) => ({ fieldId: field.id, roleId, access: 'edit', ...base })),
    ...(field.viewRoleIds ?? []).map((roleId) => ({ fieldId: field.id, roleId, access: 'view', ...base })),
  ]));
  await insertBatch(db, t.templateExpressions, records.expressions.map(({ references: _references, ...row }) => ({ ...row, ...base })));
  await insertBatch(db, t.templateExpressionReferences, records.expressions.flatMap((row) => expressionRecords(base, row.id, row.references)));
}

export async function createDraft(client, identity, sourceVersionId) {
  requirePermission(identity, 'templates.manage'); uuid(sourceVersionId);
  const { records } = await loadDefinition(client, identity.organization_id, sourceVersionId, { forFreeze: true });
  if (records.version.status !== 'frozen') throw new HttpError(400, 'invalid_source_version', 'Create a new draft from a frozen version.');
  await client.query('SELECT id FROM templates WHERE organization_id = $1 AND id = $2 FOR UPDATE', [identity.organization_id, records.version.templateId]);
  const existing = await client.query("SELECT max(number) AS number, bool_or(status = 'draft') AS has_draft FROM template_versions WHERE organization_id = $1 AND template_id = $2", [identity.organization_id, records.version.templateId]);
  if (existing.rows[0].has_draft) throw new HttpError(409, 'draft_exists', 'This template already has an editable draft.');
  const versionId = randomUUID();
  const db = database(client);
  await db.insert(t.templateVersions).values({ organizationId: identity.organization_id, id: versionId, templateId: records.version.templateId, number: existing.rows[0].number + 1,
    name: records.version.name, description: records.version.description, kind: records.version.kind, templateType: records.version.templateType, sourceVersionId, createdBy: identity.user_id,
    headerDocumentId: records.version.headerDocumentId, footerDocumentId: records.version.footerDocumentId,
    nablHeaderDocumentId: records.version.nablHeaderDocumentId, nablFooterDocumentId: records.version.nablFooterDocumentId });
  await copyDefinition(db, records, identity.organization_id, versionId);
  return { templateId: records.version.templateId, versionId, revision: 1 };
}

export async function cloneTemplate(client, identity, sourceVersionId) {
  requirePermission(identity, 'templates.manage'); uuid(sourceVersionId, 'Template version');
  const { records } = await loadDefinition(client, identity.organization_id, sourceVersionId);
  const templateId = randomUUID();
  const versionId = randomUUID();
  const db = database(client);
  await db.insert(t.templates).values({ organizationId: identity.organization_id, id: templateId, code: randomUUID(), createdBy: identity.user_id });
  await db.insert(t.templateVersions).values({ organizationId: identity.organization_id, id: versionId, templateId, number: 1,
    name: `${records.version.name} - Copy`, description: records.version.description, kind: records.version.kind, templateType: records.version.templateType,
    headerDocumentId: records.version.headerDocumentId, footerDocumentId: records.version.footerDocumentId,
    nablHeaderDocumentId: records.version.nablHeaderDocumentId, nablFooterDocumentId: records.version.nablFooterDocumentId, createdBy: identity.user_id });
  await copyDefinition(db, cloneVersionLayout(records, randomUUID), identity.organization_id, versionId);
  return { templateId, versionId, revision: 1 };
}

export async function templateFieldRoleOptions(client, identity) {
  requirePermission(identity, 'templates.manage');
  return (await client.query('SELECT id, name FROM roles WHERE organization_id = $1 AND active ORDER BY name LIMIT 500', [identity.organization_id])).rows;
}

export { assembleDefinition };
