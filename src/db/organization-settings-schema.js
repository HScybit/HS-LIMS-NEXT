import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, integer, time, timestamp, primaryKey, foreignKey, check, unique, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships, roles } from './schema.js';
import { templates } from './template-schema.js';
import { workflows } from './workflow-schema.js';
import { sampleCategories } from './master-schema.js';

const transactionId = customType({ dataType: () => 'xid8' });

// One current logo per organization; replaced wholesale on re-upload (no history, matching the source apps' single-slot logo).
export const organizationLogoFiles = pgTable('organization_logo_files', {
  organizationId: uuid('organization_id').notNull(), id: uuid('id').notNull(),
  originalName: text('original_name').notNull(), mediaType: text('media_type').notNull(),
  content: customType({ dataType: () => 'bytea' })('content').notNull(), byteLength: integer('byte_length').notNull(), sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(), uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId] }),
  foreignKey({ name: 'org_logo_actor_fk', columns: [t.organizationId, t.uploadedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('org_logo_media_type', sql`${t.mediaType} in ('image/png','image/jpeg','image/webp')`),
  check('org_logo_size', sql`${t.byteLength} between 1 and 2097152 and ${t.byteLength}=octet_length(${t.content})`),
]);

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

  // Basic / Company Identity (step 7)
  // A logo's presence/id is read directly from organization_logo_files (PK=organization_id, singleton per org) rather than mirrored here.
  displayName: text('display_name'), description: text('description'), tagline: text('tagline'), brandColor: text('brand_color'),
  nablNumber: text('nabl_number'), locationCode: text('location_code'),
  entityName: text('entity_name').notNull().default('Sample'), productEntityName: text('product_entity_name').notNull().default('Product'),
  headerStyle: text('header_style'), templateAclEnabled: boolean('template_acl_enabled').notNull().default(false),
  workflowBasedAcl: boolean('workflow_based_acl').notNull().default(false), workflowBasedTemplates: boolean('workflow_based_templates').notNull().default(false),
  zebraPrintingEnabled: boolean('zebra_printing_enabled').notNull().default(false),

  // Sample Page extensions
  scrollableSampleListing: boolean('scrollable_sample_listing').notNull().default(true),
  autoInitializeSamples: boolean('auto_initialize_samples').notNull().default(false),
  showBarcodeSection: boolean('show_barcode_section').notNull().default(true), showJobcardActions: boolean('show_jobcard_actions').notNull().default(true),
  showDatasheetActions: boolean('show_datasheet_actions').notNull().default(true), showWorkflowNodes: boolean('show_workflow_nodes').notNull().default(true),
  useTemplatizedAcknowledgement: boolean('use_templatized_acknowledgement').notNull().default(false),
  directlyPrintCoa: boolean('directly_print_coa').notNull().default(false), allowManualResults: boolean('allow_manual_results').notNull().default(false),
  nonLimsMode: boolean('non_lims_mode').notNull().default(false), limsLabel: text('lims_label'),
  sampleAssociationMode: text('sample_association_mode').notNull().default('single'), defaultSampleCategoryId: uuid('default_sample_category_id'),

  // TR Settings: ID schemes and number series
  sampleNumberScheme: text('sample_number_scheme').notNull().default('SMP-{current_year:yyyy}-{sample_counter}'),
  testRequestNumberScheme: text('test_request_number_scheme').notNull().default('TR-{current_year:yyyy}-{tr_counter}'),
  jobNumberScheme: text('job_number_scheme').notNull().default('JOB-{current_year:yyyy}-{job_countall}'),
  sampleNumberStart: integer('sample_number_start').notNull().default(1), testRequestNumberStart: integer('test_request_number_start').notNull().default(1),
  instrumentBreakdownValidationEnabled: boolean('instrument_breakdown_validation_enabled').notNull().default(true),
  minimumMaterialValidationEnabled: boolean('minimum_material_validation_enabled').notNull().default(true),

  // Test Parameters Settings
  measurementUncertaintyEnabled: boolean('measurement_uncertainty_enabled').notNull().default(false),

  // Lab Settings: reminders (times/emails live in child tables below)
  reminderBeforeMinutes: integer('reminder_before_minutes').notNull().default(60),

  // NABL Settings extensions (schemeNonNablStartNumber above already covers the Non-NABL Start Number field)
  printNablOnNonNabl: boolean('print_nabl_on_non_nabl').notNull().default(false), onDemandUlr: boolean('on_demand_ulr').notNull().default(false),
  generateUlrForAmendment: boolean('generate_ulr_for_amendment').notNull().default(false),
  ulrStartNumber: integer('ulr_start_number').notNull().default(1), includeFInUlr: boolean('include_f_in_ulr').notNull().default(false),
  ulrNumberPadding: integer('ulr_number_padding').notNull().default(6), retentionDays: integer('retention_days').notNull().default(0),

  // Accounting
  companyLegalName: text('company_legal_name'), companyIdentificationNumber: text('company_identification_number'),
  companyTaxIdentifier: text('company_tax_identifier'), companyAddress: text('company_address'),

  // Tenant Settings extensions (Financial Year/Date-Time already covered by the scheme*/date*/datetime* columns above)
  defaultRetentionPeriod: integer('default_retention_period').notNull().default(0), defaultClassification: text('default_classification'),
  productLabel: text('product_label').notNull().default('Product'), sampleLabel: text('sample_label').notNull().default('Sample'),
  customerLabel: text('customer_label').notNull().default('Customer'), vendorLabel: text('vendor_label').notNull().default('Vendor'),
  sampleScheme: text('sample_scheme'), minimumPasswordLength: integer('minimum_password_length').notNull().default(12),
  maximumLoginAttempts: integer('maximum_login_attempts').notNull().default(5), supportSlug: text('support_slug'),
  operatingStartTime: time('operating_start_time'), operatingEndTime: time('operating_end_time'),
  environmentDataIntervalMinutes: integer('environment_data_interval_minutes'), projectDefaultPage: text('project_default_page'),
}, (t) => [
  primaryKey({ columns: [t.organizationId] }),
  foreignKey({ name: 'lab_settings_result_template_fk', columns: [t.organizationId, t.resultSummaryTemplateId], foreignColumns: [templates.organizationId, templates.id] }),
  foreignKey({ name: 'lab_settings_job_workflow_fk', columns: [t.organizationId, t.jobWorkflowId], foreignColumns: [workflows.organizationId, workflows.id] }),
  foreignKey({ name: 'lab_settings_request_workflow_fk', columns: [t.organizationId, t.testRequestWorkflowId], foreignColumns: [workflows.organizationId, workflows.id] }),
  ...[['base', t.sampleWorkflowBaseId], ['iqc', t.sampleWorkflowIqcId], ['ilc', t.sampleWorkflowIlcId], ['pt', t.sampleWorkflowPtId],
    ['amendment', t.sampleWorkflowAmendmentId], ['complaint', t.sampleWorkflowComplaintId]]
    .map(([key, column]) => foreignKey({ name: `lab_settings_sample_${key}_workflow_fk`, columns: [t.organizationId, column], foreignColumns: [workflows.organizationId, workflows.id] })),
  foreignKey({ name: 'lab_settings_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'lab_settings_default_category_fk', columns: [t.organizationId, t.defaultSampleCategoryId], foreignColumns: [sampleCategories.organizationId, sampleCategories.id] }),
  check('lab_settings_revision', sql`${t.revision}>0`),
  check('lab_settings_date_format', sql`length(${t.dateFormat})<=40`),
  check('lab_settings_datetime_format', sql`length(${t.datetimeFormat})<=60`),
  check('lab_settings_scheme_values', sql`length(${t.schemeCurrentYearDigits})<=128 and length(${t.schemeNextYearDigits})<=128
    and length(${t.schemeSeparator})<=250 and length(${t.schemeNonNablStartNumber})<=128
    and (${t.schemeMonthFormat} is null or ${t.schemeMonthFormat} in ('','number','short','long'))`),
  check('lab_settings_identity_fields', sql`length(${t.displayName})<=200 and length(${t.description})<=4000 and length(${t.tagline})<=300
    and length(${t.brandColor})<=20 and length(${t.nablNumber})<=100 and length(${t.locationCode})<=64
    and length(${t.entityName}) between 1 and 100 and length(${t.productEntityName}) between 1 and 100
    and (${t.headerStyle} is null or ${t.headerStyle} in ('fixed','floating'))`),
  check('lab_settings_sample_page_fields', sql`(${t.limsLabel} is null or length(${t.limsLabel})<=100)
    and ${t.sampleAssociationMode} in ('single','multiple')`),
  check('lab_settings_numbering_fields', sql`length(${t.sampleNumberScheme}) between 1 and 200 and length(${t.testRequestNumberScheme}) between 1 and 200
    and length(${t.jobNumberScheme}) between 1 and 200 and ${t.sampleNumberStart}>0 and ${t.testRequestNumberStart}>0`),
  check('lab_settings_nabl_fields', sql`${t.ulrStartNumber}>0 and ${t.ulrNumberPadding} between 1 and 20 and ${t.retentionDays}>=0`),
  check('lab_settings_accounting_fields', sql`length(${t.companyLegalName})<=250 and length(${t.companyIdentificationNumber})<=100
    and length(${t.companyTaxIdentifier})<=100 and length(${t.companyAddress})<=4000`),
  check('lab_settings_tenant_fields', sql`${t.defaultRetentionPeriod}>=0 and length(${t.defaultClassification})<=150
    and length(${t.productLabel}) between 1 and 100 and length(${t.sampleLabel}) between 1 and 100
    and length(${t.customerLabel}) between 1 and 100 and length(${t.vendorLabel}) between 1 and 100
    and length(${t.sampleScheme})<=200 and ${t.minimumPasswordLength} between 8 and 200 and ${t.maximumLoginAttempts} between 1 and 20
    and length(${t.supportSlug})<=100 and (${t.environmentDataIntervalMinutes} is null or ${t.environmentDataIntervalMinutes}>0)
    and (${t.operatingStartTime} is null or ${t.operatingEndTime} is null or ${t.operatingStartTime}<>${t.operatingEndTime})
    and (${t.projectDefaultPage} is null or ${t.projectDefaultPage} in ('overview','stages','files','update_history','workflow','team','requests','planner','critical_params','project_metadata','project_rationale','activity_log'))`),
]);

export const organizationReminderTimes = pgTable('organization_reminder_times', {
  organizationId: uuid('organization_id').notNull(), reminderTime: time('reminder_time').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.reminderTime] })]);

