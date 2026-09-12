import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { createTestRequestJobs } from '../../src/test-requests/jobs.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { loadTestRequest } from '../../src/test-requests/load.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { sampleTestRequests, allocationOptions } from '../../src/test-requests/listing.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';

const owner = ownerPool(); let creator; let analyst; let reviewer; let reader; let foreign;
const work = (user, callback, options = {}) => withSession(user.token, callback, { csrfToken: user.csrfToken, ...options });
async function account(options) {
  const user = await createAccount(owner, options);
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
before(async () => {
  creator = await account({ permissions: ['samples.create', 'samples.manage', 'test_requests.allocate', 'templates.manage', 'settings.manage'] });
  analyst = await account({ organizationId: creator.organizationId, permissions: ['datasheets.execute'] });
  reviewer = await account({ organizationId: creator.organizationId, permissions: ['approvals.respond'] });
  reader = await account({ organizationId: creator.organizationId, permissions: ['settings.read'] });
  foreign = await account({ permissions: ['test_requests.allocate', 'settings.manage'] });
});
after(async () => { await closePool(); await owner.end(); });
async function prepare({ products = 1, parameters = 1, configure = true } = {}) {
  const source = await createLaboratoryFixture(owner, creator, { repeated: false });
  if (parameters > 1) {
    const code = randomUUID();
    const parameter = (await owner.query(`INSERT INTO test_parameters(organization_id,code,name,master_key,scheme_abbreviation,measurement_unit_id)
      VALUES($1,$2,'Second synthetic job parameter',$2,$2,$3) RETURNING id`, [creator.organizationId, code, source.unit.id])).rows[0];
    await owner.query('INSERT INTO parameter_methods(organization_id,test_parameter_id,method_id,is_default) VALUES($1,$2,$3,true)',
      [creator.organizationId, parameter.id, source.method.id]);
    source.registration.products[0].tests.push({ ...source.registration.products[0].tests[0], testParameterId: parameter.id, decisionRuleId: null });
  }
  if (configure) {
    const current = await work(creator, loadLaboratorySettings, { readOnly: true });
    await work(creator, (client, identity) => saveLaboratorySettings(client, identity, { revision: current.settings.revision,
      autoCreateJobs: false, resultSummaryTemplateId: source.template.templateId, jobWorkflowId: null }));
  }
  const sample = await work(creator, (client, identity) => registerSample(client, identity, { ...source.registration,
    products: Array.from({ length: products }, () => structuredClone(source.registration.products[0])) }));
  const generated = await work(creator, (client, identity) => generateTestRequests(client, identity, sample.id));
  return { source, sample, requests: generated.items };
}
const create = (flow, options = {}, user = creator) => work(user, (client, identity) => createTestRequestJobs(client, identity,
  { requestIds: flow.requests.map((request) => request.id), analystUserId: analyst.userId, reviewerUserId: reviewer.userId, ...options }));

test('job settings are tenant scoped, require management access, validate references and serialize first creation', async () => {
  const source = await createLaboratoryFixture(owner, creator);
  const initial = await work(reader, loadLaboratorySettings, { readOnly: true });
  assert.equal(initial.settings.revision, 0); assert.equal(initial.canManage, false);
  assert.ok(initial.templates.some((row) => row.id === source.template.templateId));
  const input = { revision: 0, autoCreateJobs: false, resultSummaryTemplateId: source.template.templateId, jobWorkflowId: null };
  await assert.rejects(work(reader, (client, identity) => saveLaboratorySettings(client, identity, input)), { code: 'forbidden' });
  await assert.rejects(work(foreign, (client, identity) => saveLaboratorySettings(client, identity, input)), { code: 'invalid_job_template' });
  const raced = await Promise.allSettled([1, 2].map(() => work(creator, (client, identity) => saveLaboratorySettings(client, identity, input))));
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.find((result) => result.status === 'rejected').reason.code, 'stale_settings');
});

