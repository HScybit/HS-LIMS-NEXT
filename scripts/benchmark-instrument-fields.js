import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createInstrumentFieldFixture } from '../tests/helpers/instrument-field-fixtures.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { instrumentCustomFields } from '../src/masters/custom-fields.js';
import { loadInstrumentCore, saveInstrumentCore } from '../src/instruments/core.js';
import { listInstruments } from '../src/instruments/list.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../tests/helpers/module-access.js';
import { generateInstrumentCustomFields } from '../src/instruments/custom-field-generation.js';
import { instrumentServiceTypeCatalog } from '../src/instruments/service-types.js';

assert.match(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic verification database.');
// serviceCount is capped at 3 (the fixed Instrument service type catalog — see
// src/instruments/service-types.js); it no longer scales with fixture size.
const fixtures = [
  { name: 'small', fieldCount: 10, instrumentCount: 10, serviceCount: 2, readP95Ms: 150, listP95Ms: 200, saveP95Ms: 500, generationP95Ms: 400, payloadBytes: 131072 },
  { name: 'large', fieldCount: 100, instrumentCount: 10, serviceCount: 3, readP95Ms: 400, listP95Ms: 600, saveP95Ms: 1500, generationP95Ms: 700, payloadBytes: 1572864 },
  { name: 'complex', fieldCount: 500, instrumentCount: 100, serviceCount: 3, readP95Ms: 1500, listP95Ms: 3500, saveP95Ms: 6000, generationP95Ms: 1500, payloadBytes: 16777216 },
];
const budgets = { recordedAt: new Date().toISOString(), warmups: 3, samples: 30, fixtures,
  queryBounds: { definitions: 3, load: 9, list: 8, generation: 5, save: 30 },
  browser: { small: { readyP95Ms: 1200, inputPaintP95Ms: 100, saveP95Ms: 1500 }, large: { readyP95Ms: 2500, inputPaintP95Ms: 200, saveP95Ms: 3000 }, complex: { readyP95Ms: 6000, inputPaintP95Ms: 500, saveP95Ms: 8000 } } };
await mkdir('.local', { recursive: true });
await writeFile('.local/instrument-fields-performance-budgets.json', JSON.stringify(budgets, null, 2));
const sourceFiles = ['src/instruments/core.js', 'src/masters/master-custom-field-values.js', 'src/instruments/list.js',
  'src/instruments/custom-field-generation.js', 'src/custom-fields/product-generation-worker.js', 'tests/helpers/instrument-field-fixtures.js'];
const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, budgets, fixtures: [],
  conditions: ['Dedicated loopback PostgreSQL, restricted application role and real authenticated transactions.',
    'Three warmups and thirty sequential measured operations; setup and the first operation are separate.',
    'SQL duration includes driver transport. Service duration includes SQL, validation and assembly; JSON serialization is measured separately.',
    'Instrument queries enforce configured module and record access, allowed users, configured services and fields. Native completion checks and receipts are measured.',
    'Standard text lengths, five options per select, repeated numbers including zero and invalid text, dates and tenant user references.',
    'Three ordered schemes with one history counter. This does not claim constant queries for arbitrary independent counters or pathological patterns.',
    'No source runtime timing comparison, real data, cold-cache or concurrent-load performance claim.'],
  environment: { node: process.version, cpu: cpus()[0]?.model, memoryBytes: totalmem() },
  sourceSha256: Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, createHash('sha256').update(await readFile(file)).digest('hex')]))) };
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const owner = ownerPool();
try {
  report.environment.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const fixture of fixtures) {
    const account = await createAccount(owner, { permissions: ['masters.manage', 'instruments.manage', 'settings.manage'] });
    const session = await signIn({ identifier: account.username, password: account.password });
    const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
    const modules = emptyModuleAccess(); modules[2] = { ...modules[2], enabled: true, userIds: [account.userId] };
    const serviceTypes = instrumentServiceTypeCatalog.slice(0, fixture.serviceCount);
    await saveModuleAccessSettings({ ...account, ...session }, modules);
    const laboratoryId = randomUUID();
    await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2,'PERFORMANCE','Performance lab')", [account.organizationId, laboratoryId]);
    const setupStart = performance.now();
    const data = await createInstrumentFieldFixture(work, { ...fixture, userId: account.userId, laboratoryId, serviceTypes });
    let current = data.instruments[0];
    const result = { ...fixture, organizationId: account.organizationId, instrumentId: current.id, fieldIds: data.fields.map((field) => field.id),
      setupMs: performance.now() - setupStart, capturedItems: current.customFields.reduce((total, field) => total + field.items.length, 0), operations: {} };
    report.fixtures.push(result);
    console.log(`${fixture.name}: ${fixture.fieldCount} definitions and ${fixture.instrumentCount} captured Instruments created.`);
    const generationInput = { instrument: { ...data.instrument, code: 'I-0' }, customFieldTimeZone: 'UTC',
      customFields: data.values.map((value, index) => ({ ...value, value: index >= fixture.fieldCount - 3 ? '' : value.value })) };
    const operations = {
      definitions: (client, identity) => instrumentCustomFields(client, identity),
      load: (client, identity) => loadInstrumentCore(client, identity, current.id),
      list: (client, identity) => listInstruments(client, identity, { pageSize: fixture.instrumentCount, search: 'Synthetic' }),
      generation: (client, identity) => generateInstrumentCustomFields(client, identity, generationInput),
      save: async (client, identity) => {
        current = await saveInstrumentCore(client, identity, { ...data.instrument, code: current.code, name: current.name, id: current.id, revision: current.revision,
          requestId: randomUUID(), customFields: data.values, customFieldTimeZone: 'UTC' });
        return current;
      },
    };
    for (const [name, action] of Object.entries(operations)) {
      const measurements = []; let first;
      for (let run = -budgets.warmups; run < budgets.samples; run++) {
        const sample = { statements: 0, sqlMs: 0 }; const start = performance.now();
        await work(async (client, identity) => {
          const measured = { async query(...args) {
            const before = performance.now(); try { return await client.query(...args); }
            finally { sample.statements++; sample.sqlMs += performance.now() - before; }
          } };
          const before = performance.now(); const output = await action(measured, identity); sample.serviceMs = performance.now() - before;
          if (name === 'definitions') assert.equal(output.length, fixture.fieldCount);
          if (name === 'load' || name === 'save') assert.equal(output.customFields.length, fixture.fieldCount);
          if (name === 'list') assert.equal(output.rows.length, fixture.instrumentCount);
          if (name === 'generation') assert.deepEqual(output.values.map((value) => value.value), ['C/002', 'C/002/copy', 'C/002/copy/copy']);
          const serialize = performance.now(); const payload = JSON.stringify(output); sample.serializeMs = performance.now() - serialize;
          sample.payloadBytes = Buffer.byteLength(payload);
        }, name !== 'save');
        sample.authenticatedTransactionMs = performance.now() - start;
        if (run === -budgets.warmups) first = sample;
        if (run >= 0) measurements.push(sample);
      }
      const summary = Object.fromEntries(['sqlMs', 'serviceMs', 'serializeMs', 'authenticatedTransactionMs'].map((key) => [key, p95(measurements.map((sample) => sample[key]))]));
      summary.statements = Math.max(...measurements.map((sample) => sample.statements));
      summary.payloadBytes = Math.max(...measurements.map((sample) => sample.payloadBytes));
      const limit = name === 'save' ? fixture.saveP95Ms : name === 'generation' ? fixture.generationP95Ms : name === 'list' ? fixture.listP95Ms : fixture.readP95Ms;
      const checks = { service: summary.serviceMs <= limit, queries: summary.statements <= budgets.queryBounds[name], payload: summary.payloadBytes <= fixture.payloadBytes };
      result.operations[name] = { summary, checks, first, measurements };
      console.log(JSON.stringify({ fixture: fixture.name, operation: name, summary, checks }));
      await writeFile('.local/instrument-fields-performance.json', JSON.stringify(report, null, 2));
    }
  }
  report.status = report.fixtures.every((fixture) => Object.values(fixture.operations).every((operation) => Object.values(operation.checks).every(Boolean))) ? 'completed' : 'failed';
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile('.local/instrument-fields-performance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error }));
  await closePool(); await owner.end();
}
