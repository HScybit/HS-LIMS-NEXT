import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, integer, timestamp, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { templates } from './template-schema.js';
import { workflows } from './workflow-schema.js';

// The job workflow's organization-level defaults. Scientific results and
// template/workflow definitions remain in their own versioned relations.
export const organizationLaboratorySettings = pgTable('organization_laboratory_settings', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  autoCreateJobs: boolean('auto_create_jobs').notNull().default(false),
  selfAllocationEnabled: boolean('self_allocation_enabled').notNull().default(false),
  resultSummaryTemplateId: uuid('result_summary_template_id'), jobWorkflowId: uuid('job_workflow_id'),
  // GenericForm scheme settings are source text-input lexemes; parseInt prefixes and absent fallbacks are meaningful.
  schemeCurrentYearDigits: text('scheme_current_year_digits'), schemeNextYearDigits: text('scheme_next_year_digits'),
  schemeSeparator: text('scheme_separator'), schemeMonthFormat: text('scheme_month_format'), schemeNonNablStartNumber: text('scheme_non_nabl_start_number'),
  revision: integer('revision').notNull().default(1), updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId] }),
  foreignKey({ name: 'lab_settings_result_template_fk', columns: [t.organizationId, t.resultSummaryTemplateId], foreignColumns: [templates.organizationId, templates.id] }),
  foreignKey({ name: 'lab_settings_job_workflow_fk', columns: [t.organizationId, t.jobWorkflowId], foreignColumns: [workflows.organizationId, workflows.id] }),
  foreignKey({ name: 'lab_settings_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('lab_settings_revision', sql`${t.revision}>0`),
  check('lab_settings_scheme_values', sql`length(${t.schemeCurrentYearDigits})<=128 and length(${t.schemeNextYearDigits})<=128
    and length(${t.schemeSeparator})<=250 and length(${t.schemeNonNablStartNumber})<=128
    and (${t.schemeMonthFormat} is null or ${t.schemeMonthFormat} in ('','number','short','long'))`),
]);
