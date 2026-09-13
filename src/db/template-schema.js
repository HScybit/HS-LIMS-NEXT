import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, integer, numeric, doublePrecision, date, primaryKey, unique, uniqueIndex, index, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { reportDocuments } from './report-assets-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const transactionId = customType({ dataType: () => 'xid8' });
const tenant = () => uuid('organization_id').notNull();
const logicalId = () => uuid('id').notNull().defaultRandom();
const version = () => uuid('version_id').notNull();
const versionKey = (table) => primaryKey({ columns: [table.organizationId, table.versionId, table.id] });
const versionLink = (table) => foreignKey({ columns: [table.organizationId, table.versionId], foreignColumns: [templateVersions.organizationId, templateVersions.id] });
const logicalLink = (table, column, target, name) => foreignKey({ name, columns: [table.organizationId, table.versionId, column], foreignColumns: [target.organizationId, target.versionId, target.id] });

const bytes = customType({ dataType: () => 'bytea' });
export const templateImageAssets = pgTable('template_image_assets', {
  organizationId: tenant().references(() => organizations.id), id: uuid('id').notNull(),
  originalName: text('original_name').notNull(), mediaType: text('media_type').notNull(), content: bytes('content').notNull(),
  byteLength: integer('byte_length').notNull(), sha256: text('sha256').notNull(), width: integer('width').notNull(), height: integer('height').notNull(),
  frameCount: integer('frame_count').notNull(), printContent: bytes('print_content').notNull(), printByteLength: integer('print_byte_length').notNull(), printSha256: text('print_sha256').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(), uploadedAt: time('uploaded_at').notNull().defaultNow(),
}, (t) => [primaryKey({ name: 'template_image_asset_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'template_image_asset_actor_fk', columns: [t.organizationId, t.uploadedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('template_image_asset_shape', sql`${t.mediaType} in ('image/png','image/jpeg','image/gif','image/webp') and length(trim(${t.originalName})) between 1 and 255
    and ${t.sha256} ~ '^[a-f0-9]{64}$' and ${t.printSha256} ~ '^[a-f0-9]{64}$'
    and ${t.byteLength} between 1 and 10485760 and ${t.byteLength}=octet_length(${t.content})
    and ${t.printByteLength} between 1 and 10485760 and ${t.printByteLength}=octet_length(${t.printContent})
    and ${t.width} between 1 and 10000 and ${t.height} between 1 and 10000 and ${t.frameCount} between 1 and 200
    and ${t.width}::bigint*${t.height}::bigint*${t.frameCount}::bigint<=40000000`),
]);

export const templates = pgTable('templates', {
  organizationId: tenant().references(() => organizations.id), id: logicalId(),
  code: text('code').notNull(), active: boolean('active').notNull().default(true),
  createdAt: time('created_at').notNull().defaultNow(), createdBy: uuid('created_by').notNull(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  uniqueIndex('templates_code_key').on(t.organizationId, sql`lower(${t.code})`),
  check('templates_code_length', sql`length(trim(${t.code})) between 1 and 200`),
  foreignKey({ columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
]);

export const templateVersions = pgTable('template_versions', {
  organizationId: tenant(), id: logicalId(), templateId: uuid('template_id').notNull(),
  number: integer('number').notNull(), revision: integer('revision').notNull().default(1),
  status: text('status').notNull().default('draft'), name: text('name').notNull(), description: text('description').notNull().default(''),
  kind: text('kind').notNull(), templateType: text('template_type'), semantics: text('semantics').notNull().default('meteor-number-v1'),
  sourceVersionId: uuid('source_version_id'), createdAt: time('created_at').notNull().defaultNow(), createdBy: uuid('created_by').notNull(),
  snapshotSourceId: uuid('snapshot_source_id'), snapshotSourceRevision: integer('snapshot_source_revision'),
  frozenAt: time('frozen_at'), frozenBy: uuid('frozen_by'),
  headerDocumentId: uuid('header_document_id'), footerDocumentId: uuid('footer_document_id'),
  nablHeaderDocumentId: uuid('nabl_header_document_id'), nablFooterDocumentId: uuid('nabl_footer_document_id'),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  unique('template_version_number_key').on(t.organizationId, t.templateId, t.number),
  uniqueIndex('template_one_draft_key').on(t.organizationId, t.templateId).where(sql`${t.status} = 'draft'`),
  foreignKey({ columns: [t.organizationId, t.templateId], foreignColumns: [templates.organizationId, templates.id] }),
  foreignKey({ columns: [t.organizationId, t.sourceVersionId], foreignColumns: [t.organizationId, t.id] }),
  foreignKey({ columns: [t.organizationId, t.snapshotSourceId], foreignColumns: [t.organizationId, t.id] }),
  uniqueIndex('template_runtime_snapshot_key').on(t.organizationId, t.snapshotSourceId, t.snapshotSourceRevision).where(sql`${t.snapshotSourceId} is not null`),
  foreignKey({ columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ columns: [t.organizationId, t.frozenBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  ...[t.headerDocumentId, t.footerDocumentId, t.nablHeaderDocumentId, t.nablFooterDocumentId].map((column) => foreignKey({ columns: [t.organizationId, column], foreignColumns: [reportDocuments.organizationId, reportDocuments.id] })),
  check('template_version_state', sql`(${t.status} in ('draft', 'building') and ${t.frozenAt} is null and ${t.frozenBy} is null) or (${t.status} = 'frozen' and ${t.frozenAt} is not null and ${t.frozenBy} is not null)`),
  check('template_snapshot_source', sql`(${t.snapshotSourceId} is null and ${t.snapshotSourceRevision} is null and ${t.status} <> 'building') or (${t.snapshotSourceId} is not null and ${t.snapshotSourceRevision} is not null and ${t.snapshotSourceRevision} > 0 and ${t.snapshotSourceId} <> ${t.id} and ${t.status} in ('building', 'frozen'))`),
  check('template_version_metadata', sql`${t.number} > 0 and ${t.revision} > 0 and length(trim(${t.name})) between 1 and 200 and length(${t.description}) <= 10000 and ${t.kind} in ('sample', 'datasheet', 'report', 'label', 'equipment_service_log') and ${t.semantics} = 'meteor-number-v1'`),
  check('template_source_type', sql`${t.templateType} is null or (${t.templateType} = 'sample_coa' and ${t.kind} = 'report') or (${t.templateType} in ('job_template', 'test_request') and ${t.kind} = 'datasheet')`),
]);

export const templateSections = pgTable('template_sections', {
  organizationId: tenant(), versionId: version(), id: logicalId(), parentColumnId: uuid('parent_column_id'),
  position: integer('position').notNull(), name: text('name').notNull().default(''), cssClass: text('css_class').notNull().default(''),
  x: numeric('x').notNull().default('100'), y: numeric('y').notNull().default('100'),
  width: numeric('width').notNull().default('100'), height: numeric('height').notNull().default('100'),
  visible: boolean('visible').notNull().default(true), isHeader: boolean('is_header').notNull().default(false),
  isFooter: boolean('is_footer').notNull().default(false), isFinalResult: boolean('is_final_result').notNull().default(false),
  isParameterLoop: boolean('is_parameter_loop').notNull().default(false), isParameterLoopHeader: boolean('is_parameter_loop_header').notNull().default(false),
  sourceVersionId: uuid('source_version_id'), sourceSectionId: uuid('source_section_id'),
}, (t) => [
  versionKey(t), versionLink(t), logicalLink(t, t.parentColumnId, templateColumns, 'section_parent_column_fk'),
  foreignKey({ columns: [t.organizationId, t.sourceVersionId, t.sourceSectionId], foreignColumns: [t.organizationId, t.versionId, t.id] }),
  index('template_sections_order').on(t.organizationId, t.versionId, t.parentColumnId, t.position),
  check('template_section_layout', sql`${t.position} >= 0 and ${t.width} > 0 and ${t.height} > 0 and abs(${t.x}) <= 100000 and abs(${t.y}) <= 100000 and ${t.width} <= 100000 and ${t.height} <= 100000`),
  check('template_section_provenance', sql`(${t.sourceVersionId} is null) = (${t.sourceSectionId} is null)`),
]);

export const templateRows = pgTable('template_rows', {
  organizationId: tenant(), versionId: version(), id: logicalId(), sectionId: uuid('section_id').notNull(),
  position: integer('position').notNull(), cssClass: text('css_class').notNull().default(''),
}, (t) => [versionKey(t), versionLink(t), logicalLink(t, t.sectionId, templateSections),
  index('template_rows_order').on(t.organizationId, t.versionId, t.sectionId, t.position), check('template_row_position', sql`${t.position} >= 0`)]);

export const templateColumns = pgTable('template_columns', {
  organizationId: tenant(), versionId: version(), id: logicalId(), rowId: uuid('row_id').notNull(),
  position: integer('position').notNull(), span: integer('span').notNull().default(0), cssClass: text('css_class').notNull().default(''),
  isFinalResult: boolean('is_final_result').notNull().default(false),
}, (t) => [versionKey(t), versionLink(t), logicalLink(t, t.rowId, templateRows),
  index('template_columns_order').on(t.organizationId, t.versionId, t.rowId, t.position),
  check('template_column_layout', sql`${t.position} >= 0 and ${t.span} between 0 and 12`)]);

// Source manual row repeats and section loops share an explicit ancestry, never array-position identity.
export const templateRepeatGroups = pgTable('template_repeat_groups', {
  organizationId: tenant(), versionId: version(), id: logicalId(), parentGroupId: uuid('parent_group_id'),
  sectionId: uuid('section_id'), rowId: uuid('row_id'), source: text('source').notNull().default('manual'),
  minimum: integer('minimum').notNull().default(1), maximum: integer('maximum').notNull().default(1000),
}, (t) => [versionKey(t), versionLink(t), logicalLink(t, t.sectionId, templateSections), logicalLink(t, t.rowId, templateRows), logicalLink(t, t.parentGroupId, t),
  unique('repeat_section_key').on(t.organizationId, t.versionId, t.sectionId), unique('repeat_row_key').on(t.organizationId, t.versionId, t.rowId),
  check('repeat_definition_shape', sql`num_nonnulls(${t.sectionId}, ${t.rowId}) = 1 and (${t.source} = 'manual' or (${t.source} = 'test_requests' and ${t.sectionId} is not null)) and ${t.minimum} between 0 and 1000 and ${t.maximum} between greatest(1, ${t.minimum}) and 1000 and ${t.parentGroupId} is distinct from ${t.id}`)]);

export const templateFields = pgTable('template_fields', {
  organizationId: tenant(), versionId: version(), id: logicalId(), columnId: uuid('column_id').notNull(), repeatGroupId: uuid('repeat_group_id'),
  widget: text('widget').notNull(), valueType: text('value_type').notNull(), alias: text('alias').notNull().default(''),
  label: text('label').notNull().default(''), placeholder: text('placeholder').notNull().default(''), required: boolean('required').notNull().default(false),
  editable: boolean('editable').notNull().default(false), defaultState: text('default_state').notNull().default('absent'),
  sourceField: text('source_field'), serialPadding: integer('serial_padding'),
  defaultText: text('default_text'), defaultNumber: numeric('default_number'), defaultBoolean: boolean('default_boolean'), defaultDate: date('default_date', { mode: 'string' }), defaultLexical: text('default_lexical'),
  defaultImageId: uuid('default_image_id'),
}, (t) => [versionKey(t), versionLink(t), logicalLink(t, t.columnId, templateColumns), logicalLink(t, t.repeatGroupId, templateRepeatGroups),
  unique('template_column_field_key').on(t.organizationId, t.versionId, t.columnId),
  unique('template_field_type_key').on(t.organizationId, t.versionId, t.id, t.valueType),
  foreignKey({ name: 'template_field_default_image_fk', columns: [t.organizationId, t.defaultImageId], foreignColumns: [templateImageAssets.organizationId, templateImageAssets.id] }),
  index('template_fields_alias').on(t.organizationId, t.versionId, t.alias),
  check('template_field_alias', sql`${t.alias} ~ '^[A-Za-z0-9_]*$' and length(${t.alias}) <= 200`),
  check('template_default_lexical', sql`${t.defaultLexical} is null or (${t.widget} = 'result_widget' and ${t.defaultState} = 'present' and ${t.defaultNumber} is not null and length(${t.defaultLexical}) between 1 and 1000
    and case when ${t.defaultLexical} ~ '^-?[0-9]+([.][0-9]+)?$' then ${t.defaultNumber} = ${t.defaultLexical}::numeric else false end)`),
  check('template_widget_type', sql`(${t.widget} in ('text_widget', 'input_widget', 'paragraph_widget', 'sample_details_widget_v2', 'product_detail_widget', 'tr_data_widget', 'decision_rule_widget', 'tr_result_widget', 'sno_widget') and ${t.valueType} = 'text') or (${t.widget} in ('number_widget', 'formula_widget') and ${t.valueType} = 'numeric') or (${t.widget} = 'result_widget' and ${t.valueType} in ('numeric', 'result')) or (${t.widget} = 'checkbox_widget' and ${t.valueType} = 'boolean') or (${t.widget} = 'datepicker_widget' and ${t.valueType} = 'date') or (${t.widget} = 'dropdown_widget' and ${t.valueType} = 'option') or (${t.widget} = 'template_image_widget' and ${t.valueType} = 'image')`),
  check('template_image_readonly', sql`${t.widget}<>'template_image_widget' or not ${t.editable}`),
  check('template_field_context', sql`(${t.sourceField} is null or
    (${t.widget} = 'sample_details_widget_v2' and ${t.sourceField} in ('sampleNumber', 'customerName', 'customerAddress', 'sampleCategoryName', 'productName', 'receivedAt', 'registeredAt', 'dueAt', 'description', 'customerReference')) or
    (${t.widget} = 'tr_data_widget' and ${t.sourceField} in ('requestNumber', 'parameterName', 'productName', 'methodName', 'analystName', 'submittedAt', 'completedAt')) or
    (${t.widget} = 'decision_rule_widget' and ${t.sourceField} in ('specification', 'measurementUnit', 'parameterName', 'productName', 'methodName', 'decisionOutcome')))
    and (${t.serialPadding} is null or (${t.widget} = 'sno_widget' and ${t.serialPadding} between 0 and 100))
    and (${t.widget} not in ('sample_details_widget_v2', 'product_detail_widget', 'tr_data_widget', 'decision_rule_widget', 'tr_result_widget', 'sno_widget') or not ${t.editable})`),
  check('template_field_default', sql`(${t.defaultState} in ('absent', 'empty') and num_nonnulls(${t.defaultText}, ${t.defaultNumber}, ${t.defaultBoolean}, ${t.defaultDate}, ${t.defaultImageId}) = 0) or (${t.defaultState} = 'present' and num_nonnulls(${t.defaultText}, ${t.defaultNumber}, ${t.defaultBoolean}, ${t.defaultDate}, ${t.defaultImageId}) = 1 and ((${t.valueType} in ('text', 'result') and ${t.defaultText} is not null) or (${t.valueType} in ('numeric', 'result') and ${t.defaultNumber} is not null and ${t.defaultNumber}::text not in ('NaN', 'Infinity', '-Infinity')) or (${t.valueType} = 'boolean' and ${t.defaultBoolean} is not null) or (${t.valueType} = 'date' and ${t.defaultDate} is not null) or (${t.valueType} = 'image' and ${t.defaultImageId} is not null)))`),
]);

export const templateImageConfig = pgTable('template_image_config', {
  organizationId: tenant(), versionId: version(), fieldId: uuid('field_id').notNull(), valueType: text('value_type').notNull().default('image'),
  widthPercent: doublePrecision('width_percent').notNull().default(100), marginTop: doublePrecision('margin_top').notNull().default(0),
  marginBottom: doublePrecision('margin_bottom').notNull().default(0), marginLeft: doublePrecision('margin_left').notNull().default(0), marginRight: doublePrecision('margin_right').notNull().default(0),
  alignment: text('alignment').notNull().default('start'),
}, (t) => [primaryKey({ name: 'template_image_config_pk', columns: [t.organizationId, t.versionId, t.fieldId] }), versionLink(t),
  foreignKey({ name: 'template_image_config_field_fk', columns: [t.organizationId, t.versionId, t.fieldId, t.valueType], foreignColumns: [templateFields.organizationId, templateFields.versionId, templateFields.id, templateFields.valueType] }),
  check('template_image_config_type', sql`${t.valueType}='image' and ${t.alignment} in ('start','center','end')`),
  ...[t.widthPercent, t.marginTop, t.marginBottom, t.marginLeft, t.marginRight].map((column) => check(`template_image_${column.name}_finite`, sql`${column} not in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)`)),
]);

export const templateNumericConfig = pgTable('template_numeric_config', {
  organizationId: tenant(), versionId: version(), fieldId: uuid('field_id').notNull(), valueType: text('value_type').notNull().default('numeric'),
  displayScale: integer('display_scale'), padDecimals: boolean('pad_decimals').notNull().default(false), minimum: numeric('minimum'), maximum: numeric('maximum'),
}, (t) => [primaryKey({ columns: [t.organizationId, t.versionId, t.fieldId] }), versionLink(t),
  foreignKey({ columns: [t.organizationId, t.versionId, t.fieldId, t.valueType], foreignColumns: [templateFields.organizationId, templateFields.versionId, templateFields.id, templateFields.valueType] }),
  check('numeric_config_type', sql`${t.valueType} in ('numeric', 'result') and (${t.displayScale} is null or ${t.displayScale} between 0 and 100) and (${t.minimum} is null or ${t.maximum} is null or ${t.minimum} <= ${t.maximum}) and coalesce(${t.minimum}::text, '') not in ('NaN', 'Infinity', '-Infinity') and coalesce(${t.maximum}::text, '') not in ('NaN', 'Infinity', '-Infinity')`)]);

export const templateOptions = pgTable('template_options', {
  organizationId: tenant(), versionId: version(), fieldId: uuid('field_id').notNull(), id: logicalId(),
  valueType: text('value_type').notNull().default('option'), position: integer('position').notNull(), label: text('label').notNull(), value: text('value').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.versionId, t.fieldId, t.id] }), versionLink(t),
  foreignKey({ columns: [t.organizationId, t.versionId, t.fieldId, t.valueType], foreignColumns: [templateFields.organizationId, templateFields.versionId, templateFields.id, templateFields.valueType] }),
  unique('template_option_order_key').on(t.organizationId, t.versionId, t.fieldId, t.position),
  unique('template_option_value_key').on(t.organizationId, t.versionId, t.fieldId, t.value),
  check('template_option_type', sql`${t.valueType} = 'option' and ${t.position} >= 0`)]);

export const templateExpressions = pgTable('template_expressions', {
  organizationId: tenant(), versionId: version(), id: logicalId(), fieldId: uuid('field_id').notNull(), purpose: text('purpose').notNull(),
}, (t) => [versionKey(t), versionLink(t), logicalLink(t, t.fieldId, templateFields),
  unique('template_expression_purpose_key').on(t.organizationId, t.versionId, t.fieldId, t.purpose),
  check('template_expression_purpose', sql`${t.purpose} in ('calculate', 'visible', 'required')`)]);

export const templateExpressionNodes = pgTable('template_expression_nodes', {
  organizationId: tenant(), versionId: version(), expressionId: uuid('expression_id').notNull(),
  nodeIndex: integer('node_index').notNull(), parentIndex: integer('parent_index'), operandOrder: integer('operand_order').notNull(), kind: text('kind').notNull(),
  numberLiteral: text('number_literal'), textLiteral: text('text_literal'), booleanLiteral: boolean('boolean_literal'),
  referenceFieldId: uuid('reference_field_id'), referenceScope: text('reference_scope'), operator: text('operator'), functionName: text('function_name'),
}, (t) => [primaryKey({ columns: [t.organizationId, t.versionId, t.expressionId, t.nodeIndex] }), versionLink(t),
  logicalLink(t, t.expressionId, templateExpressions, 'expression_nodes_expression_fk'), logicalLink(t, t.referenceFieldId, templateFields, 'expression_nodes_reference_fk'),
  foreignKey({ name: 'expression_nodes_parent_fk', columns: [t.organizationId, t.versionId, t.expressionId, t.parentIndex], foreignColumns: [t.organizationId, t.versionId, t.expressionId, t.nodeIndex] }),
  index('expression_dependencies').on(t.organizationId, t.versionId, t.referenceFieldId),
  check('expression_node_bounds', sql`${t.nodeIndex} between 0 and 999 and ${t.operandOrder} between 0 and 999 and (${t.parentIndex} is null or (${t.parentIndex} between 0 and 999 and ${t.parentIndex} <> ${t.nodeIndex}))`),
  check('expression_node_payload', sql`(
    (${t.kind} = 'number' and ${t.numberLiteral} is not null and ${t.numberLiteral} ~ '^(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?$') or
    (${t.kind} = 'text' and ${t.textLiteral} is not null) or (${t.kind} = 'boolean' and ${t.booleanLiteral} is not null) or
    (${t.kind} = 'field' and ${t.referenceFieldId} is not null and ${t.referenceScope} in ('current', 'ancestor', 'descendants')) or
    (${t.kind} = 'unary' and ${t.operator} in ('+', '-', '%')) or
    (${t.kind} = 'binary' and ${t.operator} in ('+', '-', '*', '/', '^', '=', '<>', '<', '>', '<=', '>=')) or
    (${t.kind} = 'call' and ${t.functionName} in ('ABS', 'MIN', 'MAX', 'ROUND', 'SUM', 'AVERAGE', 'IF'))
  ) and num_nonnulls(${t.numberLiteral}, ${t.textLiteral}, ${t.booleanLiteral}, ${t.referenceFieldId}, ${t.operator}, ${t.functionName}) = 1 and (${t.kind} = 'field' or ${t.referenceScope} is null)`),
]);

// Technical capture versioning only; a datasheet owns its runtime through an explicit domain FK.
export const templateInstances = pgTable('template_instances', {
  organizationId: tenant(), id: logicalId(), versionId: version(), revision: integer('revision').notNull().default(1),
  status: text('status').notNull().default('editing'), createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }), versionLink(t),
  unique('template_instance_version_key').on(t.organizationId, t.id, t.versionId),
  foreignKey({ columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('template_instance_state', sql`${t.revision} > 0 and ${t.status} in ('editing', 'frozen')`)]);

// Recorded by the database when a capture revision is created. Earlier captures
// retain their existing evidence; no historical actors or transactions are inferred.
export const templateCaptureRevisions = pgTable('template_capture_revisions', {
  organizationId: tenant(), instanceId: uuid('instance_id').notNull(), revision: integer('revision').notNull(),
  status: text('status').notNull(), transactionId: transactionId('transaction_id').notNull(),
  recordedBy: uuid('recorded_by'), databaseRole: text('database_role').notNull(), recordedAt: time('recorded_at').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.instanceId, t.revision] }),
  foreignKey({ columns: [t.organizationId, t.instanceId], foreignColumns: [templateInstances.organizationId, templateInstances.id] }),
  foreignKey({ columns: [t.organizationId, t.recordedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('capture_revision_state', sql`${t.revision}>0 and ${t.status} in ('editing','frozen')`),
  check('capture_revision_actor', sql`length(${t.databaseRole})>0 and (${t.databaseRole}<>'sampleify_app' or ${t.recordedBy} is not null)`),
]);

export const templateOccurrences = pgTable('template_occurrences', {
  organizationId: tenant(), instanceId: uuid('instance_id').notNull(), versionId: version(), id: logicalId(),
  groupId: uuid('group_id'), parentId: uuid('parent_id'), position: numeric('position').notNull(),
  createdRevision: integer('created_revision').notNull(), removedRevision: integer('removed_revision'),
}, (t) => [primaryKey({ columns: [t.organizationId, t.instanceId, t.versionId, t.id] }),
  foreignKey({ columns: [t.organizationId, t.instanceId, t.versionId], foreignColumns: [templateInstances.organizationId, templateInstances.id, templateInstances.versionId] }),
  logicalLink(t, t.groupId, templateRepeatGroups),
  foreignKey({ name: 'template_occurrence_parent_fk', columns: [t.organizationId, t.instanceId, t.versionId, t.parentId], foreignColumns: [t.organizationId, t.instanceId, t.versionId, t.id] }),
  uniqueIndex('template_root_occurrence_key').on(t.organizationId, t.instanceId).where(sql`${t.groupId} is null`),
  index('template_occurrences_order').on(t.organizationId, t.instanceId, t.parentId, t.groupId, t.position),
  check('template_occurrence_shape', sql`(${t.groupId} is null and ${t.parentId} is null and ${t.position} = 0 and ${t.removedRevision} is null) or (${t.groupId} is not null and ${t.parentId} is not null and ${t.parentId} <> ${t.id} and ${t.position} >= 0)`),
  check('template_occurrence_revision', sql`${t.createdRevision} > 0 and (${t.removedRevision} is null or ${t.removedRevision} > ${t.createdRevision})`),
  check('template_occurrence_position_finite', sql`${t.position} not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`)]);

// Append-only typed history is authoritative. The latest saved revision is the current value.
export const templateValues = pgTable('template_values', {
  organizationId: tenant(), instanceId: uuid('instance_id').notNull(), versionId: version(), fieldId: uuid('field_id').notNull(), occurrenceId: uuid('occurrence_id').notNull(),
  revision: integer('revision').notNull(), valueType: text('value_type').notNull(), state: text('state').notNull(), origin: text('origin').notNull(),
  numberValue: numeric('number_value'), textValue: text('text_value'), booleanValue: boolean('boolean_value'), dateValue: date('date_value', { mode: 'string' }), optionId: uuid('option_id'),
  imageId: uuid('image_id'),
  lexical: text('lexical'), errorCode: text('error_code'), errorMessage: text('error_message'),
  savedBy: uuid('saved_by').notNull(), savedAt: time('saved_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.instanceId, t.fieldId, t.occurrenceId, t.revision] }),
  foreignKey({ columns: [t.organizationId, t.instanceId, t.versionId], foreignColumns: [templateInstances.organizationId, templateInstances.id, templateInstances.versionId] }),
  foreignKey({ name: 'template_value_field_type_fk', columns: [t.organizationId, t.versionId, t.fieldId, t.valueType], foreignColumns: [templateFields.organizationId, templateFields.versionId, templateFields.id, templateFields.valueType] }),
  foreignKey({ name: 'template_value_occurrence_fk', columns: [t.organizationId, t.instanceId, t.versionId, t.occurrenceId], foreignColumns: [templateOccurrences.organizationId, templateOccurrences.instanceId, templateOccurrences.versionId, templateOccurrences.id] }),
  foreignKey({ name: 'template_value_option_fk', columns: [t.organizationId, t.versionId, t.fieldId, t.optionId], foreignColumns: [templateOptions.organizationId, templateOptions.versionId, templateOptions.fieldId, templateOptions.id] }),
  foreignKey({ columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'template_value_image_fk', columns: [t.organizationId, t.imageId], foreignColumns: [templateImageAssets.organizationId, templateImageAssets.id] }),
  index('template_value_latest').on(t.organizationId, t.instanceId, t.fieldId, t.occurrenceId, t.revision.desc()),
  check('template_value_revision', sql`${t.revision} > 0 and ${t.origin} in ('entered', 'calculated', 'default')`),
  check('template_value_payload', sql`(
    (${t.state} in ('absent', 'empty', 'not_applicable', 'invalid') and num_nonnulls(${t.numberValue}, ${t.textValue}, ${t.booleanValue}, ${t.dateValue}, ${t.optionId}, ${t.imageId}) = 0) or
    (${t.state} = 'present' and num_nonnulls(${t.numberValue}, ${t.textValue}, ${t.booleanValue}, ${t.dateValue}, ${t.optionId}, ${t.imageId}) = 1 and (
      (${t.valueType} in ('numeric', 'result') and ${t.numberValue} is not null and ${t.numberValue}::text not in ('NaN', 'Infinity', '-Infinity')) or
      (${t.valueType} in ('text', 'result') and ${t.textValue} is not null) or (${t.valueType} = 'boolean' and ${t.booleanValue} is not null) or
      (${t.valueType} = 'date' and ${t.dateValue} is not null) or (${t.valueType} = 'option' and ${t.optionId} is not null) or (${t.valueType} = 'image' and ${t.imageId} is not null)
    ))) and ((${t.state} = 'invalid' and ${t.errorCode} is not null and ${t.errorMessage} is not null) or (${t.state} <> 'invalid' and ${t.errorCode} is null and ${t.errorMessage} is null))`),
]);
