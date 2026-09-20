import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveLookupSourceObservation } from '../src/custom-fields/lookup-sources.js';
import { saveCustomField, retireCustomField } from '../src/masters/custom-fields.js';
import { saveProduct, loadProduct } from '../src/masters/products.js';
import { saveTestParameter, loadTestParameter } from '../src/masters/test-parameters.js';

if (!/^sampleify_verify_[a-f0-9]{32}$/.test(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '')) {
  throw new Error('Master lookup benchmarks require an explicitly selected isolated verification database.');
}
const budgets = { recordedAt: new Date().toISOString(), warmups: 1, samples: 5, payloadBytes: 8 * 1024 * 1024,
  fields100: { capture: 750, read: 250 }, fields500: { capture: 2500, read: 750, retry: 1000, retain: 2500, recover: 2500, omission: 2500, omissionRetry: 1000 },
  queries: { product: { capture: 16, read: 5, retry: 8, retain: 19, recover: 19, omission: 16, omissionRetry: 8 },
    parameter: { capture: 15, read: 4, retry: 7, retain: 17, recover: 17, omission: 14, omissionRetry: 7 } } };
await writeFile('.local/master-lookup-fields-performance-budgets.json', JSON.stringify(budgets, null, 2) + '\n');
const sourceFiles = ['src/masters/master-custom-field-values.js', 'src/masters/products.js', 'src/masters/test-parameters.js',
  'src/masters/custom-fields.js', 'drizzle/0148_master_lookup_field_values.sql', 'drizzle/0149_master_field_writer_session.sql',
  'drizzle/0150_master_field_unique_probe.sql'];
const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, budgets, fixtures: [], cases: [],
  conditions: 'Run alone on isolated local PostgreSQL. One warmup/five samples; each master kind has 100/500 lookup fields sharing one actual 10000-line observation, with 10 selected 80-character original IDs per field and 160-character labels. Seven records, including a separate priming capture after explicit ANALYZE, followed by another ANALYZE. Auth, normalization, transaction, SQL/driver, integrity checks, full master assembly, commit and JSON serialization included. Setup and verification reads excluded; service query counts exclude auth/control queries whose time is included. No tags, uncertainty grid or laboratory binding in these fixtures. Current source clear/reappearance and definition retirement use actual commands. This does not establish first-operation performance after an unanalyzed bulk load, combined field maxima, 16000-character labels, browser transfer or concurrency.',
  sourceSha256: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')]))) };
const owner = ownerPool();
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const account = async options => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const apis = { product: { save: saveProduct, load: loadProduct }, parameter: { save: saveTestParameter, load: loadTestParameter } };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const analyze = () => owner.query(`ANALYZE users,memberships,custom_field_definitions,custom_field_versions,custom_field_lookup_sources,
  custom_field_lookup_versions,custom_field_lookup_lines,products,product_versions,product_version_custom_fields,product_version_custom_field_values,
  test_parameters,test_parameter_versions,parameter_version_custom_fields,parameter_version_custom_field_values`);
