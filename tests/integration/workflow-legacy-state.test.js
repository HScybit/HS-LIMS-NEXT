import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { workflowGraphValues } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, publishWorkflow, cloneWorkflowDraft } from '../../src/workflows/authoring.js';
import { cloneWorkflowMaster } from '../../src/workflows/master-clone.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';

const owner = ownerPool(); let manager; let reader; let foreign;
const work = (action, actor = manager, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
async function account(options) { const user = await createAccount(owner, options); return { ...user, ...await signIn({ identifier: user.username, password: user.password }) }; }
before(async () => {
  manager = await account({ permissions: ['workflows.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });
async function fixture() {
  return work(async (client, identity) => {
    const workflow = await createWorkflow(client, identity, { code: randomUUID(), name: `Synthetic legacy TR states ${randomUUID()}`, appliesTo: 'test_request' });
    const initial = await saveWorkflowState(client, identity, workflow.versionId, 1,
      { code: 'initial', name: 'Analysis in Progress', stateType: 'initial', legacyTrState: 'allocated' });
    const final = await saveWorkflowState(client, identity, workflow.versionId, initial.revision,
      { code: 'final', name: 'Approved', stateType: 'final', legacyTrState: 'approved' });
    const edge = await saveWorkflowTransition(client, identity, workflow.versionId, final.revision,
      { code: 'finish', name: 'Approve', sourceStateId: initial.id, targetStateId: final.id });
    return { ...workflow, initialId: initial.id, finalId: final.id, revision: edge.revision };
  });
}
const load = (value, actor = manager) => work((client, identity) => loadWorkflowDefinition(client, identity, value.versionId), actor, true);
const finalInput = (extra = {}) => ({ code: 'final', name: 'Approved', stateType: 'final', ...extra });

test('legacy request identifiers preserve exact text, explicit clearing and omission independently of state labels', async () => {
  const value = await fixture();
  for (const legacyTrState of ['reviewed', 'Approved', '  approved  ', '0', 'x'.repeat(150), '', null]) {
    const saved = await work((client, identity) => saveWorkflowState(client, identity, value.versionId, value.revision, finalInput({ legacyTrState }), value.finalId));
    value.revision = saved.revision;
    assert.equal((await load(value)).states.find((state) => state.id === value.finalId).legacyTrState, legacyTrState);
    const omitted = await work((client, identity) => saveWorkflowState(client, identity, value.versionId, value.revision, finalInput({ name: 'Renamed display label' }), value.finalId));
    value.revision = omitted.revision;
    const loaded = await load(value); assert.equal(loaded.metrics.queryCount, 8);
    const state = loaded.states.find((state) => state.id === value.finalId);
    assert.equal(state.legacyTrState, legacyTrState); assert.equal(state.name, 'Renamed display label'); assert.equal(state.code, 'final');
  }
});

test('invalid legacy states, stale edits, foreign tenants and reader writes leave the complete graph unchanged', async () => {
  const value = await fixture(); const original = await load(value);
  for (const legacyTrState of [false, [], {}, '\0', '\ud800', 'x'.repeat(151)]) {
    await assert.rejects(work((client, identity) => saveWorkflowState(client, identity, value.versionId, value.revision, finalInput({ legacyTrState }), value.finalId)), { code: 'invalid_workflow_input' });
  }
  for (const [actor, revision, code] of [[reader, value.revision, 'forbidden'], [foreign, value.revision, 'workflow_not_found'], [manager, value.revision - 1, 'stale_workflow_definition']]) {
    await assert.rejects(work((client, identity) => saveWorkflowState(client, identity, value.versionId, revision, finalInput({ legacyTrState: 'reviewed' }), value.finalId), actor), { code });
  }
  await assert.rejects(work((client) => client.query('UPDATE workflow_states SET legacy_tr_state=$3 WHERE organization_id=$1 AND id=$2',
    [manager.organizationId, value.finalId, 'x'.repeat(151)])), { code: '23514', constraint: 'workflow_state_legacy_tr_state' });
  assert.deepEqual(await load(value), original);
});

test('published states and both clone paths retain hidden identifiers through retries and later source edits', async () => {
  const value = await fixture();
  await work((client, identity) => publishWorkflow(client, identity, value.versionId, value.revision, 'Frozen hidden request-state identifiers'));
  const original = await load(value); const expected = workflowGraphValues(original);
  const draft = await work((client, identity) => cloneWorkflowDraft(client, identity, value.versionId));
  const input = { id: randomUUID(), requestId: randomUUID(), sourceVersionId: value.versionId };
  const master = await work((client, identity) => cloneWorkflowMaster(client, identity, value.workflowId, input));
  assert.deepEqual(await work((client, identity) => cloneWorkflowMaster(client, identity, value.workflowId, input)), master);
  for (const copied of [draft, master]) {
    const cloned = await load(copied); assert.deepEqual(workflowGraphValues(cloned), expected);
    assert.notEqual(cloned.states[0].id, original.states[0].id);
  }
  await assert.rejects(work((client, identity) => saveWorkflowState(client, identity, value.versionId, original.version.revision,
    finalInput({ legacyTrState: 'reviewed' }), value.finalId)), { code: 'stale_workflow_definition' });
  await assert.rejects(owner.query('UPDATE workflow_states SET legacy_tr_state=$3 WHERE organization_id=$1 AND id=$2',
    [manager.organizationId, value.finalId, 'reviewed']), { code: '55000' });
  const draftFinal = (await load(draft)).states.find((state) => state.stateType === 'final');
  await work((client, identity) => saveWorkflowState(client, identity, draft.versionId, draft.revision,
    finalInput({ name: 'Released', legacyTrState: 'reviewed' }), draftFinal.id));
  const latest = await work((client, identity) => cloneWorkflowMaster(client, identity, value.workflowId, { id: randomUUID(), requestId: randomUUID() }));
  assert.equal((await load(latest)).states.find((state) => state.stateType === 'final').legacyTrState, 'reviewed');
  assert.deepEqual(await load(value), original); assert.deepEqual(workflowGraphValues(await load(master)), expected);
});
