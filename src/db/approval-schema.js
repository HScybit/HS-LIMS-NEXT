import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, integer, primaryKey, unique, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { organizations, memberships, roles } from './schema.js';
import { workflowTransitions, workflowTransitionChecklistItems } from './workflow-schema.js';
import { workflowRuns, workflowRunHistory } from './sample-schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);
const identity = () => ({ organizationId: tenant(), id: uuid('id').notNull().defaultRandom() });
const key = (t) => primaryKey({ columns: [t.organizationId, t.id] });
const link = (t, column, target) => foreignKey({ columns: [t.organizationId, column], foreignColumns: [target.organizationId, target.id] });
const actor = (t, column) => foreignKey({ columns: [t.organizationId, column], foreignColumns: [memberships.organizationId, memberships.userId] });

// The request's actor, timestamp, comment and selected edge are canonical in the
// append-only workflow history. Cases hold only approval lifecycle information.
export const approvalCases = pgTable('approval_cases', {
  ...identity(), workflowRunId: uuid('workflow_run_id').notNull(), workflowVersionId: uuid('workflow_version_id').notNull(),
  transitionId: uuid('transition_id').notNull(), requestHistoryId: uuid('request_history_id').notNull(), runRevision: integer('run_revision').notNull(),
  status: text('status').notNull().default('pending'), resolvedAt: time('resolved_at'),
}, (t) => [key(t),
  foreignKey({ name: 'approval_case_run_fk', columns: [t.organizationId, t.workflowRunId, t.workflowVersionId], foreignColumns: [workflowRuns.organizationId, workflowRuns.id, workflowRuns.workflowVersionId] }),
  foreignKey({ name: 'approval_case_transition_fk', columns: [t.organizationId, t.workflowVersionId, t.transitionId], foreignColumns: [workflowTransitions.organizationId, workflowTransitions.workflowVersionId, workflowTransitions.id] }),
  foreignKey({ name: 'approval_case_request_fk', columns: [t.organizationId, t.requestHistoryId, t.transitionId], foreignColumns: [workflowRunHistory.organizationId, workflowRunHistory.id, workflowRunHistory.transitionId] }),
  unique('approval_case_request_key').on(t.organizationId, t.requestHistoryId),
  uniqueIndex('approval_one_pending_run_key').on(t.organizationId, t.workflowRunId).where(sql`${t.status} = 'pending'`),
  check('approval_case_state', sql`${t.runRevision} > 0 and ((${t.status} = 'pending' and ${t.resolvedAt} is null) or (${t.status} in ('approved', 'rejected', 'cancelled') and ${t.resolvedAt} is not null))`)]);

export const approvalStages = pgTable('approval_stages', {
  ...identity(), approvalCaseId: uuid('approval_case_id').notNull(), stageNumber: integer('stage_number').notNull(),
  completionRule: text('completion_rule').notNull(), status: text('status').notNull().default('waiting'), activatedAt: time('activated_at'), resolvedAt: time('resolved_at'),
}, (t) => [key(t), link(t, t.approvalCaseId, approvalCases), unique('approval_stage_number_key').on(t.organizationId, t.approvalCaseId, t.stageNumber),
  uniqueIndex('approval_one_pending_stage_key').on(t.organizationId, t.approvalCaseId).where(sql`${t.status} = 'pending'`),
  check('approval_stage_details', sql`${t.stageNumber} between 1 and 100 and ${t.completionRule} in ('any', 'all')
    and ((${t.status} = 'waiting' and ${t.activatedAt} is null and ${t.resolvedAt} is null)
      or (${t.status} = 'pending' and ${t.activatedAt} is not null and ${t.resolvedAt} is null)
      or (${t.status} in ('approved', 'rejected') and ${t.activatedAt} is not null and ${t.resolvedAt} is not null and ${t.resolvedAt} >= ${t.activatedAt})
      or (${t.status} = 'cancelled' and ${t.resolvedAt} is not null and (${t.activatedAt} is null or ${t.resolvedAt} >= ${t.activatedAt})))`)]);

