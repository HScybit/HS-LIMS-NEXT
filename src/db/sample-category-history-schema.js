import { sql } from 'drizzle-orm';
import { pgTable, pgView, uuid, text, integer, boolean, doublePrecision, timestamp, primaryKey, unique, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { sampleCategories } from './master-schema.js';

const transactionId = customType({ dataType: () => 'xid8' });
const scope = () => ({ organizationId: uuid('organization_id').notNull().references(() => organizations.id), sampleCategoryId: uuid('sample_category_id').notNull(), revision: integer('revision').notNull() });

export const sampleCategoryVersions = pgTable('sample_category_versions', {
  ...scope(), requestId: uuid('request_id').notNull(), previousRevision: integer('previous_revision'), operation: text('operation').notNull(),
  code: text('code').notNull(), name: text('name').notNull(), description: text('description').notNull(), abbreviation: text('abbreviation').notNull(),
  retentionDays: integer('retention_days'), estimatedTimeInDays: doublePrecision('estimated_time_in_days').notNull(),
  enableEvents: boolean('enable_events').notNull(), enableReissue: boolean('enable_reissue').notNull(), active: boolean('active').notNull(),
  savedBy: uuid('saved_by').notNull(), savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (table) => [
  primaryKey({ name: 'sample_category_version_pk', columns: [table.organizationId, table.sampleCategoryId, table.revision] }),
  unique('sample_category_save_request_key').on(table.organizationId, table.requestId),
  foreignKey({ name: 'sample_category_version_parent_fk', columns: [table.organizationId, table.sampleCategoryId], foreignColumns: [sampleCategories.organizationId, sampleCategories.id] }),
  foreignKey({ name: 'sample_category_version_actor_fk', columns: [table.organizationId, table.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('sample_category_version_revision', sql`(${table.operation}='create' and ${table.previousRevision} is null and ${table.revision}=1)
    or (${table.operation} in ('update','retire') and ${table.previousRevision} is not null and ${table.previousRevision}>0 and ${table.revision}=${table.previousRevision}+1)`),
  check('sample_category_version_fields', sql`length(trim(${table.code})) between 1 and 64 and length(trim(${table.name})) between 1 and 250
    and (${table.operation}='retire' or (length(trim(${table.name}))<=200 and length(${table.description})<=16000 and length(trim(${table.abbreviation})) between 1 and 64
      and ${table.retentionDays}>=0 and ${table.estimatedTimeInDays}>=0
      and ${table.estimatedTimeInDays} not in ('NaN'::double precision,'Infinity'::double precision,'-Infinity'::double precision)))
    and (${table.operation}<>'retire' or not ${table.active})`),
]);

// A narrow read projection for Sample Category user selection/display, matching
// method_access_user_labels/master_bulk_user_labels; base identity tables keep their own grants.
export const sampleCategoryUserLabels = pgView('sample_category_user_labels', {
  organizationId: uuid('organization_id'), id: uuid('id'), username: text('username'), displayName: text('display_name'), active: boolean('active'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT member.organization_id,person.id,person.username,person.display_name,(member.active AND person.active) AS active
  FROM public.memberships member JOIN public.users person ON person.id=member.user_id
  WHERE member.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('masters.read') OR public.app_has_permission('masters.manage'))
`);
