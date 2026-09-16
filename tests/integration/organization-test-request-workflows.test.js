import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest, initializeGeneratedRequest } from '../../src/test-requests/allocate.js';
import { createTestRequestJobs } from '../../src/test-requests/jobs.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, publishWorkflow } from '../../src/workflows/authoring.js';
import { retireWorkflowMaster, updateWorkflowMaster } from '../../src/workflows/metadata.js';

const owner = ownerPool();
const work = (actor, callback) => withSession(actor.token, callback, { csrfToken: actor.csrfToken });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read', 'settings.manage', 'workflows.manage', 'test_requests.allocate', 'datasheets.execute'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function configure(actor, changes) {
  const { settings } = await work(actor, loadLaboratorySettings);
  return work(actor, (client, identity) => saveLaboratorySettings(client, identity, { revision: settings.revision,
    autoCreateJobs: settings.autoCreateJobs, resultSummaryTemplateId: settings.resultSummaryTemplateId,
    jobWorkflowId: settings.jobWorkflowId, testRequestWorkflowId: settings.testRequestWorkflowId, ...changes }));
}
async function snapshot(actor) {
  const result = {};
  for (const table of ['samples', 'sample_products', 'sample_tests', 'number_sequences', 'test_requests', 'test_request_assignments', 'datasheets',
    'template_instances', 'template_values', 'workflow_runs', 'workflow_run_history', 'sample_events']) {
    result[table] = (await owner.query(`SELECT count(*)::integer AS count,md5(string_agg(digest,'' ORDER BY digest)) AS digest
      FROM (SELECT md5(row_to_json(record)::text) AS digest FROM ${table} record WHERE organization_id=$1) rows`, [actor.organizationId])).rows[0];
  }
  return result;
}
async function selectedWorkflow(actor, requestId) {
  return (await owner.query(`SELECT version.workflow_id FROM workflow_runs run JOIN workflow_versions version
    ON version.organization_id=run.organization_id AND version.id=run.workflow_version_id
    WHERE run.organization_id=$1 AND run.test_request_id=$2`, [actor.organizationId, requestId])).rows[0]?.workflow_id ?? null;
}
async function generate(actor, fixture) {
  const sample = await work(actor, (client, identity) => registerSample(client, identity, fixture.registration));
  const generated = await work(actor, (client, identity) => generateTestRequests(client, identity, sample.id));
  return { sample, request: generated.items[0] };
}
const allocate = (actor, requestId, revision = 1) => work(actor, (client, identity) => allocateTestRequest(client, identity, requestId,
  { revision, assignmentType: 'analyst', assignedUserId: actor.userId }));
after(async () => { await closePool(); await owner.end(); });

test('new dynamic requests reject missing organization configuration and roll back the complete allocation', async () => {
  const actor = await account(); const fixture = await createLaboratoryFixture(owner, actor, { repeated: false });
  await configure(actor, { testRequestWorkflowId: null });
  const { request } = await generate(actor, fixture); const before = await snapshot(actor);
  assert.equal((await owner.query('SELECT using_dynamic_workflow FROM test_requests WHERE organization_id=$1 AND id=$2', [actor.organizationId, request.id])).rows[0].using_dynamic_workflow, true);
  await assert.rejects(allocate(actor, request.id), { code: 'test_request_workflow_not_configured' });
  assert.deepEqual(await snapshot(actor), before);
});

test('separate request and Job selections work without settings access or a category workflow', async () => {
  const manager = await account(); const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  const alternate = await createLaboratoryFixture(owner, manager, { repeated: false, configureSampleWorkflows: false });
  await configure(manager, { resultSummaryTemplateId: fixture.template.templateId, testRequestWorkflowId: alternate.workflowRecords[1].workflow.id });
  await owner.query("DELETE FROM sample_category_workflows WHERE organization_id=$1 AND sample_category_id=$2 AND applies_to='test_request'", [manager.organizationId, fixture.category.id]);
  const { request } = await generate(manager, fixture);
  const allocator = await account({ organizationId: manager.organizationId, permissions: ['samples.manage', 'samples.read', 'test_requests.allocate', 'datasheets.execute'] });
  await assert.rejects(work(allocator, loadLaboratorySettings), { code: 'forbidden' });
  const created = await work(allocator, (client, identity) => createTestRequestJobs(client, identity, { requestIds: [request.id], analystUserId: allocator.userId }));
  assert.equal(await selectedWorkflow(manager, request.id), alternate.workflowRecords[1].workflow.id);
  assert.equal(await selectedWorkflow(manager, created.items[0].id), fixture.workflowRecords[1].workflow.id);
});

