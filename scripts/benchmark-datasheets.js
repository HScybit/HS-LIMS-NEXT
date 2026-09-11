import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { performanceFixtures, performanceRecords } from '../tests/helpers/template-performance.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool, database } from '../src/db/pool.js';
import { createTemplate, copyDefinition, editTemplate } from '../src/templates/authoring.js';
import { resolveCaptureVersion } from '../src/templates/snapshots.js';
import { saveCapture, recalculateCapture, changeRepeat } from '../src/templates/capture.js';
import { assertCaptureSize } from '../src/templates/runtime-limits.js';
import { registerSample } from '../src/samples/register.js';
import { generateTestRequests } from '../src/test-requests/generate.js';
import { allocateTestRequest } from '../src/test-requests/allocate.js';
import { loadDatasheet } from '../src/datasheets/service.js';

const runs = 30;
const path = '.local/datasheet-performance.json';
const owner = ownerPool();
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
};
const report = { generatedAt: new Date().toISOString(), synthetic: true, status: 'running', runs, fixtures: [],
  environment: { node: process.version, platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30), poolSize: 10, statementTimeoutMs: 30_000 },
  conditions: { database: 'Dedicated local synthetic PostgreSQL with RLS; ANALYZE after population.', firstLoad: 'First measured load; database buffers are not cold.',
    transactions: 'Session authentication and BEGIN/COMMIT included in all end-to-end timings.', sourceLatency: 'Not measured.',
    concurrentUsers: 'One assigned analyst plus independent readers in the same synthetic organization.',
    scope: 'Allocated datasheet route service, repeated captures and immutable runtime snapshot creation. Full scientific submission and output remain pending.' } };
