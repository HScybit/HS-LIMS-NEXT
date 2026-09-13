import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { closePool, transaction } from '../../src/db/pool.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, deleteWorkflowElement, publishWorkflow, cloneWorkflowDraft } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { cloneWorkflowMaster } from '../../src/workflows/master-clone.js';
import { retireWorkflowMaster } from '../../src/workflows/metadata.js';
import { workflowChecklistOptions } from '../../src/workflows/checklists.js';
import { createChecklist, updateChecklist, retireChecklist, loadChecklist } from '../../src/checklists/service.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { registerSample } from '../../src/samples/register.js';
import { loadWorkflowRun } from '../../src/workflows/load.js';
import { requestWorkflowTransition, approveWorkflowAssignment } from '../../src/workflows/requests.js';

const owner = ownerPool(); let manager; let checklistManager; let reader; let outsider;
const work = (callback, actor = manager, readOnly = false) => withSession(actor.token, callback, { csrfToken: actor.csrfToken, readOnly });
const sqlError = (code, constraint) => (error) => (error.cause ?? error).code === code && (!constraint || (error.cause ?? error).constraint === constraint);
async function account(options) { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; }
before(async () => {
  manager = await account({ permissions: ['workflows.manage'] });
  checklistManager = await account({ organizationId: manager.organizationId, permissions: ['checklists.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  outsider = await account({ permissions: ['workflows.manage', 'checklists.manage'] });
});
after(async () => { await closePool(); await owner.end(); });
async function master(changes = {}, actor = checklistManager) {
  const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: `Workflow checklist ${randomUUID()}`, isActive: true,
    items: [{ id: randomUUID(), prompt: 'Verify identity' }, { id: randomUUID(), prompt: '0' }], ...changes };
  await work((client, identity) => createChecklist(client, identity, input), actor); return input;
}
async function graph() {
  const workflow = await work((client, identity) => createWorkflow(client, identity, { code: randomUUID(), name: `Checklist graph ${randomUUID()}`, appliesTo: 'sample' }));
  const initial = await work((client, identity) => saveWorkflowState(client, identity, workflow.versionId, 1, { code: 'initial', name: 'Pending', stateType: 'initial' }));
  const final = await work((client, identity) => saveWorkflowState(client, identity, workflow.versionId, initial.revision, { code: 'final', name: 'Complete', stateType: 'final', isPositiveTermination: true }));
  return { ...workflow, revision: final.revision, input: { code: 'finish', name: 'Finish', sourceStateId: initial.id, targetStateId: final.id } };
}
async function bind(fixture, checklist, extra = {}) {
  const result = await work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision,
    { ...fixture.input, checklistMasterId: checklist.id, ...extra }, fixture.transitionId));
  return { ...fixture, revision: result.revision, transitionId: result.id };
}
const load = (fixture, actor = manager) => work((client, identity) => loadWorkflowDefinition(client, identity, fixture.versionId), actor, true);
async function waitForLock(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The authenticated command did not reach the expected database lock.');
}
async function observeWork(action, actor = manager) {
  let signalStarted; const started = new Promise((resolve) => { signalStarted = resolve; }); const observed = {};
  observed.pending = work(async (client, identity) => {
    observed.pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    signalStarted(); return action(client, identity);
  }, actor).then((result) => ({ result }), (error) => ({ error })).finally(signalStarted);
  await started; assert.ok(observed.pid, 'the authenticated callback started'); return observed;
}

