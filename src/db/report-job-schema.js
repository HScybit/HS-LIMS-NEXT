import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, integer, primaryKey, unique, index, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { sampleReports } from './report-schema.js';

const bytes = customType({ dataType: () => 'bytea' });
const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });

export const reportPdfJobs = pgTable('report_pdf_jobs', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id), id: uuid('id').notNull().defaultRandom(), reportId: uuid('report_id').notNull(),
  rendererId: text('renderer_id').notNull(), requestedBy: uuid('requested_by').notNull(), requestedAt: time('requested_at').notNull().defaultNow(),
  status: text('status').notNull().default('queued'), attempts: integer('attempts').notNull().default(0), availableAt: time('available_at').notNull().defaultNow(),
  leaseTokenHash: bytes('lease_token_hash'), leaseExpiresAt: time('lease_expires_at'), startedAt: time('started_at'), completedAt: time('completed_at'),
  lastErrorCode: text('last_error_code'), lastErrorMessage: text('last_error_message'),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }), unique('report_pdf_job_report_key').on(t.organizationId, t.reportId),
  unique('report_pdf_job_identity_key').on(t.organizationId, t.id, t.reportId),
  foreignKey({ name: 'report_pdf_job_report_fk', columns: [t.organizationId, t.reportId], foreignColumns: [sampleReports.organizationId, sampleReports.id] }),
  foreignKey({ name: 'report_pdf_job_requester_fk', columns: [t.organizationId, t.requestedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  index('report_pdf_job_ready_idx').on(t.rendererId, t.status, t.availableAt, t.leaseExpiresAt).where(sql`${t.status} in ('queued','running')`),
  check('report_pdf_job_version', sql`${t.rendererId} ~ '^[a-f0-9]{64}$' and ${t.attempts} between 0 and 5`),
  check('report_pdf_job_state', sql`(${t.status}='queued' and ${t.leaseTokenHash} is null and ${t.leaseExpiresAt} is null and ${t.completedAt} is null)
    or (${t.status}='running' and ${t.attempts}>0 and ${t.leaseTokenHash} is not null and octet_length(${t.leaseTokenHash})=32 and ${t.leaseExpiresAt} is not null and ${t.startedAt} is not null and ${t.leaseExpiresAt}>${t.startedAt} and ${t.completedAt} is null)
    or (${t.status} in ('succeeded','failed') and ${t.attempts}>0 and ${t.leaseTokenHash} is null and ${t.leaseExpiresAt} is null and ${t.startedAt} is not null and ${t.completedAt} is not null)`),
  check('report_pdf_job_dates', sql`${t.availableAt} >= ${t.requestedAt} and (${t.startedAt} is null or ${t.startedAt} >= ${t.requestedAt})
    and (${t.completedAt} is null or ${t.completedAt} >= ${t.requestedAt})`),
  check('report_pdf_job_error', sql`(${t.lastErrorCode} is null and ${t.lastErrorMessage} is null and ${t.status}<>'failed')
    or (${t.lastErrorCode} is not null and ${t.lastErrorMessage} is not null and ${t.lastErrorCode} ~ '^[a-z0-9_]{1,80}$' and length(${t.lastErrorMessage}) between 1 and 2000 and ${t.status}<>'succeeded')`),
]);

export const reportPdfAttempts = pgTable('report_pdf_attempts', {
  organizationId: uuid('organization_id').notNull(), jobId: uuid('job_id').notNull(), attemptNumber: integer('attempt_number').notNull(),
  workerId: uuid('worker_id').notNull(), startedAt: time('started_at').notNull().defaultNow(), completedAt: time('completed_at'),
  status: text('status').notNull().default('running'), errorCode: text('error_code'), errorMessage: text('error_message'),
}, (t) => [primaryKey({ name: 'report_pdf_attempt_pk', columns: [t.organizationId, t.jobId, t.attemptNumber] }),
  foreignKey({ name: 'report_pdf_attempt_job_fk', columns: [t.organizationId, t.jobId], foreignColumns: [reportPdfJobs.organizationId, reportPdfJobs.id] }),
  check('report_pdf_attempt_number', sql`${t.attemptNumber} between 1 and 5`),
  check('report_pdf_attempt_state', sql`(${t.status}='running' and ${t.completedAt} is null and ${t.errorCode} is null and ${t.errorMessage} is null)
    or (${t.status}='succeeded' and ${t.completedAt} is not null and ${t.errorCode} is null and ${t.errorMessage} is null)
    or (${t.status} in ('failed','expired') and ${t.completedAt} is not null and ${t.errorCode} is not null and ${t.errorMessage} is not null and ${t.errorCode} ~ '^[a-z0-9_]{1,80}$' and length(${t.errorMessage}) between 1 and 2000)`),
  check('report_pdf_attempt_dates', sql`${t.completedAt} is null or ${t.completedAt} >= ${t.startedAt}`),
]);

// Only generated PDF bytes are stored here. Definitions, entered values and
// intermediate render models remain in their canonical relational tables.
export const reportPdfArtifacts = pgTable('report_pdf_artifacts', {
  organizationId: uuid('organization_id').notNull(), id: uuid('id').notNull().defaultRandom(), reportId: uuid('report_id').notNull(),
  jobId: uuid('job_id').notNull(), attemptNumber: integer('attempt_number').notNull(),
  contentType: text('content_type').notNull().default('application/pdf'), byteLength: integer('byte_length').notNull(), sha256: bytes('sha256').notNull(),
  content: bytes('content').notNull(), createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [primaryKey({ name: 'report_pdf_artifact_pk', columns: [t.organizationId, t.id] }), unique('report_pdf_artifact_report_key').on(t.organizationId, t.reportId),
  foreignKey({ name: 'report_pdf_artifact_job_fk', columns: [t.organizationId, t.jobId, t.reportId], foreignColumns: [reportPdfJobs.organizationId, reportPdfJobs.id, reportPdfJobs.reportId] }),
  foreignKey({ name: 'report_pdf_artifact_attempt_fk', columns: [t.organizationId, t.jobId, t.attemptNumber], foreignColumns: [reportPdfAttempts.organizationId, reportPdfAttempts.jobId, reportPdfAttempts.attemptNumber] }),
  check('report_pdf_artifact_bytes', sql`${t.contentType}='application/pdf' and ${t.byteLength}=octet_length(${t.content}) and ${t.byteLength} between 100 and 52428800
    and octet_length(${t.sha256})=32 and ${t.sha256}=sha256(${t.content}) and substring(${t.content} from 1 for 5)=convert_to('%PDF-','UTF8')`),
]);
