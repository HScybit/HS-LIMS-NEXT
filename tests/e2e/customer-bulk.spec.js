import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { grantSyntheticCustomerAccess, emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { decodeMasterXlsx } from '../../src/masters/bulk-xlsx.js';
import { masterWorkbook } from '../helpers/master-workbooks.js';
import { customerBulkHeaders } from '../../src/masters/customer-bulk-config.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function account(options = {}, configured = true) {
  const actor = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
  if (configured) actor.manager = await grantSyntheticCustomerAccess(owner, actor);
  return actor;
}
async function login(page, actor) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
const summary = (page, label) => page.getByLabel('Bulk upload validation summary').locator('.bulk-upload-summary__item')
  .filter({ has: page.getByText(label, { exact: true }) }).locator('span');
async function upload(page, buffer, name = 'Customers.csv') {
  await page.goto('/customer_masters'); await page.getByRole('button', { name: 'Bulk Upload', exact: true }).click();
  await expect(page.getByLabel('Select Model', { exact: true })).toHaveValue('customers');
  await page.getByLabel('Select File', { exact: true }).setInputFiles({ name, mimeType: name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv', buffer });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
}
async function headers(page) {
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
}

test('Customer bulk sample, duplicate correction, zero values and retained uploads work on desktop and mobile', async ({ page }, testInfo) => {
  const actor = await account(); await login(page, actor);
  const sample = await page.request.get('/api/master-bulk/sample?resource=customers'); expect(sample.status()).toBe(200);
  const decoded = await decodeMasterXlsx(await sample.body()); expect(decoded.headers).toEqual(customerBulkHeaders); expect(decoded.rows[0].values[0]).toBe('Example Customer');
  await upload(page, Buffer.from('name,legal_name,igst,default_credit_period,isFeedback,customer_total_balance\nRepeated,Legal,0,0,false,-12.345\nREPEATED,Legal,0,0,false,0'));
  await expect(page).toHaveURL(/\/bulk_uploads\/[a-f0-9-]+$/); const id = page.url().split('/').at(-1);
  await expect(page.getByText('Customer uploads create new records.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Validate', exact: true }).click(); await expect(summary(page, 'Cannot upload')).toHaveText('2');
  const rejected = await page.request.get(`/api/master-bulk/${id}/rejected`); expect(rejected.status()).toBe(200); expect((await decodeMasterXlsx(await rejected.body())).rows).toHaveLength(2);
  await page.getByRole('button', { name: 'Fix row 3', exact: true }).click(); await page.getByLabel('Row 3 name', { exact: true }).fill('Corrected Customer');
  await page.getByRole('button', { name: 'Save fixes & revalidate', exact: true }).click(); await expect(summary(page, 'Cannot upload')).toHaveText('1');
  await page.getByRole('button', { name: 'Validate', exact: true }).click(); await expect(summary(page, 'Cannot upload')).toHaveText('0');
  await page.getByRole('button', { name: 'Process valid rows', exact: true }).click(); await expect(summary(page, 'Committed')).toHaveText('2');
  const original = await page.request.get(`/api/master-bulk/${id}/original`); expect((await decodeMasterXlsx(await original.body())).rows[1].values[0]).toBe('REPEATED');
  const saved = (await owner.query('SELECT name,credit_days,igst_percent,feedback_applicable,total_balance FROM customers WHERE organization_id=$1 ORDER BY name', [actor.organizationId])).rows;
  expect(saved).toHaveLength(2); expect(saved.every(row => row.credit_days === 0 && row.igst_percent === '0.0000' && row.feedback_applicable === false)).toBe(true);
  expect(saved.find(row => row.name === 'Repeated').total_balance).toBe('-12.35');
  await page.screenshot({ path: testInfo.outputPath('customer-bulk-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await page.locator('.bulk-upload-preview-table th').nth(2).boundingBox()).width).toBeGreaterThanOrEqual(179);
  await page.getByText('Corrected Customer', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('customer-bulk-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.goto('/bulk_uploads?resource=customers'); await expect(page.getByText('2 of 2 committed', { exact: true })).toBeVisible();
  await page.getByPlaceholder('Search...', { exact: true }).fill('Customers'); await expect(page).toHaveURL(/search=Customers/);
  const history = page.url(); await page.getByRole('link', { name: 'Preview', exact: true }).click(); await expect(summary(page, 'Committed')).toHaveText('2');
  await page.getByRole('link', { name: 'Uploads', exact: true }).click(); await expect(page).toHaveURL(history);
});

test('Customer XLSX and lost upload/process responses retain the exact request and create one Customer', async ({ page }) => {
  const actor = await account(); await login(page, actor); const uploads = []; const processing = [];
  await page.route('**/api/master-bulk?resource=customers', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    uploads.push(route.request().headers()['x-upload-request-id']); const response = await route.fetch(); expect(response.status()).toBe(201);
    if (uploads.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  const bytes = await masterWorkbook([['name', 'legal_name', 'igst', 'isFeedback'], ['XLSX retry', 'Legal', 0, { formula: 'FALSE()', result: false }]]);
  await upload(page, bytes, 'Customers.xlsx'); await expect(page.locator('.alert[role="alert"]')).toContainText('could not be confirmed');
  await expect(page.getByLabel('Select File')).toBeDisabled(); await page.getByRole('button', { name: 'Retry upload', exact: true }).click();
  await expect(page).toHaveURL(/\/bulk_uploads\/[a-f0-9-]+$/); expect(uploads).toHaveLength(2); expect(uploads[0]).toBe(uploads[1]);
  await page.getByRole('button', { name: 'Validate', exact: true }).click(); await expect(page.getByText('Create', { exact: true })).toBeVisible();
  await page.route('**/api/master-bulk/*/process', async route => {
    processing.push(route.request().postDataJSON()); const response = await route.fetch(); expect(response.status()).toBe(200);
    if (processing.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Process valid rows', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('could not be confirmed');
  await page.getByRole('button', { name: 'Retry interrupted action', exact: true }).click(); await expect(summary(page, 'Committed')).toHaveText('1');
  expect(processing).toHaveLength(2); expect(processing[0]).toEqual(processing[1]); await page.reload(); await expect(summary(page, 'Committed')).toHaveText('1');
  expect((await owner.query('SELECT 1 FROM master_bulk_batches WHERE organization_id=$1', [actor.organizationId])).rowCount).toBe(1);
  expect((await owner.query('SELECT 1 FROM customer_versions WHERE organization_id=$1', [actor.organizationId])).rowCount).toBe(1);
});

test('Customer bulk HTTP access checks precede decoding and cover revocation, exports, tenant and CSRF', async ({ page, browser }) => {
  const actor = await account(); expect((await page.request.get('/api/master-bulk/sample?resource=customers')).status()).toBe(401);
  await login(page, actor); await upload(page, Buffer.from('name,legal_name\nRestricted,Legal'));
  await expect(page).toHaveURL(/\/bulk_uploads\/[a-f0-9-]+$/); const id = page.url().split('/').at(-1);
  expect((await page.request.post(`/api/master-bulk/${id}/review`, { data: { rows: [] }, headers: { Origin: 'http://127.0.0.1:3100' } })).status()).toBe(403);
  for (const subject of [await account({ organizationId: actor.organizationId, permissions: ['masters.manage'] }, false),
    await account({ organizationId: actor.organizationId, permissions: ['masters.read'] }), await account()]) {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
    try {
      const other = await context.newPage(); await login(other, subject); await other.goto('/customer_masters');
      if (subject.organizationId === actor.organizationId) {
        await expect(other.getByRole('button', { name: 'Bulk Upload', exact: true })).toHaveCount(0);
        expect((await other.request.get('/api/master-bulk/sample?resource=customers')).status()).toBe(403);
        expect((await other.request.post('/api/master-bulk?resource=customers', { headers: await headers(other), data: Buffer.from('invalid workbook') })).status()).toBe(403);
      }
      for (const suffix of ['', '/original', '/rejected']) {
        const response = await other.request.get(`/api/master-bulk/${id}${suffix}`); expect([403, 404]).toContain(response.status());
      }
    } finally { await context.close(); }
  }
  await saveModuleAccessSettings(actor.manager, emptyModuleAccess());
  expect((await page.request.get(`/api/master-bulk/${id}/original`)).status()).toBe(404);
  expect((await page.request.post('/api/master-bulk?resource=customers', { headers: { ...await headers(page), 'X-Upload-Request-Id': randomUUID() }, data: Buffer.from('name,legal_name\nNo,Legal') })).status()).toBe(403);
});
