import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { prepareSubjectJob } from '../helpers/job-subjects.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';

const owner = ownerPool(); let manager;
const work = (account, action) => withSession(account.token, action, { csrfToken: account.csrfToken });
async function account(options = {}) {
  const value = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'], ...options });
  return { ...value, ...await signIn({ identifier: value.username, password: value.password }) };
}
before(async () => { manager = await account(); });
after(async () => { await closePool(); await owner.end(); });
async function setup(extra = {}, user = manager, options = {}) {
  const fixture = await createLaboratoryFixture(owner, user, { repeated: false, ...options });
  const sample = await work(user, (client, identity) => registerSample(client, identity, { ...fixture.registration, ...extra }));
  return { sample, fixture };
}
const generate = (sample, input = {}, user = manager) => work(user, (client, identity) => generateTestRequests(client, identity, sample.id, input));
const due = async (id, user = manager) => (await owner.query('SELECT due_at::text AS value FROM test_requests WHERE organization_id=$1 AND id=$2', [user.organizationId, id])).rows[0].value;
async function snapshot(user = manager) {
  const result = {};
  for (const table of ['samples', 'sample_products', 'sample_tests', 'sample_events', 'number_sequences', 'test_requests', 'analytical_specifications', 'workflow_runs', 'workflow_run_history', 'template_instances', 'datasheets']) {
    result[table] = (await owner.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [user.organizationId])).rows.map(row => JSON.stringify(row)).sort();
  }
  return result;
}

test('explicit test-request due dates preserve their supplied microseconds', async () => {
  const { sample } = await setup(); const result = await generate(sample, { dueAt: '2026-09-14T10:30:00.123456+05:30' });
  assert.equal(result.items.length, 1); assert.equal(await due(result.items[0].id), '2026-09-14 05:00:00.123456+00');
});

test('PostgreSQL-invalid timestamp offsets reject without generating any records', async () => {
  const { sample } = await setup(); const before = await snapshot();
  await assert.rejects(generate(sample, { dueAt: '2026-09-14T10:30:00+23:00' }), { code: 'invalid_sample', status: 400 });
  assert.deepEqual(await snapshot(), before);
});

test('offset equivalents, precision rounding and valid calendar boundaries keep their PostgreSQL instants', async () => {
  for (const [input, expected] of [
    ['2026-09-14T05:00:00.123456Z', '2026-09-14 05:00:00.123456+00'],
    ['2026-09-14T10:30:00.123456+05:30', '2026-09-14 05:00:00.123456+00'],
    ['2026-09-14T05:00:00.1234567Z', '2026-09-14 05:00:00.123457+00'],
    ['2031-12-31T23:59:59.9999999Z', '2032-01-01 00:00:00+00'],
    ['0001-01-01T00:00:00Z', '0001-01-01 00:00:00+00'],
    ['9999-12-31T23:59:59.9999994Z', '9999-12-31 23:59:59.999999+00'],
  ]) {
    const { sample } = await setup(); const result = await generate(sample, { dueAt: input });
    assert.equal(await due(result.items[0].id), expected);
  }
});

test('omitted and null overrides inherit the precise saved due date, including a missing date', async () => {
  for (const input of [{}, { dueAt: null }]) {
    const { sample } = await setup({ dueAt: '2026-09-14T05:00:00.654321Z' }); const result = await generate(sample, input);
    assert.equal(await due(result.items[0].id), '2026-09-14 05:00:00.654321+00');
  }
  const { sample } = await setup({ dueAt: null }); const result = await generate(sample, { dueAt: null });
  assert.equal(await due(result.items[0].id), null);
  const before = await snapshot(); assert.deepEqual(await generate(sample, { dueAt: '2027-01-01T00:00:00.123456Z' }), { items: [], jobs: [] });
  assert.deepEqual(await snapshot(), before);
});

