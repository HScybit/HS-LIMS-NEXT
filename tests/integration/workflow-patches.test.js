import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createTemplate } from '../../src/templates/authoring.js';
import { createChecklist, updateChecklist } from '../../src/checklists/service.js';
import { patchWorkflowState, patchWorkflowTransition, cloneWorkflowDraft, publishWorkflow } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';

const owner = ownerPool(); let manager; let author; let reader; let foreign;
const account = async (options) => { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; };
const work = (action, actor = manager, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const load = (versionId) => work((client, identity) => loadWorkflowDefinition(client, identity, versionId), manager, true);
before(async () => {
  manager = await account({ permissions: ['workflows.manage'] });
  author = await account({ organizationId: manager.organizationId, permissions: ['templates.manage', 'checklists.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  foreign = await account({ permissions: ['workflows.manage'] });
});
after(async () => { await closePool(); await owner.end(); });
async function graph({ edges = 5, inactiveReferences = false } = {}) {
  const roleId = randomUUID();
  // Synthetic reference roles grant no authority to any account.
  await owner.query('INSERT INTO roles(organization_id,id,name) VALUES($1,$2,$3)', [manager.organizationId, roleId, `Patch reference ${roleId}`]);
  const template = await work((client, identity) => createTemplate(client, identity, { name: `Patch template ${randomUUID()}`, kind: 'datasheet' }), author);
  const source = await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges, roleId, templateId: template.templateId }));
  const draft = await work((client, identity) => cloneWorkflowDraft(client, identity, source.versionId));
  if (inactiveReferences) {
    await owner.query('UPDATE roles SET active=false WHERE organization_id=$1 AND id=$2', [manager.organizationId, roleId]);
    await work((client, identity) => client.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=$2', [manager.organizationId, template.templateId]), author);
  }
  return { ...draft, sourceVersionId: source.versionId, roleId, templateId: template.templateId, definition: await load(draft.versionId) };
}
const statePatch = (graph, id, input, revision = graph.revision, actor = manager) => work((client, identity) => patchWorkflowState(client, identity, graph.versionId, revision, id, input), actor);
const transitionPatch = (graph, id, input, revision = graph.revision, actor = manager) => work((client, identity) => patchWorkflowTransition(client, identity, graph.versionId, revision, id, input), actor);
const contents = ({ states, transitions }) => ({ states, transitions });

test('metadata patches preserve inactive references, NULL layout, hidden flags and all five typed condition cases', async () => {
  const fixture = await graph({ inactiveReferences: true }); const before = fixture.definition;
  const published = contents(await load(fixture.sourceVersionId)); let revision = 1;
  const state = before.states[1]; assert.equal(state.canvasY, null); assert.equal(state.badgeStyle, null);
  const changed = { name: 'Renamed node', showSampleEdit: false };
  revision = (await statePatch(fixture, state.id, changed, revision)).revision;
  for (const transition of before.transitions) {
    await work(async (client, identity) => {
      let count = 0; const observed = { query(...args) { count++; return client.query(...args); } };
      revision = (await patchWorkflowTransition(observed, identity, fixture.versionId, revision, transition.id, { name: `Renamed ${transition.code}` })).revision;
      assert.equal(count, 6);
    });
  }
  const after = await load(fixture.versionId);
  assert.deepEqual(after.states, before.states.map((entry) => entry.id === state.id ? { ...entry, ...changed } : entry));
  assert.deepEqual(after.transitions, before.transitions.map((entry) => ({ ...entry, name: `Renamed ${entry.code}` })));
  assert.deepEqual(contents(await load(fixture.sourceVersionId)), published);
  assert.equal(after.version.revision, revision);
  await assert.rejects(statePatch(fixture, state.id, { templateId: fixture.templateId }, revision), { code: 'invalid_workflow_template' });
  await assert.rejects(statePatch(fixture, state.id, { accessRoleIds: [fixture.roleId] }, revision), { code: 'invalid_workflow_role' });
  assert.deepEqual(contents(await load(fixture.versionId)), contents(after));
});

test('explicit state capability changes and clears leave every other family and column intact', async () => {
  const fixture = await graph(); const stateId = fixture.definition.states[1].id;
  // Hidden legacy capabilities are not fields in the node editor.
  await work((client, identity) => client.query(`INSERT INTO workflow_state_capability_roles(organization_id,workflow_state_id,capability,role_id)
    SELECT $1,$2,capability,$3 FROM unnest(ARRAY['review','approve','cancel']) AS capability`, [identity.organization_id, stateId, fixture.roleId]));
  const before = await load(fixture.versionId); const state = before.states[1];
  const input = { accessRoleIds: [], editRoleIds: [manager.roleId], allocateRoleIds: [author.roleId], templateId: null, canvasX: 0, showAddResult: false };
  const result = await statePatch(fixture, state.id, input); assert.equal(result.revision, 2);
  const after = await load(fixture.versionId); const saved = after.states.find((entry) => entry.id === state.id);
  const { capabilityRoles, ...columns } = saved;
  assert.deepEqual(columns, { ...Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'capabilityRoles')), templateId: null, canvasX: 0, showAddResult: false });
  assert.deepEqual([...capabilityRoles].sort((a, b) => a.capability.localeCompare(b.capability)),
    [{ capability: 'allocate', roleId: author.roleId }, { capability: 'approve', roleId: fixture.roleId }, { capability: 'cancel', roleId: fixture.roleId },
      { capability: 'edit', roleId: manager.roleId }, { capability: 'review', roleId: fixture.roleId }]);
  assert.deepEqual(after.transitions, before.transitions);
  const unchanged = contents(after);
  for (const input of [{ name: 'Must roll back', editRoleIds: [foreign.roleId] }, { name: 'Must roll back', templateId: randomUUID() }, {}]) {
    await assert.rejects(statePatch(fixture, state.id, input, 2)); assert.deepEqual(contents(await load(fixture.versionId)), unchanged);
  }
});

