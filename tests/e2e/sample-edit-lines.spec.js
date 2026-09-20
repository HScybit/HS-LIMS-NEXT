import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool, database } from '../../src/db/pool.js';
import { randomUUID } from 'node:crypto';
import { testParameters, parameterMethods } from '../../src/db/master-schema.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
}

test('sample editing keeps stable line and test IDs through a line save and rejects stale retries', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const headers = await login(page, account);
  const created = await page.request.post('/api/samples', { headers, data: fixture.registration });
  expect(created.status()).toBe(201); const sample = await created.json();
  const path = `/api/samples/${sample.id}`;
  const before = await (await page.request.get(path)).json();
  const original = before.products[0];
  const products = [{ ...fixture.registration.products[0], id: original.id, sampleCategoryId: fixture.category.id,
    description: 'Revised operational line', quantity: '2.000000000000001',
    tests: [{ ...fixture.registration.products[0].tests[0], id: original.tests[0].id, requestedSize: '25 ml' }] }];
  const edited = await page.request.patch(path, { headers, data: { revision: 1, products, description: 'Edited with lines' } });
  expect(edited.status()).toBe(200);
  expect((await edited.json()).revision).toBe(2);
  const after = await (await page.request.get(path)).json();
  expect(after.products[0].id).toBe(original.id);
  expect(after.products[0].tests[0].id).toBe(original.tests[0].id);
  expect(after.products[0].tests[0].decisionRuleId).toBe(fixture.rule.id);
  expect(after.products[0].tests[0].requestedSize).toBe('25 ml');
  expect(after.products[0].quantity).toBe('2.000000000000001');
  expect(after.products[0].productRevision).toBe(original.productRevision);
  expect(after.description).toBe('Edited with lines');
  const stale = await page.request.patch(path, { headers, data: { revision: 1, products } });
  expect(stale.status()).toBe(409);
  await page.goto(`/samples/${sample.id}`);
  await expect(page.locator('.smplfy-sample-details-product-card')).toContainText('Revised operational line');
  await expect(page.locator('.smplfy-sample-details-product-card')).toContainText('2.000000000000001');
  await expect(page.locator('.smplfy-sample-details-product-card')).toContainText('25 ml');
});

test('sample line HTTP preserves requested identity and rejects removal without adding an edit event', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false }); const headers = await login(page, account);
  const created = await page.request.post('/api/samples', { headers, data: fixture.registration }); expect(created.status()).toBe(201);
  const sample = await created.json(); const path = `/api/samples/${sample.id}`;
  expect((await page.request.post(`${path}/test-requests`, { headers, data: {} })).status()).toBe(201);
  const before = await (await page.request.get(path)).json(); const selected = before.products[0].tests[0];
  const products = [{ ...fixture.registration.products[0], id: before.products[0].id, sampleCategoryId: fixture.category.id,
    tests: [{ ...fixture.registration.products[0].tests[0], id: selected.id, requestedSize: 'New operational size' }] }];
  expect((await page.request.patch(path, { headers, data: { revision: before.revision, products } })).status()).toBe(200);
  const saved = await (await page.request.get(path)).json();
  expect(saved.products[0].tests[0].id).toBe(selected.id); expect(saved.products[0].tests[0].requestId).toBe(selected.requestId);
  expect(saved.products[0].tests[0].requestedSize).toBe('New operational size');
  products[0].tests[0].id = null;
  const denied = await page.request.patch(path, { headers, data: { revision: saved.revision, products, description: 'Must not persist' } });
  expect(denied.status()).toBe(409); expect((await denied.json()).error.code).toBe('sample_lines_changed');
  expect(await (await page.request.get(path)).json()).toEqual(saved);
});

test('sample line HTTP accepts a bounded multi-megabyte save of 100 lines and 5,000 tests', async ({ page }) => {
  test.setTimeout(120_000);
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const parameters = await database(owner).insert(testParameters).values(Array.from({ length: 50 }, (_, index) => ({ organizationId: account.organizationId,
    code: randomUUID(), masterKey: randomUUID(), schemeAbbreviation: `HTTP${index}`, name: `Synthetic HTTP edit parameter ${index}`,
    laboratoryId: fixture.laboratory.id, measurementUnitId: fixture.unit.id }))).returning();
  await database(owner).insert(parameterMethods).values(parameters.map(parameter => ({ organizationId: account.organizationId,
    testParameterId: parameter.id, methodId: fixture.method.id, isDefault: true })));
  const data = { ...fixture.registration, products: Array.from({ length: 100 }, () => ({ productId: fixture.product.id, quantity: '1',
    sampleCategoryId: fixture.category.id, description: 'D'.repeat(2000), tests: parameters.map(parameter => ({ testParameterId: parameter.id, methodId: fixture.method.id, requestedSize: 'R'.repeat(150) })) })) };
  const headers = await login(page, account);
  const created = await page.request.post('/api/samples', { headers, data }); expect(created.status()).toBe(201);
  const sample = await created.json(); const path = `/api/samples/${sample.id}`;
  const before = await (await page.request.get(path)).json();
  const products = data.products.map((line, index) => ({ ...line, id: before.products[index].id, description: 'E'.repeat(2000),
    tests: line.tests.map((selected, position) => ({ ...selected, id: before.products[index].tests[position].id, requestedSize: 'N'.repeat(150) })) }));
  const input = { revision: before.revision, products };
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(1_000_000);
  const updated = await page.request.patch(path, { headers, data: input }); expect(updated.status()).toBe(200);
  const after = await (await page.request.get(path)).json();
  expect(after.revision).toBe(before.revision + 1); expect(after.products).toHaveLength(100);
  expect(after.products.flatMap(line => line.tests).map(selected => selected.id)).toEqual(before.products.flatMap(line => line.tests).map(selected => selected.id));
  expect(after.products.every(line => line.description === 'E'.repeat(2000) && line.tests.every(selected => selected.requestedSize === 'N'.repeat(150)))).toBe(true);
});
