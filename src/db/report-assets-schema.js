import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, numeric, boolean, timestamp, primaryKey, unique, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';

const bytes = customType({ dataType: () => 'bytea' });
const transactionId = customType({ dataType: () => 'xid8' });
export const reportImageAssets = pgTable('report_image_assets', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), id: uuid('id').notNull(),
  originalName: text('original_name').notNull(), mediaType: text('media_type').notNull(), content: bytes('content').notNull(),
  byteLength: integer('byte_length').notNull(), sha256: text('sha256').notNull(), width: integer('width').notNull(), height: integer('height').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(), uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [primaryKey({ name: 'report_image_asset_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'report_image_asset_actor_fk', columns: [t.organizationId, t.uploadedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('report_image_asset_shape', sql`${t.mediaType} in ('image/png','image/jpeg','image/webp','image/svg+xml')
    and length(trim(${t.originalName})) between 1 and 255 and ${t.sha256} ~ '^[a-f0-9]{64}$'
    and ${t.byteLength} between 1 and 10485760 and ${t.byteLength}=octet_length(${t.content})
    and ${t.width} between 1 and 10000 and ${t.height} between 1 and 10000 and ${t.width}::bigint*${t.height}::bigint<=40000000`),
]);

export const reportDocuments = pgTable('report_documents', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), id: uuid('id').notNull(),
  type: text('type').notNull(), createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [primaryKey({ name: 'report_document_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'report_document_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('report_document_type', sql`${t.type} in ('header','footer')`),
]);

export const reportDocumentVersions = pgTable('report_document_versions', {
  organizationId: uuid('organization_id').notNull(), id: uuid('id').notNull(), documentId: uuid('document_id').notNull(),
  revision: integer('revision').notNull(), name: text('name').notNull(), templateHtml: text('template_html').notNull(),
  isRetired: boolean('is_retired').notNull(), requestedDefault: boolean('requested_default').notNull(),
  savedBy: uuid('saved_by').notNull(), savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  transactionId: transactionId('transaction_id').notNull(),
}, (t) => [primaryKey({ name: 'report_document_version_pk', columns: [t.organizationId, t.id] }),
  unique('report_document_revision_key').on(t.organizationId, t.documentId, t.revision),
  unique('report_document_version_identity_key').on(t.organizationId, t.documentId, t.id),
  foreignKey({ name: 'report_document_version_document_fk', columns: [t.organizationId, t.documentId], foreignColumns: [reportDocuments.organizationId, reportDocuments.id] }),
  foreignKey({ name: 'report_document_version_actor_fk', columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('report_document_version_shape', sql`${t.revision}>0 and length(trim(${t.name})) between 1 and 200 and length(${t.templateHtml})<=1000000 and not (${t.isRetired} and ${t.requestedDefault})`),
]);

export const reportDocumentImages = pgTable('report_document_images', {
  organizationId: uuid('organization_id').notNull(), versionId: uuid('version_id').notNull(), imageId: uuid('image_id').notNull(),
}, (t) => [primaryKey({ name: 'report_document_image_pk', columns: [t.organizationId, t.versionId, t.imageId] }),
  foreignKey({ name: 'report_document_image_version_fk', columns: [t.organizationId, t.versionId], foreignColumns: [reportDocumentVersions.organizationId, reportDocumentVersions.id] }),
  foreignKey({ name: 'report_document_image_asset_fk', columns: [t.organizationId, t.imageId], foreignColumns: [reportImageAssets.organizationId, reportImageAssets.id] }),
]);

// This is the current default selection. Its source save is retained as an
// immutable version; a generated report will reference the selected version.
export const reportDocumentDefaults = pgTable('report_document_defaults', {
  organizationId: uuid('organization_id').primaryKey().references(() => organizations.id),
  defaultHeaderId: uuid('default_header_id'), changedVersionId: uuid('changed_version_id').notNull(),
}, (t) => [
  foreignKey({ name: 'report_document_default_header_fk', columns: [t.organizationId, t.defaultHeaderId], foreignColumns: [reportDocuments.organizationId, reportDocuments.id] }),
  foreignKey({ name: 'report_document_default_change_fk', columns: [t.organizationId, t.changedVersionId], foreignColumns: [reportDocumentVersions.organizationId, reportDocumentVersions.id] }),
]);

export const reportWatermarks = pgTable('report_watermarks', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), id: uuid('id').notNull(),
  createdBy: uuid('created_by').notNull(), createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [primaryKey({ name: 'report_watermark_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'report_watermark_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
]);

export const reportWatermarkVersions = pgTable('report_watermark_versions', {
  organizationId: uuid('organization_id').notNull(), id: uuid('id').notNull(), watermarkId: uuid('watermark_id').notNull(),
  revision: integer('revision').notNull(), name: text('name').notNull(), imageId: uuid('image_id').notNull(),
  opacity: numeric('opacity').notNull(), width: integer('width').notNull(), height: integer('height').notNull(), rotation: integer('rotation').notNull(),
  isRetired: boolean('is_retired').notNull(), savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(), transactionId: transactionId('transaction_id').notNull(),
}, (t) => [primaryKey({ name: 'report_watermark_version_pk', columns: [t.organizationId, t.id] }),
  unique('report_watermark_revision_key').on(t.organizationId, t.watermarkId, t.revision),
  foreignKey({ name: 'report_watermark_version_watermark_fk', columns: [t.organizationId, t.watermarkId], foreignColumns: [reportWatermarks.organizationId, reportWatermarks.id] }),
  foreignKey({ name: 'report_watermark_version_image_fk', columns: [t.organizationId, t.imageId], foreignColumns: [reportImageAssets.organizationId, reportImageAssets.id] }),
  foreignKey({ name: 'report_watermark_version_actor_fk', columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('report_watermark_version_shape', sql`${t.revision}>0 and length(trim(${t.name})) between 1 and 200 and ${t.opacity} between 0 and 1
    and ${t.width} between 1 and 10000 and ${t.height} between 1 and 10000 and ${t.rotation} in (0,90,180,270,360)`),
]);
