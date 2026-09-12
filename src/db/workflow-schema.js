import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, integer, numeric, date, primaryKey, unique, uniqueIndex, check, foreignKey } from 'drizzle-orm/pg-core';
import { organizations, memberships, roles } from './schema.js';
import { templates } from './template-schema.js';
import { sampleCategories } from './master-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const identity = () => ({ organizationId: tenant(), id: uuid('id').notNull().defaultRandom() });
const key = (t) => primaryKey({ columns: [t.organizationId, t.id] });
const link = (t, column, target) => foreignKey({ columns: [t.organizationId, column], foreignColumns: [target.organizationId, target.id] });
const actor = (t, column) => foreignKey({ columns: [t.organizationId, column], foreignColumns: [memberships.organizationId, memberships.userId] });

export const workflows = pgTable('workflows', {
  ...identity(), code: text('code').notNull(), name: text('name').notNull(), description: text('description').notNull().default(''),
  appliesTo: text('applies_to').notNull(), active: boolean('active').notNull().default(true), createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [key(t), uniqueIndex('workflow_code_key').on(t.organizationId, sql`lower(${t.code})`), unique('workflow_entity_type_key').on(t.organizationId, t.id, t.appliesTo),
  check('workflow_metadata', sql`length(trim(${t.code})) between 1 and 64 and length(trim(${t.name})) between 1 and 200 and ${t.appliesTo} in ('sample', 'test_request')`)]);

export const workflowVersions = pgTable('workflow_versions', {
  ...identity(), workflowId: uuid('workflow_id').notNull(), number: integer('number').notNull(), revision: integer('revision').notNull().default(1),
  status: text('status').notNull().default('draft'), changeSummary: text('change_summary').notNull().default(''),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(), publishedBy: uuid('published_by'), publishedAt: time('published_at'), retiredAt: time('retired_at'),
}, (t) => [key(t), link(t, t.workflowId, workflows), actor(t, t.createdBy), actor(t, t.publishedBy), unique('workflow_version_number_key').on(t.organizationId, t.workflowId, t.number),
  uniqueIndex('workflow_one_draft_key').on(t.organizationId, t.workflowId).where(sql`${t.status} = 'draft'`),
  check('workflow_version_revision', sql`${t.number} > 0 and ${t.revision} > 0`),
  check('workflow_version_status', sql`(${t.status} = 'draft' and ${t.publishedBy} is null and ${t.publishedAt} is null and ${t.retiredAt} is null)
    or (${t.status} = 'published' and ${t.publishedBy} is not null and ${t.publishedAt} is not null and ${t.retiredAt} is null)
    or (${t.status} = 'retired' and ${t.publishedBy} is not null and ${t.publishedAt} is not null and ${t.retiredAt} is not null and ${t.retiredAt} >= ${t.publishedAt})`)]);

export const workflowStates = pgTable('workflow_states', {
  ...identity(), workflowVersionId: uuid('workflow_version_id').notNull(), code: text('code').notNull(), name: text('name').notNull(),
  description: text('description').notNull().default(''), stateType: text('state_type').notNull().default('normal'), displayOrder: integer('display_order').notNull().default(0), color: text('color'),
  templateId: uuid('template_id'), showSampleEdit: boolean('show_sample_edit').notNull().default(false), showSampleRetest: boolean('show_sample_retest').notNull().default(false),
  showSampleReissue: boolean('show_sample_reissue').notNull().default(false), enableTemplateValidation: boolean('enable_template_validation').notNull().default(false),
  enableCriticalParametersValidation: boolean('enable_critical_parameters_validation').notNull().default(false), showAddResult: boolean('show_add_result').notNull().default(false),
  generateTestRequests: boolean('generate_test_requests').notNull().default(false), requireAllTestRequestsAllocated: boolean('require_all_test_requests_allocated').notNull().default(false),
  requireAllTestRequestsApproved: boolean('require_all_test_requests_approved').notNull().default(false), fetchEnvironmentData: boolean('fetch_environment_data').notNull().default(false),
  canWorkOnTestRequest: boolean('can_work_on_test_request').notNull().default(false), isPositiveTermination: boolean('is_positive_termination').notNull().default(false),
  enableJobCard: boolean('enable_job_card').notNull().default(false),
}, (t) => [key(t), link(t, t.workflowVersionId, workflowVersions), link(t, t.templateId, templates),
  unique('workflow_state_version_key').on(t.organizationId, t.workflowVersionId, t.id), unique('workflow_state_code_key').on(t.organizationId, t.workflowVersionId, t.code),
  uniqueIndex('workflow_single_state_type_key').on(t.organizationId, t.workflowVersionId, t.stateType).where(sql`${t.stateType} in ('initial', 'final', 'cancelled')`),
  check('workflow_state_details', sql`${t.stateType} in ('initial', 'normal', 'final', 'cancelled') and ${t.displayOrder} >= 0 and length(trim(${t.code})) between 1 and 64 and length(trim(${t.name})) between 1 and 150`)]);

export const workflowStateCapabilityRoles = pgTable('workflow_state_capability_roles', {
  organizationId: tenant(), workflowStateId: uuid('workflow_state_id').notNull(), capability: text('capability').notNull(), roleId: uuid('role_id').notNull(),
}, (t) => [primaryKey({ name: 'workflow_state_capability_role_pk', columns: [t.organizationId, t.workflowStateId, t.capability, t.roleId] }), link(t, t.workflowStateId, workflowStates), link(t, t.roleId, roles),
  check('workflow_state_capability', sql`${t.capability} in ('view', 'edit', 'allocate', 'execute', 'review', 'approve', 'cancel', 'download_report')`)]);

export const workflowTransitions = pgTable('workflow_transitions', {
  ...identity(), workflowVersionId: uuid('workflow_version_id').notNull(), code: text('code').notNull(), name: text('name').notNull(),
  sourceStateId: uuid('source_state_id').notNull(), targetStateId: uuid('target_state_id').notNull(), approvalMode: text('approval_mode').notNull().default('none'),
  autoExecute: boolean('auto_execute').notNull().default(false), requireComment: boolean('require_comment').notNull().default(false), displayOrder: integer('display_order').notNull().default(0),
}, (t) => [key(t), link(t, t.workflowVersionId, workflowVersions), unique('workflow_transition_code_key').on(t.organizationId, t.workflowVersionId, t.code),
  unique('workflow_transition_version_key').on(t.organizationId, t.workflowVersionId, t.id),
  foreignKey({ name: 'workflow_transition_source_state_fk', columns: [t.organizationId, t.workflowVersionId, t.sourceStateId], foreignColumns: [workflowStates.organizationId, workflowStates.workflowVersionId, workflowStates.id] }),
  foreignKey({ name: 'workflow_transition_target_state_fk', columns: [t.organizationId, t.workflowVersionId, t.targetStateId], foreignColumns: [workflowStates.organizationId, workflowStates.workflowVersionId, workflowStates.id] }),
  check('workflow_transition_details', sql`${t.sourceStateId} <> ${t.targetStateId} and ${t.approvalMode} in ('none', 'any', 'all', 'sequential') and ${t.displayOrder} >= 0 and length(trim(${t.code})) between 1 and 64 and length(trim(${t.name})) between 1 and 150`)]);

export const workflowTransitionCreatorRoles = pgTable('workflow_transition_creator_roles', {
  organizationId: tenant(), transitionId: uuid('transition_id').notNull(), roleId: uuid('role_id').notNull(),
}, (t) => [primaryKey({ name: 'workflow_creator_role_pk', columns: [t.organizationId, t.transitionId, t.roleId] }), link(t, t.transitionId, workflowTransitions), link(t, t.roleId, roles)]);

export const workflowTransitionApproverRoles = pgTable('workflow_transition_approver_roles', {
  organizationId: tenant(), transitionId: uuid('transition_id').notNull(), roleId: uuid('role_id').notNull(), stageNumber: integer('stage_number').notNull(),
}, (t) => [primaryKey({ name: 'workflow_approver_role_pk', columns: [t.organizationId, t.transitionId, t.stageNumber, t.roleId] }), link(t, t.transitionId, workflowTransitions), link(t, t.roleId, roles),
  check('workflow_approver_stage_number', sql`${t.stageNumber} between 1 and 100`)]);

export const workflowTransitionCcRoles = pgTable('workflow_transition_cc_roles', {
  organizationId: tenant(), transitionId: uuid('transition_id').notNull(), roleId: uuid('role_id').notNull(),
}, (t) => [primaryKey({ name: 'workflow_cc_role_pk', columns: [t.organizationId, t.transitionId, t.roleId] }), link(t, t.transitionId, workflowTransitions), link(t, t.roleId, roles)]);

export const workflowTransitionCcEmails = pgTable('workflow_transition_cc_emails', {
  organizationId: tenant(), transitionId: uuid('transition_id').notNull(), email: text('email').notNull(),
}, (t) => [primaryKey({ name: 'workflow_cc_email_pk', columns: [t.organizationId, t.transitionId, t.email] }), link(t, t.transitionId, workflowTransitions),
  check('workflow_cc_email', sql`length(${t.email}) between 3 and 320 and ${t.email} = lower(trim(${t.email})) and ${t.email} ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'`)]);

export const workflowTransitionConditions = pgTable('workflow_transition_conditions', {
  ...identity(), transitionId: uuid('transition_id').notNull(), sourceField: text('source_field').notNull(), operator: text('operator').notNull(),
  comparisonText: text('comparison_text'), comparisonNumber: numeric('comparison_number'), comparisonBoolean: boolean('comparison_boolean'), comparisonDate: date('comparison_date'),
  displayOrder: integer('display_order').notNull().default(0),
}, (t) => [key(t), link(t, t.transitionId, workflowTransitions),
  check('workflow_condition_details', sql`length(trim(${t.sourceField})) between 1 and 150 and ${t.operator} in ('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'is_null', 'is_not_null')
    and ${t.displayOrder} >= 0 and num_nonnulls(${t.comparisonText}, ${t.comparisonNumber}, ${t.comparisonBoolean}, ${t.comparisonDate}) <= 1
    and (${t.comparisonText} is null or length(${t.comparisonText}) <= 5000)
    and (${t.comparisonNumber} is null or ${t.comparisonNumber}::text not in ('NaN', 'Infinity', '-Infinity'))`)]);

export const workflowTransitionChecklistItems = pgTable('workflow_transition_checklist_items', {
  ...identity(), transitionId: uuid('transition_id').notNull(), prompt: text('prompt').notNull(), isRequired: boolean('is_required').notNull().default(true), displayOrder: integer('display_order').notNull().default(0),
}, (t) => [key(t), link(t, t.transitionId, workflowTransitions), unique('workflow_checklist_transition_key').on(t.organizationId, t.transitionId, t.id),
  check('workflow_checklist_details', sql`length(trim(${t.prompt})) between 1 and 500 and ${t.displayOrder} >= 0`)]);

export const sampleCategoryWorkflows = pgTable('sample_category_workflows', {
  organizationId: tenant(), sampleCategoryId: uuid('sample_category_id').notNull(), workflowId: uuid('workflow_id').notNull(), appliesTo: text('applies_to').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
}, (t) => [primaryKey({ columns: [t.organizationId, t.sampleCategoryId, t.workflowId, t.appliesTo] }), link(t, t.sampleCategoryId, sampleCategories),
  foreignKey({ columns: [t.organizationId, t.workflowId, t.appliesTo], foreignColumns: [workflows.organizationId, workflows.id, workflows.appliesTo] }),
  uniqueIndex('sample_category_default_workflow_key').on(t.organizationId, t.sampleCategoryId, t.appliesTo).where(sql`${t.isDefault}`),
  check('sample_category_workflow_type', sql`${t.appliesTo} in ('sample', 'test_request')`)]);
