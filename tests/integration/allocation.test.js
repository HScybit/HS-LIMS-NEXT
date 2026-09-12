import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { createAlternateMethod } from '../helpers/methods.js';
import { addTestRequestMethod, deleteTestRequestMethod } from '../../src/test-requests/methods.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';
import { saveCapture, recalculateCapture } from '../../src/templates/capture.js';
import { loadCapture, loadDefinition } from '../../src/templates/loader.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { loadTestRequest } from '../../src/test-requests/load.js';

const owner = ownerPool();
let author; let registrar; let allocator; let analyst; let replacement; let reader; let foreign;
before(async () => {
  author = await createAccount(owner, { permissions: ['templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  Object.assign(author, await signIn({ identifier: author.username, password: author.password }));
  const users = [];
  for (const permissions of [['samples.create'], ['test_requests.allocate'], ['datasheets.execute'], ['datasheets.execute'], ['samples.read']]) {
    const account = await createAccount(owner, { organizationId: author.organizationId, permissions });
    users.push({ ...account, ...await signIn({ identifier: account.username, password: account.password }) });
  }
  [registrar, allocator, analyst, replacement, reader] = users;
  const account = await createAccount(owner, { permissions: ['test_requests.allocate', 'datasheets.execute'] });
  foreign = { ...account, ...await signIn({ identifier: account.username, password: account.password }) };
});
after(async () => { await closePool(); await owner.end(); });
const work = (session, action, options = {}) => withSession(session.token, action, { csrfToken: session.csrfToken, ...options });
async function prepare(options) {
  const fixture = await createLaboratoryFixture(owner, author, options);
  const sample = await work(registrar, (client, identity) => registerSample(client, identity, fixture.registration));
  const requests = await work(allocator, (client, identity) => generateTestRequests(client, identity, sample.id));
  return { ...fixture, sample, requestId: requests.items[0].id };
}
const allocate = (requestId, revision = 1, assigned = analyst, type = 'analyst', session = allocator) => work(session,
  (client, identity) => allocateTestRequest(client, identity, requestId, { revision, assignmentType: type, assignedUserId: assigned.userId }));
const read = (instanceId, atRevision) => work(reader, (client, identity) => loadCapture(client, identity.organization_id, instanceId, atRevision), { readOnly: true });
async function sheet(id) { return (await owner.query('SELECT * FROM datasheets WHERE organization_id=$1 AND id=$2', [author.organizationId, id])).rows[0]; }

test('allocation pins a draft snapshot and scientific specification, preserves actual actors and gives only the analyst capture access', async () => {
  const fixture = await prepare();
  const allocated = await allocate(fixture.requestId);
  assert.equal(allocated.status, 'allocated'); assert.equal(allocated.revision, 2);
  assert.ok(allocated.workflowRunId);
  const stored = await sheet(allocated.datasheetId);
  assert.equal(stored.created_by, allocator.userId);
  const request = (await owner.query('SELECT * FROM test_requests WHERE organization_id=$1 AND id=$2', [author.organizationId, fixture.requestId])).rows[0];
  assert.equal(stored.specification_id, request.specification_id);
  const capture = await read(stored.template_instance_id);
  const definition = await work(reader, (client, identity) => loadDefinition(client, identity.organization_id, capture.instance.version_id), { readOnly: true });
  assert.equal(definition.model.version.status, 'frozen');
  assert.equal(definition.model.version.snapshotSourceId, fixture.template.versionId);
  const raw = fixture.template.records.fields[0];
  const occurrence = capture.occurrences.find((row) => row.groupId === raw.repeatGroupId);
  const value = [{ fieldId: raw.id, occurrenceId: occurrence.id, state: 'present', value: '0' }];
  const save = (session, rev = 1) => work(session, (client, identity) => saveCapture(client, identity, stored.template_instance_id, rev, value));
  for (const session of [allocator, replacement, foreign, reader]) await assert.rejects(save(session), { status: 403 });
  const saved = await save(analyst);
  assert.equal(saved.revision, 2);
  assert.equal(saved.values.find((item) => item.fieldId === raw.id && item.occurrenceId === occurrence.id).numberValue, '0');
  const reloaded = await read(stored.template_instance_id);
  assert.equal(reloaded.values.find((item) => item.fieldId === raw.id && item.occurrenceId === occurrence.id).savedBy, analyst.userId);
  assert.equal((await read(stored.template_instance_id, 1)).values.some((item) => item.fieldId === raw.id), false);
  await assert.rejects(save(analyst), { code: 'stale_capture' });
  await work(author, (client, identity) => editTemplate(client, identity, fixture.template.versionId, 1,
    { type: 'configureField', columnId: raw.columnId, widget: raw.widget, alias: raw.alias, label: 'New draft label', required: false }));
  const historical = await work(reader, (client, identity) => loadDefinition(client, identity.organization_id, capture.instance.version_id), { readOnly: true });
  assert.equal(historical.model.fieldsById[raw.id].label, raw.label);
});

test('reassignment serializes revisions, reuses the existing datasheet and immediately removes the previous analyst write access', async () => {
  const fixture = await prepare();
  const allocated = await allocate(fixture.requestId);
  const results = await Promise.allSettled([allocate(fixture.requestId, 2, replacement), allocate(fixture.requestId, 2, replacement)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'stale_test_request');
  const reassigned = results.find((result) => result.status === 'fulfilled').value;
  assert.equal(reassigned.datasheetId, allocated.datasheetId); assert.equal(reassigned.workflowRunId, allocated.workflowRunId);
  const assignments = (await owner.query('SELECT * FROM test_request_assignments WHERE organization_id=$1 AND test_request_id=$2 ORDER BY assigned_at', [author.organizationId, fixture.requestId])).rows;
  assert.equal(assignments.length, 2); assert.ok(assignments[0].unassigned_at); assert.equal(assignments[1].unassigned_at, null);
  assert.equal(assignments[1].assigned_by, allocator.userId);
  const stored = await sheet(allocated.datasheetId); const capture = await read(stored.template_instance_id);
  const raw = fixture.template.records.fields[0]; const occurrence = capture.occurrences.find((row) => row.groupId === raw.repeatGroupId);
  const value = [{ fieldId: raw.id, occurrenceId: occurrence.id, state: 'present', value: '7.5' }];
  await assert.rejects(work(analyst, (client, identity) => saveCapture(client, identity, stored.template_instance_id, 1, value)), { code: 'capture_write_denied' });
  await work(replacement, (client, identity) => saveCapture(client, identity, stored.template_instance_id, 1, value));
  const method = await createAlternateMethod(owner, author, fixture);
  const added = await work(replacement, (client, identity) => addTestRequestMethod(client, identity, fixture.requestId, { revision: 3, methodId: method.id }));
  await work(replacement, (client, identity) => deleteTestRequestMethod(client, identity, fixture.requestId, stored.id, { revision: added.revision }));
  await assert.rejects(work(replacement, (client, identity) => saveCapture(client, identity, stored.template_instance_id, 2, value)), { code: 'capture_write_denied' });
});

test('reviewers do not create captures, conflicts/inactive users/closed requests and tenant or permission attacks are rejected', async () => {
  const fixture = await prepare();
  const reviewer = await allocate(fixture.requestId, 1, analyst, 'reviewer');
  assert.equal(reviewer.datasheetId, null); assert.equal(reviewer.workflowRunId, null); assert.equal(reviewer.status, 'created');
  await assert.rejects(allocate(fixture.requestId, 2, analyst), { code: 'allocation_role_conflict' });
  await assert.rejects(allocate(fixture.requestId, 2, foreign), { code: 'invalid_assignee' });
  const inactive = await createAccount(owner, { organizationId: author.organizationId });
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [author.organizationId, inactive.userId]);
  await assert.rejects(allocate(fixture.requestId, 2, inactive), { code: 'invalid_assignee' });
  await assert.rejects(allocate(fixture.requestId, 2, replacement, 'analyst', foreign), { status: 404 });
  await assert.rejects(allocate(fixture.requestId, 2, replacement, 'analyst', reader), { status: 403 });
  const allocated = await allocate(fixture.requestId, 2, replacement);
  assert.equal(allocated.revision, 3);
  const finalApprover = await allocate(fixture.requestId, 3, replacement, 'final_approver');
  assert.equal(finalApprover.revision, 4);
  await owner.query("UPDATE test_requests SET status='cancelled', revision=revision+1 WHERE organization_id=$1 AND id=$2", [author.organizationId, fixture.requestId]);
  await assert.rejects(allocate(fixture.requestId, 5), { code: 'test_request_closed' });
});

test('missing template rolls back assignments and request revision; category fallback is selected once at allocation', async () => {
  const fixture = await createLaboratoryFixture(owner, author);
  fixture.registration.products[0].tests[0].decisionRuleId = null;
  const sample = await work(registrar, (client, identity) => registerSample(client, identity, fixture.registration));
  const requests = await work(allocator, (client, identity) => generateTestRequests(client, identity, sample.id));
  const requestId = requests.items[0].id;
  await owner.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=$2', [author.organizationId, fixture.template.templateId]);
  await assert.rejects(allocate(requestId), { code: 'datasheet_template_not_configured' });
  const unchanged = (await owner.query(`SELECT revision, status, (SELECT count(*) FROM test_request_assignments WHERE organization_id=$1 AND test_request_id=$2) AS assignment_count
    FROM test_requests WHERE organization_id=$1 AND id=$2`, [author.organizationId, requestId])).rows[0];
  assert.deepEqual(unchanged, { revision: 1, status: 'created', assignment_count: '0' });
  await owner.query('UPDATE templates SET active=true WHERE organization_id=$1 AND id=$2', [author.organizationId, fixture.template.templateId]);
  const allocated = await allocate(requestId);
  assert.ok(allocated.datasheetId);
  const selected = (await owner.query('SELECT datasheet_template_id FROM test_requests WHERE organization_id=$1 AND id=$2', [author.organizationId, requestId])).rows[0];
  assert.equal(selected.datasheet_template_id, fixture.template.templateId);
  await assert.rejects(owner.query('UPDATE test_requests SET revision=revision+1, datasheet_template_id=NULL WHERE organization_id=$1 AND id=$2', [author.organizationId, requestId]), { code: '23514' });
});

test('datasheet reads use one metadata plus eight definition and three capture queries, with tenant/history/approval access enforced', async () => {
  const fixture = await prepare(); const allocated = await allocate(fixture.requestId);
  await work(analyst, async (client, identity) => {
    const query = client.query; const statements = [];
    client.query = function (...args) { statements.push(typeof args[0] === 'string' ? args[0] : args[0].text); return query.apply(this, args); };
    try {
      const result = await loadDatasheet(client, identity, allocated.datasheetId, { sampleId: fixture.sample.id });
      assert.equal(statements.length, 12); assert.ok(statements.every((statement) => /^(select|with)\b/i.test(statement) && !/\b(insert|update|delete)\b/i.test(statement)));
      assert.equal(result.canExecute, true); assert.equal(result.metrics.definition.queryCount, 8); assert.equal(result.metrics.capture.queryCount, 3);
      assert.equal(result.datasheet.methodName, fixture.method.name);
    } finally { client.query = query; }
  }, { readOnly: true });
  const approver = await createAccount(owner, { organizationId: author.organizationId, permissions: ['approvals.respond'] });
  Object.assign(approver, await signIn({ identifier: approver.username, password: approver.password }));
  const view = (session, options) => work(session, (client, identity) => loadDatasheet(client, identity, allocated.datasheetId, options), { readOnly: true });
  for (const session of [reader, approver, replacement, allocator]) assert.equal((await view(session)).canExecute, false);
  assert.equal((await view(analyst, { atRevision: 1 })).canExecute, false);
  await assert.rejects(view(analyst, { atRevision: 2 }), { code: 'invalid_revision' });
  await assert.rejects(view(foreign), { code: 'datasheet_not_found' });
  await assert.rejects(view(analyst, { sampleId: fixture.product.id }), { code: 'datasheet_not_found' });
  const stored = await sheet(allocated.datasheetId);
  await assert.rejects(work(replacement, (client, identity) => recalculateCapture(client, identity, stored.template_instance_id, 1)), { code: 'capture_write_denied' });
  const calculated = await work(analyst, (client, identity) => recalculateCapture(client, identity, stored.template_instance_id, 1));
  assert.equal(calculated.revision, 2);
  assert.ok(calculated.values.some((value) => value.state === 'invalid'));
  assert.equal((await sheet(allocated.datasheetId)).status, 'in_progress');
  const request = await work(reader, (client, identity) => loadTestRequest(client, identity, fixture.requestId, fixture.sample.id), { readOnly: true });
  assert.equal(request.datasheetId, allocated.datasheetId); assert.equal(request.activity.length, 1);
  assert.equal(request.activity[0].actorUserId, allocator.userId); assert.equal(request.activity[0].actorName, 'Synthetic Analyst');
  assert.equal(request.assignments[0].assignedUserName, 'Synthetic Analyst');
  const foreignLabel = await work(reader, (client) => client.query('SELECT * FROM laboratory_actor_labels($1::uuid[])', [[foreign.userId]]), { readOnly: true });
  assert.equal(foreignLabel.rowCount, 0);
  await assert.rejects(work(foreign, (client, identity) => loadTestRequest(client, identity, fixture.requestId)), { code: 'test_request_not_found' });
  await owner.query("UPDATE test_requests SET status='cancelled', revision=revision+1 WHERE organization_id=$1 AND id=$2", [author.organizationId, fixture.requestId]);
  assert.equal((await view(analyst)).canExecute, false);
  await assert.rejects(work(analyst, (client, identity) => recalculateCapture(client, identity, stored.template_instance_id, 2)), { code: 'capture_write_denied' });
});
