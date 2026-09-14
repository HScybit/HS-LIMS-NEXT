import { sql } from 'drizzle-orm';
import { pgTable, pgView, uuid, text, boolean, timestamp, integer, numeric, date, primaryKey, unique, uniqueIndex, index, check, foreignKey, customType } from 'drizzle-orm/pg-core';
import { organizations, memberships, roles } from './schema.js';
import { templates } from './template-schema.js';
import { sampleCategories } from './master-schema.js';
import { checklists, checklistVersions } from './checklist-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const identity = () => ({ organizationId: tenant(), id: uuid('id').notNull().defaultRandom() });
const key = (t) => primaryKey({ columns: [t.organizationId, t.id] });
const link = (t, column, target) => foreignKey({ columns: [t.organizationId, column], foreignColumns: [target.organizationId, target.id] });
const actor = (t, column) => foreignKey({ columns: [t.organizationId, column], foreignColumns: [memberships.organizationId, memberships.userId] });
const transactionId = customType({ dataType: () => 'xid8' });
const bytes = customType({ dataType: () => 'bytea' });

export const workflowRoleLabels = pgView('workflow_role_labels', {
  organizationId: uuid('organization_id'), id: uuid('id'), name: text('name'), active: boolean('active'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT organization_id,id,name,active FROM public.roles
  WHERE organization_id=(SELECT public.workflow_reference_organization())
`);

export const workflowTemplateLabels = pgView('workflow_template_labels', {
  organizationId: uuid('organization_id'), id: uuid('id'), name: text('name'), active: boolean('active'),
}).with({ securityBarrier: true, securityInvoker: false }).as(sql`
  SELECT template.organization_id,template.id,version.name,template.active FROM public.templates template
  JOIN LATERAL (
    SELECT name FROM public.template_versions version
    WHERE version.organization_id=template.organization_id AND version.template_id=template.id AND version.status<>'building'
    ORDER BY (version.status='draft') DESC,version.number DESC LIMIT 1
  ) version ON true
  WHERE template.organization_id=(SELECT public.workflow_reference_organization())
`);

export const workflows = pgTable('workflows', {
  ...identity(), code: text('code').notNull(), name: text('name').notNull(), description: text('description').notNull().default(''),
  appliesTo: text('applies_to').notNull(), active: boolean('active').notNull().default(true), createdAt: time('created_at').notNull().defaultNow(),
  // Zero and NULL distinguish metadata that predates recorded edit history.
  metadataRevision: integer('metadata_revision').notNull().default(0), createdBy: uuid('created_by'), updatedBy: uuid('updated_by'), updatedAt: time('updated_at'),
}, (t) => [key(t), actor(t, t.createdBy), actor(t, t.updatedBy), uniqueIndex('workflow_code_key').on(t.organizationId, sql`lower(${t.code})`), unique('workflow_entity_type_key').on(t.organizationId, t.id, t.appliesTo),
  index('workflow_active_name').on(t.organizationId, t.name).where(sql`${t.active}`), check('workflow_metadata_revision', sql`${t.metadataRevision}>=0`),
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

export const workflowMetadataVersions = pgTable('workflow_metadata_versions', {
  organizationId: tenant(), workflowId: uuid('workflow_id').notNull(), revision: integer('revision').notNull(), requestId: uuid('request_id').notNull(),
  previousRevision: integer('previous_revision'), operation: text('operation').notNull(), initialVersionId: uuid('initial_version_id'),
  code: text('code').notNull(), name: text('name').notNull(), description: text('description').notNull(), appliesTo: text('applies_to').notNull(), active: boolean('active').notNull(),
  requestedCode: text('requested_code'), generatedCode: boolean('generated_code').notNull(), descriptionProvided: boolean('description_provided').notNull(),
  requestedAppliesTo: text('requested_applies_to'), requestedActive: boolean('requested_active'),
  savedBy: uuid('saved_by').notNull(), savedAt: time('saved_at').notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (t) => [primaryKey({ name: 'workflow_metadata_version_pk', columns: [t.organizationId, t.workflowId, t.revision] }),
  unique('workflow_metadata_request_key').on(t.organizationId, t.requestId), link(t, t.workflowId, workflows), link(t, t.initialVersionId, workflowVersions), actor(t, t.savedBy),
  check('workflow_metadata_history_revision', sql`(${t.operation}='create' and ${t.previousRevision} is null and ${t.revision}=1 and ${t.initialVersionId} is not null)
    or (${t.operation} in ('update','retire') and ${t.previousRevision} is not null and ${t.previousRevision}>=0 and ${t.revision}=${t.previousRevision}+1 and ${t.initialVersionId} is null)`),
  check('workflow_metadata_history_fields', sql`length(trim(${t.code})) between 1 and 64 and length(trim(${t.name})) between 1 and 200
    and ${t.appliesTo} in ('sample','test_request') and (${t.requestedAppliesTo} is null or ${t.requestedAppliesTo} in ('sample','test_request'))
    and (not ${t.generatedCode} or (${t.operation}='create' and ${t.requestedCode} is not null))
    and (${t.operation}<>'retire' or (not ${t.active} and not ${t.descriptionProvided} and not ${t.generatedCode}
      and num_nonnulls(${t.requestedCode},${t.requestedAppliesTo},${t.requestedActive})=0))`),
]);

export const workflowCloneOrigins = pgTable('workflow_clone_origins', {
  organizationId: tenant(), workflowId: uuid('workflow_id').notNull(), workflowVersionId: uuid('workflow_version_id').notNull(),
  clonedRevision: integer('cloned_revision').notNull(),
  sourceWorkflowId: uuid('source_workflow_id').notNull(), sourceVersionId: uuid('source_version_id').notNull(),
  sourceRevision: integer('source_revision').notNull(), sourceMetadataRevision: integer('source_metadata_revision').notNull(),
  requestedSourceVersionId: uuid('requested_source_version_id'), requestId: uuid('request_id').notNull(),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (t) => [primaryKey({ name: 'workflow_clone_origin_pk', columns: [t.organizationId, t.workflowId] }),
  unique('workflow_clone_request_key').on(t.organizationId, t.requestId),
  ...[[t.workflowId, workflows, 'workflow_clone_target_fk'], [t.sourceWorkflowId, workflows, 'workflow_clone_source_fk'],
    [t.workflowVersionId, workflowVersions, 'workflow_clone_version_fk'], [t.sourceVersionId, workflowVersions, 'workflow_clone_source_version_fk'],
    [t.requestedSourceVersionId, workflowVersions, 'workflow_clone_requested_version_fk']].map(([column, table, name]) => foreignKey({
    name, columns: [t.organizationId, column], foreignColumns: [table.organizationId, table.id],
  })),
  foreignKey({ name: 'workflow_clone_request_fk', columns: [t.organizationId, t.requestId], foreignColumns: [workflowMetadataVersions.organizationId, workflowMetadataVersions.requestId] }),
  foreignKey({ name: 'workflow_clone_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('workflow_clone_origin_identity', sql`${t.workflowId}<>${t.sourceWorkflowId} and ${t.workflowVersionId}<>${t.sourceVersionId}
    and ${t.clonedRevision}>0 and ${t.sourceRevision}>0 and ${t.sourceMetadataRevision}>=0`),
]);

export const workflowEditorCommands = pgTable('workflow_editor_commands', {
  organizationId: tenant(), requestId: uuid('request_id').notNull(), workflowId: uuid('workflow_id').notNull(),
  sourceVersionId: uuid('source_version_id').notNull(), sourceRevision: integer('source_revision').notNull(),
  workflowVersionId: uuid('workflow_version_id').notNull(), revision: integer('revision').notNull(),
  operation: text('operation').notNull(), sourceElementId: uuid('source_element_id'), elementId: uuid('element_id'),
  fingerprint: bytes('fingerprint').notNull(), savedBy: uuid('saved_by').notNull(), savedAt: time('saved_at').notNull().defaultNow(),
  createdTransactionId: transactionId('created_transaction_id').notNull().default(sql`pg_current_xact_id()`),
}, (t) => [primaryKey({ name: 'workflow_editor_command_pk', columns: [t.organizationId, t.requestId] }),
  unique('workflow_editor_command_revision_key').on(t.organizationId, t.workflowVersionId, t.revision),
  link(t, t.workflowId, workflows), link(t, t.sourceVersionId, workflowVersions), link(t, t.workflowVersionId, workflowVersions), actor(t, t.savedBy),
  check('workflow_editor_command_operation', sql`${t.operation} in ('create_state','patch_state','delete_state','create_transition','patch_transition','delete_transition','publish')`),
  check('workflow_editor_command_revision', sql`${t.sourceRevision}>0 and ${t.revision}>1 and (
    (${t.sourceVersionId}=${t.workflowVersionId} and ${t.revision}=${t.sourceRevision}+1)
    or (${t.sourceVersionId}<>${t.workflowVersionId} and ${t.revision}=2 and ${t.operation}<>'publish'))`),
  check('workflow_editor_command_elements', sql`(
    (${t.operation} in ('patch_state','delete_state','patch_transition','delete_transition') and ${t.sourceElementId} is not null and ${t.elementId} is not null
      and (${t.sourceVersionId}<>${t.workflowVersionId} or ${t.sourceElementId}=${t.elementId}))
    or (${t.operation} in ('create_state','create_transition') and ${t.sourceElementId} is null and ${t.elementId} is not null)
    or (${t.operation}='publish' and ${t.sourceElementId} is null and ${t.elementId} is null))`),
  check('workflow_editor_command_fingerprint', sql`octet_length(${t.fingerprint})=32`),
]);

export const workflowStates = pgTable('workflow_states', {
  ...identity(), workflowVersionId: uuid('workflow_version_id').notNull(), code: text('code').notNull(), name: text('name').notNull(),
  description: text('description').notNull().default(''), stateType: text('state_type').notNull().default('normal'), displayOrder: integer('display_order').notNull().default(0), color: text('color'),
  legacyTrState: text('legacy_tr_state'),
  // Earlier definitions did not record canvas layout. Preserve that absence in history and copies.
  canvasX: integer('canvas_x'), canvasY: integer('canvas_y'), inputCount: integer('input_count'), outputCount: integer('output_count'), badgeStyle: text('badge_style'),
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
  check('workflow_state_legacy_tr_state', sql`${t.legacyTrState} is null or length(${t.legacyTrState}) <= 150`),
  check('workflow_state_layout', sql`(${t.canvasX} is null or ${t.canvasX} between 0 and 100000) and (${t.canvasY} is null or ${t.canvasY} between 0 and 100000)
    and (${t.inputCount} is null or ${t.inputCount} between 0 and 8) and (${t.outputCount} is null or ${t.outputCount} between 0 and 8)
    and (${t.badgeStyle} is null or ${t.badgeStyle} in ('light','dark'))`),
  check('workflow_state_details', sql`${t.stateType} in ('initial', 'normal', 'final', 'cancelled') and ${t.displayOrder} >= 0 and length(trim(${t.code})) between 1 and 64 and length(trim(${t.name})) between 1 and 150`)]);

export const workflowStateCapabilityRoles = pgTable('workflow_state_capability_roles', {
  organizationId: tenant(), workflowStateId: uuid('workflow_state_id').notNull(), capability: text('capability').notNull(), roleId: uuid('role_id').notNull(),
}, (t) => [primaryKey({ name: 'workflow_state_capability_role_pk', columns: [t.organizationId, t.workflowStateId, t.capability, t.roleId] }), link(t, t.workflowStateId, workflowStates), link(t, t.roleId, roles),
  check('workflow_state_capability', sql`${t.capability} in ('view', 'edit', 'allocate', 'execute', 'review', 'approve', 'cancel', 'download_report')`)]);

export const workflowTransitions = pgTable('workflow_transitions', {
  ...identity(), workflowVersionId: uuid('workflow_version_id').notNull(), code: text('code').notNull(), name: text('name').notNull(),
  sourceStateId: uuid('source_state_id').notNull(), targetStateId: uuid('target_state_id').notNull(), approvalMode: text('approval_mode').notNull().default('none'),
  sourcePort: integer('source_port'), targetPort: integer('target_port'),
  checklistMasterId: uuid('checklist_master_id'), checklistMasterRevision: integer('checklist_master_revision'),
  autoExecute: boolean('auto_execute').notNull().default(false), autoMoveMode: text('auto_move_mode'),
  requireComment: boolean('require_comment').notNull().default(false), displayOrder: integer('display_order').notNull().default(0),
}, (t) => [key(t), link(t, t.workflowVersionId, workflowVersions), unique('workflow_transition_code_key').on(t.organizationId, t.workflowVersionId, t.code),
  unique('workflow_transition_version_key').on(t.organizationId, t.workflowVersionId, t.id),
  index('workflow_transition_source').on(t.organizationId, t.workflowVersionId, t.sourceStateId),
  index('workflow_transition_target').on(t.organizationId, t.workflowVersionId, t.targetStateId),
  index('workflow_transition_checklist_master').on(t.organizationId, t.checklistMasterId).where(sql`${t.checklistMasterId} is not null`),
  foreignKey({ name: 'workflow_transition_checklist_master_fk', columns: [t.organizationId, t.checklistMasterId], foreignColumns: [checklists.organizationId, checklists.id] }),
  foreignKey({ name: 'workflow_transition_checklist_version_fk', columns: [t.organizationId, t.checklistMasterId, t.checklistMasterRevision], foreignColumns: [checklistVersions.organizationId, checklistVersions.checklistId, checklistVersions.revision] }),
  check('workflow_transition_checklist_binding', sql`${t.checklistMasterRevision} is null or (${t.checklistMasterId} is not null and ${t.checklistMasterRevision}>0)`),
  check('workflow_transition_auto_move_mode', sql`${t.autoMoveMode} is null or ${t.autoMoveMode} in ('yes','no','all_trs_allocated','all_trs_approved')`),
  check('workflow_transition_auto_move_pair', sql`${t.autoMoveMode} is null or ${t.autoExecute}=(${t.autoMoveMode}='yes')`),
  check('workflow_transition_ports', sql`(${t.sourcePort} is null or ${t.sourcePort} between 1 and 8) and (${t.targetPort} is null or ${t.targetPort} between 1 and 8)`),
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
