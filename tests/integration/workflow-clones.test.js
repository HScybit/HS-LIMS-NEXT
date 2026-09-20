import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../helpers/workflow-clones.js';
import { closePool } from '../../src/db/pool.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { createTemplate } from '../../src/templates/authoring.js';
import { cloneWorkflowDraft } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';

const owner = ownerPool(); let manager; let reader; let foreign;
const work = (action, account = manager, readOnly = false) => withSession(account.token, action, { csrfToken: account.csrfToken, readOnly });
const load = (versionId) => work((client, identity) => loadWorkflowDefinition(client, identity, versionId), reader, true);
const fixture = (options = {}) => work((client, identity) => createWorkflowCloneFixture(client, identity, { roleId: manager.roleId, ...options }));
before(async () => {
  const account = async (options) => { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; };
  manager = await account({ permissions: ['workflows.manage', 'templates.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

test('cloning beyond one batch preserves every typed graph value and independent identities with bounded queries', async () => {
  const template = await work((client, identity) => createTemplate(client, identity, { name: 'Synthetic workflow reference', kind: 'datasheet' }));
  const source = await fixture({ edges: 501, templateId: template.templateId });
  const original = await load(source.versionId); let queries = 0;
  const copy = await work((client, identity) => cloneWorkflowDraft({ query(...args) { queries++; return client.query(...args); } }, identity, source.versionId));
  assert.ok(queries <= 40, `Expected batched graph writes; received ${queries} queries`);
  const cloned = await load(copy.versionId);
  assert.equal(cloned.version.number, 2); assert.equal(cloned.version.revision, 1); assert.equal(cloned.version.status, 'draft');
  assert.deepEqual(workflowGraphValues(cloned), workflowGraphValues(original));
  const ids = (graph) => [...graph.states.map((state) => state.id), ...graph.transitions.flatMap((edge) => [edge.id, ...edge.conditions.map((item) => item.id), ...edge.checklist.map((item) => item.id)])];
  const originals = new Set(ids(original)); const copies = ids(cloned);
  assert.equal(new Set(copies).size, copies.length); assert.ok(copies.every((id) => !originals.has(id)));
  assert.deepEqual(await load(source.versionId), original);
  assert.ok(cloned.states.every((state) => state.templateId === template.templateId));
});

test('connection-only graphs clone without synthesizing empty role or checklist records', async () => {
  const source = await fixture({ edges: 1, details: false });
  const original = await load(source.versionId);
  const copy = await work((client, identity) => cloneWorkflowDraft(client, identity, source.versionId));
  const cloned = await load(copy.versionId);
  assert.deepEqual(workflowGraphValues(cloned), workflowGraphValues(original));
  assert.equal(cloned.states[0].capabilityRoles.length, 0);
  for (const key of ['creatorRoleIds', 'ccRoleIds', 'approverStages', 'ccEmails', 'conditions', 'checklist']) assert.deepEqual(cloned.transitions[0][key], []);
});

test('an asynchronous failure after batched detail writes rolls back the complete draft and permits a clean retry', async () => {
  const source = await fixture({ edges: 3 }); const original = await load(source.versionId); let failed = false;
  await assert.rejects(work((client, identity) => cloneWorkflowDraft({ async query(...args) {
    const statement = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (/^insert into "workflow_transition_cc_emails"/i.test(statement)) {
      failed = true; await Promise.resolve(); throw new Error('Synthetic asynchronous insert failure');
    }
    return client.query(...args);
  } }, identity, source.versionId)), (error) => (error.cause ?? error).message === 'Synthetic asynchronous insert failure');
  assert.equal(failed, true);
  assert.equal((await owner.query('SELECT count(*)::int n FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, source.workflowId])).rows[0].n, 1);
  assert.deepEqual(await load(source.versionId), original);
  const copy = await work((client, identity) => cloneWorkflowDraft(client, identity, source.versionId));
  assert.deepEqual(workflowGraphValues(await load(copy.versionId)), workflowGraphValues(original));
});

test('batched cloning keeps tenant, permission and concurrent single-draft enforcement', async () => {
  const source = await fixture();
  await assert.rejects(work((client, identity) => cloneWorkflowDraft(client, identity, source.versionId), reader), { status: 403 });
  await assert.rejects(work((client, identity) => cloneWorkflowDraft(client, identity, source.versionId), foreign), { status: 404 });
  const results = await Promise.allSettled([0, 1].map(() => work((client, identity) => cloneWorkflowDraft(client, identity, source.versionId))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'workflow_draft_exists');
});
