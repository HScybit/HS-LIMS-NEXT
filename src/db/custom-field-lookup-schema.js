import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, doublePrecision, boolean, timestamp, primaryKey, unique, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';

const transactionId = customType({ dataType: () => 'xid8' });
const time = name => timestamp(name, { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const sourceColumns = table => [table.organizationId, table.sourceId];
const versionColumns = table => [...sourceColumns(table), table.revision];

// This is the flat DataMasterLine dependency, separate from embedded template options.
export const customFieldLookupSources = pgTable('custom_field_lookup_sources', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), id: uuid('id').notNull(),
  sourceSystem: text('source_system').notNull().default('meteor'), originalSourceId: text('original_source_id').notNull(),
  name: text('name').notNull(), revision: integer('revision').notNull().default(1), lineCount: integer('line_count').notNull(),
  requestId: uuid('request_id').notNull(), createdAt: time('created_at'), updatedAt: time('updated_at'),
}, table => [
  primaryKey({ name: 'custom_lookup_source_pk', columns: [table.organizationId, table.id] }),
  unique('custom_lookup_original_source_key').on(table.organizationId, table.sourceSystem, table.originalSourceId),
  check('custom_lookup_source_shape', sql`${table.sourceSystem}='meteor' and length(trim(${table.originalSourceId}))>0
    and length(${table.originalSourceId})<=200 and length(${table.name})<=16000
    and ${table.revision}>0 and ${table.lineCount} between 0 and 10000`),
]);

export const customFieldLookupVersions = pgTable('custom_field_lookup_versions', {
  organizationId: uuid('organization_id').notNull(), sourceId: uuid('source_id').notNull(), revision: integer('revision').notNull(),
  previousRevision: integer('previous_revision').notNull(), requestId: uuid('request_id').notNull(), name: text('name').notNull(),
  lineCount: integer('line_count').notNull(), observedBy: uuid('observed_by').notNull(), observedAt: time('observed_at'),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [
  primaryKey({ name: 'custom_lookup_version_pk', columns: versionColumns(table) }),
  unique('custom_lookup_request_key').on(table.organizationId, table.requestId),
  foreignKey({ name: 'custom_lookup_version_source_fk', columns: sourceColumns(table), foreignColumns: [customFieldLookupSources.organizationId, customFieldLookupSources.id] }),
  foreignKey({ name: 'custom_lookup_observer_fk', columns: [table.organizationId, table.observedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('custom_lookup_version_shape', sql`${table.previousRevision}>=0 and ${table.revision}=${table.previousRevision}+1
    and length(${table.name})<=16000 and ${table.lineCount} between 0 and 10000`),
]);

export const customFieldLookupLines = pgTable('custom_field_lookup_lines', {
  organizationId: uuid('organization_id').notNull(), sourceId: uuid('source_id').notNull(), revision: integer('revision').notNull(),
  originalLineId: text('original_line_id').notNull(), position: integer('position').notNull(),
  labelKind: text('label_kind').notNull(), labelText: text('label_text'), labelNumber: doublePrecision('label_number'), labelBoolean: boolean('label_boolean'),
}, table => [
  primaryKey({ name: 'custom_lookup_line_pk', columns: [...versionColumns(table), table.originalLineId] }),
  // Keep cached line-ID foreign-key checks on the full primary key instead of scanning source positions.
  unique('custom_lookup_line_position').on(table.position, ...versionColumns(table)),
  foreignKey({ name: 'custom_lookup_line_version_fk', columns: versionColumns(table), foreignColumns: versionColumns(customFieldLookupVersions) }),
  check('custom_lookup_line_shape', sql`length(trim(${table.originalLineId}))>0 and length(${table.originalLineId})<=200 and ${table.position} between 0 and 9999
    and num_nonnulls(${table.labelText},${table.labelNumber},${table.labelBoolean})=1
    and ((${table.labelKind}='text' and ${table.labelText} is not null and length(${table.labelText})<=16000)
      or (${table.labelKind}='number' and ${table.labelNumber} is not null and ${table.labelNumber} between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision)
      or (${table.labelKind}='boolean' and ${table.labelBoolean} is not null))`),
]);
