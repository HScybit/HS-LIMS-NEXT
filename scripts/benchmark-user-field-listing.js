import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../src/masters/custom-fields.js';
import { saveUserCustomFields } from '../src/users/custom-fields.js';
import { listUsers } from '../src/users/directory.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, fixtures: [], cases: [],
  conditions: 'Run alone on isolated PostgreSQL. Each organization has10000 synthetic uncredentialed members plus two fixture actors;50 members have five native captures of100/500 fields, including number/boolean/date/select/text and a replacement definition UUID sharing an original saved key. Explicit ANALYZE before captures and after setup. One warmup/five samples. Timings include actual session authentication, repeatable-read read-only transaction, service SQL/driver, assembly, commit and JSON serialization; setup, assertions, socket and browser excluded. Service query counts exclude authentication/transaction statements. This does not establish first-read performance after unanalyzed loads, arbitrary text lengths, or500 simultaneous URL filters.' };
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const account = async options => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const analyze = () => owner.query('ANALYZE users,memberships,roles,membership_roles,custom_field_definitions,custom_field_versions,custom_field_version_options,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');

async function fixture(count) {
  const started = performance.now(); const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const prefix = `Listing-${randomUUID()}`; const record = { count, organizationId: author.organizationId, members: 10000, capturedMembers: 50, revisions: 5, setupStage: 'members' }; report.fixtures.push(record);
  const people = (await owner.query(`INSERT INTO users(id,username,email,display_name)
    SELECT gen_random_uuid(),$1||'-'||n,$1||'-'||n||'@example.invalid',$1||'-'||lpad(n::text,6,'0') FROM generate_series(0,9999) n
    RETURNING id,display_name`, [prefix])).rows.sort((a, b) => a.display_name.localeCompare(b.display_name));
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [author.organizationId, people.map(person => person.id)]);
  const fields = []; record.setupStage = 'definitions';
  await work(author, async (c, i) => {
    for (let n = 0; n < count; n++) fields.push(await saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key: `listing_${n}`, label: `Listing field ${String(n).padStart(3, '0')}`, fieldType: ['number', 'checkbox', 'date', 'select'][n] ?? 'text',
      associatedWith: 'users', showInList: true, showInFilter: true, displayOrder: n,
      ...(n === 3 ? { options: [{ id: randomUUID(), key: 'A', label: 'Choice Alpha' }, { id: randomUUID(), key: 'B', label: 'Choice Beta' }] } : {}) }));
  });
  await analyze(); record.setupStage = 'native captures';
  const value = (n, person, revision) => n === 0 ? person - 25 : n === 1 ? person % 2 === 0 : n === 2 ? '2025-04-05'
    : n === 3 ? person % 2 ? 'B' : 'A' : `Revision ${revision} member ${person} field ${n} %_[x]\\literal`;
  for (let revision = 0; revision < 5; revision++) {
    if (revision === 2) await work(author, async (c, i) => {
      const original = fields[count - 1]; await retireCustomField(c, i, { id: original.id, revision: 1, requestId: randomUUID() });
      fields[count - 1] = await saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0, key: original.key,
        label: 'Replacement listing field', fieldType: 'text', associatedWith: 'users', showInList: true, showInFilter: true, displayOrder: count - 1 });
      record.replacedDefinition = { originalId: original.id, currentId: fields[count - 1].id, key: original.key };
    });
    for (let person = 0; person < 50; person++) await work(manager, (c, i) => saveUserCustomFields(c, i, people[person].id, {
      requestId: randomUUID(), revision, customFieldTimeZone: 'UTC', customFields: fields.map((field, n) => ({ fieldId: field.id, fieldRevision: field.revision, value: value(n, person, revision) })) }));
    record.completedCaptureRevisions = revision + 1; console.log(JSON.stringify({ count, preparedRevision: revision + 1 }));
  }
  const at = performance.now(); await analyze(); record.analyzeMs = performance.now() - at; record.setupMs = performance.now() - started; record.setupStage = 'complete';
  return { manager, record, fields, people, prefix, value };
}

