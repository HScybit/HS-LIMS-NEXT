import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { updateUserAccount } from '../src/users/accounts.js';
import { updateUserProfile } from '../src/users/profiles.js';
import { updateUserForm, loadUserForm } from '../src/users/forms.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version,
  conditions: 'Run alone on isolated local PostgreSQL. One warmup and five measured samples. Includes actual authentication, validation, HMAC/scrypt, service SQL and driver parsing, deferred integrity checks for the complete form, commit/rollback and JSON serialization. Fixtures, current-revision reads, HTTP and browser transfer are excluded. First-profile samples have distinct targets; existing edits change identity text and contact each time. Synthetic target measurements are not a source-performance or unrestricted-scale claim.', cases: [] };
const percentile = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const command = (person, revision, profileRevision, extra = {}) => ({ requestId: randomUUID(), revision, profileRevision, username: person.username, email: person.email, displayName: `Form identity ${revision}`, ...extra });
const account = async (options) => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const save = (actor, target, input) => withSession(actor.token, (client, identity) => updateUserForm(client, identity, target, input));
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
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Form benchmark laboratory')", [admin.organizationId, lab]);
  let person = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] });
  const initial = person => command(person, 1, 0, { defaultRoleId: person.roleId, laboratoryId: lab, phone: 'Original contact' });
  await save(admin, person.userId, initial(person));
  await measure(admin, (client, identity) => loadUserForm(client, identity, person.userId), result => {
    assert.equal(result.account.revision, 2); assert.equal(result.profile.revision, 1); assert.equal(result.signature.file, null);
  }, { label: 'Read complete user-form metadata', budgetMs: 100, queries: 5 });
  await measure(admin, (client, identity, fixture) => updateUserForm(client, identity, fixture.person.userId, fixture.input), result => {
    assert.equal(result.revision, 2); assert.equal(result.profileRevision, 1);
  }, { label: 'Save identity and first laboratory profile', budgetMs: 200, queries: 3, readOnly: false, prepare: async () => {
    const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] }); return { person, input: initial(person) };
  } });
  let revision = 2; let profileRevision = 1;
  await measure(admin, (client, identity, input) => updateUserForm(client, identity, person.userId, input), (result, input) => {
    assert.equal(result.revision, input.revision + 1); assert.equal(result.profileRevision, input.profileRevision + 1); revision = result.revision; profileRevision = result.profileRevision;
  }, { label: 'Change identity and sparse laboratory profile together', budgetMs: 150, queries: 3, readOnly: false,
    prepare: () => command(person, revision, profileRevision, { phone: `Contact ${profileRevision}` }) });
  await measure(admin, (client, identity, input) => updateUserForm(client, identity, person.userId, input), (result, input) => {
    assert.equal(result.revision, input.revision + 1); assert.equal(result.profileRevision, input.profileRevision + 1); assert.equal(result.passwordChanged, true); revision = result.revision; profileRevision = result.profileRevision;
  }, { label: 'Save identity, profile and a supplied password', budgetMs: 350, queries: 3, readOnly: false,
    prepare: () => command(person, revision, profileRevision, { phone: `Password contact ${profileRevision}`, password: 'Actual benchmark password' }) });
  const before = await withSession(admin.token, (client, identity) => loadUserForm(client, identity, person.userId), { readOnly: true });
  await measure(admin, (client, identity) => updateUserForm(client, identity, person.userId, command(person, revision, profileRevision, { email: admin.email, phone: 'Must roll back' })),
    result => assert.equal(result.code, 'sign_in_identifier_taken'), { label: 'Roll back a profile after a late global alias collision', budgetMs: 200, queries: 3, readOnly: false, errorCode: 'sign_in_identifier_taken' });
  assert.deepEqual(await withSession(admin.token, (client, identity) => loadUserForm(client, identity, person.userId), { readOnly: true }), before);
  const exact = command(person, revision, profileRevision, { phone: 'Original exact contact', password: 'Exact original form password' });
  const original = await save(admin, person.userId, exact);
  await withSession(admin.token, (client, identity) => updateUserProfile(client, identity, person.userId, { requestId: randomUUID(), revision: original.profileRevision, phone: 'Later standalone contact' }));
  await withSession(admin.token, (client, identity) => updateUserAccount(client, identity, person.userId, { requestId: randomUUID(), revision: original.revision,
    username: person.username, email: person.email, displayName: 'Later standalone identity', password: 'Later standalone password' }));
  await measure(admin, (client, identity) => updateUserForm(client, identity, person.userId, exact), result => assert.deepEqual(result, original),
    { label: 'Exact combined password retry after later standalone changes', budgetMs: 350, queries: 3, readOnly: false });
  assert(report.cases.every(entry => entry.passed), 'At least one unchanged declared user-form budget failed.'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-form-performance.json', `${JSON.stringify(report, null, 2)}\n`); await closePool(); await owner.end(); }
