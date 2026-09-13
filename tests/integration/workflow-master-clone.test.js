import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { cloneWorkflowMaster } from '../../src/workflows/master-clone.js';
import { createWorkflowMaster, loadWorkflowMaster, updateWorkflowMaster, retireWorkflowMaster } from '../../src/workflows/metadata.js';
import { workflowCodeBase } from '../../src/workflows/metadata-input.js';
import { cloneWorkflowDraft, saveWorkflowState, saveWorkflowTransition, publishWorkflow } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { createTemplate } from '../../src/templates/authoring.js';

const owner = ownerPool(); let manager; let reader; let colleague; let foreign;
const account = async (options) => { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; };
const work = (action, actor = manager, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const input = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), ...changes });
const copy = (source, command = input(), actor = manager) => work((client, identity) => cloneWorkflowMaster(client, identity, source, command), actor);
const definition = (versionId, actor = manager) => work((client, identity) => loadWorkflowDefinition(client, identity, versionId), actor, true);
const master = (workflowId) => work((client, identity) => loadWorkflowMaster(client, identity, workflowId), manager, true);
const create = (changes = {}) => work((client, identity) => createWorkflowMaster(client, identity, {
  ...input(), metadataRevision: 0, name: `Synthetic master clone ${randomUUID()}`, ...changes,
}));
const fixture = (edges = 1) => work((client, identity) => createWorkflowCloneFixture(client, identity, { edges, roleId: manager.roleId }));
const origin = (workflowId) => work((client) => client.query('SELECT * FROM workflow_clone_origins WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, workflowId]), reader, true).then((result) => result.rows[0]);
const absent = async (workflowId) => assert.equal((await owner.query('SELECT count(*)::int n FROM workflows WHERE organization_id=$1 AND id=$2', [manager.organizationId, workflowId])).rows[0].n, 0);
const sqlError = (code) => (error) => (error.cause ?? error).code === code;
before(async () => {
  manager = await account({ permissions: ['workflows.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  colleague = await account({ organizationId: manager.organizationId, permissions: ['workflows.manage'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

test('a master clone copies every typed graph relation and non-default category selection with two service queries', async () => {
  const source = await fixture(501); const original = await definition(source.versionId); const categoryId = randomUUID();
  await owner.query('INSERT INTO sample_categories(organization_id,id,code,name,abbreviation) VALUES($1,$2,$3,$3,$3)', [manager.organizationId, categoryId, randomUUID()]);
  await work((client) => client.query('INSERT INTO sample_category_workflows(organization_id,sample_category_id,workflow_id,applies_to,is_default) VALUES($1,$2,$3,$4,true)',
    [manager.organizationId, categoryId, source.workflowId, 'sample']));
  const command = input(); let queries = 0;
  const copied = await work((client, identity) => cloneWorkflowMaster({ query(...args) { queries++; return client.query(...args); } }, identity, source.workflowId, command));
  assert.equal(queries, 2); assert.equal(copied.metadataRevision, 1); assert.equal(copied.revision, 2);
  const cloned = await definition(copied.versionId); const current = await master(copied.workflowId);
  assert.equal(cloned.version.status, 'draft'); assert.equal(cloned.version.number, 1);
  assert.equal(cloned.version.changeSummary, `Cloned from ${original.workflow.code}`);
  assert.equal(current.name, `${original.workflow.name} - Copy`); assert.equal(current.code, workflowCodeBase(`${original.workflow.code}-COPY`));
  assert.deepEqual(workflowGraphValues(cloned), workflowGraphValues(original));
  const identities = (graph) => [...graph.states.map((row) => row.id), ...graph.transitions.flatMap((row) => [row.id, ...row.conditions.map((item) => item.id), ...row.checklist.map((item) => item.id)])];
  const priorIds = new Set(identities(original)); assert.ok(identities(cloned).every((id) => !priorIds.has(id)));
  assert.deepEqual(await definition(source.versionId), original);
  const selections = (await owner.query('SELECT workflow_id,is_default FROM sample_category_workflows WHERE organization_id=$1 AND sample_category_id=$2 ORDER BY is_default DESC', [manager.organizationId, categoryId])).rows;
  assert.deepEqual(selections, [{ workflow_id: source.workflowId, is_default: true }, { workflow_id: copied.workflowId, is_default: false }]);
  const recorded = await origin(copied.workflowId);
  assert.equal(recorded.source_workflow_id, source.workflowId); assert.equal(recorded.source_version_id, source.versionId);
  assert.equal(recorded.source_revision, original.version.revision); assert.equal(recorded.source_metadata_revision, 1);
  assert.equal(recorded.workflow_version_id, copied.versionId); assert.equal(recorded.cloned_revision, 2);
  assert.equal(recorded.created_by, manager.userId); assert.equal(recorded.request_id, command.requestId); assert.equal(recorded.requested_source_version_id, null);
  const creation = (await owner.query('SELECT saved_by,saved_at,created_transaction_id FROM workflow_metadata_versions WHERE organization_id=$1 AND request_id=$2', [manager.organizationId, command.requestId])).rows[0];
  assert.equal(recorded.created_by, creation.saved_by); assert.deepEqual(recorded.created_at, creation.saved_at); assert.equal(recorded.created_transaction_id, creation.created_transaction_id);
});

test('a workflow manager preserves shared template references without receiving template management permission', async () => {
  const designer = await account({ organizationId: manager.organizationId, permissions: ['templates.manage'] });
  const template = await work((client, identity) => createTemplate(client, identity, { name: 'Synthetic shared workflow template', kind: 'datasheet' }), designer);
  const source = await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges: 1, roleId: manager.roleId, templateId: template.templateId }));
  const cloned = await copy(source.workflowId);
  assert.ok((await definition(cloned.versionId)).states.every((state) => state.templateId === template.templateId));
  await assert.rejects(work((client, identity) => createTemplate(client, identity, { name: 'Unpermitted template', kind: 'datasheet' })), { status: 403 });
});

test('master cloning prefers the current draft including cycles and can explicitly copy an earlier published or retired version', async () => {
  const source = await fixture(2); const published = await definition(source.versionId);
  const draft = await work((client, identity) => cloneWorkflowDraft(client, identity, source.versionId));
  const graph = await definition(draft.versionId); const initial = graph.states.find((state) => state.stateType === 'initial'); const middle = graph.states.find((state) => state.stateType === 'normal');
  const edited = await work((client, identity) => saveWorkflowState(client, identity, draft.versionId, 1,
    { code: initial.code, name: 'Current draft state', stateType: 'initial', inputCount: 1 }, initial.id));
  const connected = await work((client, identity) => saveWorkflowTransition(client, identity, draft.versionId, edited.revision,
    { code: 'cycle', name: 'Return to initial', sourceStateId: middle.id, targetStateId: initial.id }));
  const currentDraft = await definition(draft.versionId); const automatic = await copy(source.workflowId);
  assert.deepEqual(workflowGraphValues(await definition(automatic.versionId)), workflowGraphValues(currentDraft));
  assert.equal((await origin(automatic.workflowId)).source_version_id, draft.versionId);
  const selected = await copy(source.workflowId, input({ sourceVersionId: source.versionId }));
  assert.deepEqual(workflowGraphValues(await definition(selected.versionId)), workflowGraphValues(published));
  assert.equal((await origin(selected.workflowId)).requested_source_version_id, source.versionId);
  await work((client, identity) => publishWorkflow(client, identity, draft.versionId, connected.revision, 'Synthetic next source publication'));
  const historical = await copy(source.workflowId, input({ sourceVersionId: source.versionId }));
  assert.deepEqual(workflowGraphValues(await definition(historical.versionId)), workflowGraphValues(published));
  const latest = await copy(source.workflowId); assert.equal((await origin(latest.workflowId)).source_version_id, draft.versionId);
});

test('empty test-request workflows preserve zero text and Unicode code normalization, with replay after edits and retirement', async () => {
  const source = await create({ appliesTo: 'test_request', description: '0', code: 'Straße.' + randomUUID() });
  const original = await master(source.workflowId); const command = input(); const cloned = await copy(source.workflowId, command);
  const current = await master(cloned.workflowId); assert.equal(current.appliesTo, 'test_request'); assert.equal(current.description, '0');
  assert.equal(current.code, workflowCodeBase(`${original.code}-COPY`)); assert.equal((await definition(cloned.versionId)).states.length, 0);
  await work((client, identity) => saveWorkflowState(client, identity, cloned.versionId, cloned.revision, { code: 'new', name: 'Independent target edit' }));
  assert.equal((await definition(source.versionId)).states.length, 0);
  await work((client, identity) => updateWorkflowMaster(client, identity, { ...input(), id: source.workflowId, metadataRevision: 1, name: `Renamed source ${randomUUID()}`, code: randomUUID() }));
  for (const [id, metadataRevision] of [[source.workflowId, 2], [cloned.workflowId, 1]]) {
    await work((client, identity) => retireWorkflowMaster(client, identity, { ...input(), id, metadataRevision }));
  }
  assert.deepEqual(await copy(source.workflowId, command), cloned);
  await assert.rejects(copy(source.workflowId), { code: 'workflow_not_found' });
});

test('master cloning denies foreign sources or versions, readers, forged authority and changed retry identities', async () => {
  const source = await create(); const command = input(); const cloned = await copy(source.workflowId, command);
  await assert.rejects(copy(source.workflowId, input(), reader), { status: 403 });
  await assert.rejects(copy(source.workflowId, input(), foreign), { status: 404 });
  await assert.rejects(copy(source.workflowId, command, colleague), { code: 'save_request_reused' });
  await assert.rejects(copy(source.workflowId, { ...command, id: randomUUID() }), { code: 'save_request_reused' });
  await assert.rejects(copy(source.workflowId, { ...command, sourceVersionId: source.versionId }), { code: 'save_request_reused' });
  await assert.rejects(copy(randomUUID(), command), { code: 'save_request_reused' });
  await assert.rejects(copy(cloned.workflowId, command), { code: 'invalid_workflow_clone' });
  const unrelated = await create(); await assert.rejects(copy(source.workflowId, input({ sourceVersionId: unrelated.versionId })), { code: 'invalid_workflow_version' });
  const creationCommand = { ...input(), name: `Created once ${randomUUID()}`, metadataRevision: 0 };
  await work((client, identity) => createWorkflowMaster(client, identity, creationCommand));
  await assert.rejects(copy(source.workflowId, { id: creationCommand.id, requestId: creationCommand.requestId }), { code: 'save_request_reused' });
  await assert.rejects(work(async (client, identity) => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [colleague.userId]); return cloneWorkflowMaster(client, identity, source.workflowId, input());
  }), { code: 'forbidden' });
  assert.equal((await work((client) => client.query('SELECT * FROM workflow_clone_origins WHERE workflow_id=$1', [cloned.workflowId]), foreign, true)).rowCount, 0);
});

test('concurrent master clones serialize names and codes, while identical request retries create exactly once', async () => {
  const source = await create({ code: randomUUID() }); const original = await master(source.workflowId); const command = input();
  const repeated = await Promise.all([copy(source.workflowId, command), copy(source.workflowId, command)]);
  assert.deepEqual(repeated[0], repeated[1]);
  const copies = await Promise.all([copy(source.workflowId), copy(source.workflowId)]);
  const metadata = await Promise.all(copies.map((copy) => master(copy.workflowId)));
  assert.deepEqual(metadata.map((row) => row.name).sort(), [`${original.name} - Copy 2`, `${original.name} - Copy 3`]);
  const base = workflowCodeBase(`${original.code}-COPY`);
  assert.deepEqual(metadata.map((row) => row.code).sort(), [base + '-2', base + '-3']);
  assert.equal((await owner.query('SELECT count(*)::int n FROM workflow_clone_origins WHERE organization_id=$1 AND request_id=$2', [manager.organizationId, command.requestId])).rows[0].n, 1);
});

test('a source metadata change between the service read and locked copy rejects the stale operation without a partial target', async () => {
  const source = await create(); const original = await master(source.workflowId); const command = input();
  await assert.rejects(work((client, identity) => cloneWorkflowMaster({ async query(...args) {
    const result = await client.query(...args);
    if (args[0].startsWith('SELECT code,metadata_revision FROM workflows')) {
      await work((otherClient, otherIdentity) => updateWorkflowMaster(otherClient, otherIdentity,
        { ...input(), id: source.workflowId, metadataRevision: 1, name: 'Updated ' + original.name }), colleague);
    }
    return result;
  } }, identity, source.workflowId, command)), { code: 'stale_workflow_metadata' });
  await absent(command.id); assert.equal((await copy(source.workflowId, command)).workflowId, command.id);
});

test('a clone waiting on the organization lock rechecks revoked access before creating any target', async () => {
  const source = await create(); const command = input(); const lock = await owner.connect(); let pending; let pid;
  try {
    await lock.query('BEGIN'); await lock.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [manager.organizationId]);
    let signal; const started = new Promise((resolve) => { signal = resolve; });
    pending = work(async (client, identity) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; signal(); return cloneWorkflowMaster(client, identity, source.workflowId, command);
    }, colleague).then((result) => ({ result }), (error) => ({ error })).finally(signal);
    await started; assert.ok(pid); let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true);
    await lock.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='workflows.manage'", [manager.organizationId, colleague.roleId]);
    await lock.query('COMMIT'); assert.equal((await pending).error?.code, 'forbidden'); await absent(command.id);
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending; }
});

