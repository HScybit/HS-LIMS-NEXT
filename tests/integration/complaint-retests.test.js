import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { updateSample } from '../../src/samples/update.js';
import { loadSample } from '../../src/samples/load.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';

const owner = ownerPool(); let manager; let reader; let foreign;
const work = (action, user = manager) => withSession(user.token, action, { csrfToken: user.csrfToken });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read', 'test_requests.allocate'], ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
before(async () => {
  manager = await account(); reader = await account({ organizationId: manager.organizationId, permissions: ['samples.read'] }); foreign = await account();
});
after(async () => { await closePool(); await owner.end(); });
const read = (sample, user = manager) => work((client, identity) => loadSample(client, identity, sample.id), user);
const testsOf = sample => sample.products.flatMap(line => line.tests);
const select = (sample, complaintRetestIds, extra = {}, user = manager) => work((client, identity) => updateSample(client, identity, sample.id,
  { revision: sample.revision, complaintRetestIds, ...extra }), user);
async function setup({ flags = [true, false], sampleType = 'complaint', headers = {}, fixtureOptions = {}, user = manager } = {}) {
  const fixture = await createLaboratoryFixture(owner, user, { repeated: false, ...fixtureOptions });
  const products = flags.map(isRetest => ({ ...structuredClone(fixture.registration.products[0]),
    tests: fixture.registration.products[0].tests.map(row => ({ ...row, isRetest })) }));
  const created = await work((client, identity) => registerSample(client, identity, { ...fixture.registration, sampleType, products, ...headers }), user);
  return { fixture, sample: await read(created, user), created };
}
async function snapshot(sample) {
  const result = {};
  for (const [name, query] of [
    ['sample', 'SELECT *,received_at::text AS received_exact,due_at::text AS due_exact FROM samples WHERE organization_id=$1 AND id=$2'],
    ['products', 'SELECT * FROM sample_products WHERE organization_id=$1 AND sample_id=$2'],
    ['tests', 'SELECT test.* FROM sample_tests test JOIN sample_products line ON line.organization_id=test.organization_id AND line.id=test.sample_product_id WHERE line.organization_id=$1 AND line.sample_id=$2'],
    ['events', 'SELECT * FROM sample_events WHERE organization_id=$1 AND sample_id=$2'],
  ]) result[name] = (await owner.query(query, [manager.organizationId, sample.id])).rows.map(row => JSON.stringify(row)).sort();
  return result;
}

test('complaint retest selection retains selected test IDs and removes only unselected tests', async () => {
  const { sample } = await setup(); const selected = sample.products[0].tests[0].id;
  await work((client, identity) => updateSample(client, identity, sample.id, { revision: sample.revision, complaintRetestIds: [selected] }));
  const saved = await read(sample);
  assert.deepEqual(saved.products.map(line => line.id), sample.products.map(line => line.id));
  assert.deepEqual(saved.products.flatMap(line => line.tests).map(row => row.id), [selected]);
});

test('complaint generation excludes planned rows that are not selected for retest', async () => {
  const { sample } = await setup();
  const result = await work((client, identity) => generateTestRequests(client, identity, sample.id, {}));
  assert.equal(result.items.length, 1);
  const saved = await read(sample); assert(saved.products[0].tests[0].requestId);
  assert.equal(saved.products[1].tests[0].requestId, null);
});

test('selecting an existing unused row changes only its retest flag and preserves locked metadata and line history', async () => {
  const { sample } = await setup({ flags: [false, true, false] }); const tests = testsOf(sample); const kept = tests.slice(0, 2);
  await select(sample, kept.map(row => row.id), { complaintRemarks: 'Selected for investigation', products: { invalid: true }, sampleCategoryId: 'invalid',
    description: 'Must remain locked', receivedAt: 'invalid', quantity: 'invalid' });
  const saved = await read(sample);
  assert.equal(saved.revision, sample.revision + 1); assert.equal(saved.complaintRemarks, 'Selected for investigation');
  assert.equal(saved.description, sample.description); assert.equal(saved.receivedAt.getTime(), sample.receivedAt.getTime());
  assert.deepEqual(saved.products.map(line => ({ ...line, tests: [] })), sample.products.map(line => ({ ...line, tests: [] })));
  assert.deepEqual(testsOf(saved), kept.map(row => ({ ...row, isRetest: true })));
  assert.equal(saved.activity.filter(event => event.eventType === 'sample_updated').length, 1);
  assert.equal(saved.activity.find(event => event.eventType === 'sample_updated').actorUserId, manager.userId);
});