test('workflow selection copies all current master prompts, records the version and keeps definition loading at eight queries', async () => {
  const checklist = await master({ items: Array.from({ length: 200 }, (_, index) => ({ id: randomUUID(), prompt: `Check ${index}` })) });
  const fixture = await bind(await graph(), checklist, { checklist: [{ prompt: 'Untrusted inline copy', isRequired: false }] });
  const definition = await work(async (client, identity) => {
    let queries = 0; const observed = { query(...args) { queries++; return client.query(...args); } };
    const result = await loadWorkflowDefinition(observed, identity, fixture.versionId); assert.equal(queries, 8); return result;
  }, reader, true);
  const edge = definition.transitions[0]; assert.equal(edge.checklistMasterId, checklist.id); assert.equal(edge.checklistMasterRevision, 1);
  assert.deepEqual(edge.checklist.map((item) => item.prompt), checklist.items.map((item) => item.prompt)); assert(edge.checklist.every((item) => item.isRequired));
  assert(edge.checklist.every((item) => !checklist.items.some((source) => source.id === item.id)));
  assert.equal((await work((client) => client.query('SELECT * FROM checklists'))).rowCount, 0);
  await assert.rejects(work((client, identity) => loadChecklist(client, identity, checklist.id)), { code: 'forbidden' });
});

test('workflow edits distinguish explicit refresh, omitted binding, conflicting inline changes and detachment', async () => {
  const checklist = await master(); let fixture = await bind(await graph(), checklist); const first = (await load(fixture)).transitions[0];
  await work((client, identity) => updateChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 1,
    items: [{ id: checklist.items[1].id, prompt: 'New prompt' }, { id: checklist.items[0].id, prompt: 'Changed identity check' }] }), checklistManager);
  const omitted = await work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision, { ...fixture.input, name: 'Renamed' }, fixture.transitionId));
  fixture = { ...fixture, revision: omitted.revision };
  assert.deepEqual((await load(fixture)).transitions[0].checklist, first.checklist); assert.equal((await load(fixture)).transitions[0].checklistMasterRevision, 1);
  const same = await work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision,
    { ...fixture.input, checklist: first.checklist.map(({ id, prompt, isRequired }) => ({ id, prompt, isRequired })) }, fixture.transitionId));
  fixture = { ...fixture, revision: same.revision }; assert.deepEqual((await load(fixture)).transitions[0].checklist, first.checklist);
  await assert.rejects(work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision,
    { ...fixture.input, checklist: [{ prompt: 'Changed inline' }] }, fixture.transitionId)), { code: 'bound_workflow_checklist' });
  fixture = await bind(fixture, checklist); const refreshed = (await load(fixture)).transitions[0];
  assert.equal(refreshed.checklistMasterRevision, 2); assert.deepEqual(refreshed.checklist.map((item) => item.prompt), ['New prompt', 'Changed identity check']);
  assert(refreshed.checklist.every((item) => !first.checklist.some((old) => old.id === item.id)));
  const detached = await work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision,
    { ...fixture.input, checklistMasterId: null, checklist: refreshed.checklist.map(({ id, prompt }) => ({ id, prompt, isRequired: false })) }, fixture.transitionId));
  fixture = { ...fixture, revision: detached.revision }; const edge = (await load(fixture)).transitions[0];
  assert.equal(edge.checklistMasterId, null); assert.equal(edge.checklistMasterRevision, null); assert(edge.checklist.every((item) => !item.isRequired));
  await work((client, identity) => retireChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 2 }), checklistManager);
});

