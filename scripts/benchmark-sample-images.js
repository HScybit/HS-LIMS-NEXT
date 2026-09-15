import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { uploadSampleImage, readSampleImage } from '../src/samples/images.js';

assert.match(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '', /^sampleify_verify_[a-f0-9]{32}$/);
for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) assert.equal(new URL(process.env[key]).pathname, '/' + process.env.SAMPLEIFY_TEST_DATABASE_NAME);
const owner = ownerPool();
const report = { status: 'running', databaseName: process.env.SAMPLEIFY_TEST_DATABASE_NAME, conditions: {
  warmups: 1, measurements: 5, concurrency: 1, synthetic: true,
  includes: 'session authorization, transaction, full image validation, PostgreSQL transfer and commit; upload response JSON, read byte checksum',
  excludes: 'fixture generation, browser/network, sample registration and report rendering',
}, results: [] };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
try {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const small = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#6aaacc' } }).png().toBuffer();
  const pixels = Buffer.alloc(2048 * 1600 * 3); let value = 271828;
  for (let index = 0; index < pixels.length; index += 1) { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; pixels[index] = value & 255; }
  const large = await sharp(pixels, { raw: { width: 2048, height: 1600, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert(large.length > 9 * 1024 * 1024 && large.length <= 10 * 1024 * 1024);
  for (const [name, content, uploadBudget, readBudget] of [['small', small, 500, 250], ['near-limit', large, 3000, 1500]]) {
    let imageId;
    for (const [operation, budgetMs, queryBudget] of [['upload', uploadBudget, 3], ['read', readBudget, 1]]) {
      const samples = []; const queries = [];
      for (let iteration = 0; iteration < 6; iteration += 1) {
        let queryCount = 0; const started = performance.now();
        const result = await withSession(session.token, async (client, identity) => {
          const counted = new Proxy(client, { get(target, property) {
            if (property !== 'query') return Reflect.get(target, property);
            return (...args) => { queryCount += 1; return target.query(...args); };
          } });
          return operation === 'upload' ? uploadSampleImage(counted, identity, { requestId: randomUUID(), originalName: `${name}.png`, mediaType: 'image/png', content })
            : readSampleImage(counted, identity, imageId);
        }, { csrfToken: session.csrfToken, readOnly: operation === 'read' });
        if (operation === 'upload') { imageId = result.id; JSON.stringify(result); }
        else assert.deepEqual(result.content, content);
        const elapsed = performance.now() - started;
        if (iteration) { samples.push(elapsed); queries.push(queryCount); }
      }
      const result = { name, operation, byteLength: content.length, budgetMs, queryBudget, samplesMs: samples, queryCounts: queries, p95Ms: p95(samples) };
      result.passed = result.p95Ms <= budgetMs && queries.every(count => count <= queryBudget); report.results.push(result);
    }
  }
  report.status = report.results.every(result => result.passed) ? 'passed' : 'failed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code }; throw error; }
finally { await writeFile('.local/sample-images-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
console.log(JSON.stringify({ status: report.status, results: report.results.map(({ name, operation, p95Ms, budgetMs, passed }) => ({ name, operation, p95Ms, budgetMs, passed })) }));
assert.equal(report.status, 'passed');
