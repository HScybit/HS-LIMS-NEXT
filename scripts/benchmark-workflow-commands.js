import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../tests/helpers/workflow-clones.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { cloneWorkflowDraft } from '../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../src/workflows/definition.js';
import { executeWorkflowEditorCommand } from '../src/workflows/commands.js';

const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Local PostgreSQL with actual application sessions/RLS and synthetic 1/100/1000-edge graphs containing all typed detail families. One warm-up and five measured calls per operation/size. Setup and comparison loads excluded and recorded separately. Published first edits include the complete clone. Sequential execution without concurrent builds/tests. No HTTP/browser editing or source-relative claim.', cases: [] };
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const [edges, editBudgetMs, authenticatedEditBudgetMs, cloneBudgetMs, authenticatedCloneBudgetMs] of [[1, 100, 250, 500, 750], [100, 500, 750, 2000, 2500], [1000, 1500, 2000, 5000, 6000]]) {
    const actor = await createAccount(owner, { permissions: ['workflows.manage'] });
    const session = await signIn({ identifier: actor.username, password: actor.password });
    const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
    const load = (id) => work((client, identity) => loadWorkflowDefinition(client, identity, id), true);
    const create = () => work((client, identity) => createWorkflowCloneFixture(client, identity, { edges, roleId: actor.roleId }));
    const entries = [
      { operation: 'draft-edit', queryBudget: 12, serviceBudgetMs: editBudgetMs, authenticatedBudgetMs: authenticatedEditBudgetMs },
      { operation: 'exact-retry', queryBudget: 3, serviceBudgetMs: editBudgetMs, authenticatedBudgetMs: authenticatedEditBudgetMs },
      { operation: 'published-first-edit', queryBudget: 48, serviceBudgetMs: cloneBudgetMs, authenticatedBudgetMs: authenticatedCloneBudgetMs },
    ].map((entry) => ({ ...entry, edges, samples: [] })); report.cases.push(...entries);
    const measure = async (entry, workflowId, command, iteration) => {
      let queries = 0; let databaseMs = 0; let serviceMs; const authenticatedAt = performance.now();
      const result = await work(async (client, identity) => {
        const observed = { async query(...args) { queries++; const at = performance.now();
          try { return await client.query(...args); } finally { databaseMs += performance.now() - at; }
        } };
        const at = performance.now(); const result = await executeWorkflowEditorCommand(observed, identity, workflowId, command);
        serviceMs = performance.now() - at; return result;
      });
      const authenticatedMs = performance.now() - authenticatedAt; const at = performance.now(); const serialized = JSON.stringify(result);
      const serializationMs = performance.now() - at; const responseBytes = Buffer.byteLength(serialized);
      assert(queries <= entry.queryBudget); assert(responseBytes <= 1024);
      const sample = { queries, databaseMs, serviceMs, assemblyMs: serviceMs - databaseMs, authenticatedMs, serializationMs, responseBytes,
        inputBytes: Buffer.byteLength(JSON.stringify(command)) };
      if (iteration) entry.samples.push(sample); else entry.warmup = sample;
      console.log(JSON.stringify({ edges, operation: entry.operation, iteration, ...sample }));
      return result;
    };
    const setupAt = performance.now(); const original = await create(); const beforeSource = await load(original.versionId);
    const draft = await work((client, identity) => cloneWorkflowDraft(client, identity, original.versionId));
    const beforeDraft = await load(draft.versionId); const state = beforeDraft.states[Math.floor(beforeDraft.states.length / 2)];
    entries[0].setupMs = performance.now() - setupAt; let revision = draft.revision; let lastName;
    for (let iteration = 0; iteration < 6; iteration++) {
      lastName = `Measured draft edit ${iteration}`;
      const command = { requestId: randomUUID(), versionId: draft.versionId, revision, operation: 'patch_state', elementId: state.id, input: { name: lastName } };
      const saved = await measure(entries[0], draft.workflowId, command, iteration); revision = saved.revision;
      assert.deepEqual(await measure(entries[1], draft.workflowId, command, iteration), saved);
    }
    const expected = workflowGraphValues(beforeDraft); expected.states.find((entry) => entry.code === state.code).name = lastName;
    assert.deepEqual(workflowGraphValues(await load(draft.versionId)), expected); assert.deepEqual(await load(original.versionId), beforeSource);
    entries[2].setups = [];
    for (let iteration = 0; iteration < 6; iteration++) {
      const setupAt = performance.now(); const source = await create(); const before = await load(source.versionId);
      const state = before.states[Math.floor(before.states.length / 2)]; entries[2].setups.push(performance.now() - setupAt);
      const name = `Measured first edit ${iteration}`;
      const command = { requestId: randomUUID(), versionId: source.versionId, revision: before.version.revision, operation: 'patch_state', elementId: state.id, input: { name } };
      const saved = await measure(entries[2], source.workflowId, command, iteration);
      assert.notEqual(saved.versionId, source.versionId); assert.notEqual(saved.id, state.id); assert.equal(saved.revision, 2);
      const expected = workflowGraphValues(before); expected.states.find((entry) => entry.code === state.code).name = name;
      assert.deepEqual(workflowGraphValues(await load(saved.versionId)), expected); assert.deepEqual(await load(source.versionId), before);
    }
    for (const entry of entries) {
      entry.metrics = Object.fromEntries(Object.keys(entry.samples[0]).map((key) => [key, p95(entry.samples.map((sample) => sample[key]))]));
      await writeFile('.local/workflow-command-performance.json', JSON.stringify(report, null, 2) + '\n');
      assert(entry.metrics.serviceMs <= entry.serviceBudgetMs); assert(entry.metrics.authenticatedMs <= entry.authenticatedBudgetMs);
    }
  }
  report.status = 'passed';
} finally {
  report.finishedAt = new Date().toISOString(); await closePool(); await owner.end();
  await writeFile('.local/workflow-command-performance.json', JSON.stringify(report, null, 2) + '\n');
}