test('published snapshots and both clone commands preserve old master versions through edits and deactivation', async () => {
  const checklist = await master(); const fixture = await bind(await graph(), checklist);
  await work((client, identity) => publishWorkflow(client, identity, fixture.versionId, fixture.revision, 'Frozen checklist evidence'));
  const original = await load(fixture);
  await work((client, identity) => updateChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 1, isActive: false,
    items: [{ id: checklist.items[0].id, prompt: 'Later master text' }] }), checklistManager);
  const same = await work((client, identity) => cloneWorkflowDraft(client, identity, fixture.versionId));
  const other = await work((client, identity) => cloneWorkflowMaster(client, identity, fixture.workflowId, { id: randomUUID(), requestId: randomUUID(), sourceVersionId: fixture.versionId }));
  for (const copy of [same, other]) {
    const cloned = (await load(copy)).transitions[0]; assert.equal(cloned.checklistMasterId, checklist.id); assert.equal(cloned.checklistMasterRevision, 1);
    assert.deepEqual(cloned.checklist.map((item) => item.prompt), original.transitions[0].checklist.map((item) => item.prompt));
    assert.notEqual(cloned.checklist[0].id, original.transitions[0].checklist[0].id);
  }
  assert.deepEqual(await load(fixture), original);
  await assert.rejects(work((client, identity) => retireChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 2 }), checklistManager), { code: 'checklist_in_use' });
  const draft = await load(same); const edge = draft.transitions[0];
  await assert.rejects(work((client, identity) => saveWorkflowTransition(client, identity, same.versionId, 1,
    { ...fixture.input, sourceStateId: edge.sourceStateId, targetStateId: edge.targetStateId, checklistMasterId: checklist.id }, edge.id)), { code: 'invalid_workflow_checklist' });
});

test('unversioned master snapshots stay explicit and reproducible after a first real master edit and cloning', async () => {
  const checklist = { id: randomUUID(), name: `Imported checklist ${randomUUID()}` };
  await owner.query('INSERT INTO checklists(organization_id,id,name) VALUES($1,$2,$3)', [manager.organizationId, checklist.id, checklist.name]);
  await owner.query('INSERT INTO checklist_items(organization_id,checklist_id,id,prompt,display_order) VALUES($1,$2,$3,$4,4)', [manager.organizationId, checklist.id, randomUUID(), 'Original imported text']);
  const fixture = await bind(await graph(), checklist); const edge = (await load(fixture)).transitions[0];
  assert.equal(edge.checklistMasterRevision, null); assert.equal(edge.checklist[0].displayOrder, 0);
  assert.equal((await owner.query('SELECT count(*)::integer AS n FROM checklist_versions WHERE checklist_id=$1', [checklist.id])).rows[0].n, 0);
  await work((client, identity) => publishWorkflow(client, identity, fixture.versionId, fixture.revision, 'Imported snapshot'));
  await work((client, identity) => updateChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 0,
    items: [{ id: randomUUID(), prompt: 'First newly saved text' }] }), checklistManager);
  for (const copy of [await work((client, identity) => cloneWorkflowDraft(client, identity, fixture.versionId)),
    await work((client, identity) => cloneWorkflowMaster(client, identity, fixture.workflowId, { id: randomUUID(), requestId: randomUUID(), sourceVersionId: fixture.versionId }))]) {
    const cloned = (await load(copy)).transitions[0]; assert.equal(cloned.checklistMasterRevision, null); assert.equal(cloned.checklist[0].prompt, 'Original imported text');
  }
});

test('workflow metadata lookups are bounded, tenant scoped and retain selected inactive labels without master grants', async () => {
  const prefix = `Lookup ${randomUUID()}`; const ids = Array.from({ length: 105 }, () => randomUUID());
  await owner.query('INSERT INTO checklists(organization_id,id,name) SELECT $1,id,$3||ordinal::text FROM unnest($2::uuid[]) WITH ORDINALITY items(id,ordinal)', [manager.organizationId, ids, prefix]);
  const inactive = await master({ isActive: false });
  const result = await work((client, identity) => workflowChecklistOptions(client, identity, { search: prefix, selectedIds: [inactive.id] }), reader, true);
  assert.equal(result.rows.length, 100); assert.equal(result.hasMore, true); assert.deepEqual(result.selected.map(({ id, isActive }) => ({ id, isActive })), [{ id: inactive.id, isActive: false }]);
  assert.equal(Object.hasOwn(result.selected[0], 'items'), false);
  assert.deepEqual((await work((client, identity) => workflowChecklistOptions(client, identity, { search: prefix, selectedIds: [inactive.id] }), outsider, true)).selected, []);
  await assert.rejects(work(workflowChecklistOptions, checklistManager, true), { code: 'forbidden' });
  assert.equal((await work((client) => client.query('SELECT * FROM workflow_checklist_labels'), checklistManager, true)).rowCount, 0);
  assert.equal((await owner.query("SELECT has_table_privilege('sampleify_report_worker','workflow_checklist_labels','SELECT') AS allowed")).rows[0].allowed, false);
});