test('a missing Job selection does not borrow the request or category workflow and rolls back its members', async () => {
  const actor = await account(); const fixture = await createLaboratoryFixture(owner, actor, { repeated: false });
  await configure(actor, { resultSummaryTemplateId: fixture.template.templateId, jobWorkflowId: null });
  const { request } = await generate(actor, fixture); const before = await snapshot(actor);
  await assert.rejects(work(actor, (client, identity) => createTestRequestJobs(client, identity, { requestIds: [request.id], analystUserId: actor.userId })),
    { code: 'test_request_workflow_not_configured' });
  assert.deepEqual(await snapshot(actor), before);
});

test('automatic children use the request setting for registration-only actors and missing configuration rolls back registration', async () => {
  const manager = await account(); const fixture = await createLaboratoryFixture(owner, manager, { repeated: false, generateTestRequests: true });
  const alternate = await createLaboratoryFixture(owner, manager, { repeated: false, configureSampleWorkflows: false });
  await configure(manager, { autoCreateJobs: true, resultSummaryTemplateId: fixture.template.templateId, testRequestWorkflowId: alternate.workflowRecords[1].workflow.id });
  const creator = await account({ organizationId: manager.organizationId, permissions: ['samples.create'] });
  const sample = await work(creator, (client, identity) => registerSample(client, identity, fixture.registration));
  assert.equal(await selectedWorkflow(manager, sample.testRequests[0].id), alternate.workflowRecords[1].workflow.id);
  await assert.rejects(work(creator, (client, identity) => initializeGeneratedRequest(client, identity, sample.testRequests[0].id)), { code: 'automatic_job_required' });
  await assert.rejects(work(creator, client => client.query('SELECT laboratory_test_request_workflow($1)', [sample.testRequests[0].id])), { code: '42501' });
  await configure(manager, { testRequestWorkflowId: null }); const before = await snapshot(manager);
  await assert.rejects(work(creator, (client, identity) => registerSample(client, identity, fixture.registration)), { code: 'test_request_workflow_not_configured' });
  assert.deepEqual(await snapshot(manager), before);
});

