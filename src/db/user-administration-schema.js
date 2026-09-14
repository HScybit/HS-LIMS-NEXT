import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, timestamp, primaryKey, unique, check, foreignKey, customType } from 'drizzle-orm/pg-core';
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
