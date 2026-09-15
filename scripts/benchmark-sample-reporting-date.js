import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { closePool, database } from '../src/db/pool.js';
import { sampleCategories, testParameters, parameterMethods, decisionRules } from '../src/db/master-schema.js';
import { insertBatch } from '../src/templates/authoring.js';
import { signIn, withSession } from '../src/auth/service.js';
import { registerSample } from '../src/samples/register.js';
import { loadSample } from '../src/samples/load.js';
import { updateSample } from '../src/samples/update.js';

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic database.');
const owner = ownerPool();
const watched = ['src/samples/update.js', 'src/samples/reconcile.js', 'src/samples/reporting-date.js', 'src/samples/reporting-estimates.js',
  'src/samples/edit-references.js', 'src/samples/update-input.js', 'src/samples/lines-input.js', 'scripts/benchmark-sample-reporting-date.js'];
const fingerprints = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await fingerprints(),
  measurement: 'One warmup/five samples; request JSON parse/serialize, authentication, update service, actor event, commit and response JSON included. Fixtures, loading saved IDs, browser/network and first operation excluded. Each iteration replaces one unused line and its tests to require a real reporting-date recalculation.', cases: [] };
const productKeys = ['id', 'productId', 'sampleCategoryId', 'quantity', 'customerReference', 'description', 'sampleSize', 'quality', 'identificationMark', 'measurementUnitId', 'tagId', 'tag'];
const testKeys = ['id', 'testParameterId', 'methodId', 'decisionRuleId', 'requestedQuantity', 'requestedSize', 'rate', 'currencyCode', 'estimatedDurationMinutes', 'isAccredited', 'isRetest', 'isSubcontracted'];
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
try {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  const work = action => withSession(account.token, action, { csrfToken: account.csrfToken });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false }); const db = database(owner);
  await owner.query('UPDATE decision_rules SET estimated_time_in_days=3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [account.organizationId, fixture.rule.id]);
  const categories = await db.insert(sampleCategories).values(Array.from({ length: 20 }, (_, i) => ({ organizationId: account.organizationId,
    code: randomUUID(), name: `Synthetic estimate category ${i}`, abbreviation: `E${i}`, estimatedTimeInDays: 2 }))).returning();
  const parameters = await db.insert(testParameters).values(Array.from({ length: 50 }, (_, i) => ({ organizationId: account.organizationId,
    code: randomUUID(), masterKey: randomUUID(), schemeAbbreviation: `DATE${i}`, name: `Synthetic reporting parameter ${i}`,
    laboratoryId: fixture.laboratory.id, measurementUnitId: fixture.unit.id }))).returning();
  await db.insert(parameterMethods).values(parameters.map(parameter => ({ organizationId: account.organizationId,
    testParameterId: parameter.id, methodId: fixture.method.id, isDefault: true })));
  await insertBatch(db, decisionRules, parameters.flatMap(parameter => categories.map(category => ({ organizationId: account.organizationId,
    code: randomUUID(), name: 'Synthetic category-specific estimate', productId: fixture.product.id, testParameterId: parameter.id,
    methodId: fixture.method.id, sampleCategoryId: category.id, estimatedTimeInDays: '3' }))));
  const small = await work((client, identity) => registerSample(client, identity, fixture.registration));
  const large = await work((client, identity) => registerSample(client, identity, { ...fixture.registration,
    products: Array.from({ length: 100 }, () => ({ productId: fixture.product.id, quantity: '1',
      tests: parameters.map(parameter => ({ testParameterId: parameter.id, methodId: fixture.method.id })) })) }));
  assert.equal(large.sampleTestIds.length, 5000);
  for (const table of ['samples', 'sample_products', 'sample_tests', 'sample_events', 'decision_rules', 'sample_categories', 'workflow_runs']) await owner.query(`ANALYZE ${table}`);
  const cases = [{ name: 'one-line-one-test-recalculation', sample: small, rules: 1, budgetMs: 250 },
    { name: '100-lines-5000-tests-1000-rules-recalculation', sample: large, rules: 1000, budgetMs: 2500 }];
  for (const scenario of cases) {
    report.activeCase = scenario.name; const timings = []; const queryCounts = []; let requestBytes; let responseBytes;
    for (let iteration = -1; iteration < 5; iteration += 1) {
      const sample = await work((client, identity) => loadSample(client, identity, scenario.sample.id));
      const products = sample.products.map(line => ({ ...pick(line, productKeys), condition: line.receivedCondition, tests: line.tests.map(row => pick(row, testKeys)) }));
      products[0].id = null; for (const selected of products[0].tests) selected.id = null;
      const input = { revision: sample.revision, products }; let queries = 0;
      const started = performance.now(); const encoded = JSON.stringify(input); const command = JSON.parse(encoded);
      const result = await work(async (client, identity) => {
        const query = client.query.bind(client); client.query = (...args) => { queries += 1; return query(...args); };
        try { return await updateSample(client, identity, sample.id, command); } finally { client.query = query; }
      });
      const response = JSON.stringify(result); const elapsedMs = performance.now() - started;
      report.lastIteration = { case: scenario.name, iteration, elapsedMs, queries };
      assert.equal(result.revision, sample.revision + 1); assert(queries <= 40, 'Bounded service query count');
      const saved = await work((client, identity) => loadSample(client, identity, sample.id));
      assert.equal(saved.dueAt.toISOString(), '2026-09-15T00:00:00.000Z');
      assert.notEqual(saved.products[0].id, sample.products[0].id);
      if (iteration >= 0) { timings.push(elapsedMs); queryCounts.push(queries); requestBytes = Buffer.byteLength(encoded); responseBytes = Buffer.byteLength(response); }
    }
    const p95Ms = [...timings].sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1];
    assert(requestBytes <= 8_388_608);
    const result = { name: scenario.name, matchingRules: scenario.rules, samplesMs: timings, p95Ms, budgetMs: scenario.budgetMs,
      passed: p95Ms <= scenario.budgetMs, serviceQueryCounts: queryCounts, maximumServiceQueries: 40, requestBytes, responseBytes };
    report.cases.push(result); console.log(JSON.stringify({ name: result.name, p95Ms, queryCounts, requestBytes }));
  }
  assert.deepEqual(await fingerprints(), report.sourceHashes);
  report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'Reporting-date timing budget');
} catch (error) {
  report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error;
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile('.local/sample-reporting-date-performance.json', JSON.stringify(report, null, 2) + '\n');
  await closePool(); await owner.end();
}