test('existing runs survive settings changes, retirement of their version and reassignment', async () => {
  const actor = await account(); const fixture = await createLaboratoryFixture(owner, actor, { repeated: false });
  const { request } = await generate(actor, fixture); const allocated = await allocate(actor, request.id);
  const before = (await owner.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND id=$2', [actor.organizationId, allocated.workflowRunId])).rows[0];
  await configure(actor, { testRequestWorkflowId: null });
  await owner.query("UPDATE workflow_versions SET status='retired',retired_at=now(),revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, before.workflow_version_id]);
  const reassigned = await allocate(actor, request.id, allocated.revision);
  assert.equal(reassigned.workflowRunId, allocated.workflowRunId); assert.equal(reassigned.datasheetId, allocated.datasheetId);
  assert.deepEqual((await owner.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND id=$2', [actor.organizationId, allocated.workflowRunId])).rows[0], before);
});

test('unavailable retained settings can synchronize to the source common control but cannot initialize new runs', async () => {
  const actor = await account(); const fixture = await createLaboratoryFixture(owner, actor, { repeated: false });
  const workflow = fixture.workflowRecords[1]; await configure(actor, { testRequestWorkflowId: null });
  await owner.query("UPDATE workflow_versions SET status='retired',retired_at=now(),revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, workflow.version.id]);
  const settings = await work(actor, loadLaboratorySettings);
  assert.equal(settings.workflows.find(row => row.id === workflow.workflow.id).available, false);
  await configure(actor, { testRequestWorkflowId: workflow.workflow.id.toUpperCase() });
  const stored = (await work(actor, loadLaboratorySettings)).settings;
  assert.equal(stored.testRequestWorkflowId, stored.jobWorkflowId);
  const { request } = await generate(actor, fixture); const before = await snapshot(actor);
  await assert.rejects(allocate(actor, request.id), { code: 'test_request_workflow_unavailable' });
  assert.deepEqual(await snapshot(actor), before);
  await configure(actor, { testRequestWorkflowId: null, jobWorkflowId: null });
  await assert.rejects(configure(actor, { testRequestWorkflowId: workflow.workflow.id }), { code: 'invalid_test_request_workflow' });
});

test('typed settings validate IDs, tenant, workflow kind, partial preservation and stale revisions', async () => {
  const actor = await account(); const fixture = await createLaboratoryFixture(owner, actor, { repeated: false });
  const foreign = await account(); const foreignFixture = await createLaboratoryFixture(owner, foreign, { repeated: false });
  for (const value of ['', undefined, false]) await assert.rejects(configure(actor, { testRequestWorkflowId: value }), { code: 'invalid_id' });
  for (const value of [randomUUID(), fixture.workflowRecords[0].workflow.id, foreignFixture.workflowRecords[1].workflow.id]) {
    await assert.rejects(configure(actor, { testRequestWorkflowId: value }), { code: 'invalid_test_request_workflow' });
  }
  const current = (await work(actor, loadLaboratorySettings)).settings;
  const input = { revision: current.revision, autoCreateJobs: true, resultSummaryTemplateId: null, jobWorkflowId: current.jobWorkflowId };
  await work(actor, (client, identity) => saveLaboratorySettings(client, identity, input));
  assert.equal((await work(actor, loadLaboratorySettings)).settings.testRequestWorkflowId, current.testRequestWorkflowId);
  await assert.rejects(work(actor, (client, identity) => saveLaboratorySettings(client, identity, input)), { code: 'stale_settings' });
  const { request } = await generate(foreign, foreignFixture);
  await assert.rejects(work(actor, client => client.query('SELECT laboratory_test_request_workflow($1)', [request.id])), { code: '42501' });
});

test('typed historical null and explicit false modes retain their behavior and application actors cannot change them', async () => {
  const actor = await account(); const fixture = await createLaboratoryFixture(owner, actor, { repeated: false });
  const { request } = await generate(actor, fixture); await configure(actor, { testRequestWorkflowId: null });
  for (const [index, mode] of [null, false].entries()) {
    const restored = (await owner.query(`INSERT INTO test_requests(organization_id,id,request_number,sample_test_id,specification_id,attempt_number,datasheet_template_id,created_by,using_dynamic_workflow)
      SELECT organization_id,$3,request_number||$4,sample_test_id,specification_id,$5,datasheet_template_id,created_by,$6 FROM test_requests
      WHERE organization_id=$1 AND id=$2 RETURNING id`, [actor.organizationId, request.id, randomUUID(), `-historical-${index}`, index + 2, mode])).rows[0];
    const allocated = await allocate(actor, restored.id);
    assert.ok(allocated.datasheetId);
    assert.equal(await selectedWorkflow(actor, restored.id), mode === null ? fixture.workflowRecords[1].workflow.id : null);
    await assert.rejects(work(actor, client => client.query('UPDATE test_requests SET using_dynamic_workflow=true,revision=revision+1 WHERE organization_id=$1 AND id=$2',
      [actor.organizationId, restored.id])), { code: '23514' });
  }
  for (const mode of [null, false]) await assert.rejects(work(actor, client => client.query(`INSERT INTO test_requests(organization_id,id,request_number,sample_test_id,specification_id,attempt_number,datasheet_template_id,created_by,using_dynamic_workflow)
    SELECT organization_id,$3,request_number||'-invalid',sample_test_id,specification_id,4,datasheet_template_id,$4,$5 FROM test_requests WHERE organization_id=$1 AND id=$2`,
  [actor.organizationId, request.id, randomUUID(), actor.userId, mode])), { code: '42501' });
});

async function definition(actor) {
  const workflow = await work(actor, (client, identity) => createWorkflow(client, identity, { code: randomUUID(), name: `Synthetic request workflow ${randomUUID()}`, appliesTo: 'test_request' }));
  const initial = await work(actor, (client, identity) => saveWorkflowState(client, identity, workflow.versionId, 1, { code: 'initial', name: 'Initial', stateType: 'initial' }));
  const final = await work(actor, (client, identity) => saveWorkflowState(client, identity, workflow.versionId, initial.revision, { code: 'final', name: 'Final', stateType: 'final', isPositiveTermination: true }));
  const transition = await work(actor, (client, identity) => saveWorkflowTransition(client, identity, workflow.versionId, final.revision,
    { code: 'finish', name: 'Finish', sourceStateId: initial.id, targetStateId: final.id, approvalMode: 'none', creatorRoleIds: [actor.roleId], approverStages: [], requireComment: false, checklist: [] }));
  await work(actor, (client, identity) => publishWorkflow(client, identity, workflow.versionId, transition.revision, 'Synthetic configuration proof'));
  return { ...workflow, stateId: initial.id };
}
async function assertBlocked(waitingPid, blockingPid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await owner.query('SELECT pg_blocking_pids($1) AS blockers', [waitingPid])).rows[0].blockers.includes(blockingPid)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Expected the configuration or workflow lock to serialize these actions.');
}

test('direct SQL cannot start a new dynamic request on a different published workflow', async () => {
  const actor = await account(); const fixture = await createLaboratoryFixture(owner, actor, { repeated: false });
  const alternate = await definition(actor); const { request } = await generate(actor, fixture); const before = await snapshot(actor);
  await assert.rejects(work(actor, client => client.query(`INSERT INTO workflow_runs(organization_id,workflow_version_id,test_request_id,current_state_id,started_by)
    VALUES($1,$2,$3,$4,$5)`, [actor.organizationId, alternate.versionId, request.id, alternate.stateId, actor.userId])),
  { code: '23514', constraint: 'test_request_workflow_binding' });
  assert.deepEqual(await snapshot(actor), before);
});

test('allocation holds its selected configuration through commit and later requests use the updated assignment', async () => {
  const actor = await account(); const fixture = await createLaboratoryFixture(owner, actor, { repeated: false });
  const alternate = await definition(actor); const { request } = await generate(actor, fixture);
  const ready = Promise.withResolvers(); const release = Promise.withResolvers(); const savingReady = Promise.withResolvers(); let saving;
  const allocating = work(actor, async (client, identity) => {
    const result = await allocateTestRequest(client, identity, request.id, { revision: 1, assignmentType: 'analyst', assignedUserId: actor.userId });
    ready.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); await release.promise; return result;
  });
  allocating.catch(ready.reject);
  try {
    const allocatingPid = await ready.promise; const { settings } = await work(actor, loadLaboratorySettings);
    saving = work(actor, async (client, identity) => {
      savingReady.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return saveLaboratorySettings(client, identity, { revision: settings.revision, autoCreateJobs: false,
        resultSummaryTemplateId: null, jobWorkflowId: settings.jobWorkflowId, testRequestWorkflowId: alternate.workflowId });
    });
    saving.catch(savingReady.reject); await assertBlocked(await savingReady.promise, allocatingPid);
    release.resolve(); await allocating; await saving;
    assert.equal(await selectedWorkflow(actor, request.id), fixture.workflowRecords[1].workflow.id);
    const next = await generate(actor, fixture); await allocate(actor, next.request.id);
    assert.equal(await selectedWorkflow(actor, next.request.id), alternate.workflowId);
  } finally { release.resolve(); await Promise.allSettled([allocating, saving].filter(Boolean)); }
});

test('request-only settings block workflow type changes and serialize with retirement in either order', async () => {
  for (const firstAction of ['save', 'retire']) {
    const actor = await account(); const fixture = await createLaboratoryFixture(owner, actor, { repeated: false });
    const target = await definition(actor); const { settings } = await work(actor, loadLaboratorySettings);
    const saveAction = (client, identity) => saveLaboratorySettings(client, identity, { revision: settings.revision, autoCreateJobs: false,
      resultSummaryTemplateId: null, jobWorkflowId: fixture.workflowRecords[1].workflow.id, testRequestWorkflowId: target.workflowId });
    const retireAction = (client, identity) => retireWorkflowMaster(client, identity, { id: target.workflowId, metadataRevision: 1, requestId: randomUUID() });
    const ready = Promise.withResolvers(); const release = Promise.withResolvers(); const secondReady = Promise.withResolvers(); let second;
    const first = work(actor, async (client, identity) => {
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const result = await (firstAction === 'save' ? saveAction : retireAction)(client, identity);
      ready.resolve(pid); await release.promise; return result;
    });
    first.catch(ready.reject);
    try {
      const firstPid = await ready.promise;
      second = work(actor, async (client, identity) => {
        secondReady.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return (firstAction === 'save' ? retireAction : saveAction)(client, identity);
      });
      second.catch(secondReady.reject); await assertBlocked(await secondReady.promise, firstPid); release.resolve(); await first;
      await assert.rejects(second, { code: firstAction === 'save' ? 'workflow_in_use' : 'invalid_test_request_workflow' });
      if (firstAction === 'save') await assert.rejects(work(actor, (client, identity) => updateWorkflowMaster(client, identity,
        { id: target.workflowId, metadataRevision: 1, requestId: randomUUID(), name: 'Synthetic changed kind', appliesTo: 'sample' })), { code: 'workflow_type_immutable' });
    } finally { release.resolve(); await Promise.allSettled([first, second].filter(Boolean)); }
  }
});