test('a native version of unchanged imported prompts preserves raw text and maps gapped master order into a dense workflow copy', async () => {
  const checklist = { id: randomUUID(), name: `Gapped imported checklist ${randomUUID()}` };
  await owner.query('INSERT INTO checklists(organization_id,id,name) VALUES($1,$2,$3)', [manager.organizationId, checklist.id, checklist.name]);
  await owner.query('INSERT INTO checklist_items(organization_id,checklist_id,id,prompt,display_order) VALUES($1,$2,$3,$4,4),($1,$2,$5,$6,9)',
    [manager.organizationId, checklist.id, randomUUID(), '  Original raw text  ', randomUUID(), '0']);
  await work((client, identity) => updateChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 0, name: checklist.name }), checklistManager);
  const fixture = await bind(await graph(), checklist); const original = (await load(fixture)).transitions[0];
  assert.equal(original.checklistMasterRevision, 1); assert.deepEqual(original.checklist.map((item) => item.displayOrder), [0, 1]);
  assert.deepEqual(original.checklist.map((item) => item.prompt), ['  Original raw text  ', '0']);
  await work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision,
    { ...fixture.input, checklist: original.checklist.map(({ id, prompt, isRequired }) => ({ id, prompt, isRequired })) }, fixture.transitionId));
  assert.deepEqual((await load(fixture)).transitions[0].checklist, original.checklist);
});

test('workflow checklist selection rejects inactive, retired, foreign and invalid legacy masters atomically', async () => {
  const inactive = await master({ isActive: false }); const retired = await master(); const foreign = await master({}, outsider);
  await work((client, identity) => retireChecklist(client, identity, { id: retired.id, requestId: randomUUID(), revision: 1 }), checklistManager);
  const empty = { id: randomUUID() }; await owner.query('INSERT INTO checklists(organization_id,id,name) VALUES($1,$2,$3)', [manager.organizationId, empty.id, 'Empty imported checklist']);
  const fixture = await graph();
  for (const value of [inactive, retired, foreign, empty, { id: randomUUID() }]) await assert.rejects(bind(fixture, value), { code: 'invalid_workflow_checklist' });
  const definition = await load(fixture); assert.equal(definition.version.revision, fixture.revision); assert.deepEqual(definition.transitions, []);
  await assert.rejects(transaction(async (client) => {
    await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [manager.organizationId, manager.userId]);
    await client.query('SELECT * FROM workflow_select_checklist($1)', [inactive.id]);
  }), sqlError('42501', 'workflow_metadata_session_required'));
  await assert.rejects(work((client) => client.query('SELECT * FROM workflow_select_checklist($1)', [inactive.id]), reader), sqlError('42501', 'workflow_metadata_session_required'));
});

