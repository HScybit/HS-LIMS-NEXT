import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, boolean, timestamp, integer, bigint, primaryKey,
  uniqueIndex, index, check, foreignKey,
} from 'drizzle-orm/pg-core';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().defaultRandom();

export const organizations = pgTable('organizations', {
  id: id(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: time('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('organizations_code_key').on(sql`lower(${table.code})`)]);

// Global identities are separate from organization membership. Email is not identity.
export const users = pgTable('users', {
  id: id(),
  username: text('username').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  active: boolean('active').notNull().default(true),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  revision: integer('revision').notNull().default(1),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('users_username_key').on(sql`lower(${table.username})`),
  index('users_email_lookup').on(sql`lower(${table.email})`),
  check('users_name_length', sql`length(trim(${table.displayName})) between 1 and 200`),
  check('users_username_length', sql`length(trim(${table.username})) between 1 and 100`),
]);

export const credentials = pgTable('credentials', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  passwordHash: text('password_hash').notNull(),
  revision: integer('revision').notNull().default(1),
  updatedAt: time('updated_at').notNull().defaultNow(),
});

export const memberships = pgTable('memberships', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  active: boolean('active').notNull().default(true),
  // Zero preserves an observed membership without inventing historical status changes.
  statusRevision: integer('status_revision').notNull().default(0),
  signatureRevision: integer('signature_revision').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: time('created_at').notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.userId] }),
  uniqueIndex('memberships_default_user_key').on(table.userId).where(sql`${table.isDefault}`),
  check('membership_status_revision', sql`${table.statusRevision}>=0`),
  check('membership_signature_revision', sql`${table.signatureRevision}>=0`),
]);

export const roles = pgTable('roles', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  id: uuid('id').notNull().defaultRandom(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  defaultPath: text('default_path'),
  active: boolean('active').notNull().default(true),
  protected: boolean('protected').notNull().default(false),
  // Pre-existing roles have no invented creation event. Their first edit records revision one.
  revision: integer('revision').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.id] }),
  uniqueIndex('roles_name_key').on(table.organizationId, sql`lower(${table.name})`),
  check('role_fields', sql`length(trim(${table.name})) between 1 and 150 and length(${table.description})<=2000
    and (${table.defaultPath} is null or length(${table.defaultPath})<=300) and ${table.revision}>=0
    and (not ${table.protected} or ${table.active})`),
]);

export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(),
  description: text('description').notNull(),
});

export const rolePermissions = pgTable('role_permissions', {
  organizationId: uuid('organization_id').notNull(),
  roleId: uuid('role_id').notNull(),
  permissionCode: text('permission_code').notNull().references(() => permissions.code),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.roleId, table.permissionCode] }),
  foreignKey({ columns: [table.organizationId, table.roleId], foreignColumns: [roles.organizationId, roles.id] }),
]);

export const membershipRoles = pgTable('membership_roles', {
  organizationId: uuid('organization_id').notNull(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.userId, table.roleId] }),
  index('membership_roles_role').on(table.organizationId, table.roleId, table.userId),
  foreignKey({ columns: [table.organizationId, table.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ columns: [table.organizationId, table.roleId], foreignColumns: [roles.organizationId, roles.id] }),
]);

export const sessions = pgTable('sessions', {
  id: id(),
  organizationId: uuid('organization_id').notNull(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  csrfHash: text('csrf_hash').notNull(),
  credentialRevision: integer('credential_revision').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  expiresAt: time('expires_at').notNull(),
  revokedAt: time('revoked_at'),
}, (table) => [
  uniqueIndex('sessions_token_key').on(table.tokenHash),
  index('sessions_user_active').on(table.userId, table.createdAt).where(sql`${table.revokedAt} is null`),
  foreignKey({ columns: [table.organizationId, table.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('sessions_valid_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
  check('sessions_hash_lengths', sql`${table.tokenHash} ~ '^[a-f0-9]{64}$' and ${table.csrfHash} ~ '^[a-f0-9]{64}$'`),
]);

export const loginLimits = pgTable('login_limits', {
  lookupHash: text('lookup_hash').primaryKey(),
  attempts: integer('attempts').notNull(),
  windowStartedAt: time('window_started_at').notNull().defaultNow(),
});

export const passwordResets = pgTable('password_resets', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  credentialRevision: integer('credential_revision').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  expiresAt: time('expires_at').notNull(),
  usedAt: time('used_at'),
}, (table) => [
  uniqueIndex('password_resets_token_key').on(table.tokenHash),
  index('password_resets_user').on(table.userId),
  check('password_resets_hash_length', sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
  check('password_resets_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const userMfa = pgTable('user_mfa', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  // AES-256-GCM envelope is a scalar ciphertext, not serialized configuration.
  encryptedSecret: text('encrypted_secret'),
  enabled: boolean('enabled').notNull().default(false),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }).notNull().default(-1),
  revision: integer('revision').notNull().default(1),
  changeId: uuid('change_id'),
  changeSessionId: uuid('change_session_id').references(() => sessions.id),
  createdAt: time('created_at').notNull().defaultNow(),
}, (table) => [
  check('user_mfa_revision_positive', sql`${table.revision} > 0`),
  check('user_mfa_secret_state', sql`(${table.enabled} and ${table.encryptedSecret} is not null and ${table.lastUsedStep} >= -1) or (not ${table.enabled} and ${table.encryptedSecret} is null and ${table.lastUsedStep} = -1)`),
  check('user_mfa_change_identity', sql`(${table.changeId} is null) = (${table.changeSessionId} is null)`),
]);

// Enrollment is temporary, belongs to one authenticated session and is never a login factor.
export const userMfaSetups = pgTable('user_mfa_setups', {
  sessionId: uuid('session_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
  id: uuid('id').notNull().defaultRandom(),
  encryptedSecret: text('encrypted_secret').notNull(),
  credentialRevision: integer('credential_revision').notNull(),
  mfaRevision: integer('mfa_revision').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  expiresAt: time('expires_at').notNull(),
}, (table) => [
  uniqueIndex('user_mfa_setups_id_key').on(table.id),
  check('user_mfa_setups_revisions', sql`${table.credentialRevision} > 0 and ${table.mfaRevision} >= 0`),
  check('user_mfa_setups_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
  check('user_mfa_setups_ciphertext', sql`${table.encryptedSecret} ~ '^[A-Za-z0-9_-]{60,220}$'`),
]);

export const accountEvents = pgTable('account_events', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id),
  organizationId: uuid('organization_id').references(() => organizations.id),
  kind: text('kind').notNull(),
  occurredAt: time('occurred_at').notNull().defaultNow(),
}, (table) => [
  index('account_events_user_time').on(table.userId, table.occurredAt),
  check('account_events_kind', sql`${table.kind} in ('sign_in', 'sign_out', 'profile_changed', 'password_changed', 'password_reset', 'mfa_enabled', 'mfa_disabled')`),
]);
