import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { closePool } from '../../src/db/pool.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { createWorkflowMaster, updateWorkflowMaster, retireWorkflowMaster, loadWorkflowMaster, listWorkflows } from '../../src/workflows/metadata.js';
import { workflowCodeBase } from '../../src/workflows/metadata-input.js';
import { saveWorkflowState } from '../../src/workflows/authoring.js';

const owner = ownerPool(); let manager; let reader; let foreign;
const account = async (options) => { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; };
const work = (action, actor = manager, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const input = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: `Synthetic workflow ${randomUUID()}`, ...changes });
const create = (value = input(), actor = manager) => work((client, identity) => createWorkflowMaster(client, identity, value), actor);
const load = (id, actor = reader, options) => work((client, identity) => loadWorkflowMaster(client, identity, id, options), actor, true);
const retire = (id, metadataRevision = 1) => ({ id, metadataRevision, requestId: randomUUID() });
const sqlError = (code) => (error) => (error.cause ?? error).code === code;
before(async () => {
  manager = await account({ permissions: ['workflows.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

async function category() {
  const id = randomUUID(); await owner.query('INSERT INTO sample_categories(organization_id,id,code,name,abbreviation) VALUES($1,$2,$3,$3,$3)', [manager.organizationId, id, id]);
  return id;
}
const assign = (client, categoryId, workflowId) => client.query('INSERT INTO sample_category_workflows(organization_id,sample_category_id,workflow_id,applies_to) VALUES($1,$2,$3,$4)', [manager.organizationId, categoryId, workflowId, 'sample']);
async function waitForLock(pid) {
  let waiting = false;
  for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
    waiting = (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(waiting, true, 'the command reached an actual database lock');
}

test('workflow metadata creation and exact retries retain actual authors and independent graph revisions', async () => {
  const command = input({ description: '0' }); const created = await create(command);
  assert.equal(created.metadataRevision, 1); assert.equal(created.revision, 1); assert.ok(created.versionId);
  assert.deepEqual(await create(command), created);
  const original = await load(command.id);
  assert.equal(original.createdBy, manager.userId); assert.equal(original.updatedBy, manager.userId);
  assert.equal(original.code, workflowCodeBase(command.name)); assert.equal(original.description, '0'); assert.equal(original.draftRevision, 1);
  const update = { id: command.id, requestId: randomUUID(), metadataRevision: 1, name: 'Renamed ' + command.name };
  const edited = await work((client, identity) => updateWorkflowMaster(client, identity, update));
  assert.equal(edited.metadataRevision, 2); assert.deepEqual(await work((client, identity) => updateWorkflowMaster(client, identity, update)), edited);
  assert.deepEqual(await create(command), created, 'retrying an old successful creation does not create a second graph or overwrite later edits');
  const next = await load(command.id); assert.equal(next.code, original.code); assert.equal(next.description, '0'); assert.equal(next.draftRevision, 1);
  assert.deepEqual(next.createdAt, original.createdAt); assert.equal(next.createdBy, original.createdBy);
  const historical = await load(command.id, reader, { atRevision: 1 }); assert.equal(historical.name, command.name); assert.equal(historical.savedBy, manager.userId);
  await work((client, identity) => saveWorkflowState(client, identity, created.versionId, 1, { code: 'initial', name: 'Initial', stateType: 'initial' }));
  assert.equal((await load(command.id)).metadataRevision, 2); assert.equal((await load(command.id)).draftRevision, 2);
  await assert.rejects(work((client, identity) => updateWorkflowMaster(client, identity, { ...update, description: 'Changed retry' })), { code: 'save_request_reused' });
  await assert.rejects(work((client, identity) => updateWorkflowMaster(client, identity, { ...update, requestId: randomUUID() })), { code: 'stale_workflow_metadata' });
});

test('active names retain source case sensitivity while code allocation and concurrent duplicates are serialized', async () => {
  const name = `Name ${randomUUID()}`;
  const first = input({ name }); const second = input({ name: name.toLowerCase() });
  await create(first); await create(second);
  assert.equal((await load(first.id)).code, workflowCodeBase(name)); assert.equal((await load(second.id)).code, workflowCodeBase(name) + '-2');
  await assert.rejects(create(input({ name })), { code: 'workflow_name_exists' });
  const duplicateName = `Concurrent ${randomUUID()}`;
  const attempts = await Promise.allSettled([0, 1].map(() => create(input({ name: duplicateName }))));
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((attempt) => attempt.status === 'rejected').reason.code, 'workflow_name_exists');
  const retired = retire(first.id); await work((client, identity) => retireWorkflowMaster(client, identity, retired));
  const replacement = input({ name }); await create(replacement);
  assert.equal((await load(replacement.id)).code, workflowCodeBase(name) + '-3', 'retired names can be reused, while stable codes remain reserved');
  const inactive = input({ active: false }); const value = await create(inactive); assert.ok(value.versionId);
  await assert.rejects(load(inactive.id), { code: 'workflow_not_found' }); assert.deepEqual(await create(inactive), value);
});

test('legacy revision-zero workflows keep unrecorded authors, duplicate names and unchanged long descriptions', async () => {
  const ids = [randomUUID(), randomUUID()]; const name = `Legacy duplicate ${randomUUID()}`; const description = 'Legacy description '.repeat(900);
  for (const id of ids) await owner.query('INSERT INTO workflows(organization_id,id,code,name,description,applies_to,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [manager.organizationId, id, id, name, description, 'sample', '2001-01-01T00:00:00Z']);
  const original = await load(ids[0]); assert.equal(original.metadataRevision, 0); assert.equal(original.createdBy, null); assert.equal(original.updatedAt, null);
  await assert.rejects(load(ids[0], reader, { atRevision: 1 }), { code: 'workflow_not_found' });
  await work((client, identity) => updateWorkflowMaster(client, identity, { id: ids[0], requestId: randomUUID(), metadataRevision: 0, name }));
  const updated = await load(ids[0]); assert.equal(updated.description, description); assert.equal(updated.createdBy, null); assert.deepEqual(updated.createdAt, original.createdAt);
  assert.equal((await load(ids[0], reader, { atRevision: 1 })).operation, 'update'); assert.equal((await load(ids[1])).metadataRevision, 0);
  await assert.rejects(create(input({ name })), { code: 'workflow_name_exists' });
});

test('retirement and type changes protect assigned workflows, while unchanged type allows ordinary details edits', async () => {
  const created = await create(); const categoryId = await category(); await work((client) => assign(client, categoryId, created.workflowId));
  const current = await load(created.workflowId);
  await assert.rejects(work((client, identity) => retireWorkflowMaster(client, identity, retire(created.workflowId))), { code: 'workflow_in_use' });
  await assert.rejects(work((client, identity) => updateWorkflowMaster(client, identity,
    { ...retire(created.workflowId), name: current.name, active: false })), { code: 'workflow_in_use' });
  await assert.rejects(work((client, identity) => updateWorkflowMaster(client, identity,
    { ...retire(created.workflowId), name: current.name, appliesTo: 'test_request' })), { code: 'workflow_type_immutable' });
  const updated = await work((client, identity) => updateWorkflowMaster(client, identity,
    { ...retire(created.workflowId), name: 'Updated ' + current.name, appliesTo: 'sample' }));
  assert.equal(updated.metadataRevision, 2);
  const unused = await create(); const command = retire(unused.workflowId);
  const result = await work((client, identity) => retireWorkflowMaster(client, identity, command));
  assert.deepEqual(await work((client, identity) => retireWorkflowMaster(client, identity, command)), result);
  await assert.rejects(load(unused.workflowId), { code: 'workflow_not_found' }); assert.equal((await load(unused.workflowId, reader, { atRevision: 2 })).active, false);
  await assert.rejects(work((client, identity) => saveWorkflowState(client, identity, unused.versionId, 1, { code: 'bad', name: 'Bad' })), { code: 'workflow_not_found' });
  await assert.rejects(work((client) => assign(client, categoryId, unused.workflowId)), sqlError('23514'));
});

test('workflow metadata remains tenant-scoped and rejects readers, forged sessions and direct history or metadata writes', async () => {
  const command = input(); await create(command);
  await assert.rejects(create(input(), reader), { status: 403 }); await assert.rejects(load(command.id, foreign), { status: 404 });
  await assert.rejects(load(command.id, foreign, { atRevision: 1 }), { status: 404 });
  await assert.rejects(work((client, identity) => updateWorkflowMaster(client, identity, { ...retire(command.id), name: command.name }), foreign), { status: 404 });
  await assert.rejects(work((client) => client.query('UPDATE workflows SET name=$3 WHERE organization_id=$1 AND id=$2', [manager.organizationId, command.id, 'Forged'])), sqlError('42501'));
  await assert.rejects(work((client) => client.query('UPDATE workflows SET metadata_revision=metadata_revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, command.id])), sqlError('23514'));
  await assert.rejects(work((client) => client.query('DELETE FROM workflows WHERE organization_id=$1 AND id=$2', [manager.organizationId, command.id])), sqlError('42501'));
  await assert.rejects(work((client) => client.query('UPDATE workflow_metadata_versions SET name=$3 WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, command.id, 'Forged'])), sqlError('42501'));
  await assert.rejects(owner.query('DELETE FROM workflow_metadata_versions WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, command.id]), sqlError('55000'));
  await assert.rejects(work(async (client, identity) => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [foreign.userId]);
    return updateWorkflowMaster(client, identity, { ...retire(command.id), name: command.name });
  }), { code: 'forbidden' });
  assert.equal((await load(command.id)).metadataRevision, 1);
});

test('workflow lists use two bounded queries with literal search, fuzzy text filters and stable empty pages', async () => {
  const command = input({ name: `Literal %_\\' ${randomUUID()}`, description: 'Specific long wording' }); await create(command);
  let queries = 0;
  const listed = await work((client, identity) => listWorkflows({ query(...args) { queries++; return client.query(...args); } }, identity, { search: "%_\\'" }), reader, true);
  assert.equal(queries, 2); assert.equal(listed.totalCount, 1); assert.equal(listed.rows[0]._id, command.id);
  assert.equal(listed.rows[0].draftVersionId, (await load(command.id)).draftVersionId);
  const filtered = await work((client, identity) => listWorkflows(client, identity, { filters: { description: { type: 'text', value: 'Specific wording' } },
    sort: { key: 'created_at', dir: 'desc' }, pageSize: 1 }), reader, true);
  assert.equal(filtered.rows[0]._id, command.id);
  const empty = await work((client, identity) => listWorkflows(client, identity, { search: command.name, page: 1_000_000 }), reader, true);
  assert.equal(empty.totalCount, 1); assert.deepEqual(empty.rows, []);
});

test('a metadata command waiting on the organization lock rechecks revoked authority before writing', async () => {
  const actor = await account({ permissions: ['workflows.manage'] }); const lock = await owner.connect(); const command = input(); let pending; let pid;
  try {
    await lock.query('BEGIN'); await lock.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [actor.organizationId]);
    let signal; const started = new Promise((resolve) => { signal = resolve; });
    pending = work(async (client, identity) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; signal(); return createWorkflowMaster(client, identity, command);
    }, actor).then((result) => ({ result }), (error) => ({ error })).finally(signal);
    await started; assert.ok(pid); await waitForLock(pid);
    await lock.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='workflows.manage'", [actor.organizationId, actor.roleId]);
    await lock.query('COMMIT'); assert.equal((await pending).error?.code, 'forbidden');
    assert.equal((await owner.query('SELECT count(*)::int n FROM workflows WHERE organization_id=$1 AND id=$2', [actor.organizationId, command.id])).rows[0].n, 0);
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending; }
});

test('both concurrent retirement and category assignment orders preserve the active-reference boundary', async () => {
  for (const referenceFirst of [true, false]) {
    const created = await create(); const categoryId = await category(); const command = retire(created.workflowId);
    let release; const gate = new Promise((resolve) => { release = resolve; });
    let signalPrepared; const prepared = new Promise((resolve) => { signalPrepared = resolve; }); let firstPrepared = false; let first; let second;
    try {
      first = work(async (client, identity) => {
        const result = referenceFirst ? await assign(client, categoryId, created.workflowId) : await retireWorkflowMaster(client, identity, command);
        firstPrepared = true; signalPrepared(); await gate; return result;
      }).then((result) => ({ result }), (error) => ({ error })).finally(signalPrepared);
      await prepared; assert.equal(firstPrepared, true);
      let signalStarted; const started = new Promise((resolve) => { signalStarted = resolve; }); let pid;
      second = work(async (client, identity) => {
        pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; signalStarted();
        return referenceFirst ? retireWorkflowMaster(client, identity, command) : assign(client, categoryId, created.workflowId);
      }).then((result) => ({ result }), (error) => ({ error })).finally(signalStarted);
      await started; assert.ok(pid); await waitForLock(pid); release();
      assert.ok((await first).result); const failure = (await second).error;
      if (referenceFirst) {
        assert.equal(failure?.code, 'workflow_in_use'); assert.equal((await load(created.workflowId)).active, true);
      } else {
        assert.equal(failure?.constraint, 'workflow_active_reference'); await assert.rejects(load(created.workflowId), { code: 'workflow_not_found' });
        assert.equal((await owner.query('SELECT count(*)::int n FROM sample_category_workflows WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, created.workflowId])).rows[0].n, 0);
      }
    } finally { release(); await first; await second; }
  }
});