test('database constraints deny forged native snapshots, missing items and deletion of referenced or retired-workflow masters', async () => {
  const checklist = await master(); const fixture = await bind(await graph(), checklist); const original = await load(fixture);
  for (const sql of [
    'UPDATE workflow_transition_checklist_items SET prompt=\'Forged\' WHERE organization_id=$1 AND transition_id=$2',
    'UPDATE workflow_transition_checklist_items SET is_required=false WHERE organization_id=$1 AND transition_id=$2',
    'UPDATE workflow_transition_checklist_items SET display_order=display_order+10 WHERE organization_id=$1 AND transition_id=$2',
    'DELETE FROM workflow_transition_checklist_items WHERE organization_id=$1 AND transition_id=$2',
  ]) await assert.rejects(work((client) => client.query(sql, [manager.organizationId, fixture.transitionId])), sqlError('23514', 'workflow_checklist_snapshot'));
  await assert.rejects(work((client) => client.query(`INSERT INTO workflow_transition_checklist_items(organization_id,id,transition_id,prompt,is_required,display_order)
    VALUES($1,$2,$3,$4,true,2)`, [manager.organizationId, randomUUID(), fixture.transitionId, checklist.items[0].prompt])), sqlError('23514', 'workflow_checklist_snapshot'));
  const different = await master({ items: [{ id: randomUUID(), prompt: 'A different snapshot' }] });
  await assert.rejects(work((client) => client.query('UPDATE workflow_transitions SET checklist_master_id=$3 WHERE organization_id=$1 AND id=$2',
    [manager.organizationId, fixture.transitionId, different.id])), sqlError('23514', 'workflow_checklist_snapshot'));
  await assert.rejects(work((client) => client.query('UPDATE workflow_transitions SET checklist_master_revision=999 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.transitionId])), sqlError('23503'));
  assert.deepEqual(await load(fixture), original);
  await work(async (client) => {
    const item = original.transitions[0].checklist[0];
    await client.query('DELETE FROM workflow_transition_checklist_items WHERE organization_id=$1 AND id=$2', [manager.organizationId, item.id]);
    await client.query(`INSERT INTO workflow_transition_checklist_items(organization_id,id,transition_id,prompt,is_required,display_order)
      VALUES($1,$2,$3,$4,true,0)`, [manager.organizationId, item.id, fixture.transitionId, item.prompt]);
  });
  assert.deepEqual(await load(fixture), original);
  await work((client, identity) => retireWorkflowMaster(client, identity, { id: fixture.workflowId, requestId: randomUUID(), metadataRevision: 1 }));
  await assert.rejects(work((client, identity) => retireChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 1 }), checklistManager), { code: 'checklist_in_use' });
});

test('deleting a bound draft connection releases its checklist reference without deleting checklist history', async () => {
  const checklist = await master(); const fixture = await bind(await graph(), checklist);
  await work((client, identity) => deleteWorkflowElement(client, identity, fixture.versionId, fixture.revision, { type: 'transition', id: fixture.transitionId }));
  await work((client, identity) => retireChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 1 }), checklistManager);
  assert.equal((await work((client, identity) => loadChecklist(client, identity, checklist.id, { atRevision: 1 }), checklistManager, true)).items.length, 2);
});

test('a committed workflow binding prevents a checklist retirement that was waiting on its shared head lock', async () => {
  const checklist = await master(); const fixture = await graph(); let release; let signalSaved; let retirement;
  const gate = new Promise((resolve) => { release = resolve; }); const saved = new Promise((resolve) => { signalSaved = resolve; });
  const binding = work(async (client, identity) => {
    const result = await saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision, { ...fixture.input, checklistMasterId: checklist.id });
    signalSaved(); await gate; return result;
  }).then((result) => ({ result }), (error) => ({ error })).finally(signalSaved);
  try {
    await saved;
    retirement = await observeWork((client, identity) => retireChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 1 }), checklistManager);
    await waitForLock(retirement.pid); release(); assert.ok((await binding).result);
    assert.equal((await retirement.pending).error?.code, 'checklist_in_use');
    assert.equal((await load(fixture)).transitions[0].checklistMasterRevision, 1);
    assert.equal((await work((client, identity) => loadChecklist(client, identity, checklist.id), checklistManager, true)).revision, 1);
  } finally { release(); await binding; await retirement?.pending; }
});

