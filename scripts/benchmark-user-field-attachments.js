import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveCustomField } from '../src/masters/custom-fields.js';
import { uploadUserFieldAttachment, readUserFieldAttachment } from '../src/users/custom-field-attachments.js';

const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true,
  conditions: 'Run alone on dedicated synthetic PostgreSQL. One warmup/five samples. Actual authentication, transaction, SQL/driver, checksum/assembly, commit and upload-metadata serialization included. Fixture construction, socket and browser transfer excluded. Downloads return original binary without JSON conversion. Query counts exclude authentication queries, whose time is included. Upload/retry reads no previous binary payload. This is the attachment service boundary, not complete user form performance.', cases: [] };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
async function account(options) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function measure(name, bytes, budgetMs, actor, readOnly, expectedQueries, operation, validate) {
  const entry = { name, bytes, budgetMs, samples: [] }; report.cases.push(entry);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; const at = performance.now();
    const result = await withSession(actor.token, (client, identity) => operation({ async query(...args) {
      queries++; const start = performance.now(); const value = await client.query(...args); sqlMs += performance.now() - start; return value;
    } }, identity), { readOnly });
    const metadataBytes = readOnly ? null : Buffer.byteLength(JSON.stringify(result)); const totalMs = performance.now() - at;
    assert.equal(queries, expectedQueries); validate(result);
    const sample = { totalMs, sqlMs, queries, metadataBytes };
    if (index) entry.samples.push(sample); else entry.warmup = sample;
  }
  entry.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
  entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ name, bytes, budgetMs, ...entry.metrics, passed: entry.passed }));
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  const author = await account({ permissions: ['masters.manage'] });
  const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] }); report.organizationId = author.organizationId;
  const field = await withSession(author.token, (client, identity) => saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
    key: 'benchmark_user_file', label: 'Synthetic benchmark user file', associatedWith: 'users', fieldType: 'attachment' }));
  for (const [bytes, uploadBudget, readBudget] of [[0, 100, 50], [1024 * 1024, 300, 150], [20 * 1024 * 1024, 1500, 1000]]) {
    const content = Buffer.alloc(bytes, 37); const sha256 = createHash('sha256').update(content).digest('hex');
    const base = { fieldId: field.id, fieldRevision: field.revision, originalName: 'Synthetic file.dat', mediaType: 'application/octet-stream', content };
    let lastId;
    await measure('upload', bytes, uploadBudget, manager, false, 2, (client, identity) => uploadUserFieldAttachment(client, identity, { ...base, requestId: randomUUID() }), result => {
      assert.equal(result.replayed, false); assert.equal(result.byteLength, bytes); assert.equal(result.sha256, sha256); lastId = result.id;
    });
    await measure('download', bytes, readBudget, reader, true, 1, (client, identity) => readUserFieldAttachment(client, identity, lastId), result => {
      assert.deepEqual(result.content, content); assert.equal(result.sha256, sha256);
    });
    if (bytes === 20 * 1024 * 1024) await measure('exact retry', bytes, 1500, manager, false, 2,
      (client, identity) => uploadUserFieldAttachment(client, identity, { ...base, requestId: lastId }), result => {
        assert.equal(result.id, lastId); assert.equal(result.replayed, true); assert.equal(result.sha256, sha256);
      });
  }
  report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('User field attachment budgets failed. Preserve the report and diagnose.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-field-attachments-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
