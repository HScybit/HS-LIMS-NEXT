import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareSubjectJob } from '../helpers/job-subjects.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { saveCapture } from '../../src/templates/capture.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, publishWorkflow, cloneWorkflowDraft } from '../../src/workflows/authoring.js';
import { loadWorkflowMaster, retireWorkflowMaster, updateWorkflowMaster } from '../../src/workflows/metadata.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { submitDatasheetTransition, approveWorkflowAssignment, requestWorkflowTransition } from '../../src/workflows/requests.js';
import { loadWorkflowRun } from '../../src/workflows/load.js';
import { loadTestRequest } from '../../src/test-requests/load.js';

const owner = ownerPool(); let creator; let analyst; let reviewer; let outsider;
const work = (user, callback, options = {}) => withSession(user.token, callback, { csrfToken: user.csrfToken, ...options });
const load = (id) => work(analyst, (client, identity) => loadDatasheet(client, identity, id), { readOnly: true });
before(async () => {
  creator = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'test_requests.allocate', 'templates.manage', 'settings.manage', 'workflows.manage'] });
  analyst = await createAccount(owner, { organizationId: creator.organizationId, permissions: ['datasheets.execute'] });
  reviewer = await createAccount(owner, { organizationId: creator.organizationId, permissions: ['approvals.respond'] });
  outsider = await createAccount(owner, { permissions: ['samples.read', 'datasheets.execute'] });
  for (const user of [creator, analyst, reviewer, outsider]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

async function definition(mode = 'none', { intermediate = false } = {}) {
  const call = (callback) => work(creator, callback);
  const workflow = await call((client, identity) => createWorkflow(client, identity, { code: randomUUID(), name: `Synthetic independent job workflow ${randomUUID()}`, appliesTo: 'test_request' }));
  const initial = await call((client, identity) => saveWorkflowState(client, identity, workflow.versionId, 1, { code: 'initial', name: 'Summary review', stateType: 'initial', showAddResult: true }));
  const middle = intermediate ? await call((client, identity) => saveWorkflowState(client, identity, workflow.versionId, initial.revision,
    { code: 'reviewing', name: 'Job review in progress', stateType: 'normal' })) : null;
  const final = await call((client, identity) => saveWorkflowState(client, identity, workflow.versionId, middle?.revision ?? initial.revision, { code: 'accepted', name: 'Job accepted', stateType: 'final', isPositiveTermination: true }));
  const cancelled = await call((client, identity) => saveWorkflowState(client, identity, workflow.versionId, final.revision, { code: 'cancelled', name: 'Job cancelled', stateType: 'cancelled' }));
  const complete = await call((client, identity) => saveWorkflowTransition(client, identity, workflow.versionId, cancelled.revision,
    { code: 'accept', name: 'Accept job', sourceStateId: middle?.id ?? initial.id, targetStateId: final.id, approvalMode: mode, creatorRoleIds: [analyst.roleId],
      approverStages: mode === 'none' ? [] : [{ stageNumber: 1, roleIds: [reviewer.roleId] }], requireComment: true, checklist: [] }));
  const cancel = await call((client, identity) => saveWorkflowTransition(client, identity, workflow.versionId, complete.revision,
    { code: 'cancel', name: 'Cancel job', sourceStateId: initial.id, targetStateId: cancelled.id, approvalMode: 'none', creatorRoleIds: [analyst.roleId], requireComment: true, checklist: [] }));
  const review = middle ? await call((client, identity) => saveWorkflowTransition(client, identity, workflow.versionId, cancel.revision,
    { code: 'review', name: 'Review job', sourceStateId: initial.id, targetStateId: middle.id, approvalMode: 'none', creatorRoleIds: [analyst.roleId], requireComment: true, checklist: [] })) : null;
  await call((client, identity) => publishWorkflow(client, identity, workflow.versionId, review?.revision ?? cancel.revision, 'Synthetic grouped workflow evidence'));
  return { ...workflow, complete, cancel, review };
}

async function prepare(mode, options) {
  const workflow = await definition(mode, options);
  const flow = await prepareSubjectJob(owner, creator, analyst, { resultWidget: true, jobWorkflowId: workflow.workflowId });
  let sheet = await load(flow.job.datasheetId);
  const fields = Object.values(sheet.model.fieldsById); const raw = fields.find((field) => field.alias === 'raw_0'); const result = fields.find((field) => field.widget === 'result_widget');
  const rows = sheet.capture.occurrences.filter((row) => row.subject);
  await work(analyst, (client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision,
    rows.flatMap((row, index) => [{ fieldId: raw.id, occurrenceId: row.id, state: 'present', value: '0' }, { fieldId: result.id, occurrenceId: row.id, state: 'present', value: String(index * 5) }])));
  sheet = await load(flow.job.datasheetId);
  const run = await work(analyst, (client, identity) => loadWorkflowRun(client, identity, flow.job.workflowRunId), { readOnly: true });
  const children = (await owner.query('SELECT run.* FROM workflow_runs run JOIN test_requests child ON child.organization_id=run.organization_id AND child.id=run.test_request_id WHERE child.organization_id=$1 AND child.parent_test_request_id=$2 ORDER BY run.id', [creator.organizationId, flow.job.id])).rows;
  return { ...flow, workflow, sheet, run, children };
}
const submit = (flow, transitionId = flow.workflow.complete.id) => work(analyst, (client, identity) => submitDatasheetTransition(client, identity, flow.run.id, {
  datasheetId: flow.sheet.datasheet.id, datasheet: { revision: flow.sheet.datasheet.revision, captureRevision: flow.sheet.capture.revision },
  transition: { revision: flow.run.revision, transitionId, comment: 'Synthetic actual job decision', checklistItemIds: [] },
}));
const effects = async (flow) => (await owner.query('SELECT * FROM laboratory_job_workflow_effects WHERE organization_id=$1 AND parent_request_id=$2 ORDER BY test_request_id', [creator.organizationId, flow.job.id])).rows;

test('a configured job workflow cannot be retired until the actual laboratory setting is cleared', async () => {
  const workflow = await definition();
  const current = await work(creator, loadLaboratorySettings, { readOnly: true });
  const setting = { revision: current.settings.revision, autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: workflow.workflowId };
  const saved = await work(creator, (client, identity) => saveLaboratorySettings(client, identity, setting));
  const command = { id: workflow.workflowId, metadataRevision: 1, requestId: randomUUID() };
  await assert.rejects(work(creator, (client, identity) => retireWorkflowMaster(client, identity, command)), { code: 'workflow_in_use' });
  await work(creator, (client, identity) => saveLaboratorySettings(client, identity, { ...setting, revision: saved.revision, jobWorkflowId: null }));
  assert.equal((await work(creator, (client, identity) => retireWorkflowMaster(client, identity, command))).metadataRevision, 2);
  await assert.rejects(work(creator, (client, identity) => saveLaboratorySettings(client, identity, { ...setting, revision: saved.revision + 1 })), { code: 'invalid_job_workflow' });
  await assert.rejects(work(creator, (client, identity) => cloneWorkflowDraft(client, identity, workflow.versionId)), { code: 'workflow_not_found' });
});

test('an actual job run protects its workflow after settings are cleared and permits an unchanged-type metadata edit', async () => {
  const flow = await prepare();
  const current = await work(creator, loadLaboratorySettings, { readOnly: true });
  await work(creator, (client, identity) => saveLaboratorySettings(client, identity, { revision: current.settings.revision,
    autoCreateJobs: false, resultSummaryTemplateId: current.settings.resultSummaryTemplateId, jobWorkflowId: null }));
  assert.equal((await owner.query('SELECT count(*)::int n FROM sample_category_workflows WHERE organization_id=$1 AND workflow_id=$2', [creator.organizationId, flow.workflow.workflowId])).rows[0].n, 0);
  assert.equal((await owner.query('SELECT count(*)::int n FROM workflow_runs WHERE organization_id=$1 AND workflow_version_id=$2', [creator.organizationId, flow.workflow.versionId])).rows[0].n, 1);
  const master = await work(creator, (client, identity) => loadWorkflowMaster(client, identity, flow.workflow.workflowId), { readOnly: true });
  const command = { id: master.id, metadataRevision: master.metadataRevision, requestId: randomUUID() };
  await assert.rejects(work(creator, (client, identity) => retireWorkflowMaster(client, identity, command)), { code: 'workflow_in_use' });
  await assert.rejects(work(creator, (client, identity) => updateWorkflowMaster(client, identity, { ...command, name: master.name, appliesTo: 'sample' })), { code: 'workflow_type_immutable' });
  assert.equal((await work(creator, (client, identity) => updateWorkflowMaster(client, identity, { ...command, name: 'Renamed ' + master.name, appliesTo: 'test_request' }))).metadataRevision, 2);
  const retained = await work(analyst, (client, identity) => loadWorkflowRun(client, identity, flow.run.id), { readOnly: true });
  assert.equal(retained.versionId, flow.run.versionId); assert.equal(retained.status, 'active');
});

test('a job decision covers its child results while preserving their different workflow definitions and actual parent evidence', async () => {
  const flow = await prepare(); const completed = await submit(flow);
  assert.equal(completed.status, 'completed'); const rows = await effects(flow); assert.equal(rows.length, 2);
  for (const child of flow.children) {
    assert.notEqual(child.workflow_version_id, flow.workflow.versionId);
    const actual = (await owner.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND id=$2', [creator.organizationId, child.id])).rows[0];
    assert.equal(actual.workflow_version_id, child.workflow_version_id); assert.equal(actual.current_state_id, child.current_state_id);
    assert.equal(actual.status, 'completed'); assert.equal(actual.revision, child.revision + 1);
    assert.equal((await owner.query('SELECT count(*)::integer AS count FROM workflow_run_history WHERE organization_id=$1 AND workflow_run_id=$2', [creator.organizationId, child.id])).rows[0].count, 1);
    const shown = await work(reviewer, (client, identity) => loadWorkflowRun(client, identity, child.id), { readOnly: true });
    assert.equal(shown.state.id, child.current_state_id); assert.equal(shown.jobState.toStateName, 'Job accepted'); assert.equal(shown.transitions.length, 0);
    assert.equal(shown.activity.filter((event) => event.parentJobNumber).length, 1);
    assert.equal((await work(reviewer, (client, identity) => loadTestRequest(client, identity, child.test_request_id), { readOnly: true })).stateName, 'Job accepted');
  }
  assert.ok(rows.every((row) => row.parent_history_id === completed.historyId && row.actor_user_id === analyst.userId && row.is_current));
  await assert.rejects(work(analyst, (client) => client.query('INSERT INTO job_workflow_effects(organization_id) VALUES($1)', [creator.organizationId])), { code: '42501' });
  await assert.rejects(work(analyst, (client) => client.query('SELECT workflow_apply_job_effects($1)', [completed.historyId])), { code: '42501' });
  assert.equal((await work(outsider, (client) => client.query('SELECT * FROM laboratory_job_workflow_effects WHERE parent_request_id=$1', [flow.job.id]), { readOnly: true })).rowCount, 0);
});

test('an approval-only responder applies the group outcome and a late failure rolls back the decision and every child effect', async () => {
  const flow = await prepare('all'); const requested = await submit(flow);
  assert.equal(requested.status, 'approval_pending'); assert.equal((await effects(flow)).length, 0);
  const pending = await work(reviewer, (client, identity) => loadWorkflowRun(client, identity, flow.run.id), { readOnly: true });
  const input = { comment: 'Synthetic reviewed group', checklistItemIds: [] };
  await assert.rejects(work(reviewer, async (client, identity) => {
    const observed = Object.create(client);
    observed.query = async (...args) => {
      const result = await client.query(...args);
      if (typeof args[0] === 'string' && args[0].includes('workflow_apply_test_request_transition')) throw new Error('Synthetic after-effect failure');
      return result;
    };
    return approveWorkflowAssignment(observed, identity, pending.approvalRequest.assignmentId, input);
  }), /Synthetic after-effect failure/);
  assert.equal((await effects(flow)).length, 0);
  assert.equal((await work(reviewer, (client, identity) => loadWorkflowRun(client, identity, flow.run.id), { readOnly: true })).approvalRequest.status, 'pending');
  const completed = await work(reviewer, (client, identity) => approveWorkflowAssignment(client, identity, pending.approvalRequest.assignmentId, input));
  assert.equal(completed.status, 'completed'); assert.ok((await effects(flow)).every((row) => row.actor_user_id === reviewer.userId));
});

test('combined group submission and cancellation retains every source capture and actual parent cancellation evidence', async () => {
  const flow = await prepare(); const cancelled = await submit(flow, flow.workflow.cancel.id);
  assert.equal(cancelled.status, 'cancelled'); const rows = await effects(flow); assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.action === 'cancelled' && row.actor_user_id === analyst.userId));
  const sheets = (await owner.query('SELECT sheet.status FROM datasheets sheet JOIN test_requests child ON child.organization_id=sheet.organization_id AND child.id=sheet.test_request_id WHERE child.organization_id=$1 AND child.parent_test_request_id=$2', [creator.organizationId, flow.job.id])).rows;
  assert.ok(sheets.every((sheet) => sheet.status === 'void'));
  assert.equal((await owner.query('SELECT status FROM template_instances WHERE organization_id=$1 AND id=$2', [creator.organizationId, flow.sheet.capture.instance.id])).rows[0].status, 'frozen');
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM job_submission_members WHERE organization_id=$1 AND parent_submission_id=$2', [creator.organizationId, cancelled.submissionId])).rows[0].count, 2);
});

