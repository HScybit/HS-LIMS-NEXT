import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { closePool } from '../src/db/pool.js';
import { signIn, withSession } from '../src/auth/service.js';
import { loadLaboratory, listLaboratories, saveLaboratory } from '../src/masters/laboratories.js';

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic database.');
const owner = ownerPool();
const watched = ['src/masters/laboratories.js', 'drizzle/0171_laboratory_authoring.sql', 'scripts/benchmark-laboratories.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await hashes(),
  measurement: '100/10000 laboratories, 200-character names, 64-character codes, 20-character abbreviations, 2000-character descriptions and four 2000-character raw limits; ten-row pages, one warmup/five samples. Authentication, transaction, input parse, assembly and response serialization included. Action query counts exclude authentication/transaction. Synthetic setup, ANALYZE, initial writes, current-revision reads and browser/network work excluded.', cases: [] };
try {
  const account = await createAccount(owner, { permissions: ['users.manage'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  const work = action => withSession(account.token, action, { csrfToken: account.csrfToken });
  const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, code: 'LAB-EDITABLE'.padEnd(64, 'X'), name: 'Synthetic lab editable '.padEnd(200, 'N'),
    description: 'D'.repeat(2000), abbreviation: 'A'.repeat(20), minimumTemperature: '0'.repeat(2000), maximumTemperature: 'T'.repeat(2000),
    minimumHumidity: ' '.repeat(2000), maximumHumidity: 'H'.repeat(2000), headUserId: account.userId, delegateUserId: account.userId, active: true };
  const original = await work((client, identity) => saveLaboratory(client, identity, input)); let existing = 1;
  for (const count of [100, 10000]) {
    await owner.query(`INSERT INTO laboratories(organization_id,code,name,description,abbreviation,minimum_temperature_text,maximum_temperature_text,minimum_humidity_text,maximum_humidity_text,active)
      SELECT $1,rpad('LAB-'||number,64,'X'),rpad('Synthetic lab '||lpad(number::text,5,'0'),200,'N'),$4,$5,$6,$7,$8,$9,number%2=0
      FROM generate_series($2::integer,$3::integer) number`,
    [account.organizationId, existing, count - 1, input.description, input.abbreviation, input.minimumTemperature, input.maximumTemperature, input.minimumHumidity, input.maximumHumidity]);
    existing = count; await owner.query('ANALYZE laboratories'); await owner.query('ANALYZE laboratory_versions');
    for (const operation of ['list', 'filter', 'save', 'history']) {
      const times = []; const queryCounts = []; let responseBytes;
      const budgetMs = operation === 'history' ? 250 : operation === 'save' || count === 10000 ? 500 : 250;
      const queryBudget = operation === 'history' ? 1 : 2;
      for (let iteration = -1; iteration < 5; iteration += 1) {
        const current = operation === 'save' ? await work((client, identity) => loadLaboratory(client, identity, input.id)) : null;
        const raw = operation === 'save' ? { ...input, requestId: randomUUID(), revision: current.revision, active: !current.active }
          : operation === 'history' ? { id: input.id, atRevision: 1 }
            : operation === 'filter' ? { search: 'Synthetic', filters: { active: { type: 'boolean', value: 'true' } }, sort: { key: 'name', dir: 'asc' } } : {};
        let queries = 0; const start = performance.now(); const command = JSON.parse(JSON.stringify(raw));
        const result = await work(async (client, identity) => {
          const query = client.query; client.query = (...args) => { queries += 1; return query.apply(client, args); };
          try {
            if (operation === 'save') return await saveLaboratory(client, identity, command);
            if (operation === 'history') return await loadLaboratory(client, identity, command.id, { atRevision: command.atRevision });
            return await listLaboratories(client, identity, command);
          } finally { client.query = query; }
        });
        const response = JSON.stringify(result); const elapsed = performance.now() - start;
        assert.equal(queries, queryBudget);
        if (operation === 'list') assert.equal(result.totalCount, count);
        if (operation === 'filter') assert.equal(result.rows.length, 10);
        if (operation === 'save') assert.equal(result.revision, current.revision + 1);
        if (operation === 'history') assert.deepEqual(result, original);
        if (iteration >= 0) { times.push(elapsed); queryCounts.push(queries); responseBytes = Buffer.byteLength(response); }
      }
      const result = { laboratories: count, operation, samplesMs: times, p95Ms: p95(times), budgetMs, queryCounts, queryBudget, responseBytes };
      result.passed = result.p95Ms <= budgetMs; report.cases.push(result); console.log(JSON.stringify(result));
    }
  }
  assert.deepEqual(await hashes(), report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'Laboratory timing budgets');
} catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/m06-laboratories-service-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
