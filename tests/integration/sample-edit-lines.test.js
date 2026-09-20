import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { prepareSampleLineFlow } from '../helpers/sample-lines.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { updateSample } from '../../src/samples/update.js';
import { loadSample } from '../../src/samples/load.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { saveProduct } from '../../src/masters/products.js';

const owner = ownerPool(); let manager; let reader; let allocator; let foreign;
const permissions = ['samples.create', 'samples.manage', 'samples.read', 'test_requests.allocate', 'masters.manage', 'templates.manage', 'datasheets.execute', 'settings.manage'];
const work = (user, action) => withSession(user.token, action, { csrfToken: user.csrfToken });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions, ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
before(async () => {
  manager = await account(); reader = await account({ organizationId: manager.organizationId, permissions: ['samples.read'] });
  allocator = await account({ organizationId: manager.organizationId, permissions: ['test_requests.allocate'] }); foreign = await account();
});
after(async () => { await closePool(); await owner.end(); });

const productKeys = ['id', 'productId', 'sampleCategoryId', 'quantity', 'customerReference', 'description', 'sampleSize', 'quality', 'identificationMark', 'measurementUnitId', 'tagId', 'tag'];
const testKeys = ['id', 'testParameterId', 'methodId', 'decisionRuleId', 'requestedQuantity', 'requestedSize', 'rate', 'currencyCode', 'estimatedDurationMinutes', 'isAccredited', 'isRetest', 'isSubcontracted'];
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
const productsInput = sample => sample.products.map(line => ({ ...pick(line, productKeys), condition: line.receivedCondition, tests: line.tests.map(row => pick(row, testKeys)) }));
const read = (sample, user = manager) => work(user, (client, identity) => loadSample(client, identity, sample.id));
const edit = (sample, products, extra = {}, user = manager) => work(user, (client, identity) => updateSample(client, identity, sample.id, { revision: sample.revision, products, ...extra }));
const sqlError = code => error => (error.code ?? error.cause?.code) === code;
async function setup({ count = 1, sampleType = 'internal', ...options } = {}) {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false, ...options });
  const registration = { ...fixture.registration, sampleType, products: Array.from({ length: count }, () => structuredClone(fixture.registration.products[0])) };
  if (sampleType === 'quality_control') registration.iqcType = 'retest';
  if (sampleType === 'complaint') for (const line of registration.products) for (const selected of line.tests) selected.isRetest = true;
  const created = await work(manager, (client, identity) => registerSample(client, identity, registration));
  return { fixture, sample: await read(created) };
}
async function snapshot(sample) {
  const records = {};
  for (const [name, query] of [
    ['sample', 'SELECT * FROM samples WHERE organization_id=$1 AND id=$2'],
    ['products', 'SELECT * FROM sample_products WHERE organization_id=$1 AND sample_id=$2'],
    ['tests', 'SELECT chosen.* FROM sample_tests chosen JOIN sample_products line ON line.organization_id=chosen.organization_id AND line.id=chosen.sample_product_id WHERE line.organization_id=$1 AND line.sample_id=$2'],
    ['events', 'SELECT * FROM sample_events WHERE organization_id=$1 AND sample_id=$2'],
  ]) records[name] = (await owner.query(query, [manager.organizationId, sample.id])).rows.map(row => JSON.stringify(row)).sort();
  return records;
}

test('ordinary line saving preserves stable IDs, exact values, captured labels and one actor event', async () => {
  const { sample } = await setup(); const products = productsInput(sample);
  products[0].quantity = '2.00000000000000001'; products[0].description = ''; products[0].quality = null;
  products[0].tests[0].requestedSize = '25 ml'; products[0].tests[0].rate = '0';
  const result = await edit(sample, products, { description: 'Revised header' }); assert.equal(result.revision, 2);
  const saved = await read(sample);
  assert.equal(saved.products[0].id, sample.products[0].id); assert.equal(saved.products[0].tests[0].id, sample.products[0].tests[0].id);
  assert.equal(saved.products[0].productRevision, sample.products[0].productRevision); assert.equal(saved.products[0].quantity, products[0].quantity);
  assert.equal(saved.products[0].description, ''); assert.equal(saved.products[0].quality, null);
  assert.equal(saved.products[0].tests[0].requestedSize, '25 ml'); assert.equal(saved.products[0].tests[0].decisionRuleId, sample.products[0].tests[0].decisionRuleId);
  assert.equal(saved.description, 'Revised header'); assert.equal(saved.sampleNumber, sample.sampleNumber); assert.equal(saved.registeredAt.getTime(), sample.registeredAt.getTime());
  assert.equal(saved.activity.filter(event => event.eventType === 'sample_updated').length, 1);
  assert.equal(saved.activity.find(event => event.eventType === 'sample_updated').actorUserId, manager.userId);
});

