import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { createAlternateMethod } from '../helpers/methods.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { addTestRequestMethod, deleteTestRequestMethod } from '../../src/test-requests/methods.js';
import { loadTestRequest } from '../../src/test-requests/load.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { saveCapture, createWorkflowCapture } from '../../src/templates/capture.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { loadWorkflowRun } from '../../src/workflows/load.js';
import { submitDatasheetTransition } from '../../src/workflows/requests.js';
import { generateReports, loadReport } from '../../src/reports/service.js';

const owner = ownerPool(); let analyst; let manager; let reader; let foreign;
const work = (account, action, options = {}) => withSession(account.token, action, { csrfToken: account.csrfToken, ...options });
async function account(options) {
  const user = await createAccount(owner, options);
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
before(async () => {
  analyst = await account({ permissions: ['templates.manage', 'workflows.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  manager = await account({ organizationId: analyst.organizationId, permissions: ['samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  reader = await account({ organizationId: analyst.organizationId, permissions: ['samples.read'] });
  foreign = await account({ permissions: ['datasheets.execute'] });
});
after(async () => { await closePool(); await owner.end(); });
const prepare = (options) => prepareReportFlow(owner, analyst, { complete: false, ...options });
const add = (flow, methodId, expected = 2, user = analyst) => work(user, (client, identity) =>
  addTestRequestMethod(client, identity, flow.requestId, { revision: expected, methodId }));
const remove = (flow, sheetId, expected, user = analyst) => work(user, (client, identity) =>
  deleteTestRequestMethod(client, identity, flow.requestId, sheetId, { revision: expected }));
const request = (flow, user = analyst) => work(user, (client, identity) => loadTestRequest(client, identity, flow.requestId), { readOnly: true });
const runtime = (sheetId) => work(analyst, (client, identity) => loadDatasheet(client, identity, sheetId), { readOnly: true });
async function enter(sheetId, value) {
  const loaded = await runtime(sheetId);
  const values = Object.values(loaded.model.fieldsById).filter((field) => field.widget === 'number_widget').flatMap((field) =>
    loaded.capture.occurrences.filter((row) => row.groupId === (field.repeatGroupId ?? null)).map((row) => ({ fieldId: field.id, occurrenceId: row.id, state: 'present', value })));
  const saved = await work(analyst, (client, identity) => saveCapture(client, identity, loaded.datasheet.templateInstanceId, loaded.capture.revision, values));
  return { loaded, saved, values };
}
async function specification(sheetId) {
  return (await owner.query(`SELECT specification.* FROM datasheets sheet JOIN analytical_specifications specification
    ON specification.organization_id=sheet.organization_id AND specification.id=sheet.specification_id WHERE sheet.organization_id=$1 AND sheet.id=$2`,
  [analyst.organizationId, sheetId])).rows[0];
}

test('alternate methods keep frozen request criteria and limits while capturing current method and template versions', async () => {
  const flow = await prepare();
  const base = await specification(flow.sheet.id);
  const method = await createAlternateMethod(owner, analyst, flow.fixture);
  await owner.query("UPDATE test_parameters SET name='Later parameter name',revision=revision+1 WHERE organization_id=$1 AND id=$2", [analyst.organizationId, flow.fixture.parameter.id]);
  await owner.query("UPDATE measurement_units SET symbol='later-unit',revision=revision+1 WHERE organization_id=$1 AND id=$2", [analyst.organizationId, flow.fixture.unit.id]);
  await owner.query("UPDATE decision_rules SET cutoff_value=999,revision=revision+1 WHERE organization_id=$1 AND id=$2", [analyst.organizationId, flow.fixture.rule.id]);
  await work(analyst, (client, identity) => editTemplate(client, identity, flow.fixture.template.versionId, 2,
    { type: 'configureSection', id: flow.fixture.template.records.sections[0].id, name: 'Later template section' }));
  const added = await add(flow, method.id.toUpperCase());
  const alternate = await specification(added.datasheetId);
  for (const key of Object.keys(base).filter((key) => !['id', 'basis_specification_id', 'recorded_by', 'recorded_at', 'decimal_scale', 'parse_number'].includes(key) && !key.startsWith('method_'))) {
    assert.deepEqual(alternate[key], base[key], key);
  }
  assert.equal(alternate.basis_specification_id, base.id); assert.equal(alternate.method_id, method.id);
  assert.equal(alternate.method_revision, 1); assert.equal(alternate.decimal_scale, 3); assert.equal(alternate.parse_number, false);
  const limits = async (id) => (await owner.query('SELECT id,lower_limit,upper_limit,lower_inclusive,upper_inclusive,outcome,narration,display_order FROM analytical_specification_limits WHERE organization_id=$1 AND specification_id=$2 ORDER BY id', [analyst.organizationId, id])).rows;
  assert.deepEqual(await limits(alternate.id), await limits(base.id));
  const original = await runtime(flow.sheet.id); const next = await runtime(added.datasheetId);
  assert.notEqual(original.model.version.id, next.model.version.id); assert.notEqual(original.capture.instance.id, next.capture.instance.id);
  assert.equal(next.metrics.definition.queryCount, 8); assert.equal(next.metrics.capture.queryCount, 3);
  await owner.query("UPDATE methods_of_analysis SET name='Later method name',revision=revision+1 WHERE organization_id=$1 AND id=$2", [analyst.organizationId, method.id]);
  assert.equal((await runtime(added.datasheetId)).datasheet.methodName, method.name);
  const evidence = (await request(flow)).methodActivity;
  assert.equal(evidence.length, 1); assert.equal(evidence[0].actorUserId, analyst.userId); assert.equal(evidence[0].datasheetId, added.datasheetId);
});

test('assignment, applicability, tenant, stale revision and concurrent method changes are enforced', async () => {
  const flow = await prepare();
  const method = await createAlternateMethod(owner, analyst, flow.fixture);
  const second = await createAlternateMethod(owner, analyst, flow.fixture, { name: 'Concurrent method' });
  const unavailable = await createAlternateMethod(owner, analyst, flow.fixture, { active: false });
  const unrelated = await createAlternateMethod(owner, analyst, flow.fixture, { applicable: false });
  await assert.rejects(add(flow, method.id, 2, manager), { code: 'method_change_denied' });
  await assert.rejects(add(flow, method.id, 2, reader), { code: 'forbidden' });
  await assert.rejects(add(flow, method.id, 2, foreign), { status: 404 });
  await assert.rejects(add(flow, randomUUID()), { code: 'method_not_applicable' });
  await assert.rejects(add(flow, unavailable.id), { code: 'method_not_applicable' });
  await assert.rejects(add(flow, unrelated.id), { code: 'method_not_applicable' });
  await assert.rejects(add(flow, flow.fixture.method.id), { code: 'method_already_added' });
  const raced = await Promise.allSettled([add(flow, method.id), add(flow, second.id)]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.find((result) => result.status === 'rejected').reason.code, 'stale_test_request');
  const current = await request(flow);
  assert.equal(current.revision, 3); assert.equal(current.datasheets.length, 2); assert.equal(current.methodActivity.length, 1);
  assert.equal((await request(flow, manager)).canChangeMethods, false);
});

test('method removal retains frozen zero values and actual history and protects the last active method', async () => {
  const flow = await prepare(); const method = await createAlternateMethod(owner, analyst, flow.fixture);
  await assert.rejects(remove(flow, flow.sheet.id, 2), { code: 'last_datasheet' });
  const entered = await enter(flow.sheet.id, '0');
  const added = await add(flow, method.id);
  await assert.rejects(remove(flow, flow.sheet.id, 3, manager), { code: 'method_change_denied' });
  await remove(flow, flow.sheet.id, 3);
  const retired = await runtime(flow.sheet.id); const active = await request(flow);
  assert.equal(retired.datasheet.status, 'void'); assert.equal(retired.capture.instance.status, 'frozen'); assert.equal(retired.canExecute, false);
  assert.ok(retired.capture.values.some((value) => value.numberValue === '0'));
  assert.equal(active.datasheets.length, 1); assert.equal(active.datasheetId, added.datasheetId);
  assert.deepEqual(active.methodActivity.map((event) => event.action).sort(), ['datasheet_method_added', 'datasheet_method_voided']);
  await assert.rejects(remove(flow, added.datasheetId, 4), { code: 'last_datasheet' });
  await assert.rejects(work(analyst, (client, identity) => saveCapture(client, identity, entered.loaded.datasheet.templateInstanceId, entered.saved.revision, entered.values)), { code: 'capture_write_denied' });
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM datasheet_submissions WHERE organization_id=$1 AND datasheet_id=$2', [analyst.organizationId, flow.sheet.id])).rows[0].count, 0);
  const again = await add(flow, flow.fixture.method.id, 4);
  assert.notEqual(again.datasheetId, flow.sheet.id);
  assert.equal((await runtime(again.datasheetId)).datasheet.attemptNumber, 3);
});

test('a failed method transaction rolls back captures, specifications, request revision and event evidence', async () => {
  const flow = await prepare(); const method = await createAlternateMethod(owner, analyst, flow.fixture);
  const counts = async () => (await owner.query(`SELECT
    (SELECT count(*)::integer FROM template_instances WHERE organization_id=$1) AS captures,
    (SELECT count(*)::integer FROM analytical_specifications WHERE organization_id=$1) AS specifications,
    (SELECT count(*)::integer FROM sample_events WHERE organization_id=$1 AND test_request_id=$2) AS events`, [analyst.organizationId, flow.requestId])).rows[0];
  const before = await counts();
  await assert.rejects(work(analyst, async (client, identity) => {
    await addTestRequestMethod(client, identity, flow.requestId, { revision: 2, methodId: method.id });
    throw new Error('Synthetic transaction failure');
  }), /Synthetic transaction failure/);
  assert.deepEqual(await counts(), before); assert.equal((await request(flow)).revision, 2);
  await assert.rejects(work(analyst, (client, identity) => client.query(`INSERT INTO sample_events(organization_id,sample_id,test_request_id,datasheet_id,event_type,actor_user_id,description)
    VALUES($1,$2,$3,$4,'datasheet_method_voided',$5,'Forged event')`, [identity.organization_id, flow.sample.id, flow.requestId, flow.sheet.id, identity.user_id])), { code: '42501' });
});

test('only the explicitly submitted alternate result is approved and frozen into the COA', async () => {
  const flow = await prepare(); const method = await createAlternateMethod(owner, analyst, flow.fixture);
  const added = await add(flow, method.id);
  await enter(flow.sheet.id, '2'); const entered = await enter(added.datasheetId, '0');
  const selectedRequest = await request(flow);
  const run = await work(analyst, (client, identity) => loadWorkflowRun(client, identity, selectedRequest.workflowRunId), { readOnly: true });
  const submitted = await work(analyst, (client, identity) => submitDatasheetTransition(client, identity, run.id, {
    datasheetId: added.datasheetId, datasheet: { revision: 1, captureRevision: entered.saved.revision },
    transition: { revision: run.revision, transitionId: run.transitions[0].id, comment: 'Selected alternate result', checklistItemIds: [] },
  }));
  const final = await request(flow); assert.equal(final.finalDatasheetId, added.datasheetId); assert.equal(final.datasheetId, added.datasheetId);
  assert.equal((await runtime(flow.sheet.id)).datasheet.status, 'in_progress'); assert.equal((await runtime(added.datasheetId)).datasheet.status, 'approved');
  await assert.rejects(remove(flow, flow.sheet.id, final.revision), { code: 'test_request_closed' });
  await assert.rejects(add(flow, randomUUID(), final.revision), { code: 'test_request_closed' });
  const generated = await work(analyst, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const report = await work(analyst, (client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true });
  assert.equal(report.results[0].submissionId, submitted.submissionId); assert.equal(report.results[0].methodName, method.name);
  assert.equal(report.results[0].finalResult, '0'); assert.equal(report.results[0].decisionOutcome, 'Within synthetic limit');
});

test('configured sample workflow gates both method mutations and direct capture writes', async () => {
  const flow = await prepare({ sampleCanWork: false, printRoleId: analyst.roleId });
  const method = await createAlternateMethod(owner, analyst, flow.fixture);
  const loaded = await runtime(flow.sheet.id);
  assert.equal(loaded.canExecute, false); assert.equal((await request(flow)).canChangeMethods, false);
  await assert.rejects(add(flow, method.id), { code: 'method_change_denied' });
  await assert.rejects(enter(flow.sheet.id, '0'), { code: 'capture_write_denied' });
  await work(analyst, async (client, identity) => {
    await client.query("SELECT set_config('app.capture_id',$1,true)", [flow.sheet.template_instance_id]);
    const bypass = await client.query('UPDATE template_instances SET revision=revision+1 WHERE organization_id=$1 AND id=$2', [identity.organization_id, flow.sheet.template_instance_id]);
    assert.equal(bypass.rowCount, 0);
  });
});

test('direct inserts cannot bind an alternate method to another request template or bypass assigned-analyst access', async () => {
  const flow = await prepare(); const other = await prepare();
  const method = await createAlternateMethod(owner, analyst, flow.fixture);
  const wrongTemplate = await runtime(other.sheet.id);
  await assert.rejects(work(manager, (client) => client.query('SELECT laboratory_snapshot_method($1,$2)', [flow.requestId, method.id])), { code: '42501' });
  await assert.rejects(work(analyst, async (client, identity) => {
    const snapshot = (await client.query('SELECT laboratory_snapshot_method($1,$2) AS id', [flow.requestId, method.id])).rows[0];
    const capture = await createWorkflowCapture(client, identity, wrongTemplate.model.version.id);
    await client.query(`INSERT INTO datasheets(organization_id,test_request_id,template_instance_id,specification_id,method_id,attempt_number,created_by)
      VALUES($1,$2,$3,$4,$5,2,$6)`, [identity.organization_id, flow.requestId, capture.instanceId, snapshot.id, method.id, identity.user_id]);
  }), { code: '23514' });
  assert.equal((await request(flow)).datasheets.length, 1);
});

test('workflow cancellation retires every method with actual transition evidence; a forged cancelled status cannot bypass deletion gates', async () => {
  const flow = await prepare({ cancelTestRequest: true });
  const method = await createAlternateMethod(owner, analyst, flow.fixture);
  const added = await add(flow, method.id);
  await assert.rejects(work(manager, async (client, identity) => {
    await client.query("UPDATE test_requests SET status='cancelled',revision=revision+1 WHERE organization_id=$1 AND id=$2", [identity.organization_id, flow.requestId]);
    await client.query("UPDATE datasheets SET status='void',revision=revision+1 WHERE organization_id=$1 AND test_request_id=$2", [identity.organization_id, flow.requestId]);
  }), { code: '23514' });
  const entered = await enter(added.datasheetId, '0');
  const current = await request(flow);
  const run = await work(analyst, (client, identity) => loadWorkflowRun(client, identity, current.workflowRunId), { readOnly: true });
  await work(analyst, (client, identity) => submitDatasheetTransition(client, identity, run.id, {
    datasheetId: added.datasheetId, datasheet: { revision: 1, captureRevision: entered.saved.revision },
    transition: { revision: run.revision, transitionId: run.transitions.find((item) => item.targetStateName === 'Cancelled').id, comment: 'Synthetic cancellation', checklistItemIds: [] },
  }));
  assert.equal((await request(flow)).status, 'cancelled');
  for (const id of [flow.sheet.id, added.datasheetId]) {
    const sheet = await runtime(id); assert.equal(sheet.datasheet.status, 'void'); assert.equal(sheet.canExecute, false);
  }
  const history = (await owner.query("SELECT actor_user_id,comment FROM workflow_run_history WHERE organization_id=$1 AND workflow_run_id=$2 AND action='cancelled'", [analyst.organizationId, run.id])).rows;
  assert.deepEqual(history, [{ actor_user_id: analyst.userId, comment: 'Synthetic cancellation' }]);
});
