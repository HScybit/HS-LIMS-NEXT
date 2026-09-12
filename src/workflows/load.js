import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { loadWorkflowDefinition } from './definition.js';
import { workflowConditionsMatch } from './conditions.js';

export function requireWorkflowRead(identity) {
  if (!['samples.read', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'approvals.respond'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view this workflow.');
  }
}
export async function workflowRunRecord(client, identity, runId) {
  requireWorkflowRead(identity); uuid(runId, 'Workflow run');
  const result = await client.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND id=$2', [identity.organization_id, runId]);
  if (!result.rowCount) throw new HttpError(404, 'workflow_run_not_found', 'Workflow was not found.');
  return result.rows[0];
}
export async function workflowConditionSource(client, identity, run) {
  if (run.sample_id) {
    const sample = (await client.query(`SELECT sample.*, category.code AS sample_category_code, category.name AS sample_category_name,
      customer.code AS customer_code, customer.name AS customer_name FROM samples sample
      JOIN sample_categories category ON category.organization_id=sample.organization_id AND category.id=sample.sample_category_id
      LEFT JOIN customers customer ON customer.organization_id=sample.organization_id AND customer.id=sample.customer_id
      WHERE sample.organization_id=$1 AND sample.id=$2`, [identity.organization_id, run.sample_id])).rows[0];
    return { ...sample, sample };
  }
  const request = (await client.query(`SELECT request.*, sample.sample_number, sample.status AS sample_status, sheet.status AS datasheet_status,
    coalesce(submission.text_value, submission.number_value::text, submission.boolean_value::text) AS final_result
    FROM test_requests request JOIN sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    JOIN sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    JOIN samples sample ON sample.organization_id=product.organization_id AND sample.id=product.sample_id
    LEFT JOIN LATERAL (SELECT status, latest_submission_id FROM datasheets WHERE organization_id=request.organization_id AND test_request_id=request.id AND status<>'void'
      ORDER BY (id=request.final_datasheet_id) DESC NULLS LAST, attempt_number DESC LIMIT 1) sheet ON true
    LEFT JOIN datasheet_submissions submission ON submission.organization_id=request.organization_id AND submission.id=sheet.latest_submission_id
    WHERE request.organization_id=$1 AND request.id=$2`, [identity.organization_id, run.test_request_id])).rows[0];
  return { ...request, testRequest: request };
}
export async function currentWorkflowRoles(client, identity) {
  return new Set((await client.query('SELECT role_id FROM membership_roles WHERE organization_id=$1 AND user_id=$2', [identity.organization_id, identity.user_id])).rows.map((role) => role.role_id));
}
export function canRequestTransition(identity, transition, roles) {
  return ['samples.manage', 'datasheets.execute', 'approvals.respond'].some((permission) => identity.permission_codes?.includes(permission))
    && (!transition.creatorRoleIds.length || transition.creatorRoleIds.some((roleId) => roles.has(roleId)));
}
const daysTaken = (assigned, responded) => {
  if (!assigned || !responded) return '-';
  const days = Math.ceil(Math.max(0, new Date(responded).getTime() - new Date(assigned).getTime()) / 86400000);
  return days < 1 ? '<1 day' : `${days} ${days === 1 ? 'day' : 'days'}`;
};

export async function readApprovalCase(client, identity, { caseId = null, runId = null }) {
  requireWorkflowRead(identity);
  if (caseId) uuid(caseId, 'Approval request'); if (runId) uuid(runId, 'Workflow');
  const approval = (await client.query(`SELECT approval.id, approval.status, approval.resolved_at AS "resolvedAt", approval.request_history_id AS "requestHistoryId",
    history.actor_user_id AS "requestedById", history.occurred_at AS "requestedAt", history.comment AS comments, history.datasheet_submission_id AS "datasheetSubmissionId",
    transition.id AS "transitionId", transition.name AS "transitionName", transition.approval_mode AS "approvalMode",
    source.code AS "sourceStateCode", source.name AS "sourceStateName", source.state_type AS "sourceStateType", source.color AS "sourceColor",
    target.code AS "targetStateCode", target.name AS "targetStateName", target.state_type AS "targetStateType", target.color AS "targetColor",
    run.id AS "workflowRunId", run.sample_id AS "sampleId", run.test_request_id AS "testRequestId", coalesce(sample.sample_number, request.request_number) AS "referenceNumber"
    FROM approval_cases approval JOIN workflow_run_history history ON history.organization_id=approval.organization_id AND history.id=approval.request_history_id
    JOIN workflow_transitions transition ON transition.organization_id=approval.organization_id AND transition.id=approval.transition_id
    JOIN workflow_states source ON source.organization_id=transition.organization_id AND source.id=transition.source_state_id
    JOIN workflow_states target ON target.organization_id=transition.organization_id AND target.id=transition.target_state_id
    JOIN workflow_runs run ON run.organization_id=approval.organization_id AND run.id=approval.workflow_run_id
    LEFT JOIN samples sample ON sample.organization_id=run.organization_id AND sample.id=run.sample_id
    LEFT JOIN test_requests request ON request.organization_id=run.organization_id AND request.id=run.test_request_id
    WHERE approval.organization_id=$1 AND (($2::uuid IS NOT NULL AND approval.id=$2) OR ($3::uuid IS NOT NULL AND approval.workflow_run_id=$3))
    ORDER BY (approval.status='pending') DESC, history.occurred_at DESC, approval.id DESC LIMIT 1`, [identity.organization_id, caseId, runId])).rows[0];
  if (!approval) return null;
  const assignments = (await client.query(`SELECT assignment.id, assignment.assigned_user_id AS "assignedUserId", assignment.status, assignment.assigned_at AS "assignedAt",
    assignment.responded_at AS "respondedAt", stage.id AS "stageId", stage.stage_number AS "stageNumber", stage.status AS "stageStatus", stage.completion_rule AS "completionRule",
    decision.id AS "decisionId", decision.comment, decision.decided_by AS "decidedBy", decision.decided_at AS "decidedAt"
    FROM approval_stages stage JOIN approval_assignments assignment ON assignment.organization_id=stage.organization_id AND assignment.approval_stage_id=stage.id
    LEFT JOIN approval_decisions decision ON decision.organization_id=assignment.organization_id AND decision.approval_assignment_id=assignment.id
    WHERE stage.organization_id=$1 AND stage.approval_case_id=$2 ORDER BY stage.stage_number, assignment.assigned_at, assignment.id`, [identity.organization_id, approval.id])).rows;
  const checklist = (await client.query(`SELECT item.id, item.prompt AS label, item.is_required AS "isRequired", answer.is_checked AS "isChecked"
    FROM workflow_transition_checklist_items item LEFT JOIN workflow_checklist_answers answer
    ON answer.organization_id=item.organization_id AND answer.transition_id=item.transition_id AND answer.checklist_item_id=item.id AND answer.history_id=$3
    WHERE item.organization_id=$1 AND item.transition_id=$2 ORDER BY item.display_order,item.id`, [identity.organization_id, approval.transitionId, approval.requestHistoryId])).rows;
  const answers = (await client.query(`SELECT answer.decision_id, answer.checklist_item_id, answer.is_checked FROM approval_decision_checklist_answers answer
    JOIN approval_decisions decision ON decision.organization_id=answer.organization_id AND decision.id=answer.decision_id
    JOIN approval_assignments assignment ON assignment.organization_id=decision.organization_id AND assignment.id=decision.approval_assignment_id
    JOIN approval_stages stage ON stage.organization_id=assignment.organization_id AND stage.id=assignment.approval_stage_id
    WHERE answer.organization_id=$1 AND stage.approval_case_id=$2`, [identity.organization_id, approval.id])).rows;
  const decisionChecks = new Map();
  for (const answer of answers) {
    if (!decisionChecks.has(answer.decision_id)) decisionChecks.set(answer.decision_id, new Map());
    decisionChecks.get(answer.decision_id).set(answer.checklist_item_id, answer.is_checked);
  }
  const userIds = [...new Set([approval.requestedById, ...assignments.flatMap((assignment) => [assignment.assignedUserId, assignment.decidedBy].filter(Boolean))])];
  const labels = new Map((await client.query('SELECT * FROM laboratory_actor_labels($1::uuid[])', [userIds])).rows.map((user) => [user.user_id, user.display_name]));
  const active = assignments.find((assignment) => assignment.assignedUserId === identity.user_id && assignment.status === 'pending' && assignment.stageStatus === 'pending');
  return { ...approval, entityType: approval.sampleId ? 'sample' : 'test_request', requestedByName: labels.get(approval.requestedById) ?? approval.requestedById,
    checklistItems: checklist, approvalRows: assignments.map((assignment, index) => ({ ...assignment, sr: index + 1, approverName: labels.get(assignment.assignedUserId) ?? assignment.assignedUserId,
      checklistItems: assignment.decisionId ? checklist.map((item) => ({ id: item.id, label: item.label, isRequired: item.isRequired, isChecked: decisionChecks.get(assignment.decisionId)?.get(item.id) ?? null })) : [],
      status: assignment.stageStatus === 'waiting' ? 'waiting' : assignment.status, daysTaken: daysTaken(assignment.assignedAt, assignment.respondedAt), decisionOn: assignment.decidedAt })),
    approverProgress: `${assignments.filter((assignment) => ['approved', 'rejected'].includes(assignment.status)).length}/${assignments.length} responded`,
    assignmentId: active?.id ?? null, canRespond: approval.status === 'pending' && Boolean(active) && identity.permission_codes.includes('approvals.respond'),
    positiveActionLabel: approval.targetStateType === 'final' ? 'Approve' : 'Review' };
}

export async function loadWorkflowRun(client, identity, runId) {
  const run = await workflowRunRecord(client, identity, runId);
  const definition = await loadWorkflowDefinition(client, identity, run.workflow_version_id);
  const states = new Map(definition.states.map((state) => [state.id, state]));
  const source = await workflowConditionSource(client, identity, run); const roles = await currentWorkflowRoles(client, identity);
  const approvalRequest = await readApprovalCase(client, identity, { runId });
  const history = (await client.query(`SELECT history.id, history.action, history.actor_user_id AS "actorUserId", history.comment, history.occurred_at AS "occurredAt",
    target.name AS "toStateName", source.name AS "fromStateName", history.transition_id AS "transitionId"
    FROM workflow_run_history history JOIN workflow_states target ON target.organization_id=history.organization_id AND target.id=history.to_state_id
    LEFT JOIN workflow_states source ON source.organization_id=history.organization_id AND source.id=history.from_state_id
    WHERE history.organization_id=$1 AND history.workflow_run_id=$2 ORDER BY history.occurred_at DESC, history.id DESC LIMIT 100`, [identity.organization_id, runId])).rows;
  const labels = new Map((await client.query('SELECT * FROM laboratory_actor_labels($1::uuid[])', [[...new Set(history.map((event) => event.actorUserId))]])).rows.map((user) => [user.user_id, user.display_name]));
  return { id: run.id, versionId: run.workflow_version_id, sampleId: run.sample_id, testRequestId: run.test_request_id, revision: run.revision, status: run.status,
    state: states.get(run.current_state_id), startedAt: run.started_at, completedAt: run.completed_at,
    transitions: run.status !== 'active' || approvalRequest?.status === 'pending' ? [] : definition.transitions
      .filter((transition) => transition.sourceStateId === run.current_state_id && canRequestTransition(identity, transition, roles) && workflowConditionsMatch(source, transition.conditions))
      .map((transition) => ({ id: transition.id, name: transition.name, targetStateId: transition.targetStateId,
        targetStateName: states.get(transition.targetStateId)?.name, approvalMode: transition.approvalMode, requireComment: transition.requireComment,
        checklistItems: transition.checklist.map((item) => ({ id: item.id, label: item.prompt, isRequired: item.isRequired })) })),
    approvalRequest, activity: history.map((event) => ({ ...event, actorName: labels.get(event.actorUserId) ?? event.actorUserId })) };
}
