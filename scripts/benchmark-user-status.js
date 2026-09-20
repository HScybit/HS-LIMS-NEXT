import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { updateUserStatus, loadUserStatus, loadUserStatusHistory } from '../src/users/status.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Run alone on isolated local PostgreSQL. One warmup and five measured samples. Total includes authentication, transaction setup, service SQL, driver parsing, assembly, deferred constraints, commit/rollback and serialization. SQL timing/query count covers service queries only; authentication and transaction control remain in total. Fixtures and HTTP/browser are excluded. The 1000-session stress case represents synthetic observed/import rows, not a native session limit. Deactivation samples have distinct targets and fresh unrevoked session rows. No source improvement or arbitrary maximum scale claim.', cases: [] };
const percentile = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const command = (revision, membershipActive) => ({ requestId: randomUUID(), revision, membershipActive });
const account = async (options) => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const save = (actor, target, input) => withSession(actor.token, (client, identity) => updateUserStatus(client, identity, target, input));
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
  const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['roles.manage'] });
  const extra = Array.from({ length: 9_998 }, () => randomUUID());
  await owner.query("INSERT INTO users(id,username,email,display_name) SELECT id,'status-bench-'||id,id||'@example.invalid','Synthetic status member' FROM unnest($1::uuid[]) id", [extra]);
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [admin.organizationId, extra]);
  await owner.query('ANALYZE memberships'); await owner.query('ANALYZE users');
  await measure(admin, (client, identity) => loadUserStatus(client, identity, person.userId), (result) => {
    assert.equal(result.revision, 0); assert.equal(result.membershipActive, true);
  }, { label: 'Read exact status among 10000 organization members', budgetMs: 75 });
  await measure(admin, (client, identity) => updateUserStatus(client, identity, person.userId, command(0, false)),
    (result) => assert.equal(result.code, 'last_user_administrator'),
    { label: 'Reject disabling last role administrator among 10000 members', budgetMs: 300, readOnly: false, errorCode: 'last_user_administrator' });
  let target; let off;
  for (const sessions of [1, 1000]) {
    await measure(admin, (client, identity, member) => updateUserStatus(client, identity, member.userId, member.input),
      (result) => { assert.equal(result.revision, 1); assert.equal(result.membershipActive, false); },
      { label: `Disable membership with ${sessions} unrevoked session rows`, budgetMs: sessions === 1 ? 150 : 300, readOnly: false, prepare: async () => {
        target = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] }); off = command(0, false);
        await owner.query(`INSERT INTO sessions(organization_id,user_id,token_hash,csrf_hash,credential_revision,expires_at)
          SELECT $1,$2,repeat(md5(gen_random_uuid()::text),2),repeat(md5(gen_random_uuid()::text),2),1,now()+interval '1 hour' FROM generate_series(1,$3)`,
        [admin.organizationId, target.userId, sessions]);
        return { ...target, input: off };
      } });
  }
  const selected = target.userId; const exact = off;
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM sessions WHERE user_id=$1 AND revoked_at IS NOT NULL', [selected])).rows[0].count, 1000);
  await save(admin, selected, command(1, true));
  await measure(admin, (client, identity) => updateUserStatus(client, identity, selected, exact), (result) => {
    assert.equal(result.revision, 1); assert.equal(result.membershipActive, false);
  }, { label: 'Exact deactivation retry after later reactivation', budgetMs: 100, readOnly: false });
  let revision = 2;
  while (revision < 100) revision = (await save(admin, selected, command(revision, revision % 2 === 1))).revision;
  await measure(admin, (client, identity) => loadUserStatusHistory(client, identity, selected), (result) => {
    assert.equal(result.rows.length, 25); assert.equal(result.rows[0].revision, 100); assert.equal(result.nextBeforeRevision, 76);
  }, { label: 'First 25 of 100 immutable status revisions', budgetMs: 100, queries: 2 });
  assert(report.cases.every((entry) => entry.passed), 'At least one unchanged declared status budget failed.'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-status-performance.json', `${JSON.stringify(report, null, 2)}\n`); await closePool(); await owner.end(); }
