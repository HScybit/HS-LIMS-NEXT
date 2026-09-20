import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, date, timestamp, primaryKey, foreignKey, check, index, unique, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { methodsOfAnalysis } from './master-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytes = customType({ dataType: () => 'bytea' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);

// Step 10f: current-state records (no approval workflow, no versioned
// history), same precedent as Leave Management/Environmental Monitoring.
// Meteor's ActualTraining/Templatizer document-rendering integration (and
// its own inconsistent files_id[]-vs-fileId attachment fields) is
// deliberately not carried over — scheduling/attendance/certification
// tracking is the load-bearing part; there is no matching "training"
// template kind scaffolded anywhere in this codebase to render against.
export const trainingSchedules = pgTable('training_schedules', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  name: text('name').notNull(), description: text('description'),
  fromDate: date('from_date', { mode: 'string' }).notNull(), toDate: date('to_date', { mode: 'string' }).notNull(),
  trainerName: text('trainer_name'),
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'training_schedule_created_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'training_schedule_updated_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('training_schedule_fields', sql`length(trim(${t.name})) between 1 and 200 and (${t.description} is null or length(${t.description}) between 1 and 10000)
    and ${t.toDate} >= ${t.fromDate} and (${t.trainerName} is null or length(trim(${t.trainerName})) between 1 and 200) and ${t.revision} > 0`),
  index('training_schedule_listing').on(t.organizationId, t.fromDate, t.id),
]);

export const trainingScheduleAttendees = pgTable('training_schedule_attendees', {
  organizationId: tenant(), trainingScheduleId: uuid('training_schedule_id').notNull(), userId: uuid('user_id').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.trainingScheduleId, t.userId] }),
  foreignKey({ name: 'training_schedule_attendee_schedule_fk', columns: [t.organizationId, t.trainingScheduleId], foreignColumns: [trainingSchedules.organizationId, trainingSchedules.id] }),
  foreignKey({ name: 'training_schedule_attendee_user_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
]);

export const trainingAttendance = pgTable('training_attendance', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  trainingScheduleId: uuid('training_schedule_id').notNull(), userId: uuid('user_id').notNull(), attendanceDate: date('attendance_date', { mode: 'string' }).notNull(),
  checkInAt: time('check_in_at'), checkOutAt: time('check_out_at'),
  revision: integer('revision').notNull().default(1),
  recordedBy: uuid('recorded_by').notNull(), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'training_attendance_schedule_fk', columns: [t.organizationId, t.trainingScheduleId], foreignColumns: [trainingSchedules.organizationId, trainingSchedules.id] }),
  foreignKey({ name: 'training_attendance_user_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'training_attendance_actor_fk', columns: [t.organizationId, t.recordedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('training_attendance_fields', sql`(${t.checkOutAt} is null or ${t.checkInAt} is not null and ${t.checkOutAt} >= ${t.checkInAt}) and ${t.revision} > 0`),
  unique('training_attendance_unique').on(t.organizationId, t.trainingScheduleId, t.userId, t.attendanceDate),
]);

export const userCertificationFiles = pgTable('user_certification_files', {
  organizationId: tenant(), id: uuid('id').notNull(),
  originalName: text('original_name').notNull(), mediaType: text('media_type').notNull(), content: bytes('content').notNull(),
  byteLength: integer('byte_length').notNull(), sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(), uploadedAt: time('uploaded_at').notNull().defaultNow(),
}, (t) => [primaryKey({ name: 'user_certification_file_pk', columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'user_certification_file_actor_fk', columns: [t.organizationId, t.uploadedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('user_certification_file_fields', sql`length(${t.originalName}) between 1 and 500 and ${t.originalName}=trim(${t.originalName})
    and ${t.originalName} !~ '[[:cntrl:]]' and position('/' in ${t.originalName})=0 and position(chr(92) in ${t.originalName})=0
    and length(${t.mediaType}) between 1 and 255 and ${t.mediaType}=lower(${t.mediaType})
    and ${t.mediaType} ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
    and ${t.byteLength} between 0 and 26214400 and ${t.byteLength}=octet_length(${t.content}) and ${t.sha256}=encode(sha256(${t.content}),'hex')`),
]);

// User Certification: tracks external/internal certifications (e.g. Method
// of Analysis competency) with a validity window and supporting document.
export const userCertifications = pgTable('user_certifications', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  userId: uuid('user_id').notNull(), methodId: uuid('method_id'),
  certificationName: text('certification_name').notNull(), completionStatus: text('completion_status').notNull().default('pending'),
  validFrom: date('valid_from', { mode: 'string' }).notNull(), validTill: date('valid_till', { mode: 'string' }),
  certificateFileId: uuid('certificate_file_id'), reviewerId: uuid('reviewer_id'),
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'user_certification_user_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'user_certification_reviewer_fk', columns: [t.organizationId, t.reviewerId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'user_certification_method_fk', columns: [t.organizationId, t.methodId], foreignColumns: [methodsOfAnalysis.organizationId, methodsOfAnalysis.id] }),
  foreignKey({ name: 'user_certification_created_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'user_certification_updated_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'user_certification_file_fk', columns: [t.organizationId, t.certificateFileId], foreignColumns: [userCertificationFiles.organizationId, userCertificationFiles.id] }),
  check('user_certification_fields', sql`length(trim(${t.certificationName})) between 1 and 200 and ${t.completionStatus} in ('pending', 'completed', 'expired')
    and (${t.validTill} is null or ${t.validTill} >= ${t.validFrom}) and ${t.revision} > 0`),
  index('user_certification_listing').on(t.organizationId, t.userId, t.validFrom, t.id),
]);
