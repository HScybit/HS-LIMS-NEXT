import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { ownerPool } from '../tests/helpers/database.js';
import { createModuleAccessPerformanceFixture } from '../tests/helpers/module-access-performance.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../tests/helpers/module-access.js';
import { withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../src/organization-settings/service.js';
import { moduleAccessOptions } from '../src/organization-settings/module-access.js';

assert.match(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '', /^sampleify_verify_[a-f0-9]{32}$/);
const owner = ownerPool(); const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const watched = ['drizzle/0174_party_module_access.sql', 'src/organization-settings/service.js', 'src/organization-settings/module-access.js',
  'src/organization-settings/module-access-filter.js', 'tests/helpers/module-access-performance.js', 'scripts/benchmark-organization-module-access.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const report = { status: 'running', databaseName: process.env.SAMPLEIFY_TEST_DATABASE_NAME, startedAt: new Date().toISOString(), hashes: await hashes(),
  measurement: 'Standalone 100/10000 tenant roles and users. One warmup/five measurements; real authentication, transaction, request parsing, service assembly and JSON serialization included. Action query counts exclude authentication/transaction and internal SQL statements. Fixtures, ANALYZE and prior revision reads excluded. Current settings use 0/100 or 0/500 assignments of each kind for each module, with 137-character ordinary choice labels. Catalog first page and last-record accent/UUID searches include all bounded scan batches. No source runtime, first bulk import, browser transfer or concurrent throughput claim.', cases: [] };
const output = '.local/organization-module-access-performance.json';
const catalogTables = ['roles', 'users', 'memberships', 'organization_module_access_versions', 'organization_module_access_modules', 'organization_module_access_roles', 'organization_module_access_users'];
async function catalogBeforeStatistics(count) {
  const guard = await owner.connect(); let fixture;
  try {
    await guard.query('BEGIN'); await guard.query(`LOCK TABLE ${catalogTables.join(',')} IN SHARE UPDATE EXCLUSIVE MODE`);
    const selections = Math.min(500, count); fixture = await createModuleAccessPerformanceFixture(owner, count, selections);
    if (count === 10000) {
      fixture.modules[1].roleIds = fixture.roleIds.slice(500, 1000); fixture.modules[1].userIds = fixture.userIds.slice(500, 1000);
      await saveModuleAccessSettings(fixture.actor, fixture.modules);
    }
    const samples = []; const queryCounts = []; let responseBytes;
    for (let iteration = -1; iteration < 5; iteration++) {
      let queries = 0; const started = performance.now();
      const result = await withSession(fixture.actor.token, (client, identity) => loadLaboratorySettings({ query(...args) { queries++; return client.query(...args); } }, identity), { readOnly: true });
      responseBytes = Buffer.byteLength(JSON.stringify(result)); const elapsed = performance.now() - started;
      assert.equal(result.settings.moduleAccess[1].roleIds[0], fixture.modules[1].roleIds[0]);
      if (iteration >= 0) { samples.push(elapsed); queryCounts.push(queries); }
    }
    const row = { choices: count, selectionsPerKindPerModule: selections, distinctSelectionsPerKind: count === 10000 ? 1000 : count,
      operation: 'load-before-statistics-refresh', samplesMs: samples, p95Ms: p95(samples), budgetMs: 500, queryCounts, queryBudget: 6, responseBytes,
      condition: 'New synthetic tenant, transaction-scoped SHARE UPDATE EXCLUSIVE locks hold off automatic statistics refresh; ordinary reads/writes remain compatible. Release all locks before other cases.' };
    row.passed = row.p95Ms <= row.budgetMs && queryCounts.every(value => value === row.queryBudget); report.cases.push(row); console.log(JSON.stringify(row));
  } finally { await guard.query('ROLLBACK'); guard.release(); }
  return fixture;
}
try {
  for (const count of [100, 10000]) {
    const fixture = await catalogBeforeStatistics(count); const { actor } = fixture;
    const work = (action, readOnly = false) => withSession(actor.token, action, { readOnly });
    for (const table of ['roles', 'users', 'memberships', 'membership_roles', 'organization_laboratory_settings', 'organization_module_access_versions', 'organization_module_access_modules', 'organization_module_access_roles', 'organization_module_access_users']) await owner.query(`ANALYZE ${table}`);
    for (const [selections, disjoint] of [[0, false], [Math.min(500, count), false], ...(count === 10000 ? [[500, true]] : [])]) {
      const modules = emptyModuleAccess().map((access, index) => { const offset = disjoint && index === 1 ? 500 : 0;
        return { ...access, enabled: true, roleIds: fixture.roleIds.slice(offset, offset + selections), userIds: fixture.userIds.slice(offset, offset + selections) }; });
      let revision = (await work(loadLaboratorySettings, true)).settings.revision;
      await work((client, identity) => saveLaboratorySettings(client, identity, { revision, autoCreateJobs: false, moduleAccess: modules }));
      for (const operation of ['load', 'save']) {
        const times = []; const queryCounts = []; let requestBytes = 0; let responseBytes;
        for (let iteration = -1; iteration < 5; iteration++) {
          revision = (await work(loadLaboratorySettings, true)).settings.revision;
          const wire = JSON.stringify({ revision, autoCreateJobs: false, moduleAccess: modules }); requestBytes = Buffer.byteLength(wire);
          let queries = 0; const started = performance.now();
          const result = await work((client, identity) => {
            const counted = { query(...args) { queries++; return client.query(...args); } };
            return operation === 'load' ? loadLaboratorySettings(counted, identity) : saveLaboratorySettings(counted, identity, JSON.parse(wire));
          }, operation === 'load');
          responseBytes = Buffer.byteLength(JSON.stringify(result)); const elapsed = performance.now() - started;
          if (operation === 'load') assert.equal(result.settings.moduleAccess[0].roleIds.length, selections);
          if (iteration >= 0) { times.push(elapsed); queryCounts.push(queries); }
        }
        const row = { choices: count, selectionsPerKindPerModule: selections, distinctSelectionsPerKind: selections * (disjoint ? 2 : 1), operation, samplesMs: times, p95Ms: p95(times),
          budgetMs: operation === 'save' && selections === 500 ? 1500 : 500, queryCounts, queryBudget: operation === 'load' ? 6 : 5, requestBytes, responseBytes };
        row.passed = row.p95Ms <= row.budgetMs && row.queryCounts.every(value => value === row.queryBudget); report.cases.push(row); console.log(JSON.stringify(row));
      }
    }
    for (const [kind, search, expectedId] of [['role', '', null], ['user', '', null], ['role', 'etalon prufgerat', fixture.roleIds.at(-1)], ['user', fixture.userIds.at(-1).toUpperCase(), fixture.userIds.at(-1)]]) {
      const times = []; const queryCounts = []; let responseBytes;
      for (let iteration = -1; iteration < 5; iteration++) {
        let queries = 0; const wire = JSON.stringify({ kind, search }); const started = performance.now();
        const result = await work((client, identity) => moduleAccessOptions({ query(...args) { queries++; return client.query(...args); } }, identity, JSON.parse(wire)), true);
        responseBytes = Buffer.byteLength(JSON.stringify(result)); const elapsed = performance.now() - started;
        if (expectedId) assert.deepEqual(result.rows.map(row => row.id), [expectedId]); else assert.equal(result.rows.length, 100);
        if (iteration >= 0) { times.push(elapsed); queryCounts.push(queries); }
      }
      const row = { choices: count, operation: `${kind}-${search ? 'last-match' : 'first-page'}`, samplesMs: times, p95Ms: p95(times),
        budgetMs: count === 10000 && search ? 1000 : 300, queryCounts, queryBudget: search ? Math.ceil(count / 500) : 1,
        expectedQueryCount: search ? Math.ceil(count / 1000) : 1, responseBytes };
      row.passed = row.p95Ms <= row.budgetMs && row.queryCounts.every(value => value === row.expectedQueryCount && value <= row.queryBudget); report.cases.push(row); console.log(JSON.stringify(row));
    }
  }
  assert.deepEqual(await hashes(), report.hashes); report.status = report.cases.every(row => row.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') process.exitCode = 1;
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
