import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareSampleRejection, workflowWork as work } from '../helpers/workflow-rejections.js';
import { signIn } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { approveWorkflowAssignment, rejectWorkflowAssignment, requestWorkflowTransition } from '../../src/workflows/requests.js';
import { readApprovalCase } from '../../src/workflows/load.js';

const owner = ownerPool(); let manager; let first; let second; let reader; let foreign;
const input = { comment: 'Synthetic result needs correction', checklistItemIds: [] };
const assignment = (flow, user, stage = 1) => flow.assignments.find((row) => row.assigned_user_id === user.userId && row.stage_number === stage).id;
const reject = (flow, user = first, value = input, stage = 1) => work(user, (client, identity) => rejectWorkflowAssignment(client, identity, assignment(flow, user, stage), value));
const prepare = (options) => prepareSampleRejection(owner, manager, [first, second], options);
const approve = (flow, user, stage = 1) => work(user, (client, identity) => approveWorkflowAssignment(client, identity, assignment(flow, user, stage), {
  comment: 'Synthetic approved review', checklistItemIds: flow.workflow.transition.checklist.filter((item) => item.isRequired).map((item) => item.id),
}));
const read = (flow, user = first) => work(user, (client, identity) => readApprovalCase(client, identity, { caseId: flow.request.approvalCaseId }), true);
before(async () => {
  manager = await createAccount(owner, { permissions: ['workflows.manage', 'samples.create', 'samples.manage'] });
  first = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['approvals.respond'] });
  second = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['approvals.respond'] });
  reader = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['samples.read'] });
  foreign = await createAccount(owner, { permissions: ['approvals.respond'] });
  for (const user of [manager, first, second, reader, foreign]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

for (const mode of ['any', 'all', 'sequential']) test(`${mode} closes on its first rejection, retains actual unchecked answers and cancels without fabricated responses`, async () => {
  const flow = await prepare({ mode, ...(mode === 'sequential' ? { stages: [{ stageNumber: 1, roleIds: [first.roleId, second.roleId] }, { stageNumber: 3, roleIds: [second.roleId] }] } : {}) });
  const result = await reject(flow);
  assert.equal(result.revision, flow.request.revision + 1); assert.equal(result.status, 'rejected'); assert.equal(result.stateId, flow.workflow.initial.id);
  const shown = await read(flow); assert.equal(shown.status, 'rejected'); assert.equal(shown.canRespond, false); assert.equal(shown.assignmentId, null);
  const rejected = shown.approvalRows.find((row) => row.status === 'rejected'); assert.equal(rejected.decidedBy, first.userId); assert.equal(rejected.comment, input.comment);
  assert.ok(rejected.checklistItems.every((item) => item.isChecked === false));
  assert.ok(shown.approvalRows.filter((row) => row.status !== 'rejected').every((row) => row.status === 'cancelled' && row.respondedAt === null && row.decisionOn === null && row.decidedBy === null));
  const history = (await owner.query('SELECT * FROM workflow_run_history WHERE organization_id=$1 AND id=$2', [manager.organizationId, result.historyId])).rows[0];
  assert.equal(history.action, 'rejected'); assert.equal(history.from_state_id, history.to_state_id); assert.equal(history.actor_user_id, first.userId);
  assert.equal((await owner.query('SELECT status FROM samples WHERE organization_id=$1 AND id=$2', [manager.organizationId, flow.sample.id])).rows[0].status, 'rejected');
  assert.equal((await owner.query('SELECT status FROM workflow_runs WHERE organization_id=$1 AND id=$2', [manager.organizationId, flow.run.id])).rows[0].status, 'active');
  await assert.rejects(approve(flow, second), { code: 'approval_not_pending' });
  await assert.rejects(reject(flow, second), { code: 'approval_not_pending' });
});

test('earlier approvals remain intact when a later sequential stage rejects', async () => {
  const flow = await prepare({ mode: 'sequential', stages: [{ stageNumber: 1, roleIds: [first.roleId] }, { stageNumber: 3, roleIds: [second.roleId] }, { stageNumber: 9, roleIds: [first.roleId] }] });
  await assert.rejects(reject(flow, second, input, 3), { code: 'approval_not_pending' });
  await approve(flow, first); const earlier = (await read(flow)).approvalRows[0];
  await reject(flow, second, input, 3);
  const after = await read(flow); assert.deepEqual(after.approvalRows[0], earlier);
  assert.deepEqual(after.approvalRows.map((row) => row.status), ['approved', 'rejected', 'cancelled']);
  assert.equal(after.approvalRows[2].respondedAt, null); assert.equal(after.approvalRows[2].stageStatus, 'cancelled');
});

test('all-mode rejection preserves a previous approval in the same stage', async () => {
  const flow = await prepare(); await approve(flow, first);
  const before = (await read(flow)).approvalRows.find((row) => row.decidedBy === first.userId);
  await reject(flow, second);
  const after = await read(flow); assert.equal(after.status, 'rejected');
  assert.deepEqual(after.approvalRows.find((row) => row.decidedBy === first.userId), { ...before, stageStatus: 'rejected' });
  assert.equal(after.approvalRows.filter((row) => row.status === 'rejected').length, 1);
});

test('exact rejection retry survives a later request and final approval, while changed content and decisions are refused', async () => {
  const flow = await prepare({ mode: 'any' });
  const value = { ...input, checklistItemIds: flow.workflow.transition.checklist.map((item) => item.id) };
  const result = await reject(flow, first, value);
  assert.deepEqual(await reject(flow, first, { ...value, checklistItemIds: [...value.checklistItemIds].reverse() }), result);
  await assert.rejects(reject(flow, first, { ...value, comment: 'Different' }), { code: 'approval_not_pending' });
  await assert.rejects(reject(flow), { code: 'approval_not_pending' });
  const next = await work(manager, (client, identity) => requestWorkflowTransition(client, identity, flow.run.id, {
    revision: result.revision, transitionId: flow.workflow.transition.id, comment: 'Synthetic later request', checklistItemIds: value.checklistItemIds,
  }));
  const pending = await work(second, (client, identity) => readApprovalCase(client, identity, { caseId: next.approvalCaseId }), true);
  await work(second, (client, identity) => approveWorkflowAssignment(client, identity, pending.assignmentId, { comment: 'Synthetic later approval', checklistItemIds: value.checklistItemIds }));
  assert.deepEqual(await reject(flow, first, value), result);
  assert.equal((await owner.query('SELECT count(*)::int n FROM workflow_run_history WHERE organization_id=$1 AND workflow_run_id=$2 AND action=\'rejected\'', [manager.organizationId, flow.run.id])).rows[0].n, 1);
  await assert.rejects(work(second, (client, identity) => rejectWorkflowAssignment(client, identity, pending.assignmentId, input)), { code: 'approval_not_pending' });
});

test('competing rejections serialize to one decision and concurrent exact retries return one outcome', async () => {
  const flow = await prepare(); const results = await Promise.allSettled([reject(flow), reject(flow, second)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'approval_not_pending');
  const winner = results[0].status === 'fulfilled' ? first : second;
  const retried = await Promise.all([reject(flow, winner), reject(flow, winner)]); assert.deepEqual(retried[0], retried[1]);
  assert.equal((await read(flow)).approvalRows.filter((row) => row.decisionId).length, 1);
});

test('competing any-mode approval and rejection commit only the winning complete outcome', async () => {
  const flow = await prepare({ mode: 'any' });
  const results = await Promise.allSettled([approve(flow, first), reject(flow, second)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'approval_not_pending');
  const shown = await read(flow); assert.ok(['approved', 'rejected'].includes(shown.status));
  assert.equal(shown.approvalRows.filter((row) => row.decisionId).length, 1);
});

test('assignee, tenant, current session and permissions are required on every rejection and retry', async () => {
  const flow = await prepare(); const id = assignment(flow, first);
  await assert.rejects(work(second, (client, identity) => rejectWorkflowAssignment(client, identity, id, input)), { code: 'approval_assignee_required' });
  await assert.rejects(work(foreign, (client, identity) => rejectWorkflowAssignment(client, identity, id, input)), { code: 'approval_not_found' });
  await assert.rejects(work(reader, (client, identity) => rejectWorkflowAssignment(client, identity, id, input)), { status: 403 });
  await assert.rejects(reject(flow, first, { comment: ' ', checklistItemIds: [] }), { status: 400 });
  await assert.rejects(reject(flow, first, { ...input, checklistItemIds: [randomUUID()] }), { code: 'invalid_workflow_checklist' });
  await assert.rejects(reject(flow, first, { ...input, checklistItemIds: [flow.workflow.transition.checklist[0].id, flow.workflow.transition.checklist[0].id] }), { status: 400 });
  await assert.rejects(work(first, async (client) => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [second.userId]);
    return client.query('SELECT * FROM workflow_reject_approval($1,$2,$3::uuid[])', [id, input.comment, []]);
  }), { constraint: 'workflow_response_session' });
  const result = await reject(flow);
  await assert.rejects(work(first, async (client, identity) => {
    await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code=\'approvals.respond\'', [manager.organizationId, first.roleId]);
    return rejectWorkflowAssignment(client, identity, id, input);
  }), { status: 403 });
  await owner.query('INSERT INTO role_permissions(organization_id,role_id,permission_code) VALUES($1,$2,\'approvals.respond\')', [manager.organizationId, first.roleId]);
  assert.deepEqual(await reject(flow), result);
  await assert.rejects(work(first, async (client, identity) => {
    await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [first.userId]);
    return rejectWorkflowAssignment(client, identity, id, input);
  }), { status: 403 });
  Object.assign(first, await signIn({ identifier: first.username, password: first.password }));
  assert.deepEqual(await reject(flow), result);
});

