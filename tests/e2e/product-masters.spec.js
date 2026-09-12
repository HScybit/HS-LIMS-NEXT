import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveProduct } from '../../src/masters/products.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function fixture() {
  const account = await createAccount(owner, { permissions: ['masters.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Original product', key: `P-${randomUUID()}`,
    description: '', abbreviation: null, jobTemplateId: null, tagIds: [] };
  const product = await withSession(session.token, (client, identity) => saveProduct(client, identity, command), { csrfToken: session.csrfToken });
  return { account, session, command, product };
}

test('source Product form preserves zero, ordered selections and retries through filtering, editing and retirement', async ({ page }, testInfo) => {
  test.setTimeout(75_000); await page.setViewportSize({ width: 1280, height: 960 });
  const account = await createAccount(owner, { permissions: ['masters.manage'] });
  const lab = await createLaboratoryFixture(owner, account, { repeated: false });
  const tags = (await owner.query(`INSERT INTO tags(organization_id,code,name) VALUES($1,$2,'Alpha-Tag'),($1,$3,'Beta Tag') RETURNING id,name`,
    [account.organizationId, randomUUID(), randomUUID()])).rows;
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, account); await page.getByRole('link', { name: 'Products', exact: true }).click();
  await page.getByRole('button', { name: 'New Product', exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Name is required.', { exact: true })).toBeVisible();
  await expect(page.getByText('Unique Key is required.', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic browser product');
  const key = 'P' + 'x'.repeat(63);
  await page.getByLabel('Unique Key', { exact: true }).fill(key);
  await page.getByLabel('Description', { exact: true }).fill('  Exact product notes  ');
  await page.getByLabel('Abbreviation', { exact: true }).fill('0');
  await page.getByLabel('Job Template', { exact: true }).fill('Synthetic');
  await page.getByRole('option', { name: /Synthetic/ }).click();
  await page.getByLabel('Tags', { exact: true }).fill('Beta'); await page.getByRole('option', { name: 'Beta Tag', exact: true }).click();
  await page.getByLabel('Tags', { exact: true }).fill('Alpha'); await page.getByRole('option', { name: 'Alpha Tag', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.smplfy-rselect__multi-value-label')).toHaveText(['Beta Tag', 'Alpha Tag']);
  await page.route('**/api/masters/products/tags?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic tag lookup failure' } }) }));
  await page.getByLabel('Tags', { exact: true }).fill('unavailable');
  await expect(page.getByText('Synthetic tag lookup failure', { exact: true })).toBeVisible();
  await expect(page.locator('.smplfy-rselect__multi-value-label')).toHaveText(['Beta Tag', 'Alpha Tag']);
  await page.unroute('**/api/masters/products/tags?**'); await page.getByLabel('Tags', { exact: true }).fill('Alpha');
  await expect(page.getByRole('option', { name: 'Alpha Tag', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('product-source-form-desktop.png'), fullPage: true, animations: 'disabled' });
  let attempted;
  await page.route('**/api/masters/products', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempted = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost product save response' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost product save response');
  await expect(page.getByLabel('Unique Key', { exact: true })).toHaveValue(key);
  await page.unroute('**/api/masters/products');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/masters/products') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const response = await saved;
  expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual(attempted);
  const product = await response.json(); expect(product.revision).toBe(1); expect(product.key).toBe(key); expect(product.abbreviation).toBe('0');
  expect(product.tagIds).toEqual([tags[1].id, tags[0].id]); expect(product.jobTemplateId).toBe(lab.template.templateId); expect(product.description).toBe('  Exact product notes  ');
  await page.getByPlaceholder('Search...', { exact: true }).fill('Synthetic browser product'); await expect(page).toHaveURL(/search=Synthetic/);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: product.name, exact: true }) });
  await page.getByRole('button', { name: 'Filters', exact: true }).click(); await page.getByPlaceholder('Filter Tags', { exact: true }).click();
  await page.getByRole('option', { name: 'Beta Tag', exact: true }).click();
  await page.getByLabel('Search Tags filters', { exact: true }).fill('Alpha');
  await page.getByRole('option', { name: 'Alpha-Tag', exact: true }).click();
  await expect(page.getByPlaceholder('Filter Tags', { exact: true })).toHaveValue('Beta Tag, Alpha-Tag');
  await page.route('**/api/masters/products/tags?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic filter lookup failure' } }) }));
  await page.getByLabel('Search Tags filters', { exact: true }).fill('failed');
  await expect(page.locator('.dt-multiselect-dropdown [role="alert"]')).toContainText('Synthetic filter lookup failure');
  await expect(page.getByPlaceholder('Filter Tags', { exact: true })).toHaveValue('Beta Tag, Alpha-Tag');
  await page.unroute('**/api/masters/products/tags?**'); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.dt-multiselect-dropdown [role="alert"]')).toHaveCount(0);
  await page.getByLabel('Search Tags filters', { exact: true }).press('Escape');
  await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Abbreviation', { exact: true })).toHaveValue('0');
  await expect(page.locator('.smplfy-rselect__multi-value-label')).toHaveText(['Beta Tag', 'Alpha Tag']);
  await page.getByLabel('Unique Key', { exact: true }).fill('Revised-Product-Key');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Update', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('product-source-form-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(row).toBeVisible();
  await expect(page).toHaveURL(/search=Synthetic/); await expect(page).toHaveURL(/filters=/);
  await row.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('cell', { name: '0', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Beta Tag, Alpha-Tag', exact: true })).toBeVisible();
  await page.goBack(); await row.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Product', exact: true }); let removal;
  await page.route(`**/api/masters/products/${product.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    removal = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost product delete response' } }) });
  });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog).toContainText('Synthetic lost product delete response');
  await page.unroute(`**/api/masters/products/${product.id}`);
  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/masters/products/${product.id}`) && response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); const deletion = await deleted;
  expect(deletion.status()).toBe(200); expect(deletion.request().postDataJSON()).toEqual(removal);
  await expect(dialog).toBeHidden(); await expect(row).toHaveCount(0);
  const historical = await (await page.request.get(`/api/masters/products/${product.id}?revision=1`)).json();
  expect(historical.tagIds).toEqual(product.tagIds); expect(historical.key).toBe(key); expect(historical.savedBy).toBe(account.userId);
  expect(errors).toEqual([]);
});

