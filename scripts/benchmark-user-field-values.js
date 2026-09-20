import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveUserCustomFields, loadUserCustomFields } from '../src/users/custom-fields.js';

const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true,
  conditions: 'Run alone on synthetic PostgreSQL. One warmup/five samples. Each first capture uses a different unrecorded subject; setup seeds one separate capture then explicitly ANALYZEs the populated tables. Text primitives are 80 characters. Actual authentication, transaction, input validation, SQL/driver, assembly, commit and response serialization included. Fixtures/statistics, socket/browser transfer excluded. Service query counts exclude authentication queries, whose time is included. The selected-user case has one field with 100 actual member references and frozen labels.', cases: [] };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
async function account(options) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function measure(fixture, name, budgetMs, actor, readOnly, operation, verify) {
  const record = { fixture, name, budgetMs, samples: [] }; report.cases.push(record);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; const at = performance.now();
    const result = await withSession(actor.token, (client, identity) => operation(index, { async query(...args) {
      queries++; const start = performance.now(); const value = await client.query(...args); sqlMs += performance.now() - start; return value;
    } }, identity), { readOnly });
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - at, sqlMs, queries, bytes };
    verify(result, index, queries); if (index) record.samples.push(sample); else record.warmup = sample;
  }
  record.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(record.samples.map(sample => sample[key]))]));
  record.passed = record.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ fixture, name, budgetMs, ...record.metrics, passed: record.passed }));
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  report.fixtures = [];
  for (const [fieldCount, itemsPerField, userCount, writeBudget, readBudget] of [[0, 0, 0, 100, 50], [10, 1, 0, 150, 75],
    [100, 10, 0, 750, 250], [500, 10, 0, 2500, 750], [1, 100, 100, 750, 250]]) {
    const setupAt = performance.now(); const author = await account({ permissions: ['masters.manage'] });
    const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
    const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
    const subjects = []; for (let i = 0; i < 7; i++) subjects.push(await createAccount(owner, { organizationId: author.organizationId, permissions: [] }));
    const users = []; for (let i = 0; i < userCount; i++) users.push(await createAccount(owner, { organizationId: author.organizationId, permissions: [] }));
    const ids = Array.from({ length: fieldCount }, () => randomUUID());
    if (fieldCount) await withSession(author.token, (client, identity) => client.query(`INSERT INTO custom_field_definitions
      (organization_id,id,key,label,associated_with,field_type,allows_multiple,save_request_id,display_order)
      SELECT $1,id,'field_'||replace(id::text,'-',''),'Field '||position,'users',$3,$4,gen_random_uuid(),position
      FROM unnest($2::uuid[]) WITH ORDINALITY AS fixture(id,position)`, [identity.organization_id, ids, userCount ? 'multi_user_select' : 'text', itemsPerField > 1]));
    const value = userCount ? users.map(user => user.userId) : itemsPerField > 1
      ? Array.from({ length: itemsPerField }, (_, index) => String(index).padStart(80, 'v')) : 'v'.repeat(80);
    const commands = subjects.map(() => ({ requestId: randomUUID(), revision: 0, customFields: ids.map(fieldId => ({ fieldId, fieldRevision: 1, value })) }));
    await withSession(manager.token, (client, identity) => saveUserCustomFields(client, identity, subjects[6].userId, commands[6]));
    const analyzeAt = performance.now(); await owner.query('ANALYZE custom_field_definitions,custom_field_versions,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values,users,memberships');
    const fixture = { fieldCount, itemsPerField, userCount, organizationId: author.organizationId, setupMs: performance.now() - setupAt, analyzeMs: performance.now() - analyzeAt };
    report.fixtures.push(fixture); console.log(JSON.stringify({ prepared: fixture }));
    await measure(fixture, 'first capture', writeBudget, manager, false, (index, client, identity) => saveUserCustomFields(client, identity, subjects[index].userId, commands[index]), (result, index, queries) => {
      assert.equal(result.id, subjects[index].userId); assert.equal(result.revision, 1); assert.equal(queries, fieldCount ? userCount ? 7 : 6 : 4);
    });
    await measure(fixture, 'current values', readBudget, reader, true, (_index, client, identity) => loadUserCustomFields(client, identity, subjects[5].userId), (result, _index, queries) => {
      assert.equal(queries, fieldCount ? 3 : 1); assert.equal(result.customFields.length, fieldCount); assert.equal(result.revision, 1);
      assert.deepEqual(result.customFields.map(field => field.fieldId), ids);
      for (const field of result.customFields) { assert.deepEqual(field.value, value); if (userCount) assert(field.items.every(item => item.userName === 'Synthetic Analyst' && item.userUsername)); }
    });
    if (fieldCount === 500) await measure(fixture, 'exact retry', 750, manager, false,
      (_index, client, identity) => saveUserCustomFields(client, identity, subjects[5].userId, commands[5]), (result, _index, queries) => {
        assert.equal(result.revision, 1); assert.equal(queries, 3);
      });
  }
  report.status = report.cases.every(record => record.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('User field capture budgets failed. Preserve the report and diagnose.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-field-values-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