test('connection patches preserve sparse approval stages and copied checklist history until explicitly changed', async () => {
  const fixture = await graph(); const transition = fixture.definition.transitions[0]; let revision = 1;
  const checklist = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Patch checklist', isActive: true, items: [{ id: randomUUID(), prompt: 'Original prompt' }] };
  await work((client, identity) => createChecklist(client, identity, checklist), author);
  revision = (await transitionPatch(fixture, transition.id, { checklistMasterId: checklist.id }, revision)).revision;
  const bound = (await load(fixture.versionId)).transitions[0]; assert.equal(bound.checklistMasterRevision, 1);
  await work((client, identity) => updateChecklist(client, identity, { ...checklist, requestId: randomUUID(), revision: 1,
    items: [{ ...checklist.items[0], prompt: 'New master prompt' }] }), author);
  revision = (await transitionPatch(fixture, transition.id, { ccEmails: ['New@Example.invalid'], requireComment: false, approvalMode: 'sequential' }, revision)).revision;
  const unchanged = (await load(fixture.versionId)).transitions[0];
  assert.deepEqual(unchanged, { ...bound, ccEmails: ['new@example.invalid'], requireComment: false });
  await assert.rejects(transitionPatch(fixture, transition.id, { approvalMode: 'all' }, revision), { status: 400 });
  revision = (await transitionPatch(fixture, transition.id, { approvalMode: 'all', approverStages: [{ stageNumber: 1, roleIds: [manager.roleId] }], creatorRoleIds: [], ccRoleIds: [] }, revision)).revision;
  const roles = (await load(fixture.versionId)).transitions[0];
  assert.deepEqual(roles, { ...unchanged, approvalMode: 'all', approverStages: [{ stageNumber: 1, roleIds: [manager.roleId] }], creatorRoleIds: [], ccRoleIds: [] });
  revision = (await transitionPatch(fixture, transition.id, { checklistMasterId: checklist.id, autoMoveMode: 'all_trs_allocated' }, revision)).revision;
  const refreshed = (await load(fixture.versionId)).transitions[0];
  assert.equal(refreshed.checklistMasterRevision, 2); assert.equal(refreshed.checklist[0].prompt, 'New master prompt');
  assert.equal(refreshed.autoExecute, false); assert.equal(refreshed.autoMoveMode, 'all_trs_allocated');
  assert.deepEqual(refreshed.conditions, transition.conditions);
  await work((client, identity) => updateChecklist(client, identity, { ...checklist, requestId: randomUUID(), revision: 2, isActive: false,
    items: [{ ...checklist.items[0], prompt: 'Inactive master prompt' }] }), author);
  revision = (await transitionPatch(fixture, transition.id, { name: 'Keep inactive checklist copy' }, revision)).revision;
  assert.deepEqual((await load(fixture.versionId)).transitions[0].checklist, refreshed.checklist);
  await assert.rejects(transitionPatch(fixture, transition.id, { checklistMasterId: checklist.id }, revision), { code: 'invalid_workflow_checklist' });
  await transitionPatch(fixture, transition.id, { checklistMasterId: null }, revision);
  const cleared = (await load(fixture.versionId)).transitions[0];
  assert.equal(cleared.checklistMasterId, null); assert.equal(cleared.checklistMasterRevision, null); assert.deepEqual(cleared.checklist, []);
  assert.deepEqual(cleared.conditions, transition.conditions);
});

