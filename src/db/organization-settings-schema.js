import { sql } from 'drizzle-orm';
import { pgTable, uuid, boolean, integer, timestamp, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { templates } from './template-schema.js';
import { workflows } from './workflow-schema.js';

// The job workflow's organization-level defaults. Scientific results and
// template/workflow definitions remain in their own versioned relations.
export const organizationLaboratorySettings = pgTable('organization_laboratory_settings', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  autoCreateJobs: boolean('auto_create_jobs').notNull().default(false),
  resultSummaryTemplateId: uuid('result_summary_template_id'), jobWorkflowId: uuid('job_workflow_id'),
  revision: integer('revision').notNull().default(1), updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId] }),
  foreignKey({ name: 'lab_settings_result_template_fk', columns: [t.organizationId, t.resultSummaryTemplateId], foreignColumns: [templates.organizationId, templates.id] }),
  foreignKey({ name: 'lab_settings_job_workflow_fk', columns: [t.organizationId, t.jobWorkflowId], foreignColumns: [workflows.organizationId, workflows.id] }),
  foreignKey({ name: 'lab_settings_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('lab_settings_revision', sql`${t.revision}>0`),
]);
