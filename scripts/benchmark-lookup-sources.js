import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveLookupSourceObservation, loadLookupSourceObservation } from '../src/custom-fields/lookup-sources.js';

if (!/^sampleify_verify_[a-f0-9]{32}$/.test(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '')) {
  throw new Error('Lookup benchmarks require an explicitly selected isolated verification database.');
}
const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, fixtures: [], cases: [],
  conditions: 'Standalone isolated PostgreSQL, prepared statistics, synthetic flat catalogs of 10/1000/10000 lines with 160-character text labels plus numeric/boolean labels. One warm/five measured samples. Full authentication, transaction, service SQL/driver, assembly, commit/deferred constraints and JSON serialization included. Setup, assertions, HTTP and browser excluded. Service query counts exclude authentication/transaction statements. Writes append native observations; old exact replay follows later revisions. This does not measure imported unknown source distributions, labels near 16000 characters, unanalyzed bulk loads or configured form rendering.' };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
async function measure(f, name, budgetMs, expectedQueries, action, readOnly, validate) {
  const record = { count: f.input.lines.length, name, budgetMs, expectedQueries, samples: [] }; report.cases.push(record);
  for (let sample = 0; sample < 6; sample++) {
    let queries = 0; let sqlMs = 0; const statements = []; const started = performance.now();
    const result = await withSession(f.session.token, (client, identity) => action({ async query(...args) {
      queries++; const at = performance.now();
      try { return await client.query(...args); }
      finally { const ms = performance.now() - at; sqlMs += ms; statements.push({ sql: args[0], ms }); }
    } }, identity), { readOnly });
    const bytes = Buffer.byteLength(JSON.stringify(result)); const metrics = { totalMs: performance.now() - started, sqlMs, queries, bytes, statements };
    assert.equal(queries, expectedQueries); validate(result);
    if (sample) record.samples.push(metrics); else record.warmup = metrics;
  }
  record.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(record.samples.map(sample => sample[key]))]));
  record.passed = record.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ count: record.count, name, budgetMs, ...record.metrics, passed: record.passed }));
}
try {
  for (const [count, saveBudget, readBudget] of [[10, 250, 100], [1000, 750, 250], [10000, 2000, 750]]) {
    const at = performance.now(); const actor = await createAccount(owner, { permissions: ['masters.manage'] });
    const session = await signIn({ identifier: actor.username, password: actor.password });
    const input = { id: randomUUID(), revision: 0, requestId: randomUUID(), sourceId: 'Synthetic-original-' + randomUUID(), name: 'Synthetic flat source',
      lines: Array.from({ length: count }, (_, n) => ({ id: `Original_${String(n).padStart(6, '0')}`, label: n % 3 === 0 ? `Label ${n} `.padEnd(160, 'x') : n % 3 === 1 ? n : false })) };
    const first = await withSession(session.token, (c, i) => saveLookupSourceObservation(c, i, input));
    await owner.query('ANALYZE custom_field_lookup_sources,custom_field_lookup_versions,custom_field_lookup_lines,users,memberships,roles,membership_roles');
    const fixture = { count, organizationId: actor.organizationId, sourceId: input.id, setupMs: performance.now() - at }; report.fixtures.push(fixture);
    const f = { actor, session, input }; let revision = 1;
    await measure(f, 'append observation', saveBudget, 7, (c, i) => saveLookupSourceObservation(c, i, { ...input, revision: revision++, requestId: randomUUID() }), false,
      result => { assert.equal(result.lines.length, count); assert.deepEqual(result.lines, input.lines); });
    await measure(f, 'complete observation read', readBudget, 2, (c, i) => loadLookupSourceObservation(c, i, input.id), true,
      result => { assert.equal(result.revision, 7); assert.deepEqual(result.lines, input.lines); });
    if (count === 10000) await measure(f, 'old exact observation retry', 1000, 4, (c, i) => saveLookupSourceObservation(c, i, input), false,
      result => assert.deepEqual(result, first));
  }
  report.status = report.cases.every(record => record.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') process.exitCode = 1;
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code, constraint: error.constraint }; process.exitCode = 1; }
finally {
  await closePool(); await owner.end(); report.finishedAt = new Date().toISOString();
  await writeFile('.local/lookup-source-benchmark.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error }));
}