test('selection detects retest identity collisions and may replace an unused counterpart while retaining its ID', async () => {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false }); const line = fixture.registration.products[0];
  const created = await work((client, identity) => registerSample(client, identity, { ...fixture.registration, sampleType: 'complaint',
    products: [{ ...line, tests: [true, false].map(isRetest => ({ ...line.tests[0], isRetest })) }] }));
  const sample = await read(created); const ids = testsOf(sample).map(row => row.id); const before = await snapshot(sample);
  await assert.rejects(select(sample, ids), { code: 'invalid_complaint_retest', status: 422 }); assert.deepEqual(await snapshot(sample), before);
  await select(sample, [ids[1]]); const saved = await read(sample);
  assert.equal(saved.products[0].id, sample.products[0].id);
  assert.deepEqual(testsOf(saved).map(row => ({ id: row.id, isRetest: row.isRetest })), [{ id: ids[1], isRetest: true }]);
});

test('empty, duplicate, foreign-sample and foreign-tenant selections fail without changing any sample data', async () => {
  const { sample } = await setup(); const other = await setup(); const elsewhere = await setup({ user: foreign }); const id = testsOf(sample)[0].id;
  const before = await snapshot(sample);
  for (const ids of [[], null, [id, id.toUpperCase()], [randomUUID()], [testsOf(other.sample)[0].id], [testsOf(elsewhere.sample)[0].id]]) {
    await assert.rejects(select(sample, ids)); assert.deepEqual(await snapshot(sample), before);
  }
  await assert.rejects(select(sample, [id], {}, reader), { status: 403 });
  await assert.rejects(select(sample, [id], {}, foreign), { status: 404 });
  assert.deepEqual(await snapshot(sample), before);
});

test('requested complaint tests cannot be removed and selecting them preserves frozen specifications', async () => {
  const { sample } = await setup({ flags: [true, true] });
  await work((client, identity) => generateTestRequests(client, identity, sample.id, {}));
  const opened = await read(sample); const ids = testsOf(opened).map(row => row.id); const before = await snapshot(opened);
  const specifications = (await owner.query('SELECT * FROM analytical_specifications WHERE organization_id=$1 ORDER BY id', [manager.organizationId])).rows;
  await assert.rejects(select(opened, ids.slice(0, 1), { complaintRemarks: 'Must roll back' }), { code: 'sample_lines_changed' });
  assert.deepEqual(await snapshot(opened), before);
  await select(opened, ids, { complaintRemarks: 'Preserve requested identities' });
  const saved = await read(opened); assert.deepEqual(testsOf(saved), testsOf(opened));
  assert.deepEqual((await owner.query('SELECT * FROM analytical_specifications WHERE organization_id=$1 ORDER BY id', [manager.organizationId])).rows, specifications);
});

test('a nonplanned legacy false retest flag is preserved instead of being silently changed', async () => {
  const { sample } = await setup(); const ids = testsOf(sample).map(row => row.id);
  await owner.query("UPDATE sample_tests SET status='cancelled' WHERE organization_id=$1 AND id=$2", [manager.organizationId, ids[1]]);
  const before = await snapshot(sample);
  await assert.rejects(select(sample, ids), { code: 'sample_lines_changed' });
  await assert.rejects(select(sample, ids.slice(0, 1)), { code: 'sample_lines_changed' });
  assert.deepEqual(await snapshot(sample), before);
  await work((client, identity) => updateSample(client, identity, sample.id, { revision: sample.revision, complaintRemarks: 'Header remains editable' }));
  const saved = await read(sample); assert.equal(testsOf(saved)[1].isRetest, false); assert.equal(testsOf(saved)[1].status, 'cancelled');
});