test('port reduction removes affected connections and all dependent draft details without changing published history', async () => {
  const fixture = await graph(); const before = fixture.definition; const state = before.states[1];
  const published = contents(await load(fixture.sourceVersionId));
  const removed = before.transitions.filter((entry) => entry.sourceStateId === state.id || entry.targetStateId === state.id).map((entry) => entry.id);
  assert.equal(removed.length, 2);
  await statePatch(fixture, state.id, { inputCount: 0, outputCount: 0 });
  const after = await load(fixture.versionId);
  assert.deepEqual(after.transitions, before.transitions.filter((entry) => !removed.includes(entry.id)));
  assert.deepEqual(after.states, before.states.map((entry) => entry.id === state.id ? { ...entry, inputCount: 0, outputCount: 0 } : entry));
  for (const table of ['workflow_transition_creator_roles', 'workflow_transition_approver_roles', 'workflow_transition_cc_roles', 'workflow_transition_cc_emails', 'workflow_transition_conditions', 'workflow_transition_checklist_items']) {
    assert.equal((await owner.query(`SELECT count(*)::integer count FROM ${table} WHERE organization_id=$1 AND transition_id=ANY($2::uuid[])`, [manager.organizationId, removed])).rows[0].count, 0);
  }
  assert.deepEqual(contents(await load(fixture.sourceVersionId)), published);
  const transition = after.transitions[0];
  await assert.rejects(transitionPatch(fixture, transition.id, { targetStateId: state.id }, 2), { code: 'invalid_workflow_port' });
  await assert.rejects(transitionPatch(fixture, transition.id, { targetStateId: randomUUID() }, 2), { code: 'invalid_workflow_state' });
  assert.deepEqual(contents(await load(fixture.versionId)), contents(after));
});