test('Product stale saves retain drafts, invalid keys remain visible and optional selections clear explicitly', async ({ page }) => {
  const { account, session, command, product } = await fixture(); await login(page, account); await page.goto(`/products/${product.id}/edit`);
  await page.getByLabel('Name', { exact: true }).fill('Unsaved local product');
  await page.getByLabel('Unique Key', { exact: true }).fill('Invalid key');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByText('Unique Key must start with a letter or number and contain only letters, numbers, dots, slashes, underscores or hyphens.', { exact: true })).toBeVisible();
  await page.getByLabel('Unique Key', { exact: true }).fill('Valid-product-key');
  await withSession(session.token, (client, identity) => saveProduct(client, identity,
    { ...command, revision: 1, requestId: randomUUID(), name: 'Concurrent product' }), { csrfToken: session.csrfToken });
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('The product changed. Reload before saving.');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved local product');
  await page.reload(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Concurrent product');
  await page.getByLabel('Abbreviation', { exact: true }).fill('text'); await page.getByLabel('Abbreviation', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/products$/);
  const latest = await (await page.request.get(`/api/masters/products/${product.id}`)).json();
  expect(latest.abbreviation).toBe(''); expect(latest.jobTemplateId).toBe(null); expect(latest.tagIds).toEqual([]); expect(latest.revision).toBe(3);
});

test('Product read-only pages and API enforce tenant boundaries, permissions, CSRF and list input validation', async ({ page }) => {
  const { account, product } = await fixture(); const foreign = await fixture();
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['masters.read'] });
  await login(page, reader); await page.getByRole('link', { name: 'Products', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Original product', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Product', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'View', exact: true }).click(); await expect(page.getByRole('cell', { name: product.key, exact: true })).toBeVisible();
  await page.goto(`/products/${product.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('permission');
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value;
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
  expect((await page.request.post('/api/masters/products', { headers, data: {} })).status()).toBe(403);
  expect((await page.request.delete(`/api/masters/products/${product.id}`, { headers, data: { requestId: randomUUID(), revision: 1 } })).status()).toBe(403);
  expect((await page.request.post('/api/masters/products', { data: {} })).status()).toBe(403);
  expect((await page.request.get(`/api/masters/products/${foreign.product.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/masters/products/${foreign.product.id}?revision=1`)).status()).toBe(404);
  for (const query of ['%7B', 'null', encodeURIComponent(JSON.stringify({ sort: { key: 'password_hash', dir: 'asc' } }))]) {
    expect((await page.request.get(`/api/masters/products?query=${query}`)).status()).toBe(400);
  }
});

test('clearing existing Product relations preserves hidden sample categories and untouched null abbreviation', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['masters.manage'] });
  const lab = await createLaboratoryFixture(owner, account, { repeated: false });
  const tag = (await owner.query("INSERT INTO tags(organization_id,code,name) VALUES($1,$2,'Clearable tag') RETURNING id", [account.organizationId, randomUUID()])).rows[0];
  const session = await signIn({ identifier: account.username, password: account.password });
  const product = await withSession(session.token, (client, identity) => saveProduct(client, identity, { id: lab.product.id, revision: 1, requestId: randomUUID(),
    name: lab.product.name, key: lab.product.code, description: '', abbreviation: null, jobTemplateId: lab.template.templateId, tagIds: [tag.id] }), { csrfToken: session.csrfToken });
  await login(page, account); await page.goto(`/products/${product.id}/edit`);
  await expect(page.locator('.smplfy-rselect__multi-value-label')).toHaveText(['Clearable tag']);
  const templateField = page.locator('.smplfy-form-element').filter({ has: page.locator('label[for="product-template"]') });
  await expect(templateField.locator('.smplfy-rselect__single-value')).not.toHaveText('');
  await page.route('**/api/masters/products/templates?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic template lookup failure' } }) }));
  await page.getByLabel('Job Template', { exact: true }).fill('failed');
  await expect(page.getByText('Synthetic template lookup failure', { exact: true })).toBeVisible();
  await page.unroute('**/api/masters/products/templates?**'); await page.getByLabel('Job Template', { exact: true }).fill('');
  await page.getByLabel('Job Template', { exact: true }).press('Escape'); await page.getByLabel('Job Template', { exact: true }).press('Backspace');
  await expect(templateField.locator('.smplfy-rselect__single-value')).toHaveCount(0);
  await page.getByLabel('Tags', { exact: true }).click(); await page.getByRole('button', { name: 'Clear all (1)', exact: true }).click();
  await page.keyboard.press('Escape'); await expect(page.locator('.smplfy-rselect__multi-value-label')).toHaveCount(0);
  const saving = page.waitForResponse((response) => response.url().endsWith('/api/masters/products') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); const response = await saving; expect(response.status()).toBe(200);
  const saved = await response.json(); expect(saved.jobTemplateId).toBe(null); expect(saved.tagIds).toEqual([]); expect(saved.abbreviation).toBe(null);
  expect(saved.sampleCategoryIds).toEqual([lab.category.id]); expect(saved.revision).toBe(3);
});
