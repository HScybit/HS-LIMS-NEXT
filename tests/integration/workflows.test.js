import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool, database } from '../../src/db/pool.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, deleteWorkflowElement, publishWorkflow, cloneWorkflowDraft } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { registerSample } from '../../src/samples/register.js';
import { workflowRunHistory } from '../../src/db/sample-schema.js';
import { approvalCases, approvalStages, approvalAssignments, approvalDecisions, workflowChecklistAnswers, approvalDecisionChecklistAnswers } from '../../src/db/approval-schema.js';
import { loadWorkflowRun, readApprovalCase } from '../../src/workflows/load.js';
import { requestWorkflowTransition, approveWorkflowAssignment } from '../../src/workflows/requests.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';

const owner = ownerPool(); let manager; let first; let second; let reader; let foreign;
const work = (user, action, readOnly = false) => withSession(user.token, action, { csrfToken: user.csrfToken, readOnly });
const sqlError = (code) => (error) => (error.cause ?? error).code === code;
before(async () => {
  async function account(options) { const record = await createAccount(owner, options); return { ...record, ...await signIn({ identifier: record.username, password: record.password }) }; }
  manager = await account({ permissions: ['workflows.manage', 'samples.create', 'samples.manage', 'samples.read'] });
  first = await account({ organizationId: manager.organizationId, permissions: ['approvals.respond'] });
  second = await account({ organizationId: manager.organizationId, permissions: ['approvals.respond'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['samples.read'] });
  foreign = await account({ permissions: ['workflows.manage', 'approvals.respond'] });
});
after(async () => { await closePool(); await owner.end(); });

async function definition({ mode = 'none', stages, publish = true, targetFlags = {} } = {}) {
  const workflow = await work(manager, (client, identity) => createWorkflow(client, identity, { code: randomUUID(), name: 'Synthetic approval workflow', appliesTo: 'sample' }));
  const initial = await work(manager, (client, identity) => saveWorkflowState(client, identity, workflow.versionId, 1,
    { code: 'initial', name: 'In Progress', stateType: 'initial', showSampleEdit: true, allocateRoleIds: [manager.roleId] }));
  const final = await work(manager, (client, identity) => saveWorkflowState(client, identity, workflow.versionId, initial.revision,
    { code: 'complete', name: 'Completed', stateType: 'final', isPositiveTermination: true, ...targetFlags }));
  const transition = await work(manager, (client, identity) => saveWorkflowTransition(client, identity, workflow.versionId, final.revision,
    { code: 'complete', name: 'Complete', sourceStateId: initial.id, targetStateId: final.id, approvalMode: mode, creatorRoleIds: [manager.roleId],
      ccRoleIds: [manager.roleId], ccEmails: ['Audit@example.invalid'], requireComment: true,
      approverStages: stages ?? (mode === 'none' ? [] : [{ stageNumber: 1, roleIds: [first.roleId, second.roleId] }]),
      checklist: [{ prompt: 'Confirm the sample identification', isRequired: true }, { prompt: 'Optional note', isRequired: false }],
      conditions: [{ sourceField: 'sample.sampleType', operator: 'eq', comparisonValue: 'internal' }] }));
  const publication = publish ? await work(manager, (client, identity) => publishWorkflow(client, identity, workflow.versionId, transition.revision, 'Synthetic approval validation')) : null;
  return { ...workflow, initial, final, transition, revision: publication?.revision ?? transition.revision };
}

test('workflow authoring loads in eight actual queries, freezes details and clones complete independent definitions', async () => {
  const fixture = await definition({ mode: 'sequential', stages: [{ stageNumber: 1, roleIds: [first.roleId] }, { stageNumber: 3, roleIds: [second.roleId] }] });
  const source = await work(reader, async (client, identity) => {
    let count = 0;
    const observed = { query(...args) { count += 1; return client.query(...args); } };
    const value = await loadWorkflowDefinition(observed, identity, fixture.versionId);
    assert.equal(count, 8); assert.equal(value.metrics.queryCount, 8); return value;
  }, true);
  assert.equal(source.states.length, 2); assert.equal(source.transitions[0].checklist.length, 2);
  assert.equal(source.transitions[0].checklist[1].isRequired, false); assert.deepEqual(source.transitions[0].ccEmails, ['audit@example.invalid']);
  assert.deepEqual(source.transitions[0].approverStages.map((stage) => stage.stageNumber), [1, 3]);
  await assert.rejects(work(manager, (client, identity) => saveWorkflowState(client, identity, fixture.versionId, fixture.revision, { code: 'illegal', name: 'Illegal' })), { code: 'stale_workflow_definition' });
  await assert.rejects(work(manager, (client) => client.query('DELETE FROM workflow_transition_checklist_items WHERE organization_id=$1 AND transition_id=$2', [manager.organizationId, fixture.transition.id])), sqlError('55000'));
  await assert.rejects(work(foreign, (client, identity) => loadWorkflowDefinition(client, identity, fixture.versionId), true), { status: 404 });
  const cloned = await work(manager, (client, identity) => cloneWorkflowDraft(client, identity, fixture.versionId));
  const draft = await work(manager, (client, identity) => loadWorkflowDefinition(client, identity, cloned.versionId), true);
  assert.equal(draft.version.status, 'draft'); assert.equal(draft.version.number, 2);
  assert.equal(draft.transitions[0].conditions[0].comparisonText, 'internal');
  assert.equal(draft.states.length, source.states.length); assert.deepEqual(draft.transitions[0].approverStages, source.transitions[0].approverStages);
  assert.notEqual(draft.states[0].id, source.states[0].id); assert.notEqual(draft.transitions[0].checklist[0].id, source.transitions[0].checklist[0].id);
  assert.ok(draft.states.some((state) => state.id === draft.transitions[0].sourceStateId));
  await assert.rejects(work(manager, (client, identity) => cloneWorkflowDraft(client, identity, fixture.versionId)), { code: 'workflow_draft_exists' });
  await work(manager, (client, identity) => publishWorkflow(client, identity, cloned.versionId, 1, 'Second synthetic publication'));
  assert.equal((await work(reader, (client, identity) => loadWorkflowDefinition(client, identity, fixture.versionId), true)).version.status, 'retired');
});

test('workflow edits serialize stale revisions and reject missing, foreign and disconnected references without partial writes', async () => {
  const fixture = await definition({ publish: false });
  const edits = await Promise.allSettled(['first', 'second'].map((code) => work(manager, (client, identity) => saveWorkflowState(client, identity, fixture.versionId, fixture.revision, { code, name: code }))));
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(edits.find((result) => result.status === 'rejected').reason.code, 'stale_workflow_definition');
  const current = await work(manager, (client, identity) => loadWorkflowDefinition(client, identity, fixture.versionId), true);
  await assert.rejects(work(manager, (client, identity) => saveWorkflowState(client, identity, fixture.versionId, current.version.revision, { code: 'bad', name: 'Bad role', accessRoleIds: [foreign.roleId] })), { code: 'invalid_workflow_role' });
  await assert.rejects(work(reader, (client, identity) => saveWorkflowState(client, identity, fixture.versionId, current.version.revision, { code: 'bad', name: 'Bad permission' })), { status: 403 });
  await assert.rejects(work(manager, (client, identity) => publishWorkflow(client, identity, fixture.versionId, current.version.revision, 'Disconnected state')), { code: 'workflow_validation_failed' });
  assert.equal((await work(reader, (client, identity) => loadWorkflowDefinition(client, identity, fixture.versionId), true)).version.revision, current.version.revision);
  const orphan = current.states.find((state) => ['first', 'second'].includes(state.code));
  const deleted = await work(manager, (client, identity) => deleteWorkflowElement(client, identity, fixture.versionId, current.version.revision, { type: 'state', id: orphan.id }));
  await work(manager, (client, identity) => publishWorkflow(client, identity, fixture.versionId, deleted.revision, 'Connected workflow'));
});

test('deleting a draft state removes its connections and associated definition rows as in the source designer', async () => {
  const fixture = await definition({ publish: false, mode: 'all' });
  const result = await work(manager, (client, identity) => deleteWorkflowElement(client, identity, fixture.versionId, fixture.revision, { type: 'state', id: fixture.initial.id }));
  const draft = await work(manager, (client, identity) => loadWorkflowDefinition(client, identity, fixture.versionId), true);
  assert.equal(draft.states.length, 1); assert.equal(draft.states[0].id, fixture.final.id); assert.deepEqual(draft.transitions, []);
  assert.equal((await owner.query('SELECT id FROM workflow_transition_checklist_items WHERE organization_id=$1 AND transition_id=$2', [manager.organizationId, fixture.transition.id])).rowCount, 0);
  assert.equal((await owner.query('SELECT role_id FROM workflow_transition_approver_roles WHERE organization_id=$1 AND transition_id=$2', [manager.organizationId, fixture.transition.id])).rowCount, 0);
  await assert.rejects(work(manager, (client, identity) => publishWorkflow(client, identity, fixture.versionId, result.revision, 'Missing initial state')), { code: 'workflow_validation_failed' });
});

async function registeredWorkflow(options) {
  const fixture = await definition(options);
  const laboratory = await createLaboratoryFixture(owner, manager, { workflow: false });
  await owner.query("INSERT INTO sample_category_workflows(organization_id,sample_category_id,workflow_id,applies_to,is_default) VALUES($1,$2,$3,'sample',true)", [manager.organizationId, laboratory.category.id, fixture.workflowId]);
  const sample = await work(manager, (client, identity) => registerSample(client, identity, laboratory.registration));
  return { ...fixture, sample, laboratory };
}
async function pendingRequest({ omitRecipient = false, omitStage = false } = {}) {
  const fixture = await registeredWorkflow({ mode: 'sequential', stages: [{ stageNumber: 1, roleIds: [first.roleId, second.roleId] }, { stageNumber: 2, roleIds: [second.roleId] }] });
  const { sample } = fixture;
  const pending = await work(manager, async (client, identity) => {
    const run = (await client.query('UPDATE workflow_runs SET revision=revision+1 WHERE organization_id=$1 AND sample_id=$2 RETURNING *', [identity.organization_id, sample.id])).rows[0];
    const db = database(client); const org = identity.organization_id;
    const [history] = await db.insert(workflowRunHistory).values({ organizationId: org, workflowRunId: run.id, workflowVersionId: fixture.versionId,
      fromStateId: fixture.initial.id, toStateId: fixture.final.id, transitionId: fixture.transition.id, action: 'requested', actorUserId: identity.user_id, comment: 'Synthetic checked request' }).returning();
    const [approval] = await db.insert(approvalCases).values({ organizationId: org, workflowRunId: run.id, workflowVersionId: fixture.versionId, transitionId: fixture.transition.id, requestHistoryId: history.id, runRevision: run.revision }).returning();
    const [stage] = await db.insert(approvalStages).values({ organizationId: org, approvalCaseId: approval.id, stageNumber: 1, completionRule: 'all', status: 'pending', activatedAt: new Date() }).returning();
    const assignments = await db.insert(approvalAssignments).values((omitRecipient ? [first] : [first, second]).map((user) => ({ organizationId: org, approvalStageId: stage.id, assignedUserId: user.userId, sourceRoleId: user.roleId }))).returning();
    let future;
    if (!omitStage) {
      const [next] = await db.insert(approvalStages).values({ organizationId: org, approvalCaseId: approval.id, stageNumber: 2, completionRule: 'all' }).returning();
      [future] = await db.insert(approvalAssignments).values({ organizationId: org, approvalStageId: next.id, assignedUserId: second.userId, sourceRoleId: second.roleId }).returning();
    }
    const model = await loadWorkflowDefinition(client, identity, fixture.versionId);
    const checklistItemId = model.transitions[0].checklist[0].id;
    await db.insert(workflowChecklistAnswers).values({ organizationId: org, historyId: history.id, transitionId: fixture.transition.id, checklistItemId, isChecked: true });
    return { run, approval, stage, assignments, future, history, checklistItemId };
  });
  return { ...fixture, ...pending };
}

test('approval requests cannot omit a configured stage or active recipient, even through direct SQL', async () => {
  await assert.rejects(pendingRequest({ omitRecipient: true }), sqlError('23514'));
  await assert.rejects(pendingRequest({ omitStage: true }), sqlError('23514'));
});

test('approval evidence enforces actor, assignment, stage order, actual quorum and immutable responses', async () => {
  const fixture = await pendingRequest(); const org = manager.organizationId;
  const decision = (user, assignment, { actor = user.userId, skipChecks = false, finishCase = false } = {}) => work(user, async (client) => {
    const [record] = await database(client).insert(approvalDecisions).values({ organizationId: org, approvalAssignmentId: assignment.id, decision: 'approve', decidedBy: actor, comment: 'Synthetic review completed' }).returning();
    if (!skipChecks) await database(client).insert(approvalDecisionChecklistAnswers).values({ organizationId: org, decisionId: record.id, transitionId: fixture.transition.id, checklistItemId: fixture.checklistItemId, isChecked: true });
    await client.query("UPDATE approval_assignments SET status='approved', responded_at=now() WHERE organization_id=$1 AND id=$2", [org, assignment.id]);
    if (finishCase) {
      await client.query("UPDATE approval_stages SET status='approved', resolved_at=now() WHERE organization_id=$1 AND id=$2", [org, fixture.future.approvalStageId]);
      await client.query("UPDATE approval_cases SET status='approved', resolved_at=now() WHERE organization_id=$1 AND id=$2", [org, fixture.approval.id]);
      await client.query('SELECT * FROM workflow_apply_sample_transition($1,$2,$3,$4)', [fixture.run.id, fixture.transition.id, fixture.run.revision, record.comment]);
    }
    return record;
  });
  const firstAssignment = fixture.assignments.find((assignment) => assignment.assignedUserId === first.userId);
  const secondAssignment = fixture.assignments.find((assignment) => assignment.assignedUserId === second.userId);
  const pending = await work(first, (client, identity) => readApprovalCase(client, identity, { caseId: fixture.approval.id }), true);
  assert.equal(pending.canRespond, true); assert.equal(pending.approvalRows.length, 3); assert.equal(pending.checklistItems[0].isChecked, true);
  assert.equal((await work(reader, (client, identity) => readApprovalCase(client, identity, { caseId: fixture.approval.id }), true)).canRespond, false);
  assert.deepEqual((await work(manager, (client, identity) => loadWorkflowRun(client, identity, fixture.run.id), true)).transitions, []);
  await assert.rejects(decision(first, secondAssignment, { actor: second.userId }), sqlError('42501'));
  await assert.rejects(decision(first, secondAssignment), sqlError('42501'));
  await assert.rejects(decision(second, fixture.future), sqlError('42501'));
  await assert.rejects(work(manager, (client) => client.query("UPDATE approval_assignments SET status='approved', responded_at=now() WHERE organization_id=$1 AND id=$2", [org, firstAssignment.id])), sqlError('23514'));
  await assert.rejects(decision(first, firstAssignment, { skipChecks: true }), sqlError('23514'));
  const firstDecision = await decision(first, firstAssignment);
  assert.equal(firstDecision.decidedBy, first.userId); assert.ok(firstDecision.decidedAt);
  await assert.rejects(work(first, (client) => client.query("UPDATE approval_stages SET status='approved', resolved_at=now() WHERE organization_id=$1 AND id=$2", [org, fixture.stage.id])), sqlError('23514'));
  await assert.rejects(decision(first, firstAssignment), sqlError('42501'));
  await decision(second, secondAssignment);
  await work(second, async (client) => {
    await client.query("UPDATE approval_stages SET status='approved', resolved_at=now() WHERE organization_id=$1 AND id=$2", [org, fixture.stage.id]);
    await client.query("UPDATE approval_stages SET status='pending', activated_at=now() WHERE organization_id=$1 AND id=$2", [org, fixture.future.approvalStageId]);
  });
  await decision(second, fixture.future, { finishCase: true });
  const completed = await work(reader, (client, identity) => loadWorkflowRun(client, identity, fixture.run.id), true);
  assert.equal(completed.status, 'completed'); assert.equal(completed.revision, fixture.run.revision + 1);
  assert.equal(completed.approvalRequest.status, 'approved'); assert.equal(completed.approvalRequest.canRespond, false);
  await assert.rejects(work(second, (client) => client.query("UPDATE approval_cases SET status='pending', resolved_at=null WHERE organization_id=$1 AND id=$2", [org, fixture.approval.id])), sqlError('55000'));
  await assert.rejects(owner.query("UPDATE approval_decisions SET comment='Rewritten evidence' WHERE organization_id=$1 AND id=$2", [org, firstDecision.id]), sqlError('55000'));
  await assert.rejects(work(manager, (client) => database(client).insert(workflowChecklistAnswers).values({ organizationId: org, historyId: fixture.history.id,
    transitionId: fixture.transition.id, checklistItemId: fixture.checklistItemId, isChecked: false })), sqlError('23514'));
  const hidden = await work(foreign, (client) => client.query('SELECT id FROM approval_cases WHERE id=$1', [fixture.approval.id]), true);
  assert.equal(hidden.rowCount, 0);
});

const readRun = (fixture, user = manager) => work(user, (client, identity) => loadWorkflowRun(client, identity, fixture.sample.workflowRunId), true);
const command = (fixture, input, user = manager) => work(user, (client, identity) => requestWorkflowTransition(client, identity, fixture.sample.workflowRunId, input));
async function commandInput(fixture) {
  const run = await readRun(fixture);
  return { revision: run.revision, transitionId: fixture.transition.id, comment: 'Synthetic request confirmed',
    checklistItemIds: run.transitions[0].checklistItems.filter((item) => item.isRequired).map((item) => item.id) };
}
async function approve(fixture, user, observedClient) {
  const run = await readRun(fixture, user); const approval = run.approvalRequest;
  return work(user, (client, identity) => approveWorkflowAssignment(observedClient?.(client) ?? client, identity, approval.assignmentId,
    { comment: 'Synthetic approval confirmed', checklistItemIds: approval.checklistItems.filter((item) => item.isRequired).map((item) => item.id) }));
}

test('sample transition commands enforce source conditions, required comments/checks, creator role and atomic direct completion', async () => {
  const fixture = await registeredWorkflow(); const input = await commandInput(fixture);
  await assert.rejects(command(fixture, { ...input, comment: '' }), { code: 'workflow_comment_required' });
  await assert.rejects(command(fixture, { ...input, checklistItemIds: [] }), { code: 'workflow_checklist_required' });
  await assert.rejects(command(fixture, { ...input, checklistItemIds: [randomUUID()] }), { code: 'invalid_workflow_checklist' });
  await assert.rejects(command(fixture, input, reader), { status: 403 });
  await assert.rejects(command(fixture, input, first), { code: 'workflow_role_required' });
  await assert.rejects(command(fixture, input, foreign), { status: 404 });
  await assert.rejects(work(manager, (client) => client.query('SELECT * FROM workflow_apply_sample_transition($1,$2,$3,$4)', [fixture.sample.workflowRunId, fixture.transition.id, 1, input.comment])), sqlError('23514'));
  assert.equal((await readRun(fixture)).revision, 1);
  const result = await command(fixture, input); assert.equal(result.status, 'completed'); assert.equal(result.revision, 2);
  assert.equal((await readRun(fixture)).activity[0].actorUserId, manager.userId);
  await assert.rejects(command(fixture, input), { code: 'workflow_run_closed' });
  const gated = await registeredWorkflow({ targetFlags: { requireAllTestRequestsAllocated: true } });
  await assert.rejects(command(gated, await commandInput(gated)), { code: 'test_requests_not_allocated' });
  assert.equal((await readRun(gated)).revision, 1);
});

test('concurrent requests create one case, and any-approver completion cancels only the remaining assignments', async () => {
  const fixture = await registeredWorkflow({ mode: 'any' }); const input = await commandInput(fixture);
  const outcomes = await Promise.allSettled([command(fixture, input), command(fixture, input)]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1); assert.equal(outcomes.find((result) => result.status === 'rejected').reason.code, 'stale_workflow_run');
  const pending = await readRun(fixture); assert.equal(pending.approvalRequest.approvalRows.length, 2);
  await assert.rejects(command(fixture, { ...input, revision: pending.revision }), { code: 'approval_already_pending' });
  const completed = await approve(fixture, first); assert.equal(completed.status, 'completed');
  const result = await readRun(fixture, second);
  assert.equal(result.approvalRequest.canRespond, false);
  assert.deepEqual(result.approvalRequest.approvalRows.map((row) => row.status).sort(), ['approved', 'cancelled']);
  const cancelled = result.approvalRequest.approvalRows.find((row) => row.status === 'cancelled');
  await assert.rejects(owner.query('DELETE FROM approval_assignments WHERE organization_id=$1 AND id=$2', [manager.organizationId, cancelled.id]), sqlError('55000'));
});

test('sequential command approvals activate the next stage and reject changed conditions without losing the pending response', async () => {
  const fixture = await registeredWorkflow({ mode: 'sequential', stages: [{ stageNumber: 1, roleIds: [first.roleId] }, { stageNumber: 2, roleIds: [second.roleId] }] });
  await command(fixture, await commandInput(fixture));
  assert.equal((await readRun(fixture, second)).approvalRequest.canRespond, false);
  const firstResult = await approve(fixture, first); assert.equal(firstResult.status, 'approval_pending');
  await owner.query("UPDATE samples SET sample_type='proficiency', revision=revision+1 WHERE organization_id=$1 AND id=$2", [manager.organizationId, fixture.sample.id]);
  await assert.rejects(approve(fixture, second), { code: 'workflow_conditions_not_met' });
  assert.equal((await readRun(fixture, second)).approvalRequest.canRespond, true);
  await owner.query("UPDATE samples SET sample_type='internal', revision=revision+1 WHERE organization_id=$1 AND id=$2", [manager.organizationId, fixture.sample.id]);
  assert.equal((await approve(fixture, second)).status, 'completed');
});

test('automatic test generation uses the actual approving actor and rolls the whole final approval back on a failed write', async () => {
  const fixture = await registeredWorkflow({ mode: 'all', targetFlags: { generateTestRequests: true } });
  await assert.rejects(work(second, (client, identity) => generateTestRequests(client, identity, fixture.sample.id, {}, { automatic: true, workflowRunId: fixture.sample.workflowRunId })), { code: 'workflow_generation_required' });
  await command(fixture, await commandInput(fixture));
  assert.equal((await approve(fixture, first)).status, 'approval_pending');
  const failRequestInsert = (client) => ({ query(...args) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (/insert into "test_requests"/i.test(sql)) throw new Error('Synthetic request write failed');
    return client.query(...args);
  } });
  await assert.rejects(approve(fixture, second, failRequestInsert), (error) => /Synthetic request write failed/.test((error.cause ?? error).message));
  const pending = await readRun(fixture, second); assert.equal(pending.status, 'active'); assert.equal(pending.approvalRequest.canRespond, true);
  assert.equal(pending.approvalRequest.approvalRows.filter((row) => row.status === 'approved').length, 1);
  assert.equal((await approve(fixture, second)).status, 'completed');
  const generated = (await owner.query(`SELECT request.created_by FROM test_requests request JOIN sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    JOIN sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id WHERE request.organization_id=$1 AND product.sample_id=$2`, [manager.organizationId, fixture.sample.id])).rows;
  assert.equal(generated.length, 1); assert.equal(generated[0].created_by, second.userId);
  await assert.rejects(work(second, (client, identity) => generateTestRequests(client, identity, fixture.sample.id, {}, { automatic: true, workflowRunId: fixture.sample.workflowRunId })), { code: 'workflow_generation_required' });
});

