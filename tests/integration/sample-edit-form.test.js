import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { loadSample } from '../../src/samples/load.js';
import { updateSample } from '../../src/samples/update.js';
import { sampleRegistrationOptions } from '../../src/samples/options.js';
import { sampleEditForm, sampleEditPayload } from '../../src/samples/edit-form.js';

const owner = ownerPool(); let manager; let reader; let foreign;
const work = (account, action) => withSession(account.token, action, { csrfToken: account.csrfToken });
async function account(options = {}) {
  const value = await createAccount(owner, { permissions: ['samples.read', 'samples.create', 'samples.manage'], ...options });
  return { ...value, ...await signIn({ identifier: value.username, password: value.password }) };
}
before(async () => {
  manager = await account(); reader = await account({ organizationId: manager.organizationId, permissions: ['samples.read'] }); foreign = await account();
});
after(async () => { await closePool(); await owner.end(); });
const load = (id, user = manager) => work(user, (client, identity) => loadSample(client, identity, id));

test('edit availability reflects actual management permission, workflow capability and tenant access', async () => {
  for (const [settings, allowed] of [[{}, true], [{ editRoleId: manager.roleId }, true], [{ editRoleId: reader.roleId }, false], [{ editRoleId: manager.roleId, showSampleEdit: false }, false]]) {
    const fixture = await createLaboratoryFixture(owner, manager, { repeated: false, ...settings });
    const sample = await work(manager, (client, identity) => registerSample(client, identity, fixture.registration));
    assert.equal((await load(sample.id)).canEdit, allowed); assert.equal((await load(sample.id, reader)).canEdit, false);
    await assert.rejects(load(sample.id, foreign), { status: 404 });
  }
});

test('the edit adapter preserves saved precision and nullable values in a real header and child save', async () => {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  const input = { ...fixture.registration, receivedAt: '2024-02-28T10:30:00.123456Z', dueAt: '2024-03-20T18:00:00.654321Z',
    totalAmount: null, currencyCode: null, receivedByName: null, products: [{ ...fixture.registration.products[0], quantity: '1.000000000000000001', description: null,
      tests: [{ ...fixture.registration.products[0].tests[0], requestedSize: null, rate: '0.000000000000000001', currencyCode: 'USD', estimatedDurationMinutes: 1 }] }] };
  const created = await work(manager, (client, identity) => registerSample(client, identity, input));
  let sample = await load(created.id); const options = await work(manager, sampleRegistrationOptions);
  const exact = async () => (await owner.query('SELECT received_at::text,due_at::text FROM samples WHERE organization_id=$1 AND id=$2', [manager.organizationId, sample.id])).rows[0];
  const beforeDates = await exact(); const beforeProducts = structuredClone(sample.products);
  let form = sampleEditForm(sample); form.customerAddress = 'Updated address';
  await work(manager, (client, identity) => updateSample(client, identity, sample.id, sampleEditPayload(form, sample, options)));
  sample = await load(created.id); assert.deepEqual(sample.products, beforeProducts); assert.deepEqual(await exact(), beforeDates);
  form = sampleEditForm(sample); form.products[0].description = 'Updated operational description';
  await work(manager, (client, identity) => updateSample(client, identity, sample.id, sampleEditPayload(form, sample, options)));
  const saved = await load(created.id); const line = saved.products[0]; const selected = line.tests[0];
  assert.equal(line.id, beforeProducts[0].id); assert.equal(line.quantity, '1.000000000000000001');
  assert.equal(selected.id, beforeProducts[0].tests[0].id); assert.equal(selected.rate, '0.000000000000000001');
  assert.equal(selected.currencyCode, 'USD'); assert.equal(selected.estimatedDurationMinutes, 1); assert.equal(selected.requestedSize, null);
  assert.equal(saved.totalAmount, null); assert.equal(saved.currencyCode, null); assert.equal(saved.receivedByName, null); assert.deepEqual(await exact(), beforeDates);
});

test('an edit retains inactive saved references without substituting current options or rewriting their labels', async () => {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  const created = await work(manager, (client, identity) => registerSample(client, identity, { ...fixture.registration, customerId: fixture.customer.id, customerAddress: 'Saved customer address' }));
  for (const [table, id] of [['products', fixture.product.id], ['sample_categories', fixture.category.id], ['test_parameters', fixture.parameter.id],
    ['methods_of_analysis', fixture.method.id], ['decision_rules', fixture.rule.id], ['customers', fixture.customer.id]]) {
    await owner.query(`UPDATE ${table} SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2`, [manager.organizationId, id]);
  }
  const sample = await load(created.id); const options = await work(manager, sampleRegistrationOptions); const form = sampleEditForm(sample);
  assert(!options.products.some(product => product.id === fixture.product.id)); assert(!options.customers.some(customer => customer.id === fixture.customer.id));
  form.products[0].description = 'Preserved inactive selections';
  await work(manager, (client, identity) => updateSample(client, identity, sample.id, sampleEditPayload(form, sample, options)));
  const saved = await load(created.id);
  assert.equal(saved.customerName, sample.customerName); assert.equal(saved.products[0].productName, sample.products[0].productName);
  assert.deepEqual(saved.products[0].tests, sample.products[0].tests);
});
