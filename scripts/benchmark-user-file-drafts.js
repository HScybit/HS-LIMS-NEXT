import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../src/masters/custom-fields.js';
import { saveUserCustomFields, loadUserCustomFields } from '../src/users/custom-fields.js';
import { uploadUserFieldAttachment } from '../src/users/custom-field-attachments.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, fixtures: [], cases: [],
  conditions: 'Run alone on isolated local PostgreSQL. One warmup/five samples.100/500 distinct original small-file uploads, retired original definitions and replacement UUIDs with the same saved keys. Each measured subject has no previous field capture. A separate subject primes the new path; explicit ANALYZE runs before and after priming. Actual authentication, normalization, transaction, SQL/driver, integrity checks, assembly, commit and JSON serialization included; setup, independent validation, socket/browser transfer excluded. Files contain short distinct synthetic text, not large or arbitrary binary content. This does not establish first-read performance after an unanalyzed bulk load.' };
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const account = async options => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const analyze = () => owner.query('ANALYZE users,memberships,custom_field_definitions,custom_field_versions,custom_field_attachments,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');

async function fixture(count) {
  const started = performance.now(); const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const record = { count, organizationId: author.organizationId, setupStage: 'original definitions' }; report.fixtures.push(record);
  const original = []; await work(author, async (client, identity) => {
    for (let n = 0; n < count; n++) original.push(await saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key: `draft_${n}`, label: `Original evidence ${n}`, fieldType: 'attachment', associatedWith: 'users' }));
  });
  const files = []; record.setupStage = 'original uploads';
  await work(manager, async (client, identity) => {
    for (const [n, field] of original.entries()) files.push(await uploadUserFieldAttachment(client, identity, { requestId: randomUUID(), fieldId: field.id, fieldRevision: 1,
      originalName: `Original-${n}.txt`, mediaType: 'text/plain', content: Buffer.from(`Fresh original evidence ${n}`) }));
  });
  record.setupStage = 'replacement definitions'; const fields = [];
  await work(author, async (client, identity) => {
    for (const field of original) {
      await retireCustomField(client, identity, { id: field.id, revision: 1, requestId: randomUUID() });
      fields.push(await saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
        key: field.key, label: field.label, fieldType: 'attachment', associatedWith: 'users' }));
    }
  });
  record.setupStage = 'uncaptured subjects'; const subjects = [];
  for (let n = 0; n < 7; n++) subjects.push(await createAccount(owner, { organizationId: author.organizationId, permissions: [] }));
  const commands = subjects.map(() => ({ requestId: randomUUID(), revision: 0,
    customFields: fields.map((field, index) => ({ fieldId: field.id, fieldRevision: 1, value: files[index].id })) }));
  let at = performance.now(); await analyze(); record.prePrimeAnalyzeMs = performance.now() - at;
  record.setupStage = 'prime first capture'; await work(manager, (c, i) => saveUserCustomFields(c, i, subjects[6].userId, commands[6]));
  at = performance.now(); await analyze(); record.analyzeMs = performance.now() - at;
  record.setupMs = performance.now() - started; record.setupStage = 'complete'; console.log(JSON.stringify({ prepared: record }));
  return { manager, record, subjects, commands, files, fields };
}
function verifyFields(f, fields) {
  assert.equal(fields.length, f.record.count);
  for (const [n, field] of fields.entries()) {
    assert.equal(field.fieldId, f.fields[n].id); assert.equal(field.key, f.fields[n].key); assert.equal(field.value, f.files[n].id);
    assert.equal(field.items[0].attachment.originalName, `Original-${n}.txt`);
  }
}
async function measure(f, name, budgetMs, expectedQueries, readOnly, operation, validate) {
  const entry = { count: f.record.count, name, budgetMs, expectedQueries, samples: [] }; report.cases.push(entry);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; const statements = []; const started = performance.now();
    const result = await work(f.manager, (client, identity) => operation({ async query(...args) {
      queries++; const at = performance.now(); try { return await client.query(...args); }
      finally { const ms = performance.now() - at; sqlMs += ms; statements.push({ sql: args[0], ms }); }
    } }, identity, index), readOnly);
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - started, sqlMs, queries, bytes, statements };
    assert.equal(queries, expectedQueries); await validate(result, index); if (index) entry.samples.push(sample); else entry.warmup = sample;
  }
  entry.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
  entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ count: entry.count, name, budgetMs, ...entry.metrics, passed: entry.passed }));
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const count of [100, 500]) {
    const f = await fixture(count);
    await measure(f, 'first capture of same-upload-key file drafts', count === 100 ? 250 : 750, 7, false,
      (c, i, index) => saveUserCustomFields(c, i, f.subjects[index].userId, f.commands[index]), async (result, index) => {
        assert.equal(result.revision, 1); assert.equal(result.id, f.subjects[index].userId);
        verifyFields(f, (await work(f.manager, (c, i) => loadUserCustomFields(c, i, result.id), true)).customFields);
      });
    if (count === 500) {
      await measure(f, 'largest exact retry', 100, 3, false, (c, i) => saveUserCustomFields(c, i, f.subjects[5].userId, f.commands[5]),
        async result => { assert.equal(result.revision, 1); assert.equal(result.id, f.subjects[5].userId); });
      await measure(f, 'largest captured-file read', 150, 3, true, (c, i) => loadUserCustomFields(c, i, f.subjects[5].userId),
        async result => { assert.equal(result.revision, 1); verifyFields(f, result.customFields); });
    }
  }
  report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; assert.equal(report.status, 'passed');
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code, constraint: error.constraint }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-file-draft-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
