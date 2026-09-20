import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { closePool } from '../src/db/pool.js';
import { signIn, withSession } from '../src/auth/service.js';
import { loadBusinessUnit, listBusinessUnits, saveBusinessUnit } from '../src/masters/business-units.js';

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic database.');
const owner = ownerPool(); const watched = ['src/masters/business-units.js', 'drizzle/0169_business_unit_authoring.sql', 'scripts/benchmark-business-units.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await hashes(),
  measurement: '100/10000 units, 160-character descriptions, ten-row pages, one warmup/five samples. Authentication, transaction, input parse and response serialization included; action query counts exclude authentication/transaction. Synthetic setup, ANALYZE, initial writes, current-revision reads and browser/network work excluded.', cases: [] };
try {
  const account = await createAccount(owner, { permissions: ['users.manage'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  const work = action => withSession(account.token, action, { csrfToken: account.csrfToken });
  const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, code: 'UNIT-EDITABLE', name: 'Synthetic unit editable', description: 'Synthetic '.repeat(16), active: true };
  await work((client, identity) => saveBusinessUnit(client, identity, input)); let existing = 1;
  for (const count of [100, 10000]) {
    await owner.query(`INSERT INTO business_units(organization_id,code,name,description,active)
      SELECT $1,'UNIT-'||number,'Synthetic unit '||lpad(number::text,5,'0'),$4,number%2=0 FROM generate_series($2::integer,$3::integer) number`,
    [account.organizationId, existing, count - 1, input.description]); existing = count;
    await owner.query('ANALYZE business_units'); await owner.query('ANALYZE business_unit_versions');
    for (const operation of ['list', 'filter', 'save']) {
      const times = []; const queryCounts = []; let responseBytes;
      const budgetMs = count === 100 ? 250 : 500; const queryBudget = 2;
      for (let iteration = -1; iteration < 5; iteration += 1) {
        const current = operation === 'save' ? await work((client, identity) => loadBusinessUnit(client, identity, input.id)) : null;
        const raw = operation === 'save' ? { ...input, requestId: randomUUID(), revision: current.revision, active: !current.active }
          : operation === 'filter' ? { search: 'Synthetic', filters: { active: { type: 'boolean', value: 'true' } }, sort: { key: 'name', dir: 'asc' } } : {};
        let queries = 0; const start = performance.now(); const command = JSON.parse(JSON.stringify(raw));
        const result = await work(async (client, identity) => {
          const query = client.query; client.query = (...args) => { queries += 1; return query.apply(client, args); };
          try { return operation === 'save' ? await saveBusinessUnit(client, identity, command) : await listBusinessUnits(client, identity, command); }
          finally { client.query = query; }
        });
        const response = JSON.stringify(result); const elapsed = performance.now() - start;
        assert.equal(queries, queryBudget);
        if (operation === 'list') assert.equal(result.totalCount, count);
        if (operation === 'filter') assert.equal(result.rows.length, 10);
        if (operation === 'save') assert.equal(result.revision, current.revision + 1);
        if (iteration >= 0) { times.push(elapsed); queryCounts.push(queries); responseBytes = Buffer.byteLength(response); }
      }
      const result = { units: count, operation, samplesMs: times, p95Ms: p95(times), budgetMs, queryCounts, queryBudget, responseBytes };
      result.passed = result.p95Ms <= budgetMs; report.cases.push(result); console.log(JSON.stringify(result));
    }
  }
  assert.deepEqual(await hashes(), report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'Material unit timing budgets');
} catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/m06-business-units-service-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