test('selection waiting for a checklist edit reads one current revision and rejects prior retirement or deactivation', async () => {
  for (const operation of ['edit', 'deactivate', 'retire']) {
    const checklist = await master(); const fixture = await graph(); let release; let signalSaved; let binding;
    const gate = new Promise((resolve) => { release = resolve; }); const saved = new Promise((resolve) => { signalSaved = resolve; });
    const change = work(async (client, identity) => {
      const input = { id: checklist.id, requestId: randomUUID(), revision: 1 };
      const result = operation === 'retire' ? await retireChecklist(client, identity, input)
        : await updateChecklist(client, identity, { ...input, ...(operation === 'deactivate' ? { isActive: false }
          : { items: [{ id: checklist.items[0].id, prompt: 'Current committed prompt' }] }) });
      signalSaved(); await gate; return result;
    }, checklistManager).then((result) => ({ result }), (error) => ({ error })).finally(signalSaved);
    try {
      await saved;
      binding = await observeWork((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision, { ...fixture.input, checklistMasterId: checklist.id }));
      await waitForLock(binding.pid); release(); assert.ok((await change).result);
      const result = await binding.pending; const current = await load(fixture);
      if (operation === 'edit') {
        assert.ok(result.result); assert.equal(current.transitions[0].checklistMasterRevision, 2);
        assert.deepEqual(current.transitions[0].checklist.map((item) => item.prompt), ['Current committed prompt']);
      } else {
        assert.equal(result.error?.code, 'invalid_workflow_checklist'); assert.deepEqual(current.transitions, []);
        assert.equal(current.version.revision, fixture.revision);
      }
    } finally { release(); await change; await binding?.pending; }
  }
});

test('checklist selection rechecks revoked workflow authority after waiting on the actual master lock', async () => {
  const actor = await account({ organizationId: manager.organizationId, permissions: ['workflows.manage'] });
  const checklist = await master(); const fixture = await graph(); const lock = await owner.connect(); let binding;
  try {
    await lock.query('BEGIN'); await lock.query('SELECT id FROM checklists WHERE id=$1 FOR UPDATE', [checklist.id]);
    binding = await observeWork((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.revision,
      { ...fixture.input, checklistMasterId: checklist.id }), actor);
    await waitForLock(binding.pid);
    await lock.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='workflows.manage'", [actor.organizationId, actor.roleId]);
    await lock.query('COMMIT'); assert.equal((await binding.pending).error?.code, 'forbidden');
    const current = await load(fixture); assert.deepEqual(current.transitions, []); assert.equal(current.version.revision, fixture.revision);
  } finally { await lock.query('ROLLBACK'); lock.release(); await binding?.pending; }
});

test('concurrent graph edits preserve a single complete binding and explicit null can clear its entire inline copy', async () => {
  const checklists = await Promise.all([master(), master()]); const fixture = await graph();
  const outcomes = await Promise.allSettled(checklists.map((checklist) => bind(fixture, checklist)));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'stale_workflow_definition');
  const winner = outcomes.find((outcome) => outcome.status === 'fulfilled').value; const original = await load(winner);
  assert.equal(original.transitions.length, 1); assert.equal(original.transitions[0].checklist.length, 2);
  await work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, winner.revision,
    { ...fixture.input, checklistMasterId: null }, winner.transitionId));
  const cleared = (await load(fixture)).transitions[0]; assert.equal(cleared.checklistMasterId, null); assert.equal(cleared.checklistMasterRevision, null); assert.deepEqual(cleared.checklist, []);
});

