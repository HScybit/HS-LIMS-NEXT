import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, integer, date, timestamp, primaryKey, unique, index, foreignKey, check, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { testParameters, products, methodsOfAnalysis } from './master-schema.js';

const time = name => timestamp(name, { withTimezone: true, mode: 'date' });
const transactionId = customType({ dataType: () => 'xid8' });
const bytes = customType({ dataType: () => 'bytea' });
const versionColumns = table => [table.organizationId, table.certificationId, table.revision];
const scopeColumns = table => [...versionColumns(table), table.parameterId];
const scope = () => ({ organizationId: uuid('organization_id').notNull(), certificationId: uuid('certification_id').notNull(), revision: integer('revision').notNull() });

export const nablFiles = pgTable('nabl_files', {
  organizationId: uuid('organization_id').notNull(), id: uuid('id').notNull(),
  originalName: text('original_name').notNull(), mediaType: text('media_type').notNull(), content: bytes('content').notNull(),
  byteLength: integer('byte_length').notNull(), sha256: text('sha256').notNull(), uploadedBy: uuid('uploaded_by').notNull(),
  uploadedByUsername: text('uploaded_by_username').notNull(), uploadedByName: text('uploaded_by_name').notNull(),
  uploadedAt: time('uploaded_at').notNull().defaultNow(), createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [
  primaryKey({ name: 'nabl_file_pk', columns: [table.organizationId, table.id] }),
  foreignKey({ name: 'nabl_files_organization_id_fkey', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  foreignKey({ name: 'nabl_file_actor_fk', columns: [table.organizationId, table.uploadedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('nabl_file_fields', sql`length(${table.originalName}) between 1 and 500 and ${table.originalName}=trim(${table.originalName})
    and ${table.originalName} !~ '[[:cntrl:]]' and position('/' in ${table.originalName})=0 and position(chr(92) in ${table.originalName})=0
    and length(${table.mediaType}) between 1 and 255 and ${table.mediaType}=lower(${table.mediaType})
    and ${table.mediaType} ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
    and ${table.byteLength} between 0 and 26214400 and ${table.byteLength}=octet_length(${table.content}) and ${table.sha256}=encode(sha256(${table.content}),'hex')`),
]);

export const nablCertifications = pgTable('nabl_certifications', {
  organizationId: uuid('organization_id').notNull(), id: uuid('id').notNull(),
  revision: integer('revision').notNull().default(1), active: boolean('active').notNull().default(true), createdBy: uuid('created_by').notNull(),
  createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, table => [primaryKey({ name: 'nabl_certification_pk', columns: [table.organizationId, table.id] }),
  foreignKey({ name: 'nabl_certifications_organization_id_fkey', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  foreignKey({ name: 'nabl_certification_actor_fk', columns: [table.organizationId, table.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('nabl_certification_revision', sql`${table.revision}>0`),
  index('nabl_certification_listing').on(table.organizationId, table.createdAt, table.id).where(sql`${table.active}`),
]);

export const nablCertificateVersions = pgTable('nabl_certificate_versions', {
  ...scope(), previousRevision: integer('previous_revision'), requestId: uuid('request_id').notNull(), operation: text('operation').notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(), validTo: date('valid_to', { mode: 'string' }).notNull(),
  scopeFileId: uuid('scope_file_id'), certificateFileId: uuid('certificate_file_id'), scopeCount: integer('scope_count').notNull(), active: boolean('active').notNull(),
  savedBy: uuid('saved_by').notNull(), savedByUsername: text('saved_by_username').notNull(), savedByName: text('saved_by_name').notNull(),
  savedAt: time('saved_at').notNull().defaultNow(), createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [primaryKey({ name: 'nabl_version_pk', columns: versionColumns(table) }), unique('nabl_request_key').on(table.organizationId, table.requestId),
  foreignKey({ name: 'nabl_version_parent_fk', columns: [table.organizationId, table.certificationId], foreignColumns: [nablCertifications.organizationId, nablCertifications.id] }),
  foreignKey({ name: 'nabl_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'nabl_scope_file_fk', columns: [table.organizationId, table.scopeFileId], foreignColumns: [nablFiles.organizationId, nablFiles.id] }),
  foreignKey({ name: 'nabl_certificate_file_fk', columns: [table.organizationId, table.certificateFileId], foreignColumns: [nablFiles.organizationId, nablFiles.id] }),
  check('nabl_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1 and ${table.active})
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>0 and ${table.revision}=${table.previousRevision}+1 and ${table.active}=(${table.operation}='update'))`),
  check('nabl_version_fields', sql`${table.validFrom} between date '0001-01-01' and date '9999-12-31'
    and ${table.validTo} between ${table.validFrom} and date '9999-12-31' and ${table.scopeCount}>=0`),
]);

export const nablScopeRows = pgTable('nabl_scope_rows', {
  ...scope(), parameterId: uuid('parameter_id').notNull(), position: integer('position').notNull(), parameterName: text('parameter_name').notNull(),
  schemeAbbreviation: text('scheme_abbreviation').notNull(), parameterRevision: integer('parameter_revision').notNull(),
  productCount: integer('product_count').notNull(), methodCount: integer('method_count').notNull(),
}, table => [primaryKey({ name: 'nabl_scope_pk', columns: scopeColumns(table) }), unique('nabl_scope_position').on(...versionColumns(table), table.position),
  foreignKey({ name: 'nabl_scope_version_fk', columns: versionColumns(table), foreignColumns: versionColumns(nablCertificateVersions) }),
  foreignKey({ name: 'nabl_scope_parameter_fk', columns: [table.organizationId, table.parameterId], foreignColumns: [testParameters.organizationId, testParameters.id] }),
  check('nabl_scope_fields', sql`${table.position}>=0 and ${table.parameterRevision}>0 and ${table.productCount}>=0 and ${table.methodCount}>=0`),
]);

export const nablScopeProducts = pgTable('nabl_scope_products', {
  ...scope(), parameterId: uuid('parameter_id').notNull(), productId: uuid('product_id').notNull(), position: integer('position').notNull(),
  productName: text('product_name').notNull(), productRevision: integer('product_revision').notNull(),
}, table => [primaryKey({ name: 'nabl_scope_product_pk', columns: [...scopeColumns(table), table.productId] }),
  unique('nabl_scope_product_position').on(...scopeColumns(table), table.position),
  foreignKey({ name: 'nabl_scope_product_parent_fk', columns: scopeColumns(table), foreignColumns: scopeColumns(nablScopeRows) }),
  foreignKey({ name: 'nabl_scope_product_reference_fk', columns: [table.organizationId, table.productId], foreignColumns: [products.organizationId, products.id] }),
  check('nabl_scope_product_fields', sql`${table.position}>=0 and ${table.productRevision}>0`),
]);

export const nablScopeMethods = pgTable('nabl_scope_methods', {
  ...scope(), parameterId: uuid('parameter_id').notNull(), methodId: uuid('method_id').notNull(), position: integer('position').notNull(),
  methodName: text('method_name').notNull(), methodRevision: integer('method_revision').notNull(),
}, table => [primaryKey({ name: 'nabl_scope_method_pk', columns: [...scopeColumns(table), table.methodId] }),
  unique('nabl_scope_method_position').on(...scopeColumns(table), table.position),
  foreignKey({ name: 'nabl_scope_method_parent_fk', columns: scopeColumns(table), foreignColumns: scopeColumns(nablScopeRows) }),
  foreignKey({ name: 'nabl_scope_method_reference_fk', columns: [table.organizationId, table.methodId], foreignColumns: [methodsOfAnalysis.organizationId, methodsOfAnalysis.id] }),
  check('nabl_scope_method_fields', sql`${table.position}>=0 and ${table.methodRevision}>0`),
]);
