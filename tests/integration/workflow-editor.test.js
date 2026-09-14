import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadWorkflowEditor } from '../../src/workflows/editor.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { createWorkflowMaster, retireWorkflowMaster } from '../../src/workflows/metadata.js';
import { cloneWorkflowDraft, publishWorkflow, saveWorkflowState } from '../../src/workflows/authoring.js';

const owner = ownerPool(); let manager; let reader; let runtimeReader; let foreign;
const account = async (options) => { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; };
const work = (action, actor = manager, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const read = (workflowId, actor = manager, options) => work((client, identity) => loadWorkflowEditor(client, identity, workflowId, options), actor, true);
const fixture = () => work((client, identity) => createWorkflowCloneFixture(client, identity, { edges: 2, roleId: manager.roleId }));
before(async () => {
  manager = await account({ permissions: ['workflows.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  runtimeReader = await account({ organizationId: manager.organizationId, permissions: ['samples.read'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

test('editor selects an actual draft for managers and a published version for readers without modifying history', async () => {
  const created = await fixture(); const original = await read(created.workflowId);
  const draft = await work((client, identity) => cloneWorkflowDraft(client, identity, created.versionId));
  const editable = await read(created.workflowId); assert.equal(editable.version.id, draft.versionId);
  assert.equal((await read(created.workflowId, reader)).version.id, created.versionId);
  assert.deepEqual(workflowGraphValues(editable), workflowGraphValues(original));
  await work((client, identity) => publishWorkflow(client, identity, draft.versionId, 1, 'Synthetic editor test'));
  assert.equal((await read(created.workflowId, reader)).version.id, draft.versionId);
  const historical = await read(created.workflowId, reader, { versionId: created.versionId.toUpperCase() });
  assert.equal(historical.version.status, 'retired'); assert.deepEqual(workflowGraphValues(historical), workflowGraphValues(original));
});

test('graph reads reject foreign and mismatched versions, retired masters and runtime-only permissions', async () => {
  const first = await fixture(); const second = await fixture();
  for (const versionId of [second.versionId, randomUUID()]) {
    await assert.rejects(read(first.workflowId, reader, { versionId }), { status: 404, code: 'workflow_version_not_found' });
  }
  await assert.rejects(read(first.workflowId, reader, { versionId: '' }), { status: 400 });
  await assert.rejects(read(first.workflowId, foreign), { status: 404 });
  await assert.rejects(read(first.workflowId, runtimeReader), { status: 403 });
  await assert.rejects(read(randomUUID()), { status: 404 });
  await work((client, identity) => retireWorkflowMaster(client, identity, { id: first.workflowId, requestId: randomUUID(), metadataRevision: 1 }));
  await assert.rejects(read(first.workflowId), { status: 404 });
  const saved = await work((client, identity) => loadWorkflowDefinition(client, identity, first.versionId), manager, true);
  assert.equal(saved.states.length, 3); assert.equal(saved.transitions.length, 2);
});

test('empty drafts and exact stored layout are readable with ten bounded graph queries', async () => {
  const created = await work((client, identity) => createWorkflowMaster(client, identity, { id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: `Empty ${randomUUID()}` }));
  const empty = await read(created.workflowId, reader); assert.equal(empty.version.status, 'draft'); assert.deepEqual(empty.states, []);
  assert.deepEqual(empty.transitions, []);
  await work((client, identity) => saveWorkflowState(client, identity, created.versionId, 1, { name: 'Zero', code: 'zero', stateType: 'initial',
    canvasX: 0, canvasY: 100000, inputCount: 0, outputCount: 8, legacyTrState: '  ' }));
  await work(async (client, identity) => {
    const query = client.query.bind(client); let count = 0;
    client.query = (...args) => { count++; return query(...args); };
    try {
      const value = await loadWorkflowEditor(client, identity, created.workflowId);
      assert.equal(count, 10); assert.equal(value.metrics.queryCount, 10);
      assert.equal(value.states[0].canvasX, 0); assert.equal(value.states[0].canvasY, 100000);
      assert.equal(value.states[0].inputCount, 0); assert.equal(value.states[0].legacyTrState, '  ');
    } finally { client.query = query; }
  }, reader, true);
});
