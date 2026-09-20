import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { prepareSampleRejection, workflowWork } from '../tests/helpers/workflow-rejections.js';
import { signIn } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { rejectWorkflowAssignment } from '../src/workflows/requests.js';

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
// Existing Workflow save limits; include actual cancellation and deferred commit.
const budgets = [
  { assignments: 1, users: 1, stages: 1, checks: 2, serviceMs: 100, authenticatedMs: 250, browserMs: 500 },
  { assignments: 100, users: 100, stages: 1, checks: 100, serviceMs: 500, authenticatedMs: 750, browserMs: 1500 },
  { assignments: 1000, users: 100, stages: 10, checks: 200, serviceMs: 1500, authenticatedMs: 2000, browserMs: 3000 },
];
await writeFile('.local/workflow-rejection-performance-budgets.json', JSON.stringify({ budgets, warmups: 1, samples: 5, queryLimit: 1, responseByteLimit: 1024 }, null, 2) + '\n', { flag: 'wx' });
const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Actual application sessions and native first rejection with complete cancellation, immutable checks and commit. One warm-up and five measured sequential responses and exact retries at 1/100/1000 assignments. Setup and comparison reads excluded. No cold-cache, source, concurrent-load or throttle claim.', cases: [] };
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const budget of budgets) {
    const manager = await createAccount(owner, { permissions: ['workflows.manage', 'samples.create', 'samples.manage'] });
    const actor = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['approvals.respond', 'samples.read'] });
    for (const user of [manager, actor]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
    if (budget.users > 1) {
      const ids = Array.from({ length: budget.users - 1 }, () => randomUUID());
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query("INSERT INTO users(id,username,email,display_name) SELECT id,'synthetic-reviewer-'||id,id||'@example.invalid','Synthetic unresponded reviewer' FROM unnest($1::uuid[]) item(id)", [ids]);
        await client.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,id FROM unnest($2::uuid[]) item(id)', [manager.organizationId, ids]);
        await client.query('INSERT INTO membership_roles(organization_id,user_id,role_id) SELECT $1,id,$3 FROM unnest($2::uuid[]) item(id)', [manager.organizationId, ids, actor.roleId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const options = { mode: budget.stages > 1 ? 'sequential' : 'all', checklistCount: budget.checks,
      stages: Array.from({ length: budget.stages }, (_, index) => ({ stageNumber: index + 1, roleIds: [actor.roleId] })) };
    const entry = { ...budget, organizationId: manager.organizationId, username: actor.username, cases: [], retries: [], browserFixtures: [] }; report.cases.push(entry);
    const measure = async (flow, iteration, retry = false) => {
      const id = flow.assignments.find(item => item.assigned_user_id === actor.userId && item.stage_number === 1).id;
      const authenticatedAt = performance.now(); let serviceMs; let queries = 0; let databaseMs = 0;
      const result = await workflowWork(actor, async (client, identity) => {
        const observed = { async query(...args) { queries++; const at = performance.now(); try { return await client.query(...args); } finally { databaseMs += performance.now() - at; } } };
        const at = performance.now(); const value = await rejectWorkflowAssignment(observed, identity, id, { comment: 'Synthetic measured rejection', checklistItemIds: [] });
        serviceMs = performance.now() - at; return value;
      });
      const authenticatedMs = performance.now() - authenticatedAt; const serializationAt = performance.now(); const response = JSON.stringify(result);
      const sample = { queries, databaseMs, serviceMs, authenticatedMs, assemblyMs: serviceMs - databaseMs, serializationMs: performance.now() - serializationAt, responseBytes: Buffer.byteLength(response) };
      assert.equal(queries, 1); assert(sample.responseBytes <= 1024); assert.equal(result.status, 'rejected');
      if (iteration) entry[retry ? 'retries' : 'cases'].push(sample); else entry[retry ? 'retryWarmup' : 'warmup'] = sample;
      return result;
    };
    for (let iteration = 0; iteration < 6; iteration++) {
      const flow = await prepareSampleRejection(owner, manager, [actor], options); assert.equal(flow.assignments.length, budget.assignments);
      const result = await measure(flow, iteration); assert.deepEqual(await measure(flow, iteration, true), result);
    }
    entry.metrics = Object.fromEntries(Object.keys(entry.cases[0]).map(key => [key, p95(entry.cases.map(item => item[key]))]));
    entry.retryMetrics = Object.fromEntries(Object.keys(entry.retries[0]).map(key => [key, p95(entry.retries.map(item => item[key]))]));
    entry.passed = [entry.metrics, entry.retryMetrics].every(metrics => metrics.serviceMs <= budget.serviceMs && metrics.authenticatedMs <= budget.authenticatedMs);
    console.log(JSON.stringify({ assignments: budget.assignments, passed: entry.passed, metrics: entry.metrics, retryMetrics: entry.retryMetrics }));
    // Retain real, still-pending cases for the browser's complete response/reload.
    for (let iteration = 0; iteration < 6; iteration++) {
      const flow = await prepareSampleRejection(owner, manager, [actor], options);
      entry.browserFixtures.push({ sampleId: flow.sample.id, caseId: flow.request.approvalCaseId, runId: flow.run.id,
        assignmentId: flow.assignments.find(item => item.assigned_user_id === actor.userId && item.stage_number === 1).id });
    }
    await writeFile('.local/workflow-rejection-performance.json', JSON.stringify(report, null, 2) + '\n');
  }
  report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; assert.equal(report.status, 'passed', 'Workflow rejection timing budget exceeded');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await closePool(); await owner.end(); await writeFile('.local/workflow-rejection-performance.json', JSON.stringify(report, null, 2) + '\n'); }