test('manual jobs group by product line, retain individual specifications and initialize assigned child and summary captures', async () => {
  const flow = await prepare({ products: 2, parameters: 2 });
  const jobs = await create(flow);
  assert.equal(jobs.items.length, 2);
  for (const job of jobs.items) {
    assert.equal(job.memberCount, 2); assert.match(job.requestNumber, /^JOB-\d{4}-\d{4,}$/);
    const record = await work(analyst, (client, identity) => loadTestRequest(client, identity, job.id), { readOnly: true });
    assert.equal(record.isJob, true); assert.equal(record.canChangeMethods, false); assert.ok(record.workflowRunId);
    const sheet = await work(analyst, (client, identity) => loadDatasheet(client, identity, job.datasheetId), { readOnly: true });
    assert.equal(sheet.datasheet.isJob, true); assert.equal(sheet.canExecute, true); assert.equal(sheet.metrics.definition.queryCount, 8);
    const members = (await owner.query(`SELECT request.*,context.sample_product_id FROM test_requests request
      JOIN laboratory_test_request_context context ON context.organization_id=request.organization_id AND context.test_request_id=request.id
      WHERE request.organization_id=$1 AND request.parent_test_request_id=$2 ORDER BY request.job_member_position`, [creator.organizationId, job.id])).rows;
    assert.deepEqual(members.map((member) => member.job_member_position), [0, 1]);
    assert.equal(new Set(members.map((member) => member.sample_product_id)).size, 1);
    for (const member of members) {
      assert.equal(member.job_linked_by, creator.userId); assert.ok(member.job_linked_at);
      assert.ok(member.specification_id); assert.ok(member.sample_test_id); assert.equal(member.is_job, false);
      const child = await work(analyst, (client, identity) => loadTestRequest(client, identity, member.id), { readOnly: true });
      assert.ok(child.datasheetId); assert.ok(child.workflowRunId); assert.equal(child.parentTestRequestId, job.id);
      assert.equal(child.canChangeMethods, true);
    }
    const stored = (await owner.query('SELECT specification_id,sample_test_id FROM test_requests WHERE organization_id=$1 AND id=$2', [creator.organizationId, job.id])).rows[0];
    assert.deepEqual(stored, { specification_id: null, sample_test_id: null });
    const event = (await owner.query("SELECT actor_user_id,description FROM sample_events WHERE organization_id=$1 AND test_request_id=$2 AND event_type='test_request_job_created'", [creator.organizationId, job.id])).rows[0];
    assert.equal(event.actor_user_id, creator.userId); assert.equal(event.description, 'Created job with 2 test requests.');
  }
});

test('empty, duplicated, mixed-sample, foreign and already grouped selections cannot create partial jobs', async () => {
  const first = await prepare(); const second = await prepare();
  await assert.rejects(create(first, { requestIds: [] }), { code: 'invalid_job_selection' });
  await assert.rejects(create(first, { requestIds: [first.requests[0].id, first.requests[0].id] }), { code: 'duplicate_job_selection' });
  await assert.rejects(create(first, { requestIds: [first.requests[0].id, second.requests[0].id] }), { code: 'job_sample_mismatch' });
  await assert.rejects(create(first, {}, foreign), { code: 'test_request_not_available' });
  await assert.rejects(create(first, {}, analyst), { code: 'forbidden' });
  await assert.rejects(create(first, { reviewerUserId: analyst.userId }), { code: 'allocation_role_conflict' });
  await assert.rejects(create(first, { analystUserId: foreign.userId }), { code: 'invalid_assignee' });
  const raced = await Promise.allSettled([create(first), create(first)]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.find((result) => result.status === 'rejected').reason.code, 'test_request_not_available');
  assert.equal((await owner.query(`SELECT count(*)::integer AS count FROM test_requests request JOIN laboratory_test_request_context context
    ON context.organization_id=request.organization_id AND context.test_request_id=request.id WHERE request.organization_id=$1 AND context.sample_id=$2 AND request.is_job`,
  [creator.organizationId, first.sample.id])).rows[0].count, 1);
});