const recordReport = () => writeFile('.local/master-lookup-fields-performance.json', JSON.stringify(report, null, 2) + '\n');
async function fixture(kind, fieldCount) {
  const start = performance.now(); const author = await account({ permissions: ['masters.manage'] });
  const manager = await account({ organizationId: author.organizationId, permissions: ['masters.manage'] });
  const record = { kind, fieldCount, sourceLineCount: 10000, itemsPerField: 10, organizationId: author.organizationId, setupStage: 'source observation' };
  report.fixtures.push(record); await recordReport();
  const lines = Array.from({ length: 10000 }, (_, index) => ({ id: `original_flat_${index}`.padEnd(80, 'v'), label: `Actual label ${index}`.padEnd(160, 'l') }));
  const source = { id: randomUUID(), requestId: randomUUID(), revision: 0, sourceId: 'Original-' + randomUUID(), name: 'Shared master lookup', lines };
  await work(author, (c, i) => saveLookupSourceObservation(c, i, source));
  const fields = []; record.setupStage = 'bound definitions';
  await work(author, async (c, i) => {
    for (let index = 0; index < fieldCount; index++) fields.push(await saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key: `lookup_${index}`, label: `Lookup ${index}`.padEnd(160, 'f'), displayOrder: index, fieldType: 'lookup', associatedWith: kind,
      lookupSourceId: source.id, allowsMultiple: true }));
  });
  const values = Array.from({ length: 10 }, (_, index) => lines[index * 1000].id);
  const display = Array.from({ length: 10 }, (_, index) => lines[index * 1000].label).join(', ');
  const commands = Array.from({ length: 7 }, (_, index) => ({ id: randomUUID(), name: 'Captured master lookup', key: randomUUID(),
    ...(kind === 'parameter' ? { schemeAbbreviation: `Lookup_${index}` } : {}), requestId: randomUUID(), revision: 0,
    customFields: fields.map(field => ({ fieldId: field.id, fieldRevision: 1, value: values })) }));
  record.sourceId = source.id; record.fieldIds = fields.map(field => field.id); record.masterIds = commands.map(command => command.id);
  await analyze(); record.setupStage = 'separate priming capture';
  await work(manager, (c, i) => apis[kind].save(c, i, commands[6])); await analyze();
  record.setupStage = 'complete'; record.setupMs = performance.now() - start; await recordReport();
  return { kind, api: apis[kind], author, manager, record, fields, values, display, source, commands };
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
async function measure(f, name, readOnly, action, validate) {
  const expectedQueries = budgets.queries[f.kind][name]; const budgetMs = budgets[`fields${f.fields.length}`][name];
  const record = { kind: f.kind, fieldCount: f.fields.length, name, budgetMs, expectedQueries, samples: [] }; report.cases.push(record);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; let lookupQueries = 0; const statements = []; const start = performance.now();
    const result = await work(f.manager, (client, identity) => action({ async query(...args) {
      queries++; if (args[0].includes('JOIN custom_field_lookup_lines line')) {
        lookupQueries++; assert.equal(args[1][1].length, 10); assert.equal(new Set(args[1][1]).size, 1); assert.equal(new Set(args[1][2]).size, 10);
      }
      const at = performance.now(); try { return await client.query(...args); }
      finally { const ms = performance.now() - at; sqlMs += ms; statements.push({ sql: args[0], ms }); }
    } }, identity, index), readOnly);
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - start, sqlMs, queries, lookupQueries, bytes, statements };
    if (index) record.samples.push(sample); else record.warmup = sample;
    assert.equal(queries, expectedQueries); assert.equal(lookupQueries, ['capture', 'retain', 'recover'].includes(name) ? 1 : 0);
    assert(bytes <= budgets.payloadBytes); await validate(result, index); sample.validated = true;
  }
  record.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'lookupQueries', 'bytes'].map(key => [key, p95(record.samples.map(sample => sample[key]))]));
  record.passed = record.metrics.totalMs <= budgetMs;
  console.log(JSON.stringify({ kind: f.kind, fieldCount: f.fields.length, name, budgetMs, ...record.metrics, passed: record.passed })); await recordReport();
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const kind of ['product', 'parameter']) for (const count of [100, 500]) {
    const f = await fixture(kind, count);
    await measure(f, 'capture', false, (c, i, index) => f.api.save(c, i, f.commands[index]), result => verifyRead(f, result, 1, 1));
    await measure(f, 'read', true, (c, i) => f.api.load(c, i, f.commands[5].id), result => verifyRead(f, result, 1, 1));
    if (count === 500) {
      const original = await work(f.manager, (c, i) => f.api.load(c, i, f.commands[5].id, { atRevision: 1 }), true);
      await measure(f, 'retry', false, (c, i) => f.api.save(c, i, f.commands[5]), result => assert.deepEqual(result, original));
      await work(f.author, (c, i) => saveLookupSourceObservation(c, i, { ...f.source, revision: 1, requestId: randomUUID(), lines: [] })); await analyze();
      await measure(f, 'retain', false, (c, i, index) => f.api.save(c, i, { ...f.commands[index], requestId: randomUUID(), revision: 1 }), result => verifyRead(f, result, 2, null, true));
      await work(f.author, (c, i) => saveLookupSourceObservation(c, i, { ...f.source, revision: 2, requestId: randomUUID() })); await analyze();
      await measure(f, 'recover', false, (c, i, index) => f.api.save(c, i, { ...f.commands[index], requestId: randomUUID(), revision: 2 }), result => verifyRead(f, result, 3, 3));
      verifyRead(f, await work(f.manager, (c, i) => f.api.load(c, i, f.commands[5].id, { atRevision: 1 }), true), 1, 1);
      verifyRead(f, await work(f.manager, (c, i) => f.api.load(c, i, f.commands[5].id, { atRevision: 2 }), true), 2, null, true);
      await work(f.author, async (c, i) => { for (const field of f.fields) await retireCustomField(c, i, { id: field.id, revision: 1, requestId: randomUUID() }); });
      await work(f.author, (c, i) => saveLookupSourceObservation(c, i, { ...f.source, revision: 3, requestId: randomUUID(), lines: [] })); await analyze();
      const omissions = f.commands.map(({ customFields: _fields, ...command }) => ({ ...command, requestId: randomUUID(), revision: 3 }));
      await measure(f, 'omission', false, (c, i, index) => f.api.save(c, i, omissions[index]), result => { verifyRead(f, result, 4, 3); assert.equal(result.customFieldsProvided, false); });
      const preserved = await work(f.manager, (c, i) => f.api.load(c, i, f.commands[5].id, { atRevision: 4 }), true);
      await measure(f, 'omissionRetry', false, (c, i) => f.api.save(c, i, omissions[5]), result => assert.deepEqual(result, preserved));
    }
  }
  assert.equal(report.cases.length, 18); report.status = report.cases.every(record => record.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('Configured master lookup budgets failed; preserve and diagnose.');
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code, constraint: error.constraint }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await recordReport(); await closePool(); await owner.end(); }
