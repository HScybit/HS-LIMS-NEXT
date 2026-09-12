import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { loadCapture, loadDefinition } from '../../src/templates/loader.js';
import { saveCapture } from '../../src/templates/capture.js';
import { submitDatasheet } from '../../src/datasheets/submit.js';
import { requestWorkflowTransition, submitDatasheetTransition, approveWorkflowAssignment } from '../../src/workflows/requests.js';
import { loadWorkflowRun } from '../../src/workflows/load.js';
import { cloneWorkflowDraft, saveWorkflowTransition, publishWorkflow } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';

const owner = ownerPool();
let author; let analyst; let replacement; let reader; let foreign; let approver;
const work = (account, action, options = {}) => withSession(account.token, action, { csrfToken: account.csrfToken, ...options });
async function account(options) {
  const user = await createAccount(owner, options);
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
before(async () => {
  author = await account({ permissions: ['templates.manage', 'workflows.manage', 'samples.create', 'samples.manage', 'test_requests.allocate'] });
  analyst = await account({ organizationId: author.organizationId, permissions: ['datasheets.execute'] });
  replacement = await account({ organizationId: author.organizationId, permissions: ['datasheets.execute'] });
  reader = await account({ organizationId: author.organizationId, permissions: ['samples.read'] });
  foreign = await account({ permissions: ['datasheets.execute'] });
  approver = await account({ organizationId: author.organizationId, permissions: ['approvals.respond'] });
});
after(async () => { await closePool(); await owner.end(); });

async function prepare({ enter = true, repeated = true, approval = false } = {}) {
  const fixture = await createLaboratoryFixture(owner, author, { repeated });
  await work(author, (client, identity) => editTemplate(client, identity, fixture.template.versionId, 1,
    { type: 'configureColumn', id: fixture.template.records.columns.at(-1).id, span: 6, isFinalResult: true }));
  if (approval) {
    const original = fixture.workflowRecords.find((row) => row.workflow.appliesTo === 'test_request');
    const draft = await work(author, (client, identity) => cloneWorkflowDraft(client, identity, original.version.id));
    const definition = await work(author, (client, identity) => loadWorkflowDefinition(client, identity, draft.versionId), { readOnly: true });
    const edge = definition.transitions[0];
    const saved = await work(author, (client, identity) => saveWorkflowTransition(client, identity, draft.versionId, draft.revision, {
      code: edge.code, name: edge.name, sourceStateId: edge.sourceStateId, targetStateId: edge.targetStateId,
      approvalMode: 'all', approverStages: [{ stageNumber: 1, roleIds: [approver.roleId] }], creatorRoleIds: [analyst.roleId], requireComment: true,
      checklist: [{ prompt: 'Confirm the analytical result', isRequired: true }],
    }, edge.id));
    await work(author, (client, identity) => publishWorkflow(client, identity, draft.versionId, saved.revision, 'Synthetic result approval'));
  }
  const sample = await work(author, (client, identity) => registerSample(client, identity, fixture.registration));
  const requests = await work(author, (client, identity) => generateTestRequests(client, identity, sample.id));
  const requestId = requests.items[0].id;
  const allocated = await work(author, (client, identity) => allocateTestRequest(client, identity, requestId, { revision: 1, assignedUserId: analyst.userId, assignmentType: 'analyst' }));
  const sheet = (await owner.query('SELECT * FROM datasheets WHERE organization_id=$1 AND id=$2', [author.organizationId, allocated.datasheetId])).rows[0];
  const capture = await work(analyst, (client, identity) => loadCapture(client, identity.organization_id, sheet.template_instance_id), { readOnly: true });
  const inputs = fixture.template.records.fields.filter((field) => field.widget === 'number_widget').flatMap((field) => capture.occurrences
    .filter((occurrence) => occurrence.groupId === field.repeatGroupId)
    .map((occurrence) => ({ fieldId: field.id, occurrenceId: occurrence.id, state: 'present', value: '0' })));
  const saved = enter ? await work(analyst, (client, identity) => saveCapture(client, identity, sheet.template_instance_id, capture.revision, inputs)) : capture;
  return { ...fixture, sample, requestId, sheet, inputs, workflowRunId: allocated.workflowRunId, captureRevision: saved.revision };
}
const submit = (fixture, input = {}, user = analyst) => work(user, (client, identity) => submitDatasheet(client, identity, fixture.sheet.id,
  { revision: 1, captureRevision: fixture.captureRevision, ...input }));
async function status(fixture) {
  return (await owner.query(`SELECT sheet.status, sheet.revision, sheet.latest_submission_id, request.status AS request_status, capture.status AS capture_status, capture.revision AS capture_revision,
    (SELECT count(*)::integer FROM datasheet_submissions WHERE organization_id=sheet.organization_id AND datasheet_id=sheet.id) AS submissions
    FROM datasheets sheet JOIN test_requests request ON request.organization_id=sheet.organization_id AND request.id=sheet.test_request_id
    JOIN template_instances capture ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id WHERE sheet.organization_id=$1 AND sheet.id=$2`, [author.organizationId, fixture.sheet.id])).rows[0];
}

test('submission atomically pins the exact capture, zero result, unit snapshot and actual actor; history remains immutable', async () => {
  const fixture = await prepare();
  await owner.query("UPDATE measurement_units SET name='Changed master unit', revision=revision+1 WHERE organization_id=$1 AND id=$2", [author.organizationId, fixture.unit.id]);
  const submitted = await submit(fixture, { narration: '' });
  assert.equal(submitted.status, 'under_review'); assert.equal(submitted.revision, 2);
  assert.equal(submitted.metrics.definition.queryCount, 8); assert.equal(submitted.metrics.capture.queryCount, 3);
  const result = submitted.submission;
  assert.equal(result.submittedBy, analyst.userId); assert.equal(result.numberValue, '0'); assert.equal(result.resultType, 'numeric');
  assert.equal(result.fieldId, fixture.template.records.fields.at(-1).id); assert.equal(result.valueRevision, 1);
  assert.equal(result.captureRevision, fixture.captureRevision + 1); assert.equal(result.unitName, fixture.unit.name); assert.equal(result.unitRevision, 1);
  assert.equal(result.narration, ''); assert.equal(result.number, 1);
  assert.deepEqual(await status(fixture), { status: 'under_review', revision: 2, latest_submission_id: result.id,
    request_status: 'under_review', capture_status: 'frozen', capture_revision: fixture.captureRevision + 1, submissions: 1 });
  const historical = await work(reader, (client, identity) => loadCapture(client, identity.organization_id, result.instanceId, result.captureRevision), { readOnly: true });
  assert.equal(historical.values.find((value) => value.fieldId === result.fieldId).numberValue, '0');
  const version = await work(reader, (client, identity) => loadDefinition(client, identity.organization_id, result.versionId), { readOnly: true });
  assert.equal(version.model.version.status, 'frozen');
  await assert.rejects(work(analyst, (client, identity) => saveCapture(client, identity, result.instanceId, result.captureRevision, fixture.inputs)), { code: 'capture_write_denied' });
  await assert.rejects(owner.query('UPDATE datasheet_submissions SET number_value=7 WHERE organization_id=$1 AND id=$2', [author.organizationId, result.id]), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM datasheet_submissions WHERE organization_id=$1 AND id=$2', [author.organizationId, result.id]), { code: '55000' });
  const invisible = await work(foreign, (client) => client.query('SELECT id FROM datasheet_submissions WHERE id=$1', [result.id]), { readOnly: true });
  assert.equal(invisible.rowCount, 0);
  const event = (await owner.query("SELECT actor_user_id, occurred_at FROM sample_events WHERE organization_id=$1 AND test_request_id=$2 AND event_type='datasheet_submitted'", [author.organizationId, fixture.requestId])).rows[0];
  assert.equal(event.actor_user_id, analyst.userId); assert.equal(event.occurred_at.getTime(), result.submittedAt.getTime());
});

test('submission rejects client results, unauthorized actors, foreign units, stale revisions and empty required captures without partial writes', async () => {
  const fixture = await prepare(); const original = await status(fixture);
  await assert.rejects(submit(fixture, { finalResult: 'forged' }), { code: 'invalid_input' });
  await assert.rejects(submit(fixture, {}, reader), { status: 403 });
  await assert.rejects(submit(fixture, {}, replacement), { code: 'datasheet_not_assigned' });
  await assert.rejects(submit(fixture, {}, foreign), { status: 404 });
  await assert.rejects(submit(fixture, { measurementUnitId: randomUUID() }), { code: 'invalid_measurement_unit' });
  await assert.rejects(submit(fixture, { revision: 2 }), { code: 'stale_datasheet' });
  await assert.rejects(submit(fixture, { captureRevision: 1 }), { code: 'stale_capture' });
  assert.deepEqual(await status(fixture), original);
  const empty = await prepare({ enter: false });
  await assert.rejects(submit(empty), { code: 'required_template_values_missing' });
  assert.equal((await status(empty)).submissions, 0); assert.equal((await status(empty)).capture_status, 'editing');
});

test('concurrent submissions record one frozen result and reassignment removes the prior analyst authority', async () => {
  const fixture = await prepare();
  const results = await Promise.allSettled([submit(fixture), submit(fixture)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'datasheet_closed');
  assert.equal((await status(fixture)).submissions, 1);
  const reassigned = await prepare();
  await work(author, (client, identity) => allocateTestRequest(client, identity, reassigned.requestId, { revision: 2, assignedUserId: replacement.userId, assignmentType: 'analyst' }));
  await assert.rejects(submit(reassigned), { code: 'datasheet_not_assigned' });
  assert.equal((await submit(reassigned, { measurementUnitId: null }, replacement)).submission.measurementUnitId, null);
});

test('an audit-write failure rolls back the result and capture freeze, and retry creates one submission', async () => {
  const fixture = await prepare(); const original = await status(fixture);
  await assert.rejects(work(analyst, (client, identity) => {
    const query = client.query.bind(client);
    const failing = Object.create(client);
    failing.query = (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (/insert into "sample_events"/i.test(sql)) throw new Error('Synthetic submission audit failure');
      return query(...args);
    };
    return submitDatasheet(failing, identity, fixture.sheet.id, { revision: 1, captureRevision: fixture.captureRevision });
  }), (error) => { assert.match((error.cause ?? error).message, /Synthetic submission audit failure/); return true; });
  assert.deepEqual(await status(fixture), original);
  const submitted = await submit(fixture); assert.equal(submitted.submission.number, 1); assert.equal((await status(fixture)).submissions, 1);
});

test('direct SQL cannot invent a current submission link or record submission without its owner and audit effects', async () => {
  const fixture = await prepare();
  await assert.rejects(work(analyst, (client) => client.query("UPDATE datasheets SET latest_submission_id=$3, revision=revision+1, status='under_review', completed_at=now(), completed_by=$4 WHERE organization_id=$1 AND id=$2",
    [author.organizationId, fixture.sheet.id, randomUUID(), analyst.userId])), { code: '23514' });
  const original = await status(fixture);
  await assert.rejects(work(analyst, (client, identity) => {
    const query = client.query.bind(client); const incomplete = Object.create(client);
    incomplete.query = (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (/insert into "sample_events"/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
      return query(...args);
    };
    return submitDatasheet(incomplete, identity, fixture.sheet.id, { revision: 1, captureRevision: fixture.captureRevision });
  }), { code: '23514' });
  assert.deepEqual(await status(fixture), original);
});

test('the combined submission and direct workflow action commits one approved frozen result, with failures rolling back both', async () => {
  const fixture = await prepare();
  const run = await work(analyst, (client, identity) => loadWorkflowRun(client, identity, fixture.workflowRunId), { readOnly: true });
  const edge = run.transitions[0];
  const transition = { revision: run.revision, transitionId: edge.id, comment: 'Synthetic direct completion', checklistItemIds: [] };
  await assert.rejects(work(analyst, (client, identity) => requestWorkflowTransition(client, identity, run.id, transition)), { code: 'final_result_required' });
  const original = await status(fixture);
  const command = { datasheetId: fixture.sheet.id, datasheet: { revision: 1, captureRevision: fixture.captureRevision }, transition };
  await assert.rejects(work(analyst, (client, identity) => submitDatasheetTransition(client, identity, run.id, { ...command, transition: { ...transition, revision: run.revision + 1 } })), { code: 'stale_workflow_run' });
  assert.deepEqual(await status(fixture), original);
  const completed = await work(analyst, (client, identity) => submitDatasheetTransition(client, identity, run.id, command));
  assert.equal(completed.status, 'completed'); assert.equal((await status(fixture)).request_status, 'approved');
  assert.equal((await status(fixture)).status, 'approved');
  const history = (await owner.query("SELECT * FROM workflow_run_history WHERE organization_id=$1 AND workflow_run_id=$2 AND action='completed'", [author.organizationId, run.id])).rows[0];
  assert.equal(history.datasheet_submission_id, completed.submissionId); assert.equal(history.actor_user_id, analyst.userId);
  const selected = (await owner.query('SELECT selected.status FROM sample_tests selected JOIN test_requests request ON request.organization_id=selected.organization_id AND request.sample_test_id=selected.id WHERE request.organization_id=$1 AND request.id=$2', [author.organizationId, fixture.requestId])).rows[0];
  assert.equal(selected.status, 'completed');
});

test('an assigned approver with no datasheet or sample write permission approves the exact requested submission', async () => {
  const fixture = await prepare({ approval: true });
  const run = await work(analyst, (client, identity) => loadWorkflowRun(client, identity, fixture.workflowRunId), { readOnly: true });
  const edge = run.transitions[0];
  const input = { datasheetId: fixture.sheet.id, datasheet: { revision: 1, captureRevision: fixture.captureRevision },
    transition: { revision: run.revision, transitionId: edge.id, comment: 'Synthetic review request', checklistItemIds: edge.checklistItems.map((item) => item.id) } };
  const requested = await work(analyst, (client, identity) => submitDatasheetTransition(client, identity, run.id, input));
  assert.equal(requested.status, 'approval_pending');
  const pending = await work(approver, (client, identity) => loadWorkflowRun(client, identity, run.id), { readOnly: true });
  const approval = pending.approvalRequest;
  assert.equal(approval.datasheetSubmissionId, requested.submissionId); assert.equal(approval.canRespond, true);
  await assert.rejects(work(analyst, (client, identity) => approveWorkflowAssignment(client, identity, approval.assignmentId, { comment: 'Not an approver', checklistItemIds: [] })), { status: 403 });
  await assert.rejects(work(approver, (client, identity) => approveWorkflowAssignment(client, identity, approval.assignmentId, { comment: 'Missing check', checklistItemIds: [] })), { code: 'workflow_checklist_required' });
  const approved = await work(approver, (client, identity) => approveWorkflowAssignment(client, identity, approval.assignmentId,
    { comment: 'Synthetic result approved', checklistItemIds: approval.checklistItems.map((item) => item.id) }));
  assert.equal(approved.status, 'completed'); assert.equal((await status(fixture)).status, 'approved');
  const history = (await owner.query("SELECT * FROM workflow_run_history WHERE organization_id=$1 AND workflow_run_id=$2 AND action='completed'", [author.organizationId, run.id])).rows[0];
  assert.equal(history.datasheet_submission_id, requested.submissionId); assert.equal(history.actor_user_id, approver.userId);
  const result = (await owner.query('SELECT * FROM datasheet_submissions WHERE organization_id=$1 AND id=$2', [author.organizationId, requested.submissionId])).rows[0];
  assert.equal(result.submitted_by, analyst.userId); assert.equal(result.number_value, '0');
  const closed = await work(reader, (client, identity) => loadWorkflowRun(client, identity, run.id), { readOnly: true });
  assert.equal(closed.approvalRequest.approvalRows[0].checklistItems[0].isChecked, true);
});
