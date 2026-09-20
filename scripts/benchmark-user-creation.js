import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { createUser } from '../src/users/create.js';
import { updateUserProfile } from '../src/users/profiles.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true,
  conditions: 'Run alone on the isolated local PostgreSQL database. One warmup and five measured samples per case. Total includes authentication, input normalization, keyed fingerprinting, real scrypt hashing, service SQL, driver parsing, history constraints, COMMIT/ROLLBACK and serialization. Service SQL counts exclude authentication/transaction-control queries, which are included in total time. Fixture construction and HTTP/browser rendering are excluded. Complex roles each have2000-character descriptions. Global lookup fixture adds10000 synthetic identities in a separate organization. No password, credential hash or fingerprint is written to this report.', cases: [] };
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
async function measure(label, budgetMs, queryBudget, action, validate) {
  const entry = { label, budgetMs, serviceQueryBudget: queryBudget, samples: [] }; report.cases.push(entry);
  for (let index = 0; index < 6; index++) {
    let serviceQueries = 0; let serviceSqlMs = 0;
    const call = (actor, input) => withSession(actor.token, (client, identity) => createUser({ async query(...args) {
      serviceQueries++; const at = performance.now();
      try { return await client.query(...args); } finally { serviceSqlMs += performance.now() - at; }
    } }, identity, input));
    const start = performance.now(); const result = await action(call); const committedAt = performance.now();
    const response = JSON.stringify(result); const end = performance.now(); validate(result); assert.equal(serviceQueries, queryBudget);
    const sample = { totalMs: end - start, aggregateServiceSqlMs: serviceSqlMs,
      serializationMs: end - committedAt, bytes: Buffer.byteLength(response), serviceQueries };
    if (index) entry.samples.push(sample); else entry.warmup = sample;
  }
  entry.metrics = Object.fromEntries(['totalMs', 'aggregateServiceSqlMs', 'serializationMs', 'bytes', 'serviceQueries'].map((key) => [key, p95(entry.samples.map((sample) => sample[key]))]));
  entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ label, ...entry.metrics, passed: entry.passed }));
}
async function fixture() {
  const admin = await createAccount(owner, { permissions: ['users.manage', 'roles.manage'] }); Object.assign(admin, await signIn({ identifier: admin.username, password: admin.password }));
  const reader = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] }); const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Benchmark creation lab')", [admin.organizationId, lab]);
  const input = (extra = {}) => { const id = randomUUID(); return { id, requestId: randomUUID(), revision: 0, username: `bench-${id}`, email: `bench-${id}@example.invalid`,
    displayName: 'Synthetic creation benchmark', password: 'Synthetic creation benchmark password', defaultRoleId: reader.roleId, laboratoryId: lab, ...extra }; };
  return { admin, reader, lab, input };
}
const saved = (value) => { assert.equal(value.profileRevision, 1); assert.equal(Object.keys(value.user).length, 4); };
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  const f = await fixture(); const foreign = await fixture(); const prefix = `Global-${randomUUID()}`;
  const identities = (await owner.query("INSERT INTO users(id,username,email,display_name) SELECT gen_random_uuid(),$1||n,$1||n||'@example.invalid','Global alias fixture' FROM generate_series(1,10000) n RETURNING id", [prefix])).rows.map((row) => row.id);
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [foreign.admin.organizationId, identities]);
  const roles = (await owner.query("INSERT INTO roles(organization_id,id,name,description) SELECT $1,gen_random_uuid(),'Complex role '||n,repeat('D',2000) FROM generate_series(1,100) n RETURNING id", [f.admin.organizationId])).rows.map((row) => row.id);
  for (const [roleCount, roleIds, budget] of [[1, [f.reader.roleId], 350], [100, [f.reader.roleId, ...roles.slice(0, 99)], 600], [101, roles, 650]]) {
    const created = [];
    await measure(`Create with ${roleCount} roles among10000 global aliases`, budget, 1, (call) => {
      const input = f.input({ roleIds }); created.push(input.id); return call(f.admin, input);
    }, saved);
    const versions = (await owner.query('SELECT role_count FROM user_profile_versions WHERE organization_id=$1 AND user_id=ANY($2::uuid[])', [f.admin.organizationId, created])).rows;
    assert.equal(versions.length, 6); assert(versions.every((version) => version.role_count === roleCount));
  }
  const retry = f.input(); const original = await withSession(f.admin.token, (client, identity) => createUser(client, identity, retry));
  await withSession(f.admin.token, (client, identity) => updateUserProfile(client, identity, retry.id, { requestId: randomUUID(), revision: 1, designation: 'Changed after creation' }));
  await measure('Exact creation retry after a later profile edit', 350, 1, (call) => call(f.admin, retry), (value) => assert.deepEqual(value, original));
  const rejectedIds = [];
  await measure('Invalid laboratory rolls back a provisional account', 350, 1, async (call) => {
    const input = f.input({ laboratoryId: randomUUID() }); rejectedIds.push(input.id);
    try { await call(f.admin, input); assert.fail('Invalid laboratory must fail'); } catch (error) { assert.equal(error.code, 'invalid_laboratory'); return { code: error.code }; }
  }, (value) => assert.equal(value.code, 'invalid_laboratory'));
  assert.equal((await owner.query('SELECT id FROM users WHERE id=ANY($1::uuid[])', [rejectedIds])).rowCount, 0);
  await measure('Two concurrent exact requests create one account', 700, 2, async (call) => {
    const input = f.input(); return Promise.all([call(f.admin, input), call(f.admin, input)]);
  }, (values) => { saved(values[0]); assert.deepEqual(values[0], values[1]); });
  await measure('Concurrent cross-organization alias collision', 700, 2, async (call) => {
    const alias = `cross-${randomUUID()}@example.invalid`;
    const results = await Promise.allSettled([call(f.admin, f.input({ username: alias })), call(foreign.admin, foreign.input({ email: alias }))]);
    assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
    const winner = results.find((value) => value.status === 'fulfilled').value; const conflict = results.find((value) => value.status === 'rejected').reason;
    assert.equal(conflict.code, 'sign_in_identifier_taken'); return { winner, conflict: conflict.code };
  }, (value) => { saved(value.winner); assert.equal(value.conflict, 'sign_in_identifier_taken'); });
  assert(report.cases.every((entry) => entry.passed), 'At least one declared account creation budget failed.'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-creation-performance.json', `${JSON.stringify(report, null, 2)}\n`); await closePool(); await owner.end(); }
