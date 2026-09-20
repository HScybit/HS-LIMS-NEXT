import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { grantSyntheticCustomerAccess } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, database } from '../../src/db/pool.js';
import { tags, productTags, customerAddresses, customerQuotations } from '../../src/db/master-schema.js';
import { sampleRegistrationOptions } from '../../src/samples/options.js';
import { quickCreateCustomer } from '../../src/samples/customer.js';
import { registerSample } from '../../src/samples/register.js';
import { loadSample } from '../../src/samples/load.js';
import { listSamples } from '../../src/samples/listing.js';
import { sampleTestRequests, allocationOptions } from '../../src/test-requests/listing.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';

const owner = ownerPool();
let registrar; let reader; let foreign; let operator; let fixture;
before(async () => {
  registrar = await createAccount(owner, { permissions: ['samples.create'] });
  reader = await createAccount(owner, { organizationId: registrar.organizationId, permissions: ['samples.read'] });
  foreign = await createAccount(owner, { permissions: ['samples.create'] });
  operator = await createAccount(owner, { organizationId: registrar.organizationId, permissions: ['samples.read', 'test_requests.allocate', 'datasheets.execute'] });
  for (const account of [registrar, reader, foreign, operator]) Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
  fixture = await createLaboratoryFixture(owner, registrar);
  await grantSyntheticCustomerAccess(owner, registrar);
});
after(async () => { await closePool(); await owner.end(); });
const work = (account, action) => withSession(account.token, action, { csrfToken: account.csrfToken });
const input = () => ({ name: `Synthetic ${randomUUID()}`, legalName: 'Synthetic legal name', contactPersonName: 'Synthetic contact',
  contactPersonEmail: 'synthetic@example.invalid', contactPersonPhone: '00000000', billToAddress: 'First line\nSecond line', shipToAddress: 'Receiving department\nSecond site' });

test('batched options return active tenant references, structured/freeform addresses, approved quotations and stable relationships', async () => {
  const db = database(owner); const organizationId = registrar.organizationId;
  const [tag] = await db.insert(tags).values({ organizationId, code: randomUUID(), name: 'Synthetic product tag' }).returning();
  await db.insert(productTags).values({ organizationId, productId: fixture.product.id, tagId: tag.id });
  await db.insert(customerAddresses).values([
    { organizationId, customerId: fixture.customer.id, addressType: 'billing', line1: 'Building 1', city: 'Synthetic city', countryCode: 'IN', isDefault: true },
    { organizationId, customerId: fixture.customer.id, addressType: 'shipping', freeformAddress: 'Unstructured\nReceiving bay' },
  ]);
  await db.insert(customerQuotations).values(['approved', 'draft', 'expired'].map((status) => ({ organizationId, customerId: fixture.customer.id,
    quotationNumber: randomUUID(), quotationDate: '2026-01-01', status, totalAmount: '0' })));
  const actualQueries = [];
  const options = await work(registrar, async (client, identity) => {
    const original = client.query.bind(client);
    client.query = (...args) => { actualQueries.push(typeof args[0] === 'string' ? args[0] : args[0].text); return original(...args); };
    try { return await sampleRegistrationOptions(client, identity); } finally { client.query = original; }
  });
  assert.equal(actualQueries.length, 11);
  assert.deepEqual(options.products[0].tagIds, [tag.id]);
  assert.deepEqual(options.products[0].sampleCategoryIds, [fixture.category.id]);
  assert.equal(options.testParameters[0].methods[0].id, fixture.method.id);
  assert.equal(options.customers[0].addresses[0].text, 'Building 1, Synthetic city, IN');
  assert.equal(options.customers[0].addresses[1].text, 'Unstructured\nReceiving bay');
  assert.equal(options.customers[0].quotations.length, 1);
  assert.equal(options.customers[0].quotations[0].totalAmount, '0');
  assert.equal((await work(reader, sampleRegistrationOptions)).products.length, 1);
  assert.equal((await work(foreign, sampleRegistrationOptions)).products.length, 0);
  await owner.query('UPDATE tags SET active=false, revision=revision+1 WHERE organization_id=$1 AND id=$2', [organizationId, tag.id]);
  assert.equal((await work(registrar, sampleRegistrationOptions)).tags.length, 0);
});

test('quick customer creation is atomic and scoped without conferring general master writes', async () => {
  const details = input(); const customer = await work(registrar, (client, identity) => quickCreateCustomer(client, identity, details));
  assert.equal(customer.name, details.name);
  assert.equal(customer.addresses[0].text, details.billToAddress);
  const stored = (await owner.query('SELECT * FROM customer_addresses WHERE organization_id=$1 AND customer_id=$2', [registrar.organizationId, customer.id])).rows;
  assert.equal(stored.length, 2);
  assert.ok(stored.every((row) => row.line_1 === null && row.city === null && row.country_code === null));
  assert.equal((await owner.query('SELECT * FROM customer_contacts WHERE organization_id=$1 AND customer_id=$2', [registrar.organizationId, customer.id])).rows[0].email, details.contactPersonEmail);
  await assert.rejects(work(registrar, (client, identity) => quickCreateCustomer(client, identity, details)), { code: 'customer_exists' });
  await assert.rejects(work(reader, (client, identity) => quickCreateCustomer(client, identity, input())), { status: 403 });
  await assert.rejects(work(reader, (client) => client.query('SELECT laboratory_quick_customer($1,$2,$3,$4,$5,$6,$7)', Object.values(input()))), { code: '42501' });
  await assert.rejects(work(registrar, (client) => client.query('SELECT laboratory_quick_customer($1,$2,$3,$4,$5,$6,$7)', [null, ...Object.values(input()).slice(1)])), { code: '23514' });
  await assert.rejects(work(registrar, (client) => client.query("INSERT INTO customers(organization_id, code, name, legal_name) VALUES($1,$2,'Arbitrary','Arbitrary')", [registrar.organizationId, randomUUID()])), { code: '42501' });
  const beforeDeniedUpdate = (await owner.query('SELECT name,revision FROM customers WHERE organization_id=$1 AND id=$2', [registrar.organizationId, customer.id])).rows[0];
  await assert.rejects(work(registrar, (client) => client.query('UPDATE customers SET name=$3, revision=revision+1 WHERE organization_id=$1 AND id=$2', [registrar.organizationId, customer.id, 'Denied'])),
    { code: '42501' });
  assert.deepEqual((await owner.query('SELECT name,revision FROM customers WHERE organization_id=$1 AND id=$2', [registrar.organizationId, customer.id])).rows[0], beforeDeniedUpdate);
  assert.equal((await work(foreign, sampleRegistrationOptions)).customers.length, 0);
  await assert.rejects(owner.query("UPDATE customer_addresses SET city='Invented' WHERE organization_id=$1 AND customer_id=$2", [registrar.organizationId, customer.id]), { code: '23514' });
});

