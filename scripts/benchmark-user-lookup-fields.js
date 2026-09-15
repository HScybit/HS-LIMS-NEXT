import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveLookupSourceObservation } from '../src/custom-fields/lookup-sources.js';
import { saveCustomField } from '../src/masters/custom-fields.js';
import { saveUserCustomFields, loadUserCustomFields } from '../src/users/custom-fields.js';

if (!/^sampleify_verify_[a-f0-9]{32}$/.test(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '')) {
  throw new Error('User lookup benchmarks require an explicitly selected isolated verification database.');
}
const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, fixtures: [], cases: [],
  conditions: 'Run alone on isolated local PostgreSQL. One warmup/five samples; 100/500 lookup fields share one actual 10000-line observation, with 10 selected 80-character original line IDs per field and 160-character labels. Seven subjects; a separate subject primes the first-capture path after explicit ANALYZE, followed by another ANALYZE. Actual auth, normalization, transaction, SQL/driver, integrity checks, assembly, commit and JSON serialization included; setup, verification reads, socket/browser transfer excluded. Service query counts exclude auth/control queries whose time is included. Retention clears the source in an actual observation; recovery reintroduces the same lines in another observation. This does not establish first-read performance after an unanalyzed bulk load, 16000-character labels or complete browser catalog loading.' };
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const account = async options => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const analyze = () => owner.query('ANALYZE users,memberships,custom_field_definitions,custom_field_versions,custom_field_lookup_sources,custom_field_lookup_versions,custom_field_lookup_lines,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');
async function fixture(fieldCount) {
  const start = performance.now(); const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const record = { fieldCount, sourceLineCount: 10000, itemsPerField: 10, organizationId: author.organizationId, setupStage: 'source observation' }; report.fixtures.push(record);
  const lines = Array.from({ length: 10000 }, (_, index) => ({ id: `original_flat_${index}`.padEnd(80, 'v'), label: `Actual label ${index}`.padEnd(160, 'l') }));
  const source = { id: randomUUID(), requestId: randomUUID(), revision: 0, sourceId: 'Original-' + randomUUID(), name: 'Shared lookup observation', lines };
  await work(author, (c, i) => saveLookupSourceObservation(c, i, source));
  const fields = []; record.setupStage = 'bound definitions';
  await work(author, async (c, i) => {
    for (let index = 0; index < fieldCount; index++) fields.push(await saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key: `lookup_${index}`, label: `Lookup ${index}`.padEnd(160, 'f'), fieldType: 'lookup', associatedWith: 'users', lookupSourceId: source.id, allowsMultiple: true }));
  });
  const values = Array.from({ length: 10 }, (_, index) => lines[index * 1000].id);
  const display = Array.from({ length: 10 }, (_, index) => lines[index * 1000].label).join(', ');
  record.setupStage = 'subjects'; const subjects = [];
  for (let index = 0; index < 7; index++) subjects.push(await createAccount(owner, { organizationId: author.organizationId, permissions: [] }));
  record.sourceId = source.id; record.fieldIds = fields.map(field => field.id); record.subjectIds = subjects.map(subject => subject.userId); record.selectedLineIds = values;
  const commands = subjects.map(() => ({ requestId: randomUUID(), revision: 0, customFields: fields.map(field => ({ fieldId: field.id, fieldRevision: 1, value: values })) }));
  await analyze(); record.setupStage = 'separate priming capture';
  await work(manager, (c, i) => saveUserCustomFields(c, i, subjects[6].userId, commands[6])); await analyze();
  record.setupStage = 'complete'; record.setupMs = performance.now() - start;
  return { author, manager, record, fields, values, display, source, subjects, commands };
}
function verifyRead(f, result, revision, observation, retained = false) {
  assert.equal(result.revision, revision); assert.equal(result.customFields.length, f.fields.length);
  for (const [index, field] of result.customFields.entries()) {
    assert.equal(field.fieldId, f.fields[index].id); assert.deepEqual(field.value, f.values);
    assert.equal(field.displayValue, retained ? f.values.join(', ') : f.display);
    for (const [position, item] of field.items.entries()) {
      assert.equal(item.lookupSourceId, retained ? null : f.source.id); assert.equal(item.lookupRevision, observation);
      assert.equal(item.lookupLineId, retained ? null : f.values[position]); assert.equal(item.interpretationState, retained ? 'invalid' : 'valid');
    }
  }
}
async function verifySaved(f, result, index, revision, observation, retained = false) {
  assert.deepEqual(result, { id: f.subjects[index].userId, revision });
  verifyRead(f, await work(f.manager, (c, i) => loadUserCustomFields(c, i, result.id), true), revision, observation, retained);
}
async function measure(f, name, budgetMs, expectedQueries, readOnly, action, validate) {
  const record = { fieldCount: f.fields.length, name, budgetMs, expectedQueries, samples: [] }; report.cases.push(record);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; let lookupQueries = 0; const statements = []; const start = performance.now();
    const result = await work(f.manager, (client, identity) => action({ async query(...args) {
      queries++; if (args[0].includes('JOIN user_custom_field_lookup_lines')) {
        lookupQueries++; assert.equal(args[1][1].length, 10); assert.equal(new Set(args[1][1]).size, 1); assert.equal(new Set(args[1][2]).size, 10);
      }
      const at = performance.now(); try { return await client.query(...args); }
      finally { const ms = performance.now() - at; sqlMs += ms; statements.push({ sql: args[0], ms }); }
    } }, identity, index), readOnly);
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - start, sqlMs, queries, lookupQueries, bytes, statements };
    if (index) record.samples.push(sample); else record.warmup = sample;
    assert.equal(queries, expectedQueries); assert.equal(lookupQueries, expectedQueries === 7 || expectedQueries === 9 ? 1 : 0);
    await validate(result, index); sample.validated = true;
  }
  record.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'lookupQueries', 'bytes'].map(key => [key, p95(record.samples.map(sample => sample[key]))]));
  record.passed = record.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ fieldCount: f.fields.length, name, budgetMs, ...record.metrics, passed: record.passed }));
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const count of [100, 500]) {
    const f = await fixture(count);
    await measure(f, 'configured current lookup capture', count === 100 ? 750 : 2500, 7, false,
      (c, i, index) => saveUserCustomFields(c, i, f.subjects[index].userId, f.commands[index]), (result, index) => verifySaved(f, result, index, 1, 1));
    await measure(f, 'captured lookup read', count === 100 ? 250 : 750, 3, true,
      (c, i) => loadUserCustomFields(c, i, f.subjects[5].userId), result => verifyRead(f, result, 1, 1));
    if (count === 500) {
      await measure(f, 'largest exact lookup retry', 1000, 3, false,
        (c, i) => saveUserCustomFields(c, i, f.subjects[5].userId, f.commands[5]), result => verifySaved(f, result, 5, 1, 1));
      await work(f.author, (c, i) => saveLookupSourceObservation(c, i, { ...f.source, revision: 1, requestId: randomUUID(), lines: [] })); await analyze();
      await measure(f, 'largest retain after source clear', 2500, 9, false,
        (c, i, index) => saveUserCustomFields(c, i, f.subjects[index].userId, { ...f.commands[index], requestId: randomUUID(), revision: 1 }),
        (result, index) => verifySaved(f, result, index, 2, null, true));
      await work(f.author, (c, i) => saveLookupSourceObservation(c, i, { ...f.source, revision: 2, requestId: randomUUID() })); await analyze();
      await measure(f, 'largest recover after source reappearance', 2500, 9, false,
        (c, i, index) => saveUserCustomFields(c, i, f.subjects[index].userId, { ...f.commands[index], requestId: randomUUID(), revision: 2 }),
        (result, index) => verifySaved(f, result, index, 3, 3));
      verifyRead(f, await work(f.manager, (c, i) => loadUserCustomFields(c, i, f.subjects[5].userId, { atRevision: 1 }), true), 1, 1);
      verifyRead(f, await work(f.manager, (c, i) => loadUserCustomFields(c, i, f.subjects[5].userId, { atRevision: 2 }), true), 2, null, true);
    }
  }
  assert.equal(report.cases.length, 7); report.status = report.cases.every(record => record.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('Configured user lookup budgets failed; preserve and diagnose.');
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code, constraint: error.constraint }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-lookup-fields-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
