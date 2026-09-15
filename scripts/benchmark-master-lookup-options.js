import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveLookupSourceObservation, loadMasterFieldLookupOptions } from '../src/custom-fields/lookup-sources.js';
import { saveCustomField, retireCustomField } from '../src/masters/custom-fields.js';

if (!/^sampleify_verify_[a-f0-9]{32}$/.test(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '')) {
  throw new Error('Master catalog benchmarks require an explicitly selected isolated verification database.');
}
const budgets = { recordedAt: new Date().toISOString(), warmups: 1, samples: 5,
  complete: { 0: 100, 10: 100, 1000: 250, 10000: 750 }, unchanged: 100, retired: 100 };
await writeFile('.local/master-lookup-options-performance-budgets.json', JSON.stringify(budgets, null, 2) + '\n');
const sourceFiles = ['src/custom-fields/lookup-sources.js', 'src/custom-fields/lookup-source-input.js', 'src/masters/custom-fields.js'];
const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true,
  databaseName: process.env.SAMPLEIFY_TEST_DATABASE_NAME, budgets, fixtures: [], cases: [],
  sourceSha256: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')]))),
  conditions: 'Run alone on isolated PostgreSQL. Each Product/Parameter fixture has 500 actual active bound definitions and a complete 0/10/1000/10000-line catalog, 80-character original IDs and 160-character labels. Explicit ANALYZE after fixture setup. One warmup/five samples. Actual authentication, repeatable-read read-only transaction, validation, SQL/driver, complete option assembly, commit and JSON serialization included. Setup, assertions, socket/browser transfer excluded. Matching organization/revision reuses complete catalogs including known empty observations; removal retires every current binding. Service query counts exclude auth/control queries whose time is included. No claim about first-operation performance, combined maximums or actual export bounds.' };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const account = async options => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const recordReport = () => writeFile('.local/master-lookup-options-performance.json', JSON.stringify(report, null, 2) + '\n');
async function measure(f, name, input, budgetMs, expectedQueries, expected) {
  const record = { kind: f.kind, sourceId: f.sourceId, lineCount: f.lines.length, name, budgetMs, expectedQueries, samples: [] }; report.cases.push(record);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; const start = performance.now();
    const result = await work(f.reader, (client, identity) => loadMasterFieldLookupOptions(f.kind, { async query(...args) {
      queries++; const at = performance.now(); try { return await client.query(...args); } finally { sqlMs += performance.now() - at; }
    } }, identity, { sourceId: f.sourceId, ...input }), true);
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - start, sqlMs, queries, bytes };
    if (index) record.samples.push(sample); else record.warmup = sample;
    assert.equal(queries, expectedQueries); assert.deepEqual(result, expected); sample.validated = true;
  }
  record.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(record.samples.map(sample => sample[key]))]));
  record.passed = record.metrics.totalMs <= budgetMs;
  console.log(JSON.stringify({ kind: f.kind, name, lineCount: f.lines.length, budgetMs, ...record.metrics, passed: record.passed })); await recordReport();
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const kind of ['product', 'parameter']) for (const lineCount of [0, 10, 1000, 10000]) {
    const setup = performance.now(); const author = await account({ permissions: ['masters.manage'] });
    const reader = await account({ organizationId: author.organizationId, permissions: ['masters.read'] });
    const sourceId = randomUUID(); const fieldIds = Array.from({ length: 500 }, () => randomUUID());
    const lines = Array.from({ length: lineCount }, (_, index) => ({ id: `original_${index}`.padEnd(80, 'v'), label: `Choice ${index}`.padEnd(160, 'l') }));
    const fixture = { kind, organizationId: author.organizationId, sourceId, fieldIds, lineCount, fields: 500 }; report.fixtures.push(fixture);
    await work(author, (c, i) => saveLookupSourceObservation(c, i, { id: sourceId, requestId: randomUUID(), revision: 0,
      sourceId: 'Original-options-' + randomUUID(), name: 'Shared source', lines }));
    await work(author, async (c, i) => {
      for (let index = 0; index < fieldIds.length; index++) await saveCustomField(c, i, { id: fieldIds[index], requestId: randomUUID(), revision: 0,
        key: `lookup_${index}`, label: `Lookup ${index}`, associatedWith: kind, fieldType: 'lookup', lookupSourceId: sourceId, displayOrder: index });
    });
    const analyze = performance.now(); await owner.query('ANALYZE users,memberships,custom_field_definitions,custom_field_versions,custom_field_lookup_sources,custom_field_lookup_versions,custom_field_lookup_lines');
    fixture.analyzeMs = performance.now() - analyze; fixture.setupMs = performance.now() - setup;
    const f = { kind, reader, sourceId, lines }; const context = { organizationId: author.organizationId, sourceId };
    await measure(f, 'complete current catalog', {}, budgets.complete[lineCount], 2,
      { ...context, revision: 1, options: lines.map(line => ({ value: line.id, label: line.label })) });
    if (lineCount === 0 || lineCount === 10000) await measure(f, 'unchanged current catalog', { revision: 1, knownOrganizationId: author.organizationId },
      budgets.unchanged, 1, { ...context, revision: 1, unchanged: true });
    if (lineCount === 10000) {
      await work(author, async (c, i) => {
        for (const id of fieldIds) await retireCustomField(c, i, { id, requestId: randomUUID(), revision: 1 });
      });
      await measure(f, 'retired bindings clear the cached catalog', { revision: 1, knownOrganizationId: author.organizationId }, budgets.retired, 1,
        { ...context, revision: null, options: [] });
    }
  }
  assert.equal(report.cases.length, 14); report.status = report.cases.every(record => record.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('Master catalog budgets failed; preserve and diagnose.');
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code, constraint: error.constraint }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await recordReport(); await closePool(); await owner.end(); }