test('direct partial rejections and orphan histories fail at commit; late application errors roll back the whole response', async () => {
  const flow = await prepare(); const id = assignment(flow, first);
  await assert.rejects(work(first, async (client) => {
    await client.query("INSERT INTO approval_decisions(organization_id,approval_assignment_id,decision,decided_by,comment) VALUES($1,$2,'reject',$3,$4)", [manager.organizationId, id, first.userId, input.comment]);
    await client.query("UPDATE approval_assignments SET status='rejected',responded_at=now() WHERE organization_id=$1 AND id=$2", [manager.organizationId, id]);
  }), { constraint: 'workflow_rejection_evidence' });
  await assert.rejects(work(first, (client) => client.query(`INSERT INTO workflow_run_history(organization_id,workflow_run_id,workflow_version_id,transition_id,from_state_id,to_state_id,action,actor_user_id,comment)
    VALUES($1,$2,$3,$4,$5,$5,'rejected',$6,$7)`, [manager.organizationId, flow.run.id, flow.workflow.versionId, flow.workflow.transition.id, flow.workflow.initial.id, first.userId, input.comment])), { constraint: 'workflow_rejection_evidence' });
  await assert.rejects(work(first, async (client, identity) => {
    await rejectWorkflowAssignment(client, identity, id, input); await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    throw new Error('Synthetic failure after all effects');
  }), /Synthetic failure after all effects/);
  const pending = await read(flow); assert.equal(pending.status, 'pending'); assert.ok(pending.approvalRows.every((row) => !row.decisionId));
  assert.equal((await owner.query('SELECT revision FROM workflow_runs WHERE organization_id=$1 AND id=$2', [manager.organizationId, flow.run.id])).rows[0].revision, flow.request.revision);
  assert.equal((await reject(flow)).status, 'rejected');
});

test('rejection remains possible after positive transition conditions cease to hold', async () => {
  const flow = await prepare({ conditions: [{ sourceField: 'sample.status', operator: 'neq', comparisonValue: 'on_hold' }] });
  await owner.query("UPDATE samples SET status='on_hold',revision=revision+1 WHERE organization_id=$1 AND id=$2", [manager.organizationId, flow.sample.id]);
  await assert.rejects(approve(flow, first), { code: 'workflow_conditions_not_met' });
  assert.equal((await reject(flow)).status, 'rejected');
});