async function saveReport() { await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 }); }
try {
  await mkdir('.local', { recursive: true, mode: 0o700 });
  try { await copyFile(path, `.local/datasheet-performance-${Date.now()}.json`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  report.environment.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  report.environment.packages = JSON.parse(await readFile('package.json', 'utf8')).dependencies;
  report.schemaJournalSha256 = createHash('sha256').update(await readFile('drizzle/meta/_journal.json')).digest('hex');
  report.sourceFileHashes = {};
  for (const path of ['next.config.js', 'src/datasheets/service.js', 'src/datasheets/transport.js', 'src/templates/loader.js', 'src/templates/model.js', 'src/templates/calculations.js', 'src/templates/capture.js',
    'src/templates/access.js', 'src/templates/runtime-limits.js', 'src/components/datasheets/DatasheetResults.jsx', 'src/components/templates/TemplateCanvas.jsx', 'scripts/benchmark-datasheets.js']) {
    report.sourceFileHashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  const account = await createAccount(owner, { permissions: ['templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (action, readOnly = false) => withSession(session.token, action, { readOnly, csrfToken: session.csrfToken });
  const sessions = [session];
  for (let index = 1; index < 20; index += 1) {
    const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['samples.read'] });
    sessions.push(await signIn({ identifier: reader.username, password: reader.password }));
  }
  for (const fixture of performanceFixtures) {
    report.phase = `${fixture.name}: populate`; await saveReport();
    const records = performanceRecords(fixture);
    const template = await work(async (client, identity) => {
      const created = await createTemplate(client, identity, { name: `Synthetic runtime ${fixture.name}`, kind: 'datasheet' });
      await copyDefinition(database(client), records, identity.organization_id, created.versionId);
      return { ...created, records };
    });
    const scientific = await createLaboratoryFixture(owner, account, { template });
    const sample = await work((client, identity) => registerSample(client, identity, scientific.registration));
    const generated = await work((client, identity) => generateTestRequests(client, identity, sample.id));
    const requestId = generated.items[0].id;
    const allocationStart = performance.now();
    const allocation = await work((client, identity) => allocateTestRequest(client, identity, requestId, { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId }));
    const firstAllocationMs = performance.now() - allocationStart;
    const loaded = await work((client, identity) => loadDatasheet(client, identity, allocation.datasheetId), true);
    const captureId = loaded.capture.instance.id;
    const fieldsByGroup = new Map();
    for (const field of Object.values(loaded.model.fieldsById)) {
      if (field.widget === 'formula_widget') continue;
      const key = field.repeatGroupId ?? null;
      if (!fieldsByGroup.has(key)) fieldsByGroup.set(key, []);
      fieldsByGroup.get(key).push(field);
    }
    const inputs = loaded.capture.occurrences.flatMap((occurrence) => (fieldsByGroup.get(occurrence.groupId ?? null) ?? []).map((field) => ({
      fieldId: field.id, occurrenceId: occurrence.id, state: 'present', value: field.valueType === 'option' ? field.options[0].id : '1.25' })));
    let revision = loaded.capture.revision;
    for (let start = 0; start < inputs.length; start += 1000) revision = (await work((client, identity) => saveCapture(client, identity, captureId, revision, inputs.slice(start, start + 1000)))).revision;
    await owner.query('ANALYZE');
    report.phase = `${fixture.name}: read`; await saveReport();
    async function measureRead(active = session) {
      const start = performance.now();
      let dataQueries = 0;
      const result = await withSession(active.token, async (client, identity) => {
        const query = client.query;
        client.query = function (...args) { dataQueries += 1; return query.apply(this, args); };
        try { return await loadDatasheet(client, identity, allocation.datasheetId); }
        finally { client.query = query; }
      }, { readOnly: true });
      const serializationStart = performance.now(); const payload = JSON.stringify(result); const serializationMs = performance.now() - serializationStart;
      const serviceMs = performance.now() - start; const metrics = result.metrics;
      assert.equal(dataQueries, 12);
      return { serviceMs, serializationMs, dataQueries, databaseMs: metrics.metadataMs + metrics.definition.databaseMs + metrics.capture.databaseMs,
        assemblyMs: metrics.definition.assemblyMs, projectionMs: metrics.projectionMs, calculationMs: metrics.calculationMs,
        bytes: Buffer.byteLength(payload), gzipBytes: gzipSync(payload).length };
    }
    const firstLoad = await measureRead();
    for (let index = 0; index < 3; index += 1) await measureRead();
    const measurements = []; for (let index = 0; index < runs; index += 1) measurements.push(await measureRead());
    const saves = []; const calculations = []; const clones = []; const removals = []; const snapshots = [];
    report.phase = `${fixture.name}: mutate`; await saveReport();
    const input = inputs.find((input) => loaded.model.fieldsById[input.fieldId].valueType === 'numeric');
    const repeated = loaded.capture.occurrences.find((occurrence) => occurrence.groupId);
    for (let index = 0; index < runs; index += 1) {
      let start = performance.now();
      revision = (await work((client, identity) => saveCapture(client, identity, captureId, revision, [{ ...input, value: index % 2 ? '1.25' : '2.5' }]))).revision;
      saves.push(performance.now() - start);
      start = performance.now(); revision = (await work((client, identity) => recalculateCapture(client, identity, captureId, revision))).revision;
      calculations.push(performance.now() - start);
      start = performance.now();
      const clone = await work((client, identity) => changeRepeat(client, identity, captureId, revision, { type: 'clone', occurrenceId: repeated.id, withData: true }));
      clones.push(performance.now() - start); revision = clone.revision;
      const added = clone.occurrences.find((occurrence) => occurrence.createdRevision === revision);
      start = performance.now(); revision = (await work((client, identity) => changeRepeat(client, identity, captureId, revision, { type: 'remove', occurrenceId: added.id }))).revision;
      removals.push(performance.now() - start);
      await work((client, identity) => editTemplate(client, identity, template.versionId, index + 1, { type: 'editDetails', name: `Synthetic runtime ${fixture.name} revision ${index + 2}`, description: '' }));
      start = performance.now(); await work((client, identity) => resolveCaptureVersion(client, identity, template.templateId, { kind: 'datasheet' }));
      snapshots.push(performance.now() - start);
    }
    const concurrency = [];
    report.phase = `${fixture.name}: concurrent reads`; await saveReport();
    for (const count of [1, 5, 20]) {
      const reads = [];
      for (let index = 0; index < runs; index += 1) reads.push(...await Promise.all(sessions.slice(0, count).map(measureRead)));
      concurrency.push({ sessions: count, measurements: reads, serviceMs: stats(reads.map((value) => value.serviceMs)) });
    }
    const sizes = assertCaptureSize(loaded.model, loaded.capture.occurrences);
    report.fixtures.push({ name: fixture.name, organizationId: account.organizationId, templateId: template.templateId, versionId: loaded.model.version.id, instanceId: captureId,
      sampleId: sample.id, requestId, datasheetId: allocation.datasheetId, fixtureSha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
      definitionFields: records.fields.length, expandedValues: sizes.cells, layoutNodes: sizes.layoutNodes, occurrences: loaded.capture.occurrences.length,
      firstAllocationMs, firstLoad, queries: { metadata: 1, definition: 8, capture: 3, fixedAuth: 1, transaction: 2, saveAuthorization: 3 },
      warm: Object.fromEntries(['databaseMs', 'assemblyMs', 'projectionMs', 'serializationMs', 'calculationMs', 'serviceMs'].map((key) => [key, stats(measurements.map((row) => row[key]))])),
      payload: { bytes: firstLoad.bytes, gzipBytes: firstLoad.gzipBytes }, measurements, concurrency,
      mutations: Object.fromEntries(Object.entries({ saves, calculations, clones, removals, snapshots }).map(([name, values]) => [name, { measurements: values, ...stats(values) }])) });
    await saveReport(); console.log(`${fixture.name}: 30 reads/saves/calculations/clones/removals/snapshots and 1/5/20-session reads completed; ${sizes.cells} expanded cells.`);
  }
  report.status = 'completed'; delete report.phase; await saveReport();
} catch (error) {
  report.status = 'failed'; report.failure = { code: (error.cause ?? error).code ?? error.name, message: (error.cause ?? error).message, phase: report.phase };
  await saveReport(); throw error;
} finally { await closePool(); await owner.end(); }
