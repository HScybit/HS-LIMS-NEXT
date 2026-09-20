import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { sampleEditForm, sampleEditPayload } from '../src/samples/edit-form.js';

const watched = ['src/samples/edit-form.js', 'src/samples/lines-input.js', 'src/samples/input.js', 'src/samples/update-input.js', 'scripts/benchmark-sample-edit-form.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
function fixture(lines, count, longText) {
  const categoryId = randomUUID(); const productId = randomUUID(); const methodId = randomUUID();
  const parameters = Array.from({ length: count }, () => randomUUID());
  return { id: randomUUID(), revision: 1, sampleType: 'internal', sampleCategoryId: categoryId, receivedAt: '2024-02-28T10:30:00.123456Z',
    dueAt: '2024-03-20T18:00:00.654321Z', currencyCode: 'INR', totalAmount: '0', participatingLabs: [],
    products: Array.from({ length: lines }, (_, index) => ({ id: randomUUID(), productId, sampleCategoryId: categoryId,
      productName: `Synthetic saved Product ${index}`, categoryName: 'Synthetic category', quantity: '1.000000000000001', tagId: null, tag: null,
      description: longText ? 'x'.repeat(2000) : '', customerReference: null, sampleSize: '', quality: null, identificationMark: null,
      receivedCondition: '', measurementUnitId: null,
      tests: parameters.map(testParameterId => ({ id: randomUUID(), testParameterId, methodId, decisionRuleId: null, parameterName: 'Synthetic parameter', methodName: 'Synthetic method',
        requestedQuantity: 1, requestedSize: longText ? 'x'.repeat(150) : null, rate: '0.000000000000001', currencyCode: 'USD',
        estimatedDurationMinutes: 1, isAccredited: false, isRetest: false, isSubcontracted: false, status: 'planned' })) })),
  };
}

const report = { status: 'running', startedAt: new Date().toISOString(), sourceHashes: await hashes(),
  measurement: 'Synthetic saved samples. One warmup/five samples per case. Includes input JSON parsing, hydration, a real line change, complete validation/serialization and output JSON. Excludes fixture construction, filesystem, database/network and browser rendering.', cases: [] };
try {
  for (const scenario of [{ name: 'one-line-one-test', lines: 1, count: 1, budgetMs: 25 },
    { name: '100-lines-5000-tests', lines: 100, count: 50, budgetMs: 250 },
    { name: '100-lines-5000-tests-long-text', lines: 100, count: 50, longText: true, budgetMs: 500 }]) {
    const sample = fixture(scenario.lines, scenario.count, scenario.longText); const source = JSON.stringify(sample);
    const options = { allowReceivingDateEdit: false, sampleCategories: [] }; const times = []; let responseBytes;
    for (let index = 0; index < 6; index += 1) {
      const start = performance.now(); const loaded = JSON.parse(source); const form = sampleEditForm(loaded);
      form.products[0].quality = 'Changed quality'; const payload = sampleEditPayload(form, loaded, options); const output = JSON.stringify(payload);
      const elapsed = performance.now() - start;
      assert.equal(payload.products.length, scenario.lines); assert.equal(payload.products.flatMap(line => line.tests).length, scenario.lines * scenario.count);
      assert.equal(payload.products[0].tests[0].id, sample.products[0].tests[0].id); assert(!Object.hasOwn(payload, 'receivedAt'));
      assert.equal(JSON.stringify(loaded), source); assert(Buffer.byteLength(output) <= 8_388_608);
      if (index) times.push(elapsed); responseBytes = Buffer.byteLength(output);
    }
    const p95Ms = [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];
    const result = { ...scenario, samplesMs: times, p95Ms, passed: p95Ms <= scenario.budgetMs, inputBytes: Buffer.byteLength(source), outputBytes: responseBytes };
    report.cases.push(result); console.log(JSON.stringify({ name: scenario.name, p95Ms, budgetMs: scenario.budgetMs, passed: result.passed }));
  }
  assert.deepEqual(await hashes(), report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'Sample edit form model timing budget');
} catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/sample-edit-form-performance.json', JSON.stringify(report, null, 2) + '\n'); }
