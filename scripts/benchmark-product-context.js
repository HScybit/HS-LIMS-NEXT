import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createProductFieldFixture } from '../tests/helpers/product-field-fixtures.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool, database } from '../src/db/pool.js';
import { copyDefinition } from '../src/templates/authoring.js';
import { registerSample } from '../src/samples/register.js';
import { generateTestRequests } from '../src/test-requests/generate.js';
import { allocateTestRequest } from '../src/test-requests/allocate.js';
import { loadDatasheet } from '../src/datasheets/service.js';
import { loadSampleProductContext } from '../src/samples/product-context.js';
import { loadCapture } from '../src/templates/loader.js';
import { saveCapture } from '../src/templates/capture.js';

const fixtures = [
  { name: 'small', fieldCount: 10, productCount: 1, batchP95Ms: 150, datasheetP95Ms: 250, payloadBytes: 131072, browserReadyP95Ms: 1500 },
  { name: 'large', fieldCount: 100, productCount: 10, batchP95Ms: 600, datasheetP95Ms: 750, payloadBytes: 1048576, browserReadyP95Ms: 3000 },
  { name: 'complex', fieldCount: 500, productCount: 100, batchP95Ms: 2000, datasheetP95Ms: 2500, payloadBytes: 8388608, browserReadyP95Ms: 8000 },
];
const budgets = { recordedAt: new Date().toISOString(), warmups: 3, samples: 30, fixtures, batchQueries: 4, datasheetQueries: 17, serializationP95Ms: 500 };
await writeFile('.local/product-context-performance-budgets.json', JSON.stringify(budgets, null, 2));
const sourceFiles = ['src/samples/product-context.js', 'src/templates/product-context.js', 'src/datasheets/context.js', 'src/datasheets/service.js', 'src/templates/calculations.js', 'tests/helpers/product-field-fixtures.js'];
const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, budgets, fixtures: [],
  conditions: ['Restricted app role and authenticated read transactions against dedicated loopback PostgreSQL.',
    'Three warmups and thirty sequential measurements; setup and first loads are recorded separately.',
    'Full sample Product batch and actual allocated datasheet are measured separately. Datasheets select their fixed Product line.',
    'Datasheets place the requested Product widgets in an existing repeated analytical row with two occurrences, input and formula widgets.',
    'Fixed standard text/options and raw zero/false/invalid values. No source runtime, cold-cache, concurrent-load or maximal-text latency claim.'],
  environment: { node: process.version, cpu: cpus()[0]?.model, memoryBytes: totalmem() },
  sourceSha256: Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, createHash('sha256').update(await readFile(file)).digest('hex')]))),
  schemaJournalSha256: createHash('sha256').update(await readFile('drizzle/meta/_journal.json')).digest('hex') };
