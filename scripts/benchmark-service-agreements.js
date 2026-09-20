import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { ownerPool } from '../tests/helpers/database.js';
import { serviceAgreementFixture, serviceAgreementCommand, agreementWork as work, addAgreementInstruments } from '../tests/helpers/service-agreements.js';
import { closePool } from '../src/db/pool.js';
import { loadServiceAgreement, saveServiceAgreement } from '../src/masters/service-agreements.js';
import { listServiceAgreements } from '../src/masters/service-agreement-list.js';
import { serviceAgreementOptions } from '../src/masters/service-agreement-options.js';

assert.match(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an isolated synthetic verification database.');
const fixtures = [
  { name: 'small', instrumentCount: 10, agreementCount: 10, catalogCount: 10, readP95Ms: 150, listP95Ms: 200, saveP95Ms: 500, payloadBytes: 131072 },
  { name: 'large', instrumentCount: 100, agreementCount: 10, catalogCount: 1000, readP95Ms: 400, listP95Ms: 600, saveP95Ms: 1500, payloadBytes: 1572864 },
  { name: 'complex', instrumentCount: 500, agreementCount: 100, catalogCount: 10000, readP95Ms: 1500, listP95Ms: 3500, saveP95Ms: 6000, payloadBytes: 16777216 },
];
const budgets = { recordedAt: new Date().toISOString(), warmups: 3, samples: 30, fixtures,
  queryBounds: { load: 4, list: 4, save: 15, choices: 13 }, choiceP95Ms: 1000, choicePayloadBytes: 262144,
  browser: { small: { readyP95Ms: 1200, inputPaintP95Ms: 100, saveP95Ms: 1500 }, large: { readyP95Ms: 2500, inputPaintP95Ms: 200, saveP95Ms: 3000 }, complex: { readyP95Ms: 6000, inputPaintP95Ms: 500, saveP95Ms: 8000 } } };
await mkdir('.local', { recursive: true });
await writeFile('.local/service-agreements-performance-budgets.json', JSON.stringify(budgets, null, 2));
const files = ['src/masters/service-agreements.js', 'src/masters/service-agreement-list.js', 'src/masters/service-agreement-options.js', 'drizzle/0196_service_agreement_core.sql'];
const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, budgets, fixtures: [],
  conditions: ['Restricted authenticated sessions on the dedicated loopback synthetic PostgreSQL database; no manual ANALYZE or database-setting changes.',
    'Three warmups and thirty sequential measured operations. First operations and setup are separate; no source, cold-cache or concurrent-load comparison.',
    'Ten source form controls, 10/100/500 captured Instruments, all three services, zero/false and 10/10/100 Agreements.',
    'Catalogs contain 10/1000/10000 native Instruments, half inactive, with 10/100/500 retained selections; last UUID and accent-insensitive search cross all scan pages.',
    'Instrument catalog setup calls the existing native command with validated inputs, original permissions, immutable history and all constraints. No raw fixture heads.',
    'Service duration includes validation, SQL transport and assembly. JSON serialization and the full authenticated transaction are measured separately.'],
  environment: { node: process.version, cpu: cpus()[0]?.model, memoryBytes: totalmem() },
  sourceSha256: Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')]))) };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const owner = ownerPool();
async function seedCatalog(context, total) {
  assert.equal((await owner.query("SELECT count(*)::integer AS count FROM custom_field_definitions WHERE organization_id=$1 AND associated_with='instrument' AND active", [context.actor.organizationId])).rows[0].count, 0);
  await addAgreementInstruments(context, total);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM instrument_versions WHERE organization_id=$1', [context.actor.organizationId])).rows[0].count, total);
}
try {
  report.environment.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const fixture of fixtures) {
    const setup = performance.now(); const context = await serviceAgreementFixture(owner); await seedCatalog(context, fixture.catalogCount);
    const instrumentIds = context.instruments.slice(0, fixture.instrumentCount).map(item => item.id); const agreements = [];
    for (let index = 0; index < fixture.agreementCount; index++) agreements.push(await work(context.actor, (client, identity) => saveServiceAgreement(client, identity,
      serviceAgreementCommand(context, { instrumentIds, includedServices: ['calibration', 'preventivemaintenance', 'breakdown'], notes: `Synthetic agreement ${index}` }))));
    let current = agreements[0]; const last = context.instruments.at(-1);
    const result = { ...fixture, organizationId: context.actor.organizationId, agreementId: current.id, setupMs: performance.now() - setup, operations: {} };
    report.fixtures.push(result); console.log(`${fixture.name}: ${fixture.agreementCount} Agreements and ${fixture.catalogCount} native Instrument choices created.`);
    const operations = {
      load: (client, identity) => loadServiceAgreement(client, identity, current.id),
      list: (client, identity) => listServiceAgreements(client, identity, { pageSize: fixture.agreementCount, search: 'Choice' }),
      choices: (client, identity) => serviceAgreementOptions(client, identity, { kind: 'instruments', selectedIds: instrumentIds, search: last.id.toUpperCase() }),
      choicesAccent: (client, identity) => serviceAgreementOptions(client, identity, { kind: 'instruments', selectedIds: instrumentIds, search: last.name.replace('échelle', 'ECHELLE') }),
      save: async (client, identity) => {
        current = await saveServiceAgreement(client, identity, serviceAgreementCommand(context, { id: current.id, revision: current.revision, instrumentIds,
          includedServices: ['calibration', 'preventivemaintenance', 'breakdown'], noOfServices: 0, cost: '0', inEffect: false, notes: 'Synthetic complete save', attachmentFileId: null }));
        return current;
      },
    };
    for (const [name, action] of Object.entries(operations)) {
      const measurements = []; let first;
      for (let run = -budgets.warmups; run < budgets.samples; run++) {
        const sample = { statements: 0, sqlMs: 0 }; const start = performance.now();
        await work(context.actor, async (client, identity) => {
          const measured = { async query(...args) { const before = performance.now(); try { return await client.query(...args); } finally { sample.statements++; sample.sqlMs += performance.now() - before; } } };
          const before = performance.now(); const output = await action(measured, identity); sample.serviceMs = performance.now() - before;
          if (name === 'load' || name === 'save') assert.equal(output.instrumentIds.length, fixture.instrumentCount);
          if (name === 'list') { assert.equal(output.rows.length, fixture.agreementCount); assert.equal(output.rows[0].equipment_ids.length, fixture.instrumentCount); }
          if (name.startsWith('choices')) { assert.equal(output.rows.length, 1); assert.equal(output.rows[0].id, last.id); assert.equal(output.retained.length, fixture.instrumentCount); }
          const serialize = performance.now(); sample.payloadBytes = Buffer.byteLength(JSON.stringify(output)); sample.serializeMs = performance.now() - serialize;
        }, name !== 'save');
        sample.authenticatedTransactionMs = performance.now() - start; if (run === -budgets.warmups) first = sample; if (run >= 0) measurements.push(sample);
      }
      const summary = Object.fromEntries(['sqlMs', 'serviceMs', 'serializeMs', 'authenticatedTransactionMs'].map(key => [key, p95(measurements.map(sample => sample[key]))]));
      summary.statements = Math.max(...measurements.map(sample => sample.statements)); summary.payloadBytes = Math.max(...measurements.map(sample => sample.payloadBytes));
      const isChoice = name.startsWith('choices'); const limit = isChoice ? budgets.choiceP95Ms : name === 'save' ? fixture.saveP95Ms : name === 'list' ? fixture.listP95Ms : fixture.readP95Ms;
      const checks = { service: summary.serviceMs <= limit, queries: summary.statements <= budgets.queryBounds[isChoice ? 'choices' : name], payload: summary.payloadBytes <= (isChoice ? budgets.choicePayloadBytes : fixture.payloadBytes) };
      result.operations[name] = { summary, checks, first, measurements }; console.log(JSON.stringify({ fixture: fixture.name, operation: name, summary, checks }));
      await writeFile('.local/service-agreements-performance.json', JSON.stringify(report, null, 2));
    }
  }
  report.status = report.fixtures.every(fixture => Object.values(fixture.operations).every(operation => Object.values(operation.checks).every(Boolean))) ? 'completed' : 'failed';
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code, constraint: error.constraint }; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString(); await writeFile('.local/service-agreements-performance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error })); await closePool(); await owner.end();
}