test('patches reject stale, foreign, reader and published writes and roll back details on a conflicting code', async () => {
  const fixture = await graph(); const before = fixture.definition; const state = before.states[0]; const transition = before.transitions[0];
  await assert.rejects(statePatch(fixture, state.id, { name: 'Stale' }, 2), { code: 'stale_workflow_definition' });
  await assert.rejects(statePatch(fixture, state.id, { name: 'Reader' }, 1, reader), { status: 403 });
  await assert.rejects(work((client, identity) => patchWorkflowState(client, { ...identity, permission_codes: ['workflows.manage'] },
    fixture.versionId, 1, state.id, { name: 'Forged management permission' }), reader), { status: 404 });
  await assert.rejects(work((client, identity) => patchWorkflowTransition(client, { ...identity, user_id: foreign.userId },
    fixture.versionId, 1, transition.id, { name: 'Forged actor' })), { status: 403 });
  await assert.rejects(transitionPatch(fixture, transition.id, { name: 'Foreign' }, 1, foreign), { status: 404 });
  await assert.rejects(statePatch(fixture, randomUUID(), { name: 'Missing' }), { status: 404 });
  await assert.rejects(transitionPatch(fixture, randomUUID(), { name: 'Missing' }), { status: 404 });
  await assert.rejects(statePatch(fixture, state.id, { code: before.states[1].code, accessRoleIds: [] }), { code: 'workflow_duplicate' });
  await assert.rejects(transitionPatch(fixture, transition.id, { code: before.transitions[1].code, ccEmails: [] }), { code: 'workflow_duplicate' });
  assert.deepEqual(contents(await load(fixture.versionId)), contents(before)); assert.equal((await load(fixture.versionId)).version.revision, 1);
  await work((client, identity) => publishWorkflow(client, identity, fixture.versionId, 1, 'Synthetic partial save publication'));
  await assert.rejects(statePatch(fixture, state.id, { name: 'Published' }, 2), { code: 'stale_workflow_definition' });
  const source = await load(fixture.sourceVersionId); assert.equal(source.version.status, 'retired');
  await assert.rejects(work((client, identity) => patchWorkflowTransition(client, identity, source.version.id, source.version.revision, source.transitions[0].id, { name: 'Retired' })), { code: 'stale_workflow_definition' });
});

test('concurrent patches of one draft revision commit once and reject the stale writer', async () => {
  const fixture = await graph({ edges: 1 }); const state = fixture.definition.states[0];
  const results = await Promise.allSettled([statePatch(fixture, state.id, { name: 'First' }), statePatch(fixture, state.id, { name: 'Second' })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'stale_workflow_definition');
  assert.equal((await load(fixture.versionId)).version.revision, 2);
});

test('capability patches retain unchanged rows while adding and removing only selected assignments', async () => {
  const fixture = await graph({ edges: 1 }); const state = fixture.definition.states[0];
  const rows = async () => (await owner.query(`SELECT role_id,capability,xmin::text AS transaction FROM workflow_state_capability_roles
    WHERE organization_id=$1 AND workflow_state_id=$2 ORDER BY capability,role_id`, [manager.organizationId, state.id])).rows;
  const before = await rows(); assert.equal(before.length, 1);
  await statePatch(fixture, state.id, { name: 'Keep existing assignment', accessRoleIds: [fixture.roleId, manager.roleId] });
  const added = await rows(); assert.deepEqual(added.find((row) => row.role_id === fixture.roleId), before[0]);
  await statePatch(fixture, state.id, { accessRoleIds: [manager.roleId] }, 2);
  assert.deepEqual(await rows(), added.filter((row) => row.role_id === manager.roleId));
  await statePatch(fixture, state.id, { accessRoleIds: [] }, 3); assert.deepEqual(await rows(), []);
});

test('partial authoring rechecks a revoked actual session after waiting on the workflow lock', async () => {
  const actor = await account({ organizationId: manager.organizationId, permissions: ['workflows.manage'] });
  const fixture = await graph({ edges: 1 }); const state = fixture.definition.states[0]; const writer = await owner.connect(); let pending;
  try {
    await writer.query('BEGIN'); await writer.query('SELECT id FROM workflows WHERE organization_id=$1 AND id=$2 FOR UPDATE', [manager.organizationId, fixture.workflowId]);
    let started; const ready = new Promise((resolve) => { started = resolve; });
    pending = work(async (client, identity) => {
      started((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return patchWorkflowState(client, identity, fixture.versionId, 1, state.id, { name: 'Revoked writer' });
    }, actor).then((value) => ({ value }), (error) => ({ error }));
    const pid = await Promise.race([ready, pending.then((result) => { throw result.error ?? new Error('Patch did not reach the workflow lock.'); })]);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(waiting, 'The actual workflow lock was not reached.');
    await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId]); await writer.query('COMMIT');
    assert.equal((await pending).error?.status, 403);
    assert.equal((await load(fixture.versionId)).version.revision, 1); assert.deepEqual(contents(await load(fixture.versionId)), contents(fixture.definition));
  } finally { await writer.query('ROLLBACK'); writer.release(); if (pending) await pending; }
});
