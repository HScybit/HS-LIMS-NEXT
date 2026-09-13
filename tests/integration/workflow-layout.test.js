import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { closePool } from '../../src/db/pool.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, publishWorkflow, cloneWorkflowDraft } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';

const owner = ownerPool(); let manager; let reader; let foreign;
const work = (callback, account = manager, readOnly = false) => withSession(account.token, callback, { csrfToken: account.csrfToken, readOnly });
const sqlError = (code, constraint) => (error) => (error.cause ?? error).code === code && (!constraint || (error.cause ?? error).constraint === constraint);
before(async () => {
  const account = async (options) => { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; };
  manager = await account({ permissions: ['workflows.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

async function graph() {
  const workflow = await work((client, identity) => createWorkflow(client, identity, { code: randomUUID(), name: `Synthetic layout workflow ${randomUUID()}`, appliesTo: 'sample' }));
  const initialInput = { code: 'initial', name: 'In progress', stateType: 'initial', canvasX: 0, canvasY: 0, inputCount: 0, outputCount: 8, badgeStyle: 'dark' };
  const finalInput = { code: 'final', name: 'Complete', stateType: 'final', canvasX: 100000, canvasY: 100000, inputCount: 8, outputCount: 0, badgeStyle: 'light' };
  const initial = await work((client, identity) => saveWorkflowState(client, identity, workflow.versionId, 1, initialInput));
  const final = await work((client, identity) => saveWorkflowState(client, identity, workflow.versionId, initial.revision, finalInput));
  const input = { code: 'finish', name: 'Finish', sourceStateId: initial.id, targetStateId: final.id, sourcePort: 8, targetPort: 8,
    approvalMode: 'all', approverStages: [{ stageNumber: 1, roleIds: [manager.roleId] }], creatorRoleIds: [manager.roleId],
    ccRoleIds: [manager.roleId], ccEmails: ['review@example.invalid'], conditions: [{ sourceField: 'name', operator: 'is_not_null' }],
    checklist: [{ prompt: 'Confirm the item', isRequired: true }] };
  const connection = await work((client, identity) => saveWorkflowTransition(client, identity, workflow.versionId, final.revision, input));
  return { ...workflow, initial, final, connection, initialInput, finalInput, input, revision: connection.revision };
}
const load = (fixture) => work((client, identity) => loadWorkflowDefinition(client, identity, fixture.versionId), reader, true);

test('layout and ports survive omitted old-client fields, publication and independent version cloning', async () => {
  const fixture = await graph();
  const saved = await work((client, identity) => saveWorkflowState(client, identity, fixture.versionId, fixture.revision,
    { code: 'initial', name: 'Renamed', stateType: 'initial' }, fixture.initial.id));
  const { sourcePort: _source, targetPort: _target, ...oldClient } = fixture.input;
  const edited = await work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, saved.revision, oldClient, fixture.connection.id));
  const value = await load(fixture); const first = value.states.find((state) => state.id === fixture.initial.id);
  assert.equal(first.canvasX, 0); assert.equal(first.canvasY, 0); assert.equal(first.inputCount, 0); assert.equal(first.outputCount, 8); assert.equal(first.badgeStyle, 'dark');
  assert.equal(value.transitions[0].sourcePort, 8); assert.equal(value.transitions[0].targetPort, 8);
  const published = await work((client, identity) => publishWorkflow(client, identity, fixture.versionId, edited.revision, 'Layout captured'));
  const original = await load(fixture);
  await assert.rejects(work((client) => client.query('UPDATE workflow_states SET canvas_x=50 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.initial.id])), sqlError('55000'));
  await assert.rejects(work((client) => client.query('UPDATE workflow_transitions SET source_port=1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.connection.id])), sqlError('55000'));
  await assert.rejects(work((client, identity) => saveWorkflowState(client, identity, fixture.versionId, published.revision, fixture.initialInput, fixture.initial.id)), { code: 'stale_workflow_definition' });
  const copy = await work((client, identity) => cloneWorkflowDraft(client, identity, fixture.versionId));
  const clone = await load(copy); const clonedState = clone.states.find((state) => state.code === 'initial');
  assert.notEqual(clonedState.id, fixture.initial.id); assert.equal(clonedState.canvasX, 0); assert.equal(clonedState.badgeStyle, 'dark');
  assert.equal(clone.transitions[0].sourcePort, 8); assert.equal(clone.transitions[0].targetPort, 8);
  assert.equal(clone.transitions[0].sourceStateId, clonedState.id);
  await work((client, identity) => saveWorkflowState(client, identity, copy.versionId, 1, { ...fixture.initialInput, canvasX: 12, outputCount: 1 }, clonedState.id));
  assert.equal((await load(copy)).transitions.length, 0);
  assert.deepEqual(await load(fixture), original, 'editing the copied graph cannot change frozen port, style or position history');
});

test('reducing source or target ports removes only discarded connections and their details in one revision', async () => {
  for (const side of ['source', 'target']) {
    const fixture = await graph();
    const retained = await work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision,
      { ...fixture.input, code: 'retained', name: 'Keep this edge', sourcePort: 1, targetPort: 1 }));
    const before = (await load(fixture)).transitions.find((transition) => transition.id === retained.id);
    const changed = await work((client, identity) => saveWorkflowState(client, identity, fixture.versionId, retained.revision,
      side === 'source' ? { ...fixture.initialInput, outputCount: 1 } : { ...fixture.finalInput, inputCount: 1 }, side === 'source' ? fixture.initial.id : fixture.final.id));
    assert.equal(changed.revision, retained.revision + 1);
    assert.deepEqual((await load(fixture)).transitions, [before]);
    for (const table of ['workflow_transition_creator_roles', 'workflow_transition_approver_roles', 'workflow_transition_cc_roles', 'workflow_transition_cc_emails', 'workflow_transition_conditions', 'workflow_transition_checklist_items']) {
      assert.equal((await owner.query(`SELECT count(*)::int n FROM ${table} WHERE organization_id=$1 AND transition_id=$2`, [manager.organizationId, fixture.connection.id])).rows[0].n, 0, table);
    }
  }
});

test('port integrity rejects unavailable endpoints and direct SQL dangling connections without partial changes', async () => {
  const fixture = await graph(); const before = await load(fixture);
  await assert.rejects(work((client, identity) => saveWorkflowState(client, identity, fixture.versionId, fixture.revision,
    { ...fixture.initialInput, code: 'final', outputCount: 1 }, fixture.initial.id)), { code: 'workflow_duplicate' });
  await assert.rejects(work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision,
    { ...fixture.input, code: 'reverse', sourceStateId: fixture.final.id, targetStateId: fixture.initial.id, sourcePort: 1, targetPort: 1 })), { code: 'invalid_workflow_port' });
  await assert.rejects(work((client) => client.query('UPDATE workflow_states SET output_count=1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.initial.id])), sqlError('23514', 'workflow_connection_port'));
  await assert.rejects(work((client) => client.query('UPDATE workflow_transitions SET source_state_id=$3,target_state_id=$4 WHERE organization_id=$1 AND id=$2',
    [manager.organizationId, fixture.connection.id, fixture.final.id, fixture.initial.id])), sqlError('23514', 'workflow_connection_port'));
  await assert.rejects(work((client) => client.query('UPDATE workflow_states SET canvas_x=-1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.initial.id])), sqlError('23514', 'workflow_state_layout'));
  await assert.rejects(work((client) => client.query('UPDATE workflow_transitions SET source_port=0 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.connection.id])), sqlError('23514', 'workflow_transition_ports'));
  assert.deepEqual(await load(fixture), before);
});

test('pre-layout NULL metadata remains explicitly unrecorded through reads, publication and cloning', async () => {
  const fixture = await graph();
  await work(async (client) => {
    await client.query('UPDATE workflow_transitions SET source_port=NULL,target_port=NULL WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.connection.id]);
    await client.query('UPDATE workflow_states SET canvas_x=NULL,canvas_y=NULL,input_count=NULL,output_count=NULL,badge_style=NULL WHERE organization_id=$1 AND workflow_version_id=$2', [manager.organizationId, fixture.versionId]);
  });
  await work((client, identity) => publishWorkflow(client, identity, fixture.versionId, fixture.revision, 'Synthetic pre-layout definition'));
  const source = await load(fixture); const copy = await work((client, identity) => cloneWorkflowDraft(client, identity, fixture.versionId));
  const cloned = await load(copy);
  for (const definition of [source, cloned]) {
    for (const state of definition.states) for (const key of ['canvasX', 'canvasY', 'inputCount', 'outputCount', 'badgeStyle']) assert.equal(state[key], null);
    assert.equal(definition.transitions[0].sourcePort, null); assert.equal(definition.transitions[0].targetPort, null);
  }
  const initial = cloned.states.find((state) => state.code === 'initial');
  await work((client, identity) => saveWorkflowState(client, identity, copy.versionId, 1, { code: 'initial', name: 'Closed output', stateType: 'initial', outputCount: 0 }, initial.id));
  assert.equal((await load(copy)).transitions.length, 0, 'implicit legacy port one is removed when its output count becomes zero');
  assert.deepEqual(await load(fixture), source);
});

test('layout changes retain tenant permissions, stale revision checks and fixed definition query count', async () => {
  const fixture = await graph();
  await assert.rejects(work((client, identity) => saveWorkflowState(client, identity, fixture.versionId, fixture.revision, fixture.initialInput, fixture.initial.id), reader), { status: 403 });
  await assert.rejects(work((client, identity) => saveWorkflowState(client, identity, fixture.versionId, fixture.revision, fixture.initialInput, fixture.initial.id), foreign), { status: 404 });
  await assert.rejects(work((client, identity) => loadWorkflowDefinition(client, identity, fixture.versionId), foreign, true), { status: 404 });
  const saves = await Promise.allSettled([20, 40].map((canvasX) => work((client, identity) => saveWorkflowState(client, identity, fixture.versionId, fixture.revision,
    { ...fixture.initialInput, canvasX }, fixture.initial.id))));
  assert.equal(saves.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(saves.find((result) => result.status === 'rejected').reason.code, 'stale_workflow_definition');
  await work(async (client, identity) => {
    let count = 0; const observed = { query(...args) { count++; return client.query(...args); } };
    const definition = await loadWorkflowDefinition(observed, identity, fixture.versionId);
    assert.equal(count, 8); assert.equal(definition.metrics.queryCount, 8);
    assert.ok([20, 40].includes(definition.states.find((state) => state.id === fixture.initial.id).canvasX));
    assert.equal(definition.transitions[0].sourcePort, 8);
  }, reader, true);
});
