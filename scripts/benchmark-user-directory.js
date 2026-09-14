import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { listUsers, loadUser } from '../src/users/directory.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Run alone on the dedicated local synthetic PostgreSQL. One warmup and five measured reads per case. Timings include service queries, driver parsing, row assembly and JSON serialization. Fixture setup, authentication/transaction setup, HTTP and browser rendering are excluded. Listings return at most100 identities; every configured role is returned. Complex fixture has20 roles and100 actual synthetic sign-in/out events per identity. Separate detail has500 roles. No maximum arbitrary-role-count claim.', cases: [] };
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
async function measure(actor, action, validate, budgetMs, queryBudget, label) {
  const entry = { label, budgetMs, queryBudget, samples: [] }; report.cases.push(entry);
  for (let i = 0; i < 6; i++) await withSession(actor.token, async (client, identity) => {
    let queries = 0; let sqlMs = 0; const measured = { async query(...args) { queries++; const at = performance.now(); const result = await client.query(...args); sqlMs += performance.now() - at; return result; } };
    const start = performance.now(); const result = await action(measured, identity); const loadedAt = performance.now(); const json = JSON.stringify(result); const finishedAt = performance.now();
    validate(result); assert.equal(queries, queryBudget);
    const sample = { totalMs: finishedAt - start, sqlMs, assemblyMs: loadedAt - start - sqlMs, serializationMs: finishedAt - loadedAt, bytes: Buffer.byteLength(json), queries };
    if (i) entry.samples.push(sample); else entry.warmup = sample;
  }, { readOnly: true });
  entry.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'assemblyMs', 'serializationMs', 'bytes', 'queries'].map((key) => [key, p95(entry.samples.map((sample) => sample[key]))]));
  console.log(JSON.stringify({ label, ...entry.metrics })); assert(entry.metrics.totalMs <= budgetMs, `${label}: ${entry.metrics.totalMs}ms exceeds ${budgetMs}ms`);
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const [size, roleCount, events, budgetMs] of [[10, 1, 0, 50], [10_000, 1, 2, 250], [1000, 20, 100, 500]]) {
    const actor = await createAccount(owner, { permissions: ['users.read'] }); Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
    const prefix = `Directory-${randomUUID()}`; const setupAt = performance.now();
    const people = (await owner.query(`INSERT INTO users(id,username,email,display_name)
      SELECT gen_random_uuid(),$1||'-'||n,$1||'-'||n||'@example.invalid',$1||'-'||lpad(n::text,6,'0') FROM generate_series(1,$2) n RETURNING id`, [prefix, size])).rows.map((row) => row.id);
    await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [actor.organizationId, people]);
    const roles = (await owner.query(`INSERT INTO roles(organization_id,id,name) SELECT $1,gen_random_uuid(),$2||'-Role-'||n FROM generate_series(1,$3) n RETURNING id`, [actor.organizationId, prefix, roleCount])).rows.map((row) => row.id);
    await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) SELECT $1,person,role FROM unnest($2::uuid[]) person CROSS JOIN unnest($3::uuid[]) role', [actor.organizationId, people, roles]);
    if (events) await owner.query(`INSERT INTO account_events(user_id,organization_id,kind,occurred_at)
      SELECT person,$1,CASE WHEN n%2=0 THEN 'sign_in' ELSE 'sign_out' END,timestamptz '2025-01-01 00:00:00+00'+n*interval '1 second'
      FROM unnest($2::uuid[]) person CROSS JOIN generate_series(0,$3-1) n`, [actor.organizationId, people, events]);
    console.log(JSON.stringify({ size, roleCount, events, setupMs: performance.now() - setupAt }));
    await measure(actor, (client, identity) => listUsers(client, identity, { search: prefix, pageSize: 100 }), (result) => {
      assert.equal(result.totalCount, size); assert.equal(result.rows.length, Math.min(100, size));
      assert(result.rows.every((row) => row.roles.length === roleCount && (events ? row.lastLoginAt && row.lastLogoutAt : row.lastLoginAt === null && row.lastLogoutAt === null)));
    }, budgetMs, 2, `${size} users, ${roleCount} roles, ${events} events each`);
    if (roleCount === 20) {
      const manyRoles = (await owner.query(`INSERT INTO roles(organization_id,id,name) SELECT $1,gen_random_uuid(),$2||'-Detailed-'||n FROM generate_series(1,500) n RETURNING id`, [actor.organizationId, prefix])).rows.map((row) => row.id);
      await owner.query('DELETE FROM membership_roles WHERE organization_id=$1 AND user_id=$2', [actor.organizationId, people[0]]);
      await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) SELECT $1,$2,unnest($3::uuid[])', [actor.organizationId, people[0], manyRoles]);
      await measure(actor, (client, identity) => loadUser(client, identity, people[0]), (person) => { assert.equal(person.roles.length, 500); assert.equal(person.id, people[0]); }, 150, 1, 'Exact user with500 roles');
    }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-directory-performance.json', `${JSON.stringify(report, null, 2)}\n`); await closePool(); await owner.end(); }
