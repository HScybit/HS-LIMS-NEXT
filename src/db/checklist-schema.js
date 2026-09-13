import { sql } from 'drizzle-orm';
import { pgTable, pgView, uuid, text, integer, boolean, timestamp, primaryKey, unique, index, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';

const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), checklistId: uuid('checklist_id').notNull() });
const versionKey = (table) => [table.organizationId, table.checklistId, table.revision];
const masterLink = (table, name) => foreignKey({ name,
  columns: [table.organizationId, table.checklistId], foreignColumns: [checklists.organizationId, checklists.id] });

export const checklists = pgTable('checklists', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), id: uuid('id').primaryKey(),
  name: text('name').notNull(), isActive: boolean('is_active').notNull().default(true), revision: integer('revision').notNull().default(0),
  createdBy: uuid('created_by'), createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }),
  updatedBy: uuid('updated_by'), updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
  retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  unique('checklist_tenant_key').on(table.organizationId, table.id),
  foreignKey({ name: 'checklist_creator_fk', columns: [table.organizationId, table.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'checklist_editor_fk', columns: [table.organizationId, table.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('checklist_revision', sql`${table.revision}>=0`),
  index('checklist_name_lookup').on(table.organizationId, table.name).where(sql`${table.retiredAt} is null`),
]);

export const checklistItems = pgTable('checklist_items', {
  ...scope(), id: uuid('id').notNull(), prompt: text('prompt').notNull(), displayOrder: integer('display_order').notNull(),
}, (table) => [
  primaryKey({ name: 'checklist_item_pk', columns: [table.organizationId, table.checklistId, table.id] }),
  masterLink(table, 'checklist_item_master_fk'), unique('checklist_item_order').on(table.organizationId, table.checklistId, table.displayOrder),
  check('checklist_item_position', sql`${table.displayOrder}>=0`),
]);

export const checklistVersions = pgTable('checklist_versions', {
  ...scope(), revision: integer('revision').notNull(), requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'),
  operation: text('operation').notNull(), name: text('name').notNull(), isActive: boolean('is_active').notNull(),
  retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }), itemCount: integer('item_count').notNull(),
  nameProvided: boolean('name_provided').notNull(), activeProvided: boolean('active_provided').notNull(), itemsProvided: boolean('items_provided').notNull(),
  savedBy: uuid('saved_by').notNull(), savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (table) => [
  primaryKey({ name: 'checklist_version_pk', columns: versionKey(table) }), masterLink(table, 'checklist_version_master_fk'),
  unique('checklist_save_request_key').on(table.organizationId, table.requestId),
  foreignKey({ name: 'checklist_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('checklist_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1)
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>=0 and ${table.revision}=${table.previousRevision}+1)`),
  check('checklist_version_fields', sql`${table.itemCount}>=0 and ((${table.operation}='retire')=(${table.retiredAt} is not null))
    and (${table.operation}<>'retire' or not (${table.nameProvided} or ${table.activeProvided} or ${table.itemsProvided}))`),
  index('checklist_version_time').on(table.organizationId, table.savedAt),
]);

export const checklistVersionItems = pgTable('checklist_version_items', {
  ...scope(), revision: integer('revision').notNull(), id: uuid('id').notNull(), prompt: text('prompt').notNull(), displayOrder: integer('display_order').notNull(),
}, (table) => [
  primaryKey({ name: 'checklist_version_item_pk', columns: [...versionKey(table), table.id] }),
  foreignKey({ name: 'checklist_version_item_parent_fk', columns: versionKey(table), foreignColumns: versionKey(checklistVersions) }),
  unique('checklist_version_item_order').on(...versionKey(table), table.displayOrder),
  check('checklist_version_item_position', sql`${table.displayOrder}>=0`),
]);

// Workflow selectors need labels without granting Checklist Master/history access.
export const workflowChecklistLabels = pgView('workflow_checklist_labels', {
  organizationId: uuid('organization_id'), id: uuid('id'), name: text('name'), isActive: boolean('is_active'), revision: integer('revision'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT organization_id,id,name,is_active,revision FROM public.checklists
  WHERE retired_at is null AND organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('workflows.read') OR public.app_has_permission('workflows.manage'))
`);
