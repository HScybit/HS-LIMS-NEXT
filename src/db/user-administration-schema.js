import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, timestamp, primaryKey, unique, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, users, memberships } from './schema.js';
import { userProfileVersions } from './user-profile-schema.js';

const bytes = customType({ dataType: () => 'bytea' });
const transactionId = customType({ dataType: () => 'xid8' });

// Actual native creation events only. Imported/existing identities do not acquire an invented creation event.
export const userCreationCommands = pgTable('user_creation_commands', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), userId: uuid('user_id').notNull().references(() => users.id),
  requestId: uuid('request_id').notNull(), fingerprint: bytes('fingerprint').notNull(), profileRevision: integer('profile_revision').notNull(),
  username: text('username').notNull(), email: text('email').notNull(), displayName: text('display_name').notNull(),
  createdBy: uuid('created_by').notNull(), createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (t) => [
  primaryKey({ name: 'user_creation_request_pk', columns: [t.organizationId, t.requestId] }), unique('user_creation_identity_key').on(t.userId),
  foreignKey({ name: 'user_creation_profile_fk', columns: [t.organizationId, t.userId, t.profileRevision],
    foreignColumns: [userProfileVersions.organizationId, userProfileVersions.userId, userProfileVersions.revision] }),
  foreignKey({ name: 'user_creation_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('user_creation_fields', sql`octet_length(${t.fingerprint})=32 and ${t.profileRevision}=1
    and length(trim(${t.username})) between 1 and 100 and length(trim(${t.email})) between 1 and 320
    and length(trim(${t.displayName})) between 1 and 200`),
]);

export const userStatusVersions = pgTable('user_status_versions', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), userId: uuid('user_id').notNull(),
  revision: integer('revision').notNull(), previousRevision: integer('previous_revision').notNull(), requestId: uuid('request_id').notNull(),
  active: boolean('active').notNull(), previousActive: boolean('previous_active').notNull(),
  username: text('username').notNull(), displayName: text('display_name').notNull(),
  savedBy: uuid('saved_by').notNull(), savedByUsername: text('saved_by_username').notNull(), savedByName: text('saved_by_name').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (t) => [
  primaryKey({ name: 'user_status_version_pk', columns: [t.organizationId, t.userId, t.revision] }),
  unique('user_status_request_key').on(t.organizationId, t.requestId),
  foreignKey({ name: 'user_status_member_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'user_status_actor_fk', columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('user_status_transition', sql`${t.previousRevision}>=0 and ${t.revision}=${t.previousRevision}+1 and ${t.active}<>${t.previousActive}`),
  check('user_status_labels', sql`length(trim(${t.username})) between 1 and 100 and length(trim(${t.displayName})) between 1 and 200
    and length(trim(${t.savedByUsername})) between 1 and 100 and length(trim(${t.savedByName})) between 1 and 200`),
]);

// Each upload keeps its original file once. Removal is an event with no payload; old files remain addressable.
export const userSignatureVersions = pgTable('user_signature_versions', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), userId: uuid('user_id').notNull(),
  revision: integer('revision').notNull(), previousRevision: integer('previous_revision').notNull(), requestId: uuid('request_id').notNull(),
  operation: text('operation').notNull(), originalName: text('original_name'), mediaType: text('media_type'),
  content: bytes('content'), byteLength: integer('byte_length'), sha256: text('sha256'),
  username: text('username').notNull(), displayName: text('display_name').notNull(),
  savedBy: uuid('saved_by').notNull(), savedByUsername: text('saved_by_username').notNull(), savedByName: text('saved_by_name').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (t) => [
  primaryKey({ name: 'user_signature_version_pk', columns: [t.organizationId, t.userId, t.revision] }), unique('user_signature_request_key').on(t.organizationId, t.requestId),
  foreignKey({ name: 'user_signature_member_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'user_signature_actor_fk', columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('user_signature_revision', sql`${t.previousRevision}>=0 and ${t.revision}=${t.previousRevision}+1`),
  check('user_signature_payload', sql`(${t.operation}='remove' and num_nonnulls(${t.originalName},${t.mediaType},${t.content},${t.byteLength},${t.sha256})=0)
    or (${t.operation}='upload' and num_nonnulls(${t.originalName},${t.mediaType},${t.content},${t.byteLength},${t.sha256})=5
      and ${t.byteLength} between 0 and 20971520 and ${t.byteLength}=octet_length(${t.content}) and ${t.sha256}=encode(sha256(${t.content}),'hex')
      and length(trim(${t.originalName})) between 1 and 500 and ${t.originalName} !~ '[[:cntrl:]]'
      and position('/' in ${t.originalName})=0 and position(chr(92) in ${t.originalName})=0
      and length(${t.mediaType})<=255 and ${t.mediaType} ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$')`),
  check('user_signature_labels', sql`length(trim(${t.username})) between 1 and 100 and length(trim(${t.displayName})) between 1 and 200
    and length(trim(${t.savedByUsername})) between 1 and 100 and length(trim(${t.savedByName})) between 1 and 200`),
]);
