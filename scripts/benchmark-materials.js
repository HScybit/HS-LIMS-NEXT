import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool } from '../tests/helpers/database.js';
import { materialPerformanceFixture } from '../tests/helpers/material-performance-fixture.js';
import { closePool } from '../src/db/pool.js';
import { createMaterialTransaction, loadMaterial, saveMaterial } from '../src/materials/service.js';
import { listMaterials, listMaterialTransactions, materialChoices } from '../src/materials/listing.js';

assert.match(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '', /^sampleify_verify_[a-f0-9]{32}$/);
const owner = ownerPool();
const watched = ['src/materials/input.js', 'src/materials/service.js', 'src/materials/listing.js', 'drizzle/0167_material_manual_stock.sql',
  'scripts/benchmark-materials.js', 'tests/helpers/material-performance-fixture.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const budgets = { list: [200, 500, 2], detail: [200, 500, 4], save: [250, 500, 10], transaction: [250, 500, 12], batchChoices: [200, 500, 4] };
const report = { status: 'running', startedAt: new Date().toISOString(), databaseName: process.env.SAMPLEIFY_TEST_DATABASE_NAME, sourceHashes: await hashes(),
  measurement: 'Standalone, one warmup/five samples. 100/1000 materials, 160-character descriptions; all 1000/10000 initial receipts on the inspected material. List/detail page10, batch page50. Auth, transaction, input JSON parse and response serialization included. Action query counts exclude auth/transaction. Setup, ANALYZE and pre-read revision excluded. OUT adds six rows including warmup; exact initial operation row counts reported. No cold/bulk/maximum-text/concurrency claims.', cases: [] };
try {
  for (const [scale, materials] of [100, 1000].entries()) {
    const transactions = materials * 10; const fixture = await materialPerformanceFixture(owner, materials, transactions); const { account, input, material, work } = fixture;
    for (const operation of Object.keys(budgets)) {
      const times = []; const queryCounts = []; let responseBytes;
      const rowsBefore = Number((await owner.query('SELECT count(*) FROM material_transactions WHERE organization_id=$1', [account.organizationId])).rows[0].count);
      for (let iteration = -1; iteration < 5; iteration += 1) {
        const current = operation === 'save' ? await work((client, identity) => loadMaterial(client, identity, material.id)) : null;
        const raw = operation === 'save' ? { ...input, revision: current.revision, requestId: randomUUID(), minimumQuantity: current.minimumQuantity === '0' ? '1' : '0' }
          : operation === 'transaction' ? { id: randomUUID(), requestId: randomUUID(), materialId: material.id, type: 'out', quantity: '1', batchSerialNumber: 'Batch 00001' } : {};
        let queries = 0; const start = performance.now(); const command = JSON.parse(JSON.stringify(raw));
        const result = await work(async (client, identity) => {
          const query = client.query; client.query = (...args) => { queries += 1; return query.apply(client, args); };
          try {
            if (operation === 'list') return await listMaterials(client, identity, command);
            if (operation === 'detail') return { material: await loadMaterial(client, identity, material.id), transactions: await listMaterialTransactions(client, identity, material.id) };
            if (operation === 'save') return await saveMaterial(client, identity, command);
            if (operation === 'transaction') return await createMaterialTransaction(client, identity, command);
            return await materialChoices(client, identity, { kind: 'batch', materialId: material.id });
          } finally { client.query = query; }
        });
        const response = JSON.stringify(result); const elapsed = performance.now() - start;
        assert(queries <= budgets[operation][2], `${operation}: ${queries} queries exceeds declared budget`);
        if (operation === 'list') { assert.equal(result.totalCount, materials); assert.equal(result.rows.length, 10); }
        if (operation === 'detail') { assert.equal(result.transactions.totalCount, rowsBefore); assert.equal(result.transactions.items.length, 10); assert.equal(result.material.currentQuantity, String(transactions * 10)); }
        if (operation === 'save') assert.equal(result.revision, current.revision + 1);
        if (operation === 'transaction') { assert.equal(result.id, command.id); assert.equal(result.type, 'out'); assert.equal(result.supplier, 'Synthetic supplier'); }
        if (operation === 'batchChoices') { assert.equal(result.items.length, 50); assert.equal(result.hasMore, true); assert.equal(result.items[0].availableQuantity, '4'); }
        if (iteration >= 0) { times.push(elapsed); queryCounts.push(queries); responseBytes = Buffer.byteLength(response); }
      }
      const result = { materials, initialTransactions: transactions, transactionsBeforeOperation: rowsBefore, operation, samplesMs: times, p95Ms: p95(times),
        budgetMs: budgets[operation][scale], queryCounts, queryBudget: budgets[operation][2], responseBytes };
      result.passed = result.p95Ms <= result.budgetMs; report.cases.push(result); console.log(JSON.stringify(result));
    }
  }
  assert.deepEqual(await hashes(), report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
  assert.equal(report.status, 'passed', 'Materials performance budgets');
} catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/m06-materials-service-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
