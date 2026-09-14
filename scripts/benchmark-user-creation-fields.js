import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { createUser } from '../src/users/create.js';
import { loadUserCustomFields } from '../src/users/custom-fields.js';

const owner = ownerPool();
const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, cases: [], fixtures: [],
  conditions: 'Run alone on the isolated local database. One warmup/five measured samples; each creation uses a different new identity. Fixture setup seeds a separate creation and explicitly ANALYZEs populated tables. Text primitives are80 characters. Actual authentication, input normalization, keyed fingerprinting, scrypt password hashing, transaction, SQL/driver, assembly, deferred checks, commit and response JSON serialization included. Setup, verification reads and socket/browser transport excluded. Service query counts exclude auth/transaction-control queries whose elapsed time is included. No passwords, credential hashes or fingerprints are recorded.' };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
async function account(options) { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; }
async function measure(fixture, actor, name, budgetMs, queryBudget, commands, verify) {
  const entry = { fixture, name, budgetMs, queryBudget, samples: [] }; report.cases.push(entry);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; const start = performance.now();
    const result = await withSession(actor.token, (client, identity) => createUser({ async query(...args) {
      queries++; const at = performance.now(); try { return await client.query(...args); } finally { sqlMs += performance.now() - at; }
    } }, identity, commands[index]));
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - start, sqlMs, queries, bytes };
    assert.equal(queries, queryBudget); assert.equal(result.user.id, commands[index].id); assert.equal(result.profileRevision, 1); assert.equal(result.customFieldRevision, 1);
    await verify(result); if (index) entry.samples.push(sample); else entry.warmup = sample;
  }
  entry.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
  entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ fixture, name, budgetMs, ...entry.metrics, passed: entry.passed }));
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const [fieldCount, itemsPerField, createBudget, retryBudget] of [[0, 0, 500, 250], [10, 1, 500, 250], [100, 10, 1500, 500], [500, 10, 4000, 750]]) {
    const setupAt = performance.now(); const author = await account({ permissions: ['masters.manage'] });
    const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
    const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
    const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Creation field benchmark')", [author.organizationId, lab]);
    const ids = Array.from({ length: fieldCount }, () => randomUUID());
    if (fieldCount) await withSession(author.token, (client, identity) => client.query(`INSERT INTO custom_field_definitions
      (organization_id,id,key,label,associated_with,field_type,allows_multiple,save_request_id,display_order)
      SELECT $1,id,'field_'||replace(id::text,'-',''),'Field '||position,'users','text',$3,gen_random_uuid(),position
      FROM unnest($2::uuid[]) WITH ORDINALITY AS fixture(id,position)`, [identity.organization_id, ids, itemsPerField > 1]));
    const value = itemsPerField > 1 ? Array.from({ length: itemsPerField }, (_, index) => String(index).padStart(80, 'v')) : 'v'.repeat(80);
    const commands = Array.from({ length: 7 }, () => { const id = randomUUID(); return { id, requestId: randomUUID(), revision: 0, username: `create-field-${id}`,
      email: `${id}@example.invalid`, displayName: 'Synthetic creation fields', password: 'Synthetic benchmark creation fields password', defaultRoleId: reader.roleId,
      laboratoryId: lab, customFields: ids.map(fieldId => ({ fieldId, fieldRevision: 1, value })) }; });
    await withSession(manager.token, (client, identity) => createUser(client, identity, commands[6]));
    const analyzeAt = performance.now(); await owner.query('ANALYZE users,memberships,credentials,user_profiles,user_profile_versions,user_creation_commands,custom_field_definitions,custom_field_versions,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');
    const fixture = { fieldCount, itemsPerField, organizationId: author.organizationId, setupMs: performance.now() - setupAt, analyzeMs: performance.now() - analyzeAt };
    report.fixtures.push(fixture); console.log(JSON.stringify({ prepared: fixture }));
    const verify = async result => {
      const capture = await withSession(reader.token, (client, identity) => loadUserCustomFields(client, identity, result.user.id), { readOnly: true });
      assert.equal(capture.revision, 1); assert.deepEqual(capture.customFields.map(field => field.fieldId), ids); for (const field of capture.customFields) assert.deepEqual(field.value, value);
    };
    await measure(fixture, manager, 'create with fields', createBudget, fieldCount ? 7 : 5, commands, verify);
    await measure(fixture, manager, 'exact creation retry', retryBudget, fieldCount ? 4 : 2, Array(6).fill(commands[5]), verify);
  }
  report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; if (report.status !== 'passed') throw new Error('Creation field budgets failed; preserve the evidence and diagnose.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-creation-fields-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