test('late asynchronous failures roll back metadata, graph and origins, and clone provenance is immutable', async () => {
  const source = await fixture(2); const command = input();
  await assert.rejects(work(async (client, identity) => {
    await cloneWorkflowMaster(client, identity, source.workflowId, command); throw new Error('Synthetic asynchronous failure after copy');
  }), /Synthetic asynchronous failure/);
  await absent(command.id); assert.equal(await origin(command.id), undefined);
  const saved = await copy(source.workflowId, command); assert.equal((await definition(saved.versionId)).transitions.length, 2);
  await assert.rejects(work((client) => client.query('UPDATE workflow_clone_origins SET source_revision=999 WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, saved.workflowId])), sqlError('42501'));
  await assert.rejects(work((client) => client.query('INSERT INTO workflow_clone_origins(organization_id) VALUES($1)', [manager.organizationId])), sqlError('42501'));
  await assert.rejects(owner.query('DELETE FROM workflow_clone_origins WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, saved.workflowId]), sqlError('55000'));
  await assert.rejects(work((client) => client.query('SELECT workflow_guard_clone_origin()')), sqlError('42501'));
  assert.deepEqual(await copy(source.workflowId, command), saved);
});

test('missing source versions and generated-name or legacy-description bounds fail without truncation or partial copies', async () => {
  const long = await create({ name: 'N'.repeat(200) }); const command = input();
  await assert.rejects(copy(long.workflowId, command), { code: 'workflow_clone_name_too_long' }); await absent(command.id);
  assert.equal((await master(long.workflowId)).name.length, 200);
  const id = randomUUID(); const code = randomUUID();
  await owner.query('INSERT INTO workflows(organization_id,id,code,name,description,applies_to) VALUES($1,$2,$3,$3,$4,$5)', [manager.organizationId, id, code, 'Unchanged legacy text '.repeat(600), 'sample']);
  const missing = input(); await assert.rejects(copy(id, missing), { code: 'workflow_version_required' }); await absent(missing.id);
  await owner.query('INSERT INTO workflow_versions(organization_id,workflow_id,number,created_by) VALUES($1,$2,1,$3)', [manager.organizationId, id, manager.userId]);
  const overlong = input(); await assert.rejects(copy(id, overlong), { code: 'invalid_workflow_input' }); await absent(overlong.id);
  assert.equal((await master(id)).description, 'Unchanged legacy text '.repeat(600));
});
