import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { grantSyntheticCustomerAccess } from '../helpers/module-access.js';
import { closePool, database } from '../../src/db/pool.js';
import { customerAddresses, customerQuotations, tags, productTags } from '../../src/db/master-schema.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

async function login(page, account) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function select(page, name, label) {
  await page.getByRole('combobox', { name, exact: true }).fill(label);
  await page.getByRole('option', { name: label, exact: true }).click();
}
async function mutationHeaders(context) {
  const cookies = await context.cookies();
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': cookies.find((cookie) => cookie.name === 'sampleify_csrf').value };
}

test('registration recovers from a failed save and reaches allocated, persisted analytical results through the UI', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const account = await createAccount(owner, { permissions: ['samples.read', 'samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const source = await createLaboratoryFixture(owner, account); const db = database(owner); const organizationId = account.organizationId;
  await owner.query(`UPDATE organization_laboratory_settings SET allow_receiving_date_edit=true,
    revision=revision+1,updated_by=$2,updated_at=now() WHERE organization_id=$1`, [organizationId, account.userId]);
  await db.insert(customerAddresses).values({ organizationId, customerId: source.customer.id, addressType: 'billing', freeformAddress: 'Synthetic billing address\nReceiving bay', isDefault: true });
  const [quotation] = await db.insert(customerQuotations).values({ organizationId, customerId: source.customer.id, quotationNumber: `SYN-Q-${randomUUID()}`, quotationDate: '2026-09-01', status: 'approved', totalAmount: '0', currencyCode: 'USD' }).returning();
  const [tag] = await db.insert(tags).values({ organizationId, code: randomUUID(), name: 'Synthetic source tag' }).returning();
  await db.insert(productTags).values({ organizationId, productId: source.product.id, tagId: tag.id });
  await owner.query("UPDATE decision_rules SET minimum_size='10 mL', estimated_time_in_days=2, estimated_charges=125, revision=revision+1 WHERE organization_id=$1 AND id=$2", [organizationId, source.rule.id]);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, account);
  await page.getByRole('link', { name: 'Samples', exact: true }).click();
  await expect(page.getByText('No samples found for this view.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'New Sample', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New Base Sample', exact: true })).toBeVisible();
  await select(page, 'Customer', source.customer.name);
  await expect(page.getByLabel('Customer Address', { exact: true })).toHaveValue('Synthetic billing address\nReceiving bay');
  await select(page, 'Customer Quotation', quotation.quotationNumber);
  await select(page, 'Category', source.category.name);
  await select(page, 'Tag', tag.name);
  await select(page, 'Product', source.product.name);
  await page.getByRole('button', { name: 'Auto-fill parameters', exact: true }).click();
  await expect(page.getByLabel('Requested size 1', { exact: true })).toHaveValue('10 mL');
  await expect(page.getByLabel('Charges 1', { exact: true })).toHaveValue('125');
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('0');
  await page.getByLabel('Receiving Date', { exact: true }).fill('2026-09-12');
  await expect(page.getByLabel('Tentative Reporting Date', { exact: true })).toHaveValue('2026-09-14');
  await page.getByLabel('Quantity', { exact: true }).fill('1.25');
  await page.getByLabel('Description', { exact: true }).fill('Synthetic sample entered through the source form');
  await select(page, 'Sample size unit', source.unit.name);
  await page.getByRole('button', { name: 'Add New Parameter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove parameter', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove parameter', exact: true }).last().click();
  await page.getByRole('button', { name: 'Add New Product', exact: true }).click();
  await expect(page.getByLabel('Category', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove product', exact: true }).last().click();
  await page.screenshot({ path: testInfo.outputPath('sample-registration-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.lims-main').evaluate((element) => element.getBoundingClientRect().left)).toBe(0);
  await expect.poll(() => page.locator('.lims-main').evaluate((element) => element.getBoundingClientRect().width)).toBe(390);
  await page.locator('.lims-main-content').evaluate((element) => { element.scrollTop = 0; });
  const mobileLayout = await page.evaluate(() => ['.sample-form-page', '.sample-form-page__body', '#new-sample-v2-form', '#new-sample-v2-form > .d-grid', '[aria-labelledby="new-sample-product-details-title"]', '[aria-labelledby="new-sample-product-details-title"] .d-grid', '.table-responsive'].map((selector) => {
    const element = document.querySelector(selector); const bounds = element.getBoundingClientRect();
    return { selector, left: bounds.left, right: bounds.right, width: bounds.width, scrollWidth: element.scrollWidth, columns: getComputedStyle(element).gridTemplateColumns };
  }));
  await testInfo.attach('registration-mobile-layout', { body: JSON.stringify(mobileLayout, null, 2), contentType: 'application/json' });
  expect(Math.max(...mobileLayout.map((element) => element.right))).toBeLessThanOrEqual(390);
  const customerField = page.locator('.smplfy-form-field').filter({ has: page.getByRole('combobox', { name: 'Customer', exact: true }) });
  expect((await customerField.boundingBox()).width).toBeGreaterThan(200);
  await page.screenshot({ path: testInfo.outputPath('sample-registration-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });

  let fail = true;
  await page.route('**/api/samples', async (route) => {
    if (route.request().method() === 'POST' && fail) {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic registration interruption' } }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Save Sample', exact: true }).click();
  await expect(page.locator('.sample-form-page').getByRole('alert')).toContainText('Synthetic registration interruption');
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('1.25');
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('0');
  const registrationResponse = page.waitForResponse((response) => response.url().endsWith('/api/samples') && response.request().method() === 'POST' && response.status() === 201);
  await page.getByRole('button', { name: 'Save Sample', exact: true }).click();
  const created = await (await registrationResponse).json();
  await expect(page).toHaveURL(`/samples/${created.id}`);
  await expect(page.getByRole('heading', { name: created.sampleNumber, exact: true })).toBeVisible();
  const saved = await (await page.request.get(`/api/samples/${created.id}`)).json();
  expect(saved.totalAmount).toBe('0'); expect(saved.currencyCode).toBe('USD'); expect(saved.quantity).toBe('1.25');
  expect(saved.receivedAt).toBe('2026-09-12T00:00:00.000Z'); expect(saved.products[0].tag).toBe(tag.name);
  expect(saved.products[0].tests[0].isAccredited).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('sample-details-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Generate Test Requests', exact: true }).click();
  await expect(page).toHaveURL(`/samples/${created.id}/test_requests`);
  await page.getByRole('button', { name: 'Allocate', exact: true }).click();
  const allocation = page.getByRole('dialog', { name: 'Allocate Test Request', exact: true });
  await expect(allocation).toBeVisible();
  await select(page, 'Allocate to', 'Synthetic Analyst');
  await expect(allocation.getByRole('cell', { name: 'Synthetic Analyst', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('test-request-allocation-desktop.png'), fullPage: true, animations: 'disabled' });
  await allocation.getByRole('button', { name: 'Allocate', exact: true }).click();
  await expect(allocation).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Allocate', exact: true })).toHaveCount(0);
  const queue = await (await page.request.get(`/api/samples/${created.id}/test-requests`)).json();
  expect(queue.rows).toHaveLength(1); expect(queue.rows[0].status).toBe('allocated');
  const requestId = queue.rows[0].id;
  await page.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page).toHaveURL(`/samples/${created.id}/test_requests/${requestId}`);
  await page.getByRole('link', { name: 'Add Results', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add Results', exact: true })).toBeVisible();
  const datasheetId = new URL(page.url()).pathname.split('/').at(-1);
  const inputs = page.getByRole('spinbutton', { name: 'raw_0', exact: true });
  await expect(inputs).toHaveCount(2); await inputs.first().fill('0'); await inputs.last().fill('1.5');
  await page.getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(page.getByLabel('result_0', { exact: true }).first()).toHaveText('0.00');
  await expect(page.getByLabel('result_0', { exact: true }).last()).toHaveText('3.00');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(`/samples/${created.id}/test_requests/${requestId}`);
  const capture = await (await page.request.get(`/api/datasheets/${datasheetId}`)).json();
  expect(capture.capture.values.filter((value) => value.fieldId === source.template.records.fields[0].id).map((value) => value.numberValue).sort()).toEqual(['0', '1.5']);
  expect(capture.datasheet.status).toBe('in_progress');
  await page.goto('/samples'); await page.getByRole('textbox', { name: 'Search samples', exact: true }).fill(created.sampleNumber);
  await page.getByRole('button', { name: 'Search samples', exact: true }).click();
  await expect(page.getByRole('link', { name: created.sampleNumber, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: `${source.parameter.name}, Under Testing`, exact: true })).toHaveAttribute('href', `/samples/${created.id}/test_requests/${requestId}`);
  await page.getByRole('button', { name: 'Tabular view', exact: true }).click();
  await expect(page.getByRole('cell', { name: source.customer.name, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sample-list-desktop.png'), fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('create-only registration supports source quick-customer fields and bounded large payloads without read or CSRF bypass', async ({ page, context }) => {
  test.setTimeout(90_000);
  const account = await createAccount(owner, { permissions: ['samples.create'] });
  const source = await createLaboratoryFixture(owner, account);
  await grantSyntheticCustomerAccess(owner, account);
  await login(page, account); await page.getByRole('link', { name: 'Samples', exact: true }).click();
  await expect(page).toHaveURL('/samples/new');
  await page.getByRole('button', { name: 'Add customer', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Quick Add Customer', exact: true });
  const name = `Synthetic quick ${randomUUID()}`;
  const fields = { Name: name, 'Legal Name': 'Synthetic legal name', 'Contact Person': 'Synthetic contact', 'Contact Person Email': 'synthetic@example.invalid',
    'Contact Person Phone': '0000000000', 'Bill to Address': 'Synthetic billing\nSecond line', 'Ship to Address': 'Synthetic receiving bay' };
  for (const [label, value] of Object.entries(fields)) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByRole('button', { name: 'Add Customer', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByLabel('Customer Address', { exact: true })).toHaveValue(fields['Bill to Address']);
  await select(page, 'Category', source.category.name); await select(page, 'Product', source.product.name);
  await page.getByRole('button', { name: 'Auto-fill parameters', exact: true }).click();
  await page.getByRole('button', { name: 'Save Sample', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Sample .+ registered\.$/ })).toBeVisible();
  await expect(page).toHaveURL('/samples/new');

  const headers = await mutationHeaders(context);
  const unicodeAddress = '測'.repeat(3000);
  const customer = { name: `Synthetic unicode ${randomUUID()}`, legalName: 'Synthetic legal name', contactPersonName: 'Synthetic contact', contactPersonEmail: 'unicode@example.invalid', contactPersonPhone: '0000', billToAddress: unicodeAddress, shipToAddress: unicodeAddress };
  expect(Buffer.byteLength(JSON.stringify(customer))).toBeGreaterThan(16_384);
  const customerResponse = await page.request.post('/api/samples/quick-customer', { headers, data: customer });
  expect(customerResponse.status()).toBe(201);
  expect((await customerResponse.json()).addresses[0].text).toBe(unicodeAddress);
  const registration = { ...source.registration, products: Array.from({ length: 25 }, () => ({ ...structuredClone(source.registration.products[0]), description: 'S'.repeat(1000) })) };
  expect(Buffer.byteLength(JSON.stringify(registration))).toBeGreaterThan(16_384);
  const response = await page.request.post('/api/samples', { headers, data: registration });
  expect(response.status()).toBe(201); const created = await response.json();
  expect((await owner.query('SELECT count(*)::integer AS count FROM sample_products WHERE organization_id=$1 AND sample_id=$2', [account.organizationId, created.id])).rows[0].count).toBe(25);
  expect((await page.request.get(`/api/samples/${created.id}`)).status()).toBe(403);
  expect((await page.request.get('/api/samples')).status()).toBe(403);
  expect((await page.request.get('/api/samples/registration-options')).status()).toBe(200);
  expect((await page.request.post('/api/samples', { headers: { Origin: headers.Origin }, data: source.registration })).status()).toBe(403);
  expect((await page.request.post('/api/samples', { headers: { ...headers, Origin: 'https://synthetic.example.invalid' }, data: source.registration })).status()).toBe(403);
  expect((await page.request.post('/api/samples', { headers, data: { ...source.registration, sampleCategoryId: randomUUID() } })).status()).toBe(422);
  expect((await page.request.post('/api/samples', { headers, data: { padding: 'x'.repeat(8_388_608) } })).status()).toBe(413);
  expect((await page.request.post('/api/auth/login', { headers, data: { padding: 'x'.repeat(16_384) } })).status()).toBe(413);
});