async function measure(f, name, input, budgetMs, expectedQueries, validate) {
  const entry = { count: f.record.count, name, input, budgetMs, expectedQueries, samples: [] }; report.cases.push(entry);
  for (let index = 0; index < 6; index++) {
    let queries = 0; let sqlMs = 0; const statements = []; const started = performance.now();
    const result = await work(f.manager, (client, identity) => listUsers({ async query(...args) {
      queries++; const at = performance.now(); try { return await client.query(...args); }
      finally { const ms = performance.now() - at; sqlMs += ms; statements.push({ sql: args[0], ms }); }
    } }, identity, input), true);
    const bytes = Buffer.byteLength(JSON.stringify(result)); const sample = { totalMs: performance.now() - started, sqlMs, queries, bytes, statements };
    assert.equal(queries, expectedQueries); validate(result); if (index) entry.samples.push(sample); else entry.warmup = sample;
  }
  entry.metrics = Object.fromEntries(['totalMs', 'sqlMs', 'queries', 'bytes'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
  entry.passed = entry.metrics.totalMs <= budgetMs; console.log(JSON.stringify({ count: entry.count, name, budgetMs, ...entry.metrics, passed: entry.passed }));
}

try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  for (const count of [100, 500]) {
    const f = await fixture(count); const pageSize = count === 100 ? 25 : 100;
    await measure(f, 'visible custom columns', { search: f.prefix, pageSize }, count === 100 ? 750 : 2000, 6, result => {
      assert.equal(result.totalCount, 10000); assert.deepEqual(result.rows.map(row => row.id), f.people.slice(0, pageSize).map(person => person.id));
      for (const [index, row] of result.rows.entries()) {
        assert.equal(Object.keys(row.customFields).length, index < 50 ? count : 0);
        if (index < 50) { assert.equal(row.customFields.listing_0.displayValue, index - 25); assert.equal(row.customFields.listing_1.displayValue, index % 2 === 0);
          assert.equal(row.customFields.listing_2.value, '2025-04-05'); assert.equal(row.customFields[`listing_${count - 1}`].displayValue, f.value(count - 1, index, 4)); }
      }
    });
    if (count !== 500) continue;
    const exact = f.value(count - 1, 7, 4); const one = result => { assert.equal(result.totalCount, 1); assert.equal(result.rows[0].id, f.people[7].id); };
    await measure(f, 'literal custom filter', { filters: { [`pf:listing_${count - 1}`]: { type: 'text', value: exact } } }, 1500, 6, one);
    await measure(f, 'global captured search', { search: exact }, 1500, 6, one);
    await measure(f, 'numeric custom filter', { filters: { 'pf:listing_0': { type: 'text', value: '0x0' } } }, 1500, 6,
      result => { assert.equal(result.totalCount, 1); assert.equal(result.rows[0].id, f.people[25].id); });
    await measure(f, 'boolean custom filter', { pageSize: 100, filters: { 'pf:listing_1': { type: 'text', value: 'NO' } } }, 1500, 6,
      result => { assert.equal(result.totalCount, 25); assert(result.rows.every(row => row.customFields.listing_1.displayValue === false)); });
    for (const dir of ['asc', 'desc']) await measure(f, `custom display sort ${dir}`, { search: f.prefix, pageSize: 100, sort: { key: 'pf:listing_0', dir } }, 1500, dir === 'asc' ? 5 : 6,
      result => { assert.equal(result.totalCount, 10000); assert.equal(result.rows.length, 100);
        if (dir === 'asc') assert(result.rows.every(row => Object.keys(row.customFields).length === 0));
        else { assert.deepEqual(result.rows.slice(0, 50).map(row => row.id), f.people.slice(0, 50).reverse().map(person => person.id)); assert(result.rows.slice(50).every(row => Object.keys(row.customFields).length === 0)); }
      });
    await measure(f, 'absent global match', { search: `No match ${randomUUID()}` }, 1500, 4,
      result => { assert.equal(result.totalCount, 0); assert.deepEqual(result.rows, []); });
  }
  report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; assert.equal(report.status, 'passed');
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code, constraint: error.constraint }; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-field-listing-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
