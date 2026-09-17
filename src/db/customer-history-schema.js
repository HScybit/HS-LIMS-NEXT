import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, numeric, timestamp, primaryKey, unique, check, foreignKey, customType, doublePrecision, date, index } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { customers } from './master-schema.js';
import { customFieldVersions, customFieldVersionOptions, customFieldAttachments } from './custom-field-schema.js';
import { customFieldLookupLines } from './custom-field-lookup-schema.js';
import { customFieldTypes } from '../masters/custom-field-config.js';

const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), customerId: uuid('customer_id').notNull(), revision: integer('revision').notNull() });
const versionColumns = table => [table.organizationId, table.customerId, table.revision];

export const customerVersions = pgTable('customer_versions', {
  ...scope(), requestId: uuid('request_id').notNull(), requestFingerprint: text('request_fingerprint'), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  code: text('code').notNull(), name: text('name').notNull(), legalName: text('legal_name').notNull(), abbreviation: text('abbreviation'), taxIdentifier: text('tax_identifier'),
  creditDays: integer('credit_days').notNull(), totalBalance: numeric('total_balance', { precision: 20, scale: 2 }).notNull(),
  defaultInvoiceNotes: text('default_invoice_notes'), feedbackApplicable: boolean('feedback_applicable').notNull(),
  igstPercent: numeric('igst_percent', { precision: 7, scale: 4 }).notNull(), sgstPercent: numeric('sgst_percent', { precision: 7, scale: 4 }).notNull(),
  cgstPercent: numeric('cgst_percent', { precision: 7, scale: 4 }).notNull(), discountPercent: numeric('discount_percent', { precision: 7, scale: 4 }).notNull(),
  isKaleenBandhu: boolean('is_kaleen_bandhu').notNull(), active: boolean('active').notNull(), retired: boolean('retired').notNull(), saveSource: text('save_source').notNull(),
  customFieldCount: integer('custom_field_count').notNull(), customFieldsProvided: boolean('custom_fields_provided').notNull(),
  addressCount: integer('address_count').notNull(), contactCount: integer('contact_count').notNull(), savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, t => [
  primaryKey({ name: 'customer_version_pk', columns: versionColumns(t) }), unique('customer_save_request_key').on(t.organizationId, t.requestId),
  foreignKey({ name: 'customer_version_parent_fk', columns: [t.organizationId, t.customerId], foreignColumns: [customers.organizationId, customers.id] }),
  foreignKey({ name: 'customer_version_actor_fk', columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('customer_version_revision', sql`(${t.operation}='create' and ${t.previousRevision} is null and ${t.revision}=1)
    or (${t.operation} in ('update','retire') and ${t.previousRevision} is not null and ${t.previousRevision}>0 and ${t.revision}=${t.previousRevision}+1)`),
  check('customer_version_fields', sql`length(trim(${t.code})) between 1 and 64 and length(trim(${t.name})) between 1 and 250 and length(trim(${t.legalName})) between 1 and 250
    and ${t.creditDays} between 0 and 3650 and ${t.totalBalance} not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
    and ${t.igstPercent} between 0 and 100 and ${t.sgstPercent} between 0 and 100 and ${t.cgstPercent} between 0 and 100 and ${t.discountPercent} between 0 and 100
    and (${t.retired}=(${t.operation}='retire')) and (not ${t.retired} or (not ${t.active} and not ${t.customFieldsProvided}))
    and ${t.addressCount}>=0 and ${t.contactCount}>=0 and ${t.customFieldCount} between 0 and 500
    and ((${t.saveSource}='master' and ${t.requestFingerprint} is not null and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$')
      or (${t.saveSource}='registration' and ${t.operation}='create' and ${t.requestFingerprint} is null and not ${t.customFieldsProvided} and ${t.customFieldCount}=0))`),
]);

const childKeys = (t, prefix) => [primaryKey({ name: `${prefix}_pk`, columns: [...versionColumns(t), t.id] }),
  unique(`${prefix}_position`).on(...versionColumns(t), t.position), check(`${prefix}_order`, sql`${t.position}>=0`),
  index(`${prefix}_identity`).on(t.organizationId, t.id, t.customerId),
  foreignKey({ name: `${prefix}_parent_fk`, columns: versionColumns(t), foreignColumns: versionColumns(customerVersions) })];

export const customerVersionAddresses = pgTable('customer_version_addresses', {
  ...scope(), id: uuid('id').notNull(), position: integer('position').notNull(), addressType: text('address_type').notNull(), attentionTo: text('attention_to'),
  line1: text('line_1'), line2: text('line_2'), city: text('city'), state: text('state'), postalCode: text('postal_code'),
  countryCode: text('country_code'), freeformAddress: text('freeform_address'), isDefault: boolean('is_default').notNull(),
}, t => childKeys(t, 'customer_version_address'));

export const customerVersionContacts = pgTable('customer_version_contacts', {
  ...scope(), id: uuid('id').notNull(), position: integer('position').notNull(), name: text('name').notNull(), email: text('email'), phone: text('phone'),
  designation: text('designation'), isPrimary: boolean('is_primary').notNull(),
}, t => childKeys(t, 'customer_version_contact'));

const capturedFieldColumns = (table) => [...versionColumns(table), table.fieldId];
const finiteNumber = (column) => sql`${column} between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision`;

export const customerVersionCustomFields = pgTable('customer_version_custom_fields', {
  ...scope(), fieldId: uuid('field_id').notNull(), fieldRevision: integer('field_revision').notNull(), fieldType: text('field_type').notNull(),
  position: integer('position').notNull(), isArray: boolean('is_array').notNull(), valueCount: integer('value_count').notNull(),
  displayKind: text('display_kind').notNull(), displayText: text('display_text'), displayNumber: doublePrecision('display_number'), displayBoolean: boolean('display_boolean'),
  timeZone: text('time_zone'), timeZoneDataVersion: text('time_zone_data_version'), dateParserVersion: text('date_parser_version'),
}, (table) => [
  primaryKey({ name: 'customer_custom_field_pk', columns: capturedFieldColumns(table) }),
  unique('customer_custom_field_position').on(...versionColumns(table), table.position),
  foreignKey({ name: 'customer_custom_field_customer_fk', columns: versionColumns(table), foreignColumns: versionColumns(customerVersions) }),
  foreignKey({ name: 'customer_custom_field_definition_fk', columns: [table.organizationId, table.fieldId, table.fieldRevision],
    foreignColumns: [customFieldVersions.organizationId, customFieldVersions.fieldId, customFieldVersions.revision] }),
  check('customer_custom_field_shape', sql`${table.position} between 0 and 499 and ${table.valueCount} between 0 and 500
    and (${table.isArray} or ${table.valueCount}=1)
    and ${table.fieldType} in (${sql.raw(customFieldTypes.map(({ value }) => `'${value}'`).join(','))})`),
  check('customer_custom_field_display', sql`num_nonnulls(${table.displayText},${table.displayNumber},${table.displayBoolean})=1
    and ((${table.displayKind}='text' and ${table.displayText} is not null and length(${table.displayText})<=8000998)
      or (${table.displayKind}='number' and ${table.displayNumber} is not null and ${finiteNumber(table.displayNumber)})
      or (${table.displayKind}='boolean' and ${table.displayBoolean} is not null))
    and (not ${table.isArray} or ${table.displayKind}='text')`),
  check('customer_custom_field_zone', sql`(${table.fieldType} in ('date','date_time') and ${table.timeZone} is not null
      and length(${table.timeZone}) between 1 and 100 and ${table.timeZoneDataVersion} is not null and length(${table.timeZoneDataVersion}) between 1 and 40
      and ${table.dateParserVersion} is not null and length(${table.dateParserVersion}) between 1 and 80)
    or (${table.fieldType} not in ('date','date_time') and num_nonnulls(${table.timeZone},${table.timeZoneDataVersion},${table.dateParserVersion})=0)`),
  index('customer_custom_field_definition').on(table.organizationId, table.fieldId, table.customerId, table.revision),
]);

export const customerVersionCustomFieldValues = pgTable('customer_version_custom_field_values', {
  ...scope(), fieldId: uuid('field_id').notNull(), position: integer('position').notNull(),
  rawKind: text('raw_kind').notNull(), rawText: text('raw_text'), rawNumber: doublePrecision('raw_number'), rawBoolean: boolean('raw_boolean'),
  rawNumberText: text('raw_number_text'),
  interpretationState: text('interpretation_state').notNull(), parsedNumber: doublePrecision('parsed_number'), parsedBoolean: boolean('parsed_boolean'),
  parsedDate: date('parsed_date', { mode: 'string' }), parsedTimestamp: timestamp('parsed_timestamp', { withTimezone: true, mode: 'string' }),
  optionId: uuid('option_id'), optionRevision: integer('option_revision'), userId: uuid('user_id'), attachmentId: uuid('attachment_id'),
  lookupSourceId: uuid('lookup_source_id'), lookupRevision: integer('lookup_revision'), lookupLineId: text('lookup_line_id'),
}, (table) => [
  primaryKey({ name: 'customer_custom_value_pk', columns: [...capturedFieldColumns(table), table.position] }),
  foreignKey({ name: 'customer_custom_value_field_fk', columns: capturedFieldColumns(table), foreignColumns: capturedFieldColumns(customerVersionCustomFields) }),
  foreignKey({ name: 'customer_custom_value_option_fk', columns: [table.organizationId, table.fieldId, table.optionRevision, table.optionId],
    foreignColumns: [customFieldVersionOptions.organizationId, customFieldVersionOptions.fieldId, customFieldVersionOptions.revision, customFieldVersionOptions.id] }),
  foreignKey({ name: 'customer_custom_value_user_fk', columns: [table.organizationId, table.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'customer_custom_value_attachment_fk', columns: [table.organizationId, table.attachmentId], foreignColumns: [customFieldAttachments.organizationId, customFieldAttachments.id] }),
  foreignKey({ name: 'customer_custom_value_lookup_fk', columns: [table.organizationId, table.lookupSourceId, table.lookupRevision, table.lookupLineId],
    foreignColumns: [customFieldLookupLines.organizationId, customFieldLookupLines.sourceId, customFieldLookupLines.revision, customFieldLookupLines.originalLineId] }),
  check('customer_custom_value_lookup_reference', sql`num_nonnulls(${table.lookupSourceId},${table.lookupRevision},${table.lookupLineId})=0
    or (${table.lookupSourceId} is not null and ${table.lookupRevision} is not null and ${table.lookupRevision}>0 and ${table.lookupLineId} is not null)`),
  check('customer_custom_value_raw', sql`${table.position} between 0 and 499 and num_nonnulls(${table.rawText},${table.rawNumber},${table.rawBoolean})=1
    and ((${table.rawKind}='text' and ${table.rawText} is not null and length(${table.rawText})<=16000)
      or (${table.rawKind}='number' and ${table.rawNumber} is not null and ${finiteNumber(table.rawNumber)})
      or (${table.rawKind}='boolean' and ${table.rawBoolean} is not null))`),
  // JS and PostgreSQL can choose different shortest decimal strings for the same IEEE754 double.
  check('customer_custom_value_number_text', sql`case when ${table.rawKind}='number' then
    ${table.rawNumberText} is not null and length(${table.rawNumberText}) between 1 and 32
    and case when ${table.rawNumberText} ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then ${table.rawNumberText}::double precision=${table.rawNumber} else false end
    else ${table.rawNumberText} is null end`),
  check('customer_custom_value_interpretation', sql`${table.interpretationState} in ('empty','valid','invalid','out_of_range')
    and (${table.parsedNumber} is null or ${finiteNumber(table.parsedNumber)})
    and (${table.parsedTimestamp} is null or isfinite(${table.parsedTimestamp})) and (${table.parsedDate} is null or isfinite(${table.parsedDate}))
    and ((${table.optionId} is null and ${table.optionRevision} is null) or (${table.optionId} is not null and ${table.optionRevision} is not null and ${table.optionRevision}>0))
    and (${table.interpretationState}='valid' or num_nonnulls(${table.parsedNumber},${table.parsedBoolean},${table.parsedDate},${table.parsedTimestamp},${table.optionId},${table.optionRevision},${table.userId},${table.attachmentId},${table.lookupSourceId},${table.lookupRevision},${table.lookupLineId})=0)
    and ((${table.interpretationState}='empty')=(${table.rawKind}='text' and ${table.rawText}=''))`),
  index('customer_custom_value_raw_search').on(table.organizationId, table.fieldId, sql`md5(${table.rawText})`, table.customerId, table.revision).where(sql`${table.rawText} is not null`),
]);
