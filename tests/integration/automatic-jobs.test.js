import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { prepareSubjectJob } from '../helpers/job-subjects.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest, initializeGeneratedRequest } from '../../src/test-requests/allocate.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { resolveCaptureVersion } from '../../src/templates/snapshots.js';

const owner = ownerPool(); let admin; let creator; let manager; let foreign;
const work = (user, callback) => withSession(user.token, callback, { csrfToken: user.csrfToken });
const sqlError = (code) => (error) => (error.cause ?? error).code === code;
before(async () => {
  admin = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'templates.manage', 'settings.manage'] });
  creator = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['samples.create'] });
  manager = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['samples.manage'] });
  foreign = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'test_requests.allocate'] });
  for (const user of [admin, creator, manager, foreign]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

async function configure(templateId, enabled = true) {
  const { settings } = await work(admin, loadLaboratorySettings);
  await work(admin, (client, identity) => saveLaboratorySettings(client, identity,
    { revision: settings.revision, autoCreateJobs: enabled, resultSummaryTemplateId: templateId, jobWorkflowId: null }));
}
const records = async (sampleId) => (await owner.query(`SELECT request.*,context.sample_product_id,context.sample_id,
  assignment.assigned_user_id,sheet.id AS datasheet_id,sheet.template_instance_id,capture.created_by AS capture_creator,
  capture.status AS capture_status,run.id AS workflow_run_id,run.started_by AS workflow_actor
  FROM test_requests request JOIN laboratory_test_request_context context ON context.organization_id=request.organization_id AND context.test_request_id=request.id
  LEFT JOIN test_request_assignments assignment ON assignment.organization_id=request.organization_id AND assignment.test_request_id=request.id AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL
  LEFT JOIN datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.test_request_id=request.id AND sheet.attempt_number=1
  LEFT JOIN template_instances capture ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id
  LEFT JOIN workflow_runs run ON run.organization_id=request.organization_id AND run.test_request_id=request.id
  WHERE request.organization_id=$1 AND context.sample_id=$2 ORDER BY request.is_job,context.sample_product_id`, [admin.organizationId, sampleId])).rows;

test('registration-only actors initialize their new children while automatic jobs await explicit allocation', async () => {
  const configured = await prepareSubjectJob(owner, admin, admin);
  const source = await createLaboratoryFixture(owner, admin, { generateTestRequests: true, repeated: false, template: configured.template });
  await configure(source.template.templateId);
  const fallbackProduct = structuredClone(source.registration.products[0]);
  fallbackProduct.tests[0].decisionRuleId = null;
  const sample = await work(creator, (client, identity) => registerSample(client, identity, { ...source.registration,
    products: [source.registration.products[0], fallbackProduct] }));
  const all = await records(sample.id); const jobs = all.filter((row) => row.is_job); const children = all.filter((row) => !row.is_job);
  assert.equal(jobs.length, 2); assert.equal(children.length, 2);
  for (const row of children) {
    assert.equal(row.status, 'allocated'); assert.equal(row.assigned_user_id, creator.userId);
    assert.equal(row.capture_creator, creator.userId); assert.equal(row.capture_status, 'editing'); assert.equal(row.workflow_actor, creator.userId);
    assert.ok(row.datasheet_id); assert.ok(row.workflow_run_id); assert.equal(row.job_member_position, 0);
    assert.ok(sample.testRequests.some((request) => request.id === row.id && request.datasheetId === row.datasheet_id));
    const subject = (await owner.query('SELECT test_request_id,specification_id,created_by FROM datasheet_subjects WHERE organization_id=$1 AND datasheet_id=$2', [admin.organizationId, row.datasheet_id])).rows;
    assert.equal(subject.length, 1); assert.equal(subject[0].test_request_id, row.id); assert.equal(subject[0].specification_id, row.specification_id); assert.equal(subject[0].created_by, creator.userId);
  }
  for (const row of jobs) {
    assert.equal(row.is_auto_created, true); assert.equal(row.status, 'created'); assert.equal(row.revision, 1);
    assert.equal(row.assigned_user_id, null); assert.equal(row.datasheet_id, null); assert.equal(row.workflow_run_id, null);
  }
  await assert.rejects(work(creator, (client, identity) => allocateTestRequest(client, identity, jobs[0].id,
    { revision: 1, assignmentType: 'analyst', assignedUserId: creator.userId })), { code: 'forbidden' });
  const allocated = await work(admin, (client, identity) => allocateTestRequest(client, identity, jobs[0].id,
    { revision: 1, assignmentType: 'analyst', assignedUserId: admin.userId }));
  assert.ok(allocated.datasheetId); assert.ok(allocated.workflowRunId);
  const after = await records(sample.id);
  for (const child of children) {
    const current = after.find((row) => row.id === child.id);
    assert.equal(current.assigned_user_id, creator.userId); assert.equal(current.datasheet_id, child.datasheet_id); assert.equal(current.workflow_run_id, child.workflow_run_id);
  }
});

test('manual generation by a manager creates automatic jobs once and retains product grouping and exact due dates', async () => {
  const source = await createLaboratoryFixture(owner, admin, { repeated: false }); await configure(source.template.templateId);
  const sample = await work(creator, (client, identity) => registerSample(client, identity, source.registration));
  await owner.query("UPDATE samples SET due_at='2026-09-14 05:00:00.123456+00',revision=revision+1 WHERE organization_id=$1 AND id=$2", [admin.organizationId, sample.id]);
  const generated = await work(manager, (client, identity) => generateTestRequests(client, identity, sample.id));
  assert.equal(generated.jobs.length, 1); assert.equal(generated.items.length, 1);
  const all = await records(sample.id); const child = all.find((row) => !row.is_job); const job = all.find((row) => row.is_job);
  assert.equal(child.assigned_user_id, manager.userId); assert.equal(job.created_by, manager.userId);
  const exact = (await owner.query("SELECT due_at::text AS due FROM test_requests WHERE organization_id=$1 AND id=$2", [admin.organizationId, job.id])).rows[0];
  assert.match(exact.due, /00\.123456/);
  const replay = await work(manager, (client, identity) => generateTestRequests(client, identity, sample.id));
  assert.deepEqual(replay, { items: [], jobs: [] }); assert.equal((await records(sample.id)).length, 2);
});

test('disabled or unavailable summary configuration leaves newly generated requests ungrouped', async () => {
  for (const state of ['disabled', 'missing', 'inactive']) {
    const source = await createLaboratoryFixture(owner, admin, { repeated: false });
    await configure(state === 'missing' ? null : source.template.templateId, state !== 'disabled');
    if (state === 'inactive') await owner.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=$2', [admin.organizationId, source.template.templateId]);
    const sample = await work(creator, (client, identity) => registerSample(client, identity, source.registration));
    const generated = await work(manager, (client, identity) => generateTestRequests(client, identity, sample.id));
    assert.equal(generated.jobs.length, 0); assert.equal(generated.items.length, 1);
    const [request] = await records(sample.id);
    assert.equal(request.status, 'created'); assert.equal(request.parent_test_request_id, null); assert.equal(request.datasheet_id, null);
  }
});

test('automatic initialization cannot be replayed with context flags or cross-tenant request IDs', async () => {
  const source = await createLaboratoryFixture(owner, admin, { repeated: false }); await configure(source.template.templateId);
  const sample = await work(creator, (client, identity) => registerSample(client, identity, source.registration));
  const generated = await work(manager, (client, identity) => generateTestRequests(client, identity, sample.id));
  const requestId = generated.items[0].id;
  for (const user of [creator, manager, foreign]) {
    await assert.rejects(work(user, (client) => client.query('SELECT * FROM laboratory_start_auto_job($1::uuid[])', [[requestId]])), sqlError('42501'));
    await assert.rejects(work(user, async (client, identity) => {
      await client.query("SELECT set_config('app.auto_job_request_id',$1,true)", [requestId]);
      return initializeGeneratedRequest(client, identity, requestId);
    }), { code: 'automatic_job_required' });
  }
  await assert.rejects(work(creator, (client, identity) => resolveCaptureVersion(client, identity, source.template.templateId, { kind: 'datasheet' })), { code: 'forbidden' });
  const leaked = await work(creator, (client) => client.query('SELECT id FROM datasheets WHERE organization_id=$1 AND test_request_id=$2', [admin.organizationId, requestId]));
  assert.equal(leaked.rowCount, 0);
});

test('a child initialization failure rolls back requests, jobs, assignments, captures and generation evidence', async () => {
  const source = await createLaboratoryFixture(owner, admin, { repeated: false }); await configure(source.template.templateId);
  const sample = await work(creator, (client, identity) => registerSample(client, identity, { ...source.registration,
    products: [source.registration.products[0], structuredClone(source.registration.products[0])] }));
  const before = (await owner.query('SELECT count(*)::integer AS count FROM template_instances WHERE organization_id=$1', [admin.organizationId])).rows[0].count;
  await assert.rejects(work(manager, async (client, identity) => {
    const query = client.query; let initialized = 0;
    client.query = (...args) => {
      const statement = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (statement.includes('laboratory_finish_auto_job_member') && ++initialized === 2) throw new Error('Synthetic automatic child interruption');
      return query.apply(client, args);
    };
    try { return await generateTestRequests(client, identity, sample.id); } finally { client.query = query; }
  }), /Synthetic automatic child interruption/);
  assert.deepEqual(await records(sample.id), []);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM template_instances WHERE organization_id=$1', [admin.organizationId])).rows[0].count, before);
  assert.equal((await owner.query("SELECT id FROM sample_events WHERE organization_id=$1 AND sample_id=$2 AND event_type<>'sample_registered'", [admin.organizationId, sample.id])).rowCount, 0);
  assert.equal((await work(manager, (client, identity) => generateTestRequests(client, identity, sample.id))).jobs.length, 2);
});
