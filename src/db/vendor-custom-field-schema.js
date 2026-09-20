import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, timestamp, primaryKey, unique, check, foreignKey, doublePrecision, date, index } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { vendorVersions } from './vendor-schema.js';
import { customFieldVersions, customFieldVersionOptions, customFieldAttachments } from './custom-field-schema.js';
import { customFieldLookupLines } from './custom-field-lookup-schema.js';
import { customFieldTypes } from '../masters/custom-field-config.js';

const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), vendorId: uuid('vendor_id').notNull(), revision: integer('revision').notNull() });
const versionColumns = table => [table.organizationId, table.vendorId, table.revision];

const capturedFieldColumns = (table) => [...versionColumns(table), table.fieldId];
const finiteNumber = (column) => sql`${column} between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision`;

export const vendorVersionCustomFields = pgTable('vendor_version_custom_fields', {
  ...scope(), fieldId: uuid('field_id').notNull(), fieldRevision: integer('field_revision').notNull(), fieldType: text('field_type').notNull(),
  position: integer('position').notNull(), isArray: boolean('is_array').notNull(), valueCount: integer('value_count').notNull(),
  displayKind: text('display_kind').notNull(), displayText: text('display_text'), displayNumber: doublePrecision('display_number'), displayBoolean: boolean('display_boolean'),
  timeZone: text('time_zone'), timeZoneDataVersion: text('time_zone_data_version'), dateParserVersion: text('date_parser_version'),
}, (table) => [
  primaryKey({ name: 'vendor_custom_field_pk', columns: capturedFieldColumns(table) }),
  unique('vendor_custom_field_position').on(...versionColumns(table), table.position),
  foreignKey({ name: 'vendor_custom_field_vendor_fk', columns: versionColumns(table), foreignColumns: versionColumns(vendorVersions) }),
  foreignKey({ name: 'vendor_custom_field_definition_fk', columns: [table.organizationId, table.fieldId, table.fieldRevision],
    foreignColumns: [customFieldVersions.organizationId, customFieldVersions.fieldId, customFieldVersions.revision] }),
  check('vendor_custom_field_shape', sql`${table.position} between 0 and 499 and ${table.valueCount} between 0 and 500
    and (${table.isArray} or ${table.valueCount}=1)
    and ${table.fieldType} in (${sql.raw(customFieldTypes.map(({ value }) => `'${value}'`).join(','))})`),
  check('vendor_custom_field_display', sql`num_nonnulls(${table.displayText},${table.displayNumber},${table.displayBoolean})=1
    and ((${table.displayKind}='text' and ${table.displayText} is not null and length(${table.displayText})<=8000998)
      or (${table.displayKind}='number' and ${table.displayNumber} is not null and ${finiteNumber(table.displayNumber)})
      or (${table.displayKind}='boolean' and ${table.displayBoolean} is not null))
    and (not ${table.isArray} or ${table.displayKind}='text')`),
  check('vendor_custom_field_zone', sql`(${table.fieldType} in ('date','date_time') and ${table.timeZone} is not null
      and length(${table.timeZone}) between 1 and 100 and ${table.timeZoneDataVersion} is not null and length(${table.timeZoneDataVersion}) between 1 and 40
      and ${table.dateParserVersion} is not null and length(${table.dateParserVersion}) between 1 and 80)
    or (${table.fieldType} not in ('date','date_time') and num_nonnulls(${table.timeZone},${table.timeZoneDataVersion},${table.dateParserVersion})=0)`),
  index('vendor_custom_field_definition').on(table.organizationId, table.fieldId, table.vendorId, table.revision),
]);

