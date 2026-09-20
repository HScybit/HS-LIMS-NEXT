import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, doublePrecision, date, timestamp, index, primaryKey, unique, uniqueIndex, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { testParameters, laboratories, measurementUnits, methodsOfAnalysis } from './master-schema.js';
import { customFieldVersions, customFieldVersionOptions, customFieldAttachments } from './custom-field-schema.js';
import { customFieldLookupLines } from './custom-field-lookup-schema.js';
import { customFieldTypes } from '../masters/custom-field-config.js';

const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), parameterId: uuid('parameter_id').notNull(), revision: integer('revision').notNull() });
const versionColumns = (table) => [table.organizationId, table.parameterId, table.revision];
const versionLink = (table, name) => foreignKey({ name, columns: versionColumns(table), foreignColumns: versionColumns(testParameterVersions) });

// Existing master rows may predate this history. Only actual subsequent writes
// create versions; neither missing revisions nor past actors are fabricated.
export const testParameterVersions = pgTable('test_parameter_versions', {
  ...scope(), requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  code: text('code').notNull(), name: text('name').notNull(), description: text('description').notNull(), masterKey: text('master_key').notNull(),
  schemeAbbreviation: text('scheme_abbreviation').notNull(), displayOrder: integer('display_order').notNull(), active: boolean('active').notNull(),
  laboratoryId: uuid('laboratory_id'), laboratoryName: text('laboratory_name'), measurementUnitId: uuid('measurement_unit_id'), defaultScale: integer('default_scale').notNull(),
  customFieldCount: integer('custom_field_count').notNull().default(0), customFieldsProvided: boolean('custom_fields_provided').notNull().default(false),
  hasUncertainty: boolean('has_uncertainty').notNull(), savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (table) => [
  check('parameter_version_custom_fields', sql`${table.customFieldCount} between 0 and 500 and (${table.operation}<>'retire' or not ${table.customFieldsProvided})`),
  check('parameter_version_laboratory_label', sql`${table.laboratoryId} is not null or ${table.laboratoryName} is null`),
  primaryKey({ name: 'test_parameter_version_pk', columns: versionColumns(table) }),
  unique('test_parameter_save_request_key').on(table.organizationId, table.requestId),
  foreignKey({ name: 'test_parameter_version_parent_fk', columns: [table.organizationId, table.parameterId], foreignColumns: [testParameters.organizationId, testParameters.id] }),
  foreignKey({ name: 'test_parameter_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'test_parameter_version_lab_fk', columns: [table.organizationId, table.laboratoryId], foreignColumns: [laboratories.organizationId, laboratories.id] }),
  foreignKey({ name: 'test_parameter_version_unit_fk', columns: [table.organizationId, table.measurementUnitId], foreignColumns: [measurementUnits.organizationId, measurementUnits.id] }),
  check('test_parameter_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1)
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>0 and ${table.revision}=${table.previousRevision}+1)`),
  check('test_parameter_version_fields', sql`length(trim(${table.name})) between 1 and 250
    and (${table.operation}='retire' or (length(trim(${table.name}))<=200 and length(${table.description})<=16000))
    and length(trim(${table.code})) between 1 and 64 and length(trim(${table.masterKey})) between 1 and 64
    and length(trim(${table.schemeAbbreviation})) between 1 and 64 and ${table.displayOrder}>=0 and ${table.defaultScale} between 0 and 12
    and (${table.operation}<>'retire' or not ${table.active})`),
]);

export const testParameterVersionMethods = pgTable('test_parameter_version_methods', {
  ...scope(), methodId: uuid('method_id').notNull(), isDefault: boolean('is_default').notNull(),
  methodRevision: integer('method_revision'), methodName: text('method_name'),
}, (table) => [
  primaryKey({ name: 'test_parameter_version_method_pk', columns: [...versionColumns(table), table.methodId] }),
  uniqueIndex('test_parameter_version_default_method').on(...versionColumns(table)).where(sql`${table.isDefault}`),
  versionLink(table, 'test_parameter_version_method_parent_fk'),
  foreignKey({ name: 'test_parameter_version_method_fk', columns: [table.organizationId, table.methodId], foreignColumns: [methodsOfAnalysis.organizationId, methodsOfAnalysis.id] }),
  check('test_parameter_version_method_observation', sql`(${table.methodRevision} is null and ${table.methodName} is null)
    or (${table.methodRevision} is not null and ${table.methodName} is not null and ${table.methodRevision}>0 and length(trim(${table.methodName})) between 1 and 250)`),
]);

export const parameterUncertaintyColumns = pgTable('parameter_uncertainty_columns', {
  ...scope(), id: uuid('id').notNull(), position: integer('position').notNull(), title: text('title').notNull(),
}, (table) => [
  primaryKey({ name: 'parameter_uncertainty_column_pk', columns: [...versionColumns(table), table.id] }),
  versionLink(table, 'parameter_uncertainty_column_version_fk'),
  unique('parameter_uncertainty_column_position').on(...versionColumns(table), table.position),
  check('parameter_uncertainty_column_shape', sql`${table.position} between 0 and 31 and length(trim(${table.title})) between 1 and 200`),
]);

export const parameterUncertaintyRows = pgTable('parameter_uncertainty_rows', {
  ...scope(), id: uuid('id').notNull(), position: integer('position').notNull(),
}, (table) => [
  primaryKey({ name: 'parameter_uncertainty_row_pk', columns: [...versionColumns(table), table.id] }),
  versionLink(table, 'parameter_uncertainty_row_version_fk'),
  unique('parameter_uncertainty_row_position').on(...versionColumns(table), table.position),
  check('parameter_uncertainty_row_shape', sql`${table.position} between 0 and 499`),
]);

// A cell belongs to this specific uncertainty grid, never to an arbitrary
// entity/property pair. Column zero is the derived, read-only row ordinal.
export const parameterUncertaintyCells = pgTable('parameter_uncertainty_cells', {
  ...scope(), rowId: uuid('row_id').notNull(), columnId: uuid('column_id').notNull(), textValue: text('text_value').notNull(),
}, (table) => [
  primaryKey({ name: 'parameter_uncertainty_cell_pk', columns: [...versionColumns(table), table.rowId, table.columnId] }),
  foreignKey({ name: 'parameter_uncertainty_cell_row_fk', columns: [...versionColumns(table), table.rowId], foreignColumns: [...versionColumns(parameterUncertaintyRows), parameterUncertaintyRows.id] }),
  foreignKey({ name: 'parameter_uncertainty_cell_column_fk', columns: [...versionColumns(table), table.columnId], foreignColumns: [...versionColumns(parameterUncertaintyColumns), parameterUncertaintyColumns.id] }),
  check('parameter_uncertainty_cell_length', sql`length(${table.textValue})<=2000`),
]);

const capturedFieldColumns = (table) => [...versionColumns(table), table.fieldId];
const finiteNumber = (column) => sql`${column} between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision`;

export const parameterVersionCustomFields = pgTable('parameter_version_custom_fields', {
  ...scope(), fieldId: uuid('field_id').notNull(), fieldRevision: integer('field_revision').notNull(), fieldType: text('field_type').notNull(),
  position: integer('position').notNull(), isArray: boolean('is_array').notNull(), valueCount: integer('value_count').notNull(),
  displayKind: text('display_kind').notNull(), displayText: text('display_text'), displayNumber: doublePrecision('display_number'), displayBoolean: boolean('display_boolean'),
  timeZone: text('time_zone'), timeZoneDataVersion: text('time_zone_data_version'), dateParserVersion: text('date_parser_version'),
}, (table) => [
  primaryKey({ name: 'parameter_custom_field_pk', columns: capturedFieldColumns(table) }),
  unique('parameter_custom_field_position').on(...versionColumns(table), table.position),
  foreignKey({ name: 'parameter_custom_field_parameter_fk', columns: versionColumns(table), foreignColumns: versionColumns(testParameterVersions) }),
  foreignKey({ name: 'parameter_custom_field_definition_fk', columns: [table.organizationId, table.fieldId, table.fieldRevision],
    foreignColumns: [customFieldVersions.organizationId, customFieldVersions.fieldId, customFieldVersions.revision] }),
  check('parameter_custom_field_shape', sql`${table.position} between 0 and 499 and ${table.valueCount} between 0 and 500
    and (${table.isArray} or ${table.valueCount}=1)
    and ${table.fieldType} in (${sql.raw(customFieldTypes.map(({ value }) => `'${value}'`).join(','))})`),
  check('parameter_custom_field_display', sql`num_nonnulls(${table.displayText},${table.displayNumber},${table.displayBoolean})=1
    and ((${table.displayKind}='text' and ${table.displayText} is not null and length(${table.displayText})<=8000998)
      or (${table.displayKind}='number' and ${table.displayNumber} is not null and ${finiteNumber(table.displayNumber)})
      or (${table.displayKind}='boolean' and ${table.displayBoolean} is not null))
    and (not ${table.isArray} or ${table.displayKind}='text')`),
  check('parameter_custom_field_zone', sql`(${table.fieldType} in ('date','date_time') and ${table.timeZone} is not null
      and length(${table.timeZone}) between 1 and 100 and ${table.timeZoneDataVersion} is not null and length(${table.timeZoneDataVersion}) between 1 and 40
      and ${table.dateParserVersion} is not null and length(${table.dateParserVersion}) between 1 and 80)
    or (${table.fieldType} not in ('date','date_time') and num_nonnulls(${table.timeZone},${table.timeZoneDataVersion},${table.dateParserVersion})=0)`),
  index('parameter_custom_field_definition').on(table.organizationId, table.fieldId, table.parameterId, table.revision),
]);

export const parameterVersionCustomFieldValues = pgTable('parameter_version_custom_field_values', {
  ...scope(), fieldId: uuid('field_id').notNull(), position: integer('position').notNull(),
  rawKind: text('raw_kind').notNull(), rawText: text('raw_text'), rawNumber: doublePrecision('raw_number'), rawBoolean: boolean('raw_boolean'),
  rawNumberText: text('raw_number_text'),
  interpretationState: text('interpretation_state').notNull(), parsedNumber: doublePrecision('parsed_number'), parsedBoolean: boolean('parsed_boolean'),
  parsedDate: date('parsed_date', { mode: 'string' }), parsedTimestamp: timestamp('parsed_timestamp', { withTimezone: true, mode: 'string' }),
  optionId: uuid('option_id'), optionRevision: integer('option_revision'), userId: uuid('user_id'), attachmentId: uuid('attachment_id'),
  lookupSourceId: uuid('lookup_source_id'), lookupRevision: integer('lookup_revision'), lookupLineId: text('lookup_line_id'),
}, (table) => [
  primaryKey({ name: 'parameter_custom_value_pk', columns: [...capturedFieldColumns(table), table.position] }),
  foreignKey({ name: 'parameter_custom_value_field_fk', columns: capturedFieldColumns(table), foreignColumns: capturedFieldColumns(parameterVersionCustomFields) }),
  foreignKey({ name: 'parameter_custom_value_option_fk', columns: [table.organizationId, table.fieldId, table.optionRevision, table.optionId],
    foreignColumns: [customFieldVersionOptions.organizationId, customFieldVersionOptions.fieldId, customFieldVersionOptions.revision, customFieldVersionOptions.id] }),
  foreignKey({ name: 'parameter_custom_value_user_fk', columns: [table.organizationId, table.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'parameter_custom_value_attachment_fk', columns: [table.organizationId, table.attachmentId], foreignColumns: [customFieldAttachments.organizationId, customFieldAttachments.id] }),
  foreignKey({ name: 'parameter_custom_value_lookup_fk', columns: [table.organizationId, table.lookupSourceId, table.lookupRevision, table.lookupLineId],
    foreignColumns: [customFieldLookupLines.organizationId, customFieldLookupLines.sourceId, customFieldLookupLines.revision, customFieldLookupLines.originalLineId] }),
  check('parameter_custom_value_lookup_reference', sql`num_nonnulls(${table.lookupSourceId},${table.lookupRevision},${table.lookupLineId})=0
    or (${table.lookupSourceId} is not null and ${table.lookupRevision} is not null and ${table.lookupRevision}>0 and ${table.lookupLineId} is not null)`),
  check('parameter_custom_value_raw', sql`${table.position} between 0 and 499 and num_nonnulls(${table.rawText},${table.rawNumber},${table.rawBoolean})=1
    and ((${table.rawKind}='text' and ${table.rawText} is not null and length(${table.rawText})<=16000)
      or (${table.rawKind}='number' and ${table.rawNumber} is not null and ${finiteNumber(table.rawNumber)})
      or (${table.rawKind}='boolean' and ${table.rawBoolean} is not null))`),
  // JS and PostgreSQL can choose different shortest decimal strings for the same IEEE754 double.
  check('parameter_custom_value_number_text', sql`case when ${table.rawKind}='number' then
    ${table.rawNumberText} is not null and length(${table.rawNumberText}) between 1 and 32
    and case when ${table.rawNumberText} ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then ${table.rawNumberText}::double precision=${table.rawNumber} else false end
    else ${table.rawNumberText} is null end`),
  check('parameter_custom_value_interpretation', sql`${table.interpretationState} in ('empty','valid','invalid','out_of_range')
    and (${table.parsedNumber} is null or ${finiteNumber(table.parsedNumber)})
    and (${table.parsedTimestamp} is null or isfinite(${table.parsedTimestamp})) and (${table.parsedDate} is null or isfinite(${table.parsedDate}))
    and ((${table.optionId} is null and ${table.optionRevision} is null) or (${table.optionId} is not null and ${table.optionRevision} is not null and ${table.optionRevision}>0))
    and (${table.interpretationState}='valid' or num_nonnulls(${table.parsedNumber},${table.parsedBoolean},${table.parsedDate},${table.parsedTimestamp},${table.optionId},${table.optionRevision},${table.userId},${table.attachmentId},${table.lookupSourceId},${table.lookupRevision},${table.lookupLineId})=0)
    and ((${table.interpretationState}='empty')=(${table.rawKind}='text' and ${table.rawText}=''))`),
  index('parameter_custom_value_raw_search').on(table.organizationId, table.fieldId, sql`md5(${table.rawText})`, table.parameterId, table.revision).where(sql`${table.rawText} is not null`),
]);
