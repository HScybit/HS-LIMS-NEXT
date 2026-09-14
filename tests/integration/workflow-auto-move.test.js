import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { workflowGraphValues } from '../helpers/workflow-clones.js';
import { closePool } from '../../src/db/pool.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, publishWorkflow, cloneWorkflowDraft } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { cloneWorkflowMaster } from '../../src/workflows/master-clone.js';

const owner = ownerPool(); let manager; let reader; let foreign;
const modes = ['yes', 'no', 'all_trs_allocated', 'all_trs_approved'];
const work = (action, actor = manager, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
async function account(options) { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; }
const sqlError = (code, constraint) => (error) => (error.cause ?? error).code === code && (!constraint || (error.cause ?? error).constraint === constraint);
before(async () => {
  manager = await account({ permissions: ['workflows.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });
async function graph() {
  return work(async (client, identity) => {
    const workflow = await createWorkflow(client, identity, { code: randomUUID(), name: `Auto Move graph ${randomUUID()}`, appliesTo: 'sample' });
    const initial = await saveWorkflowState(client, identity, workflow.versionId, 1, { code: 'initial', name: 'Initial', stateType: 'initial' });
    const final = await saveWorkflowState(client, identity, workflow.versionId, initial.revision, { code: 'final', name: 'Complete', stateType: 'final' });
    return { ...workflow, revision: final.revision, input: { code: 'finish', name: 'Finish', sourceStateId: initial.id, targetStateId: final.id } };
  });
}
const load = (fixture, actor = manager) => work((client, identity) => loadWorkflowDefinition(client, identity, fixture.versionId), actor, true);
async function save(fixture, changes = {}) {
  const result = await work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision, { ...fixture.input, ...changes }, fixture.transitionId));
  fixture.revision = result.revision; fixture.transitionId = result.id; return (await load(fixture)).transitions.find((edge) => edge.id === result.id);
}

test('every Auto Move choice records its exact mode and derives the boolean despite a stale source editor boolean', async () => {
  const fixture = await graph();
  for (const autoMoveMode of modes) {
    const edge = await save(fixture, { autoMoveMode, autoExecute: autoMoveMode !== 'yes' });
    assert.equal(edge.autoMoveMode, autoMoveMode); assert.equal(edge.autoExecute, autoMoveMode === 'yes');
  }
  for (const autoExecute of [undefined, false, true]) {
    const created = await save(await graph(), autoExecute === undefined ? {} : { autoExecute });
    assert.equal(created.autoMoveMode, autoExecute ? 'yes' : 'no'); assert.equal(created.autoExecute, autoExecute ?? false);
  }
  await work(async (client, identity) => {
    let queries = 0; const observed = { query(...args) { queries++; return client.query(...args); } };
    await loadWorkflowDefinition(observed, identity, fixture.versionId); assert.equal(queries, 8);
  }, reader, true);
});

test('omitted and unchanged older-client booleans preserve conditional modes while explicit changes record their new meaning', async () => {
  const fixture = await graph(); await save(fixture, { autoMoveMode: 'all_trs_allocated' });
  for (const input of [{ name: 'Changed name' }, { autoExecute: false }]) {
    const retained = await save(fixture, input); assert.equal(retained.autoMoveMode, 'all_trs_allocated'); assert.equal(retained.autoExecute, false);
  }
  const enabled = await save(fixture, { autoExecute: true }); assert.equal(enabled.autoMoveMode, 'yes'); assert.equal(enabled.autoExecute, true);
  const disabled = await save(fixture, { autoExecute: false }); assert.equal(disabled.autoMoveMode, 'no'); assert.equal(disabled.autoExecute, false);
  await save(fixture, { autoMoveMode: 'all_trs_approved' });
  assert.equal((await save(fixture, { autoMoveMode: 'no' })).autoMoveMode, 'no');
});

test('unknown historical modes retain their original true or false booleans through edits, publication and both clones', async () => {
  for (const originalBoolean of [false, true]) {
    const fixture = await graph(); await save(fixture);
    await owner.query('UPDATE workflow_transitions SET auto_move_mode=NULL,auto_execute=$2 WHERE id=$1', [fixture.transitionId, originalBoolean]);
    for (const input of [{}, { autoExecute: originalBoolean }]) {
      const edge = await save(fixture, input); assert.equal(edge.autoMoveMode, null); assert.equal(edge.autoExecute, originalBoolean);
    }
    await work((client, identity) => publishWorkflow(client, identity, fixture.versionId, fixture.revision, 'Unknown historical Auto Move mode'));
    const original = await load(fixture);
    for (const copy of [await work((client, identity) => cloneWorkflowDraft(client, identity, fixture.versionId)),
      await work((client, identity) => cloneWorkflowMaster(client, identity, fixture.workflowId, { id: randomUUID(), requestId: randomUUID(), sourceVersionId: fixture.versionId }))]) {
      const edge = (await load(copy)).transitions[0]; assert.equal(edge.autoMoveMode, null); assert.equal(edge.autoExecute, originalBoolean);
      await work((client, identity) => saveWorkflowTransition(client, identity, copy.versionId, copy.revision,
        { code: edge.code, name: edge.name, sourceStateId: edge.sourceStateId, targetStateId: edge.targetStateId, autoExecute: !originalBoolean }, edge.id));
      const changed = (await load(copy)).transitions[0]; assert.equal(changed.autoExecute, !originalBoolean); assert.equal(changed.autoMoveMode, originalBoolean ? 'no' : 'yes');
    }
    assert.deepEqual(await load(fixture), original);
  }
});

test('publication and both clone paths preserve all four modes and independent complete graph values', async () => {
  const fixture = await graph();
  for (const autoMoveMode of modes) {
    fixture.transitionId = undefined; await save(fixture, { code: autoMoveMode, name: autoMoveMode, autoMoveMode });
  }
  const published = await work((client, identity) => publishWorkflow(client, identity, fixture.versionId, fixture.revision, 'All source Auto Move choices'));
  const original = await load(fixture); const values = workflowGraphValues(original);
  await assert.rejects(work((client) => client.query("UPDATE workflow_transitions SET auto_move_mode='no',auto_execute=false WHERE workflow_version_id=$1", [fixture.versionId])), sqlError('55000'));
  await assert.rejects(work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, published.revision, { ...fixture.input, autoMoveMode: 'yes' }, fixture.transitionId)), { code: 'stale_workflow_definition' });
  for (const copy of [await work((client, identity) => cloneWorkflowDraft(client, identity, fixture.versionId)),
    await work((client, identity) => cloneWorkflowMaster(client, identity, fixture.workflowId, { id: randomUUID(), requestId: randomUUID(), sourceVersionId: fixture.versionId }))]) {
    const cloned = await load(copy); assert.deepEqual(workflowGraphValues(cloned), values);
    assert.notEqual(cloned.transitions[0].id, original.transitions[0].id);
    await work((client, identity) => publishWorkflow(client, identity, copy.versionId, copy.revision, 'Copied Auto Move choices'));
    assert.deepEqual(workflowGraphValues(await load(copy)), values);
  }
  assert.deepEqual(workflowGraphValues(await load(fixture)), values);
});

test('Auto Move constraints and stale, reader or foreign commands fail without changing the saved graph', async () => {
  const fixture = await graph(); await save(fixture, { autoMoveMode: 'all_trs_approved' }); const original = await load(fixture);
  for (const autoMoveMode of ['', null, 'YES', 'unknown', true]) await assert.rejects(save(fixture, { autoMoveMode }), { code: 'invalid_workflow_input' });
  await assert.rejects(work((client) => client.query("UPDATE workflow_transitions SET auto_move_mode='unknown' WHERE id=$1", [fixture.transitionId])), sqlError('23514', 'workflow_transition_auto_move_mode'));
  await assert.rejects(work((client) => client.query('UPDATE workflow_transitions SET auto_execute=true WHERE id=$1', [fixture.transitionId])), sqlError('23514', 'workflow_transition_auto_move_pair'));
  for (const actor of [reader, foreign]) {
    await assert.rejects(work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision,
      { ...fixture.input, autoMoveMode: 'yes' }, fixture.transitionId), actor), { status: actor === reader ? 403 : 404 });
  }
  assert.deepEqual(await load(fixture), original);
  const results = await Promise.allSettled(['yes', 'all_trs_allocated'].map((autoMoveMode) => work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision,
    { ...fixture.input, autoMoveMode }, fixture.transitionId))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'stale_workflow_definition');
  const current = (await load(fixture)).transitions[0]; assert.equal(current.autoExecute, current.autoMoveMode === 'yes');
});