test('duplicate Product lines reorder, add and remove without moving or regenerating retained test identities', async () => {
  const { fixture, sample } = await setup({ count: 2 }); const originalIds = sample.products.map(line => line.id);
  await owner.query('UPDATE sample_products SET display_order=2147483647 WHERE organization_id=$1 AND id=$2', [manager.organizationId, originalIds[0]]);
  const products = productsInput(sample).reverse();
  products.push({ ...structuredClone(fixture.registration.products[0]), sampleCategoryId: fixture.category.id });
  await edit(sample, products); let saved = await read(sample);
  assert.deepEqual(saved.products.slice(0, 2).map(line => line.id), originalIds.toReversed());
  assert.deepEqual(saved.products.map(line => line.displayOrder), [0, 1, 2]);
  assert.deepEqual(saved.products.slice(0, 2).map(line => line.tests[0].id), sample.products.toReversed().map(line => line.tests[0].id));
  const freshId = saved.products[2].id; assert(!originalIds.includes(freshId));
  await edit(saved, productsInput(saved).slice(1)); saved = await read(sample);
  assert.deepEqual(saved.products.map(line => line.id), [originalIds[0], freshId]);
  assert.equal((await owner.query('SELECT 1 FROM sample_products WHERE organization_id=$1 AND id=$2', [manager.organizationId, originalIds[1]])).rowCount, 0);
});

test('an unused line may change Product/category and planned test identity while keeping typed line and test IDs', async () => {
  const { sample } = await setup(); const other = await createLaboratoryFixture(owner, manager, { repeated: false });
  await work(manager, (client, identity) => saveProduct(client, identity, { id: other.product.id, revision: 1, requestId: randomUUID(),
    key: other.product.code, name: other.product.name, description: 'Current Product capture', abbreviation: '0' }));
  const products = productsInput(sample); const lineId = products[0].id; const testId = products[0].tests[0].id;
  Object.assign(products[0], { productId: other.product.id, sampleCategoryId: other.category.id, measurementUnitId: other.unit.id });
  Object.assign(products[0].tests[0], { testParameterId: other.parameter.id, methodId: other.method.id, decisionRuleId: other.rule.id });
  const before = await owner.query('SELECT received_at::text AS received,retention_due_on::text AS retention FROM samples WHERE organization_id=$1 AND id=$2', [manager.organizationId, sample.id]);
  await edit(sample, products, { sampleCategoryId: other.category.id }); const saved = await read(sample);
  assert.equal(saved.products[0].id, lineId); assert.equal(saved.products[0].tests[0].id, testId);
  assert.equal(saved.products[0].productId, other.product.id); assert.equal(saved.products[0].productName, other.product.name);
  assert.equal(saved.products[0].productRevision, 2);
  assert.equal(saved.products[0].sampleCategoryId, other.category.id); assert.equal(saved.products[0].unitCode, other.unit.code);
  assert.equal(saved.sampleCategoryId, other.category.id); assert.equal(saved.templateInstanceId, sample.templateInstanceId);
  assert.equal(saved.workflowRunId, sample.workflowRunId);
  assert.deepEqual((await owner.query('SELECT received_at::text AS received,retention_due_on::text AS retention FROM samples WHERE organization_id=$1 AND id=$2', [manager.organizationId, sample.id])).rows, before.rows);
});

