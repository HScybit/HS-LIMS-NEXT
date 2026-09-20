import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { uploadUserSignature, removeUserSignature, loadUserSignatureHistory, readUserSignatureFile, userSignatureFileHeaders } from '../src/users/signatures.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Run alone on isolated local PostgreSQL. One warmup and five measured samples. File fixtures use random binary bytes to avoid a compressible maximum-size case. History uses 100 revisions with 1 KiB files. Total includes authentication, normalization/hashing, service SQL, driver/base64 decoding, integrity checks, deferred constraints, commit and response construction. Service SQL/query counts exclude authentication and transaction-control SQL, which remain in total. Binary downloads construct the actual Response with original bytes and safe headers; buffers are never JSON-serialized as numeric arrays. Fixtures, socket/browser transfer and external network are excluded. No source performance improvement claim.', cases: [] };
const percentile = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
async function measure(actor, action, validate, { label, budgetMs, queries = 1, readOnly = true, prepare = async () => {}, download = false, status = 200 }) {
  const entry = { label, budgetMs, serviceQueryBudget: queries, samples: [] }; report.cases.push(entry);
  for (let index = 0; index < 6; index++) {
    const fixture = await prepare(); let serviceQueries = 0; let serviceSqlMs = 0; const start = performance.now();
    const result = await withSession(actor.token, (client, identity) => action({ async query(...args) {
      serviceQueries++; const at = performance.now();
      try { return await client.query(...args); } finally { serviceSqlMs += performance.now() - at; }
    } }, identity, fixture), { readOnly });
    const committedAt = performance.now(); const body = download ? result.content : JSON.stringify(result);
    const response = new Response(body, { status, headers: download ? userSignatureFileHeaders(result) : { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    const end = performance.now(); validate(result, fixture); assert.equal(serviceQueries, queries); assert.equal(response.status, status);
    const sample = { totalMs: end - start, serviceSqlMs, transactionAndAssemblyMs: committedAt - start - serviceSqlMs,
      responseConstructionMs: end - committedAt, responseBodyBytes: Buffer.byteLength(body), serviceQueries };
    if (index) entry.samples.push(sample); else entry.warmup = sample;
  }
  entry.metrics = Object.fromEntries(['totalMs', 'serviceSqlMs', 'transactionAndAssemblyMs', 'responseConstructionMs', 'responseBodyBytes', 'serviceQueries'].map((key) => [key, percentile(entry.samples.map((sample) => sample[key]))]));
  entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ label, ...entry.metrics, passed: entry.passed }));
}

try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  const admin = await createAccount(owner, { permissions: ['users.manage'] }); Object.assign(admin, await signIn({ identifier: admin.username, password: admin.password }));
  let maximum;
  for (const [bytes, label, uploadBudget, downloadBudget] of [[1024, '1 KiB', 150, 75], [1024 * 1024, '1 MiB', 300, 200], [20 * 1024 * 1024, '20 MiB', 1500, 1500]]) {
    const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] }); const content = randomBytes(bytes);
    let revision = 0; let lastInput;
    const input = () => ({ requestId: randomUUID(), revision, originalName: 'Synthetic signature.bin', mediaType: 'application/octet-stream', content });
    await measure(admin, async (client, identity) => {
      lastInput = input(); const result = await uploadUserSignature(client, identity, person.userId, lastInput); revision = result.revision; return result;
    }, (result) => assert.equal(result.revision, revision), { label: `Upload ${label} original signature file`, budgetMs: uploadBudget, readOnly: false, status: 201 });
    const fileId = lastInput.requestId;
    await measure(admin, (client, identity) => readUserSignatureFile(client, identity, fileId), (result) => {
      assert.equal(result.byteLength, bytes); assert.equal(result.content.equals(content), true, 'Original binary response must match');
    }, { label: `Download ${label} original signature file`, budgetMs: downloadBudget, download: true });
    if (bytes === 20 * 1024 * 1024) maximum = { person, content, revision, input: lastInput };
    if (bytes === 1024) {
      while (revision < 100) revision = (await withSession(admin.token, (client, identity) => uploadUserSignature(client, identity, person.userId, input()))).revision;
      await measure(admin, (client, identity) => loadUserSignatureHistory(client, identity, person.userId), (result) => {
        assert.equal(result.rows.length, 25); assert.equal(result.rows[0].revision, 100); assert.equal(result.nextBeforeRevision, 76);
        assert(result.rows.every((row) => row.file.byteLength === 1024 && !Object.hasOwn(row.file, 'content')));
      }, { label: 'First 25 of 100 signature revisions without loading file bytes', budgetMs: 100, queries: 2 });
    }
  }
  let selected = true;
  await measure(admin, async (client, identity) => {
    const result = await removeUserSignature(client, identity, maximum.person.userId, { requestId: randomUUID(), revision: maximum.revision });
    maximum.revision = result.revision; selected = false; return result;
  }, (result) => { assert.equal(result.fileId, null); assert.equal(result.revision, maximum.revision); },
  { label: 'Remove a 20 MiB selection without deleting historical bytes', budgetMs: 150, readOnly: false, prepare: async () => {
    if (!selected) {
      maximum.revision = (await withSession(admin.token, (client, identity) => uploadUserSignature(client, identity, maximum.person.userId,
        { ...maximum.input, requestId: randomUUID(), revision: maximum.revision }))).revision;
      selected = true;
    }
  } });
  await measure(admin, (client, identity) => uploadUserSignature(client, identity, maximum.person.userId, maximum.input), (result) => {
    assert.equal(result.revision, 6); assert.equal(result.fileId, maximum.input.requestId);
  }, { label: 'Replay original 20 MiB upload after later removal', budgetMs: 1500, readOnly: false, status: 201 });
  assert.equal(report.cases.length, 9); assert(report.cases.every((entry) => entry.passed), 'At least one unchanged declared signature budget failed.'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-signature-performance.json', `${JSON.stringify(report, null, 2)}\n`); await closePool(); await owner.end(); }
