import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { registerSample } from '../../src/samples/register.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, publishWorkflow } from '../../src/workflows/authoring.js';
import { retireWorkflowMaster } from '../../src/workflows/metadata.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const empty = () => ({ base: null, iqc: null, ilc: null, pt: null, amendment: null, complaint: null });
const permissions = ['samples.create', 'samples.read', 'samples.manage', 'settings.read', 'settings.manage', 'workflows.manage'];
const work = (user, action) => withSession(user.token, action, { csrfToken: user.csrfToken });
async function account(overrides = {}) {
  const user = await createAccount(owner, { permissions, ...overrides });
  Object.assign(user, await signIn({ identifier: user.username, password: user.password })); return user;
}
const settings = async user => (await work(user, loadLaboratorySettings)).settings;
async function save(user, sampleWorkflows, changes = {}) {
  const current = await settings(user);
  return work(user, (client, identity) => saveLaboratorySettings(client, identity, { revision: current.revision,
    autoCreateJobs: current.autoCreateJobs, resultSummaryTemplateId: current.resultSummaryTemplateId, jobWorkflowId: current.jobWorkflowId,
    ...(sampleWorkflows === undefined ? {} : { sampleWorkflows }), ...changes }));
}
const register = (user, fixture, changes = {}) => work(user, (client, identity) => registerSample(client, identity, { ...fixture.registration, ...changes }));
const workflowId = async sample => (await owner.query(`SELECT version.workflow_id FROM workflow_runs run JOIN workflow_versions version
  ON version.organization_id=run.organization_id AND version.id=run.workflow_version_id WHERE run.id=$1`, [sample.workflowRunId])).rows[0].workflow_id;