export const organizationReminderEmails = pgTable('organization_reminder_emails', {
  organizationId: uuid('organization_id').notNull(), email: text('email').notNull(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.email] }),
  check('org_reminder_email_format', sql`${t.email} ~ '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' and ${t.email}=lower(${t.email}) and length(${t.email})<=254`),
]);

export const organizationCustomTableRoles = pgTable('organization_custom_table_roles', {
  organizationId: uuid('organization_id').notNull(), roleId: uuid('role_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.roleId] }),
  foreignKey({ name: 'org_custom_table_role_fk', columns: [t.organizationId, t.roleId], foreignColumns: [roles.organizationId, roles.id] }),
]);

// Purposes distinct from sample-category per-purpose templates (a separate, already-built feature)
// and from result_summary_template_id above ("Job Template"): that field already exists as its own
// column with its own consumers (Jobs/Test Requests), so "result_summary" is deliberately not one of
// the purposes here — adding a second, disconnected storage location for the same concept would
// silently orphan the existing field's UI and its consumers.
export const organizationTemplateDefaults = pgTable('organization_template_defaults', {
  organizationId: uuid('organization_id').notNull(), purpose: text('purpose').notNull(), templateId: uuid('template_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.purpose] }),
  foreignKey({ name: 'org_template_default_fk', columns: [t.organizationId, t.templateId], foreignColumns: [templates.organizationId, templates.id] }),
  check('org_template_default_purpose', sql`${t.purpose} in ('acknowledgement','result_page','ilc_report','comparative_report','intralab_report')`),
]);

export const organizationDocumentSettings = pgTable('organization_document_settings', {
  organizationId: uuid('organization_id').notNull(), documentType: text('document_type').notNull(),
  numberScheme: text('number_scheme'), numberPadding: integer('number_padding'), headerTemplateId: uuid('header_template_id'),
  headerHeightMm: integer('header_height_mm'),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.documentType] }),
  foreignKey({ name: 'org_document_setting_header_fk', columns: [t.organizationId, t.headerTemplateId], foreignColumns: [templates.organizationId, templates.id] }),
  check('org_document_setting_type', sql`${t.documentType} in ('proforma_invoice','quotation','label','sample_receipt','sample_request')`),
  check('org_document_setting_fields', sql`length(${t.numberScheme})<=200 and (${t.numberPadding} is null or ${t.numberPadding} between 1 and 20)
    and (${t.headerHeightMm} is null or ${t.headerHeightMm}>0)`),
]);

