import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { updateUserProfile, loadUserProfile, listUserProfileHistory, listUserProfileReferences } from '../src/users/profiles.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Run alone on isolated local PostgreSQL. One warmup and five measured samples. Total time includes authentication, transaction setup, service queries, driver parsing, assembly, deferred constraints, COMMIT and response serialization. SQL service timing/query count excludes authentication and transaction-control SQL; these remain included in total. Fixture construction, HTTP/browser and network outside localhost are excluded. Role sets have1/100/500 actual assignments; all are returned and copied into each immutable revision. Explicit new role input remains capped at100; these larger existing sets are preserved. No maximum legacy-role-count claim.', cases: [] };
const percentile = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
async function measure(actor, action, validate, { label, budgetMs, queries = 1, readOnly = true }) {
  const entry = { label, budgetMs, serviceQueryBudget: queries, samples: [] }; report.cases.push(entry);
  for (let sampleIndex = 0; sampleIndex < 6; sampleIndex++) {
    let serviceQueries = 0; let serviceSqlMs = 0; const start = performance.now();
    const result = await withSession(actor.token, (client, identity) => action({ async query(...args) {
      serviceQueries++; const at = performance.now(); const value = await client.query(...args); serviceSqlMs += performance.now() - at; return value;
    } }, identity), { readOnly });
    const committedAt = performance.now(); const response = JSON.stringify(result); const end = performance.now(); validate(result);
    assert.equal(serviceQueries, queries);
    const sample = { totalMs: end - start, serviceSqlMs, transactionAndAssemblyMs: committedAt - start - serviceSqlMs,
      serializationMs: end - committedAt, bytes: Buffer.byteLength(response), serviceQueries };
    if (sampleIndex) entry.samples.push(sample); else entry.warmup = sample;
  }
  entry.metrics = Object.fromEntries(['totalMs', 'serviceSqlMs', 'transactionAndAssemblyMs', 'serializationMs', 'bytes', 'serviceQueries'].map((key) => [key, percentile(entry.samples.map((sample) => sample[key]))]));
  entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ label, ...entry.metrics, passed: entry.passed }));
}

try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const [roleCount, readBudget, saveBudget] of [[1, 75, 100], [100, 150, 300], [500, 250, 1000]]) {
    const admin = await createAccount(owner, { permissions: ['users.manage', 'roles.manage'] }); Object.assign(admin, await signIn({ identifier: admin.username, password: admin.password }));
    const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: [] }); const lab = randomUUID();
    await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Benchmark laboratory')", [admin.organizationId, lab]);
    if (roleCount > 1) {
      const roles = (await owner.query("INSERT INTO roles(organization_id,id,name) SELECT $1,gen_random_uuid(),'Observed role '||n FROM generate_series(1,$2) n RETURNING id", [admin.organizationId, roleCount - 1])).rows.map((row) => row.id);
      await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) SELECT $1,$2,unnest($3::uuid[])', [admin.organizationId, person.userId, roles]);
    }
    let revision = (await withSession(admin.token, (client, identity) => updateUserProfile(client, identity, person.userId, { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab }))).revision;
    await measure(admin, (client, identity) => loadUserProfile(client, identity, person.userId), (profile) => { assert.equal(profile.roles.length, roleCount); assert.equal(profile.revision, revision); },
      { label: `Read profile with ${roleCount} roles`, budgetMs: readBudget });
    await measure(admin, async (client, identity) => {
      const result = await updateUserProfile(client, identity, person.userId, { requestId: randomUUID(), revision, phone: `Revision ${revision + 1}` }); revision = result.revision; return result;
    }, (saved) => assert.equal(saved.revision, revision), { label: `Save profile preserving ${roleCount} roles`, budgetMs: saveBudget, readOnly: false });
    assert.equal((await withSession(admin.token, (client, identity) => loadUserProfile(client, identity, person.userId), { readOnly: true })).roles.length, roleCount);
    if (roleCount === 1) {
      while (revision < 100) revision = (await withSession(admin.token, (client, identity) => updateUserProfile(client, identity, person.userId, { requestId: randomUUID(), revision, phone: `History ${revision + 1}` }))).revision;
      await measure(admin, (client, identity) => listUserProfileHistory(client, identity, person.userId, { pageSize: 25 }), (history) => {
        assert.equal(history.rows.length, 25); assert.equal(history.rows[0].revision, 100); assert.equal(history.hasMore, true);
      }, { label: 'First25 of100 immutable profile revisions', budgetMs: 100, queries: 2 });
    }
    if (roleCount === 500) {
      await owner.query("INSERT INTO business_units(organization_id,id,code,name) SELECT $1,gen_random_uuid(),'UNIT-'||n,'Unit '||lpad(n::text,6,'0') FROM generate_series(1,10000) n", [admin.organizationId]);
      await measure(admin, (client, identity) => listUserProfileReferences(client, identity, { kind: 'businessUnits', pageSize: 100 }), (result) => {
        assert.equal(result.rows.length, 100); assert.equal(result.hasMore, true); assert.equal(result.rows[0].name, 'Unit 000001');
      }, { label: 'First100 of10000 business-unit choices', budgetMs: 300 });
    }
  }
  assert(report.cases.every((entry) => entry.passed), 'At least one unchanged declared profile budget failed.'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-profile-performance.json', `${JSON.stringify(report, null, 2)}\n`); await closePool(); await owner.end(); }
