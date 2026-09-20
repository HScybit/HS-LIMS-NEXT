import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { closePool, database } from '../src/db/pool.js';
import { testParameters, parameterMethods } from '../src/db/master-schema.js';
import { signIn, withSession } from '../src/auth/service.js';
import { registerSample } from '../src/samples/register.js';
import { loadSample } from '../src/samples/load.js';
import { updateSample } from '../src/samples/update.js';
import { generateTestRequests } from '../src/test-requests/generate.js';

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic database, never shared main.');
const owner = ownerPool();
const watched = ['src/samples/update.js', 'src/samples/update-input.js', 'src/samples/input.js', 'src/samples/lines-input.js',
  'src/samples/edit-references.js', 'src/samples/reconcile.js', 'src/samples/load.js', 'drizzle/0157_sample_line_edits.sql', 'scripts/benchmark-sample-lines.js'];
const fingerprints = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await fingerprints(),
  conditions: { warmups: 1, samples: 5, smallBudgetMs: 250, maximumBudgetMs: 2500,
    included: ['input JSON serialization/parsing', 'session authentication', 'transaction', 'reconciliation', 'activity insertion', 'commit', 'response JSON serialization'],
    excluded: ['fixture creation', 'browser', 'network', 'new reference selection', 'first operation'],
    queryCountScope: 'Sample service only; authentication and commit are included in elapsed time.' }, cases: [] };

function inputFor(sample, { longText = false } = {}) {
  return { revision: sample.revision, products: sample.products.map(line => ({ id: line.id, productId: line.productId, sampleCategoryId: line.sampleCategoryId,
    quantity: line.quantity, measurementUnitId: line.measurementUnitId, tagId: line.tagId, tag: line.tag,
    description: longText ? 'D'.repeat(2000) : line.description, customerReference: line.customerReference,
    sampleSize: longText ? 'S'.repeat(120) : line.sampleSize, quality: longText ? 'Q'.repeat(200) : line.quality,
    identificationMark: longText ? 'I'.repeat(250) : line.identificationMark, condition: longText ? 'C'.repeat(250) : line.receivedCondition,
    tests: line.tests.map(selected => ({ id: selected.id, testParameterId: selected.testParameterId, methodId: selected.methodId, decisionRuleId: selected.decisionRuleId,
      requestedQuantity: selected.requestedQuantity, requestedSize: longText ? 'R'.repeat(150) : '25 ml', rate: selected.rate, currencyCode: selected.currencyCode,
      estimatedDurationMinutes: selected.estimatedDurationMinutes, isAccredited: selected.isAccredited, isRetest: selected.isRetest, isSubcontracted: selected.isSubcontracted })) })) };
}

try {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read', 'test_requests.allocate'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  const work = action => withSession(account.token, action, { csrfToken: account.csrfToken });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const parameters = await database(owner).insert(testParameters).values(Array.from({ length: 50 }, (_, index) => ({ organizationId: account.organizationId,
    code: randomUUID(), masterKey: randomUUID(), schemeAbbreviation: `BENCH${index}`, name: `Synthetic edit parameter ${index}`,
    laboratoryId: fixture.laboratory.id, measurementUnitId: fixture.unit.id }))).returning();
  await database(owner).insert(parameterMethods).values(parameters.map(parameter => ({ organizationId: account.organizationId,
    testParameterId: parameter.id, methodId: fixture.method.id, isDefault: true })));
  const small = await work((client, identity) => registerSample(client, identity, fixture.registration));
  const large = await work((client, identity) => registerSample(client, identity, { ...fixture.registration,
    products: Array.from({ length: 100 }, () => ({ productId: fixture.product.id, measurementUnitId: fixture.unit.id, quantity: '1',
      tests: parameters.map(parameter => ({ testParameterId: parameter.id, methodId: fixture.method.id })) })) }));
  assert.equal(large.sampleTestIds.length, 5000);
  console.log(JSON.stringify({ phase: 'fixtures-ready', lines: 100, tests: 5000 }));
  const analyze = async () => { for (const table of ['samples', 'sample_products', 'sample_tests', 'sample_events', 'test_requests', 'sample_reports', 'sample_line_contexts', 'workflow_runs']) await owner.query(`ANALYZE ${table}`); };
  await analyze();
  const cases = [
    { name: 'one-line-one-planned-test', sample: small, budgetMs: 250, serviceQueries: 13 },
    { name: '100-lines-5000-planned-tests', sample: large, budgetMs: 2500, serviceQueries: 22 },
    { name: '100-lines-5000-planned-tests-long-text', sample: large, longText: true, budgetMs: 2500, serviceQueries: 22 },
    { name: '100-lines-5000-requested-tests-reorder', sample: large, requested: true, longText: true, budgetMs: 2500, serviceQueries: 13 },
  ];
  for (const scenario of cases) {
    report.activeCase = scenario.name;
    if (scenario.requested) {
      const generated = await work((client, identity) => generateTestRequests(client, identity, large.id, {}));
      assert.equal(generated.items.length, 5000); await analyze();
    }
    const sample = await work((client, identity) => loadSample(client, identity, scenario.sample.id));
    const input = inputFor(sample, scenario); const timings = []; const queryCounts = []; let responseBytes; let requestBytes;
    for (let iteration = -1; iteration < 5; iteration += 1) {
      if (scenario.requested) { input.products.reverse(); for (const line of input.products) line.tests.reverse(); }
      let queries = 0;
      const started = performance.now();
      const encoded = JSON.stringify(input); const command = JSON.parse(encoded);
      const result = await work(async (client, identity) => {
        const query = client.query.bind(client);
        client.query = (...args) => { queries += 1; return query(...args); };
        try { return await updateSample(client, identity, sample.id, command); }
        finally { client.query = query; }
      });
      const response = JSON.stringify(result); const elapsedMs = performance.now() - started;
      report.lastIteration = { case: scenario.name, iteration, elapsedMs, queries };
      assert.equal(result.revision, input.revision + 1);
      assert.equal(queries, scenario.serviceQueries, `${scenario.name} service query count`);
      input.revision = result.revision;
      if (iteration >= 0) { timings.push(elapsedMs); queryCounts.push(queries); responseBytes = Buffer.byteLength(response); requestBytes = Buffer.byteLength(encoded); }
    }
    const p95Ms = [...timings].sort((left, right) => left - right)[Math.ceil(timings.length * 0.95) - 1];
    assert(requestBytes <= 8_388_608);
    report.cases.push({ name: scenario.name, lines: input.products.length, tests: input.products.reduce((count, line) => count + line.tests.length, 0),
      samplesMs: timings, p95Ms, budgetMs: scenario.budgetMs, passed: p95Ms <= scenario.budgetMs, serviceQueryCounts: queryCounts, responseBytes, requestBytes });
    console.log(JSON.stringify({ phase: 'case-complete', name: scenario.name, p95Ms, requestBytes }));
  }
  assert.deepEqual(await fingerprints(), report.sourceHashes, 'Application code changed during measurement.');
  report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'A declared line-save performance budget failed.');
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, code: error.code ?? error.cause?.code }; throw error;
} finally {
  report.finishedAt = new Date().toISOString(); await mkdir('.local', { recursive: true });
  await writeFile('.local/sample-lines-performance.json', JSON.stringify(report, null, 2) + '\n');
  await closePool(); await owner.end();
}
console.log(JSON.stringify({ status: report.status, cases: report.cases.map(({ name, p95Ms, requestBytes }) => ({ name, p95Ms, requestBytes })) }));
