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

const owner = ownerPool(); let manager; let peer; let reader; let foreign;
const account = async (options) => { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; };
const work = (action, actor = manager, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const load = (versionId) => work((client, identity) => loadWorkflowDefinition(client, identity, versionId), manager, true);
const execute = (workflowId, command, actor = manager) => work((client, identity) => executeWorkflowEditorCommand(client, identity, workflowId, command), actor);
const input = (graph, operation, value, elementId) => ({ requestId: randomUUID(), versionId: graph.versionId, revision: graph.revision, operation,
  ...(elementId ? { elementId } : {}), ...(value === undefined ? {} : { input: value }) });
const count = async (workflowId) => Number((await owner.query('SELECT count(*) FROM workflow_editor_commands WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, workflowId])).rows[0].count);
before(async () => {
  manager = await account({ permissions: ['workflows.manage'] });
  peer = await account({ organizationId: manager.organizationId, permissions: ['workflows.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });
async function graph(published = false) {
  const created = published
    ? await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges: 5, roleId: manager.roleId }))
    : await work((client, identity) => createWorkflowMaster(client, identity, { id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: `Editor commands ${randomUUID()}` }));
  const definition = await load(created.versionId);
  return { ...created, revision: definition.version.revision, definition };
}
async function apply(graph, operation, value, elementId) {
  const command = input(graph, operation, value, elementId); const result = await execute(graph.workflowId, command);
  graph.versionId = result.versionId; graph.revision = result.revision; return { command, result };
}

test('all editor operations return durable outcomes through publication, draft cloning and element deletion', async () => {
  const fixture = await graph();
  const initial = await apply(fixture, 'create_state', { code: 'initial', name: 'Initial', stateType: 'initial', inputCount: 0 });
  const final = await apply(fixture, 'create_state', { code: 'final', name: 'Final', stateType: 'final', outputCount: 0, isPositiveTermination: true });
  const edge = await apply(fixture, 'create_transition', { code: 'finish', name: 'Finish', sourceStateId: initial.result.id, targetStateId: final.result.id });
  await apply(fixture, 'patch_state', { name: 'Changed initial' }, initial.result.id);
  await apply(fixture, 'patch_transition', { ccEmails: ['Command@Example.invalid'], autoMoveMode: 'all_trs_approved' }, edge.result.id);
  const publication = await apply(fixture, 'publish', { changeSummary: 'Synthetic command publication' });
  assert.equal(publication.result.status, 'published'); const publishedVersionId = fixture.versionId;
  const published = await load(publishedVersionId);
  assert.deepEqual(await execute(fixture.workflowId, initial.command), initial.result);
  assert.deepEqual(await execute(fixture.workflowId, publication.command), publication.result);
  const deletion = await apply(fixture, 'delete_transition', undefined, edge.result.id);
  assert.notEqual(deletion.result.versionId, publishedVersionId); assert.notEqual(deletion.result.id, edge.result.id);
  assert.equal(deletion.result.revision, 2); assert.deepEqual(await execute(fixture.workflowId, deletion.command), deletion.result);
  const draft = await load(fixture.versionId); assert.equal(draft.transitions.length, 0);
  const stateDeletion = await apply(fixture, 'delete_state', undefined, draft.states.find((state) => state.code === 'final').id);
  assert.deepEqual(await execute(fixture.workflowId, stateDeletion.command), stateDeletion.result);
  assert.equal((await load(fixture.versionId)).states.length, 1); assert.equal(await count(fixture.workflowId), 8);
  assert.deepEqual(await load(publishedVersionId), published);
});

test('first transition edits map exact cloned endpoints and preserve every hidden typed family', async () => {
  const fixture = await graph(true); const before = fixture.definition; const edge = before.transitions[1];
  const command = input(fixture, 'patch_transition', { name: 'Changed cloned edge', sourceStateId: edge.sourceStateId.toUpperCase(), targetStateId: edge.targetStateId }, edge.id);
  const result = await execute(fixture.workflowId, command); const copied = await load(result.versionId);
  const expected = workflowGraphValues(before); expected.transitions[1].name = 'Changed cloned edge';
  assert.deepEqual(workflowGraphValues(copied), expected);
  assert.equal(copied.transitions[1].id, result.id); assert.notEqual(result.id, edge.id);
  assert.notEqual(copied.transitions[1].sourceStateId, edge.sourceStateId); assert.notEqual(copied.transitions[1].targetStateId, edge.targetStateId);
  assert.deepEqual(await load(fixture.versionId), before); assert.deepEqual(await execute(fixture.workflowId, command), result);
});

test('cloned state mapping uses the unique code when display names and positions are identical', async () => {
  const fixture = await graph(); const nodes = [];
  for (const [code, stateType] of [['first', 'initial'], ['middle', 'normal'], ['last', 'final']]) {
    nodes.push((await apply(fixture, 'create_state', { code, stateType, name: 'Same display name', displayOrder: 0 })).result);
  }
  for (let index = 0; index < 2; index++) await apply(fixture, 'create_transition', { code: `edge-${index}`, name: 'Same connection name', sourceStateId: nodes[index].id, targetStateId: nodes[index + 1].id });
  await apply(fixture, 'publish', { changeSummary: 'Duplicate display labels are intentional synthetic data' });
  const sourceVersionId = fixture.versionId;
  const changed = await apply(fixture, 'patch_state', { name: 'Only the middle node changes' }, nodes[1].id);
  const after = await load(changed.result.versionId);
  assert.equal(after.states.find((state) => state.id === changed.result.id).code, 'middle');
  assert.equal(after.states.filter((state) => state.name === 'Only the middle node changes').length, 1);
  assert((await load(sourceVersionId)).states.every((state) => state.name === 'Same display name'));
});

test('request reuse checks actor and workflow while object-key reordering remains an exact retry', async () => {
  const fixture = await graph(); const command = input(fixture, 'create_state', { code: 'initial', name: 'Initial', stateType: 'initial' });
  const saved = await execute(fixture.workflowId, command);
  assert.deepEqual(await execute(fixture.workflowId, { ...command, input: { stateType: 'initial', name: 'Initial', code: 'initial' } }), saved);
  await assert.rejects(execute(fixture.workflowId, { ...command, input: { ...command.input, name: 'Changed request' } }), { code: 'save_request_reused' });
  const other = await graph();
  await assert.rejects(execute(other.workflowId, command), { code: 'save_request_reused' });
  await assert.rejects(execute(other.workflowId, { ...command, versionId: other.versionId }, peer), { code: 'save_request_reused' });
  assert.equal((await load(other.versionId)).states.length, 0); assert.equal((await load(other.versionId)).version.revision, 1);
  assert.equal(await count(other.workflowId), 0); assert.equal(await count(fixture.workflowId), 1);
  assert.equal(await work(async (client, identity) => (await client.query('SELECT * FROM workflow_editor_commands WHERE organization_id=$1 AND request_id=$2', [identity.organization_id, command.requestId])).rowCount, peer, true), 0);
});

test('invalid first edits roll back the clone and leave the request identity available for a corrected command', async () => {
  const fixture = await graph(true); const before = fixture.definition;
  const command = input(fixture, 'patch_state', { templateId: randomUUID() }, before.states[0].id);
  await assert.rejects(execute(fixture.workflowId, command), { code: 'invalid_workflow_template' });
  assert.equal((await owner.query("SELECT count(*)::integer count FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2 AND status='draft'", [manager.organizationId, fixture.workflowId])).rows[0].count, 0);
  assert.equal(await count(fixture.workflowId), 0); assert.deepEqual(await load(fixture.versionId), before);
  const saved = await execute(fixture.workflowId, { ...command, input: { name: 'Corrected first edit' } }); assert.equal(saved.revision, 2);
  const incomplete = await graph(); const initial = await apply(incomplete, 'create_state', { code: 'initial', name: 'Initial', stateType: 'initial' });
  await assert.rejects(execute(incomplete.workflowId, input(incomplete, 'publish', { changeSummary: 'Must not activate an incomplete graph' })), { code: 'workflow_validation_failed' });
  assert.equal((await load(incomplete.versionId)).version.revision, initial.result.revision); assert.equal(await count(incomplete.workflowId), 1);
});

test('exact outcomes survive later publication and retirement while new retired-version changes fail', async () => {
  const fixture = await graph(true); const original = { ...fixture };
  const patched = await apply(fixture, 'patch_state', { name: 'Draft change' }, fixture.definition.states[1].id);
  await apply(fixture, 'publish', { changeSummary: 'New published graph' });
  const retired = await load(original.versionId); assert.equal(retired.version.status, 'retired');
  assert.deepEqual(await execute(fixture.workflowId, patched.command), patched.result);
  await assert.rejects(execute(fixture.workflowId, { ...patched.command, requestId: randomUUID(), revision: retired.version.revision }), { code: 'stale_workflow_definition' });
  await work((client, identity) => retireWorkflowMaster(client, identity, { id: fixture.workflowId, requestId: randomUUID(), metadataRevision: 1 }));
  assert.deepEqual(await execute(fixture.workflowId, patched.command), patched.result);
  await assert.rejects(execute(fixture.workflowId, input(fixture, 'patch_state', { name: 'Inactive' }, patched.result.id)), { status: 404 });
});

test('editor commands enforce real actor and tenant boundaries before recording changes', async () => {
  const fixture = await graph(); const command = input(fixture, 'create_state', { code: 'initial', name: 'Initial' });
  await assert.rejects(execute(fixture.workflowId, command, reader), { status: 403 });
  await assert.rejects(execute(fixture.workflowId, command, foreign), { status: 404 });
  await assert.rejects(work((client, identity) => executeWorkflowEditorCommand(client, { ...identity, user_id: peer.userId }, fixture.workflowId, command)), { status: 403 });
  await assert.rejects(work((client, identity) => executeWorkflowEditorCommand(client, { ...identity, permission_codes: ['workflows.manage'] }, fixture.workflowId, command), reader), { status: 404 });
  assert.equal((await load(fixture.versionId)).states.length, 0); assert.equal(await count(fixture.workflowId), 0);
});

test('concurrent identical commands create one result and competing draft edits reject stale revisions', async () => {
  const fixture = await graph(); const command = input(fixture, 'create_state', { code: 'initial', name: 'Initial' });
  const identical = await Promise.all([execute(fixture.workflowId, command), execute(fixture.workflowId, command)]); assert.deepEqual(identical[0], identical[1]);
  assert.equal(await count(fixture.workflowId), 1); assert.equal((await load(fixture.versionId)).states.length, 1);
  const updated = { ...fixture, revision: identical[0].revision };
  const competing = await Promise.allSettled(['First', 'Second'].map((name) => execute(fixture.workflowId, input(updated, 'patch_state', { name }, identical[0].id))));
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(competing.find((result) => result.status === 'rejected').reason.code, 'stale_workflow_definition');
  assert.equal(await count(fixture.workflowId), 2); assert.equal((await load(fixture.versionId)).version.revision, 3);
});

test('concurrent first edits clone a published graph once and never adopt another pending draft silently', async () => {
  const fixture = await graph(true); const command = input(fixture, 'patch_state', { name: 'First draft edit' }, fixture.definition.states[0].id);
  const identical = await Promise.all([execute(fixture.workflowId, command), execute(fixture.workflowId, command)]); assert.deepEqual(identical[0], identical[1]);
  await assert.rejects(execute(fixture.workflowId, { ...command, requestId: randomUUID(), input: { name: 'Another first edit' } }), { code: 'workflow_draft_exists' });
  assert.equal((await owner.query('SELECT count(*)::integer count FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, fixture.workflowId])).rows[0].count, 2);
  assert.equal(await count(fixture.workflowId), 1); assert.deepEqual(await load(fixture.versionId), fixture.definition);
});

test('receipt insertion revalidates a revoked actor and rolls back every first-edit clone mutation', async () => {
  const actor = await account({ organizationId: manager.organizationId, permissions: ['workflows.manage'] });
  const fixture = await graph(true); const command = input(fixture, 'patch_state', { name: 'Must roll back' }, fixture.definition.states[1].id); let intercepted = false;
  await assert.rejects(work(async (client, identity) => {
    const observed = { async query(...args) {
      if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO workflow_editor_commands')) {
        intercepted = true; await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId]);
      }
      return client.query(...args);
    } };
    return executeWorkflowEditorCommand(observed, identity, fixture.workflowId, command);
  }, actor), { status: 403 });
  assert(intercepted); assert.equal(await count(fixture.workflowId), 0);
  assert.equal((await owner.query("SELECT count(*)::integer count FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2 AND status='draft'", [manager.organizationId, fixture.workflowId])).rows[0].count, 0);
  assert.deepEqual(await load(fixture.versionId), fixture.definition);
});

test('receipt guards reject forged actors, results and timestamps and preserve immutable history', async () => {
  const fixture = await graph(); const created = await execute(fixture.workflowId, input(fixture, 'create_state', { code: 'initial', name: 'Initial' }));
  const insert = `INSERT INTO workflow_editor_commands(organization_id,request_id,workflow_id,source_version_id,source_revision,
    workflow_version_id,revision,operation,source_element_id,element_id,fingerprint,saved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
  const values = [manager.organizationId, randomUUID(), fixture.workflowId, fixture.versionId, 1, fixture.versionId, 2, 'create_state', null, created.id, Buffer.alloc(32), manager.userId];
  const forgedActor = [...values]; forgedActor[11] = peer.userId;
  await assert.rejects(work((client) => client.query(insert, forgedActor)), { code: '42501', constraint: 'workflow_metadata_session_required' });
  const future = [...values]; future[4] = 2; future[6] = 3;
  await assert.rejects(work((client) => client.query(insert, future)), { code: '23514', constraint: 'workflow_editor_command_result' });
  const other = await graph(); const wrongWorkflow = [...values]; wrongWorkflow[2] = other.workflowId;
  await assert.rejects(work((client) => client.query(insert, wrongWorkflow)), { code: '23514', constraint: 'workflow_editor_command_result' });
  await assert.rejects(work((client) => client.query(insert.replace('saved_by)', 'saved_by,saved_at)').replace('$12)', '$12,now())'), values)), { code: '42501' });
  for (const sql of ['UPDATE workflow_editor_commands SET fingerprint=fingerprint WHERE organization_id=$1 AND workflow_id=$2',
    'DELETE FROM workflow_editor_commands WHERE organization_id=$1 AND workflow_id=$2']) {
    await assert.rejects(work((client) => client.query(sql, [manager.organizationId, fixture.workflowId])), { code: '42501' });
    await assert.rejects(owner.query(sql, [manager.organizationId, fixture.workflowId]), { code: '55000', constraint: 'workflow_editor_command_immutable' });
  }
  const worker = await owner.connect();
  try {
    await worker.query('BEGIN'); await worker.query('SET LOCAL ROLE sampleify_report_worker');
    for (const sql of ['SELECT * FROM workflow_editor_commands', 'SELECT workflow_editor_command_guard()']) {
      await worker.query('SAVEPOINT denied'); await assert.rejects(worker.query(sql), { code: '42501' }); await worker.query('ROLLBACK TO SAVEPOINT denied');
    }
  } finally { await worker.query('ROLLBACK'); worker.release(); }
  assert.equal(await count(fixture.workflowId), 1); assert.equal((await load(fixture.versionId)).version.revision, 2);
});

test('commands revalidate the actual session after a workflow lock wait', async () => {
  const actor = await account({ organizationId: manager.organizationId, permissions: ['workflows.manage'] });
  const fixture = await graph(); const command = input(fixture, 'create_state', { code: 'initial', name: 'Must not save' });
  const writer = await owner.connect(); let pending;
  try {
    await writer.query('BEGIN'); await writer.query('SELECT id FROM workflows WHERE organization_id=$1 AND id=$2 FOR UPDATE', [manager.organizationId, fixture.workflowId]);
    let started; const ready = new Promise((resolve) => { started = resolve; });
    pending = work(async (client, identity) => {
      started((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return executeWorkflowEditorCommand(client, identity, fixture.workflowId, command);
    }, actor).then((value) => ({ value }), (error) => ({ error }));
    const pid = await Promise.race([ready, pending.then((result) => { throw result.error ?? new Error('Command did not reach the workflow lock.'); })]);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(waiting, 'The actual workflow lock was not reached.');
    await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId]); await writer.query('COMMIT');
    assert.equal((await pending).error?.status, 403);
    assert.equal(await count(fixture.workflowId), 0); assert.equal((await load(fixture.versionId)).version.revision, 1);
  } finally { await writer.query('ROLLBACK'); writer.release(); if (pending) await pending; }
});