test('actual requests and approvals keep frozen master prompts and independently attributed checked answers after later edits', async () => {
  const operator = await account({ organizationId: manager.organizationId, permissions: ['samples.create', 'samples.manage', 'samples.read'] });
  const approver = await account({ organizationId: manager.organizationId, permissions: ['approvals.respond'] });
  const checklist = await master(); const fixture = await bind(await graph(), checklist, { approvalMode: 'any', creatorRoleIds: [operator.roleId],
    approverStages: [{ stageNumber: 1, roleIds: [approver.roleId] }] });
  await work((client, identity) => publishWorkflow(client, identity, fixture.versionId, fixture.revision, 'Frozen master checklist'));
  const laboratory = await createLaboratoryFixture(owner, operator, { workflow: false });
  await owner.query("INSERT INTO sample_category_workflows(organization_id,sample_category_id,workflow_id,applies_to,is_default) VALUES($1,$2,$3,'sample',true)",
    [operator.organizationId, laboratory.category.id, fixture.workflowId]);
  const sample = await work((client, identity) => registerSample(client, identity, laboratory.registration), operator);
  const readRun = (actor = operator) => work((client, identity) => loadWorkflowRun(client, identity, sample.workflowRunId), actor, true);
  const run = await readRun(); const checks = run.transitions[0].checklistItems;
  assert.deepEqual(checks.map((item) => item.label), checklist.items.map((item) => item.prompt));
  assert.equal((await owner.query('SELECT count(*)::integer AS n FROM workflow_checklist_answers WHERE transition_id=$1', [fixture.transitionId])).rows[0].n, 0);
  await work((client, identity) => updateChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 1,
    items: [{ id: randomUUID(), prompt: 'Text saved after the workflow was published' }] }), checklistManager);
  const input = { revision: run.revision, transitionId: fixture.transitionId, comment: 'Actual request', checklistItemIds: checks.map((item) => item.id) };
  await assert.rejects(work((client, identity) => requestWorkflowTransition(client, identity, sample.workflowRunId, { ...input, checklistItemIds: [] }), operator), { code: 'workflow_checklist_required' });
  await work((client, identity) => requestWorkflowTransition(client, identity, sample.workflowRunId, input), operator);
  await work((client, identity) => updateChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 2, isActive: false }), checklistManager);
  const pending = (await readRun(approver)).approvalRequest;
  assert.deepEqual(pending.checklistItems.map(({ label, isChecked }) => ({ label, isChecked })), checks.map(({ label }) => ({ label, isChecked: true })));
  assert.deepEqual(pending.approvalRows[0].checklistItems, []);
  await assert.rejects(work((client, identity) => approveWorkflowAssignment(client, identity, pending.assignmentId,
    { comment: 'Missing actual answers', checklistItemIds: [] }), approver), { code: 'workflow_checklist_required' });
  await work((client, identity) => approveWorkflowAssignment(client, identity, pending.assignmentId,
    { comment: 'Actual approval', checklistItemIds: checks.map((item) => item.id) }), approver);
  const completed = await readRun(approver); assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.approvalRequest.approvalRows[0].checklistItems.map(({ label, isChecked }) => ({ label, isChecked })), checks.map(({ label }) => ({ label, isChecked: true })));
  const requestAnswers = (await owner.query(`SELECT history.actor_user_id,answer.checklist_item_id,answer.is_checked
    FROM workflow_checklist_answers answer JOIN workflow_run_history history ON history.organization_id=answer.organization_id AND history.id=answer.history_id
    WHERE answer.transition_id=$1 ORDER BY answer.checklist_item_id`, [fixture.transitionId])).rows;
  assert.deepEqual(requestAnswers, checks.map((item) => ({ actor_user_id: operator.userId, checklist_item_id: item.id, is_checked: true })).sort((a, b) => a.checklist_item_id.localeCompare(b.checklist_item_id)));
  const decisionAnswers = (await owner.query(`SELECT decision.decided_by,answer.checklist_item_id,answer.is_checked
    FROM approval_decision_checklist_answers answer JOIN approval_decisions decision ON decision.organization_id=answer.organization_id AND decision.id=answer.decision_id
    WHERE answer.transition_id=$1 ORDER BY answer.checklist_item_id`, [fixture.transitionId])).rows;
  assert.deepEqual(decisionAnswers, checks.map((item) => ({ decided_by: approver.userId, checklist_item_id: item.id, is_checked: true })).sort((a, b) => a.checklist_item_id.localeCompare(b.checklist_item_id)));
  assert.equal((await load(fixture)).transitions[0].checklistMasterRevision, 1);
});
