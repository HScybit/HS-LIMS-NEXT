import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { listUsers, loadUser } from '../src/users/directory.js';
import { loadUserForm } from '../src/users/forms.js';
import { updateUserProfile } from '../src/users/profiles.js';

const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Run alone on dedicated local PostgreSQL. Explicit ANALYZE of the eight populated fixture tables after setup and before one warmup and five measured reads. This measures reads with prepared statistics, not first reads after an unanalyzed bulk load. Total includes actual authentication, repeatable-read transaction, service queries, driver parsing, assembly, commit and JSON serialization; fixtures/statistics preparation, HTTP and browser work are excluded. Small fixtures have one role per user. Complex fixture: 10,000 users with 20 assigned roles each (200-character descriptions), 1,000 profiles recorded by the native command, 100 synthetic login/logout events per profiled user; remaining profiles/activity absent. Service query counts exclude authentication queries, whose time is included in total.', fixtures: [], cases: [] };
const fixtureTables = ['users', 'memberships', 'membership_roles', 'roles', 'account_events', 'user_profiles', 'user_profile_versions', 'user_profile_version_roles'];
const statistics = async () => (await owner.query(`SELECT relname,n_live_tup,n_mod_since_analyze,last_analyze,last_autoanalyze
  FROM pg_stat_user_tables WHERE schemaname='public' AND relname=ANY($1::text[]) ORDER BY relname`, [fixtureTables])).rows;
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
async function measure(actor, label, budgetMs, queryBudget, action, validate) {
  const entry = { label, budgetMs, queryBudget, samples: [] }; report.cases.push(entry);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; const at = performance.now();
    const result = await withSession(actor.token, (client, identity) => action({ async query(...args) { queries++; const began = performance.now(); const result = await client.query(...args); sqlMs += performance.now() - began; return result; } }, identity), { readOnly: true });
    const loadedAt = performance.now(); const body = JSON.stringify(result); const finishedAt = performance.now();
    validate(result); assert.equal(queries, queryBudget);
    const sample = { totalMs: finishedAt - at, sqlMs, serializationMs: finishedAt - loadedAt, queries, bytes: Buffer.byteLength(body) };
    if (index) entry.samples.push(sample); else entry.warmup = sample;
  }
  entry.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'serializationMs', 'queries', 'bytes'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
  entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ label, p95Ms: entry.metrics.totalMs, budgetMs, passed: entry.passed }));
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const [size, roleCount, budget] of [[100, 1, 150], [1000, 1, 300], [10000, 20, 600]]) {
    const actor = await createAccount(owner, { permissions: ['users.manage'] }); Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
    const prefix = `screenbench-${randomUUID()}-`; const org = actor.organizationId; const setupAt = performance.now();
    const people = (await owner.query(`INSERT INTO users(id,username,email,display_name,created_at)
      SELECT gen_random_uuid(),$1||lpad(n::text,5,'0'),$1||n||'@example.invalid',$1||lpad(n::text,5,'0'),'2024-02-29T12:00:00Z'::timestamptz
      FROM generate_series(1,$2::integer) n RETURNING id,username`, [prefix, size])).rows.sort((a, b) => a.username.localeCompare(b.username));
    const ids = people.map(person => person.id);
    await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [org, ids]);
    const roles = (await owner.query(`INSERT INTO roles(organization_id,id,name,description)
      SELECT $1,gen_random_uuid(),'Saved screen role '||n,repeat('d',200) FROM generate_series(1,$2::integer) n RETURNING id`, [org, roleCount])).rows.map(row => row.id);
    await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) SELECT $1,person,role FROM unnest($2::uuid[]) person CROSS JOIN unnest($3::uuid[]) role', [org, ids, roles]);
    let lab; let unit;
    if (size === 10000) {
      lab = randomUUID(); unit = randomUUID();
      await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Benchmark laboratory')", [org, lab]);
      await owner.query("INSERT INTO business_units(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Saved screen unit')", [org, unit]);
      for (let offset = 0; offset < 1000; offset += 100) await withSession(actor.token, async (client, identity) => {
        for (const id of ids.slice(offset, offset + 100)) await updateUserProfile(client, identity, id,
          { requestId: randomUUID(), revision: 0, defaultRoleId: roles[0], laboratoryId: lab, businessUnitId: unit });
      });
      await owner.query(`INSERT INTO account_events(organization_id,user_id,kind,occurred_at) SELECT $1,person,
        CASE WHEN n%2=0 THEN 'sign_in' ELSE 'sign_out' END,'2025-01-01T00:00:00Z'::timestamptz+n*interval '1 second'
        FROM unnest($2::uuid[]) person CROSS JOIN generate_series(1,100) n`, [org, ids.slice(0, 1000)]);
    }
    const beforeStatistics = await statistics(); const analyzeAt = performance.now();
    await owner.query(`ANALYZE ${fixtureTables.map(table => `public.${table}`).join(',')}`);
    const analyzeMs = performance.now() - analyzeAt; const afterStatistics = await statistics();
    const setupMs = performance.now() - setupAt;
    report.fixtures.push({ size, organizationId: org, prefix, roleCount, setupMs, analyzeMs, beforeStatistics, afterStatistics });
    console.log(JSON.stringify({ fixture: size, setupMs, analyzeMs, roleCount, recordedProfiles: size === 10000 ? 1000 : 0 }));
    const query = { search: prefix, pageSize: 100 };
    const validateList = result => { assert.equal(result.totalCount, size); assert.equal(result.rows.length, 100); assert(result.rows.every(person => person.roles.length === roleCount)); };
    await measure(actor, `First 100 among ${size} users`, budget, 3, (client, identity) => listUsers(client, identity, query), validateList);
    if (size === 10000) {
      await measure(actor, 'Saved label and calendar filters among 10000 users', 600, 3, (client, identity) => listUsers(client, identity, { ...query, timeZone: 'Asia/Kolkata', filters: {
        defaultRoleName: { type: 'text', value: 'Saved screen role' }, businessUnitName: { type: 'text', value: 'Saved screen unit' }, identityCreatedAt: { type: 'date', from: '2024-02-29', to: '2024-02-29' } } }),
      result => { assert.equal(result.totalCount, 1000); assert.equal(result.rows.length, 100); });
      await measure(actor, 'Actual last-login sort among 10000 users', 1000, 3, (client, identity) => listUsers(client, identity, { ...query, sort: { key: 'lastLoginAt', dir: 'desc' } }),
        result => { validateList(result); assert(result.rows.every(person => person.lastLoginAt)); });
      await measure(actor, 'Saved unit sort among 10000 users', 1000, 3, (client, identity) => listUsers(client, identity, { ...query, sort: { key: 'businessUnitName', dir: 'desc' } }),
        result => { validateList(result); assert(result.rows.every(person => person.businessUnitId === unit)); });
      await measure(actor, 'Exact profiled user among 10000 users', 100, 1, (client, identity) => loadUser(client, identity, ids[0]),
        result => { assert.equal(result.id, ids[0]); assert.equal(result.roles.length, 20); assert.equal(result.businessUnitId, unit); });
      await measure(actor, 'Complete form metadata among 10000 users', 150, 5, (client, identity) => loadUserForm(client, identity, ids[0]),
        result => { assert.equal(result.user.id, ids[0]); assert.equal(result.profile.roles.length, 20); assert.equal(result.signature.file, null); });
    }
  }
  report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed';
  if (report.status === 'failed') throw new Error('User screen performance budgets failed. Preserve this report and diagnose.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-screen-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
