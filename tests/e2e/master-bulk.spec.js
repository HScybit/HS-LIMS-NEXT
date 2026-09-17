import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { closePool } from '../../src/db/pool.js';
import { decodeMasterXlsx } from '../../src/masters/bulk-xlsx.js';
import ExcelJS from 'exceljs';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function upload(page, path, source) {
  await page.goto(path); await page.getByRole('button', { name: 'Bulk Upload', exact: true }).click();
  await page.getByLabel('Select File', { exact: true }).setInputFiles({ name: 'Synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from(source) });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page).toHaveURL(/\/bulk_uploads\/[a-f0-9-]+$/);
}
const summary = (page, label) => page.getByLabel('Bulk upload validation summary').locator('.bulk-upload-summary__item').filter({ has: page.getByText(label, { exact: true }) }).locator('span');

for (const fixture of [
  { resource: 'products', path: '/products', header: 'name,key', values: ['Water,W', ',B'] },
  { resource: 'test-parameters', path: '/test_parameters', header: 'name,key,scheme_abbr,order', values: ['Water,W,W,0', ',B,B,0'] },
  { resource: 'methods', path: '/method_of_analysis', header: 'name,uuid,parse_num,decimal_places', values: ['Water,W,false,0', ',B,false,0'] },
]) {
  test(`${fixture.resource} workbook template, upload, validation, row correction, processing and reload`, async ({ page }, testInfo) => {
    const actor = await createAccount(owner, { permissions: ['masters.manage'] }); await login(page, actor);
    const template = await page.request.get(`/api/master-bulk/sample?resource=${fixture.resource}`);
    expect(template.status()).toBe(200); expect(template.headers()['content-type']).toContain('spreadsheetml');
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await template.body());
    expect(workbook.worksheets[0].getCell('A1').value).toBe('name');
    await upload(page, fixture.path, [fixture.header, ...fixture.values].join('\n'));
    await page.getByRole('button', { name: 'Validate', exact: true }).click();
    await expect(summary(page, 'Cannot upload')).toHaveText('1');
    await page.getByRole('button', { name: 'Show Only Blocked Rows', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Fix row 2', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Fix row 3', exact: true }).click();
    await page.getByLabel('Row 3 name', { exact: true }).fill('Corrected');
    await page.getByRole('button', { name: 'Save fixes & revalidate', exact: true }).click();
    await expect(summary(page, 'Cannot upload')).toHaveText('0');
    await expect(page.getByText('No blocked rows.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Show All Rows', exact: true }).click();
    await page.getByRole('button', { name: 'Process valid rows', exact: true }).click();
    await expect(summary(page, 'Committed')).toHaveText('2'); await expect(page.getByText('Completed', { exact: true })).toBeVisible();
    await page.reload(); await expect(summary(page, 'Committed')).toHaveText('2'); await expect(page.getByText('Corrected', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fix row 3', exact: true })).toHaveCount(0);
    if (fixture.resource === 'methods') {
      const rows = (await owner.query('SELECT decimal_scale,parse_number FROM methods_of_analysis WHERE organization_id=$1', [actor.organizationId])).rows;
      expect(rows).toEqual([{ decimal_scale: 0, parse_number: false }, { decimal_scale: 0, parse_number: false }]);
    }
    if (fixture.resource === 'products') {
      await page.screenshot({ path: testInfo.outputPath('bulk-preview-desktop.png'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath('bulk-preview-mobile.png'), fullPage: true, animations: 'disabled' });
      await page.getByText('Corrected', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('bulk-preview-mobile-table.png'), fullPage: true, animations: 'disabled' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    }
    await page.goto(`/bulk_uploads?resource=${fixture.resource}`); await expect(page.getByText('2 of 2 committed', { exact: true })).toBeVisible();
    await page.getByPlaceholder('Search...', { exact: true }).fill('Synthetic');
    await expect(page).toHaveURL(/search=Synthetic/);
    const historyPath = page.url(); await page.getByRole('link', { name: 'Preview', exact: true }).click();
    await expect(summary(page, 'Committed')).toHaveText('2');
    await page.getByRole('link', { name: 'Uploads', exact: true }).click();
    await expect(page).toHaveURL(historyPath); await expect(page.getByPlaceholder('Search...', { exact: true })).toHaveValue('Synthetic');
  });
}

test('an upload with a lost response retries the same file and request without creating another batch', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['masters.manage'] }); await login(page, actor);
  const requests = [];
  await page.route('**/api/master-bulk?resource=products', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push({ id: route.request().headers()['x-upload-request-id'], body: route.request().postData() });
    const response = await route.fetch();
    if (requests.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.goto('/products'); await page.getByRole('button', { name: 'Bulk Upload', exact: true }).click();
  await page.getByLabel('Select File').setInputFiles({ name: 'Retry.csv', mimeType: 'text/csv', buffer: Buffer.from('name,key\nRetry,R') });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('could not be confirmed'); await expect(page.getByLabel('Select File')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click();
  await expect(page).toHaveURL(/\/bulk_uploads\/[a-f0-9-]+$/); expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect((await owner.query('SELECT 1 FROM master_bulk_batches WHERE organization_id=$1', [actor.organizationId])).rowCount).toBe(1);
});

test('processing with a lost response resumes exact requests and reports one committed version', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['masters.manage'] }); await login(page, actor);
  await upload(page, '/products', 'name,key\nRetry,R');
  await page.getByRole('button', { name: 'Validate', exact: true }).click(); await expect(page.getByText('Create', { exact: true })).toBeVisible();
  const requests = [];
  await page.route('**/api/master-bulk/*/process', async route => {
    requests.push(route.request().postDataJSON()); const response = await route.fetch();
    if (requests.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Process valid rows', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('could not be confirmed');
  await page.getByRole('button', { name: 'Retry interrupted action', exact: true }).click();
  await expect(summary(page, 'Committed')).toHaveText('1'); expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect((await owner.query('SELECT 1 FROM product_versions WHERE organization_id=$1', [actor.organizationId])).rowCount).toBe(1);
});

test('a lost correction response keeps its exact draft and resumes validation without a second revision', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['masters.manage'] }); await login(page, actor);
  await upload(page, '/products', 'name,key\n,R'); const id = page.url().split('/').at(-1);
  await page.getByRole('button', { name: 'Validate', exact: true }).click(); await expect(summary(page, 'Cannot upload')).toHaveText('1');
  const requests = [];
  await page.route(`**/api/master-bulk/${id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    requests.push(route.request().postDataJSON()); const response = await route.fetch();
    if (requests.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Fix row 2', exact: true }).click();
  await page.getByLabel('Row 2 name', { exact: true }).fill('Retained draft');
  await page.getByRole('button', { name: 'Save fixes & revalidate', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('could not be confirmed');
  await expect(page.getByLabel('Row 2 name', { exact: true })).toHaveValue('Retained draft');
  await expect(page.getByLabel('Row 2 name', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry interrupted action', exact: true }).click();
  await expect(summary(page, 'Cannot upload')).toHaveText('0'); expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect((await owner.query('SELECT revision FROM master_bulk_rows WHERE organization_id=$1 AND batch_id=$2', [actor.organizationId, id])).rows).toEqual([{ revision: 2 }]);
});

test('the upload model selector uses the chosen model and file-level errors remain visible', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['masters.manage'] }); await login(page, actor);
  await page.goto('/bulk_uploads'); await page.getByRole('button', { name: 'Bulk Upload', exact: true }).click();
  await page.getByLabel('Select Model', { exact: true }).selectOption('methods');
  await page.getByLabel('Select File', { exact: true }).setInputFiles({ name: 'Missing headers.csv', mimeType: 'text/csv', buffer: Buffer.from('name\nMissing Method') });
  await page.getByRole('button', { name: 'Upload', exact: true }).click(); await expect(page).toHaveURL(/\/bulk_uploads\/[a-f0-9-]+$/);
  await expect(page.getByRole('heading', { name: 'Method of Analysis Preview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.locator('.bulk-upload-file-errors')).toContainText('Required columns are missing');
});

test('original/rejected exports retain input values safely and bulk HTTP routes enforce permission, tenant and CSRF', async ({ page, browser }) => {
  const actor = await createAccount(owner, { permissions: ['masters.manage'] });
  expect((await page.request.get('/api/master-bulk?resource=products')).status()).toBe(401);
  await login(page, actor); await upload(page, '/products', 'name,key\n=1+1,');
  const id = page.url().split('/').at(-1); await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(summary(page, 'Cannot upload')).toHaveText('1');
  const rejected = await page.request.get(`/api/master-bulk/${id}/rejected`); expect(rejected.status()).toBe(200);
  const decoded = await decodeMasterXlsx(await rejected.body()); expect(decoded.rows[0].values).toEqual(['=1+1', '']);
  expect(decoded.rows[0].cellMetadata.some(cell => cell.type === 'formula')).toBe(false);
  await page.getByRole('button', { name: 'Fix row 2', exact: true }).click(); await page.getByLabel('Row 2 name', { exact: true }).fill('Corrected name');
  await page.getByRole('button', { name: 'Save fixes & revalidate', exact: true }).click();
  await expect(page.getByText('Saving fixes and validating complete.', { exact: true })).toBeVisible();
  const original = await page.request.get(`/api/master-bulk/${id}/original`); expect(original.status()).toBe(200);
  expect((await decodeMasterXlsx(await original.body())).rows[0].values[0]).toBe('=1+1');
  expect((await page.request.post(`/api/master-bulk/${id}/review`, { data: { rows: [] }, headers: { Origin: 'http://127.0.0.1:3100' } })).status()).toBe(403);
  for (const other of [await createAccount(owner, { organizationId: actor.organizationId, permissions: ['masters.read'] }), await createAccount(owner, { permissions: ['masters.manage'] })]) {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
    try {
      const otherPage = await context.newPage(); await login(otherPage, other); await otherPage.goto('/products');
      const expected = other.organizationId === actor.organizationId ? 403 : 404;
      if (expected === 403) await expect(otherPage.getByRole('button', { name: 'Bulk Upload', exact: true })).toHaveCount(0);
      for (const suffix of ['', '/original', '/rejected']) expect((await otherPage.request.get(`/api/master-bulk/${id}${suffix}`)).status()).toBe(expected);
    } finally { await context.close(); }
  }
});
