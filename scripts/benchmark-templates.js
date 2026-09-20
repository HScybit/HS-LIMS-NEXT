import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { performanceFixtures, performanceRecords } from '../tests/helpers/template-performance.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool, database } from '../src/db/pool.js';
import { createTemplate, copyDefinition, createDraft, freezeTemplate } from '../src/templates/authoring.js';
import { createCapture, saveCapture } from '../src/templates/capture.js';
import { loadCapture, loadDefinition } from '../src/templates/loader.js';
import { calculateCapture } from '../src/templates/calculations.js';
import { templateView, captureView } from '../src/templates/transport.js';

const runs = 30;
const owner = ownerPool();
const report = { generatedAt: new Date().toISOString(), synthetic: true, node: process.version, status: 'running',
  environment: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30), poolSize: 10, statementTimeoutMs: 30_000 },
  conditions: { runs, database: 'Dedicated local PostgreSQL 18.6, Docker, app role with RLS', statistics: 'ANALYZE after fixture population', firstLoad: 'First measured load after fixture insertion; database buffers are not cold', browser: 'Not measured by this server benchmark', sourceLatency: 'Not measured', gaps: ['Role-specific field ACLs', 'Cascading option sources', 'Full widget catalog', 'Print assets'] }, fixtures: [] };
