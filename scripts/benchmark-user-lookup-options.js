import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveLookupSourceObservation } from '../src/custom-fields/lookup-sources.js';
import { loadUserFieldLookupOptions } from '../src/users/custom-fields.js';

if (!/^sampleify_verify_[a-f0-9]{32}$/.test(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '')) {
  throw new Error('Lookup option benchmarks require an explicitly selected isolated verification database.');
}
const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, fixtures: [], cases: [],
  conditions: 'Run alone on isolated PostgreSQL. Full0/10/1000/10000-line catalogs,80-character original IDs,160-character labels,500 actual active user definitions per source; explicit ANALYZE after fixture setup. One warmup/five samples. Actual authentication, repeatable-read read-only transaction, validation, SQL/driver, complete option assembly, commit and JSON serialization included. Fixture setup, verification, socket and browser transfer excluded. Matching organization/revision reuses the catalog; removal retires every current user binding. Service query counts exclude auth/control queries whose time is included. These cases do not establish arbitrary combined maximums or actual export bounds.' };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const account = async options => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
async function measure(f, name, input, budgetMs, expectedQueries, expected) {
  const record = { sourceId: f.sourceId, lineCount: f.lines.length, name, budgetMs, expectedQueries, samples: [] }; report.cases.push(record);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; const start = performance.now();
    const result = await work(f.reader, (client, identity) => loadUserFieldLookupOptions({ async query(...args) {
      queries++; const at = performance.now(); try { return await client.query(...args); } finally { sqlMs += performance.now() - at; }
    } }, identity, { sourceId: f.sourceId, ...input }), true);
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - start, sqlMs, queries, bytes };
    if (index) record.samples.push(sample); else record.warmup = sample;
    assert.equal(queries, expectedQueries); assert.deepEqual(result, expected); sample.validated = true;
  }
  record.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(record.samples.map(sample => sample[key]))]));
  record.passed = record.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ name, lineCount: f.lines.length, budgetMs, ...record.metrics, passed: record.passed }));
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const lineCount of [0, 10, 1000, 10000]) {
    const setup = performance.now(); const author = await account({ permissions: ['masters.manage'] });
    const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
    const sourceId = randomUUID(); const fieldIds = Array.from({ length: 500 }, () => randomUUID());
    const lines = Array.from({ length: lineCount }, (_, index) => ({ id: `original_${index}`.padEnd(80, 'v'), label: `Choice ${index}`.padEnd(160, 'l') }));
    const fixture = { organizationId: author.organizationId, sourceId, fieldIds, lineCount, fields: 500 }; report.fixtures.push(fixture);
    await work(author, (c, i) => saveLookupSourceObservation(c, i, { id: sourceId, requestId: randomUUID(), revision: 0, sourceId: 'Original-options-' + randomUUID(), name: 'Shared source', lines }));
    await work(author, (c, i) => c.query(`INSERT INTO custom_field_definitions
      (organization_id,id,key,label,associated_with,field_type,lookup_source_id,save_request_id,display_order)
      SELECT $1,id,'lookup_'||position,'Lookup '||position,'users','lookup',$3,gen_random_uuid(),position
      FROM unnest($2::uuid[]) WITH ORDINALITY AS fields(id,position)`, [i.organization_id, fieldIds, sourceId]));
    const analyze = performance.now(); await owner.query('ANALYZE users,memberships,custom_field_definitions,custom_field_versions,custom_field_lookup_sources,custom_field_lookup_versions,custom_field_lookup_lines');
    fixture.analyzeMs = performance.now() - analyze; fixture.setupMs = performance.now() - setup;
    const f = { author, reader, sourceId, lines }; const context = { organizationId: author.organizationId, sourceId };
    await measure(f, 'complete current catalog', {}, lineCount <= 10 ? 100 : lineCount === 1000 ? 250 : 750, lineCount ? 2 : 1,
      { ...context, revision: lineCount ? 1 : null, options: lines.map(line => ({ value: line.id, label: line.label })) });
    if (lineCount === 10000) {
      await measure(f, 'unchanged current catalog', { revision: 1, knownOrganizationId: author.organizationId }, 100, 1, { ...context, revision: 1, unchanged: true });
      await work(author, (c, i) => c.query(`UPDATE custom_field_definitions SET active=false,revision=revision+1,save_request_id=gen_random_uuid(),updated_at=transaction_timestamp()
        WHERE organization_id=$1 AND id=ANY($2::uuid[])`, [i.organization_id, fieldIds]));
      await measure(f, 'retired bindings clear the cached catalog', { revision: 1, knownOrganizationId: author.organizationId }, 100, 1, { ...context, revision: null, options: [] });
    }
  }
  assert.equal(report.cases.length, 6); report.status = report.cases.every(record => record.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('Lookup choice budgets failed; preserve and diagnose.');
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code, constraint: error.constraint }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-lookup-options-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
