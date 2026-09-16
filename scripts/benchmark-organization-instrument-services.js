import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../src/organization-settings/service.js';

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/);
const owner = ownerPool(); const base = { autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null };
const watched = ['scripts/benchmark-organization-instrument-services.js', 'src/organization-settings/service.js', 'src/organization-settings/instrument-services.js', 'drizzle/0168_instrument_service_settings.sql'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await hashes(),
  measurement: 'Standalone synthetic 3/100 service definitions with 64-character codes and 150-character labels. One warmup/five samples; authentication, transaction, input parsing, assembly and JSON serialization included. Counted action queries exclude auth/transaction and report client SQL roundtrips, not statements executed within database functions. Fixtures, ANALYZE, sign-in and the revision read before save are excluded. Saving adds six complete history versions. First bulk import, combined maxima, network/browser and concurrent throughput are not measured.', cases: [] };
try {
  for (const count of [3, 100]) {
    const account = await createAccount(owner, { permissions: ['settings.manage'] });
    const session = await signIn({ identifier: account.username, password: account.password });
    const rows = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), serviceCode: String(index).padStart(64, 'A'), displayLabel: 'L'.repeat(150), isActive: index % 2 === 0 }));
    const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
    await work((client, identity) => saveLaboratorySettings(client, identity, { ...base, revision: 0, instrumentServiceTypes: rows }));
    for (const table of ['organization_laboratory_settings', 'organization_instrument_service_versions', 'organization_instrument_service_entries']) await owner.query(`ANALYZE ${table}`);
    // One additional query reads whether Customer/Vendor access is configured.
    for (const [operation, queryBudget] of [['load', 3], ['save', 5]]) {
      const samples = []; const queryCounts = []; let responseBytes;
      for (let iteration = -1; iteration < 5; iteration++) {
        const revision = (await work(loadLaboratorySettings, true)).settings.revision;
        const wire = JSON.stringify({ ...base, revision, instrumentServiceTypes: rows.map(row => ({ ...row, displayLabel: 'L'.repeat(149) + String(iteration + 1) })) });
        let queries = 0; const started = performance.now();
        const result = await work((client, identity) => {
          const counted = { query(...args) { queries++; return client.query(...args); } };
          return operation === 'load' ? loadLaboratorySettings(counted, identity) : saveLaboratorySettings(counted, identity, JSON.parse(wire));
        }, operation === 'load');
        responseBytes = Buffer.byteLength(JSON.stringify(result)); const elapsed = performance.now() - started;
        if (operation === 'load') assert.equal(result.settings.instrumentServiceTypes.length, count);
        if (iteration >= 0) { samples.push(elapsed); queryCounts.push(queries); }
      }
      const result = { definitions: count, operation, samplesMs: samples, p95Ms: p95(samples), budgetMs: count === 3 ? 250 : 500, queryCounts, queryBudget, responseBytes };
      result.passed = result.p95Ms <= result.budgetMs && queryCounts.every(value => value <= queryBudget);
      report.cases.push(result); console.log(JSON.stringify(result));
    }
  }
  assert.deepEqual(await hashes(), report.sourceHashes); report.status = report.cases.every(item => item.passed) ? 'passed' : 'failed'; assert.equal(report.status, 'passed');
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/organization-instrument-services-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