export const approvalAssignments = pgTable('approval_assignments', {
  ...identity(), approvalStageId: uuid('approval_stage_id').notNull(), assignedUserId: uuid('assigned_user_id').notNull(), sourceRoleId: uuid('source_role_id').notNull(),
  status: text('status').notNull().default('pending'), assignedAt: time('assigned_at').notNull().defaultNow(), respondedAt: time('responded_at'),
}, (t) => [key(t), link(t, t.approvalStageId, approvalStages), actor(t, t.assignedUserId), link(t, t.sourceRoleId, roles),
  unique('approval_assignment_user_key').on(t.organizationId, t.approvalStageId, t.assignedUserId),
  index('approval_assignment_inbox_idx').on(t.organizationId, t.assignedUserId, t.status, t.assignedAt),
  check('approval_assignment_state', sql`(${t.status} in ('pending', 'cancelled') and ${t.respondedAt} is null)
    or (${t.status} in ('approved', 'rejected') and ${t.respondedAt} is not null and ${t.respondedAt} >= ${t.assignedAt})`)]);

export const approvalDecisions = pgTable('approval_decisions', {
  ...identity(), approvalAssignmentId: uuid('approval_assignment_id').notNull(), decision: text('decision').notNull(),
  decidedBy: uuid('decided_by').notNull(), comment: text('comment'), decidedAt: time('decided_at').notNull().defaultNow(),
}, (t) => [key(t), link(t, t.approvalAssignmentId, approvalAssignments), actor(t, t.decidedBy),
  unique('approval_decision_assignment_key').on(t.organizationId, t.approvalAssignmentId),
  check('approval_decision_details', sql`${t.decision} in ('approve', 'reject') and (${t.comment} is null or length(${t.comment}) <= 5000)`)]);

// Answers also survive transitions without an approval case; they belong to the
// actual transition-request history entry, never to a mutable current checklist.
export const workflowChecklistAnswers = pgTable('workflow_checklist_answers', {
  organizationId: tenant(), historyId: uuid('history_id').notNull(), transitionId: uuid('transition_id').notNull(), checklistItemId: uuid('checklist_item_id').notNull(), isChecked: boolean('is_checked').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.historyId, t.checklistItemId] }),
  foreignKey({ name: 'workflow_answer_history_fk', columns: [t.organizationId, t.historyId, t.transitionId], foreignColumns: [workflowRunHistory.organizationId, workflowRunHistory.id, workflowRunHistory.transitionId] }),
  foreignKey({ name: 'workflow_answer_checklist_fk', columns: [t.organizationId, t.transitionId, t.checklistItemId], foreignColumns: [workflowTransitionChecklistItems.organizationId, workflowTransitionChecklistItems.transitionId, workflowTransitionChecklistItems.id] })]);

export const approvalDecisionChecklistAnswers = pgTable('approval_decision_checklist_answers', {
  organizationId: tenant(), decisionId: uuid('decision_id').notNull(), transitionId: uuid('transition_id').notNull(), checklistItemId: uuid('checklist_item_id').notNull(), isChecked: boolean('is_checked').notNull(),
}, (t) => [primaryKey({ name: 'approval_decision_check_pk', columns: [t.organizationId, t.decisionId, t.checklistItemId] }),
  foreignKey({ name: 'approval_check_decision_fk', columns: [t.organizationId, t.decisionId], foreignColumns: [approvalDecisions.organizationId, approvalDecisions.id] }),
  foreignKey({ name: 'approval_check_item_fk', columns: [t.organizationId, t.transitionId, t.checklistItemId], foreignColumns: [workflowTransitionChecklistItems.organizationId, workflowTransitionChecklistItems.transitionId, workflowTransitionChecklistItems.id] })]);
