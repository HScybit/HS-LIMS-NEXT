import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, database } from '../../src/db/pool.js';
import { decisionRules } from '../../src/db/master-schema.js';
import { registerSample } from '../../src/samples/register.js';
import { updateSample } from '../../src/samples/update.js';
import { loadSample } from '../../src/samples/load.js';

const owner = ownerPool(); let manager;
const work = action => withSession(manager.token, action, { csrfToken: manager.csrfToken });
before(async () => {
  manager = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read'] });
  Object.assign(manager, await signIn({ identifier: manager.username, password: manager.password }));
});
after(async () => { await closePool(); await owner.end(); });
const read = sample => work((client, identity) => loadSample(client, identity, sample.id));
const productKeys = ['id', 'productId', 'sampleCategoryId', 'quantity', 'customerReference', 'description', 'sampleSize', 'quality', 'identificationMark', 'measurementUnitId', 'tagId', 'tag'];
const testKeys = ['id', 'testParameterId', 'methodId', 'decisionRuleId', 'requestedQuantity', 'requestedSize', 'rate', 'currencyCode', 'estimatedDurationMinutes', 'isAccredited', 'isRetest', 'isSubcontracted'];
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
const productsInput = sample => sample.products.map(line => ({ ...pick(line, productKeys), condition: line.receivedCondition, tests: line.tests.map(row => pick(row, testKeys)) }));
const edit = (sample, products, extra = {}) => work((client, identity) => updateSample(client, identity, sample.id, { revision: sample.revision, products, ...extra }));
const exactDates = async sample => (await owner.query('SELECT received_at::text AS received,due_at::text AS due,retention_due_on::text AS retention FROM samples WHERE organization_id=$1 AND id=$2', [manager.organizationId, sample.id])).rows[0];
async function setup({ days = '3', count = 1, ...headers } = {}) {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  await owner.query('UPDATE decision_rules SET estimated_time_in_days=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.rule.id, days]);
  const registration = { ...fixture.registration,
    receivedAt: '2024-02-28T10:30:00.123456Z', dueAt: '2024-03-20T18:00:00.654321Z',
    products: Array.from({ length: count }, () => structuredClone(fixture.registration.products[0])), ...headers };
  const created = await work((client, identity) => registerSample(client, identity, registration));
  const opened = await read(created);
  // Registration currently rounds through Date; establish exact saved instants
  // through the existing header service before exercising line-edit preservation.
  await work((client, identity) => updateSample(client, identity, created.id, { revision: opened.revision,
    receivedAt: registration.receivedAt, dueAt: registration.dueAt }));
  return { fixture, sample: await read(created) };
}
const newLine = fixture => ({ ...structuredClone(fixture.registration.products[0]), sampleCategoryId: fixture.category.id,
  tests: fixture.registration.products[0].tests.map(row => ({ ...row, decisionRuleId: null })) });
async function addLine(sample, fixture, extra = {}) {
  await edit(sample, [...productsInput(sample), newLine(fixture)], extra); return read(sample);
}
async function addRule(fixture, values = {}) {
  const [rule] = await database(owner).insert(decisionRules).values({ organizationId: manager.organizationId, code: randomUUID(), name: 'Synthetic reporting estimate',
    productId: fixture.product.id, testParameterId: fixture.parameter.id, methodId: fixture.method.id, estimatedTimeInDays: '11', ...values }).returning();
  return rule;
}

test('changed test rows recalculate from the received date, never the registration date', async () => {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  await owner.query('UPDATE decision_rules SET estimated_time_in_days=3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.rule.id]);
  const created = await work((client, identity) => registerSample(client, identity, { ...fixture.registration,
    receivedAt: '2024-02-28T10:30:00.123456Z', dueAt: '2024-03-20T18:00:00.654321Z' }));
  const sample = await read(created);
  const products = [{ ...fixture.registration.products[0], id: sample.products[0].id,
    tests: [{ ...fixture.registration.products[0].tests[0], id: sample.products[0].tests[0].id }] }, structuredClone(fixture.registration.products[0])];
  await work((client, identity) => updateSample(client, identity, sample.id, { revision: sample.revision, products }));
  const saved = await read(sample);
  assert.equal(saved.dueAt.toISOString(), '2024-03-02T00:00:00.000Z');
  assert.equal(saved.registeredAt.getTime(), sample.registeredAt.getTime());
  assert.equal(saved.products[0].tests[0].id, sample.products[0].tests[0].id);
});

test('reorders, metadata changes, retained-ID parameter changes and identical-content replacements preserve the exact due instant', async () => {
  const { sample } = await setup({ count: 2 }); let saved = sample;
  const before = await exactDates(sample);
  await edit(saved, productsInput(saved).toReversed()); saved = await read(saved);
  let products = productsInput(saved); products[0].tests[0].rate = '123'; products[0].tests[0].estimatedDurationMinutes = 4800;
  await edit(saved, products); saved = await read(saved);
  products = productsInput(saved); products[0].tests[0].id = null;
  await edit(saved, products); saved = await read(saved);
  const other = await createLaboratoryFixture(owner, manager, { repeated: false });
  products = productsInput(saved); Object.assign(products[0].tests[0], { testParameterId: other.parameter.id, methodId: other.method.id, decisionRuleId: null });
  await edit(saved, products);
  assert.deepEqual(await exactDates(sample), before);
});

test('removing a line recalculates and the saved due instant survives when its calendar day already matches', async () => {
  const { sample } = await setup({ count: 2, dueAt: '2024-03-02T18:00:00.654321Z' });
  const before = await exactDates(sample);
  await edit(sample, productsInput(sample).slice(0, 1));
  assert.deepEqual(await exactDates(sample), before);
  const second = await setup({ count: 2 });
  await edit(second.sample, productsInput(second.sample).slice(0, 1));
  assert.equal((await read(second.sample)).dueAt.toISOString(), '2024-03-02T00:00:00.000Z');
});

test('automatic dates use a changed receiving date and override the submitted due date', async () => {
  const { fixture, sample } = await setup();
  const saved = await addLine(sample, fixture, { receivedAt: '2024-03-25T23:59:59.123456Z', dueAt: '2025-01-01T00:00:00Z' });
  assert.equal(saved.dueAt.toISOString(), '2024-03-28T00:00:00.000Z');
  assert.equal((await exactDates(saved)).received, '2024-03-25 23:59:59.123456+00');
  assert.equal(saved.registeredAt.getTime(), sample.registeredAt.getTime());
  const next = await addLine(saved, fixture, { receivedAt: '2024-04-01T23:59:59.123456Z' });
  assert.equal(next.dueAt.toISOString(), '2024-04-04T00:00:00.000Z');
});

test('positive fractions landing on the receipt day preserve receipt microseconds', async () => {
  const { fixture, sample } = await setup({ days: '0.5' });
  const saved = await addLine(sample, fixture);
  const dates = await exactDates(saved); assert.equal(dates.due, dates.received);
  assert.equal(dates.received, '2024-02-28 10:30:00.123456+00');
});

test('reporting dates follow the PostgreSQL receiving day when input precision rounds across midnight', async () => {
  const { fixture, sample } = await setup();
  const saved = await addLine(sample, fixture, { receivedAt: '2024-02-28T23:59:59.9999999Z' });
  assert.equal((await exactDates(saved)).received, '2024-02-29 00:00:00+00');
  assert.equal(saved.dueAt.toISOString(), '2024-03-03T00:00:00.000Z');
  await assert.rejects(addLine(saved, fixture, { receivedAt: '2024-03-01T00:00:00+23:00' }), { code: 'invalid_sample' });
  assert.deepEqual(await read(saved), saved);
});

test('rule selection prefers active then newest valid estimates and falls through zero to inactive rules', async () => {
  const { fixture, sample } = await setup();
  const alternative = await addRule(fixture, { active: false, updatedAt: new Date('2090-01-01') });
  let saved = await addLine(sample, fixture);
  assert.equal(saved.dueAt.toISOString(), '2024-03-02T00:00:00.000Z');
  await owner.query('UPDATE decision_rules SET estimated_time_in_days=0,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.rule.id]);
  saved = await addLine(saved, fixture); assert.equal(saved.dueAt.toISOString(), '2024-03-10T00:00:00.000Z');
  await owner.query('UPDATE decision_rules SET estimated_time_in_days=3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.rule.id]);
  await owner.query('UPDATE decision_rules SET active=true,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, alternative.id]);
  saved = await addLine(saved, fixture); assert.equal(saved.dueAt.toISOString(), '2024-03-10T00:00:00.000Z');
});

test('nonfinite JavaScript estimates and underflow do not mask a later valid rule or use row fallback', async () => {
  const { fixture, sample } = await setup({ days: '1e1000' });
  await addRule(fixture, { active: false, estimatedTimeInDays: '4' });
  let saved = await addLine(sample, fixture); assert.equal(saved.dueAt.toISOString(), '2024-03-03T00:00:00.000Z');
  await owner.query('UPDATE decision_rules SET estimated_time_in_days=1e-1000,revision=revision+1 WHERE organization_id=$1 AND product_id=$2', [manager.organizationId, fixture.product.id]);
  const products = [...productsInput(saved), newLine(fixture)]; for (const line of products) for (const row of line.tests) row.estimatedDurationMinutes = 4800;
  await edit(saved, products); saved = await read(saved);
  assert.equal(saved.dueAt.toISOString(), '2024-03-01T00:00:00.000Z');
});

test('methodless rules are excluded and saved row durations supply estimates only when the server query has no rules', async () => {
  const { fixture, sample } = await setup();
  await owner.query('UPDATE decision_rules SET method_id=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.rule.id]);
  const products = [...productsInput(sample), newLine(fixture)]; products[0].tests[0].estimatedDurationMinutes = 4800;
  await edit(sample, products); assert.equal((await read(sample)).dueAt.toISOString(), '2024-03-09T00:00:00.000Z');
});

test('an unmatched cross-set rule suppresses row fallback and category fallback includes every selected line', async () => {
  const { fixture, sample } = await setup(); const other = await createLaboratoryFixture(owner, manager, { repeated: false });
  await owner.query('UPDATE decision_rules SET method_id=NULL,revision=revision+1 WHERE organization_id=$1 AND id=ANY($2::uuid[])', [manager.organizationId, [fixture.rule.id, other.rule.id]]);
  await owner.query('UPDATE sample_categories SET estimated_time_in_days=7,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, other.category.id]);
  await addRule(fixture, { testParameterId: other.parameter.id, methodId: other.method.id, estimatedTimeInDays: '5' });
  const products = [...productsInput(sample), newLine(other)]; products[0].tests[0].estimatedDurationMinutes = 4800;
  await edit(sample, products); assert.equal((await read(sample)).dueAt.toISOString(), '2024-03-06T00:00:00.000Z');
});

test('missing or unrepresentable calendar estimates retain the due date, including a saved null date', async () => {
  for (const dueAt of ['2024-03-20T18:00:00.654321Z', null]) for (const days of ['0', '1e300']) {
    const { fixture, sample } = await setup({ days, dueAt });
    await owner.query('UPDATE sample_categories SET estimated_time_in_days=0,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.category.id]);
    const before = await exactDates(sample); await addLine(sample, fixture); assert.deepEqual(await exactDates(sample), before);
  }
});

test('failed header validation rolls back calculated dates, new lines, revision and activity together', async () => {
  const { fixture, sample } = await setup(); const dates = await exactDates(sample);
  await assert.rejects(addLine(sample, fixture, { totalAmount: '10', currencyCode: null }), { code: 'invalid_sample' });
  assert.deepEqual(await read(sample), sample); assert.deepEqual(await exactDates(sample), dates);
  const saved = await addLine(sample, fixture);
  await assert.rejects(addLine(sample, fixture), { code: 'sample_changed' });
  assert.deepEqual(await read(sample), saved);
});
