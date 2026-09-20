import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { closePool } from '../src/db/pool.js';
import { signIn, withSession } from '../src/auth/service.js';
import { loadTestParameter, saveTestParameter } from '../src/masters/test-parameters.js';

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic database.');
const owner = ownerPool(); const watched = ['src/masters/test-parameters.js', 'drizzle/0170_parameter_laboratory_labels.sql', 'scripts/benchmark-parameter-laboratory-labels.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await hashes(),
  measurement: '100/10000 laboratories with 250-character names; one warmup/five samples. Includes authentication, transaction, input parsing, assembly and response serialization. Client action roundtrips exclude authentication/transaction and internal trigger statements. Synthetic setup, ANALYZE and browser/network work excluded. Native prechange baseline: create 12 and historical load 2 action roundtrips.', cases: [] };
try {
  const account = await createAccount(owner, { permissions: ['masters.manage'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  const work = action => withSession(account.token, action, { csrfToken: account.csrfToken }); let existing = 0;
  for (const count of [100, 10000]) {
    await owner.query(`INSERT INTO laboratories(organization_id,code,name)
      SELECT $1,'LAB-'||number,rpad('Synthetic Lab '||number,250,'L') FROM generate_series($2::integer,$3::integer) number`, [account.organizationId, existing + 1, count]);
    existing = count; await owner.query('ANALYZE laboratories'); await owner.query('ANALYZE test_parameter_versions');
    const laboratory = (await owner.query('SELECT id,name FROM laboratories WHERE organization_id=$1 AND code=$2', [account.organizationId, 'LAB-' + count])).rows[0];
    let parameter;
    for (const operation of ['create', 'historicalLoad']) {
      const times = []; const queryCounts = []; let responseBytes;
      const budgetMs = operation === 'create' ? 500 : 250; const queryBudget = operation === 'create' ? 12 : 2;
      for (let iteration = -1; iteration < 5; iteration += 1) {
        const key = randomUUID();
        const raw = operation === 'create' ? { id: randomUUID(), revision: 0, requestId: randomUUID(), key, schemeAbbreviation: key,
          name: 'Synthetic parameter', description: '', order: 0, laboratoryId: laboratory.id, measurementUncertainty: null } : { id: parameter.id, atRevision: 1 };
        let queries = 0; const start = performance.now(); const command = JSON.parse(JSON.stringify(raw));
        const result = await work(async (client, identity) => {
          const query = client.query; client.query = (...args) => { queries += 1; return query.apply(client, args); };
          try { return operation === 'create' ? await saveTestParameter(client, identity, command)
            : await loadTestParameter(client, identity, command.id, { atRevision: command.atRevision }); }
          finally { client.query = query; }
        });
        const response = JSON.stringify(result); const elapsed = performance.now() - start;
        assert.equal(queries, queryBudget); assert.equal(result.laboratoryName, laboratory.name); assert.equal(result.revision, 1);
        if (operation === 'create') parameter = result;
        if (iteration >= 0) { times.push(elapsed); queryCounts.push(queries); responseBytes = Buffer.byteLength(response); }
      }
      const result = { laboratories: count, operation, samplesMs: times, p95Ms: p95(times), budgetMs, queryCounts, queryBudget, responseBytes };
      result.passed = result.p95Ms <= budgetMs; report.cases.push(result); console.log(JSON.stringify(result));
    }
  }
  assert.deepEqual(await hashes(), report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'Parameter laboratory label timing budgets');
} catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/m06-parameter-lab-labels-service-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
