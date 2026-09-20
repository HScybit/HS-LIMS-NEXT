import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveSampleCategory, loadSampleCategory, listSampleCategories, retireSampleCategory,
  sampleCategoryWorkflows, sampleCategoryTemplateOptions, sampleCategoryUserOptions, sampleCategoryFieldOptions } from '../../src/masters/sample-categories.js';
import { createWorkflowCloneFixture } from '../helpers/workflow-clones.js';

const owner = ownerPool();
const work = (actor, callback) => withSession(actor.token, callback, { csrfToken: actor.csrfToken });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage', 'workflows.manage', 'workflows.read'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function sampleWorkflow(actor) {
  let workflowId;
  await work(actor, async (client, identity) => { workflowId = (await createWorkflowCloneFixture(client, identity, { appliesTo: 'sample', roleId: actor.roleId })).workflowId; });
  return workflowId;
}
const command = (workflowId, changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: `Synthetic category ${randomUUID()}`,
  description: '', abbreviation: 'SYN', retentionDays: 30, estimatedTimeInDays: 5, enableEvents: false, enableReissue: false,
  workflowId, userIds: [], templates: {}, includedFieldIds: [], ...changes });
const save = (actor, input) => work(actor, (client, identity) => saveSampleCategory(client, identity, input));
const load = (actor, id, options) => work(actor, (client, identity) => loadSampleCategory(client, identity, id, options));
const list = (actor, input) => work(actor, (client, identity) => listSampleCategories(client, identity, input));
const retire = (actor, input) => work(actor, (client, identity) => retireSampleCategory(client, identity, input));
after(async () => { await closePool(); await owner.end(); });

test('sample category authoring records actual editors, preserves creation metadata and the workflow/user associations', async () => {
  const creator = await account(); const workflowId = await sampleWorkflow(creator);
  const input = command(workflowId, { name: '  Water Samples  ', description: '  Routine intake  ', userIds: [creator.userId] });
  const created = await save(creator, input);
  assert.equal(created.name, 'Water Samples'); assert.equal(created.description, 'Routine intake'); assert.equal(created.revision, 1);
  assert.equal(created.workflowId, workflowId); assert.deepEqual(created.userIds, [creator.userId]);
  const editor = await account({ organizationId: creator.organizationId });
  const updated = await save(editor, { ...input, requestId: randomUUID(), revision: 1, name: 'Water Samples', description: '', userIds: [], retentionDays: 60 });
  assert.equal(updated.revision, 2); assert.equal(updated.retentionDays, 60); assert.deepEqual(updated.userIds, []);
  const first = await load(editor, created.id, { atRevision: 1 }); const second = await load(editor, created.id, { atRevision: 2 });
  assert.equal(first.savedBy, creator.userId); assert.equal(first.operation, 'create'); assert.equal(first.previousRevision, null);
  assert.equal(second.savedBy, editor.userId); assert.equal(second.operation, 'update'); assert.equal(second.previousRevision, 1);
});

test('sample category save requires an active published Sample workflow', async () => {
  const actor = await account();
  await assert.rejects(save(actor, command(null)), { code: 'invalid_sample_category_workflow' });
  await assert.rejects(save(actor, command(randomUUID())), { code: 'invalid_sample_category_workflow' });
});

test('sample category retries return the original version and reject a changed payload or actor', async () => {
  const actor = await account(); const workflowId = await sampleWorkflow(actor); const input = command(workflowId); const created = await save(actor, input);
  await save(actor, { ...input, requestId: randomUUID(), revision: 1, description: 'Later revision' });
  const retried = await save(actor, { ...input, id: input.id.toUpperCase(), requestId: input.requestId.toUpperCase() });
  assert.equal(retried.revision, 1); assert.equal(retried.description, '');
  for (const changes of [{ description: 'Changed' }, { id: randomUUID() }, { revision: 1 }]) await assert.rejects(save(actor, { ...input, ...changes }), { code: 'save_request_reused' });
  const other = await account({ organizationId: actor.organizationId });
  await assert.rejects(save(other, input), { code: 'save_request_reused' });
  assert.equal((await load(actor, created.id)).revision, 2);
});

test('sample category stale revisions remain atomic under concurrent saves and retirement preserves last settings', async () => {
  const actor = await account(); const workflowId = await sampleWorkflow(actor); const input = command(workflowId); const created = await save(actor, input);
  const results = await Promise.allSettled(['First', 'Second'].map((description) => save(actor, { ...input, requestId: randomUUID(), revision: 1, description })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'stale_sample_category');
  const current = await load(actor, created.id);
  const retired = await retire(actor, { id: created.id, requestId: randomUUID(), revision: current.revision });
  assert.equal(retired.revision, current.revision + 1);
  await assert.rejects(load(actor, created.id), { code: 'sample_category_not_found' });
  const history = await load(actor, created.id, { atRevision: retired.revision });
  assert.equal(history.operation, 'retire'); assert.equal(history.active, false); assert.equal(history.name, current.name);
  await assert.rejects(retire(actor, { id: created.id, requestId: randomUUID(), revision: current.revision }), { code: 'sample_category_not_found' });
});

test('sample category listing excludes retired records and supports search', async () => {
  const actor = await account(); const workflowId = await sampleWorkflow(actor);
  const kept = await save(actor, command(workflowId, { name: 'Keep Me Findable' }));
  const gone = await save(actor, command(workflowId, { name: 'Remove Me' }));
  await retire(actor, { id: gone.id, requestId: randomUUID(), revision: gone.revision });
  const all = await list(actor, {});
  assert.ok(all.rows.some((row) => row._id === kept.id));
  assert.ok(!all.rows.some((row) => row._id === gone.id));
  const filtered = await list(actor, { search: 'Findable' });
  assert.equal(filtered.totalCount, 1); assert.equal(filtered.rows[0]._id, kept.id);
});

test('sample category user associations must be active members of the organization', async () => {
  const actor = await account(); const workflowId = await sampleWorkflow(actor);
  await assert.rejects(save(actor, command(workflowId, { userIds: [randomUUID()] })), { code: 'invalid_sample_category_users' });
});

test('sample category lookup endpoints return active, tenant-scoped, purpose-filtered options', async () => {
  const actor = await account(); const workflowId = await sampleWorkflow(actor);
  const workflows = await work(actor, (client, identity) => sampleCategoryWorkflows(client, identity, { search: '' }));
  assert.ok(workflows.rows.some((row) => row.id === workflowId));
  const outsider = await account();
  const outsiderWorkflows = await work(outsider, (client, identity) => sampleCategoryWorkflows(client, identity, { search: '' }));
  assert.ok(!outsiderWorkflows.rows.some((row) => row.id === workflowId));
  const users = await work(actor, (client, identity) => sampleCategoryUserOptions(client, identity, { search: '' }));
  assert.ok(users.rows.some((row) => row.id === actor.userId));
  const fields = await work(actor, (client, identity) => sampleCategoryFieldOptions(client, identity, { search: '' }));
  assert.deepEqual(fields, { rows: [], hasMore: false });
  await assert.rejects(work(actor, (client, identity) => sampleCategoryTemplateOptions(client, identity, { search: '', purpose: 'not-a-purpose' })), { code: 'invalid_input' });
  const templates = await work(actor, (client, identity) => sampleCategoryTemplateOptions(client, identity, { search: '', purpose: 'sample' }));
  assert.deepEqual(templates, { rows: [], hasMore: false });
});
