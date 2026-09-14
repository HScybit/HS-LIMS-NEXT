import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveUserCustomFields, loadUserCustomFields } from '../src/users/custom-fields.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, fixtures: [], cases: [],
  conditions: 'Run alone on isolated synthetic PostgreSQL. Each fixture has 100 or 500 unique text fields, one 80-character primitive per field, and 20 existing users with three actual capture revisions each. Each measured attempt targets a different unrecorded user. One warmup/five samples; explicit ANALYZE after each setup phase. Actual auth, transaction, validation, SQL/driver, assembly, commit or rollback and JSON serialization included. Fixture setup, verification reads and browser/socket transport excluded. Service query counts exclude authentication/control queries whose elapsed time is included.' };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
async function account(options) { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; }
const valueFor = (prefix, index, revision = 1) => `${prefix}-${index}-revision-${revision}`.padEnd(80, 'v');
const input = (ids, fieldRevision, value, revision = 0) => ({ requestId: randomUUID(), revision, customFields: ids.map(fieldId => ({ fieldId, fieldRevision, value })) });
async function definitions(author, ids) {
  await withSession(author.token, (client, identity) => client.query(`INSERT INTO custom_field_definitions
    (organization_id,id,key,label,associated_with,field_type,validate_uniqueness,save_request_id,display_order)
    SELECT $1,id,'field_'||position,'Field '||position,'users','text',true,gen_random_uuid(),position
    FROM unnest($2::uuid[]) WITH ORDINALITY AS fixture(id,position)`, [identity.organization_id, ids]));
}
async function analyze(fixture, phase) {
  const at = performance.now(); await owner.query('ANALYZE users,memberships,custom_field_definitions,custom_field_versions,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');
  fixture.statistics.push({ phase, durationMs: performance.now() - at });
}
async function measure(fixture, name, manager, reader, people, commands, expectedDuplicate) {
  const record = { fixture: { organizationId: fixture.organizationId, fieldCount: fixture.fieldCount, existingUsers: 20, existingCaptureRevisions: 3 }, name,
    budgetMs: fixture.fieldCount === 100 ? 750 : 2500, expectedDuplicate, samples: [] }; report.cases.push(record);
  for (let index = 0; index < 6; index++) {
    const id = people[index].userId; let queries = 0; let sqlMs = 0; const start = performance.now(); let result;
    try {
      result = await withSession(manager.token, (client, identity) => saveUserCustomFields({ async query(...args) {
        queries++; const at = performance.now(); try { return await client.query(...args); } finally { sqlMs += performance.now() - at; }
      } }, identity, id, commands[index]));
    } catch (error) { if (!expectedDuplicate || error.code !== 'duplicate_user_custom_field') throw error; result = { error: { code: error.code, status: error.status } }; }
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - start, sqlMs, queries, bytes };
    assert.equal(queries, expectedDuplicate ? 5 : 6);
    if (expectedDuplicate) {
      assert.equal(result.error?.code, 'duplicate_user_custom_field');
      const state = (await owner.query(`SELECT member.custom_field_revision,(SELECT count(*)::integer FROM user_field_value_versions WHERE organization_id=$1 AND subject_user_id=$2) AS headers
        FROM memberships member WHERE member.organization_id=$1 AND member.user_id=$2`, [fixture.organizationId, id])).rows[0];
      assert.deepEqual(state, { custom_field_revision: 0, headers: 0 });
    } else {
      assert.equal(result.id, id); assert.equal(result.revision, 1);
      const capture = await withSession(reader.token, (client, identity) => loadUserCustomFields(client, identity, id), { readOnly: true });
      assert.equal(capture.customFields.length, fixture.fieldCount); assert.deepEqual(capture.customFields.map(field => field.value), commands[index].customFields.map(field => field.value));
    }
    if (index) record.samples.push(sample); else record.warmup = sample;
  }
  record.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(record.samples.map(sample => sample[key]))]));
  record.passed = record.metrics.totalMs <= record.budgetMs; console.log(JSON.stringify({ fieldCount: fixture.fieldCount, name, budgetMs: record.budgetMs, ...record.metrics, passed: record.passed }));
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const fieldCount of [100, 500]) {
    const setupAt = performance.now(); const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
    const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] }); const ids = Array.from({ length: fieldCount }, () => randomUUID());
    const fixture = { fieldCount, organizationId: author.organizationId, statistics: [], setupStage: 'definitions', completedHistoryCaptures: 0 }; report.fixtures.push(fixture);
    await definitions(author, ids); fixture.setupStage = 'accounts';
    const existing = []; const subjects = [];
    for (let index = 0; index < 20; index++) existing.push(await createAccount(owner, { organizationId: author.organizationId, permissions: [] }));
    for (let index = 0; index < 18; index++) subjects.push(await createAccount(owner, { organizationId: author.organizationId, permissions: [] }));
    fixture.setupStage = 'capture history';
    for (let revision = 0; revision < 3; revision++) for (let index = 0; index < existing.length; index++) {
      await withSession(manager.token, (client, identity) => saveUserCustomFields(client, identity, existing[index].userId, input(ids, 1, valueFor('existing', index, revision + 1), revision)));
      fixture.completedHistoryCaptures++;
    }
    fixture.setupStage = 'complete'; fixture.setupMs = performance.now() - setupAt;
    await analyze(fixture, 'stable keys'); console.log(JSON.stringify({ prepared: fixture }));
    await measure(fixture, 'stable key success with existing history', manager, reader, subjects.slice(0, 6), Array.from({ length: 6 }, (_, index) => input(ids, 1, valueFor('new', index))), false);
    await withSession(author.token, (client, identity) => client.query(`UPDATE custom_field_definitions SET key='renamed_'||key,revision=revision+1,save_request_id=gen_random_uuid(),updated_at=transaction_timestamp()
      WHERE organization_id=$1 AND id=ANY($2::uuid[])`, [identity.organization_id, ids]));
    await analyze(fixture, 'renamed keys');
    await measure(fixture, 'renamed key accepts the original-key value', manager, reader, subjects.slice(6, 12), Array.from({ length: 6 }, (_, index) => input(ids, 2, valueFor('existing', index, 3))), false);
    await withSession(author.token, (client, identity) => client.query(`UPDATE custom_field_definitions SET active=false,revision=revision+1,save_request_id=gen_random_uuid(),updated_at=transaction_timestamp()
      WHERE organization_id=$1 AND id=ANY($2::uuid[])`, [identity.organization_id, ids]));
    const replacements = Array.from({ length: fieldCount }, () => randomUUID()); await definitions(author, replacements); await analyze(fixture, 'reused keys');
    await measure(fixture, 'reused key rejects the original-key duplicate', manager, reader, subjects.slice(12, 18), Array.from({ length: 6 }, (_, index) => input(replacements, 1, valueFor('existing', index, 3))), true);
  }
  report.status = report.cases.every(record => record.passed) ? 'passed' : 'failed'; if (report.status !== 'passed') throw new Error('Saved-key uniqueness budgets failed; preserve the report and diagnose.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-field-consistency-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