const p95 = (values) => [...values].sort((left, right) => left - right)[Math.ceil(values.length * .95) - 1];
const owner = ownerPool();
try {
  report.environment.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const fixture of fixtures) {
    const user = await createAccount(owner, { permissions: ['masters.manage', 'templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
    const session = await signIn({ identifier: user.username, password: user.password });
    const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
    const setupStart = performance.now();
    const data = await createProductFieldFixture(work, { ...fixture, userId: user.userId });
    const laboratory = await createLaboratoryFixture(owner, user, { repeated: true });
    const row = laboratory.template.records.rows[0]; const group = laboratory.template.records.groups[0];
    const columns = data.fields.map((field, index) => ({ id: randomUUID(), rowId: row.id, position: index + 2, span: 12 }));
    const fields = data.fields.map((field, index) => ({ id: randomUUID(), columnId: columns[index].id, repeatGroupId: group.id,
      widget: 'product_detail_widget', valueType: 'text', alias: `project_field__splitter__${field.key}`, label: field.label, editable: false, required: true,
      defaultState: 'present', defaultText: 'Configuration only' }));
    await work((client, identity) => copyDefinition(database(client), { sections: [], rows: [], columns, fields, groups: [], expressions: [], options: [] }, identity.organization_id, laboratory.template.versionId));
    await owner.query('INSERT INTO product_sample_categories(organization_id,product_id,sample_category_id) SELECT $1,id,$2 FROM unnest($3::uuid[]) AS product(id)',
      [user.organizationId, laboratory.category.id, data.products.map((product) => product.id)]);
    const registration = { ...laboratory.registration, products: data.products.map((product) => ({ ...laboratory.registration.products[0], productId: product.id,
      tests: laboratory.registration.products[0].tests.map((test) => ({ ...test, decisionRuleId: null })) })) };
    const sample = await work((client, identity) => registerSample(client, identity, registration));
    const requests = await work((client, identity) => generateTestRequests(client, identity, sample.id));
    const allocated = await work((client, identity) => allocateTestRequest(client, identity, requests.items[0].id, { revision: 1, assignmentType: 'analyst', assignedUserId: user.userId }));
    const instanceId = (await owner.query('SELECT template_instance_id FROM datasheets WHERE organization_id=$1 AND id=$2', [user.organizationId, allocated.datasheetId])).rows[0].template_instance_id;
    const capture = await work((client, identity) => loadCapture(client, identity.organization_id, instanceId), true);
    const inputs = laboratory.template.records.fields.filter((field) => field.widget === 'number_widget').flatMap((field) => capture.occurrences
      .filter((row) => row.groupId === field.repeatGroupId).map((row) => ({ fieldId: field.id, occurrenceId: row.id, state: 'present', value: '1.25' })));
    await work((client, identity) => saveCapture(client, identity, instanceId, capture.revision, inputs));
    const result = { ...fixture, organizationId: user.organizationId, sampleId: sample.id, requestId: requests.items[0].id, datasheetId: allocated.datasheetId,
      setupMs: performance.now() - setupStart, definitionFields: fields.length + laboratory.template.records.fields.length, expandedValues: fields.length * 2 + 6, operations: {} };
    report.fixtures.push(result);
    const selectors = fields.map((field) => field.alias);
    const operations = {
      batch: async (client, identity) => {
        const context = await loadSampleProductContext(client, identity, sample.id, selectors);
        assert.equal(Object.keys(context.productsByLineId).length, fixture.productCount);
        for (const product of Object.values(context.productsByLineId)) assert.equal(Object.keys(product.customFieldsByKey).length, fixture.fieldCount);
        return { productDetailsByLineId: context.productDetailsByLineId, primaryProductLineId: context.primaryProductLineId, metrics: context.metrics };
      },
      datasheet: async (client, identity) => {
        const sheet = await loadDatasheet(client, identity, allocated.datasheetId);
        assert.equal(Object.values(sheet.model.fieldsById).filter((field) => field.widget === 'product_detail_widget').length, fixture.fieldCount);
        assert.equal(Object.keys(sheet.dataContext.productDetailsByLineId).length, 1);
        assert.equal(sheet.capture.values.some((value) => fields.some((field) => field.id === value.fieldId)), false);
        return sheet;
      },
    };
    for (const [name, action] of Object.entries(operations)) {
      const measurements = []; let first;
      for (let run = -budgets.warmups; run < budgets.samples; run++) {
        const measured = { queries: 0, sqlMs: 0 }; const start = performance.now();
        await work(async (client, identity) => {
          const tracked = { async query(...args) { const started = performance.now(); try { return await client.query(...args); } finally { measured.queries += 1; measured.sqlMs += performance.now() - started; } } };
          const started = performance.now(); const output = await action(tracked, identity); measured.serviceMs = performance.now() - started;
          measured.stages = output.metrics;
          const serializing = performance.now(); const payload = JSON.stringify(output); measured.serializationMs = performance.now() - serializing; measured.payloadBytes = Buffer.byteLength(payload);
        }, true);
        measured.transactionMs = performance.now() - start;
        if (run === -budgets.warmups) first = measured;
        if (run >= 0) measurements.push(measured);
      }
      const summary = Object.fromEntries(['sqlMs', 'serviceMs', 'serializationMs', 'transactionMs'].map((key) => [key, p95(measurements.map((sample) => sample[key]))]));
      summary.queries = Math.max(...measurements.map((sample) => sample.queries)); summary.payloadBytes = Math.max(...measurements.map((sample) => sample.payloadBytes));
      const checks = { service: summary.serviceMs <= (name === 'batch' ? fixture.batchP95Ms : fixture.datasheetP95Ms), queries: summary.queries === (name === 'batch' ? budgets.batchQueries : budgets.datasheetQueries),
        serialization: summary.serializationMs <= budgets.serializationP95Ms, payload: summary.payloadBytes <= fixture.payloadBytes };
      result.operations[name] = { first, summary, checks, measurements };
      await writeFile('.local/product-context-performance.json', JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ fixture: fixture.name, operation: name, summary, checks }));
    }
  }
  report.status = report.fixtures.every((fixture) => Object.values(fixture.operations).every((operation) => Object.values(operation.checks).every(Boolean))) ? 'completed' : 'failed';
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString(); await writeFile('.local/product-context-performance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error })); await closePool(); await owner.end();
}