export const vendorVersionCustomFieldValues = pgTable('vendor_version_custom_field_values', {
  ...scope(), fieldId: uuid('field_id').notNull(), position: integer('position').notNull(),
  rawKind: text('raw_kind').notNull(), rawText: text('raw_text'), rawNumber: doublePrecision('raw_number'), rawBoolean: boolean('raw_boolean'),
  rawNumberText: text('raw_number_text'),
  interpretationState: text('interpretation_state').notNull(), parsedNumber: doublePrecision('parsed_number'), parsedBoolean: boolean('parsed_boolean'),
  parsedDate: date('parsed_date', { mode: 'string' }), parsedTimestamp: timestamp('parsed_timestamp', { withTimezone: true, mode: 'string' }),
  optionId: uuid('option_id'), optionRevision: integer('option_revision'), userId: uuid('user_id'), attachmentId: uuid('attachment_id'),
  lookupSourceId: uuid('lookup_source_id'), lookupRevision: integer('lookup_revision'), lookupLineId: text('lookup_line_id'),
}, (table) => [
  primaryKey({ name: 'vendor_custom_value_pk', columns: [...capturedFieldColumns(table), table.position] }),
  foreignKey({ name: 'vendor_custom_value_field_fk', columns: capturedFieldColumns(table), foreignColumns: capturedFieldColumns(vendorVersionCustomFields) }),
  foreignKey({ name: 'vendor_custom_value_option_fk', columns: [table.organizationId, table.fieldId, table.optionRevision, table.optionId],
    foreignColumns: [customFieldVersionOptions.organizationId, customFieldVersionOptions.fieldId, customFieldVersionOptions.revision, customFieldVersionOptions.id] }),
  foreignKey({ name: 'vendor_custom_value_user_fk', columns: [table.organizationId, table.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'vendor_custom_value_attachment_fk', columns: [table.organizationId, table.attachmentId], foreignColumns: [customFieldAttachments.organizationId, customFieldAttachments.id] }),
  foreignKey({ name: 'vendor_custom_value_lookup_fk', columns: [table.organizationId, table.lookupSourceId, table.lookupRevision, table.lookupLineId],
    foreignColumns: [customFieldLookupLines.organizationId, customFieldLookupLines.sourceId, customFieldLookupLines.revision, customFieldLookupLines.originalLineId] }),
  check('vendor_custom_value_lookup_reference', sql`num_nonnulls(${table.lookupSourceId},${table.lookupRevision},${table.lookupLineId})=0
    or (${table.lookupSourceId} is not null and ${table.lookupRevision} is not null and ${table.lookupRevision}>0 and ${table.lookupLineId} is not null)`),
  check('vendor_custom_value_raw', sql`${table.position} between 0 and 499 and num_nonnulls(${table.rawText},${table.rawNumber},${table.rawBoolean})=1
    and ((${table.rawKind}='text' and ${table.rawText} is not null and length(${table.rawText})<=16000)
      or (${table.rawKind}='number' and ${table.rawNumber} is not null and ${finiteNumber(table.rawNumber)})
      or (${table.rawKind}='boolean' and ${table.rawBoolean} is not null))`),
  // JS and PostgreSQL can choose different shortest decimal strings for the same IEEE754 double.
  check('vendor_custom_value_number_text', sql`case when ${table.rawKind}='number' then
    ${table.rawNumberText} is not null and length(${table.rawNumberText}) between 1 and 32
    and case when ${table.rawNumberText} ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then ${table.rawNumberText}::double precision=${table.rawNumber} else false end
    else ${table.rawNumberText} is null end`),
  check('vendor_custom_value_interpretation', sql`${table.interpretationState} in ('empty','valid','invalid','out_of_range')
    and (${table.parsedNumber} is null or ${finiteNumber(table.parsedNumber)})
    and (${table.parsedTimestamp} is null or isfinite(${table.parsedTimestamp})) and (${table.parsedDate} is null or isfinite(${table.parsedDate}))
    and ((${table.optionId} is null and ${table.optionRevision} is null) or (${table.optionId} is not null and ${table.optionRevision} is not null and ${table.optionRevision}>0))
    and (${table.interpretationState}='valid' or num_nonnulls(${table.parsedNumber},${table.parsedBoolean},${table.parsedDate},${table.parsedTimestamp},${table.optionId},${table.optionRevision},${table.userId},${table.attachmentId},${table.lookupSourceId},${table.lookupRevision},${table.lookupLineId})=0)
    and ((${table.interpretationState}='empty')=(${table.rawKind}='text' and ${table.rawText}=''))`),
  index('vendor_custom_value_raw_search').on(table.organizationId, table.fieldId, sql`md5(${table.rawText})`, table.vendorId, table.revision).where(sql`${table.rawText} is not null`),
]);
