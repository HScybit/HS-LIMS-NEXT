import { sql } from 'drizzle-orm';
import { pgTable, pgView, uuid, text, integer, boolean, timestamp, primaryKey, unique, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { methodsOfAnalysis } from './master-schema.js';

const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), methodId: uuid('method_id').notNull(), revision: integer('revision').notNull() });
const versionColumns = (table) => [table.organizationId, table.methodId, table.revision];

export const methodVersions = pgTable('method_versions', {
  ...scope(), requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  code: text('code').notNull(), methodUuid: text('method_uuid').notNull(), name: text('name').notNull(), description: text('description').notNull(),
  decimalScale: integer('decimal_scale').notNull(), parseNumber: boolean('parse_number').notNull(), active: boolean('active').notNull(),
  accessUserCount: integer('access_user_count').notNull(), savedBy: uuid('saved_by').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (table) => [
  primaryKey({ name: 'method_version_pk', columns: versionColumns(table) }),
  unique('method_save_request_key').on(table.organizationId, table.requestId),
  foreignKey({ name: 'method_version_parent_fk', columns: [table.organizationId, table.methodId], foreignColumns: [methodsOfAnalysis.organizationId, methodsOfAnalysis.id] }),
  foreignKey({ name: 'method_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('method_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1)
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>0 and ${table.revision}=${table.previousRevision}+1)`),
  check('method_version_fields', sql`length(trim(${table.name})) between 1 and 250
    and (${table.operation}='retire' or (length(trim(${table.name}))<=200 and length(${table.description})<=16000))
    and length(trim(${table.code})) between 1 and 64 and length(trim(${table.methodUuid})) between 1 and 100
    and ${table.decimalScale} between 0 and 12 and ${table.accessUserCount} between 0 and 500
    and (${table.operation}<>'retire' or not ${table.active})`),
]);

export const methodVersionUsers = pgTable('method_version_users', {
  ...scope(), userId: uuid('user_id').notNull(), position: integer('position').notNull(),
}, (table) => [
  primaryKey({ name: 'method_version_user_pk', columns: [...versionColumns(table), table.userId] }),
  unique('method_version_user_position').on(...versionColumns(table), table.position),
  foreignKey({ name: 'method_version_user_parent_fk', columns: versionColumns(table), foreignColumns: versionColumns(methodVersions) }),
  foreignKey({ name: 'method_version_user_member_fk', columns: [table.organizationId, table.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('method_version_user_order', sql`${table.position} between 0 and 499`),
]);

// A narrow read projection for method access selection/display. Base identity
// tables retain their private grants; the barrier filters tenant/permission first.
export const methodAccessUserLabels = pgView('method_access_user_labels', {
  organizationId: uuid('organization_id'), userId: uuid('user_id'), displayName: text('display_name'), active: boolean('active'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT member.organization_id,person.id AS user_id,person.display_name,(member.active AND person.active) AS active
  FROM public.memberships member JOIN public.users person ON person.id=member.user_id
  WHERE member.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('masters.read') OR public.app_has_permission('masters.manage'))
`);
