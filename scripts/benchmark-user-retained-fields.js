import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../src/masters/custom-fields.js';
import { saveUserCustomFields, loadUserCustomFields } from '../src/users/custom-fields.js';
import { uploadUserFieldAttachment } from '../src/users/custom-field-attachments.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, fixtures: [], cases: [],
  conditions: 'Run alone on isolated local PostgreSQL. One warmup/five samples. Select fixtures have 10 actual original options/items per field with 80-character keys; replacement definitions have a different choice. Attachment fixtures use small real uploads and one file per field. Seven subjects have actual original captures before old definitions are renamed/retired and new UUIDs reuse their keys. Explicit ANALYZE runs before a separate subject primes the retained path, and again after priming. Measured captures use distinct subjects. Actual auth, normalization, transaction, SQL/driver, integrity checks, assembly, commit and JSON serialization included; setup, verification reads, socket/browser transfer excluded. Service query counts exclude auth/control queries whose elapsed time is included. This does not establish first-read performance after an unanalyzed bulk load.' };
const work = (actor, operation, readOnly = false) => withSession(actor.token, operation, { readOnly });
const account = async options => { const person = await createAccount(owner, options); return { ...person, ...await signIn({ identifier: person.username, password: person.password }) }; };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
async function fixture(type, fieldCount) {
  const at = performance.now(); const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const record = { type, fieldCount, itemsPerField: type === 'select' ? 10 : 1, organizationId: author.organizationId, setupStage: 'original definitions', completedOriginalCaptures: 0 };
  report.fixtures.push(record); const values = Array.from({ length: 10 }, (_, index) => `option_${index}`.padEnd(80, 'v'));
  const old = []; await work(author, async (client, identity) => {
    for (let index = 0; index < fieldCount; index++) old.push(await saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key: `field_${index}`, label: `Original field ${index}`, associatedWith: 'users', fieldType: type, allowsMultiple: type === 'select',
      ...(type === 'select' ? { options: values.map(key => ({ id: randomUUID(), key, label: key })) } : {}) }));
  });
  const files = []; if (type === 'attachment') {
    record.setupStage = 'original uploads'; await work(manager, async (client, identity) => {
      for (const [index, field] of old.entries()) files.push(await uploadUserFieldAttachment(client, identity, { requestId: randomUUID(), fieldId: field.id, fieldRevision: 1,
        originalName: `Original-${index}.txt`, mediaType: 'text/plain', content: Buffer.from(`Original file ${index}`) }));
    });
  }
  record.setupStage = 'original captures'; const subjects = [];
  for (let index = 0; index < 7; index++) {
    const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] }); subjects.push(person);
    await work(manager, (client, identity) => saveUserCustomFields(client, identity, person.userId, { requestId: randomUUID(), revision: 0,
      customFields: old.map((field, position) => ({ fieldId: field.id, fieldRevision: 1, value: type === 'select' ? values : files[position].id })) }));
    record.completedOriginalCaptures++;
  }
  record.setupStage = 'replacement definitions'; await work(author, async (client, identity) => {
    for (const field of old) {
      await saveCustomField(client, identity, { id: field.id, requestId: randomUUID(), revision: 1,
        key: `retired_${field.key}`, label: field.label, associatedWith: 'users', fieldType: type, allowsMultiple: type === 'select', options: field.options });
      await retireCustomField(client, identity, { id: field.id, requestId: randomUUID(), revision: 2 });
    }
  });
  const current = []; await work(author, async (client, identity) => {
    for (let index = 0; index < fieldCount; index++) current.push(await saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key: `field_${index}`, label: `Replacement field ${index}`, associatedWith: 'users', fieldType: type, allowsMultiple: type === 'select',
      ...(type === 'select' ? { options: [{ id: randomUUID(), key: 'replacement', label: 'Replacement choice' }] } : {}) }));
  });
  const commands = subjects.map(() => ({ requestId: randomUUID(), revision: 1,
    customFields: current.map((field, index) => ({ fieldId: field.id, fieldRevision: 1, value: type === 'select' ? values : files[index].id })) }));
  const preAnalyzeAt = performance.now();
  await owner.query('ANALYZE users,memberships,custom_field_definitions,custom_field_versions,custom_field_version_options,custom_field_attachments,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');
  record.prePrimeAnalyzeMs = performance.now() - preAnalyzeAt;
  record.setupStage = 'prime retained capture'; await work(manager, (client, identity) => saveUserCustomFields(client, identity, subjects[6].userId, commands[6]));
  record.setupMs = performance.now() - at; const analyzeAt = performance.now();
  await owner.query('ANALYZE users,memberships,custom_field_definitions,custom_field_versions,custom_field_version_options,custom_field_attachments,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');
  record.analyzeMs = performance.now() - analyzeAt; record.setupStage = 'complete'; console.log(JSON.stringify({ prepared: record }));
  return { manager, record, subjects, commands, current, files, values };
}
async function verify(f, result, index, expectedRevision = 2) {
  assert.equal(result.id, f.subjects[index].userId); assert.equal(result.revision, expectedRevision);
  const fields = (await work(f.manager, (client, identity) => loadUserCustomFields(client, identity, result.id), true)).customFields;
  assert.deepEqual(fields.map(field => field.fieldId), f.current.map(field => field.id));
  for (const [position, field] of fields.entries()) {
    assert.equal(field.key, `field_${position}`);
    if (f.record.type === 'select') { assert.deepEqual(field.value, f.values); assert(field.items.every(item => item.interpretationState === 'invalid' && item.optionId === null)); }
    else { assert.equal(field.value, f.files[position].id); assert.equal(field.items[0].attachment.originalName, `Original-${position}.txt`); }
  }
}
async function measure(f, name, budgetMs, queriesExpected, readOnly, operation, validate) {
  const record = { fixture: f.record, name, budgetMs, serviceQueryBudget: queriesExpected, samples: [] }; report.cases.push(record);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; const statements = []; const start = performance.now();
    const result = await work(f.manager, (client, identity) => operation({ async query(...args) {
      queries++; const at = performance.now(); try { return await client.query(...args); } finally {
        const ms = performance.now() - at; sqlMs += ms; statements.push({ sql: args[0], ms });
      }
    } }, identity, index), readOnly);
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - start, sqlMs, queries, bytes, statements };
    assert.equal(queries, queriesExpected); await validate(result, index); if (index) record.samples.push(sample); else record.warmup = sample;
  }
  record.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(record.samples.map(sample => sample[key]))]));
  record.passed = record.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ type: f.record.type, fieldCount: f.record.fieldCount, name, budgetMs, ...record.metrics, passed: record.passed }));
}
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const type of ['select', 'attachment']) for (const fieldCount of [100, 500]) {
    const f = await fixture(type, fieldCount);
    await measure(f, 'retained values under replacement definitions', fieldCount === 100 ? 750 : 2500, 9, false,
      (client, identity, index) => saveUserCustomFields(client, identity, f.subjects[index].userId, f.commands[index]), (result, index) => verify(f, result, index));
    if (type === 'select' && fieldCount === 500) {
      await measure(f, 'largest unresolved exact retry', 750, 3, false,
        (client, identity) => saveUserCustomFields(client, identity, f.subjects[5].userId, f.commands[5]), result => verify(f, result, 5));
      await measure(f, 'largest unresolved current read', 750, 3, true,
        (client, identity) => loadUserCustomFields(client, identity, f.subjects[5].userId), result => {
          assert.equal(result.revision, 2); assert.equal(result.customFields.length, 500); for (const field of result.customFields) assert.deepEqual(field.value, f.values);
        });
      await measure(f, 'largest unresolved repeated capture', 2500, 9, false,
        (client, identity, index) => saveUserCustomFields(client, identity, f.subjects[index].userId, { ...f.commands[index], requestId: randomUUID(), revision: 2 }),
        (result, index) => verify(f, result, index, 3));
    }
  }
  assert.equal(report.cases.length, 7); report.status = report.cases.every(record => record.passed) ? 'passed' : 'failed';
  if (report.status !== 'passed') throw new Error('Retained user-field budgets failed; preserve and diagnose.');
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-retained-fields-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
