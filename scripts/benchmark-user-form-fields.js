import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { updateUserForm, loadUserForm } from '../src/users/forms.js';
import { saveUserCustomFields } from '../src/users/custom-fields.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, fixtures: [], cases: [],
  conditions: 'Run alone on isolated local PostgreSQL. One warmup/five measured samples. Text primitives are80 characters. Fixtures prime a complete profile/capture then explicitly ANALYZE populated tables. Edits change identity and contact each time. Omission fixtures have20 other users with three actual capture revisions each. Actual auth, normalization, keyed fingerprints, supplied-password scrypt, transaction, SQL/driver, deferred checks, assembly, commit and response JSON serialization included. Setup, current-state verification reads, socket and browser transfer excluded. Service query counts exclude auth/control queries whose time is included. No passwords, credential hashes or fingerprints are recorded.' };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options) { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; }
async function analyze(fixture) {
  const at = performance.now(); await owner.query('ANALYZE users,memberships,credentials,user_profiles,user_profile_versions,user_account_commands,custom_field_definitions,custom_field_versions,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');
  fixture.analyzeMs = performance.now() - at;
}
async function fixture(fieldCount, itemsPerField, unique = false) {
  const setupAt = performance.now(); const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Complete form benchmark')", [author.organizationId, lab]);
  const ids = Array.from({ length: fieldCount }, () => randomUUID());
  const record = { fieldCount, itemsPerField, unique, organizationId: author.organizationId, setupStage: 'definitions', completedHistoryCaptures: 0 }; report.fixtures.push(record);
  if (fieldCount) await work(author, (client, identity) => client.query(`INSERT INTO custom_field_definitions
    (organization_id,id,key,label,associated_with,field_type,allows_multiple,validate_uniqueness,save_request_id,display_order)
    SELECT $1,id,'field_'||position,'Field '||position,'users','text',$3,$4,gen_random_uuid(),position
    FROM unnest($2::uuid[]) WITH ORDINALITY AS fixture(id,position)`, [identity.organization_id, ids, itemsPerField > 1, unique]));
  const value = itemsPerField > 1 ? Array.from({ length: itemsPerField }, (_, index) => String(index).padStart(80, 'v')) : 'subject'.padEnd(80, 'v');
  const fields = ids.map(fieldId => ({ fieldId, fieldRevision: 1, value }));
  let state = { revision: 1, profileRevision: 0, customFieldRevision: 0 }; let lastInput;
  const input = (supplied = true, password) => ({ requestId: randomUUID(), revision: state.revision, profileRevision: state.profileRevision,
    username: person.username, email: person.email, displayName: `Form fields identity ${state.revision}`, phone: `Contact ${state.profileRevision}`,
    ...(state.profileRevision === 0 ? { defaultRoleId: person.roleId, laboratoryId: lab } : {}),
    ...(supplied ? { customFieldRevision: state.customFieldRevision, customFields: fields } : {}), ...(password ? { password } : {}) });
  const accept = (result, command) => { state = { ...state, ...result }; lastInput = command; };
  record.setupStage = 'initial form'; const initial = input(); accept(await work(manager, (client, identity) => updateUserForm(client, identity, person.userId, initial)), initial);
  if (unique) {
    record.setupStage = 'history accounts'; const others = [];
    for (let index = 0; index < 20; index++) others.push(await createAccount(owner, { organizationId: author.organizationId, permissions: [] }));
    record.setupStage = 'capture history';
    for (let revision = 0; revision < 3; revision++) for (let index = 0; index < others.length; index++) {
      await work(manager, (client, identity) => saveUserCustomFields(client, identity, others[index].userId, { requestId: randomUUID(), revision,
        customFields: ids.map(fieldId => ({ fieldId, fieldRevision: 1, value: `other-${index}-revision-${revision + 1}`.padEnd(80, 'v') })) }));
      record.completedHistoryCaptures++;
    }
    record.existingUsers = others.length; record.existingCaptureRevisions = 3;
  }
  record.setupStage = 'complete'; record.setupMs = performance.now() - setupAt; await analyze(record); console.log(JSON.stringify({ prepared: record }));
  return { manager, person, fields, input, accept, record, state: () => state, lastInput: () => lastInput };
}
async function measure(f, name, budgetMs, queryBudget, readOnly, prepare, action, verify) {
  const entry = { fixture: f.record, name, budgetMs, queryBudget, samples: [] }; report.cases.push(entry);
  for (let index = 0; index < 6; index++) {
    const input = await prepare(); let queries = 0; let sqlMs = 0; const start = performance.now();
    const result = await work(f.manager, (client, identity) => action({ async query(...args) {
      queries++; const at = performance.now(); try { return await client.query(...args); } finally { sqlMs += performance.now() - at; }
    } }, identity, input), readOnly);
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - start, sqlMs, queries, bytes };
    assert.equal(queries, queryBudget); await verify(result, input); if (index) entry.samples.push(sample); else entry.warmup = sample;
  }
  entry.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
  entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ fieldCount: f.record.fieldCount, name, budgetMs, ...entry.metrics, passed: entry.passed }));
}
const save = f => (client, identity, input) => updateUserForm(client, identity, f.person.userId, input);
const read = f => (client, identity) => loadUserForm(client, identity, f.person.userId);
async function checkState(f) {
  const current = await work(f.manager, read(f), true); const state = f.state();
  assert.equal(current.account.revision, state.revision); assert.equal(current.profile.revision, state.profileRevision); assert.equal(current.fieldCapture.revision, state.customFieldRevision);
  assert.equal(current.account.displayName, f.lastInput().displayName); assert.equal(current.profile.phone, f.lastInput().phone);
  assert.deepEqual(current.fieldCapture.customFields.map(({ fieldId, fieldRevision, value }) => ({ fieldId, fieldRevision, value })), f.fields);
}
const verifySave = f => async (result, input) => {
  assert.equal(result.id, f.person.userId); assert.equal(result.revision, input.revision + 1); assert.equal(result.profileRevision, input.profileRevision + 1);
  assert.equal(result.passwordChanged, !!input.password);
  if (input.customFields) assert.equal(result.customFieldRevision, input.customFieldRevision + 1); else assert.equal(Object.hasOwn(result, 'customFieldRevision'), false);
  f.accept(result, input); await checkState(f);
};
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const [fieldCount, items, writeBudget, readBudget] of [[0, 0, 250, 100], [10, 1, 500, 150], [100, 10, 1500, 400], [500, 10, 4000, 1000]]) {
    const f = await fixture(fieldCount, items);
    await measure(f, 'edit complete form with supplied fields', writeBudget, fieldCount ? 11 : 7, false, () => f.input(), save(f), verifySave(f));
    await measure(f, 'read complete form with supplied fields', readBudget, fieldCount ? 7 : 5, true, () => null, read(f), result => {
      assert.equal(result.account.revision, f.state().revision); assert.equal(result.profile.revision, f.state().profileRevision); assert.equal(result.fieldCapture.revision, f.state().customFieldRevision);
      assert.deepEqual(result.fieldCapture.customFields.map(({ fieldId, fieldRevision, value }) => ({ fieldId, fieldRevision, value })), f.fields);
    });
    if (fieldCount === 500) {
      const exact = f.lastInput(); const before = f.state();
      await measure(f, 'largest exact complete-form retry', 750, 6, false, () => exact, save(f), async result => {
        assert.deepEqual(result, { id: f.person.userId, revision: before.revision, profileRevision: before.profileRevision, customFieldRevision: before.customFieldRevision, passwordChanged: false }); await checkState(f);
      });
      await measure(f, 'largest complete form with supplied password', 4000, 11, false, () => f.input(true, 'Synthetic largest complete form password'), save(f), verifySave(f));
    }
  }
  for (const fieldCount of [100, 500]) {
    const f = await fixture(fieldCount, 1, true);
    await measure(f, 'omitted fields validate current uniqueness with history', fieldCount === 100 ? 750 : 2500, 3, false, () => f.input(false), save(f), verifySave(f));
    assert.equal(f.state().customFieldRevision, 1); assert.equal(f.record.completedHistoryCaptures, 60);
  }
  assert.equal(report.cases.length, 12); report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('Complete form budgets failed; preserve the evidence and diagnose.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-form-fields-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
