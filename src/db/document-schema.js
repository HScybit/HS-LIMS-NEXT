import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, integer, date, timestamp, primaryKey, foreignKey, check, index, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { workflows } from './workflow-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytes = customType({ dataType: () => 'bytea' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);

// Step 10g part 1: Document Management System foundation — categories,
// upload/versioning. workflowId (added in step 10g part 2, migration 0216)
// ties a category to the shared workflow/approval engine, extended with a
// 'document' owner type on workflow_runs — see 0216 and
// .local-migration/PENDING_DECISIONS.md for the full blast-radius audit
// behind that extension. Every new document version gets its own fresh
// workflow run (mirroring Meteor: a new version starts its own approval
// cycle rather than inheriting the previous version's approved state).
export const documentCategories = pgTable('document_categories', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  name: text('name').notNull(), description: text('description'), expiryApplicable: boolean('expiry_applicable').notNull().default(false),
  workflowId: uuid('workflow_id'),
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'document_category_created_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'document_category_updated_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'document_category_workflow_fk', columns: [t.organizationId, t.workflowId], foreignColumns: [workflows.organizationId, workflows.id] }),
  check('document_category_fields', sql`length(trim(${t.name})) between 1 and 200 and (${t.description} is null or length(${t.description}) between 1 and 10000) and ${t.revision} > 0`),
]);

export const documentCategoryAccess = pgTable('document_category_access', {
  organizationId: tenant(), documentCategoryId: uuid('document_category_id').notNull(), userId: uuid('user_id').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.documentCategoryId, t.userId] }),
  foreignKey({ name: 'document_category_access_category_fk', columns: [t.organizationId, t.documentCategoryId], foreignColumns: [documentCategories.organizationId, documentCategories.id] }),
  foreignKey({ name: 'document_category_access_user_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
]);

export const documentFiles = pgTable('document_files', {
  organizationId: tenant(), id: uuid('id').notNull(),
  originalName: text('original_name').notNull(), mediaType: text('media_type').notNull(), content: bytes('content').notNull(),
  byteLength: integer('byte_length').notNull(), sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(), uploadedAt: time('uploaded_at').notNull().defaultNow(),
}, (t) => [primaryKey({ name: 'document_file_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'document_file_actor_fk', columns: [t.organizationId, t.uploadedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('document_file_fields', sql`length(${t.originalName}) between 1 and 500 and ${t.originalName}=trim(${t.originalName})
    and ${t.originalName} !~ '[[:cntrl:]]' and position('/' in ${t.originalName})=0 and position(chr(92) in ${t.originalName})=0
    and length(${t.mediaType}) between 1 and 255 and ${t.mediaType}=lower(${t.mediaType})
    and ${t.mediaType} ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
    and ${t.byteLength} between 0 and 26214400 and ${t.byteLength}=octet_length(${t.content}) and ${t.sha256}=encode(sha256(${t.content}),'hex')`),
]);

// A "document" row is one version. parent_document_id chains versions of the
// same logical document together; is_latest names the current tip of that
// chain (maintained here at write time, matching Meteor's own actively-
// maintained latest/prev_version booleans rather than deriving it live).
export const documents = pgTable('documents', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  name: text('name').notNull(), description: text('description'), documentCategoryId: uuid('document_category_id').notNull(),
  fileId: uuid('file_id').notNull(), parentDocumentId: uuid('parent_document_id'), versionLabel: text('version_label'),
  isLatest: boolean('is_latest').notNull().default(true), expiryDate: date('expiry_date', { mode: 'string' }),
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'document_category_fk', columns: [t.organizationId, t.documentCategoryId], foreignColumns: [documentCategories.organizationId, documentCategories.id] }),
  foreignKey({ name: 'document_file_fk', columns: [t.organizationId, t.fileId], foreignColumns: [documentFiles.organizationId, documentFiles.id] }),
  foreignKey({ name: 'document_parent_fk', columns: [t.organizationId, t.parentDocumentId], foreignColumns: [t.organizationId, t.id] }),
  foreignKey({ name: 'document_created_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'document_updated_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('document_fields', sql`length(trim(${t.name})) between 1 and 200 and (${t.description} is null or length(${t.description}) between 1 and 10000)
    and (${t.versionLabel} is null or length(trim(${t.versionLabel})) between 1 and 100) and ${t.parentDocumentId} is distinct from ${t.id} and ${t.revision} > 0`),
  index('document_category_listing').on(t.organizationId, t.documentCategoryId, t.createdAt, t.id),
]);
