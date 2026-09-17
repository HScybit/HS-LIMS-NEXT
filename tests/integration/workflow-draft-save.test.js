import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createWorkflowMaster, retireWorkflowMaster } from '../../src/workflows/metadata.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { executeWorkflowEditorCommand } from '../../src/workflows/commands.js';

const owner = ownerPool(); let manager; let reader; let foreign;
const account = async options => { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; };
const work = (action, actor = manager, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const load = versionId => work((client, identity) => loadWorkflowDefinition(client, identity, versionId), manager, true);
const execute = (workflowId, command, actor = manager) => work((client, identity) => executeWorkflowEditorCommand(client, identity, workflowId, command), actor);
const command = (graph, operation = 'save_flow', input = { changeSummary: 'Incomplete draft saved' }, elementId) => ({
  requestId: randomUUID(), versionId: graph.versionId, revision: graph.revision, operation,
  ...(input === undefined ? {} : { input }), ...(elementId ? { elementId } : {}),
});
async function graph(published = false) {
  const value = await work((client, identity) => published
    ? createWorkflowCloneFixture(client, identity, { edges: 2, roleId: manager.roleId })
    : createWorkflowMaster(client, identity, { id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: `Draft save ${randomUUID()}` }));
  const definition = await load(value.versionId); return { ...value, revision: definition.version.revision, definition };
}
before(async () => {
  manager = await account({ permissions: ['workflows.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

test('empty Save Flow persists an inactive draft, summary and one exact retry receipt', async () => {
  const value = await graph(); const request = command(value); const saved = await execute(value.workflowId, request);
  assert.equal(saved.status, 'draft'); assert.equal(saved.revision, 2);
  assert.deepEqual(await execute(value.workflowId, request), saved);
  const actual = await load(value.versionId);
  assert.equal(actual.version.changeSummary, request.input.changeSummary); assert.equal(actual.version.publishedAt, null); assert.equal(actual.version.publishedBy, null);
  assert.equal((await owner.query('SELECT operation FROM workflow_editor_commands WHERE organization_id=$1 AND request_id=$2', [manager.organizationId, request.requestId])).rows[0].operation, 'save_draft');
  await assert.rejects(execute(value.workflowId, command({ ...value, revision: saved.revision }, 'publish')), { code: 'workflow_validation_failed' });
  assert.equal((await load(value.versionId)).version.revision, 2);
});

test('incomplete edits leave the published workflow unchanged and receipts retain their original result after later activation', async () => {
  const value = await graph(true); const original = value.definition;
  const remove = { ...command(value, 'delete_transition'), elementId: original.transitions[0].id }; delete remove.input;
  const draft = await execute(value.workflowId, remove);
  const request = command(draft); const saved = await execute(value.workflowId, request);
  assert.equal(saved.status, 'draft'); assert.deepEqual(await load(value.versionId), original);
  const incomplete = await load(saved.versionId);
  const from = incomplete.states.find(state => state.code === original.states[0].code);
  const to = incomplete.states.find(state => state.code === original.states[1].code);
  const connected = await execute(value.workflowId, command(saved, 'create_transition', { code: 'restored', name: 'Restored connection', sourceStateId: from.id, targetStateId: to.id }));
  const activationRequest = command(connected); const activated = await execute(value.workflowId, activationRequest);
  assert.equal(activated.status, 'published'); assert.equal((await load(value.versionId)).version.status, 'retired');
  assert.deepEqual(workflowGraphValues(await load(value.versionId)), workflowGraphValues(original));
  assert.deepEqual(await execute(value.workflowId, request), saved);
  assert.deepEqual(await execute(value.workflowId, activationRequest), activated);
  await work((client, identity) => retireWorkflowMaster(client, identity, { id: value.workflowId, requestId: randomUUID(), metadataRevision: 1 }));
  assert.deepEqual(await execute(value.workflowId, request), saved);
  await assert.rejects(execute(value.workflowId, command(saved)), { status: 404 });
});

test('incomplete approval configuration is retained as a draft without weakening explicit publication', async () => {
  const value = await graph(true);
  const edited = await execute(value.workflowId, command(value, 'patch_state', { name: 'Draft approval setup' }, value.definition.states[0].id));
  await work(async (client, identity) => {
    await client.query('DELETE FROM workflow_transition_approver_roles WHERE organization_id=$1 AND transition_id IN (SELECT id FROM workflow_transitions WHERE organization_id=$1 AND workflow_version_id=$2)', [identity.organization_id, edited.versionId]);
  });
  const saved = await execute(value.workflowId, command(edited)); assert.equal(saved.status, 'draft');
  await assert.rejects(execute(value.workflowId, command(saved, 'publish')), { code: 'workflow_validation_failed' });
  assert.deepEqual(await load(value.versionId), value.definition);
});

test('draft save serializes duplicates and competing revisions without accepting changed request content', async () => {
  const value = await graph(); const request = command(value);
  const results = await Promise.all([execute(value.workflowId, request), execute(value.workflowId, request)]);
  assert.deepEqual(results[0], results[1]);
  const competing = await Promise.allSettled([execute(value.workflowId, command(results[0])), execute(value.workflowId, command(results[0]))]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competing.find(result => result.status === 'rejected').reason.code, 'stale_workflow_definition');
  await assert.rejects(execute(value.workflowId, { ...request, input: { changeSummary: 'Different content' } }), { code: 'save_request_reused' });
  assert.equal((await owner.query('SELECT count(*)::integer count FROM workflow_editor_commands WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, value.workflowId])).rows[0].count, 2);
});

test('draft save respects actual management permission, tenant and retired-version boundaries', async () => {
  const value = await graph(); const request = command(value);
  await assert.rejects(execute(value.workflowId, request, reader), { status: 403 });
  await assert.rejects(execute(value.workflowId, request, foreign), { status: 404 });
  await assert.rejects(work((client, identity) => executeWorkflowEditorCommand(client, { ...identity, user_id: reader.userId }, value.workflowId, request)), { status: 403 });
  await assert.rejects(execute(value.workflowId, { ...request, input: { changeSummary: 'Valid', actor: manager.userId } }), { status: 400 });
  const active = await graph(true); await assert.rejects(execute(active.workflowId, command(active)), { code: 'stale_workflow_definition' });
  assert.equal((await load(value.versionId)).version.revision, 1);
});
