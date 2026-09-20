import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { closePool, database } from '../src/db/pool.js';
import { testParameters, parameterMethods } from '../src/db/master-schema.js';
import { signIn, withSession } from '../src/auth/service.js';
import { registerSample } from '../src/samples/register.js';
import { updateSampleHeader } from '../src/samples/update.js';

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic database, never shared main.');
const owner = ownerPool();
const watched = ['src/samples/update.js', 'src/samples/update-input.js', 'src/db/sample-schema.js', 'drizzle/0156_sample_header_edit_event.sql'];
const fingerprints = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await fingerprints(),
  conditions: { warmups: 1, samples: 5, budgetMs: 250, serviceQueries: 6,
    included: ['session authentication', 'transaction', 'header service', 'activity insertion', 'commit', 'JSON serialization'],
    excluded: ['fixture creation', 'browser', 'network', 'product/test edits'],
    queryCountScope: 'Header service only; authentication and commit are included in elapsed time.' }, cases: [] };
try {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  const fixture = await createLaboratoryFixture(owner, account); const organizationId = account.organizationId;
  const db = database(owner);
  const parameters = await db.insert(testParameters).values(Array.from({ length: 50 }, (_, index) => ({ organizationId,
    code: randomUUID(), masterKey: randomUUID(), schemeAbbreviation: randomUUID(), name: `Synthetic header parameter ${index + 1}`,
    laboratoryId: fixture.laboratory.id, measurementUnitId: fixture.unit.id }))).returning({ id: testParameters.id });
  await db.insert(parameterMethods).values(parameters.map(parameter => ({ organizationId, testParameterId: parameter.id, methodId: fixture.method.id, isDefault: true })));
  const work = action => withSession(account.token, action, { csrfToken: account.csrfToken });
  const small = await work((client, identity) => registerSample(client, identity, fixture.registration));
  const largeInput = { ...fixture.registration, products: Array.from({ length: 100 }, () => ({ productId: fixture.product.id, quantity: '1',
    tests: parameters.map(parameter => ({ testParameterId: parameter.id, methodId: fixture.method.id })) })) };
  const large = await work((client, identity) => registerSample(client, identity, largeInput));
  assert.equal(large.sampleTestIds.length, 5000);
  for (const table of ['samples', 'sample_products', 'sample_tests', 'sample_events', 'workflow_runs']) await owner.query(`ANALYZE ${table}`);
  const cases = [
    { name: 'one-line-one-test', sample: small, products: 1, tests: 1, changes: { customerReference: 'Updated reference' } },
    { name: '100-lines-5000-tests', sample: large, products: 100, tests: 5000, changes: { customerReference: 'Updated reference' } },
    { name: '100-lines-5000-tests-long-header', sample: large, products: 100, tests: 5000,
      changes: { customerAddress: 'Á'.repeat(5000), description: '🧪'.repeat(2500), collectionDetails: 'S'.repeat(5000),
        customerReference: 'R'.repeat(150), modeOfReceipt: 'M'.repeat(200), receivedByName: 'U'.repeat(200), storageLocation: 'L'.repeat(200),
        totalAmount: '0', currencyCode: 'INR', quantity: '1.00000000000000001' } },
  ];
  for (const scenario of cases) {
    const timings = []; let responseBytes; const queryCounts = [];
    for (let iteration = -1; iteration < 5; iteration += 1) {
      let queries = 0;
      const started = performance.now();
      const result = await work(async (client, identity) => {
        const query = client.query.bind(client);
        client.query = (...args) => { queries += 1; return query(...args); };
        try { return await updateSampleHeader(client, identity, scenario.sample.id, { revision: scenario.sample.revision, ...scenario.changes }); }
        finally { client.query = query; }
      });
      const serialized = JSON.stringify(result);
      const elapsedMs = performance.now() - started;
      assert.equal(result.revision, scenario.sample.revision + 1); assert.equal(queries, 6);
      scenario.sample.revision = result.revision;
      if (iteration >= 0) { timings.push(elapsedMs); queryCounts.push(queries); responseBytes = Buffer.byteLength(serialized); }
    }
    const p95Ms = [...timings].sort((left, right) => left - right)[Math.ceil(timings.length * 0.95) - 1];
    report.cases.push({ name: scenario.name, products: scenario.products, tests: scenario.tests, samplesMs: timings, p95Ms,
      budgetMs: 250, passed: p95Ms <= 250, serviceQueryCounts: queryCounts, responseBytes,
      requestBytes: Buffer.byteLength(JSON.stringify({ revision: scenario.sample.revision, ...scenario.changes })) });
  }
  assert.deepEqual(await fingerprints(), report.sourceHashes, 'Application code changed during measurement.');
  report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'A declared header-save performance budget failed.');
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, code: error.code ?? error.cause?.code }; throw error;
} finally {
  report.finishedAt = new Date().toISOString(); await mkdir('.local', { recursive: true });
  await writeFile('.local/sample-header-performance.json', JSON.stringify(report, null, 2) + '\n');
  await closePool(); await owner.end();
}
console.log(JSON.stringify({ status: report.status, cases: report.cases.map(({ name, p95Ms, responseBytes }) => ({ name, p95Ms, responseBytes })) }));