test('an unavailable job template and a failed transaction leave requests ungrouped without invented job events', async () => {
  const flow = await prepare();
  const settings = await work(creator, loadLaboratorySettings, { readOnly: true });
  await work(creator, (client, identity) => saveLaboratorySettings(client, identity, { revision: settings.settings.revision,
    autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null }));
  await assert.rejects(create(flow), { code: 'job_template_not_configured' });
  const after = await work(creator, loadLaboratorySettings, { readOnly: true });
  await work(creator, (client, identity) => saveLaboratorySettings(client, identity, { revision: after.settings.revision,
    autoCreateJobs: false, resultSummaryTemplateId: flow.source.template.templateId, jobWorkflowId: null }));
  await assert.rejects(work(creator, async (client, identity) => {
    await createTestRequestJobs(client, identity, { requestIds: flow.requests.map((request) => request.id), analystUserId: analyst.userId });
    throw new Error('Synthetic job failure');
  }), /Synthetic job failure/);
  const request = (await owner.query('SELECT parent_test_request_id,status,revision FROM test_requests WHERE organization_id=$1 AND id=$2', [creator.organizationId, flow.requests[0].id])).rows[0];
  assert.deepEqual(request, { parent_test_request_id: null, status: 'created', revision: 1 });
  assert.equal((await owner.query("SELECT count(*)::integer AS count FROM sample_events WHERE organization_id=$1 AND sample_id=$2 AND event_type='test_request_job_created'", [creator.organizationId, flow.sample.id])).rows[0].count, 0);
});

test('job defaults freeze independently, reassignment retains child ownership, and workload includes jobs', async () => {
  const flow = await prepare({ parameters: 2 });
  const alternate = await createLaboratoryFixture(owner, creator, { repeated: false });
  const alternateWorkflow = alternate.workflowRecords.find((record) => record.workflow.appliesTo === 'test_request');
  const settings = await work(creator, loadLaboratorySettings, { readOnly: true });
  await work(creator, (client, identity) => saveLaboratorySettings(client, identity, { revision: settings.settings.revision,
    autoCreateJobs: false, resultSummaryTemplateId: flow.source.template.templateId, jobWorkflowId: alternateWorkflow.workflow.id }));
  const job = (await create(flow)).items[0];
  const jobRun = (await owner.query('SELECT workflow_version_id FROM workflow_runs WHERE organization_id=$1 AND id=$2', [creator.organizationId, job.workflowRunId])).rows[0];
  assert.equal(jobRun.workflow_version_id, alternateWorkflow.version.id);
  const before = (await owner.query(`SELECT member.id,member.revision,run.workflow_version_id,assignment.id AS assignment_id FROM test_requests member
    JOIN workflow_runs run ON run.organization_id=member.organization_id AND run.test_request_id=member.id
    JOIN test_request_assignments assignment ON assignment.organization_id=member.organization_id AND assignment.test_request_id=member.id AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL
    WHERE member.organization_id=$1 AND member.parent_test_request_id=$2 ORDER BY member.id`, [creator.organizationId, job.id])).rows;
  assert.ok(before.every((member) => member.workflow_version_id === flow.source.workflowRecords.find((record) => record.workflow.appliesTo === 'test_request').version.id));
  const nextSettings = await work(creator, loadLaboratorySettings, { readOnly: true });
  await work(creator, (client, identity) => saveLaboratorySettings(client, identity, { revision: nextSettings.settings.revision,
    autoCreateJobs: false, resultSummaryTemplateId: alternate.template.templateId, jobWorkflowId: null }));
  const assigned = await work(creator, (client, identity) => allocateTestRequest(client, identity, job.id,
    { revision: job.revision, assignmentType: 'analyst', assignedUserId: creator.userId }));
  assert.equal(assigned.datasheetId, job.datasheetId); assert.equal(assigned.workflowRunId, job.workflowRunId);
  const after = (await owner.query(`SELECT member.id,member.revision,run.workflow_version_id,assignment.id AS assignment_id FROM test_requests member
    JOIN workflow_runs run ON run.organization_id=member.organization_id AND run.test_request_id=member.id
    JOIN test_request_assignments assignment ON assignment.organization_id=member.organization_id AND assignment.test_request_id=member.id AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL
    WHERE member.organization_id=$1 AND member.parent_test_request_id=$2 ORDER BY member.id`, [creator.organizationId, job.id])).rows;
  assert.deepEqual(after, before);
  const list = await work(creator, (client, identity) => sampleTestRequests(client, identity, flow.sample.id), { readOnly: true });
  assert.equal(list.rows.filter((row) => row.isJob).length, 1); assert.equal(list.rows.filter((row) => row.canJoinJob).length, 0);
  const counts = await work(creator, (client, identity) => allocationOptions(client, identity, job.id), { readOnly: true });
  const actual = (await owner.query(`SELECT count(*)::integer AS count FROM test_request_assignments assignment JOIN test_requests request
    ON request.organization_id=assignment.organization_id AND request.id=assignment.test_request_id
    WHERE assignment.organization_id=$1 AND assignment.assigned_user_id=$2 AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL
      AND request.status IN ('allocated','in_progress','under_review')`, [creator.organizationId, creator.userId])).rows[0].count;
  assert.equal(counts.users.find((user) => user.id === creator.userId).workload, actual);
});

