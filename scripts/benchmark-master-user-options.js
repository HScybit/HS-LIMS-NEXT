import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { masterCustomFieldUsers } from '../src/masters/custom-fields.js';

assert.match(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '', /^sampleify_verify_[a-f0-9]{32}$/, 'Run synthetic benchmarks only in an isolated verification database.');
const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, databaseName: process.env.SAMPLEIFY_TEST_DATABASE_NAME,
  conditions: 'Run alone.10000 synthetic members plus reader,160-character names,mixed account/membership activity and explicit ANALYZE.500-candidate name/UUID keyset batches,501 lookahead,at most100 returned matches. Exact react-select5.10.2 filter. One warmup/five samples. Includes authentication,read-only repeatable-read transaction,filtering,SQL/driver,assembly,commit and JSON serialization; excludes setup,oracle checks,browser/socket transfer. Bulk members have no credentials. Service query counts exclude auth queries whose time is included. This does not resolve unrelated master-capture latency tails.',
  budgets: { empty: 150, common: 250, 'last-name': 750, 'last-uuid': 750, missing: 750 }, sourceSha256: {}, cases: [] };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
try {
  report.buildId = (await readFile('.next/BUILD_ID', 'utf8')).trim();
  for (const file of ['src/masters/custom-fields.js','src/users/custom-field-filter.js','src/users/custom-field-options.js','scripts/benchmark-master-user-options.js']) report.sourceSha256[file] = sha(await readFile(file));
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  const reader = await createAccount(owner, { permissions: ['masters.read'] }); const session = await signIn({ identifier: reader.username, password: reader.password });
  const prefix = randomUUID(); const started = performance.now();
  const people = (await owner.query(`INSERT INTO users(id,username,email,display_name,active)
    SELECT ($1||'-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$2||n,$2||n||'@example.invalid',
      rpad(CASE WHEN n=10000 THEN 'ZZ_Last_Élodie/choice' ELSE 'Common_Åsa/person' END,160,'x'),n%5<>0
    FROM generate_series(1,10000) n RETURNING id,display_name AS name`, [prefix.slice(0, 8), prefix])).rows.sort((a, b) => a.id.localeCompare(b.id));
  await owner.query(`INSERT INTO memberships(organization_id,user_id,active)
    SELECT $1,id,position%3<>0 FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(id,position)`, [reader.organizationId, people.map(person => person.id)]);
  const analyzeStarted = performance.now(); await owner.query('ANALYZE users,memberships');
  report.fixture = { organizationId: reader.organizationId, totalMembers: 10001, fixtureMembers: 10000, nameCharacters: 160, setupMs: performance.now() - started, analyzeMs: performance.now() - analyzeStarted };
  const first = await withSession(session.token, async (client, identity) => (await client.query('SELECT user_id AS id,display_name AS name FROM method_access_user_labels WHERE organization_id=$1 ORDER BY display_name,user_id LIMIT 100', [identity.organization_id])).rows, { readOnly: true });
  assert.deepEqual(first, people.slice(0, 100));
  for (const [name, search, expectedRows, hasMore, queries] of [
    ['empty', '', first, true, 1], ['common', 'common asa', people.slice(0, 100), true, 1],
    ['last-name', 'last elodie', people.slice(-1), false, 21], ['last-uuid', people.at(-1).id.toUpperCase(), people.slice(-1), false, 21],
    ['missing', 'no such user!', [], false, 21],
  ]) {
    const entry = { name, search, budgetMs: report.budgets[name], expectedQueries: queries, samples: [] }; report.cases.push(entry);
    for (let index = 0; index < 6; index++) {
      let count = 0; let sqlMs = 0; const started = performance.now();
      const result = await withSession(session.token, (client, identity) => masterCustomFieldUsers({ async query(...args) {
        count++; const at = performance.now(); const result = await client.query(...args); sqlMs += performance.now() - at; return result;
      } }, identity, { search }), { readOnly: true });
      const body = JSON.stringify(result); const sample = { totalMs: performance.now() - started, sqlMs, queries: count, bytes: Buffer.byteLength(body) };
      assert.deepEqual(result, { rows: expectedRows, hasMore }); assert.equal(count, queries);
      if (index) entry.samples.push(sample); else entry.warmup = sample;
    }
    entry.metrics = Object.fromEntries(['totalMs','sqlMs','queries','bytes'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
    entry.passed = entry.metrics.totalMs <= entry.budgetMs; console.log(JSON.stringify({ name, budgetMs: entry.budgetMs, ...entry.metrics, passed: entry.passed }));
  }
  for (const [file, hash] of Object.entries(report.sourceSha256)) assert.equal(sha(await readFile(file)), hash, file);
  report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('Master user-choice budgets failed. Preserve the report and diagnose.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/master-user-options-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