async function definition(user, { publish = true, appliesTo = 'sample', active = true } = {}) {
  const result = await work(user, (client, identity) => createWorkflow(client, identity, { code: randomUUID(), name: `Synthetic assigned workflow ${randomUUID()}`, appliesTo, active }));
  if (!publish) return result;
  const initial = await work(user, (client, identity) => saveWorkflowState(client, identity, result.versionId, 1,
    { code: 'initial', name: 'Ready', stateType: 'initial', showSampleEdit: true }));
  const final = await work(user, (client, identity) => saveWorkflowState(client, identity, result.versionId, initial.revision,
    { code: 'complete', name: 'Complete', stateType: 'final', isPositiveTermination: true }));
  const transition = await work(user, (client, identity) => saveWorkflowTransition(client, identity, result.versionId, final.revision,
    { code: 'complete', name: 'Complete', sourceStateId: initial.id, targetStateId: final.id, approvalMode: 'none', creatorRoleIds: [], requireComment: false, checklist: [] }));
  await work(user, (client, identity) => publishWorkflow(client, identity, result.versionId, transition.revision, 'Synthetic sample configuration'));
  return result;
}
async function registrationCounts(user) {
  const tables = ['samples', 'sample_products', 'sample_tests', 'sample_events', 'number_sequences', 'workflow_runs', 'test_requests', 'datasheets'];
  const counts = {};
  for (const table of tables) counts[table] = (await owner.query(`SELECT count(*)::integer AS count FROM ${table} WHERE organization_id=$1`, [user.organizationId])).rows[0].count;
  return counts;
}
async function assertBlocked(waitingPid, blockingPid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = (await owner.query('SELECT pg_blocking_pids($1) AS blockers', [waitingPid])).rows[0];
    if (row.blockers.includes(blockingPid)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('The concurrent operation did not wait for the expected workflow/settings lock.');
}

test('missing organization configuration rejects registration and rolls back category-backed sample data', async () => {
  const user = await account(); const fixture = await createLaboratoryFixture(owner, user, { repeated: false, configureSampleWorkflows: false });
  const before = await registrationCounts(user);
  assert.deepEqual((await settings(user)).sampleWorkflows, empty());
  await assert.rejects(register(user, fixture), { code: 'sample_workflow_not_configured' });
  assert.deepEqual(await registrationCounts(user), before);
  await save(user, { ...empty(), base: fixture.workflowRecords[0].workflow.id });
  assert.equal(await workflowId(await register(user, fixture)), fixture.workflowRecords[0].workflow.id);
});

test('all native sample types select the organization workflow using the actual Meteor form mappings', async () => {
  const user = await account(); const fixture = await createLaboratoryFixture(owner, user, { repeated: false });
  const selections = {};
  for (const key of Object.keys(empty())) selections[key] = (await definition(user)).workflowId;
  await save(user, selections);
  const complaintProducts = structuredClone(fixture.registration.products); complaintProducts[0].tests[0].isRetest = true;
  for (const [sampleType, extra, key] of [
    ['internal', {}, 'base'], ['customer', { customerId: fixture.customer.id, customerAddress: 'Synthetic address' }, 'base'],
    ['quality_control', { iqcType: 'retest' }, 'iqc'], ['quality_control', { iqcType: 'int_lab', participantCount: 2 }, 'iqc'],
    ['interlaboratory', { ilcMode: 'participant' }, 'base'],
    ['interlaboratory', { ilcMode: 'organizer', participatingLabs: [{ laboratoryName: 'Synthetic partner' }] }, 'base'],
    ['proficiency', {}, 'base'], ['amendment', {}, 'amendment'], ['complaint', { products: complaintProducts }, 'complaint'],
  ]) {
    const created = await register(user, fixture, { sampleType, ...extra });
    assert.equal(await workflowId(created), selections[key]);
    assert.notEqual(await workflowId(created), fixture.workflowRecords[0].workflow.id);
  }
});

test('workflow settings distinguish omission and clearing, reject stale changes and retain prior runs', async () => {
  const user = await account(); const fixture = await createLaboratoryFixture(owner, user, { repeated: false });
  const first = await register(user, fixture); const firstWorkflow = await workflowId(first);
  const next = await definition(user); const current = await settings(user);
  await save(user, { ...current.sampleWorkflows, base: next.workflowId });
  const changed = await settings(user);
  await save(user, undefined, { allowReceivingDateEdit: true });
  assert.deepEqual((await settings(user)).sampleWorkflows, changed.sampleWorkflows);
  await assert.rejects(save(user, empty(), { revision: current.revision }), { code: 'stale_settings' });
  assert.equal(await workflowId(await register(user, fixture)), next.workflowId);
  await save(user, empty()); const before = await registrationCounts(user);
  await assert.rejects(register(user, fixture), { code: 'sample_workflow_not_configured' });
  assert.deepEqual(await registrationCounts(user), before);
  assert.equal(await workflowId(first), firstWorkflow);
});

test('foreign, unpublished, inactive and test-request workflows cannot become sample assignments', async () => {
  const user = await account(); await createLaboratoryFixture(owner, user, { repeated: false });
  const foreign = await account(); const foreignWorkflow = await definition(foreign);
  const invalid = [foreignWorkflow, await definition(user, { publish: false }), await definition(user, { publish: false, active: false }),
    await definition(user, { appliesTo: 'test_request' })];
  const before = await settings(user); const options = await work(user, loadLaboratorySettings);
  for (const workflow of invalid) {
    assert(!options.sampleWorkflowOptions.some(option => option.id === workflow.workflowId));
    await assert.rejects(save(user, { ...before.sampleWorkflows, base: workflow.workflowId }), { code: 'invalid_sample_workflow' });
    assert.deepEqual(await settings(user), before);
  }
});

test('create-only registrars use configured workflows without gaining settings access or replayable context', async () => {
  const admin = await account(); const fixture = await createLaboratoryFixture(owner, admin, { repeated: false });
  const registrar = await account({ organizationId: admin.organizationId, permissions: ['samples.create'] });
  const denied = await account({ organizationId: admin.organizationId, permissions: ['settings.read'] });
  await assert.rejects(work(registrar, loadLaboratorySettings), { code: 'forbidden' });
  await assert.rejects(save(denied, empty()), { code: 'forbidden' });
  await assert.rejects(register(denied, fixture), { code: 'forbidden' });
  const created = await register(registrar, fixture); assert.equal(await workflowId(created), fixture.workflowRecords[0].workflow.id);
  assert.equal((await work(registrar, client => client.query('SELECT * FROM organization_laboratory_settings'))).rowCount, 0);
  await assert.rejects(work(registrar, async client => {
    await client.query("SELECT set_config('app.registration_sample_id',$1,true)", [created.id]);
    assert.equal((await client.query('SELECT laboratory_registering_sample() AS id')).rows[0].id, null);
    await client.query('SELECT laboratory_sample_workflow($1)', [created.id]);
  }), { code: '42501' });
  const foreign = await account();
  await assert.rejects(work(foreign, async client => {
    await client.query("SELECT set_config('app.registration_sample_id',$1,true)", [created.id]);
    await client.query('SELECT laboratory_sample_workflow($1)', [created.id]);
  }), { code: '42501' });
});

test('every sample setting prevents workflow retirement until its actual assignment is cleared', async () => {
  const user = await account(); const target = await definition(user);
  const retire = () => work(user, (client, identity) => retireWorkflowMaster(client, identity, { id: target.workflowId, metadataRevision: 1, requestId: randomUUID() }));
  for (const key of Object.keys(empty())) {
    await save(user, { ...empty(), [key]: target.workflowId });
    await assert.rejects(retire(), { code: 'workflow_in_use' });
  }
  await save(user, empty()); assert.equal((await retire()).metadataRevision, 2);
  await assert.rejects(save(user, { ...empty(), base: target.workflowId }), { code: 'invalid_sample_workflow' });
});

test('unchanged unavailable selections survive unrelated saves but cannot be selected again or used for registration', async () => {
  const user = await account(); const fixture = await createLaboratoryFixture(owner, user, { repeated: false });
  const sampleId = fixture.workflowRecords.find(record => record.workflow.appliesTo === 'sample').workflow.id;
  const jobId = fixture.workflowRecords.find(record => record.workflow.appliesTo === 'test_request').workflow.id;
  await save(user, { ...empty(), base: sampleId }, { resultSummaryTemplateId: fixture.template.templateId, jobWorkflowId: jobId });
  // Represent retained/imported unavailable references; application retirement remains guarded.
  await owner.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=$2', [user.organizationId, fixture.template.templateId]);
  await owner.query("UPDATE workflow_versions SET status='retired',retired_at=now(),revision=revision+1 WHERE organization_id=$1 AND workflow_id=ANY($2::uuid[]) AND status='published'",
    [user.organizationId, [sampleId, jobId]]);
  await save(user, undefined, { allowReceivingDateEdit: true, resultSummaryTemplateId: fixture.template.templateId.toUpperCase(), jobWorkflowId: jobId.toUpperCase() });
  const retained = await settings(user);
  assert.equal(retained.resultSummaryTemplateId, fixture.template.templateId); assert.equal(retained.jobWorkflowId, jobId);
  assert.deepEqual(retained.sampleWorkflows, { ...empty(), base: sampleId }); assert.equal(retained.allowReceivingDateEdit, true);
  assert.deepEqual((await work(user, loadLaboratorySettings)).sampleWorkflowOptions.find(row => row.id === sampleId),
    { id: sampleId, label: fixture.workflowRecords[0].workflow.name, available: false });
  await assert.rejects(register(user, fixture), { code: 'sample_workflow_not_configured' });
  await assert.rejects(save(user, { ...retained.sampleWorkflows, iqc: sampleId }), { code: 'invalid_sample_workflow' });
  await save(user, empty(), { resultSummaryTemplateId: null, jobWorkflowId: null });
  await assert.rejects(save(user, { ...empty(), base: sampleId }), { code: 'invalid_sample_workflow' });
  await assert.rejects(save(user, undefined, { resultSummaryTemplateId: fixture.template.templateId }), { code: 'invalid_job_template' });
  await assert.rejects(save(user, undefined, { jobWorkflowId: jobId }), { code: 'invalid_job_workflow' });
  for (const [column, id] of [['result_summary_template_id', fixture.template.templateId], ['job_workflow_id', jobId], ['sample_workflow_base_id', sampleId]]) {
    await assert.rejects(work(user, (client, identity) => client.query(`UPDATE organization_laboratory_settings SET ${column}=$2,
      revision=revision+1,updated_by=$3,updated_at=now() WHERE organization_id=$1`, [user.organizationId, id, identity.user_id])), { code: '23514' });
  }
  assert.deepEqual((await settings(user)).sampleWorkflows, empty());
});

test('a settings change waits for registration and affects only subsequent sample workflows', async () => {
  const user = await account(); const fixture = await createLaboratoryFixture(owner, user, { repeated: false });
  const next = await definition(user); const current = await settings(user);
  const ready = Promise.withResolvers(); const release = Promise.withResolvers(); const savingReady = Promise.withResolvers();
  let registrationPid; let saving;
  const registration = work(user, async (client, identity) => {
    registrationPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const created = await registerSample(client, identity, fixture.registration);
    ready.resolve(); await release.promise; return created;
  });
  registration.catch(ready.reject);
  try {
    await ready.promise;
    saving = work(user, async (client, identity) => {
      savingReady.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return saveLaboratorySettings(client, identity, { revision: current.revision, autoCreateJobs: current.autoCreateJobs,
        resultSummaryTemplateId: current.resultSummaryTemplateId, jobWorkflowId: current.jobWorkflowId,
        sampleWorkflows: { ...current.sampleWorkflows, base: next.workflowId } });
    });
    saving.catch(savingReady.reject);
    await assertBlocked(await savingReady.promise, registrationPid);
    release.resolve(); const first = await registration; await saving;
    assert.equal(await workflowId(first), fixture.workflowRecords[0].workflow.id);
    assert.equal(await workflowId(await register(user, fixture)), next.workflowId);
    assert.equal(await workflowId(first), fixture.workflowRecords[0].workflow.id);
  } finally {
    release.resolve(); await Promise.allSettled([registration, saving].filter(Boolean));
  }
});

test('saving a workflow assignment and retiring that workflow serialize in either order', async () => {
  for (const firstAction of ['save', 'retire']) {
    const user = await account(); const target = await definition(user);
    await save(user, empty()); const current = await settings(user);
    const selections = { ...empty(), base: target.workflowId };
    const saveAction = (client, identity) => saveLaboratorySettings(client, identity, { revision: current.revision,
      autoCreateJobs: current.autoCreateJobs, resultSummaryTemplateId: null, jobWorkflowId: null, sampleWorkflows: selections });
    const retireAction = (client, identity) => retireWorkflowMaster(client, identity,
      { id: target.workflowId, metadataRevision: 1, requestId: randomUUID() });
    const ready = Promise.withResolvers(); const release = Promise.withResolvers(); const secondReady = Promise.withResolvers();
    let firstPid; let second;
    const first = work(user, async (client, identity) => {
      firstPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const result = await (firstAction === 'save' ? saveAction : retireAction)(client, identity);
      ready.resolve(); await release.promise; return result;
    });
    first.catch(ready.reject);
    try {
      await ready.promise;
      second = work(user, async (client, identity) => {
        secondReady.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return (firstAction === 'save' ? retireAction : saveAction)(client, identity);
      });
      second.catch(secondReady.reject);
      await assertBlocked(await secondReady.promise, firstPid);
      release.resolve(); await first;
      await assert.rejects(second, { code: firstAction === 'save' ? 'workflow_in_use' : 'invalid_sample_workflow' });
      assert.deepEqual((await settings(user)).sampleWorkflows, firstAction === 'save' ? selections : empty());
    } finally {
      release.resolve(); await Promise.allSettled([first, second].filter(Boolean));
    }
  }
});
