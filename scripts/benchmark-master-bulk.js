import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const mode = process.argv[2]; const name = process.argv[3] ?? mode;
assert(['stage', 'commands'].includes(mode)); assert(/^[a-z0-9-]+$/.test(name));
const databaseName = process.env.SAMPLEIFY_TEST_DATABASE_NAME;
assert.match(databaseName ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Use an existing isolated synthetic verification database.');
for (const [key, role] of [['DATABASE_URL', 'sampleify_app'], ['MIGRATION_DATABASE_URL', 'sampleify_owner']]) {
  const url = new URL(process.env[key]); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55442'); assert.equal(url.pathname, '/' + databaseName); assert.equal(url.username, role);
}
const { ownerPool, createAccount } = await import('../tests/helpers/database.js');
const { signIn, withSession } = await import('../src/auth/service.js');
const { closePool } = await import('../src/db/pool.js');
const { stageMasterBulk, loadMasterBulkPreview } = await import('../src/masters/bulk-store.js');
const { reviewMasterBulk, processMasterBulk } = await import('../src/masters/bulk-service.js');
const { parseMasterBulkCsv } = await import('../src/masters/bulk-csv.js');
const { saveCustomField } = await import('../src/masters/custom-fields.js');
const owner = ownerPool(); const prefix = `.local/master-bulk-performance-${mode}-${name}`;
const report = { status: 'running', startedAt: new Date().toISOString(), databaseName, mainWrites: false, mode, warmups: 3, samples: 30,
  conditions: 'Sequential local synthetic services. Complete authenticated commits and immediate first preview reads. No manual ANALYZE, database tuning, browser/concurrency claim or foreign-key removal. Every sample is retained.', fixtures: [] };
await writeFile(prefix + '-started.json', JSON.stringify(report) + '\n', { flag: 'wx' });
const p95 = samples => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1];
const stats = async () => (await owner.query("SELECT relname,n_live_tup,n_dead_tup,last_analyze,last_autoanalyze FROM pg_stat_user_tables WHERE relname LIKE 'master_bulk_%' ORDER BY relname")).rows;
async function actorFor() {
  const actor = await createAccount(owner, { permissions: ['masters.manage'] }); const session = await signIn({ identifier: actor.username, password: actor.password });
  return { actor, work: (action, readOnly = false) => withSession(session.token, action, { readOnly }) };
}
async function measure(work, action, readOnly = false) {
  const sample = { queries: 0, sqlMs: 0 }; const started = performance.now(); let result;
  await work(async (client, identity) => {
    const proxy = { query: async (...args) => { const start = performance.now(); try { return await client.query(...args); } finally { sample.queries++; sample.sqlMs += performance.now() - start; } } };
    const start = performance.now(); result = await action(proxy, identity); sample.serviceMs = performance.now() - start;
    const serialize = performance.now(); sample.responseBytes = Buffer.byteLength(JSON.stringify(result)); sample.serializeMs = performance.now() - serialize;
  }, readOnly);
  sample.transactionMs = performance.now() - started; return { sample, result };
}
const metadata = (id, resource, source, label) => ({ id, resource, format: 'csv', fileName: `${label}.csv`, timeZone: 'UTC', sourceSha256: createHash('sha256').update(source).digest('hex') });
try {
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')); assert(journal.entries.length > 0);
  const hashes = []; for (const entry of journal.entries) hashes.push(createHash('sha256').update(await readFile(`drizzle/${entry.tag}.sql`)).digest('hex'));
  assert.deepEqual((await owner.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id')).rows.map(row => row.hash), hashes);
  assert.equal((await owner.query("SELECT 1 FROM pg_constraint WHERE conrelid='master_bulk_cells'::regclass AND conname IN ('master_bulk_cell_version_fk','master_bulk_cell_column_fk')")).rowCount, 2);
  report.migrations = journal.entries.length;
  report.databaseSettings = (await owner.query("SELECT name,setting,unit FROM pg_settings WHERE name IN ('server_version','shared_buffers','work_mem','fsync','synchronous_commit','wal_compression','max_wal_size','checkpoint_timeout') ORDER BY name")).rows;
  report.implementation = {};
  for (const name of ['bulk-store','bulk-service','bulk-row','bulk-csv','bulk-access','products','test-parameters','methods','master-custom-field-values']) report.implementation[`src/masters/${name}.js`] = createHash('sha256').update(await readFile(`src/masters/${name}.js`)).digest('hex');
  report.beforeStatistics = await stats();
  if (mode === 'stage') {
    for (const [rows, columns] of [[10, 10], [1000, 30], [2500, 250]]) {
      const { actor, work } = await actorFor();
      const headers = ['name', 'key', ...Array.from({ length: columns - 2 }, (_, i) => `project_field.field_${i}`)];
      const source = [headers.join(','), ...Array.from({ length: rows }, (_, i) => [`Name ${i}`, `KEY-${i}`, ...Array.from({ length: columns - 2 }, (_, j) => `V${i}_${j}`)].join(','))].join('\n');
      const fixture = { rows, columns, organizationId: actor.organizationId, sourceBytes: Buffer.byteLength(source), budget: { stageMs: 10000, previewMs: 1000 }, measurements: [], warmups: [] }; report.fixtures.push(fixture);
      for (let run = -report.warmups; run < report.samples; run++) {
        const id = randomUUID(); const started = performance.now(); const decoded = parseMasterBulkCsv(source);
        const { sample } = await measure(work, (client, identity) => stageMasterBulk(client, identity, metadata(id, 'products', source, `Synthetic ${rows}x${columns}`), decoded));
        sample.stageMs = performance.now() - started;
        const preview = await measure(work, (client, identity) => loadMasterBulkPreview(client, identity, id), true);
        assert.equal(preview.result.summary.total, rows); assert.equal(preview.result.rows.length, Math.min(rows, 50));
        assert.equal(preview.result.rows[0].values[0], 'Name 0');
        assert.equal(preview.result.rows.at(-1).values.at(-1), `V${Math.min(rows, 50) - 1}_${columns - 3}`);
        const measurement = { id, ...sample, preview: preview.sample };
        (run < 0 ? fixture.warmups : fixture.measurements).push(measurement);
        console.log(JSON.stringify({ mode, rows, columns, run, stageMs: sample.stageMs, previewMs: preview.sample.transactionMs }));
      }
      fixture.p95 = { stageMs: p95(fixture.measurements.map(sample => sample.stageMs)), previewMs: p95(fixture.measurements.map(sample => sample.preview.transactionMs)) };
      fixture.passed = fixture.p95.stageMs <= fixture.budget.stageMs && fixture.p95.previewMs <= fixture.budget.previewMs;
    }
  } else {
    for (const resource of ['products', 'test-parameters', 'methods']) for (const size of ['small', 'maximum']) {
      const { actor, work } = await actorFor(); const baseHeaders = resource === 'products' ? ['name', 'key'] : resource === 'methods' ? ['name', 'uuid', 'parse_num'] : ['name', 'key', 'scheme_abbr'];
      const fieldCount = size === 'small' ? 10 : 250 - baseHeaders.length; const fields = [];
      for (let i = 0; i < fieldCount; i++) fields.push(await work((client, identity) => saveCustomField(client, identity, {
        id: randomUUID(), requestId: randomUUID(), revision: 0, associatedWith: resource === 'products' ? 'product' : resource === 'methods' ? 'method_of_analysis' : 'parameter',
        key: `field_${i}`, label: `Field ${i}`, fieldType: 'text', displayOrder: i,
      })));
      const fixture = { resource, size, rows: 25, fields: fieldCount, organizationId: actor.organizationId, budget: { reviewMs: 5000, processMs: 5000 }, measurements: [], warmups: [] }; report.fixtures.push(fixture);
      for (let run = -report.warmups; run < report.samples; run++) {
        const source = [[...baseHeaders, ...fields.map((_, i) => `project_field.field_${i}`)].join(','), ...Array.from({ length: 25 }, (_, i) => {
          const key = `KEY-${run + report.warmups}-${i}`;
          return [`Record ${i}`, key, ...(resource === 'products' ? [] : [resource === 'methods' ? 'false' : key]), ...fields.map((_, j) => `Value ${i}_${j}`)].join(',');
        })].join('\n');
        const id = randomUUID(); const decoded = parseMasterBulkCsv(source);
        await work((client, identity) => stageMasterBulk(client, identity, metadata(id, resource, source, `Synthetic ${resource} ${size}`), decoded));
        const state = await work((client, identity) => loadMasterBulkPreview(client, identity, id), true);
        const input = { rows: state.rowStates.map(row => ({ id: row.id, revision: 1, requestId: randomUUID() })) };
        const reviewed = await measure(work, (client, identity) => reviewMasterBulk(client, identity, id, input));
        assert(reviewed.result.rows.every(row => row.valid), JSON.stringify(reviewed.result));
        const processed = await measure(work, (client, identity) => processMasterBulk(client, identity, id, {
          rows: reviewed.result.rows.map(row => ({ id: row.id, revision: 1, reviewId: row.reviewId, requestId: randomUUID() })),
        }));
        assert.equal(processed.result.committed, 25, JSON.stringify(processed.result)); assert.equal(processed.result.rejected, 0);
        const measurement = { id, review: reviewed.sample, process: processed.sample };
        (run < 0 ? fixture.warmups : fixture.measurements).push(measurement);
        console.log(JSON.stringify({ mode, resource, size, run, reviewMs: reviewed.sample.transactionMs, processMs: processed.sample.transactionMs }));
      }
      fixture.p95 = { reviewMs: p95(fixture.measurements.map(sample => sample.review.transactionMs)), processMs: p95(fixture.measurements.map(sample => sample.process.transactionMs)) };
      fixture.passed = fixture.p95.reviewMs <= fixture.budget.reviewMs && fixture.p95.processMs <= fixture.budget.processMs;
    }
  }
  report.afterStatistics = await stats(); report.status = report.fixtures.every(fixture => fixture.passed) ? 'passed' : 'budget-failed';
  if (report.status !== 'passed') process.exitCode = 1;
} catch (error) { report.status = 'failed'; report.error = { code: error.code, message: error.message }; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString(); await writeFile(prefix + '.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await closePool(); await owner.end();
}
