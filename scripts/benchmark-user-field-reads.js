import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { userCustomFields } from '../src/masters/custom-fields.js';

const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Run alone on local synthetic PostgreSQL. One warmup and five reads, after explicit ANALYZE of populated definition/version/option tables. Actual users.read authentication, read-only repeatable-read transaction, SQL/driver, assembly, commit and JSON serialization included. Fixtures/statistics preparation, socket and browser transfer excluded. Definitions have 200-character descriptions and options have 80-character labels. Service query counts exclude authentication queries, whose time is included. This verifies represented metadata reads, not capture, lookup sources or a complete form.', cases: [] };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const [fieldCount, optionCount, budgetMs] of [[0, 0, 50], [10, 5, 100], [100, 20, 250], [500, 50, 750]]) {
    const author = await createAccount(owner, { permissions: ['masters.manage'] });
    const reader = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.read'] });
    const authorSession = await signIn({ identifier: author.username, password: author.password });
    const readerSession = await signIn({ identifier: reader.username, password: reader.password });
    const ids = Array.from({ length: fieldCount }, () => randomUUID()); const setupAt = performance.now();
    if (fieldCount) await withSession(authorSession.token, async (client, identity) => {
      await client.query(`INSERT INTO custom_field_definitions(organization_id,id,key,label,description,associated_with,field_type,option_count,save_request_id,display_order)
        SELECT $1,id,'field_'||replace(id::text,'-',''),'Field '||position,repeat('d',200),'users','select',$3,gen_random_uuid(),position
        FROM unnest($2::uuid[]) WITH ORDINALITY AS fixture(id,position)`, [identity.organization_id, ids, optionCount]);
      await client.query(`INSERT INTO custom_field_version_options(organization_id,field_id,revision,id,key,label,position)
        SELECT $1,id,1,gen_random_uuid(),'v'||position,lpad(position::text,80,'o'),position
        FROM unnest($2::uuid[]) AS fixture(id) CROSS JOIN generate_series(0,$3::integer-1) AS position`, [identity.organization_id, ids, optionCount]);
    });
    const analyzeAt = performance.now(); await owner.query('ANALYZE custom_field_definitions,custom_field_versions,custom_field_version_options');
    const analyzeMs = performance.now() - analyzeAt;
    const entry = { fieldCount, optionCount, budgetMs, organizationId: author.organizationId, setupMs: performance.now() - setupAt, analyzeMs, samples: [] }; report.cases.push(entry);
    console.log(JSON.stringify({ fixture: fieldCount, optionCount, setupMs: entry.setupMs, analyzeMs }));
    for (let index = 0; index < 6; index++) {
      let queries = 0; let sqlMs = 0; const at = performance.now();
      const fields = await withSession(readerSession.token, (client, identity) => userCustomFields({ async query(...args) {
        queries++; const start = performance.now(); const result = await client.query(...args); sqlMs += performance.now() - start; return result;
      } }, identity), { readOnly: true });
      const loadedAt = performance.now(); const body = JSON.stringify({ fields }); const finishedAt = performance.now();
      assert.equal(fields.length, fieldCount); assert.deepEqual(fields.map(field => field.id), ids); assert.equal(queries, fieldCount ? 2 : 1);
      assert(fields.every(field => field.options.length === optionCount && field.description.length === 200 && field.options.every(option => option.label.length === 80)));
      const sample = { totalMs: finishedAt - at, sqlMs, serializationMs: finishedAt - loadedAt, queries, bytes: Buffer.byteLength(body) };
      if (index) entry.samples.push(sample); else entry.warmup = sample;
    }
    entry.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'serializationMs', 'queries', 'bytes'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
    entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ fieldCount, optionCount, budgetMs, ...entry.metrics, passed: entry.passed }));
  }
  report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('User field read budgets failed. Preserve the report and diagnose.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-field-reads-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
