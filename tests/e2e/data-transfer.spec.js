import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { ownerPool, createAccount } from '../helpers/database.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}

test('sidebar follows the source order and the Admin Hub links to Data Transfer', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['masters.read', 'masters.manage', 'samples.read', 'settings.read'] }); await login(page, actor);
  await expect(page.locator('.sidebar-shell-desktop .sidebar-label span')).toHaveText(['Home', 'LIMS', 'Administration', 'Account']);
  await expect(page.locator('.sidebar-shell-desktop').getByRole('link', { name: 'Dashboard', exact: true })).toHaveAttribute('href', '/dashboard');
  await page.goto('/admin_hub');
  await expect(page.getByRole('link', { name: 'Data Transfer', exact: true })).toHaveAttribute('href', '/data_transfer');
});

test('sample workbooks carry an example row, imports continue in the validation preview and exports download listings', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['masters.read', 'masters.manage'] }); await login(page, actor);
  await owner.query('INSERT INTO products(organization_id,code,name,description) VALUES($1,$2,$3,$4)', [actor.organizationId, 'EXPORT-1', 'Exported "Product"', '=formula looking']);

  const template = await page.request.get('/api/master-bulk/sample?resource=products'); expect(template.status()).toBe(200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await template.body());
  expect(workbook.worksheets[0].getRow(1).values.slice(1)).toEqual(['name', 'key', 'description', 'abbr']);
  expect(workbook.worksheets[0].getRow(2).values.slice(1)).toEqual(['Example Product', 'example_product', 'Example description', 'PXX']);

  await page.goto('/data_transfer');
  await expect(page.getByRole('heading', { name: 'Data Transfer', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Transfer History', exact: true })).toHaveAttribute('href', '/bulk_uploads');
  await expect(page.getByLabel('Data Type', { exact: true })).toHaveValue('products');
  const columns = page.getByRole('table', { name: 'Expected columns' });
  await expect(columns.getByRole('row').filter({ hasText: 'name' }).first()).toContainText('Example Product');
  await expect(columns.getByRole('row').filter({ hasText: 'scheme_abbr' })).toHaveCount(0);
  await page.getByLabel('Data Type', { exact: true }).selectOption('test-parameters');
  await expect(columns.getByRole('row').filter({ hasText: 'scheme_abbr' })).toContainText('Required');
  await page.getByLabel('Data Type', { exact: true }).selectOption('products');
  await expect(page.getByRole('button', { name: 'Upload and validate', exact: true })).toBeDisabled();
  await page.getByLabel('Select Excel or CSV File', { exact: true }).setInputFiles({ name: 'Products.csv', mimeType: 'text/csv', buffer: Buffer.from('name,key\nWater,W\n') });
  await page.getByRole('button', { name: 'Upload and validate', exact: true }).click();
  await expect(page).toHaveURL(/\/bulk_uploads\/[a-f0-9-]+\?from=%2Fdata_transfer$/);
  await expect(page.getByRole('heading', { name: 'Bulk Upload Preview', exact: true })).toBeVisible();

  await page.goto('/data_transfer');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export 5 Fields', exact: true })).toBeEnabled();
  await page.getByLabel('Export Tags', { exact: true }).uncheck();
  await page.getByLabel('Export Job Template', { exact: true }).uncheck();
  await page.getByLabel('Export format', { exact: true }).selectOption('csv');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export 3 Fields', exact: true }).click();
  const file = await download; expect(file.suggestedFilename()).toBe('products_export.csv');
  const chunks = []; for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString('utf8')).toBe('﻿"Name","Key","Description"\r\n"Exported ""Product""","EXPORT-1","\'=formula looking"\r\n');
  await expect(page.locator('.data-transfer-message')).toContainText('Products exported as CSV.');

  const xlsx = await page.request.post('/api/data-transfer/export', { data: { resource: 'products', fields: ['name', 'key'], format: 'xlsx' }, headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value } });
  expect(xlsx.status()).toBe(200); expect(xlsx.headers()['content-type']).toContain('spreadsheetml');
  const exported = new ExcelJS.Workbook(); await exported.xlsx.load(await xlsx.body());
  expect(exported.worksheets[0].getRow(2).values.slice(1)).toEqual(['Exported "Product"', 'EXPORT-1']);
  const rejected = await page.request.post('/api/data-transfer/export', { data: { resource: 'products', fields: ['name', 'missing'], format: 'csv' }, headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value } });
  expect(rejected.status()).toBe(422);
});

test('viewers export without importing and unauthorized users are refused', async ({ page }) => {
  const viewer = await createAccount(owner, { permissions: ['masters.read'] }); await login(page, viewer);
  await page.goto('/data_transfer');
  await expect(page.getByRole('group', { name: 'Transfer mode' }).getByRole('button')).toHaveText(['Export']);
  await expect(page.getByRole('button', { name: /^Export \d+ Fields$/ })).toBeVisible();
  expect((await page.request.get('/api/master-bulk/sample?resource=products')).status()).toBe(403);
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
  expect((await page.request.post('/api/data-transfer/export', { data: { resource: 'users', fields: ['email'], format: 'csv' }, headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf } })).status()).toBe(403);
  await page.request.post('/api/auth/logout', { data: {}, headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf } });
  const outsider = await createAccount(owner, { permissions: ['samples.read'] }); await login(page, outsider);
  await page.goto('/data_transfer');
  await expect(page.getByRole('alert').filter({ hasText: 'transfer' })).toHaveText('You cannot transfer data.');
  expect((await page.request.get('/api/data-transfer/entities')).status()).toBe(200);
  expect((await (await page.request.get('/api/data-transfer/entities')).json()).items).toEqual([]);
});
