import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { loadUserFieldUserOptions } from '../src/users/custom-fields.js';

const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, cases: [],
  conditions: 'Run alone against dedicated synthetic PostgreSQL.10000 member fixtures plus the reader,160-character names, mixed identity/membership activity, explicit ANALYZE.500-candidate keyset batches and at most50 results. Exact react-select5.10.2 filter. One warmup/five samples. Authentication, read-only repeatable-read transaction, normalization/filtering, SQL/driver, assembly, commit and JSON serialization included; setup, verification and browser/socket transfer excluded. Bulk selected-user fixtures have no credentials/sign-in capability. Service query counts exclude auth queries whose time is included.' };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  const reader = await createAccount(owner, { permissions: ['users.read'] }); const session = await signIn({ identifier: reader.username, password: reader.password });
  const prefix = randomUUID(); const started = performance.now();
  const people = (await owner.query(`INSERT INTO users(id,username,email,display_name,active)
    SELECT ($1||'-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$2||n,$2||n||'@example.invalid',
      rpad(CASE WHEN n=10000 THEN 'Last_Élodie/choice' ELSE 'Common_Åsa/person' END,160,'x'),n%5<>0
    FROM generate_series(1,10000) n RETURNING id,display_name AS name`, [prefix.slice(0, 8), prefix])).rows.sort((a, b) => a.id.localeCompare(b.id));
  await owner.query(`INSERT INTO memberships(organization_id,user_id,active)
    SELECT $1,id,position%3<>0 FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(id,position)`, [reader.organizationId, people.map(row => row.id)]);
  const analyzeStarted = performance.now(); await owner.query('ANALYZE users,memberships');
  report.fixture = { organizationId: reader.organizationId, totalMembers: 10001, fixtureMembers: 10000, nameCharacters: 160, setupMs: performance.now() - started, analyzeMs: performance.now() - analyzeStarted };
  const all = [...people, { id: reader.userId, name: 'Synthetic Analyst' }].sort((a, b) => a.id.localeCompare(b.id));
  for (const [name, search, expectedRows, hasMore, queries, budgetMs] of [
    ['empty', '', all.slice(0, 50), true, 1, 150],
    ['common', 'common asa', people.slice(0, 50), true, 1, 250],
    ['last-name', 'last elodie', people.slice(-1), false, 21, 750],
    ['last-uuid', people.at(-1).id.toUpperCase(), people.slice(-1), false, 21, 750],
    ['missing', 'no such user!', [], false, 21, 750],
  ]) {
    const entry = { name, search, budgetMs, expectedQueries: queries, samples: [] }; report.cases.push(entry);
    for (let index = 0; index < 6; index++) {
      let count = 0; let sqlMs = 0; const at = performance.now();
      const result = await withSession(session.token, (client, identity) => loadUserFieldUserOptions({ async query(...args) {
        count++; const at = performance.now(); const result = await client.query(...args); sqlMs += performance.now() - at; return result;
      } }, identity, { search }), { readOnly: true });
      const body = JSON.stringify(result); const sample = { totalMs: performance.now() - at, sqlMs, queries: count, bytes: Buffer.byteLength(body) };
      assert.deepEqual(result, { rows: expectedRows, hasMore }); assert.equal(count, queries);
      if (index) entry.samples.push(sample); else entry.warmup = sample;
    }
    entry.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
    entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ name, budgetMs, ...entry.metrics, passed: entry.passed }));
  }
  report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('User-choice budgets failed. Preserve the report and diagnose.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-field-options-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
