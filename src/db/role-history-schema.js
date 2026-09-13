import { sql } from 'drizzle-orm';
import { pgTable, pgView, uuid, text, integer, boolean, timestamp, primaryKey, unique, index, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships, roles, permissions } from './schema.js';
import { roleCapabilityKeys } from '../roles/capabilities.js';

const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), roleId: uuid('role_id').notNull() });
const versionColumns = (table) => [table.organizationId, table.roleId, table.revision];
const validCapability = (column) => sql`${column} in (${sql.raw(roleCapabilityKeys.map((key) => `'${key}'`).join(','))})`;

export const roleCapabilities = pgTable('role_capabilities', {
  ...scope(), capabilityKey: text('capability_key').notNull(),
}, (table) => [
  primaryKey({ name: 'role_capability_pk', columns: [table.organizationId, table.roleId, table.capabilityKey] }),
  foreignKey({ name: 'role_capability_role_fk', columns: [table.organizationId, table.roleId], foreignColumns: [roles.organizationId, roles.id] }),
  check('role_capability_key', validCapability(table.capabilityKey)),
]);

export const roleVersions = pgTable('role_versions', {
  ...scope(), revision: integer('revision').notNull(), requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'),
  operation: text('operation').notNull(), name: text('name').notNull(), description: text('description').notNull(), defaultPath: text('default_path'),
  active: boolean('active').notNull(), protected: boolean('protected').notNull(),
  permissionCount: integer('permission_count').notNull(), capabilityCount: integer('capability_count').notNull(),
  descriptionProvided: boolean('description_provided').notNull(), defaultPathProvided: boolean('default_path_provided').notNull(),
  permissionsProvided: boolean('permissions_provided').notNull(), capabilitiesProvided: boolean('capabilities_provided').notNull(),
  savedBy: uuid('saved_by').notNull(), savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (table) => [
  primaryKey({ name: 'role_version_pk', columns: versionColumns(table) }),
  unique('role_save_request_key').on(table.organizationId, table.requestId),
  foreignKey({ name: 'role_version_role_fk', columns: [table.organizationId, table.roleId], foreignColumns: [roles.organizationId, roles.id] }),
  foreignKey({ name: 'role_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('role_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1)
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>=0 and ${table.revision}=${table.previousRevision}+1)`),
  check('role_version_fields', sql`length(trim(${table.name})) between 1 and 150 and length(${table.description})<=2000
    and (${table.defaultPath} is null or length(${table.defaultPath})<=300) and (${table.active}=(${table.operation}<>'retire'))
    and (not ${table.protected} or ${table.active}) and ${table.permissionCount} between 0 and 500 and ${table.capabilityCount} between 0 and 18
    and (${table.operation}<>'retire' or not (${table.descriptionProvided} or ${table.defaultPathProvided} or ${table.permissionsProvided} or ${table.capabilitiesProvided}))`),
  index('role_version_time').on(table.organizationId, table.savedAt),
]);

export const roleVersionPermissions = pgTable('role_version_permissions', {
  ...scope(), revision: integer('revision').notNull(), permissionCode: text('permission_code').notNull().references(() => permissions.code),
}, (table) => [
  primaryKey({ name: 'role_version_permission_pk', columns: [...versionColumns(table), table.permissionCode] }),
  foreignKey({ name: 'role_version_permission_parent_fk', columns: versionColumns(table), foreignColumns: versionColumns(roleVersions) }),
]);

export const roleVersionCapabilities = pgTable('role_version_capabilities', {
  ...scope(), revision: integer('revision').notNull(), capabilityKey: text('capability_key').notNull(),
}, (table) => [
  primaryKey({ name: 'role_version_capability_pk', columns: [...versionColumns(table), table.capabilityKey] }),
  foreignKey({ name: 'role_version_capability_parent_fk', columns: versionColumns(table), foreignColumns: versionColumns(roleVersions) }),
  check('role_version_capability_key', validCapability(table.capabilityKey)),
]);

// Role Master needs one visibility setting, without granting the organization settings page.
export const roleManagementSettings = pgView('role_management_settings', {
  organizationId: uuid('organization_id'), selfAllocationEnabled: boolean('self_allocation_enabled'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT organization.id AS organization_id,coalesce(settings.self_allocation_enabled,false) AS self_allocation_enabled
  FROM public.organizations organization LEFT JOIN public.organization_laboratory_settings settings ON settings.organization_id=organization.id
  WHERE organization.id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('roles.read') OR public.app_has_permission('roles.manage'))
`);
