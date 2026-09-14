import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createWorkflowCloneFixture } from '../tests/helpers/workflow-clones.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { cloneWorkflowDraft, patchWorkflowState, patchWorkflowTransition } from '../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../src/workflows/definition.js';

const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
function comparable(definition) {
  const value = structuredClone({ states: definition.states, transitions: definition.transitions });
  for (const state of value.states) state.capabilityRoles.sort((a, b) => `${a.capability}:${a.roleId}`.localeCompare(`${b.capability}:${b.roleId}`));
  for (const transition of value.transitions) {
    transition.creatorRoleIds.sort(); transition.ccRoleIds.sort();
    for (const stage of transition.approverStages) stage.roleIds.sort();
  }
  return value;
}

const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Dedicated local PostgreSQL with actual application session/RLS, synthetic 1/100/1000-edge graphs with all typed detail families. One warm-up and five measured mutations per operation/size. Setup, cloning and comparison loads excluded from mutation timings. Sequential execution with no concurrent builds/tests. No browser editing, HTTP retry or source-relative claim.', cases: [] };
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const [edges, serviceBudgetMs, authenticatedBudgetMs] of [[1, 100, 250], [100, 500, 750], [1000, 1500, 2000]]) {
    const setupAt = performance.now(); const actor = await createAccount(owner, { permissions: ['workflows.manage'] });
    const session = await signIn({ identifier: actor.username, password: actor.password });
    const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
    const source = await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges, roleId: actor.roleId }));
    const published = comparable(await work((client, identity) => loadWorkflowDefinition(client, identity, source.versionId), true));
    const draft = await work((client, identity) => cloneWorkflowDraft(client, identity, source.versionId));
    const definition = await work((client, identity) => loadWorkflowDefinition(client, identity, draft.versionId), true);
    const expected = structuredClone(definition); const state = expected.states[Math.floor(expected.states.length / 2)];
    const transition = expected.transitions[Math.floor(expected.transitions.length / 2)];
    // Synthetic label roles do not grant permissions to any account.
    const roles = (await owner.query(`INSERT INTO roles(organization_id,id,name)
      SELECT $1,gen_random_uuid(),'Synthetic patch role '||n FROM generate_series(1,500) n RETURNING id`, [actor.organizationId])).rows.map((row) => row.id);
    const setupMs = performance.now() - setupAt; let revision = draft.revision;
    for (const operation of ['state-name', 'transition-name', 'state-500-roles']) {
      const queryBudget = operation === 'state-500-roles' ? 9 : 6;
      const entry = { edges, operation, setupMs, serviceBudgetMs, authenticatedBudgetMs, queryBudget, samples: [] }; report.cases.push(entry);
      for (let iteration = 0; iteration < 6; iteration++) {
        const input = { name: `${operation} ${iteration}`, ...(operation === 'state-500-roles' ? { accessRoleIds: roles } : {}) };
        const inputBytes = Buffer.byteLength(JSON.stringify(input)); assert(inputBytes <= 64 * 1024);
        let queries = 0; let databaseMs = 0; let serviceMs; const authenticatedAt = performance.now();
        const saved = await work(async (client, identity) => {
          const observed = { async query(...args) { queries++; const at = performance.now();
            try { return await client.query(...args); } finally { databaseMs += performance.now() - at; }
          } };
          const at = performance.now();
          const result = operation === 'transition-name'
            ? await patchWorkflowTransition(observed, identity, draft.versionId, revision, transition.id, input)
            : await patchWorkflowState(observed, identity, draft.versionId, revision, state.id, input);
          serviceMs = performance.now() - at; return result;
        });
        const authenticatedMs = performance.now() - authenticatedAt; revision = saved.revision;
        const serializeAt = performance.now(); const serialized = JSON.stringify(saved); const serializationMs = performance.now() - serializeAt;
        const responseBytes = Buffer.byteLength(serialized); assert(responseBytes <= 1024); assert.equal(queries, queryBudget);
        if (operation === 'transition-name') transition.name = input.name;
        else { state.name = input.name; if (operation === 'state-500-roles') state.capabilityRoles = roles.map((roleId) => ({ capability: 'view', roleId })); }
        const sample = { queries, databaseMs, serviceMs, assemblyMs: serviceMs - databaseMs, authenticatedMs, inputBytes, serializationMs, responseBytes };
        if (iteration) entry.samples.push(sample); else entry.warmup = sample;
      }
      entry.metrics = Object.fromEntries(Object.keys(entry.samples[0]).map((key) => [key, p95(entry.samples.map((sample) => sample[key]))]));
      console.log(JSON.stringify({ edges, operation, ...entry.metrics }));
      await writeFile('.local/workflow-patch-performance.json', JSON.stringify(report, null, 2) + '\n');
      assert(entry.metrics.serviceMs <= serviceBudgetMs); assert(entry.metrics.authenticatedMs <= authenticatedBudgetMs);
    }
    assert.deepEqual(comparable(await work((client, identity) => loadWorkflowDefinition(client, identity, draft.versionId), true)), comparable(expected));
    assert.deepEqual(comparable(await work((client, identity) => loadWorkflowDefinition(client, identity, source.versionId), true)), published);
  }
  report.status = 'passed';
} finally {
  report.finishedAt = new Date().toISOString(); await closePool(); await owner.end();
  await writeFile('.local/workflow-patch-performance.json', JSON.stringify(report, null, 2) + '\n');
}
