import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool } from '../tests/helpers/database.js';
import { createNablPerformanceFixture } from '../tests/helpers/nabl-performance.js';
import { withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { listNablCertifications, loadNablCertification, saveNablCertification, nablCatalog } from '../src/compliance/nabl.js';
import { uploadNablFile, readNablFile, nablFileByteLimit } from '../src/compliance/nabl-files.js';

const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/);
const owner = ownerPool(); const watched = ['src/compliance/nabl.js', 'src/compliance/nabl-files.js', 'drizzle/0172_nabl_certification_authoring.sql', 'drizzle/0173_nabl_scope_validation_batches.sql', 'tests/helpers/nabl-performance.js', 'scripts/benchmark-nabl.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const report = { status: 'running', databaseName, startedAt: new Date().toISOString(), sourceHashes: await hashes(),
  measurement: 'One warmup/five samples; 100/10000 certificates and parameter/product/method references, full 250-character reference names, ten-row lists, 10/2000 saved scope rows with two products and two methods each. Includes authentication, transaction, input JSON parsing, SQL, assembly and response JSON serialization. Query counts are client action roundtrips, excluding auth/transaction. File timings include actual PostgreSQL upload/base64 download transfers, database/service hashing and metadata serialization; content is binary, not JSON. Fixture setup, ANALYZE, initial writes, current-revision prereads, browser/HTTP network and byte-buffer allocation are excluded.', cases: [] };
async function measure(actor, details, prepare, action, verify) {
  const samplesMs = []; const queryCounts = []; let responseBytes;
  for (let iteration = -1; iteration < 5; iteration += 1) {
    const input = await prepare(); let queries = 0; const start = performance.now();
    const command = input.content ? { ...JSON.parse(JSON.stringify({ ...input, content: undefined })), content: input.content } : JSON.parse(JSON.stringify(input));
    const result = await withSession(actor.token, async (client, identity) => {
      const query = client.query; client.query = (...args) => { queries += 1; return query.apply(client, args); };
      try { return await action(client, identity, command); } finally { client.query = query; }
    }, { csrfToken: actor.csrfToken });
    const response = JSON.stringify(result.content ? { ...result, content: undefined } : result);
    const elapsed = performance.now() - start; await verify(result, command); assert.equal(queries, details.queryBudget);
    if (iteration >= 0) { samplesMs.push(elapsed); queryCounts.push(queries); responseBytes = Buffer.byteLength(response) + (result.content?.length ?? 0); }
  }
  const result = { ...details, samplesMs, p95Ms: p95(samplesMs), queryCounts, responseBytes }; result.passed = result.p95Ms <= details.budgetMs;
  report.cases.push(result); console.log(JSON.stringify(result));
}
try {
  let fileActor;
  for (const [count, scopeCount] of [[100, 10], [10000, 2000]]) {
    const fixture = await createNablPerformanceFixture(owner, count, scopeCount); const { actor, command, original } = fixture; fileActor = actor;
    for (const operation of ['list', 'filter', 'parameter', 'product', 'method']) {
      const catalog = ['parameter', 'product', 'method'].includes(operation);
      const input = operation === 'filter' ? { filters: { validFrom: { type: 'date', from: '2024-01-01' } }, sort: { key: 'validTo', dir: 'asc' } }
        : catalog ? { kind: operation, ...(operation === 'parameter' ? {} : { parameterId: fixture.firstParameterId }), search: operation === 'parameter' ? 'Parameter' : '', pageSize: 10 } : {};
      await measure(actor, { records: count, operation, budgetMs: count === 100 ? 250 : 500, queryBudget: 2 }, async () => input,
        (client, identity, value) => catalog ? nablCatalog(client, identity, value) : listNablCertifications(client, identity, value), result => { assert.equal(result.totalCount, count); assert.equal(result.rows.length, 10); });
    }
    for (const operation of ['save', 'history']) {
      await measure(actor, { records: count, scopeRows: scopeCount, operation, budgetMs: operation === 'save' ? scopeCount === 10 ? 500 : 2500 : scopeCount === 10 ? 250 : 1000, queryBudget: operation === 'save' ? 5 : 4 },
        async () => {
          if (operation === 'history') return { id: command.id, revision: original.revision };
          const current = await withSession(actor.token, (client, identity) => loadNablCertification(client, identity, command.id));
          return { ...command, requestId: randomUUID(), revision: current.revision, validTo: current.validTo === '2026-09-16' ? '2026-09-17' : '2026-09-16' };
        }, (client, identity, value) => operation === 'save' ? saveNablCertification(client, identity, value) : loadNablCertification(client, identity, value.id, { atRevision: value.revision }),
        (result, value) => { assert.equal(result.scopes.length, scopeCount); if (operation === 'save') assert.equal(result.revision, value.revision + 1); else assert.deepEqual(result, original); });
    }
  }
  for (const byteLength of [0, 1024, nablFileByteLimit]) {
    const content = Buffer.alloc(byteLength, 71); const sha256 = createHash('sha256').update(content).digest('hex'); let file;
    await measure(fileActor, { operation: 'upload', byteLength, budgetMs: 5000, queryBudget: 2 }, async () => ({ requestId: randomUUID(), originalName: 'Performance file.bin', mediaType: 'application/octet-stream', content }),
      uploadNablFile, result => { assert.equal(result.sha256, sha256); assert.equal(result.byteLength, byteLength); file = result; });
    await measure(fileActor, { operation: 'download', byteLength, budgetMs: 5000, queryBudget: 1 }, async () => ({ id: file.id }),
      (client, identity, value) => readNablFile(client, identity, value.id), result => { assert.equal(result.content.length, byteLength); assert.equal(result.sha256, sha256); });
  }
  assert.deepEqual(await hashes(), report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed'; assert.equal(report.status, 'passed', 'NABL performance budgets');
} catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/m06-nabl-service-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