test('invalid and out-of-domain canonical dates reject before any persistent generation effects', async () => {
  const { sample } = await setup(); const before = await snapshot();
  for (const [dueAt, code] of [['', 'invalid_sample'], ['invalid', 'invalid_sample'], ['2024-02-30T00:00:00Z', 'invalid_date'],
    ['2026-09-14T00:00:00+16:00', 'invalid_sample'], ['9999-12-31T23:59:59.9999999Z', 'invalid_sample'],
    ['9999-12-31T23:30:00-01:00', 'invalid_sample'], ['0001-01-01T00:00:00+00:01', 'invalid_sample']]) {
    await assert.rejects(generate(sample, { dueAt }), { code, status: 400 }); assert.deepEqual(await snapshot(), before);
  }
});

test('generation still enforces permissions and tenant access before creating dated records', async () => {
  const { sample } = await setup();
  const reader = await account({ organizationId: manager.organizationId, permissions: ['samples.read'] });
  const creator = await account({ organizationId: manager.organizationId, permissions: ['samples.create'] }); const foreign = await account();
  const before = await snapshot(); const input = { dueAt: '2026-09-14T05:00:00.123456Z' };
  for (const user of [reader, creator]) await assert.rejects(generate(sample, input, user), { status: 403 });
  await assert.rejects(generate(sample, input, foreign), { status: 404 }); assert.deepEqual(await snapshot(), before);
});

test('a late generation event failure rolls back precise dates, numbers, specifications and test status', async () => {
  const { sample } = await setup(); const before = await snapshot(); let insertedRequests = false;
  await assert.rejects(work(manager, async (client, identity) => {
    const query = client.query.bind(client);
    client.query = (statement, ...args) => {
      const text = typeof statement === 'string' ? statement : statement.text;
      if (/insert into "?test_requests"?/i.test(text)) insertedRequests = true;
      if (/insert into "?sample_events"?/i.test(text)) throw new Error('Synthetic late generation failure');
      return query(statement, ...args);
    };
    try { return await generateTestRequests(client, identity, sample.id, { dueAt: '2026-09-14T05:00:00.123456Z' }); }
    finally { client.query = query; }
  }), error => (error.cause ?? error).message === 'Synthetic late generation failure');
  assert.equal(insertedRequests, true); assert.deepEqual(await snapshot(), before);
});

test('concurrent generation retains the winning precise due date without duplicating requests', async () => {
  const { sample } = await setup(); const dates = ['2026-09-14T05:00:00.123456Z', '2026-09-14T05:00:00.654321Z'];
  const results = await Promise.all(dates.map(dueAt => generate(sample, { dueAt }))); const winner = results.findIndex(result => result.items.length);
  assert.equal(results.flatMap(result => result.items).length, 1); assert.equal(results[1 - winner].items.length, 0);
  assert.equal(await due(results[winner].items[0].id), dates[winner].replace('T', ' ').replace('Z', '+00'));
});

test('registration-only automatic generation inherits precise due dates without granting manual allocation', async () => {
  const creator = await account({ permissions: ['samples.create'] });
  const { sample } = await setup({ dueAt: '2026-09-14T05:00:00.654321Z' }, creator, { generateTestRequests: true });
  assert.equal(sample.testRequests.length, 1); assert.equal(await due(sample.testRequests[0].id, creator), '2026-09-14 05:00:00.654321+00');
  await assert.rejects(generate(sample, {}, creator), { status: 403 });
});

test('automatic jobs derive the full-precision explicit due date from generated children', async () => {
  const user = await account({ permissions: ['samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'templates.manage', 'settings.manage'] });
  const configured = await prepareSubjectJob(owner, user, user); const { settings } = await work(user, loadLaboratorySettings);
  await work(user, (client, identity) => saveLaboratorySettings(client, identity, { revision: settings.revision, autoCreateJobs: true,
    resultSummaryTemplateId: configured.template.templateId, jobWorkflowId: null }));
  const { sample } = await setup({}, user, { template: configured.template });
  const generated = await generate(sample, { dueAt: '2026-09-14T10:30:00.123456+05:30' }, user);
  assert.equal(generated.items.length, 1); assert.equal(generated.jobs.length, 1);
  assert.equal(await due(generated.items[0].id, user), '2026-09-14 05:00:00.123456+00');
  assert.equal(await due(generated.jobs[0].id, user), '2026-09-14 05:00:00.123456+00');
});
