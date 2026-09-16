import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, integer, timestamp, primaryKey, foreignKey, check, unique, uniqueIndex, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';
import { templates } from './template-schema.js';
import { workflows } from './workflow-schema.js';

const transactionId = customType({ dataType: () => 'xid8' });

// Organization-level laboratory and workflow defaults. Scientific results and
// template/workflow definitions remain in their own versioned relations.
export const organizationLaboratorySettings = pgTable('organization_laboratory_settings', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  autoCreateJobs: boolean('auto_create_jobs').notNull().default(false),
  selfAllocationEnabled: boolean('self_allocation_enabled').notNull().default(false),
  allowReceivingDateEdit: boolean('allow_receiving_date_edit').notNull().default(false),
  resultSummaryTemplateId: uuid('result_summary_template_id'), jobWorkflowId: uuid('job_workflow_id'), testRequestWorkflowId: uuid('test_request_workflow_id'),
  sampleWorkflowBaseId: uuid('sample_workflow_base_id'), sampleWorkflowIqcId: uuid('sample_workflow_iqc_id'),
  sampleWorkflowIlcId: uuid('sample_workflow_ilc_id'), sampleWorkflowPtId: uuid('sample_workflow_pt_id'),
  sampleWorkflowAmendmentId: uuid('sample_workflow_amendment_id'), sampleWorkflowComplaintId: uuid('sample_workflow_complaint_id'),
  // GenericForm scheme settings are source text-input lexemes; parseInt prefixes and absent fallbacks are meaningful.
  schemeCurrentYearDigits: text('scheme_current_year_digits'), schemeNextYearDigits: text('scheme_next_year_digits'),
  schemeSeparator: text('scheme_separator'), schemeMonthFormat: text('scheme_month_format'), schemeNonNablStartNumber: text('scheme_non_nabl_start_number'),
  dateFormat: text('date_format'), datetimeFormat: text('datetime_format'),
  revision: integer('revision').notNull().default(1), updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId] }),
  foreignKey({ name: 'lab_settings_result_template_fk', columns: [t.organizationId, t.resultSummaryTemplateId], foreignColumns: [templates.organizationId, templates.id] }),
  foreignKey({ name: 'lab_settings_job_workflow_fk', columns: [t.organizationId, t.jobWorkflowId], foreignColumns: [workflows.organizationId, workflows.id] }),
  foreignKey({ name: 'lab_settings_request_workflow_fk', columns: [t.organizationId, t.testRequestWorkflowId], foreignColumns: [workflows.organizationId, workflows.id] }),
  ...[['base', t.sampleWorkflowBaseId], ['iqc', t.sampleWorkflowIqcId], ['ilc', t.sampleWorkflowIlcId], ['pt', t.sampleWorkflowPtId],
    ['amendment', t.sampleWorkflowAmendmentId], ['complaint', t.sampleWorkflowComplaintId]]
    .map(([key, column]) => foreignKey({ name: `lab_settings_sample_${key}_workflow_fk`, columns: [t.organizationId, column], foreignColumns: [workflows.organizationId, workflows.id] })),
  foreignKey({ name: 'lab_settings_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('lab_settings_revision', sql`${t.revision}>0`),
  check('lab_settings_date_format', sql`length(${t.dateFormat})<=40`),
  check('lab_settings_datetime_format', sql`length(${t.datetimeFormat})<=60`),
  check('lab_settings_scheme_values', sql`length(${t.schemeCurrentYearDigits})<=128 and length(${t.schemeNextYearDigits})<=128
    and length(${t.schemeSeparator})<=250 and length(${t.schemeNonNablStartNumber})<=128
    and (${t.schemeMonthFormat} is null or ${t.schemeMonthFormat} in ('','number','short','long'))`),
]);

// Complete service-definition sets are retained at the settings revision that saved them.
export const organizationInstrumentServiceVersions = pgTable('organization_instrument_service_versions', {
  organizationId: uuid('organization_id').notNull(), revision: integer('revision').notNull(), rowCount: integer('row_count').notNull(),
  savedBy: uuid('saved_by').notNull(), savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, t => [
  primaryKey({ name: 'organization_instrument_service_version_pk', columns: [t.organizationId, t.revision] }),
  foreignKey({ name: 'organization_instrument_service_settings_fk', columns: [t.organizationId], foreignColumns: [organizationLaboratorySettings.organizationId] }),
  foreignKey({ name: 'organization_instrument_service_actor_fk', columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('organization_instrument_service_version_bounds', sql`${t.revision}>0 and ${t.rowCount} between 0 and 100`),
]);

export const organizationInstrumentServiceEntries = pgTable('organization_instrument_service_entries', {
  organizationId: uuid('organization_id').notNull(), revision: integer('revision').notNull(), id: uuid('id').notNull(), position: integer('position').notNull(),
  serviceCode: text('service_code').notNull(), displayLabel: text('display_label').notNull(), active: boolean('active').notNull(),
}, t => [
  primaryKey({ name: 'organization_instrument_service_entry_pk', columns: [t.organizationId, t.revision, t.id] }),
  foreignKey({ name: 'organization_instrument_service_entry_version_fk', columns: [t.organizationId, t.revision], foreignColumns: [organizationInstrumentServiceVersions.organizationId, organizationInstrumentServiceVersions.revision] }),
  unique('organization_instrument_service_position').on(t.organizationId, t.revision, t.position),
  uniqueIndex('organization_instrument_service_code').on(t.organizationId, t.revision, sql`lower(${t.serviceCode})`),
  check('organization_instrument_service_entry_fields', sql`${t.position} between 0 and 99 and length(${t.serviceCode}) between 1 and 64
    and ${t.serviceCode} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' and length(${t.displayLabel}) between 1 and 150 and ${t.displayLabel}=trim(${t.displayLabel})`),
]);