export const organizationAllocatedFields = pgTable('organization_allocated_fields', {
  organizationId: uuid('organization_id').notNull(), fieldKey: text('field_key').notNull(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.fieldKey] }),
  check('org_allocated_field_key', sql`${t.fieldKey} in ('disciplines','customer','retained','generate_url','blind','product')`),
]);

export const organizationSampleListingFields = pgTable('organization_sample_listing_fields', {
  organizationId: uuid('organization_id').notNull(), fieldKey: text('field_key').notNull(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.fieldKey] }),
  check('org_sample_listing_field_key', sql`${t.fieldKey} in ('customer','product','created_date','category','status','ulr_number')`),
]);

export const organizationProjectTabs = pgTable('organization_project_tabs', {
  organizationId: uuid('organization_id').notNull(), tabKey: text('tab_key').notNull(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.tabKey] }),
  check('org_project_tab_key', sql`${t.tabKey} in ('overview','stages','files','update_history','workflow','team','requests','planner','critical_params','project_metadata','project_rationale','activity_log')`),
]);

// Instrument service types are a fixed set (Preventive Maintenance, Breakdown, Calibration);
// see instrument-schema.js's instrumentVersionServices for the fixed-value CHECK.

export const organizationModuleAccessVersions = pgTable('organization_module_access_versions', {
  organizationId: uuid('organization_id').notNull(), revision: integer('revision').notNull(), savedBy: uuid('saved_by').notNull(),
  moduleCount: integer('module_count').notNull().default(5),
  savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, t => [
  primaryKey({ name: 'module_access_version_pk', columns: [t.organizationId, t.revision] }),
  foreignKey({ name: 'module_access_settings_fk', columns: [t.organizationId], foreignColumns: [organizationLaboratorySettings.organizationId] }),
  foreignKey({ name: 'module_access_actor_fk', columns: [t.organizationId, t.savedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('module_access_revision', sql`${t.revision}>0`),
  check('module_access_count', sql`${t.moduleCount} in (2,3,4,5)`),
]);

export const organizationModuleAccessModules = pgTable('organization_module_access_modules', {
  organizationId: uuid('organization_id').notNull(), revision: integer('revision').notNull(), moduleKey: text('module_key').notNull(),
  enabled: boolean('enabled').notNull(), roleCount: integer('role_count').notNull(), userCount: integer('user_count').notNull(),
}, t => [
  primaryKey({ name: 'module_access_module_pk', columns: [t.organizationId, t.revision, t.moduleKey] }),
  foreignKey({ name: 'module_access_module_version_fk', columns: [t.organizationId, t.revision],
    foreignColumns: [organizationModuleAccessVersions.organizationId, organizationModuleAccessVersions.revision] }),
  check('module_access_module_fields', sql`${t.moduleKey} in ('customer','vendor','instrument','service_agreements','inventory') and ${t.roleCount} between 0 and 500 and ${t.userCount} between 0 and 500`),
]);

export const organizationModuleAccessRoles = pgTable('organization_module_access_roles', {
  organizationId: uuid('organization_id').notNull(), revision: integer('revision').notNull(), moduleKey: text('module_key').notNull(),
  roleId: uuid('role_id').notNull(), position: integer('position').notNull(), roleName: text('role_name').notNull(), roleActive: boolean('role_active').notNull(),
}, t => [
  primaryKey({ name: 'module_access_role_pk', columns: [t.organizationId, t.revision, t.moduleKey, t.roleId] }),
  unique('module_access_role_position').on(t.organizationId, t.revision, t.moduleKey, t.position),
  foreignKey({ name: 'module_access_role_module_fk', columns: [t.organizationId, t.revision, t.moduleKey],
    foreignColumns: [organizationModuleAccessModules.organizationId, organizationModuleAccessModules.revision, organizationModuleAccessModules.moduleKey] }),
  foreignKey({ name: 'module_access_role_reference_fk', columns: [t.organizationId, t.roleId], foreignColumns: [roles.organizationId, roles.id] }),
  check('module_access_role_fields', sql`${t.position} between 0 and 499`),
]);

export const organizationModuleAccessUsers = pgTable('organization_module_access_users', {
  organizationId: uuid('organization_id').notNull(), revision: integer('revision').notNull(), moduleKey: text('module_key').notNull(),
  userId: uuid('user_id').notNull(), position: integer('position').notNull(), userName: text('user_name').notNull(), userUsername: text('user_username').notNull(), userActive: boolean('user_active').notNull(),
}, t => [
  primaryKey({ name: 'module_access_user_pk', columns: [t.organizationId, t.revision, t.moduleKey, t.userId] }),
  unique('module_access_user_position').on(t.organizationId, t.revision, t.moduleKey, t.position),
  foreignKey({ name: 'module_access_user_module_fk', columns: [t.organizationId, t.revision, t.moduleKey],
    foreignColumns: [organizationModuleAccessModules.organizationId, organizationModuleAccessModules.revision, organizationModuleAccessModules.moduleKey] }),
  foreignKey({ name: 'module_access_user_reference_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('module_access_user_fields', sql`${t.position} between 0 and 499`),
]);
