import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import { fieldsOnly, uuid, requirePermission } from '../templates/input.js';
import { insertBatch } from '../templates/authoring.js';
import { workflowRunHistory } from '../db/sample-schema.js';
import { approvalCases, approvalStages, approvalAssignments, approvalDecisions, workflowChecklistAnswers, approvalDecisionChecklistAnswers } from '../db/approval-schema.js';
import { workflowCommand, approvalDecisionInput } from './input.js';
import { workflowRunRecord, currentWorkflowRoles, canRequestTransition, workflowConditionSource } from './load.js';
import { loadWorkflowDefinition } from './definition.js';
import { workflowConditionsMatch } from './conditions.js';
import { generateTestRequests } from '../test-requests/generate.js';
import { submitDatasheet } from '../datasheets/submit.js';
import { datasheetRecord } from '../datasheets/service.js';

export function selectedWorkflowChecks(items, selectedIds, required = true) {
  const known = new Set(items.map((item) => item.id)); const selected = new Set(selectedIds);
  if (selectedIds.some((id) => !known.has(id))) throw new HttpError(422, 'invalid_workflow_checklist', 'A selected checklist item does not belong to this transition.');
  if (required && items.some((item) => item.isRequired && !selected.has(item.id))) throw new HttpError(422, 'workflow_checklist_required', 'Complete all required checklist items.');
  return items.map((item) => ({ checklistItemId: item.id, isChecked: selected.has(item.id) }));
}
function requireWorkflowWrite(identity) {
  if (!['samples.manage', 'datasheets.execute', 'approvals.respond'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot request workflow transitions.');
  }
}
async function lockRun(client, identity, runId) {
  uuid(runId, 'Workflow run'); requireWorkflowWrite(identity);
  try {
    if (!(await client.query('SELECT workflow_lock_run($1) AS found', [runId])).rows[0].found) throw new HttpError(404, 'workflow_run_not_found', 'Workflow was not found.');
  } catch (error) {
    if (error.code === '23514' && error.constraint === 'workflow_parent_job_controls') {
      throw new HttpError(409, 'job_workflow_controls', 'Continue this review from the parent job.');
    }
    throw error;
  }
  return workflowRunRecord(client, identity, runId);
}
async function transitionForRun(client, identity, run, transitionId) {
  const definition = await loadWorkflowDefinition(client, identity, run.workflow_version_id);
  const transition = definition.transitions.find((transition) => transition.id === transitionId && transition.sourceStateId === run.current_state_id);
  if (!transition) throw new HttpError(422, 'invalid_workflow_transition', 'This transition is unavailable from the current state.');
  return { transition, target: definition.states.find((state) => state.id === transition.targetStateId) };
}
async function requireTransitionReady(client, identity, run, transition, target) {
  const source = await workflowConditionSource(client, identity, run);
  if (!workflowConditionsMatch(source, transition.conditions)) throw new HttpError(409, 'workflow_conditions_not_met', 'The workflow transition conditions are not met.');
  if (run.test_request_id) {
    const request = (await client.query(`SELECT request.status, sheet.status AS sheet_status, submission.id AS submission_id,
      capture.status AS capture_status, capture.revision AS capture_revision, submission.capture_revision AS submitted_revision,
      EXISTS (SELECT 1 FROM test_request_assignments WHERE organization_id=request.organization_id AND test_request_id=request.id AND assignment_type='analyst' AND unassigned_at IS NULL) AS allocated
      FROM test_requests request LEFT JOIN datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.test_request_id=request.id AND sheet.id=request.final_datasheet_id
      LEFT JOIN datasheet_submissions submission ON submission.organization_id=sheet.organization_id AND submission.datasheet_id=sheet.id AND submission.id=sheet.latest_submission_id
      LEFT JOIN template_instances capture ON capture.organization_id=submission.organization_id AND capture.id=submission.instance_id
      WHERE request.organization_id=$1 AND request.id=$2`, [identity.organization_id, run.test_request_id])).rows[0];
    if (!request?.allocated || request.status === 'created') throw new HttpError(409, 'test_request_not_allocated', 'Allocate this test request before requesting a workflow transition.');
    if (!['under_review', 'approved'].includes(request.status) || !['under_review', 'approved'].includes(request.sheet_status)
      || !request.submission_id || request.capture_status !== 'frozen' || request.capture_revision !== request.submitted_revision) {
      throw new HttpError(409, 'final_result_required', 'Complete and submit the test request result before requesting a workflow transition.');
    }
    return request.submission_id;
  }
  if (!target.requireAllTestRequestsAllocated && !target.requireAllTestRequestsApproved) return;
  const counts = (await client.query(`SELECT count(*)::integer AS total,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM test_request_assignments assignment
      WHERE assignment.organization_id=request.organization_id AND assignment.test_request_id=request.id AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL))::integer AS allocated,
    count(*) FILTER (WHERE request.status='approved')::integer AS approved
    FROM test_requests request JOIN sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    JOIN sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    WHERE request.organization_id=$1 AND product.sample_id=$2 AND request.status<>'cancelled'`, [identity.organization_id, run.sample_id])).rows[0];
  if (target.requireAllTestRequestsAllocated && (!counts.total || counts.allocated !== counts.total)) throw new HttpError(409, 'test_requests_not_allocated', 'Allocate all test requests before requesting this transition.');
  if (target.requireAllTestRequestsApproved && (!counts.total || counts.approved !== counts.total)) throw new HttpError(409, 'test_requests_not_approved', 'Approve all test requests before requesting this transition.');
}
async function applyWorkflowTransition(client, identity, run, transition, target, comment) {
  const statement = run.sample_id ? 'SELECT * FROM workflow_apply_sample_transition($1,$2,$3,$4)' : 'SELECT * FROM workflow_apply_test_request_transition($1,$2,$3,$4)';
  const moved = (await client.query(statement, [run.id, transition.id, run.revision, comment])).rows[0];
  if (run.sample_id && target.generateTestRequests) await generateTestRequests(client, identity, run.sample_id, {}, { automatic: true, workflowRunId: run.id });
  return { id: run.id, revision: moved.revision, status: moved.status, stateId: target.id, historyId: moved.history_id };
}

export async function requestWorkflowTransition(client, identity, runId, rawInput) {
  requireWorkflowWrite(identity); const input = workflowCommand(rawInput); const run = await lockRun(client, identity, runId);
  if (run.status !== 'active') throw new HttpError(409, 'workflow_run_closed', 'Completed workflows cannot transition.');
  if (run.revision !== input.revision) throw new HttpError(409, 'stale_workflow_run', 'This workflow changed. Reload before sending the request.');
  if ((await client.query("SELECT id FROM approval_cases WHERE organization_id=$1 AND workflow_run_id=$2 AND status='pending'", [identity.organization_id, runId])).rowCount) {
    throw new HttpError(409, 'approval_already_pending', 'An approval request is already pending for this workflow.');
  }
  const { transition, target } = await transitionForRun(client, identity, run, input.transitionId);
  const roles = await currentWorkflowRoles(client, identity);
  if (!canRequestTransition(identity, transition, roles)) throw new HttpError(403, 'workflow_role_required', 'Your role cannot request this transition.');
  const submissionId = await requireTransitionReady(client, identity, run, transition, target);
  if (transition.requireComment && !input.comment) throw new HttpError(422, 'workflow_comment_required', 'Add a comment before sending this request.');
  const checks = selectedWorkflowChecks(transition.checklist, input.checklistItemIds);
  const db = database(client); const organizationId = identity.organization_id;
  if (transition.approvalMode === 'none') {
    const result = await applyWorkflowTransition(client, identity, run, transition, target, input.comment);
    await insertBatch(db, workflowChecklistAnswers, checks.map((check) => ({ ...check, organizationId, historyId: result.historyId, transitionId: transition.id })));
    return result;
  }
  const candidates = (await client.query('SELECT * FROM workflow_approver_candidates($1)', [transition.id])).rows;
  const stages = transition.approverStages.map((stage) => ({ ...stage, users: new Map() })); const byNumber = new Map(stages.map((stage) => [stage.stageNumber, stage]));
  for (const candidate of candidates) {
    const stage = byNumber.get(candidate.stage_number);
    if (!stage.users.has(candidate.user_id)) stage.users.set(candidate.user_id, candidate.role_id);
  }
  if (!stages.length || stages.some((stage) => !stage.users.size)) throw new HttpError(422, 'workflow_approvers_unavailable', 'Every approval stage requires active users in its configured roles.');
  const revision = (await client.query('SELECT workflow_reserve_request($1,$2,$3) AS revision', [run.id, transition.id, run.revision])).rows[0].revision;
  if (!revision) throw new HttpError(409, 'stale_workflow_run', 'This workflow changed. Reload before sending the request.');
  const [history] = await db.insert(workflowRunHistory).values({ organizationId, workflowRunId: run.id, workflowVersionId: run.workflow_version_id,
    transitionId: transition.id, datasheetSubmissionId: submissionId ?? null, fromStateId: run.current_state_id, toStateId: target.id, action: 'requested', actorUserId: identity.user_id, comment: input.comment }).returning();
  const [approval] = await db.insert(approvalCases).values({ organizationId, workflowRunId: run.id, workflowVersionId: run.workflow_version_id,
    transitionId: transition.id, requestHistoryId: history.id, runRevision: revision }).returning();
  const createdStages = await db.insert(approvalStages).values(stages.map((stage, index) => ({ organizationId, approvalCaseId: approval.id, stageNumber: stage.stageNumber,
    completionRule: transition.approvalMode === 'any' ? 'any' : 'all', status: index ? 'waiting' : 'pending', activatedAt: index ? null : new Date() }))).returning();
  await insertBatch(db, approvalAssignments, createdStages.flatMap((stage) => [...byNumber.get(stage.stageNumber).users].map(([assignedUserId, sourceRoleId]) => ({ organizationId, approvalStageId: stage.id, assignedUserId, sourceRoleId }))));
  await insertBatch(db, workflowChecklistAnswers, checks.map((check) => ({ ...check, organizationId, historyId: history.id, transitionId: transition.id })));
  return { id: run.id, revision, status: 'approval_pending', approvalCaseId: approval.id };
}

export async function approveWorkflowAssignment(client, identity, assignmentId, rawInput) {
  requirePermission(identity, 'approvals.respond'); uuid(assignmentId, 'Assignment'); fieldsOnly(rawInput, ['comment', 'checklistItemIds']);
  const input = approvalDecisionInput({ ...rawInput, decision: 'approve' });
  const initial = (await client.query(`SELECT approval.workflow_run_id FROM approval_assignments assignment JOIN approval_stages stage ON stage.organization_id=assignment.organization_id AND stage.id=assignment.approval_stage_id
    JOIN approval_cases approval ON approval.organization_id=stage.organization_id AND approval.id=stage.approval_case_id WHERE assignment.organization_id=$1 AND assignment.id=$2`, [identity.organization_id, assignmentId])).rows[0];
  if (!initial) throw new HttpError(404, 'approval_not_found', 'Approval assignment was not found.');
  const run = await lockRun(client, identity, initial.workflow_run_id);
  const locked = (await client.query(`SELECT assignment.assigned_user_id, assignment.status AS assignment_status, stage.id AS stage_id, stage.stage_number, stage.completion_rule,
    stage.status AS stage_status, approval.id AS case_id, approval.status AS case_status, approval.run_revision, approval.transition_id, history.datasheet_submission_id
    FROM approval_assignments assignment JOIN approval_stages stage ON stage.organization_id=assignment.organization_id AND stage.id=assignment.approval_stage_id
    JOIN approval_cases approval ON approval.organization_id=stage.organization_id AND approval.id=stage.approval_case_id
    JOIN workflow_run_history history ON history.organization_id=approval.organization_id AND history.id=approval.request_history_id
    WHERE assignment.organization_id=$1 AND assignment.id=$2 FOR UPDATE OF assignment,stage,approval`, [identity.organization_id, assignmentId])).rows[0];
  if (locked.assigned_user_id !== identity.user_id) throw new HttpError(403, 'approval_assignee_required', 'Only the assigned approver may respond.');
  if (locked.assignment_status !== 'pending' || locked.stage_status !== 'pending' || locked.case_status !== 'pending' || run.status !== 'active' || run.revision !== locked.run_revision) {
    throw new HttpError(409, 'approval_not_pending', 'This approval changed or is no longer waiting for your response.');
  }
  const { transition, target } = await transitionForRun(client, identity, run, locked.transition_id);
  const submissionId = await requireTransitionReady(client, identity, run, transition, target);
  if (run.test_request_id && submissionId !== locked.datasheet_submission_id) throw new HttpError(409, 'approval_result_changed', 'The submitted result differs from this approval request.');
  const checks = selectedWorkflowChecks(transition.checklist, input.checklistItemIds); const organizationId = identity.organization_id; const db = database(client);
  const [decision] = await db.insert(approvalDecisions).values({ organizationId, approvalAssignmentId: assignmentId, decision: 'approve', decidedBy: identity.user_id, comment: input.comment }).returning();
  await insertBatch(db, approvalDecisionChecklistAnswers, checks.map((check) => ({ ...check, organizationId, decisionId: decision.id, transitionId: transition.id })));
  await client.query("UPDATE approval_assignments SET status='approved', responded_at=now() WHERE organization_id=$1 AND id=$2", [organizationId, assignmentId]);
  const remaining = (await client.query("SELECT count(*)::integer AS count FROM approval_assignments WHERE organization_id=$1 AND approval_stage_id=$2 AND status='pending'", [organizationId, locked.stage_id])).rows[0].count;
  if (locked.completion_rule === 'all' && remaining) return { id: run.id, revision: run.revision, status: 'approval_pending', approvalCaseId: locked.case_id };
  if (locked.completion_rule === 'any') await client.query("UPDATE approval_assignments SET status='cancelled' WHERE organization_id=$1 AND approval_stage_id=$2 AND status='pending'", [organizationId, locked.stage_id]);
  await client.query("UPDATE approval_stages SET status='approved', resolved_at=now() WHERE organization_id=$1 AND id=$2", [organizationId, locked.stage_id]);
  const next = (await client.query("SELECT id FROM approval_stages WHERE organization_id=$1 AND approval_case_id=$2 AND status='waiting' ORDER BY stage_number LIMIT 1", [organizationId, locked.case_id])).rows[0];
  if (next) {
    await client.query("UPDATE approval_stages SET status='pending', activated_at=now() WHERE organization_id=$1 AND id=$2", [organizationId, next.id]);
    return { id: run.id, revision: run.revision, status: 'approval_pending', approvalCaseId: locked.case_id };
  }
  await client.query("UPDATE approval_cases SET status='approved', resolved_at=now() WHERE organization_id=$1 AND id=$2", [organizationId, locked.case_id]);
  return applyWorkflowTransition(client, identity, run, transition, target, input.comment);
}

export async function rejectWorkflowAssignment(client, identity, assignmentId, rawInput) {
  requirePermission(identity, 'approvals.respond'); uuid(assignmentId, 'Assignment'); fieldsOnly(rawInput, ['comment', 'checklistItemIds']);
  const input = approvalDecisionInput({ ...rawInput, decision: 'reject' });
  try {
    const result = (await client.query('SELECT * FROM workflow_reject_approval($1,$2,$3::uuid[])', [assignmentId, input.comment, input.checklistItemIds])).rows[0];
    return { id: result.workflow_run_id, revision: result.revision, status: 'rejected', stateId: result.state_id, historyId: result.history_id, approvalCaseId: result.approval_case_id };
  } catch (error) {
    if (error.constraint === 'workflow_response_session') throw new HttpError(403, 'forbidden', 'Your approval access changed. Sign in again before responding.');
    if (error.constraint === 'workflow_response_assignee') throw new HttpError(403, 'approval_assignee_required', 'Only the assigned approver may respond.');
    if (error.constraint === 'workflow_response_not_found') throw new HttpError(404, 'approval_not_found', 'Approval assignment was not found.');
    if (error.constraint === 'workflow_response_input') throw new HttpError(422, 'invalid_approval_response', 'Add a comment and select valid checklist items.');
    if (error.constraint === 'workflow_response_checklist') throw new HttpError(422, 'invalid_workflow_checklist', 'A selected checklist item does not belong to this transition.');
    if (error.constraint === 'workflow_response_result') throw new HttpError(409, 'approval_result_changed', 'The submitted result differs from this approval request.');
    if (['workflow_response_not_pending', 'workflow_response_conflict'].includes(error.constraint)) throw new HttpError(409, 'approval_not_pending', 'This approval changed or already has a different response.');
    if (error.constraint === 'workflow_parent_job_controls') throw new HttpError(409, 'job_workflow_controls', 'Continue this review from the parent job.');
    throw error;
  }
}

export async function submitDatasheetTransition(client, identity, runId, input) {
  requirePermission(identity, 'datasheets.execute'); uuid(runId, 'Workflow run');
  fieldsOnly(input, ['datasheetId', 'datasheet', 'transition']);
  const sheet = await datasheetRecord(client, identity, input.datasheetId);
  const initial = await workflowRunRecord(client, identity, runId);
  if (initial.test_request_id !== sheet.testRequestId) throw new HttpError(422, 'invalid_workflow_datasheet', 'The datasheet does not belong to this test request workflow.');
  // Lock the common owner before freezing the capture and reserving the run.
  // Failure of either operation rolls back both, including its audit evidence.
  await lockRun(client, identity, runId);
  const submission = await submitDatasheet(client, identity, input.datasheetId, input.datasheet);
  const workflow = await requestWorkflowTransition(client, identity, runId, input.transition);
  return { ...workflow, datasheetId: submission.id, submissionId: submission.submission.id };
}