test('selected product tags are tenant-checked and snapshot their name, while freeform PERN tags remain supported', async () => {
  const db = database(owner); const organizationId = registrar.organizationId;
  const [tag] = await db.insert(tags).values({ organizationId, code: randomUUID(), name: 'Original tag' }).returning();
  const registration = structuredClone(fixture.registration); registration.products[0].tagId = tag.id;
  await assert.rejects(work(registrar, (client, identity) => registerSample(client, identity, registration)), { code: 'invalid_sample_reference' });
  await db.insert(productTags).values({ organizationId, productId: fixture.product.id, tagId: tag.id });
  const sample = await work(registrar, (client, identity) => registerSample(client, identity, registration));
  await owner.query('UPDATE tags SET name=$3, revision=revision+1 WHERE organization_id=$1 AND id=$2', [organizationId, tag.id, 'Later tag']);
  const stored = (await owner.query('SELECT tag_id, tag FROM sample_products WHERE organization_id=$1 AND sample_id=$2', [organizationId, sample.id])).rows[0];
  assert.deepEqual(stored, { tag_id: tag.id, tag: 'Original tag' });
  registration.products[0].tagId = randomUUID();
  await assert.rejects(work(registrar, (client, identity) => registerSample(client, identity, registration)), { code: 'invalid_sample_reference' });
  delete registration.products[0].tagId; registration.products[0].tag = 'PERN freeform tag';
  const freeform = await work(registrar, (client, identity) => registerSample(client, identity, registration));
  assert.equal((await owner.query('SELECT tag FROM sample_products WHERE organization_id=$1 AND sample_id=$2', [organizationId, freeform.id])).rows[0].tag, registration.products[0].tag);
});

test('sample lists/details and request queues reload typed values, recorded activity and immutable scientific labels', async () => {
  const source = await createLaboratoryFixture(owner, registrar);
  const created = await work(registrar, (client, identity) => registerSample(client, identity, source.registration));
  const run = (fn) => work(operator, fn);
  const before = await run((client, identity) => loadSample(client, identity, created.id));
  assert.equal(before.products.length, 1); assert.equal(before.products[0].tests[0].rate, '0');
  assert.equal(before.stateName, 'In Progress'); assert.equal(before.activity[0].actorName, 'Synthetic Analyst');
  assert.equal(before.canGenerateRequests, true);
  const { items: [request] } = await run((client, identity) => generateTestRequests(client, identity, created.id));
  await owner.query('UPDATE methods_of_analysis SET name=$3, revision=revision+1 WHERE organization_id=$1 AND id=$2', [source.organizationId, source.method.id, 'Later master label']);
  const detail = await run((client, identity) => loadSample(client, identity, created.id));
  assert.equal(detail.products[0].tests[0].methodName, source.method.name);
  assert.equal(detail.products[0].tests[0].requestId, request.id);
  const list = await run((client, identity) => listSamples(client, identity, { search: created.sampleNumber }));
  assert.equal(list.totalCount, 1); assert.equal(list.rows[0].parameters[0].requestId, request.id);
  assert.equal((await run((client, identity) => listSamples(client, identity, { search: '%' }))).totalCount, 0);
  assert.equal((await run((client, identity) => listSamples(client, identity, { sampleType: 'complaint' }))).totalCount, 0);
  const queue = await run((client, identity) => sampleTestRequests(client, identity, created.id));
  assert.equal(queue.rows[0].canAllocate, true); assert.equal(queue.rows[0].methodName, source.method.name);
  await run((client, identity) => allocateTestRequest(client, identity, request.id, { revision: 1, assignmentType: 'analyst', assignedUserId: operator.userId }));
  const choices = await run((client, identity) => allocationOptions(client, identity, request.id));
  assert.equal(choices.users.find((user) => user.id === operator.userId).parameterWorkload, 1);
  assert.equal((await run((client, identity) => sampleTestRequests(client, identity, created.id))).rows[0].canAllocate, false);
  await assert.rejects(work(reader, (client, identity) => allocationOptions(client, identity, request.id)), { status: 403 });
  await assert.rejects(work(registrar, (client, identity) => loadSample(client, identity, created.id)), { status: 403 });
  await assert.rejects(run((client, identity) => loadSample(client, identity, randomUUID())), { status: 404 });
  await assert.rejects(run((client, identity) => listSamples(client, identity, { sampleType: 'invalid' })), { status: 400 });
});
