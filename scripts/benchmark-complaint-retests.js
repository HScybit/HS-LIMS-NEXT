import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { closePool, database } from '../src/db/pool.js';
import { testParameters, parameterMethods } from '../src/db/master-schema.js';
import { signIn, withSession } from '../src/auth/service.js';
import { registerSample } from '../src/samples/register.js';
import { updateSample } from '../src/samples/update.js';

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic database.');
const owner = ownerPool();
const watched = ['src/samples/update.js', 'src/samples/complaint-input.js', 'src/samples/complaint-retests.js',
  'src/samples/reporting-date.js', 'src/samples/reporting-estimates.js', 'src/test-requests/generate.js', 'scripts/benchmark-complaint-retests.js'];
const fingerprints = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await fingerprints(),
  measurement: 'One warmup/five samples using distinct prepared complaints. Every measurement changes retest flags, and removal cases delete unselected tests. Includes request JSON parse/serialize, authentication, service, event, commit and response JSON. Excludes fixture setup, verification reads, browser/network and first operation.', cases: [] };
try {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  const work = action => withSession(account.token, action, { csrfToken: account.csrfToken });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false }); const db = database(owner);
  await owner.query('UPDATE decision_rules SET estimated_time_in_days=3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [account.organizationId, fixture.rule.id]);
  const parameters = await db.insert(testParameters).values(Array.from({ length: 50 }, (_, index) => ({ organizationId: account.organizationId,
    code: randomUUID(), masterKey: randomUUID(), schemeAbbreviation: `RETEST${index}`, name: `Synthetic retest parameter ${index}`,
    laboratoryId: fixture.laboratory.id, measurementUnitId: fixture.unit.id }))).returning();
  await db.insert(parameterMethods).values(parameters.map(parameter => ({ organizationId: account.organizationId,
    testParameterId: parameter.id, methodId: fixture.method.id, isDefault: true })));
  const small = { ...fixture.registration, sampleType: 'complaint', products: [true, false].map(isRetest => ({ ...fixture.registration.products[0],
    tests: [{ ...fixture.registration.products[0].tests[0], isRetest }] })) };
  const large = { ...fixture.registration, sampleType: 'complaint', products: Array.from({ length: 100 }, () => ({ productId: fixture.product.id, quantity: '1',
    tests: parameters.map((parameter, index) => ({ testParameterId: parameter.id, methodId: fixture.method.id, isRetest: index % 2 === 0, estimatedDurationMinutes: 1440 })) })) };
  const scenarios = [
    { name: 'two-tests-select-one', input: small, remove: true, budgetMs: 250, selectedTests: 1, dueAt: '2026-09-15T00:00:00.000Z' },
    { name: '100-lines-5000-tests-select-all', input: large, remove: false, budgetMs: 2500, selectedTests: 5000, dueAt: '2026-09-14T05:00:00.000Z' },
    { name: '100-lines-5000-tests-select-half', input: large, remove: true, budgetMs: 2500, selectedTests: 2500, dueAt: '2026-09-15T00:00:00.000Z' },
  ];
  for (const scenario of scenarios) {
    scenario.samples = [];
    for (let index = 0; index < 6; index += 1) scenario.samples.push(await work((client, identity) => registerSample(client, identity, scenario.input)));
  }
  for (const table of ['samples', 'sample_products', 'sample_tests', 'sample_events', 'workflow_runs', 'decision_rules', 'sample_categories']) await owner.query(`ANALYZE ${table}`);
  console.log(JSON.stringify({ phase: 'fixtures-ready', cases: scenarios.length, samples: 18 }));
  for (const scenario of scenarios) {
    report.activeCase = scenario.name; const timings = []; const queryCounts = []; let requestBytes; let responseBytes;
    for (const [index, sample] of scenario.samples.entries()) {
      const ids = scenario.remove ? sample.sampleTestIds.filter((_, position) => position % 2 === 1) : sample.sampleTestIds;
      assert.equal(ids.length, scenario.selectedTests); const input = { revision: sample.revision, complaintRetestIds: ids }; let queries = 0;
      const started = performance.now(); const encoded = JSON.stringify(input); const command = JSON.parse(encoded);
      const result = await work(async (client, identity) => {
        const query = client.query.bind(client); client.query = (...args) => { queries += 1; return query(...args); };
        try { return await updateSample(client, identity, sample.id, command); } finally { client.query = query; }
      });
      const response = JSON.stringify(result); const elapsedMs = performance.now() - started;
      report.lastIteration = { case: scenario.name, iteration: index - 1, elapsedMs, queries };
      assert.equal(result.revision, sample.revision + 1); assert(queries <= 20, 'Bounded service query count');
      const kept = (await owner.query(`SELECT test.id,test.is_retest FROM sample_tests test JOIN sample_products line
        ON line.organization_id=test.organization_id AND line.id=test.sample_product_id WHERE line.organization_id=$1 AND line.sample_id=$2`, [account.organizationId, sample.id])).rows;
      assert.deepEqual(kept.map(test => test.id).sort(), [...ids].sort()); assert(kept.every(test => test.is_retest));
      const saved = (await owner.query('SELECT due_at FROM samples WHERE organization_id=$1 AND id=$2', [account.organizationId, sample.id])).rows[0];
      assert.equal(saved.due_at.toISOString(), scenario.dueAt);
      if (index > 0) { timings.push(elapsedMs); queryCounts.push(queries); requestBytes = Buffer.byteLength(encoded); responseBytes = Buffer.byteLength(response); }
    }
    const p95Ms = [...timings].sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1]; assert(requestBytes <= 8_388_608);
    const result = { name: scenario.name, selectedTests: scenario.selectedTests, samplesMs: timings, p95Ms, budgetMs: scenario.budgetMs,
      passed: p95Ms <= scenario.budgetMs, serviceQueryCounts: queryCounts, maximumServiceQueries: 20, requestBytes, responseBytes };
    report.cases.push(result); console.log(JSON.stringify({ name: result.name, p95Ms, queryCounts, requestBytes }));
  }
  assert.deepEqual(await fingerprints(), report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'Complaint retest timing budget');
} catch (error) {
  report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error;
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile('.local/complaint-retests-performance.json', JSON.stringify(report, null, 2) + '\n');
  await closePool(); await owner.end();
}
