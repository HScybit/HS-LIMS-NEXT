import { sql } from 'drizzle-orm';
import { pgTable, pgView, uuid, text, integer, boolean, bigint, doublePrecision, timestamp, customType, primaryKey, foreignKey, unique, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { productVersions } from './product-history-schema.js';
import { testParameterVersions } from './parameter-history-schema.js';
import { methodVersions } from './method-history-schema.js';
import { userProfileVersions } from './user-profile-schema.js';
import { customerVersions } from './customer-history-schema.js';

const transactionId = customType({ dataType: () => 'xid8' });

export const masterBulkBatches = pgTable('master_bulk_batches', {
  organizationId: uuid('organization_id').notNull(),
  id: uuid('id').notNull(),
  resource: text('resource').notNull(),
  fileName: text('file_name').notNull(),
  fileFormat: text('file_format').notNull(),
  sourceSha256: text('source_sha256'),
  sourceHmacSha256: text('source_hmac_sha256'),
  timeZone: text('time_zone').notNull(),
  headerRowNumber: integer('header_row_number').notNull(),
  sheetName: text('sheet_name'),
  sheetCount: integer('sheet_count'),
  date1904: boolean('date_1904'),
  columnCount: integer('column_count').notNull(),
  rowCount: integer('row_count').notNull(),
  savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`transaction_timestamp()`),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [
  primaryKey({ name: 'master_bulk_batch_pk', columns: [table.organizationId, table.id] }),
  foreignKey({ name: 'master_bulk_batches_organization_id_fkey', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  foreignKey({ name: 'master_bulk_batch_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('master_bulk_batch_fields', sql`resource IN ('products','test-parameters','methods','users','customers')
  AND length(file_name) BETWEEN 1 AND 250 AND file_format IN ('csv','xlsx')
  AND ((resource='users' AND source_sha256 IS NULL AND source_hmac_sha256 IS NOT NULL AND source_hmac_sha256 ~ '^[a-f0-9]{64}$')
    OR (resource<>'users' AND source_hmac_sha256 IS NULL AND source_sha256 IS NOT NULL AND source_sha256 ~ '^[a-f0-9]{64}$'))
  AND length(time_zone) BETWEEN 1 AND 100 AND header_row_number>0
  AND column_count BETWEEN 1 AND 250 AND row_count BETWEEN 1 AND 2500
  AND ((file_format='csv' AND num_nonnulls(sheet_name,sheet_count,date_1904)=0)
    OR (file_format='xlsx' AND sheet_name IS NOT NULL AND length(sheet_name) BETWEEN 1 AND 100
      AND sheet_count IS NOT NULL AND sheet_count BETWEEN 1 AND 512 AND date_1904 IS NOT NULL))`),
  index('master_bulk_batch_list').on(table.organizationId, table.resource, table.savedAt.desc().nullsFirst(), table.id),
]);

export const masterBulkColumns = pgTable('master_bulk_columns', {
  organizationId: uuid('organization_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  columnNumber: integer('column_number').notNull(),
  sourceHeader: text('source_header').notNull(),
  sourceType: text('source_type'),
  formula: text('formula'),
  hasResult: boolean('has_result'),
  errorCode: text('error_code'),
  hyperlink: text('hyperlink'),
  numberFormat: text('number_format'),
}, table => [
  primaryKey({ name: 'master_bulk_column_pk', columns: [table.organizationId, table.batchId, table.columnNumber] }),
  foreignKey({ name: 'master_bulk_column_batch_fk', columns: [table.organizationId, table.batchId], foreignColumns: [masterBulkBatches.organizationId, masterBulkBatches.id] }),
  check('master_bulk_column_fields', sql`column_number BETWEEN 1 AND 250 AND length(source_header)<=16000
    AND (source_type IS NULL OR source_type IN ('formula','error','hyperlink','rich_text','formatted'))
    AND (formula IS NULL OR length(formula)<=16000) AND (error_code IS NULL OR length(error_code)<=16000)
    AND (hyperlink IS NULL OR length(hyperlink)<=16000) AND (number_format IS NULL OR length(number_format)<=16000)`),
]);

export const masterBulkRows = pgTable('master_bulk_rows', {
  organizationId: uuid('organization_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  id: uuid('id').notNull(),
  ordinal: integer('ordinal').notNull(),
  sourceRowNumber: integer('source_row_number').notNull(),
  revision: integer('revision').notNull().default(1),
}, table => [
  primaryKey({ name: 'master_bulk_row_pk', columns: [table.organizationId, table.batchId, table.id] }),
  foreignKey({ name: 'master_bulk_row_batch_fk', columns: [table.organizationId, table.batchId], foreignColumns: [masterBulkBatches.organizationId, masterBulkBatches.id] }),
  unique('master_bulk_row_order').on(table.organizationId, table.batchId, table.ordinal),
  unique('master_bulk_row_source').on(table.organizationId, table.batchId, table.sourceRowNumber),
  check('master_bulk_row_fields', sql`ordinal BETWEEN 1 AND 2500 AND source_row_number>0 AND revision>0`),
  foreignKey({ name: 'master_bulk_row_head_fk', columns: [table.organizationId, table.batchId, table.id, table.revision], foreignColumns: [masterBulkRowVersions.organizationId, masterBulkRowVersions.batchId, masterBulkRowVersions.rowId, masterBulkRowVersions.revision] }),
]);

export const masterBulkRowVersions = pgTable('master_bulk_row_versions', {
  organizationId: uuid('organization_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  rowId: uuid('row_id').notNull(),
  revision: integer('revision').notNull(),
  requestId: uuid('request_id').notNull(),
  savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`transaction_timestamp()`),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [
  primaryKey({ name: 'master_bulk_row_version_pk', columns: [table.organizationId, table.batchId, table.rowId, table.revision] }),
  unique('master_bulk_row_version_request').on(table.organizationId, table.requestId),
  foreignKey({ name: 'master_bulk_row_version_parent_fk', columns: [table.organizationId, table.batchId, table.rowId], foreignColumns: [masterBulkRows.organizationId, masterBulkRows.batchId, masterBulkRows.id] }),
  foreignKey({ name: 'master_bulk_row_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('master_bulk_row_version_fields', sql`revision>0`),
]);

export const masterBulkCells = pgTable('master_bulk_cells', {
  organizationId: uuid('organization_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  rowId: uuid('row_id').notNull(),
  revision: integer('revision').notNull(),
  columnNumber: integer('column_number').notNull(),
  valueKind: text('value_kind').notNull(),
  textValue: text('text_value'),
  numberValue: doublePrecision('number_value'),
  booleanValue: boolean('boolean_value'),
  dateValue: timestamp('date_value', { withTimezone: true, mode: 'date' }),
  sourceType: text('source_type'),
  formula: text('formula'),
  hasResult: boolean('has_result'),
  errorCode: text('error_code'),
  hyperlink: text('hyperlink'),
  numberFormat: text('number_format'),
}, table => [
  primaryKey({ name: 'master_bulk_cell_pk', columns: [table.organizationId, table.batchId, table.rowId, table.revision, table.columnNumber] }),
  foreignKey({ name: 'master_bulk_cell_version_fk', columns: [table.organizationId, table.batchId, table.rowId, table.revision], foreignColumns: [masterBulkRowVersions.organizationId, masterBulkRowVersions.batchId, masterBulkRowVersions.rowId, masterBulkRowVersions.revision] }),
  foreignKey({ name: 'master_bulk_cell_column_fk', columns: [table.organizationId, table.batchId, table.columnNumber], foreignColumns: [masterBulkColumns.organizationId, masterBulkColumns.batchId, masterBulkColumns.columnNumber] }),
  check('master_bulk_cell_value', sql`
    (value_kind='missing' AND num_nonnulls(text_value,number_value,boolean_value,date_value)=0)
    OR (num_nonnulls(text_value,number_value,boolean_value,date_value)=1 AND
      ((value_kind='text' AND text_value IS NOT NULL AND length(text_value)<=16000)
      OR (value_kind='number' AND number_value IS NOT NULL AND number_value BETWEEN '-1.7976931348623157e308'::double precision AND '1.7976931348623157e308'::double precision)
      OR (value_kind='boolean' AND boolean_value IS NOT NULL)
      OR (value_kind='date' AND date_value IS NOT NULL AND isfinite(date_value))))`),
  check('master_bulk_cell_source', sql`(source_type IS NULL OR source_type IN ('formula','error','hyperlink','rich_text','formatted','date'))
    AND (formula IS NULL OR length(formula)<=16000) AND (error_code IS NULL OR length(error_code)<=16000)
    AND (hyperlink IS NULL OR length(hyperlink)<=16000) AND (number_format IS NULL OR length(number_format)<=16000)`),
]);

export const masterBulkReviews = pgTable('master_bulk_reviews', {
  organizationId: uuid('organization_id').notNull(),
  id: uuid('id').notNull(),
  batchId: uuid('batch_id').notNull(),
  rowId: uuid('row_id').notNull(),
  inputRevision: integer('input_revision').notNull(),
  sequence: bigint('sequence', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
  valid: boolean('valid').notNull(),
  candidateId: uuid('candidate_id'),
  expectedRevision: integer('expected_revision'),
  operation: text('operation'),
  definitionsSha256: text('definitions_sha256'),
  commandSha256: text('command_sha256'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`transaction_timestamp()`),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [
  primaryKey({ name: 'master_bulk_review_pk', columns: [table.organizationId, table.id] }),
  unique('master_bulk_review_row_key').on(table.organizationId, table.batchId, table.rowId, table.inputRevision, table.id),
  foreignKey({ name: 'master_bulk_review_input_fk', columns: [table.organizationId, table.batchId, table.rowId, table.inputRevision], foreignColumns: [masterBulkRowVersions.organizationId, masterBulkRowVersions.batchId, masterBulkRowVersions.rowId, masterBulkRowVersions.revision] }),
  foreignKey({ name: 'master_bulk_review_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('master_bulk_review_fields', sql`
    (valid AND candidate_id IS NOT NULL AND expected_revision IS NOT NULL AND expected_revision>=0
      AND operation IS NOT NULL AND operation IN ('create','update','reactivate','update_retired')
      AND definitions_sha256 IS NOT NULL AND definitions_sha256 ~ '^[a-f0-9]{64}$'
      AND command_sha256 IS NOT NULL AND command_sha256 ~ '^[a-f0-9]{64}$' AND error_code IS NULL AND error_message IS NULL
      AND ((operation='create')=(expected_revision=0)))
    OR (NOT valid AND num_nonnulls(candidate_id,expected_revision,operation,definitions_sha256,command_sha256)=0
      AND error_code IS NOT NULL AND length(error_code) BETWEEN 1 AND 100 AND error_message IS NOT NULL AND length(error_message) BETWEEN 1 AND 2000)`),
  index('master_bulk_review_latest').on(table.organizationId, table.batchId, table.rowId, table.inputRevision, table.sequence.desc().nullsFirst()),
]);

export const masterBulkAttempts = pgTable('master_bulk_attempts', {
  organizationId: uuid('organization_id').notNull(),
  id: uuid('id').notNull(),
  batchId: uuid('batch_id').notNull(),
  rowId: uuid('row_id').notNull(),
  inputRevision: integer('input_revision').notNull(),
  reviewId: uuid('review_id').notNull(),
  sequence: bigint('sequence', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
  committed: boolean('committed').notNull(),
  productId: uuid('product_id'),
  parameterId: uuid('parameter_id'),
  methodId: uuid('method_id'),
  userId: uuid('user_id'),
  customerId: uuid('customer_id'),
  resultRevision: integer('result_revision'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`transaction_timestamp()`),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [
  primaryKey({ name: 'master_bulk_attempt_pk', columns: [table.organizationId, table.id] }),
  foreignKey({ name: 'master_bulk_attempt_review_fk', columns: [table.organizationId, table.batchId, table.rowId, table.inputRevision, table.reviewId], foreignColumns: [masterBulkReviews.organizationId, masterBulkReviews.batchId, masterBulkReviews.rowId, masterBulkReviews.inputRevision, masterBulkReviews.id] }),
  foreignKey({ name: 'master_bulk_attempt_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'master_bulk_attempt_product_fk', columns: [table.organizationId, table.productId, table.resultRevision], foreignColumns: [productVersions.organizationId, productVersions.productId, productVersions.revision] }),
  foreignKey({ name: 'master_bulk_attempt_parameter_fk', columns: [table.organizationId, table.parameterId, table.resultRevision], foreignColumns: [testParameterVersions.organizationId, testParameterVersions.parameterId, testParameterVersions.revision] }),
  foreignKey({ name: 'master_bulk_attempt_method_fk', columns: [table.organizationId, table.methodId, table.resultRevision], foreignColumns: [methodVersions.organizationId, methodVersions.methodId, methodVersions.revision] }),
  foreignKey({ name: 'master_bulk_attempt_user_fk', columns: [table.organizationId, table.userId, table.resultRevision], foreignColumns: [userProfileVersions.organizationId, userProfileVersions.userId, userProfileVersions.revision] }),
  foreignKey({ name: 'master_bulk_attempt_customer_fk', columns: [table.organizationId, table.customerId, table.resultRevision], foreignColumns: [customerVersions.organizationId, customerVersions.customerId, customerVersions.revision] }),
  check('master_bulk_attempt_fields', sql`
    (committed AND num_nonnulls(product_id,parameter_id,method_id,user_id,customer_id)=1 AND result_revision IS NOT NULL AND result_revision>0 AND error_code IS NULL AND error_message IS NULL)
    OR (NOT committed AND num_nonnulls(product_id,parameter_id,method_id,user_id,customer_id,result_revision)=0
      AND error_code IS NOT NULL AND length(error_code) BETWEEN 1 AND 100 AND error_message IS NOT NULL AND length(error_message) BETWEEN 1 AND 2000)`),
  uniqueIndex('master_bulk_one_commit').on(table.organizationId, table.batchId, table.rowId).where(sql`${table.committed}`),
  index('master_bulk_attempt_latest').on(table.organizationId, table.batchId, table.rowId, table.sequence.desc().nullsFirst()),
]);

export const masterBulkUserLabels = pgView('master_bulk_user_labels', {
  organizationId: uuid('organization_id'), id: uuid('id'), username: text('username'), email: text('email'), displayName: text('display_name'), active: boolean('active'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT member.organization_id,person.id,person.username,person.email,person.display_name,(member.active AND person.active) AS active
  FROM public.memberships member JOIN public.users person ON person.id=member.user_id
  WHERE member.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('masters.manage'))
`);

const binary = customType({ dataType: () => 'bytea' });
export const masterBulkUserCredentials = pgTable('master_bulk_user_credentials', {
  organizationId: uuid('organization_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  rowId: uuid('row_id').notNull(),
  inputRevision: integer('input_revision').notNull(),
  state: text('state').notNull(),
  fingerprint: binary('fingerprint').notNull(),
  passwordHash: text('password_hash'),
  savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`transaction_timestamp()`),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [
  primaryKey({ name: 'master_bulk_user_credential_pk', columns: [table.organizationId, table.batchId, table.rowId, table.inputRevision] }),
  foreignKey({ name: 'master_bulk_user_credential_input_fk', columns: [table.organizationId, table.batchId, table.rowId, table.inputRevision], foreignColumns: [masterBulkRowVersions.organizationId, masterBulkRowVersions.batchId, masterBulkRowVersions.rowId, masterBulkRowVersions.revision] }),
  foreignKey({ name: 'master_bulk_user_credential_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('master_bulk_user_credential_fields', sql`octet_length(fingerprint)=32
    AND ((state='valid' AND password_hash IS NOT NULL AND password_hash ~ '^scrypt[$]1[$]32768[$]8[$]1[$][A-Za-z0-9_-]{22}[$][A-Za-z0-9_-]{86}$')
      OR (state IN ('missing','invalid') AND password_hash IS NULL))`),
]);

export const masterBulkUserCredentialStates = pgView('master_bulk_user_credential_states', {
  organizationId: uuid('organization_id'), batchId: uuid('batch_id'), rowId: uuid('row_id'), inputRevision: integer('input_revision'),
  state: text('state'), fingerprint: text('fingerprint'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT organization_id,batch_id,row_id,input_revision,state,encode(fingerprint,'hex') AS fingerprint
  FROM public.master_bulk_user_credentials
  WHERE organization_id IS NOT DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('users.manage'))
`);