async function saveReport() {
  await mkdir('.local', { recursive: true, mode: 0o700 });
  await writeFile('.local/template-performance.json', JSON.stringify(report, null, 2), { mode: 0o600 });
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}
try {
  let previous;
  if (process.argv.includes('--reuse')) {
    previous = JSON.parse(await readFile('.local/template-performance.json', 'utf8'));
    if (previous.status !== 'completed') throw new Error('Fixture reuse requires a completed benchmark report.');
    await copyFile('.local/template-performance.json', `.local/template-performance-${Date.now()}.json`);
    report.conditions.reusedFixtures = true;
  }
  report.environment.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  report.environment.packages = JSON.parse(await readFile('package.json', 'utf8')).dependencies;
  report.schemaJournalSha256 = createHash('sha256').update(await readFile('drizzle/meta/_journal.json')).digest('hex');
  const organizationId = previous ? (await owner.query('SELECT organization_id FROM templates WHERE id = $1', [previous.fixtures[0].templateId])).rows[0]?.organization_id : undefined;
  if (previous && !organizationId) throw new Error('Synthetic fixture organization was not found.');
  const account = await createAccount(owner, { organizationId, permissions: ['templates.read', 'templates.manage', 'datasheets.execute'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (action, readOnly = false) => withSession(session.token, action, { readOnly, csrfToken: session.csrfToken });
  const sessions = [session];
  for (let index = 1; index < 20; index += 1) {
    const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['templates.read', 'datasheets.execute'] });
    sessions.push(await signIn({ identifier: reader.username, password: reader.password }));
  }
  for (const fixture of performanceFixtures) {
    report.phase = `${fixture.name}: populate`;
    const priorFixture = previous?.fixtures.find((value) => value.name === fixture.name);
    const records = priorFixture ? (await work((client, identity) => loadDefinition(client, identity.organization_id, priorFixture.versionId), true)).records : performanceRecords(fixture);
    const created = priorFixture ?? await work(async (client, identity) => {
      const result = await createTemplate(client, identity, { name: `Synthetic performance ${fixture.name}`, kind: 'datasheet' });
      await copyDefinition(database(client), records, identity.organization_id, result.versionId);
      return result;
    });
    console.log(`${fixture.name}: ${priorFixture ? 'reusing' : 'inserted'} ${records.fields.length} fields and ${records.expressions.length} expressions.`);
    if (!priorFixture) await work((client, identity) => freezeTemplate(client, identity, created.versionId, 1));
    const capture = priorFixture ?? await work((client, identity) => createCapture(client, identity, created.versionId));
    const loaded = await work(async (client, identity) => ({ ...(await loadDefinition(client, identity.organization_id, created.versionId)), capture: await loadCapture(client, identity.organization_id, capture.instanceId) }), true);
    const inputs = [];
    for (const occurrence of loaded.capture.occurrences) for (const field of Object.values(loaded.model.fieldsById)) {
      if ((field.repeatGroupId ?? null) !== (occurrence.groupId ?? null) || field.widget === 'formula_widget') continue;
      inputs.push({ fieldId: field.id, occurrenceId: occurrence.id, state: 'present', value: field.valueType === 'option' ? field.options[0].id : '1.25' });
    }
    let revision = loaded.capture.revision;
    for (let start = 0; !priorFixture && start < inputs.length; start += 1000) {
      const saved = await work((client, identity) => saveCapture(client, identity, capture.instanceId, revision, inputs.slice(start, start + 1000)));
      revision = saved.revision;
    }
    await owner.query('ANALYZE');
    report.phase = `${fixture.name}: read`;
    const measurements = [];
    async function measureRead(token = session.token) {
      const start = performance.now();
      const result = await withSession(token, async (client, identity) => {
        const definition = await loadDefinition(client, identity.organization_id, created.versionId);
        const runtime = await loadCapture(client, identity.organization_id, capture.instanceId);
        const calculation = calculateCapture(definition.model, runtime.occurrences, runtime.values);
        const serializeStart = performance.now();
        const payload = JSON.stringify({ model: templateView(definition.model), capture: captureView(runtime) });
        const serializationMs = performance.now() - serializeStart;
        const measurement = { databaseMs: definition.metrics.databaseMs + runtime.metrics.databaseMs, assemblyMs: definition.metrics.assemblyMs,
          serializationMs, calculationMs: calculation.durationMs,
          definitionQueries: definition.metrics.queryCount, captureQueries: runtime.metrics.queryCount, definitionQueryTimings: definition.metrics.queries };
        return { measurement, payload };
      }, { readOnly: true });
      const serviceMs = performance.now() - start;
      return { ...result.measurement, serviceMs, bytes: Buffer.byteLength(result.payload), gzipBytes: gzipSync(result.payload).length };
    }
    const firstLoad = await measureRead();
    for (let index = 0; index < 3; index += 1) await measureRead();
    for (let index = 0; index < runs; index += 1) measurements.push(await measureRead());
    console.log(`${fixture.name}: read p95 ${stats(measurements.map((value) => value.serviceMs)).p95.toFixed(1)} ms.`);
    report.phase = `${fixture.name}: save`;
    const saves = [];
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      const input = { ...inputs[0], value: index % 2 ? '1.25' : '2.5' };
      const saved = await work((client, identity) => saveCapture(client, identity, capture.instanceId, revision, [input]));
      revision = saved.revision; saves.push(performance.now() - started);
    }
    const freezes = [];
    report.phase = `${fixture.name}: freeze`;
    for (let index = 0; index < runs; index += 1) {
      const draft = await work((client, identity) => createDraft(client, identity, created.versionId));
      const started = performance.now();
      await work((client, identity) => freezeTemplate(client, identity, draft.versionId, 1));
      freezes.push(performance.now() - started);
    }
    const concurrency = [];
    report.phase = `${fixture.name}: concurrent reads`;
    for (const count of [1, 5, 20]) {
      const reads = [];
      for (let run = 0; run < runs; run += 1) reads.push(...await Promise.all(sessions.slice(0, count).map((active) => measureRead(active.token))));
      concurrency.push({ sessions: count, measurements: reads.length, serviceMs: stats(reads.map((value) => value.serviceMs)) });
    }
    report.fixtures.push({ name: fixture.name, templateId: created.templateId, versionId: created.versionId, instanceId: capture.instanceId,
      fixtureSha256: priorFixture?.fixtureSha256 ?? createHash('sha256').update(JSON.stringify(records)).digest('hex'),
      definitionFields: records.fields.length, definitionColumns: records.columns.length, sections: records.sections.length, expressions: records.expressions.length,
      groups: records.groups.length, occurrences: loaded.capture.occurrences.length, expandedValues: inputs.length + calculateCapture(loaded.model, loaded.capture.occurrences, []).calculated.length,
      firstLoad, warm: Object.fromEntries(['databaseMs', 'assemblyMs', 'serializationMs', 'calculationMs', 'serviceMs'].map((key) => [key, stats(measurements.map((value) => value[key]))])),
      queries: { definition: firstLoad.definitionQueries, capture: firstLoad.captureQueries, fixedAuth: 1, transaction: 2 },
      payload: { bytes: firstLoad.bytes, gzipBytes: firstLoad.gzipBytes }, saveMs: stats(saves), freezeMs: stats(freezes), saveMeasurements: saves, freezeMeasurements: freezes, concurrency, measurements });
    await saveReport();
    console.log(`${fixture.name}: measured 30 reads, saves and freezes, plus 1/5/20-session loads; report saved.`);
  }
  report.status = 'completed'; delete report.phase; await saveReport();
} catch (error) {
  report.status = 'failed'; report.failure = { code: (error.cause ?? error).code ?? error.name, phase: report.phase };
  await saveReport(); throw error;
} finally { await closePool(); await owner.end(); }
