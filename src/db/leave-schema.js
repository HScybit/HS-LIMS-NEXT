import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, date, timestamp, primaryKey, foreignKey, check, index, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytes = customType({ dataType: () => 'bytea' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);

// Step 10b: a flat operational log, matching Meteor/PERN's own treatment (no
// approval workflow, no versioned history) — current-state only, like the
// step-7 organization settings child tables, not the versioned-snapshot
// pattern used for regulated masters.
export const leaveRecordAttachments = pgTable('leave_record_attachments', {
  organizationId: tenant(), id: uuid('id').notNull(),
  originalName: text('original_name').notNull(), mediaType: text('media_type').notNull(), content: bytes('content').notNull(),
  byteLength: integer('byte_length').notNull(), sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(), uploadedAt: time('uploaded_at').notNull().defaultNow(),
}, (t) => [primaryKey({ name: 'leave_record_attachment_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'leave_record_attachment_actor_fk', columns: [t.organizationId, t.uploadedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('leave_record_attachment_fields', sql`length(${t.originalName}) between 1 and 500 and ${t.originalName}=trim(${t.originalName})
    and ${t.originalName} !~ '[[:cntrl:]]' and position('/' in ${t.originalName})=0 and position(chr(92) in ${t.originalName})=0
    and length(${t.mediaType}) between 1 and 255 and ${t.mediaType}=lower(${t.mediaType})
    and ${t.mediaType} ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
    and ${t.byteLength} between 0 and 26214400 and ${t.byteLength}=octet_length(${t.content}) and ${t.sha256}=encode(sha256(${t.content}),'hex')`),
]);

export const leaveRecords = pgTable('leave_records', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  userId: uuid('user_id').notNull(), fromDate: date('from_date', { mode: 'string' }).notNull(), toDate: date('to_date', { mode: 'string' }).notNull(),
  remark: text('remark'), attachmentId: uuid('attachment_id'),
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'leave_record_user_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'leave_record_created_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'leave_record_updated_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'leave_record_attachment_fk', columns: [t.organizationId, t.attachmentId], foreignColumns: [leaveRecordAttachments.organizationId, leaveRecordAttachments.id] }),
  check('leave_record_dates', sql`${t.toDate} >= ${t.fromDate} and ${t.revision} > 0
    and (${t.remark} is null or length(${t.remark}) between 1 and 5000)`),
  index('leave_record_listing').on(t.organizationId, t.fromDate, t.id),
]);
