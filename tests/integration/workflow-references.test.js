import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { analyticalRecords } from '../helpers/templates.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { hashToken } from '../../src/auth/tokens.js';
import { closePool, database } from '../../src/db/pool.js';
import { createTemplate, editTemplate, freezeTemplate, createDraft, copyDefinition } from '../../src/templates/authoring.js';
import { createWorkflowMaster } from '../../src/workflows/metadata.js';
import { saveWorkflowState } from '../../src/workflows/authoring.js';
import { workflowReferenceOptions, selectWorkflowTemplate } from '../../src/workflows/references.js';

const owner = ownerPool(); let manager; let author; let reader; let foreign; let unrelated;
const account = async (options) => { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; };
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const options = (kind, input, actor = reader) => work(actor, (client, identity) => workflowReferenceOptions(client, identity, kind, input), true);
const template = (name) => work(author, (client, identity) => createTemplate(client, identity, { name, kind: 'datasheet' }));
const workflow = (actor = manager) => work(actor, (client, identity) => createWorkflowMaster(client, identity,
  { id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: `Synthetic references ${randomUUID()}` }));
before(async () => {
  manager = await account({ permissions: ['workflows.manage'] });
  author = await account({ organizationId: manager.organizationId, permissions: ['templates.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  unrelated = await account({ organizationId: manager.organizationId, permissions: ['samples.read'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

test('workflow template choices use actual versioned names, exact search text and selected inactive labels', async () => {
  const created = await template(`Reference %_\\ ${randomUUID()}`);
  const name = (await options('templates', { selectedIds: [created.templateId] })).selected[0].name;
  assert.deepEqual((await options('templates', { search: name })).rows, [{ id: created.templateId, name, active: true }]);
  await work(author, (client, identity) => editTemplate(client, identity, created.versionId, 1, { type: 'editDetails', name: 'Updated reference title', description: '' }));
  assert.equal((await options('templates', { selectedIds: [created.templateId] })).selected[0].name, 'Updated reference title');
  await work(author, (client, identity) => copyDefinition(database(client), analyticalRecords({ rowCount: 1, repeated: false }), identity.organization_id, created.versionId));
  await work(author, (client, identity) => freezeTemplate(client, identity, created.versionId, 2));
  const draft = await work(author, (client, identity) => createDraft(client, identity, created.versionId));
  await work(author, (client, identity) => editTemplate(client, identity, draft.versionId, draft.revision, { type: 'editDetails', name: 'Current draft label', description: '' }));
  assert.equal((await options('templates', { selectedIds: [created.templateId] })).selected[0].name, 'Current draft label');
  // Synthetic deactivation uses the existing application table permission; it
  // does not pretend that the future Template Master deletion UI is delivered.
  await work(author, (client, identity) => client.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=$2', [identity.organization_id, created.templateId]));
  const result = await options('templates', { search: 'Current draft label', selectedIds: [created.templateId, randomUUID()] });
  assert.deepEqual(result.rows, []); assert.equal(result.hasMore, false);
  assert.deepEqual(result.selected, [{ id: created.templateId, name: 'Current draft label', active: false }]);
});

test('role lookups bound normal results while resolving 500 selected identities in two queries', async () => {
  const prefix = `Reference roles ${randomUUID()}`;
  // Explicit legacy/synthetic label fixtures; no role permissions are granted.
  const ids = (await owner.query(`INSERT INTO roles(organization_id,id,name,active)
    SELECT $1,gen_random_uuid(),$2 || lpad(n::text,4,'0'),n<>501 FROM generate_series(1,501) n RETURNING id,name,active`, [manager.organizationId, prefix])).rows;
  ids.sort((left, right) => left.name.localeCompare(right.name));
  await work(reader, async (client, identity) => {
    let count = 0; const observed = { query(...args) { count++; return client.query(...args); } };
    const selectedIds = ids.slice(1).map((row) => row.id);
    const result = await workflowReferenceOptions(observed, identity, 'roles', { search: prefix, selectedIds });
    assert.equal(count, 2); assert.equal(result.rows.length, 100); assert.equal(result.hasMore, true);
    assert.equal(result.selected.length, 500); assert(result.rows.every((row) => row.active));
    assert.equal(result.selected.find((row) => row.id === ids.find((row) => !row.active).id).active, false);
    assert.deepEqual(result.rows.map((row) => row.name), ids.filter((row) => row.active).map((row) => row.name).sort().slice(0, 100));
  }, true);
});

test('workflow-only managers select active templates and retain current errors for unavailable references', async () => {
  const created = await template('Reference selection'); const graph = await workflow();
  const saved = await work(manager, (client, identity) => saveWorkflowState(client, identity, graph.versionId, 1,
    { code: 'initial', name: 'Initial', stateType: 'initial', templateId: created.templateId }));
  assert.equal(saved.revision, 2);
  await work(manager, async (client, identity) => {
    assert.equal((await client.query('SELECT * FROM templates WHERE id=$1', [created.templateId])).rowCount, 0);
    assert.equal((await client.query('SELECT * FROM template_versions WHERE template_id=$1', [created.templateId])).rowCount, 0);
    assert.deepEqual((await workflowReferenceOptions(client, identity, 'templates', { selectedIds: [created.templateId] })).selected,
      [{ id: created.templateId, name: 'Reference selection', active: true }]);
  }, true);
  await assert.rejects(work(reader, (client, identity) => selectWorkflowTemplate(client, identity, created.templateId)), { status: 403 });
  await assert.rejects(work(foreign, (client, identity) => selectWorkflowTemplate(client, identity, created.templateId)), { status: 422, code: 'invalid_workflow_template' });
  await assert.rejects(work(manager, (client, identity) => selectWorkflowTemplate(client, identity, randomUUID())), { status: 422, code: 'invalid_workflow_template' });
  assert.deepEqual((await options('templates', { selectedIds: [created.templateId] }, foreign)).selected, []);
  await assert.rejects(options('roles', {}, unrelated), { status: 403 });
  assert.equal((await owner.query('SELECT template_id FROM workflow_states WHERE organization_id=$1 AND id=$2', [manager.organizationId, saved.id])).rows[0].template_id, created.templateId);
});

test('reference views require an actual matching session and deny worker access', async () => {
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE sampleify_app');
    assert.equal((await client.query('SELECT * FROM workflow_template_labels')).rowCount, 0);
    assert.equal((await client.query('SELECT * FROM workflow_role_labels')).rowCount, 0);
    await client.query('SELECT * FROM auth_session_context($1)', [hashToken(reader.token)]);
    assert((await client.query('SELECT * FROM workflow_role_labels')).rowCount > 0);
    await client.query("SELECT set_config('app.user_id',$1,true)", [foreign.userId]);
    assert.equal((await client.query('SELECT * FROM workflow_role_labels')).rowCount, 0);
    await client.query('RESET ROLE'); await client.query('SET LOCAL ROLE sampleify_report_worker');
    for (const query of ['SELECT * FROM workflow_template_labels', 'SELECT * FROM workflow_role_labels', 'SELECT workflow_reference_organization()', 'SELECT workflow_select_template(NULL)']) {
      await client.query('SAVEPOINT denied'); await assert.rejects(client.query(query), { code: '42501' }); await client.query('ROLLBACK TO SAVEPOINT denied');
    }
  } finally { await client.query('ROLLBACK'); client.release(); }
});

async function waitForLock(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The actual template lock was not reached.');
}

const startedPid = (ready, pending) => Promise.race([ready, pending.then((result) => {
  throw result.error ?? new Error('The selection completed before reaching the expected template lock.');
})]);

test('template selection rechecks activity after a concurrent deactivation commits', async () => {
  const created = await template('Concurrent reference'); const graph = await workflow();
  const writer = await owner.connect(); let pending;
  try {
    await writer.query('BEGIN'); await writer.query('SET LOCAL ROLE sampleify_app');
    const identity = (await writer.query('SELECT * FROM auth_session_context($1)', [hashToken(author.token)])).rows[0];
    await writer.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=$2', [identity.organization_id, created.templateId]);
    let started; const ready = new Promise((resolve) => { started = resolve; });
    pending = work(manager, async (client, identity) => {
      started((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return saveWorkflowState(client, identity, graph.versionId, 1, { code: 'initial', name: 'Initial', templateId: created.templateId });
    }).then((value) => ({ value }), (error) => ({ error }));
    await waitForLock(await startedPid(ready, pending)); await writer.query('COMMIT');
    const result = await pending; assert.equal(result.error?.code, 'invalid_workflow_template');
    assert.equal((await owner.query('SELECT revision FROM workflow_versions WHERE organization_id=$1 AND id=$2', [manager.organizationId, graph.versionId])).rows[0].revision, 1);
    assert.equal((await owner.query('SELECT count(*)::int count FROM workflow_states WHERE organization_id=$1 AND workflow_version_id=$2', [manager.organizationId, graph.versionId])).rows[0].count, 0);
  } finally { await writer.query('ROLLBACK'); writer.release(); if (pending) await pending; }
});

test('template selection rechecks the real workflow actor after waiting for a lock', async () => {
  const actor = await account({ organizationId: manager.organizationId, permissions: ['workflows.manage'] });
  const created = await template('Revocation while selecting'); const graph = await workflow(actor);
  const writer = await owner.connect(); let pending;
  try {
    await writer.query('BEGIN'); await writer.query('SELECT id FROM templates WHERE organization_id=$1 AND id=$2 FOR UPDATE', [manager.organizationId, created.templateId]);
    let started; const ready = new Promise((resolve) => { started = resolve; });
    pending = work(actor, async (client, identity) => {
      started((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return saveWorkflowState(client, identity, graph.versionId, 1, { code: 'initial', name: 'Initial', templateId: created.templateId });
    }).then((value) => ({ value }), (error) => ({ error }));
    await waitForLock(await startedPid(ready, pending)); await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId]);
    await writer.query('COMMIT'); const result = await pending; assert.equal(result.error?.status, 403);
    assert.equal((await owner.query('SELECT revision FROM workflow_versions WHERE organization_id=$1 AND id=$2', [manager.organizationId, graph.versionId])).rows[0].revision, 1);
  } finally { await writer.query('ROLLBACK'); writer.release(); if (pending) await pending; }
});