test('a generating approval can initialize automatic job children without granting its responder allocation permission', async () => {
  const fixture = await registeredWorkflow({ mode: 'all', targetFlags: { generateTestRequests: true } });
  await owner.query(`INSERT INTO organization_laboratory_settings(organization_id,auto_create_jobs,result_summary_template_id,updated_by)
    VALUES($1,true,$2,$3)`, [manager.organizationId, fixture.laboratory.template.templateId, manager.userId]);
  await command(fixture, await commandInput(fixture));
  assert.equal((await approve(fixture, first)).status, 'approval_pending');
  const failChildCapture = (client) => ({ query(...args) {
    const statement = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (/insert into "datasheets"/i.test(statement)) throw new Error('Synthetic automatic approval capture interruption');
    return client.query(...args);
  } });
  await assert.rejects(approve(fixture, second, failChildCapture), (error) => /Synthetic automatic approval capture interruption/.test((error.cause ?? error).message));
  const pending = await readRun(fixture, second);
  assert.equal(pending.status, 'active'); assert.equal(pending.approvalRequest.canRespond, true);
  assert.equal(pending.approvalRequest.approvalRows.filter((row) => row.status === 'approved').length, 1);
  assert.equal((await owner.query(`SELECT request.id FROM test_requests request JOIN laboratory_test_request_context context
    ON context.organization_id=request.organization_id AND context.test_request_id=request.id WHERE request.organization_id=$1 AND context.sample_id=$2`, [manager.organizationId, fixture.sample.id])).rowCount, 0);
  assert.equal((await approve(fixture, second)).status, 'completed');
  const rows = (await owner.query(`SELECT request.id,request.is_job,request.is_auto_created,request.status,request.created_by,
    assignment.assigned_user_id,sheet.id AS datasheet_id,capture.created_by AS capture_creator
    FROM test_requests request JOIN laboratory_test_request_context context ON context.organization_id=request.organization_id AND context.test_request_id=request.id
    LEFT JOIN test_request_assignments assignment ON assignment.organization_id=request.organization_id AND assignment.test_request_id=request.id AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL
    LEFT JOIN datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.test_request_id=request.id
    LEFT JOIN template_instances capture ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id
    WHERE request.organization_id=$1 AND context.sample_id=$2`, [manager.organizationId, fixture.sample.id])).rows;
  assert.equal(rows.length, 2);
  const child = rows.find((row) => !row.is_job); const job = rows.find((row) => row.is_job);
  assert.equal(child.status, 'allocated'); assert.equal(child.assigned_user_id, second.userId); assert.equal(child.capture_creator, second.userId); assert.ok(child.datasheet_id);
  assert.equal(job.status, 'created'); assert.equal(job.is_auto_created, true); assert.equal(job.created_by, second.userId); assert.equal(job.assigned_user_id, null); assert.equal(job.datasheet_id, null);
  await assert.rejects(work(second, (client) => client.query('SELECT * FROM laboratory_start_auto_job($1::uuid[])', [[child.id]])), sqlError('42501'));
});
