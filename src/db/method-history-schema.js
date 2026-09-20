import { sql } from 'drizzle-orm';
import { pgTable, pgView, uuid, text, integer, boolean, doublePrecision, date, timestamp, index, primaryKey, unique, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { methodsOfAnalysis } from './master-schema.js';
import { customFieldVersions, customFieldVersionOptions, customFieldAttachments } from './custom-field-schema.js';
import { customFieldLookupLines } from './custom-field-lookup-schema.js';
import { customFieldTypes } from '../masters/custom-field-config.js';

const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), methodId: uuid('method_id').notNull(), revision: integer('revision').notNull() });
const versionColumns = (table) => [table.organizationId, table.methodId, table.revision];

export const methodVersions = pgTable('method_versions', {
  ...scope(), requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  code: text('code').notNull(), methodUuid: text('method_uuid').notNull(), name: text('name').notNull(), description: text('description').notNull(),
  decimalScale: integer('decimal_scale').notNull(), parseNumber: boolean('parse_number').notNull(), active: boolean('active').notNull(),
  customFieldCount: integer('custom_field_count').notNull().default(0), customFieldsProvided: boolean('custom_fields_provided').notNull().default(false),
  accessUserCount: integer('access_user_count').notNull(), savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (table) => [
  check('method_version_custom_fields', sql`${table.customFieldCount} between 0 and 500 and (${table.operation}<>'retire' or not ${table.customFieldsProvided})`),
  primaryKey({ name: 'method_version_pk', columns: versionColumns(table) }),
  unique('method_save_request_key').on(table.organizationId, table.requestId),
  foreignKey({ name: 'method_version_parent_fk', columns: [table.organizationId, table.methodId], foreignColumns: [methodsOfAnalysis.organizationId, methodsOfAnalysis.id] }),
  foreignKey({ name: 'method_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('method_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1)
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>0 and ${table.revision}=${table.previousRevision}+1)`),
  check('method_version_fields', sql`length(trim(${table.name})) between 1 and 250
    and (${table.operation}='retire' or (length(trim(${table.name}))<=200 and length(${table.description})<=16000))
    and length(trim(${table.code})) between 1 and 64 and length(trim(${table.methodUuid})) between 1 and 100
    and ${table.decimalScale} between 0 and 12 and ${table.accessUserCount} between 0 and 500
    and (${table.operation}<>'retire' or not ${table.active})`),
]);

export const methodVersionUsers = pgTable('method_version_users', {
  ...scope(), userId: uuid('user_id').notNull(), position: integer('position').notNull(),
}, (table) => [
  primaryKey({ name: 'method_version_user_pk', columns: [...versionColumns(table), table.userId] }),
  unique('method_version_user_position').on(...versionColumns(table), table.position),
  foreignKey({ name: 'method_version_user_parent_fk', columns: versionColumns(table), foreignColumns: versionColumns(methodVersions) }),
  foreignKey({ name: 'method_version_user_member_fk', columns: [table.organizationId, table.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('method_version_user_order', sql`${table.position} between 0 and 499`),
]);

// A narrow read projection for method access selection/display. Base identity
// tables retain their private grants; the barrier filters tenant/permission first.
export const methodAccessUserLabels = pgView('method_access_user_labels', {
  organizationId: uuid('organization_id'), userId: uuid('user_id'), displayName: text('display_name'), active: boolean('active'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT member.organization_id,person.id AS user_id,person.display_name,(member.active AND person.active) AS active
  FROM public.memberships member JOIN public.users person ON person.id=member.user_id
  WHERE member.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('masters.read') OR public.app_has_permission('masters.manage'))
`);

const capturedFieldColumns = (table) => [...versionColumns(table), table.fieldId];
const finiteNumber = (column) => sql`${column} between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision`;

export const methodVersionCustomFields = pgTable('method_version_custom_fields', {
  ...scope(), fieldId: uuid('field_id').notNull(), fieldRevision: integer('field_revision').notNull(), fieldType: text('field_type').notNull(),
  position: integer('position').notNull(), isArray: boolean('is_array').notNull(), valueCount: integer('value_count').notNull(),
  displayKind: text('display_kind').notNull(), displayText: text('display_text'), displayNumber: doublePrecision('display_number'), displayBoolean: boolean('display_boolean'),
  timeZone: text('time_zone'), timeZoneDataVersion: text('time_zone_data_version'), dateParserVersion: text('date_parser_version'),
}, (table) => [
  primaryKey({ name: 'method_custom_field_pk', columns: capturedFieldColumns(table) }),
  unique('method_custom_field_position').on(...versionColumns(table), table.position),
  foreignKey({ name: 'method_custom_field_method_fk', columns: versionColumns(table), foreignColumns: versionColumns(methodVersions) }),
  foreignKey({ name: 'method_custom_field_definition_fk', columns: [table.organizationId, table.fieldId, table.fieldRevision],
    foreignColumns: [customFieldVersions.organizationId, customFieldVersions.fieldId, customFieldVersions.revision] }),
  check('method_custom_field_shape', sql`${table.position} between 0 and 499 and ${table.valueCount} between 0 and 500
    and (${table.isArray} or ${table.valueCount}=1)
    and ${table.fieldType} in (${sql.raw(customFieldTypes.map(({ value }) => `'${value}'`).join(','))})`),
  check('method_custom_field_display', sql`num_nonnulls(${table.displayText},${table.displayNumber},${table.displayBoolean})=1
    and ((${table.displayKind}='text' and ${table.displayText} is not null and length(${table.displayText})<=8000998)
      or (${table.displayKind}='number' and ${table.displayNumber} is not null and ${finiteNumber(table.displayNumber)})
      or (${table.displayKind}='boolean' and ${table.displayBoolean} is not null))
    and (not ${table.isArray} or ${table.displayKind}='text')`),
  check('method_custom_field_zone', sql`(${table.fieldType} in ('date','date_time') and ${table.timeZone} is not null
      and length(${table.timeZone}) between 1 and 100 and ${table.timeZoneDataVersion} is not null and length(${table.timeZoneDataVersion}) between 1 and 40
      and ${table.dateParserVersion} is not null and length(${table.dateParserVersion}) between 1 and 80)
    or (${table.fieldType} not in ('date','date_time') and num_nonnulls(${table.timeZone},${table.timeZoneDataVersion},${table.dateParserVersion})=0)`),
  index('method_custom_field_definition').on(table.organizationId, table.fieldId, table.methodId, table.revision),
]);

export const methodVersionCustomFieldValues = pgTable('method_version_custom_field_values', {
  ...scope(), fieldId: uuid('field_id').notNull(), position: integer('position').notNull(),
  rawKind: text('raw_kind').notNull(), rawText: text('raw_text'), rawNumber: doublePrecision('raw_number'), rawBoolean: boolean('raw_boolean'),
  rawNumberText: text('raw_number_text'),
  interpretationState: text('interpretation_state').notNull(), parsedNumber: doublePrecision('parsed_number'), parsedBoolean: boolean('parsed_boolean'),
  parsedDate: date('parsed_date', { mode: 'string' }), parsedTimestamp: timestamp('parsed_timestamp', { withTimezone: true, mode: 'string' }),
  optionId: uuid('option_id'), optionRevision: integer('option_revision'), userId: uuid('user_id'), attachmentId: uuid('attachment_id'),
  lookupSourceId: uuid('lookup_source_id'), lookupRevision: integer('lookup_revision'), lookupLineId: text('lookup_line_id'),
}, (table) => [
  primaryKey({ name: 'method_custom_value_pk', columns: [...capturedFieldColumns(table), table.position] }),
  foreignKey({ name: 'method_custom_value_field_fk', columns: capturedFieldColumns(table), foreignColumns: capturedFieldColumns(methodVersionCustomFields) }),
  foreignKey({ name: 'method_custom_value_option_fk', columns: [table.organizationId, table.fieldId, table.optionRevision, table.optionId],
    foreignColumns: [customFieldVersionOptions.organizationId, customFieldVersionOptions.fieldId, customFieldVersionOptions.revision, customFieldVersionOptions.id] }),
  foreignKey({ name: 'method_custom_value_user_fk', columns: [table.organizationId, table.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'method_custom_value_attachment_fk', columns: [table.organizationId, table.attachmentId], foreignColumns: [customFieldAttachments.organizationId, customFieldAttachments.id] }),
  foreignKey({ name: 'method_custom_value_lookup_fk', columns: [table.organizationId, table.lookupSourceId, table.lookupRevision, table.lookupLineId],
    foreignColumns: [customFieldLookupLines.organizationId, customFieldLookupLines.sourceId, customFieldLookupLines.revision, customFieldLookupLines.originalLineId] }),
  check('method_custom_value_lookup_reference', sql`num_nonnulls(${table.lookupSourceId},${table.lookupRevision},${table.lookupLineId})=0
    or (${table.lookupSourceId} is not null and ${table.lookupRevision} is not null and ${table.lookupRevision}>0 and ${table.lookupLineId} is not null)`),
  check('method_custom_value_raw', sql`${table.position} between 0 and 499 and num_nonnulls(${table.rawText},${table.rawNumber},${table.rawBoolean})=1
    and ((${table.rawKind}='text' and ${table.rawText} is not null and length(${table.rawText})<=16000)
      or (${table.rawKind}='number' and ${table.rawNumber} is not null and ${finiteNumber(table.rawNumber)})
      or (${table.rawKind}='boolean' and ${table.rawBoolean} is not null))`),
  // JS and PostgreSQL can choose different shortest decimal strings for the same IEEE754 double.
  check('method_custom_value_number_text', sql`case when ${table.rawKind}='number' then
    ${table.rawNumberText} is not null and length(${table.rawNumberText}) between 1 and 32
    and case when ${table.rawNumberText} ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then ${table.rawNumberText}::double precision=${table.rawNumber} else false end
    else ${table.rawNumberText} is null end`),
  check('method_custom_value_interpretation', sql`${table.interpretationState} in ('empty','valid','invalid','out_of_range')
    and (${table.parsedNumber} is null or ${finiteNumber(table.parsedNumber)})
    and (${table.parsedTimestamp} is null or isfinite(${table.parsedTimestamp})) and (${table.parsedDate} is null or isfinite(${table.parsedDate}))
    and ((${table.optionId} is null and ${table.optionRevision} is null) or (${table.optionId} is not null and ${table.optionRevision} is not null and ${table.optionRevision}>0))
    and (${table.interpretationState}='valid' or num_nonnulls(${table.parsedNumber},${table.parsedBoolean},${table.parsedDate},${table.parsedTimestamp},${table.optionId},${table.optionRevision},${table.userId},${table.attachmentId},${table.lookupSourceId},${table.lookupRevision},${table.lookupLineId})=0)
    and ((${table.interpretationState}='empty')=(${table.rawKind}='text' and ${table.rawText}=''))`),
  index('method_custom_value_raw_search').on(table.organizationId, table.fieldId, sql`md5(${table.rawText})`, table.methodId, table.revision).where(sql`${table.rawText} is not null`),
]);
