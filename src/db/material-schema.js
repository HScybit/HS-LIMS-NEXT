import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, integer, timestamp, primaryKey, unique, uniqueIndex, index, foreignKey, check, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';

const time = name => timestamp(name, { withTimezone: true, mode: 'date' });
const transactionId = customType({ dataType: () => 'xid8' });

export const materialCategories = pgTable('material_categories', {
  organizationId: uuid('organization_id').notNull(), id: uuid('id').notNull().defaultRandom(),
  name: text('name').notNull(), description: text('description').notNull().default(''),
  reusable: boolean('reusable').notNull().default(false), expirable: boolean('expirable').notNull().default(false),
  active: boolean('active').notNull().default(true), revision: integer('revision').notNull().default(1), saveRequestId: uuid('save_request_id'),
  createdBy: uuid('created_by'), updatedBy: uuid('updated_by'), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, table => [primaryKey({ name: 'material_categories_pkey', columns: [table.organizationId, table.id] }),
  foreignKey({ name: 'material_categories_organization_id_fkey', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  uniqueIndex('material_category_active_name').on(table.organizationId, sql`lower(${table.name})`).where(sql`${table.active}`),
  index('material_category_created').on(table.organizationId, table.createdAt, table.id).where(sql`${table.active}`),
  foreignKey({ name: 'material_category_creator_fk', columns: [table.organizationId, table.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'material_category_editor_fk', columns: [table.organizationId, table.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('material_category_fields', sql`length(trim(${table.name})) between 1 and 200 and length(${table.description})<=16000 and ${table.revision}>0`),
]);

export const materialCategoryVersions = pgTable('material_category_versions', {
  organizationId: uuid('organization_id').notNull(), categoryId: uuid('category_id').notNull(), revision: integer('revision').notNull(),
  requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  name: text('name').notNull(), description: text('description').notNull(), reusable: boolean('reusable').notNull(), expirable: boolean('expirable').notNull(), active: boolean('active').notNull(),
  savedBy: uuid('saved_by').notNull(), savedAt: time('saved_at').notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, table => [primaryKey({ name: 'material_category_version_pk', columns: [table.organizationId, table.categoryId, table.revision] }),
  foreignKey({ name: 'material_category_versions_organization_id_fkey', columns: [table.organizationId], foreignColumns: [organizations.id] }),
  unique('material_category_save_request').on(table.organizationId, table.requestId),
  foreignKey({ name: 'material_category_version_parent_fk', columns: [table.organizationId, table.categoryId], foreignColumns: [materialCategories.organizationId, materialCategories.id] }),
  foreignKey({ name: 'material_category_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('material_category_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1 and ${table.active})
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>0 and ${table.revision}=${table.previousRevision}+1
      and ${table.active}=(${table.operation}='update'))`),
  check('material_category_version_fields', sql`length(trim(${table.name})) between 1 and 200 and length(${table.description})<=16000`),
]);
