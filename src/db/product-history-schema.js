import { sql } from 'drizzle-orm';
import { pgTable, pgView, uuid, text, integer, boolean, doublePrecision, date, timestamp, primaryKey, unique, index, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { products, tags, sampleCategories } from './master-schema.js';
import { templates } from './template-schema.js';
import { customFieldVersions, customFieldVersionOptions, customFieldAttachments } from './custom-field-schema.js';
import { customFieldTypes } from '../masters/custom-field-config.js';

const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), productId: uuid('product_id').notNull(), revision: integer('revision').notNull() });
const versionColumns = (table) => [table.organizationId, table.productId, table.revision];

export const productVersions = pgTable('product_versions', {
  ...scope(), requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  code: text('code').notNull(), name: text('name').notNull(), description: text('description').notNull(), abbreviation: text('abbreviation'),
  jobTemplateId: uuid('job_template_id'), active: boolean('active').notNull(), tagCount: integer('tag_count').notNull(),
  customFieldCount: integer('custom_field_count').notNull().default(0), customFieldsProvided: boolean('custom_fields_provided').notNull().default(false),
  savedBy: uuid('saved_by').notNull(), savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (table) => [
  primaryKey({ name: 'product_version_pk', columns: versionColumns(table) }),
  unique('product_save_request_key').on(table.organizationId, table.requestId),
  foreignKey({ name: 'product_version_parent_fk', columns: [table.organizationId, table.productId], foreignColumns: [products.organizationId, products.id] }),
  foreignKey({ name: 'product_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'product_version_template_fk', columns: [table.organizationId, table.jobTemplateId], foreignColumns: [templates.organizationId, templates.id] }),
  check('product_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1)
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>0 and ${table.revision}=${table.previousRevision}+1)`),
  check('product_version_fields', sql`length(trim(${table.name})) between 1 and 250 and length(trim(${table.code})) between 1 and 64 and ${table.tagCount}>=0
    and (${table.operation}='retire' or (length(trim(${table.name}))<=200 and length(${table.description})<=16000 and ${table.tagCount}<=500
      and (${table.abbreviation} is null or length(${table.abbreviation})<=64) and ${table.code} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'))
    and (${table.operation}<>'retire' or not ${table.active})`),
  check('product_version_custom_fields', sql`${table.customFieldCount} between 0 and 500 and (${table.operation}<>'retire' or not ${table.customFieldsProvided})`),
]);

export const productVersionTags = pgTable('product_version_tags', {
  ...scope(), tagId: uuid('tag_id').notNull(), position: integer('position').notNull(),
}, (table) => [
  primaryKey({ name: 'product_version_tag_pk', columns: [...versionColumns(table), table.tagId] }),
  unique('product_version_tag_position').on(...versionColumns(table), table.position),
  foreignKey({ name: 'product_version_tag_parent_fk', columns: versionColumns(table), foreignColumns: versionColumns(productVersions) }),
  foreignKey({ name: 'product_version_tag_fk', columns: [table.organizationId, table.tagId], foreignColumns: [tags.organizationId, tags.id] }),
  check('product_version_tag_order', sql`${table.position} >= 0`),
]);

export const productVersionSampleCategories = pgTable('product_version_sample_categories', {
  ...scope(), sampleCategoryId: uuid('sample_category_id').notNull(),
}, (table) => [
  primaryKey({ name: 'product_version_category_pk', columns: [...versionColumns(table), table.sampleCategoryId] }),
  foreignKey({ name: 'product_version_category_parent_fk', columns: versionColumns(table), foreignColumns: versionColumns(productVersions) }),
  foreignKey({ name: 'product_version_category_fk', columns: [table.organizationId, table.sampleCategoryId], foreignColumns: [sampleCategories.organizationId, sampleCategories.id] }),
]);

const capturedFieldColumns = (table) => [...versionColumns(table), table.fieldId];
const finiteNumber = (column) => sql`${column} between '-1.7976931348623157e308'::double precision and '1.7976931348623157e308'::double precision`;

export const productVersionCustomFields = pgTable('product_version_custom_fields', {
  ...scope(), fieldId: uuid('field_id').notNull(), fieldRevision: integer('field_revision').notNull(), fieldType: text('field_type').notNull(),
  position: integer('position').notNull(), isArray: boolean('is_array').notNull(), valueCount: integer('value_count').notNull(),
  displayKind: text('display_kind').notNull(), displayText: text('display_text'), displayNumber: doublePrecision('display_number'), displayBoolean: boolean('display_boolean'),
  timeZone: text('time_zone'), timeZoneDataVersion: text('time_zone_data_version'), dateParserVersion: text('date_parser_version'),
}, (table) => [
  primaryKey({ name: 'product_custom_field_pk', columns: capturedFieldColumns(table) }),
  unique('product_custom_field_position').on(...versionColumns(table), table.position),
  foreignKey({ name: 'product_custom_field_product_fk', columns: versionColumns(table), foreignColumns: versionColumns(productVersions) }),
  foreignKey({ name: 'product_custom_field_definition_fk', columns: [table.organizationId, table.fieldId, table.fieldRevision],
    foreignColumns: [customFieldVersions.organizationId, customFieldVersions.fieldId, customFieldVersions.revision] }),
  check('product_custom_field_shape', sql`${table.position} between 0 and 499 and ${table.valueCount} between 0 and 500
    and (${table.isArray} or ${table.valueCount}=1)
    and ${table.fieldType} in (${sql.raw(customFieldTypes.map(({ value }) => `'${value}'`).join(','))})`),
  check('product_custom_field_display', sql`num_nonnulls(${table.displayText},${table.displayNumber},${table.displayBoolean})=1
    and ((${table.displayKind}='text' and ${table.displayText} is not null and length(${table.displayText})<=8000998)
      or (${table.displayKind}='number' and ${table.displayNumber} is not null and ${finiteNumber(table.displayNumber)})
      or (${table.displayKind}='boolean' and ${table.displayBoolean} is not null))
    and (not ${table.isArray} or ${table.displayKind}='text')`),
  check('product_custom_field_zone', sql`(${table.fieldType} in ('date','date_time') and ${table.timeZone} is not null
      and length(${table.timeZone}) between 1 and 100 and ${table.timeZoneDataVersion} is not null and length(${table.timeZoneDataVersion}) between 1 and 40
      and ${table.dateParserVersion} is not null and length(${table.dateParserVersion}) between 1 and 80)
    or (${table.fieldType} not in ('date','date_time') and num_nonnulls(${table.timeZone},${table.timeZoneDataVersion},${table.dateParserVersion})=0)`),
  index('product_custom_field_definition').on(table.organizationId, table.fieldId, table.productId, table.revision),
]);

export const productVersionCustomFieldValues = pgTable('product_version_custom_field_values', {
  ...scope(), fieldId: uuid('field_id').notNull(), position: integer('position').notNull(),
  rawKind: text('raw_kind').notNull(), rawText: text('raw_text'), rawNumber: doublePrecision('raw_number'), rawBoolean: boolean('raw_boolean'),
  rawNumberText: text('raw_number_text'),
  interpretationState: text('interpretation_state').notNull(), parsedNumber: doublePrecision('parsed_number'), parsedBoolean: boolean('parsed_boolean'),
  parsedDate: date('parsed_date', { mode: 'string' }), parsedTimestamp: timestamp('parsed_timestamp', { withTimezone: true, mode: 'string' }),
  optionId: uuid('option_id'), optionRevision: integer('option_revision'), userId: uuid('user_id'), attachmentId: uuid('attachment_id'),
}, (table) => [
  primaryKey({ name: 'product_custom_value_pk', columns: [...capturedFieldColumns(table), table.position] }),
  foreignKey({ name: 'product_custom_value_field_fk', columns: capturedFieldColumns(table), foreignColumns: capturedFieldColumns(productVersionCustomFields) }),
  foreignKey({ name: 'product_custom_value_option_fk', columns: [table.organizationId, table.fieldId, table.optionRevision, table.optionId],
    foreignColumns: [customFieldVersionOptions.organizationId, customFieldVersionOptions.fieldId, customFieldVersionOptions.revision, customFieldVersionOptions.id] }),
  foreignKey({ name: 'product_custom_value_user_fk', columns: [table.organizationId, table.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'product_custom_value_attachment_fk', columns: [table.organizationId, table.attachmentId], foreignColumns: [customFieldAttachments.organizationId, customFieldAttachments.id] }),
  check('product_custom_value_raw', sql`${table.position} between 0 and 499 and num_nonnulls(${table.rawText},${table.rawNumber},${table.rawBoolean})=1
    and ((${table.rawKind}='text' and ${table.rawText} is not null and length(${table.rawText})<=16000)
      or (${table.rawKind}='number' and ${table.rawNumber} is not null and ${finiteNumber(table.rawNumber)})
      or (${table.rawKind}='boolean' and ${table.rawBoolean} is not null))`),
  // JS and PostgreSQL can choose different shortest decimal strings for the same IEEE754 double.
  check('product_custom_value_number_text', sql`case when ${table.rawKind}='number' then
    ${table.rawNumberText} is not null and length(${table.rawNumberText}) between 1 and 32
    and case when ${table.rawNumberText} ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?(e[+-]?[0-9]+)?$'
      then ${table.rawNumberText}::double precision=${table.rawNumber} else false end
    else ${table.rawNumberText} is null end`),
  check('product_custom_value_interpretation', sql`${table.interpretationState} in ('empty','valid','invalid','out_of_range')
    and (${table.parsedNumber} is null or ${finiteNumber(table.parsedNumber)})
    and (${table.parsedTimestamp} is null or isfinite(${table.parsedTimestamp})) and (${table.parsedDate} is null or isfinite(${table.parsedDate}))
    and ((${table.optionId} is null and ${table.optionRevision} is null) or (${table.optionId} is not null and ${table.optionRevision} is not null and ${table.optionRevision}>0))
    and (${table.interpretationState}='valid' or num_nonnulls(${table.parsedNumber},${table.parsedBoolean},${table.parsedDate},${table.parsedTimestamp},${table.optionId},${table.optionRevision},${table.userId},${table.attachmentId})=0)
    and ((${table.interpretationState}='empty')=(${table.rawKind}='text' and ${table.rawText}=''))`),
  index('product_custom_value_raw_search').on(table.organizationId, table.fieldId, sql`md5(${table.rawText})`, table.productId, table.revision).where(sql`${table.rawText} is not null`),
]);

// Product selection/display needs current template labels, not definition access.
export const productTemplateLabels = pgView('product_template_labels', {
  organizationId: uuid('organization_id'), templateId: uuid('template_id'), code: text('code'), name: text('name'), kind: text('kind'), active: boolean('active'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT template.organization_id,template.id AS template_id,template.code,version.name,version.kind,template.active
  FROM public.templates template JOIN LATERAL (
    SELECT name,kind FROM public.template_versions version
    WHERE version.organization_id=template.organization_id AND version.template_id=template.id AND version.status<>'building'
    ORDER BY (version.status='draft') DESC,version.number DESC LIMIT 1
  ) version ON true
  WHERE template.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('masters.read') OR public.app_has_permission('masters.manage'))
`);
