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

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic database.');
const owner = ownerPool();
const watched = ['src/organization-settings/service.js', 'src/organization-settings/sample-workflows.js', 'src/workflows/start.js',
  'src/samples/register.js', 'drizzle/0160_organization_sample_workflows.sql', 'drizzle/0161_organization_workflow_reference_locks.sql',
  'drizzle/0162_sample_workflow_registration_context.sql', 'drizzle/0163_settings_retained_references.sql',
  'drizzle/0164_master_writer_foreign_key_locks.sql', 'scripts/benchmark-organization-sample-workflows.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await hashes(),
  measurement: 'One warmup/five samples per operation with 25/1000 published choices. Authentication, transaction, request parse and response serialization included; action SQL counts exclude authentication/transaction. Fixtures, browser/network, post-save verification and first operations excluded. Registration has one Product line and one test.', cases: [] };
try {
  const account = await createAccount(owner, { permissions: ['samples.create', 'settings.manage', 'workflows.manage'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  const work = action => withSession(account.token, action, { csrfToken: account.csrfToken });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  let choices = 1; let alternative;
  for (const count of [25, 1000]) {
    for (; choices < count; choices += 1) alternative = await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges: 1, details: false }));
    for (const table of ['workflows', 'workflow_versions', 'workflow_states', 'organization_laboratory_settings']) await owner.query(`ANALYZE ${table}`);
    const initial = await work(loadLaboratorySettings); assert.equal(initial.sampleWorkflowOptions.length, count);
    // Loading includes the bounded module-access version lookup; latency budgets stay unchanged.
    for (const [operation, budgetMs, queryBudget] of [['load', count === 25 ? 100 : 300, 3], ['save', count === 25 ? 150 : 500, 3], ['registration', 250, 40]]) {
      const times = []; const queryCounts = []; let responseBytes;
      for (let iteration = -1; iteration < 5; iteration += 1) {
        const { settings } = await work(loadLaboratorySettings);
        const input = operation === 'save' ? { revision: settings.revision, autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null,
          sampleWorkflows: { ...settings.sampleWorkflows, iqc: iteration % 2 ? alternative.workflowId : fixture.workflowRecords[0].workflow.id } }
          : operation === 'registration' ? fixture.registration : null;
        let queries = 0; const start = performance.now(); const command = JSON.parse(JSON.stringify(input));
        const result = await work(async (client, identity) => {
          const query = client.query; client.query = (...args) => { queries += 1; return query.apply(client, args); };
          try {
            if (operation === 'load') return await loadLaboratorySettings(client, identity);
            if (operation === 'save') return await saveLaboratorySettings(client, identity, command);
            return await registerSample(client, identity, command);
          } finally { client.query = query; }
        });
        const response = JSON.stringify(result); const elapsed = performance.now() - start;
        if (operation === 'load') assert.equal(result.sampleWorkflowOptions.length, count);
        if (operation === 'save') assert.equal(result.revision, settings.revision + 1);
        if (operation === 'registration') assert.equal(result.sampleTestIds.length, 1);
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
  report.finishedAt = new Date().toISOString(); await writeFile('.local/organization-sample-workflows-performance.json', JSON.stringify(report, null, 2) + '\n');
  await closePool(); await owner.end();
}