test('foreign, duplicate, cross-line and newly invalid references fail without partial headers or line changes', async () => {
  const { sample } = await setup({ count: 2 }); const before = await snapshot(sample);
  for (const change of [
    products => { products[0].id = randomUUID(); }, products => { products[0].tests[0].id = randomUUID(); },
    products => { products[0].tests[0].id = products[1].tests[0].id; products[1].tests[0].id = null; },
    products => { products[1].id = products[0].id.toUpperCase(); }, products => { products[0].productId = randomUUID(); },
    products => { products[0].tests[0].decisionRuleId = randomUUID(); },
  ]) {
    const products = productsInput(sample); change(products);
    await assert.rejects(edit(sample, products, { description: 'Must roll back' }), error => [400, 422].includes(error.status));
    assert.deepEqual(await snapshot(sample), before);
  }
  await assert.rejects(edit(sample, productsInput(sample), {}, reader), { code: 'forbidden' });
  await assert.rejects(edit(sample, productsInput(sample), {}, allocator), { code: 'forbidden' });
  await assert.rejects(edit(sample, productsInput(sample), {}, foreign), { code: 'sample_not_found' });
  assert.deepEqual(await snapshot(sample), before);
});

test('unchanged inactive references retain captured labels but cannot be selected on a new line', async () => {
  const { fixture, sample } = await setup();
  for (const [table, id] of [['products', fixture.product.id], ['sample_categories', fixture.category.id], ['measurement_units', fixture.unit.id],
    ['test_parameters', fixture.parameter.id], ['methods_of_analysis', fixture.method.id], ['decision_rules', fixture.rule.id]]) {
    await owner.query(`UPDATE ${table} SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2`, [manager.organizationId, id]);
  }
  await edit(sample, productsInput(sample)); const saved = await read(sample);
  assert.equal(saved.products[0].productName, sample.products[0].productName); assert.equal(saved.products[0].unitCode, sample.products[0].unitCode);
  const products = productsInput(saved); products.push({ ...structuredClone(products[0]), id: null, tests: products[0].tests.map(test => ({ ...test, id: null })) });
  const before = await snapshot(saved); await assert.rejects(edit(saved, products), { code: 'invalid_sample_reference' });
  assert.deepEqual(await snapshot(saved), before);
});

test('requested tests retain scientific identity while operational metadata changes preserve the frozen specification', async () => {
  const { sample } = await setup({ count: 2 });
  await work(manager, (client, identity) => generateTestRequests(client, identity, sample.id, {}));
  const opened = await read(sample); const products = productsInput(opened);
  const specification = (await owner.query('SELECT * FROM analytical_specifications WHERE organization_id=$1 ORDER BY id', [manager.organizationId])).rows;
  products.reverse(); products[0].tests[0].requestedSize = '50 ml'; products[0].tests[0].rate = '42.00001'; products[0].tests[0].estimatedDurationMinutes = 0;
  products[0].tests[0].isAccredited = true; products[0].tests[0].isSubcontracted = true;
  await edit(opened, products); const saved = await read(sample);
  assert.equal(saved.products[0].tests[0].requestId, opened.products[1].tests[0].requestId);
  assert.equal(saved.products[0].tests[0].requestedSize, '50 ml'); assert.equal(saved.products[0].tests[0].rate, '42.00001');
  assert.deepEqual((await owner.query('SELECT * FROM analytical_specifications WHERE organization_id=$1 ORDER BY id', [manager.organizationId])).rows, specification);
  const before = await snapshot(saved);
  for (const change of [input => { input.pop(); }, input => { input[0].tests[0].isRetest = true; }, input => { input[0].tests[0].id = null; },
    input => { input[0].productId = randomUUID(); }, input => { input[0].sampleCategoryId = randomUUID(); }]) {
    const input = productsInput(saved); change(input); await assert.rejects(edit(saved, input), { code: 'sample_lines_changed' });
    assert.deepEqual(await snapshot(saved), before);
  }
});

test('special sample whitelists ignore ordinary product payloads before parsing', async () => {
  for (const sampleType of ['quality_control', 'amendment', 'complaint']) {
    const { sample } = await setup({ sampleType }); const before = await snapshot(sample);
    const unchanged = await edit(sample, { invalid: true }, { sampleCategoryId: 'invalid locked category' });
    assert.equal(unchanged.revision, sample.revision); assert.deepEqual(await snapshot(sample), before);
    await edit(sample, null, { customerAddress: 'Revised address' });
    const saved = await read(sample); assert.equal(saved.customerAddress, 'Revised address'); assert.deepEqual(saved.products, sample.products);
  }
});

