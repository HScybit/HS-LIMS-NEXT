import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { updateUserAccount, loadUserAccount, loadUserAccountHistory } from '../src/users/accounts.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Run alone on isolated local PostgreSQL. One warmup and five measured samples. Includes actual authentication, input validation, HMAC and scrypt, service SQL and driver parsing, deferred checks, transaction commit or rollback and JSON serialization. Authentication and transaction control are included in total but outside service query counts. Fixture creation and current revision preparation, HTTP and browser transfer are excluded. Each ordinary identity sample changes all three identity fields; password samples set a supplied password. Cases use synthetic target data and do not establish source speed or every production workload.', cases: [] };
const percentile = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const command = (person, revision, extra = {}) => ({ requestId: randomUUID(), revision, username: person.username, email: person.email, displayName: 'Updated benchmark identity', ...extra });
const account = async (options) => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const save = (actor, target, input) => withSession(actor.token, (client, identity) => updateUserAccount(client, identity, target, input));
async function measure(actor, action, validate, { label, budgetMs, queries = 1, readOnly = true, prepare = async () => {}, errorCode }) {
  const entry = { label, budgetMs, serviceQueryBudget: queries, samples: [] }; report.cases.push(entry);
  for (let index = 0; index < 6; index++) {
    const fixture = await prepare(); let serviceQueries = 0; let serviceSqlMs = 0; const start = performance.now(); let result;
    try {
      result = await withSession(actor.token, (client, identity) => action({ async query(...args) {
        serviceQueries++; const at = performance.now();
        try { return await client.query(...args); } finally { serviceSqlMs += performance.now() - at; }
      } }, identity, fixture), { readOnly });
      assert.equal(errorCode, undefined, 'Expected a rejected command');
    } catch (error) {
      if (!errorCode || error.code !== errorCode) throw error;
      result = { code: error.code };
    }
    const committedAt = performance.now(); const response = JSON.stringify(result); const end = performance.now(); validate(result, fixture); assert.equal(serviceQueries, queries);
    const sample = { totalMs: end - start, serviceSqlMs, transactionAndAssemblyMs: committedAt - start - serviceSqlMs,
      serializationMs: end - committedAt, bytes: Buffer.byteLength(response), serviceQueries };
    if (index) entry.samples.push(sample); else entry.warmup = sample;
  }
  entry.metrics = Object.fromEntries(['totalMs', 'serviceSqlMs', 'transactionAndAssemblyMs', 'serializationMs', 'bytes', 'serviceQueries'].map((key) => [key, percentile(entry.samples.map((sample) => sample[key]))]));
  entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ label, ...entry.metrics, passed: entry.passed }));
}

try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  const admin = await account({ permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] });
  const extra = Array.from({ length: 9_998 }, () => randomUUID());
  await owner.query("INSERT INTO users(id,username,email,display_name) SELECT id,'account-bench-'||id,id||'@example.invalid','Synthetic account member' FROM unnest($1::uuid[]) id", [extra]);
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [admin.organizationId, extra]);
  await owner.query('ANALYZE memberships'); await owner.query('ANALYZE users');
  await measure(admin, (client, identity) => loadUserAccount(client, identity, person.userId), result => {
    assert.equal(result.revision, 1); assert.equal(result.canEditIdentity, true);
  }, { label: 'Read exact account among 10000 organization members', budgetMs: 75 });
  let revision = 1;
  for (const password of [undefined, 'Supplied benchmark password']) {
    await measure(admin, (client, identity, input) => updateUserAccount(client, identity, person.userId, input), (result, input) => {
      assert.equal(result.revision, input.revision + 1); assert.equal(result.passwordChanged, password !== undefined); revision = result.revision;
    }, { label: password ? 'Change supplied account password' : 'Change ordinary identity fields', budgetMs: password ? 300 : 150, readOnly: false,
      prepare: () => command(person, revision, password ? { password } : { username: `edited-${person.userId}-${revision}`, email: `edited-${person.userId}-${revision}@example.invalid`, displayName: `Edited identity ${revision}` }) });
  }
  const exact = command(person, revision, { password: 'Original retry password' }); const original = await save(admin, person.userId, exact);
  revision = original.revision;
  revision = (await save(admin, person.userId, command(person, revision, { password: 'Later benchmark password' }))).revision;
  await measure(admin, (client, identity) => updateUserAccount(client, identity, person.userId, exact), result => assert.deepEqual(result, original),
    { label: 'Exact password command retry after a later password change', budgetMs: 300, readOnly: false });
  const other = await createAccount(owner);
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [other.organizationId, person.userId]);
  await measure(admin, (client, identity) => updateUserAccount(client, identity, person.userId, command(person, revision, { displayName: 'Protected shared change' })),
    result => assert.equal(result.code, 'protected_user_identity'), { label: 'Reject ordinary manager shared identity edit', budgetMs: 150, readOnly: false, errorCode: 'protected_user_identity' });
  await owner.query('INSERT INTO platform_administrators(organization_id,user_id,granted_at,granted_by) VALUES($1,$2,clock_timestamp(),$3)', [admin.organizationId, admin.userId, 'Synthetic benchmark operator']);
  await measure(admin, (client, identity, input) => updateUserAccount(client, identity, person.userId, input), (result, input) => {
    assert.equal(result.revision, input.revision + 1); assert.equal(result.passwordChanged, true); revision = result.revision;
  }, { label: 'Platform-authorized shared identity password change', budgetMs: 300, readOnly: false,
    prepare: () => command(person, revision, { password: 'Shared benchmark password' }) });
  const historical = await createAccount(owner, { organizationId: admin.organizationId });
  for (let version = 1; version <= 100; version++) await save(admin, historical.userId, command(historical, version));
  await measure(admin, (client, identity) => loadUserAccountHistory(client, identity, historical.userId), result => {
    assert.equal(result.rows.length, 25); assert.equal(result.rows[0].revision, 101); assert.equal(result.nextBeforeRevision, 77);
  }, { label: 'First 25 of 100 actual administrative account records', budgetMs: 100, queries: 2 });
  assert(report.cases.every(entry => entry.passed), 'At least one unchanged declared account budget failed.'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-account-performance.json', `${JSON.stringify(report, null, 2)}\n`); await closePool(); await owner.end(); }