test('job priority and earliest due date retain database precision, while incomplete grouping and forged events roll back', async () => {
  const flow = await prepare({ parameters: 2 });
  await owner.query("UPDATE test_requests SET priority='high',due_at='2026-09-14T10:30:00.000009Z',revision=revision+1 WHERE organization_id=$1 AND id=$2", [creator.organizationId, flow.requests[0].id]);
  await owner.query("UPDATE test_requests SET priority='urgent',due_at='2026-09-14T10:30:00.000001Z',revision=revision+1 WHERE organization_id=$1 AND id=$2", [creator.organizationId, flow.requests[1].id]);
  const job = (await create(flow)).items[0];
  const actual = (await owner.query(`SELECT priority,to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS due FROM test_requests WHERE organization_id=$1 AND id=$2`, [creator.organizationId, job.id])).rows[0];
  assert.deepEqual(actual, { priority: 'urgent', due: '2026-09-14T10:30:00.000001' });
  await assert.rejects(work(creator, (client) => client.query('UPDATE test_requests SET job_member_position=99,revision=revision+1 WHERE organization_id=$1 AND id=$2', [creator.organizationId, flow.requests[0].id])), { code: '42501' });
  await assert.rejects(work(creator, (client) => client.query(`INSERT INTO sample_events(organization_id,sample_id,test_request_id,event_type,actor_user_id,description)
    VALUES($1,$2,$3,'test_request_job_created',$4,'Forged job event')`, [creator.organizationId, flow.sample.id, job.id, creator.userId])), { code: '42501' });
  const ungrouped = await prepare();
  const incompleteId = randomUUID();
  await assert.rejects(work(creator, async (client) => {
    await client.query(`INSERT INTO test_requests(organization_id,id,request_number,is_job,job_sample_product_id,datasheet_template_id,created_by)
      SELECT $1,$2,$3,true,sample_product_id,$4,$5 FROM laboratory_test_request_context WHERE organization_id=$1 AND test_request_id=$6`,
    [creator.organizationId, incompleteId, `JOB-SYNTHETIC-${incompleteId}`, ungrouped.source.template.templateId, creator.userId, ungrouped.requests[0].id]);
    await client.query(`UPDATE test_requests SET parent_test_request_id=$3,job_member_position=0,job_linked_by=$4,job_linked_at=now(),revision=revision+1
      WHERE organization_id=$1 AND id=$2`, [creator.organizationId, ungrouped.requests[0].id, incompleteId, creator.userId]);
  }), { code: '23514' });
  assert.equal((await owner.query('SELECT id FROM test_requests WHERE organization_id=$1 AND id=$2', [creator.organizationId, incompleteId])).rowCount, 0);
  assert.equal((await owner.query('SELECT parent_test_request_id FROM test_requests WHERE organization_id=$1 AND id=$2', [creator.organizationId, ungrouped.requests[0].id])).rows[0].parent_test_request_id, null);
});