test('line saving serializes revisions and rolls back the complete edit when its actor event fails', async () => {
  const { sample } = await setup(); const products = productsInput(sample);
  const results = await Promise.allSettled([edit(sample, products, { description: 'One' }), edit(sample, products, { description: 'Two' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'sample_changed');
  const saved = await read(sample); const before = await snapshot(saved);
  await assert.rejects(work(manager, async (client, identity) => {
    const query = client.query.bind(client);
    client.query = (input, ...args) => {
      const text = typeof input === 'string' ? input : input.text;
      if (/insert into "sample_events"/i.test(text)) throw new Error('Synthetic actor event failure');
      return query(input, ...args);
    };
    try { await updateSample(client, identity, saved.id, { revision: saved.revision, products: productsInput(saved), description: 'Must roll back' }); }
    finally { client.query = query; }
  }), error => (error.cause ?? error).message === 'Synthetic actor event failure');
  assert.deepEqual(await snapshot(saved), before);
});

test('direct SQL deletion requires sample management and preserves requested identities', async () => {
  const { sample } = await setup(); const selected = sample.products[0].tests[0];
  await assert.rejects(work(allocator, client => client.query('DELETE FROM sample_tests WHERE organization_id=$1 AND id=$2', [manager.organizationId, selected.id])), sqlError('42501'));
  await work(manager, (client, identity) => generateTestRequests(client, identity, sample.id, {}));
  const before = await snapshot(sample);
  for (const user of [manager, allocator]) {
    await assert.rejects(work(user, client => client.query('DELETE FROM sample_tests WHERE organization_id=$1 AND id=$2', [manager.organizationId, selected.id])), sqlError(user === manager ? '55000' : '42501'));
  }
  await assert.rejects(work(manager, client => client.query('DELETE FROM sample_products WHERE organization_id=$1 AND id=$2', [manager.organizationId, sample.products[0].id])), sqlError('55000'));
  await assert.rejects(work(manager, client => client.query('UPDATE sample_tests SET is_retest=true WHERE organization_id=$1 AND id=$2', [manager.organizationId, selected.id])), sqlError('55000'));
  assert.deepEqual(await snapshot(sample), before);
});

test('direct SQL Product reassignment checks the final test association and leaves captured history immutable', async () => {
  const { sample } = await setup(); const other = await createLaboratoryFixture(owner, manager, { repeated: false });
  const before = await snapshot(sample);
  await assert.rejects(work(manager, client => client.query(`UPDATE sample_products SET product_id=$3,product_code=$4,product_name=$5,product_revision=NULL,
    sample_category_id=$6,category_code=$7,category_name=$8 WHERE organization_id=$1 AND id=$2`,
  [manager.organizationId, sample.products[0].id, other.product.id, other.product.code, other.product.name, other.category.id, other.category.code, other.category.name])),
  error => error.constraint === 'sample_product_test_context');
  assert.deepEqual(await snapshot(sample), before);
  await assert.rejects(work(manager, client => client.query('UPDATE sample_products SET product_name=$3 WHERE organization_id=$1 AND id=$2',
    [manager.organizationId, sample.products[0].id, 'Forged history'])), sqlError('55000'));
  await assert.rejects(work(manager, client => client.query('SELECT laboratory_sample_line_in_use($1,$2,$3)',
    [manager.organizationId, sample.id, sample.products[0].id])), sqlError('42501'));
  assert.deepEqual(await snapshot(sample), before);
});

test('a report protects an otherwise unrequested fallback line and operational edits preserve all frozen output', async () => {
  const user = await account();
  // An explicit print role permits a report of the selected approved results.
  // The permission fallback intentionally requires every sample test approved.
  const flow = await prepareSampleLineFlow(owner, user, { secondLine: false, printRoleId: user.roleId });
  let sample = await read(flow.sample, user); const products = productsInput(sample);
  products.unshift({ ...structuredClone(products[0]), id: null, description: 'Unrequested report fallback',
    tests: products[0].tests.map(selected => ({ ...selected, id: null })) });
  await edit(sample, products, {}, user); sample = await read(sample, user);
  const fallback = sample.products[0]; assert.equal(fallback.tests[0].requestId, null);
  const generated = await work(user, (client, identity) => generateReports(client, identity, sample.id, { ...flow.input, revision: sample.revision }));
  const reportId = generated.items[0].id;
  assert.equal((await owner.query('SELECT product_context_line_id FROM sample_reports WHERE organization_id=$1 AND id=$2', [user.organizationId, reportId])).rows[0].product_context_line_id, fallback.id);
  const history = async () => Object.fromEntries(await Promise.all(['test_requests', 'analytical_specifications', 'datasheets', 'datasheet_submissions', 'sample_line_contexts', 'sample_reports', 'sample_report_tests', 'workflow_runs']
    .map(async table => [table, (await owner.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [user.organizationId])).rows.map(row => JSON.stringify(row)).sort()])));
  const before = await history(); const { metrics: _metrics, ...report } = await work(user, (client, identity) => loadReport(client, identity, reportId));
  sample = await read(sample, user);
  for (const change of [input => { input.shift(); }, input => { input[0].productId = randomUUID(); }, input => { input[0].sampleCategoryId = randomUUID(); }]) {
    const input = productsInput(sample); change(input); await assert.rejects(edit(sample, input, {}, user), { code: 'sample_lines_changed' });
  }
  await assert.rejects(work(user, client => client.query('DELETE FROM sample_products WHERE organization_id=$1 AND id=$2', [user.organizationId, fallback.id])), sqlError('55000'));
  const input = productsInput(sample).reverse();
  for (const line of input) { line.description = 'Current operational description'; line.tests[0].requestedSize = 'Current size'; line.tests[0].isAccredited = true; }
  await edit(sample, input, { customerReference: 'Current reference' }, user);
  assert.deepEqual(await history(), before);
  const { metrics: _afterMetrics, ...after } = await work(user, (client, identity) => loadReport(client, identity, reportId));
  assert.deepEqual(after, report);
});

test('request generation and line editing serialize on the sample before interpreting test identity', async () => {
  const { sample } = await setup();
  let release; const gate = new Promise(resolve => { release = resolve; });
  let generated; const ready = new Promise(resolve => { generated = resolve; });
  const generation = work(manager, async (client, identity) => {
    const result = await generateTestRequests(client, identity, sample.id, {}); generated(); await gate; return result;
  });
  await ready;
  const products = productsInput(sample); products[0].tests[0].id = null;
  const editing = assert.rejects(edit(sample, products), { code: 'sample_lines_changed' }); release();
  const result = await generation; assert.equal(result.items.length, 1);
  await editing;
  const saved = await read(sample); assert.equal(saved.products[0].tests[0].id, sample.products[0].tests[0].id);
  assert.equal(saved.products[0].tests[0].requestId, result.items[0].id); assert.equal(saved.revision, sample.revision);
});

test('planned identity swaps and requested test reorders preserve both test IDs and final unique positions', async () => {
  const { sample } = await setup(); const products = productsInput(sample);
  products[0].tests.push({ ...products[0].tests[0], id: null, isRetest: true });
  await edit(sample, products); let saved = await read(sample); const ids = saved.products[0].tests.map(selected => selected.id);
  const swapped = productsInput(saved);
  for (const selected of swapped[0].tests) selected.isRetest = !selected.isRetest;
  await edit(saved, swapped); saved = await read(sample);
  assert.deepEqual(saved.products[0].tests.map(selected => selected.id), ids);
  assert.deepEqual(saved.products[0].tests.map(selected => selected.isRetest), [true, false]);
  await work(manager, (client, identity) => generateTestRequests(client, identity, sample.id, {}));
  saved = await read(sample); const reordered = productsInput(saved); reordered[0].tests.reverse();
  const requests = saved.products[0].tests.map(selected => selected.requestId).reverse();
  await edit(saved, reordered); saved = await read(sample);
  assert.deepEqual(saved.products[0].tests.map(selected => selected.id), ids.toReversed());
  assert.deepEqual(saved.products[0].tests.map(selected => selected.requestId), requests);
});
