import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, timestamp, primaryKey, unique, uniqueIndex, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { testParameters, laboratories, measurementUnits, methodsOfAnalysis } from './master-schema.js';

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
  laboratoryId: uuid('laboratory_id'), measurementUnitId: uuid('measurement_unit_id'), defaultScale: integer('default_scale').notNull(),
  hasUncertainty: boolean('has_uncertainty').notNull(), savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (table) => [
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
}, (table) => [
  primaryKey({ name: 'test_parameter_version_method_pk', columns: [...versionColumns(table), table.methodId] }),
  uniqueIndex('test_parameter_version_default_method').on(...versionColumns(table)).where(sql`${table.isDefault}`),
  versionLink(table, 'test_parameter_version_method_parent_fk'),
  foreignKey({ name: 'test_parameter_version_method_fk', columns: [table.organizationId, table.methodId], foreignColumns: [methodsOfAnalysis.organizationId, methodsOfAnalysis.id] }),
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