test('removed complaint selections use the source receiving-date calculation even though direct date fields are locked', async () => {
  const { fixture, sample } = await setup({ headers: { receivedAt: '2024-02-28T10:30:00.123456Z', dueAt: '2024-03-20T18:00:00.654321Z' } });
  await owner.query('UPDATE decision_rules SET estimated_time_in_days=3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.rule.id]);
  await select(sample, [testsOf(sample)[0].id], { receivedAt: 'invalid', dueAt: 'invalid' });
  const saved = await read(sample); assert.equal(saved.dueAt.toISOString(), '2024-03-02T00:00:00.000Z');
  const dates = (await owner.query('SELECT received_at::text AS received FROM samples WHERE organization_id=$1 AND id=$2', [manager.organizationId, sample.id])).rows[0];
  assert.equal(dates.received, '2024-02-28 10:30:00.123456+00');
});

test('inactive retained references can still be selected without changing their captured labels', async () => {
  const { fixture, sample } = await setup();
  for (const [table, id] of [['products', fixture.product.id], ['sample_categories', fixture.category.id], ['test_parameters', fixture.parameter.id],
    ['methods_of_analysis', fixture.method.id], ['decision_rules', fixture.rule.id]]) {
    await owner.query(`UPDATE ${table} SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2`, [manager.organizationId, id]);
  }
  await select(sample, testsOf(sample).map(row => row.id)); const saved = await read(sample);
  assert(saved.products.every((line, index) => line.productName === sample.products[index].productName));
  assert(testsOf(saved).every(row => row.isRetest));
});

test('a failed actor event rolls back retest removals, flags, dates and revision; stale retries fail', async () => {
  const { sample } = await setup({ flags: [true, false, false] }); const ids = testsOf(sample).slice(0, 2).map(row => row.id); const before = await snapshot(sample);
  await assert.rejects(work(async (client, identity) => {
    const query = client.query.bind(client);
    client.query = (input, ...args) => {
      const text = typeof input === 'string' ? input : input.text;
      if (/insert into "sample_events"/i.test(text)) throw new Error('Synthetic complaint event failure');
      return query(input, ...args);
    };
    try { await updateSample(client, identity, sample.id, { revision: sample.revision, complaintRetestIds: ids, complaintRemarks: 'Must roll back' }); }
    finally { client.query = query; }
  }), error => (error.cause ?? error).message === 'Synthetic complaint event failure');
  assert.deepEqual(await snapshot(sample), before);
  await select(sample, ids); const saved = await snapshot(sample);
  await assert.rejects(select(sample, ids), { code: 'sample_changed' }); assert.deepEqual(await snapshot(sample), saved);
});

test('non-complaint commands ignore the locked complaint selection property', async () => {
  for (const sampleType of ['internal', 'amendment', 'quality_control']) {
    const { sample } = await setup({ sampleType, headers: sampleType === 'quality_control' ? { iqcType: 'retest' } : {} });
    const before = await snapshot(sample); await select(sample, { invalid: true }); assert.deepEqual(await snapshot(sample), before);
  }
});

test('explicit unselected test IDs fail before numbering, while automatic complaint generation uses selected rows only', async () => {
  const { sample } = await setup(); const before = await snapshot(sample);
  await assert.rejects(work((client, identity) => generateTestRequests(client, identity, sample.id, { sampleTestIds: [testsOf(sample)[1].id] })), { code: 'sample_test_not_available' });
  assert.deepEqual(await snapshot(sample), before);
  const { sample: automatic, created } = await setup({ fixtureOptions: { generateTestRequests: true } });
  assert.equal(created.testRequests.length, 1); assert(testsOf(automatic)[0].requestId); assert.equal(testsOf(automatic)[1].requestId, null);
});

test('complaint selection and generation serialize without deleting a requested test', async () => {
  const { sample } = await setup({ flags: [true, true] }); const id = testsOf(sample)[0].id;
  const [selection, generation] = await Promise.allSettled([select(sample, [id]), work((client, identity) => generateTestRequests(client, identity, sample.id, {}))]);
  assert.equal(generation.status, 'fulfilled'); const saved = await read(sample);
  if (selection.status === 'fulfilled') { assert.equal(generation.value.items.length, 1); assert.equal(testsOf(saved).length, 1); }
  else { assert.equal(selection.reason.code, 'sample_lines_changed'); assert.equal(generation.value.items.length, 2); assert.equal(testsOf(saved).length, 2); }
  assert(testsOf(saved).every(row => row.requestId && row.isRetest));
});
