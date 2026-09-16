import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { createWorkflowCloneFixture } from '../tests/helpers/workflow-clones.js';
import { closePool } from '../src/db/pool.js';
import { signIn, withSession } from '../src/auth/service.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../src/organization-settings/service.js';
import { registerSample } from '../src/samples/register.js';
import { generateTestRequests } from '../src/test-requests/generate.js';
import { allocateTestRequest } from '../src/test-requests/allocate.js';
import { createTestRequestJobs } from '../src/test-requests/jobs.js';

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic database.');
const owner = ownerPool();
const watched = ['src/organization-settings/service.js', 'src/workflows/start.js', 'src/test-requests/allocate.js', 'src/test-requests/jobs.js',
  'drizzle/0165_test_request_workflow_configuration.sql', 'tests/helpers/workflow-clones.js', 'scripts/benchmark-organization-test-request-workflows.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await hashes(),
  measurement: 'One warmup/five samples per operation with 25/1000 published choices. Authentication, transaction, request parse and response serialization included; action SQL counts exclude authentication/transaction. Fixtures, browser/network, post-save verification and first operations excluded. Allocation has one Product line/one test; Job creation includes that child and its summary.', cases: [] };
try {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'test_requests.allocate', 'settings.manage', 'workflows.manage'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  const work = action => withSession(account.token, action, { csrfToken: account.csrfToken });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  let choices = 1; let alternative;
  for (const count of [25, 1000]) {
    for (; choices < count; choices += 1) alternative = await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges: 1, details: false, appliesTo: 'test_request' }));
    for (const table of ['workflows', 'workflow_versions', 'workflow_states', 'organization_laboratory_settings']) await owner.query(`ANALYZE ${table}`);
    const initial = await work(loadLaboratorySettings); assert.equal(initial.workflows.length, count);
    for (const [operation, budgetMs, queryBudget] of [['load', count === 25 ? 100 : 300, 2], ['save', count === 25 ? 150 : 500, 3], ['allocate', 250, 60], ['job', 500, 120]]) {
      const times = []; const queryCounts = []; let responseBytes;
      for (let iteration = -1; iteration < 5; iteration += 1) {
        const { settings } = await work(loadLaboratorySettings);
        let requestId;
        if (['allocate', 'job'].includes(operation)) {
          const sample = await work((client, identity) => registerSample(client, identity, fixture.registration));
          requestId = (await work((client, identity) => generateTestRequests(client, identity, sample.id))).items[0].id;
        }
        const workflowId = iteration % 2 ? alternative.workflowId : fixture.workflowRecords[1].workflow.id;
        const input = operation === 'save' ? { revision: settings.revision, autoCreateJobs: false,
          resultSummaryTemplateId: fixture.template.templateId, jobWorkflowId: workflowId, testRequestWorkflowId: workflowId }
          : operation === 'allocate' ? { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId }
          : operation === 'job' ? { requestIds: [requestId], analystUserId: account.userId } : null;
        let queries = 0; const start = performance.now(); const command = JSON.parse(JSON.stringify(input));
        const result = await work(async (client, identity) => {
          const query = client.query; client.query = (...args) => { queries += 1; return query.apply(client, args); };
          try {
            if (operation === 'load') return await loadLaboratorySettings(client, identity);
            if (operation === 'save') return await saveLaboratorySettings(client, identity, command);
            if (operation === 'allocate') return await allocateTestRequest(client, identity, requestId, command);
            return await createTestRequestJobs(client, identity, command);
          } finally { client.query = query; }
        });
        const response = JSON.stringify(result); const elapsed = performance.now() - start;
        if (operation === 'load') assert.equal(result.workflows.length, count);
        if (operation === 'save') assert.equal(result.revision, settings.revision + 1);
        if (operation === 'allocate') assert.ok(result.workflowRunId);
        if (operation === 'job') assert.equal(result.items.length, 1);
        assert(queries <= queryBudget, `${operation}: ${queries} queries exceeds ${queryBudget}`);
        if (iteration >= 0) { times.push(elapsed); queryCounts.push(queries); responseBytes = Buffer.byteLength(response); }
      }
      const result = { choices: count, operation, samplesMs: times, p95Ms: p95(times), budgetMs, queryCounts, queryBudget, responseBytes };
      result.passed = result.p95Ms <= budgetMs; report.cases.push(result); console.log(JSON.stringify(result));
    }
  }
  assert.deepEqual(await hashes(), report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'Organization workflow timing budgets');
} catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
finally {
  report.finishedAt = new Date().toISOString(); await writeFile('.local/m04-test-request-workflows-service-performance.json', JSON.stringify(report, null, 2) + '\n');
  await closePool(); await owner.end();
}