test('an intermediate parent decision blocks stale child graph actions while the actual job can continue to completion', async () => {
  const flow = await prepare('none', { intermediate: true });
  const originalChild = await work(analyst, (client, identity) => loadWorkflowRun(client, identity, flow.children[0].id), { readOnly: true });
  assert.ok(originalChild.transitions.length);
  const reviewing = await submit(flow, flow.workflow.review.id);
  assert.equal(reviewing.status, 'active');
  const child = await work(analyst, (client, identity) => loadWorkflowRun(client, identity, originalChild.id), { readOnly: true });
  assert.equal(child.jobState.toStateName, 'Job review in progress'); assert.equal(child.transitions.length, 0);
  const input = { revision: child.revision, transitionId: originalChild.transitions[0].id, comment: 'Synthetic stale child action', checklistItemIds: [] };
  await assert.rejects(work(analyst, (client, identity) => requestWorkflowTransition(client, identity, child.id, input)), { code: 'job_workflow_controls' });
  await assert.rejects(work(analyst, (client) => client.query('SELECT * FROM workflow_apply_test_request_transition($1,$2,$3,$4)',
    [child.id, input.transitionId, child.revision, input.comment])), { code: '23514', constraint: 'workflow_parent_job_controls' });
  const completed = await work(analyst, (client, identity) => requestWorkflowTransition(client, identity, flow.run.id,
    { revision: reviewing.revision, transitionId: flow.workflow.complete.id, comment: 'Synthetic completed parent review', checklistItemIds: [] }));
  assert.equal(completed.status, 'completed');
  const after = await work(analyst, (client, identity) => loadWorkflowRun(client, identity, child.id), { readOnly: true });
  assert.equal(after.status, 'completed'); assert.equal(after.versionId, originalChild.versionId); assert.equal(after.jobState.toStateName, 'Job accepted');
  assert.equal(after.activity.filter((item) => item.parentJobNumber).length, 2);
  const evidence = await effects(flow);
  assert.equal(evidence.length, 4); assert.equal(evidence.filter((item) => item.is_current).length, 2);
});
