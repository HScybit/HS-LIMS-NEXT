import { sql } from 'drizzle-orm';
import { pgTable, pgView, uuid, text, integer, boolean, timestamp, primaryKey, unique, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { products, tags, sampleCategories } from './master-schema.js';
import { templates } from './template-schema.js';

const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), productId: uuid('product_id').notNull(), revision: integer('revision').notNull() });
const versionColumns = (table) => [table.organizationId, table.productId, table.revision];

export const productVersions = pgTable('product_versions', {
  ...scope(), requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  code: text('code').notNull(), name: text('name').notNull(), description: text('description').notNull(), abbreviation: text('abbreviation'),
  jobTemplateId: uuid('job_template_id'), active: boolean('active').notNull(), tagCount: integer('tag_count').notNull(),
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
