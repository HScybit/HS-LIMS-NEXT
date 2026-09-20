import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createWorkflowCloneFixture } from '../tests/helpers/workflow-clones.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { cloneWorkflowDraft, deleteWorkflowElement } from '../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../src/workflows/definition.js';
import { executeWorkflowEditorCommand } from '../src/workflows/commands.js';

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
// Reuse the existing Workflow command and browser-save timing limits.
const budgets = [[1, 100, 250, 500], [100, 500, 750, 1500], [1000, 1500, 2000, 3000]];
await writeFile('.local/workflow-save-flow-performance-budgets.json', JSON.stringify({ budgets,
  definition: 'edges, service p95 ms, authenticated p95 ms, browser save p95 ms', queryLimit: 19,
  responseByteLimit: 1024, warmups: 1, samples: 5 }, null, 2), { flag: 'wx' });
const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Actual local application sessions, RLS and commit; one warm-up and five measured calls per operation on 1/100/1000-edge graphs with all typed detail families. Setup, draft cloning and comparison reads excluded. Serial, no manual ANALYZE or source/cold-cache/concurrent-load comparison.', cases: [] };
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const [edges, serviceBudgetMs, authenticatedBudgetMs, browserSaveBudgetMs] of budgets) {
    const actor = await createAccount(owner, { permissions: ['workflows.manage'] });
    const session = await signIn({ identifier: actor.username, password: actor.password });
    const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
    const load = id => work((client, identity) => loadWorkflowDefinition(client, identity, id), true);
    const source = await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges, roleId: actor.roleId }));
    const original = await load(source.versionId);
    const entries = ['draft-save', 'exact-retry', 'activation'].map(operation => ({ operation, edges, organizationId: actor.organizationId,
      workflowId: source.workflowId, serviceBudgetMs, authenticatedBudgetMs, browserSaveBudgetMs, samples: [] }));
    report.cases.push(...entries);
    const measure = async (entry, workflowId, command, iteration) => {
      const authenticatedAt = performance.now(); let queries = 0; let databaseMs = 0; let serviceMs;
      const result = await work(async (client, identity) => {
        const observed = { async query(...args) { queries++; const at = performance.now();
          try { return await client.query(...args); } finally { databaseMs += performance.now() - at; }
        } };
        const at = performance.now(); const result = await executeWorkflowEditorCommand(observed, identity, workflowId, command);
        serviceMs = performance.now() - at; return result;
      });
      const authenticatedMs = performance.now() - authenticatedAt; const serializationAt = performance.now(); const response = JSON.stringify(result);
      const sample = { queries, databaseMs, serviceMs, assemblyMs: serviceMs - databaseMs, authenticatedMs,
        serializationMs: performance.now() - serializationAt, responseBytes: Buffer.byteLength(response) };
      assert(queries <= 19); assert(sample.responseBytes <= 1024);
      if (iteration) entry.samples.push(sample); else entry.warmup = sample;
      return result;
    };
    const draft = await work((client, identity) => cloneWorkflowDraft(client, identity, source.versionId));
    const definition = await load(draft.versionId);
    const disconnected = await work((client, identity) => deleteWorkflowElement(client, identity, draft.versionId, draft.revision, { type: 'transition', id: definition.transitions[0].id }));
    let revision = disconnected.revision;
    entries[0].versionId = draft.versionId;
    for (let iteration = 0; iteration < 6; iteration++) {
      const command = { requestId: randomUUID(), versionId: draft.versionId, revision, operation: 'save_flow', input: { changeSummary: `Measured draft ${iteration}` } };
      const saved = await measure(entries[0], draft.workflowId, command, iteration); assert.equal(saved.status, 'draft'); revision = saved.revision;
      assert.deepEqual(await measure(entries[1], draft.workflowId, command, iteration), saved);
    }
    assert.deepEqual(await load(source.versionId), original);
    // A separate complete workflow leaves the incomplete benchmark draft available
    // for its actual browser saves, while each activation has a fresh draft.
    const complete = await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges, roleId: actor.roleId }));
    entries[2].workflowId = complete.workflowId; let publishedVersionId = complete.versionId;
    for (let iteration = 0; iteration < 6; iteration++) {
      const ready = await work((client, identity) => cloneWorkflowDraft(client, identity, publishedVersionId));
      const command = { requestId: randomUUID(), versionId: ready.versionId, revision: ready.revision, operation: 'save_flow', input: { changeSummary: `Measured activation ${iteration}` } };
      const saved = await measure(entries[2], ready.workflowId, command, iteration); assert.equal(saved.status, 'published'); publishedVersionId = saved.versionId;
    }
    entries[2].versionId = publishedVersionId;
    for (const entry of entries) {
      entry.metrics = Object.fromEntries(Object.keys(entry.samples[0]).map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
      entry.passed = entry.metrics.serviceMs <= serviceBudgetMs && entry.metrics.authenticatedMs <= authenticatedBudgetMs;
      console.log(JSON.stringify({ edges, operation: entry.operation, passed: entry.passed, ...entry.metrics }));
    }
    await writeFile('.local/workflow-save-flow-performance.json', JSON.stringify(report, null, 2) + '\n');
  }
  report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'Workflow Save Flow exceeds a declared timing budget.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await closePool(); await owner.end(); await writeFile('.local/workflow-save-flow-performance.json', JSON.stringify(report, null, 2) + '\n'); }
