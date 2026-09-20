import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, integer, timestamp, primaryKey, foreignKey, unique, check, index } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);

// Step 10i: an admin-authored, sandboxed HTTP endpoint. This is genuinely
// unlike everything else in this migration: it lets an org admin write and
// execute their own JavaScript against this organization's own data,
// server-side, on every call to a generated URL. draft_code is what's being
// edited; live_code/published_at/published_by are what actually executes on
// invocation, changed only by an explicit publish. A change in progress
// therefore never affects an already-published, in-use integration
// endpoint until deliberately published — matching Meteor's own draft/
// publish separation for this feature.
export const dynamicApis = pgTable('dynamic_apis', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  name: text('name').notNull(), urlKey: text('url_key').notNull(), httpMethod: text('http_method').notNull(),
  draftCode: text('draft_code').notNull(), liveCode: text('live_code'), enabled: boolean('enabled').notNull().default(true),
  revision: integer('revision').notNull().default(1),
  publishedBy: uuid('published_by'), publishedAt: time('published_at'),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'dynamic_api_created_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'dynamic_api_updated_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'dynamic_api_published_actor_fk', columns: [t.organizationId, t.publishedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  unique('dynamic_api_route_key').on(t.organizationId, t.urlKey, t.httpMethod),
  check('dynamic_api_fields', sql`length(trim(${t.name})) between 1 and 200
    and ${t.urlKey} ~ '^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$'
    and ${t.httpMethod} in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')
    and length(${t.draftCode}) between 1 and 65536 and (${t.liveCode} is null or length(${t.liveCode}) between 1 and 65536)
    and (${t.publishedBy} is null and ${t.publishedAt} is null and ${t.liveCode} is null
      or ${t.publishedBy} is not null and ${t.publishedAt} is not null and ${t.liveCode} is not null)
    and ${t.revision} > 0`),
  index('dynamic_api_listing').on(t.organizationId, t.name),
]);

// A bearer token's actual secret is never stored — only its sha256. Shown to
// the author once, at creation, the same convention as most API-key UX.
export const dynamicApiTokens = pgTable('dynamic_api_tokens', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), apiId: uuid('api_id').notNull(),
  label: text('label'), tokenHash: text('token_hash').notNull(),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  lastUsedAt: time('last_used_at'), revokedAt: time('revoked_at'),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'dynamic_api_token_api_fk', columns: [t.organizationId, t.apiId], foreignColumns: [dynamicApis.organizationId, dynamicApis.id] }),
  foreignKey({ name: 'dynamic_api_token_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  unique('dynamic_api_token_hash_key').on(t.tokenHash),
  check('dynamic_api_token_fields', sql`(${t.label} is null or length(trim(${t.label})) between 1 and 200) and length(${t.tokenHash})=64`),
  index('dynamic_api_token_listing').on(t.organizationId, t.apiId),
]);

// One row per invocation, capped/pruned by the application layer — an
// admin-facing execution log covering both test runs and live calls, since
// this is the only part of the migration that runs untrusted, tenant-
// authored code and needs an audit trail of what it actually did.
export const dynamicApiInvocations = pgTable('dynamic_api_invocations', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), apiId: uuid('api_id').notNull(),
  isTestRun: boolean('is_test_run').notNull(), status: text('status').notNull(), errorMessage: text('error_message'),
  logOutput: text('log_output'), durationMs: integer('duration_ms').notNull(),
  invokedBy: uuid('invoked_by'), invokedAt: time('invoked_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'dynamic_api_invocation_api_fk', columns: [t.organizationId, t.apiId], foreignColumns: [dynamicApis.organizationId, dynamicApis.id] }),
  foreignKey({ name: 'dynamic_api_invocation_actor_fk', columns: [t.organizationId, t.invokedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('dynamic_api_invocation_fields', sql`${t.status} in ('succeeded', 'failed', 'timed_out')
    and (${t.logOutput} is null or length(${t.logOutput})<=20000) and ${t.durationMs} >= 0
    and (${t.status} = 'succeeded' or ${t.errorMessage} is not null)`),
  index('dynamic_api_invocation_listing').on(t.organizationId, t.apiId, t.invokedAt),
]);
