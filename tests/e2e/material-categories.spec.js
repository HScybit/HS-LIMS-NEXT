import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveMaterialCategory } from '../../src/masters/material-categories.js';
const grantInventory = async account => saveModuleAccessSettings({ ...account, ...await signIn({ identifier: account.username, password: account.password }) },
  emptyModuleAccess().map(module => module.moduleKey === 'inventory' ? { ...module, enabled: true, userIds: [account.userId] } : module));

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const headers = async page => ({ Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value });
async function fixture() {
  const account = await createAccount(owner, { permissions: ['masters.manage', 'settings.manage'] });
  await grantInventory(account);
  const session = await signIn({ identifier: account.username, password: account.password });
  const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Original material category', description: 'Reference', reusable: false, expirable: true };
  const work = callback => withSession(session.token, callback, { csrfToken: session.csrfToken });
  const category = await work((client, identity) => saveMaterialCategory(client, identity, input));
  return { account, input, category, work };
}

test('material category source form, flags and list state survive lost save and delete responses', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const account = await createAccount(owner, { permissions: ['masters.manage', 'settings.manage'] });
  await grantInventory(account);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page, account); await page.getByRole('link', { name: 'Material Categories', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Material Categories', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New Material Category', exact: true }).click();
  for (const name of ['Reusable', 'Expirable']) await expect(page.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('Name is required.', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic browser category');
  await page.getByLabel('Description', { exact: true }).fill('  Exact material notes  ');
  await page.getByRole('checkbox', { name: 'Reusable', exact: true }).check();
  await page.screenshot({ path: testInfo.outputPath('material-category-desktop.png'), fullPage: true, animations: 'disabled' });
  let attempted;
  await page.route('**/api/masters/material-categories', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempted = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost category save response' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost category save response');
  await expect(page.getByRole('checkbox', { name: 'Reusable', exact: true })).toBeChecked();
  await page.unroute('**/api/masters/material-categories');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/masters/material-categories') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const response = await saved;
  expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual(attempted);
  const category = await response.json(); expect(category.revision).toBe(1); expect(category.description).toBe('Exact material notes');
  await page.getByPlaceholder('Search...', { exact: true }).fill('Synthetic browser category'); await expect(page).toHaveURL(/search=Synthetic/);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: category.name, exact: true }) });
  await expect(row.getByRole('cell', { name: 'Yes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.locator('.dt-filter-field').filter({ hasText: 'Reusable' }).locator('select').selectOption('true');
  await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Updated material notes');
  await page.getByRole('checkbox', { name: 'Expirable', exact: true }).check();
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Update', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('material-category-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/material_categories\?.*search=Synthetic/);
  await expect(row).toBeVisible(); await page.setViewportSize({ width: 1280, height: 960 });
  await row.getByRole('link', { name: 'View', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Updated material notes', exact: true })).toBeVisible();
  await page.goBack(); await expect(row).toBeVisible();
  const routePath = `**/api/masters/material-categories/${category.id}`;
  let removal;
  await page.route(routePath, async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    removal = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost category delete response' } }) });
  });
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Synthetic lost category delete response');
  await page.unroute(routePath);
  const deleted = page.waitForResponse(response => response.url().endsWith(`/api/masters/material-categories/${category.id}`) && response.request().method() === 'DELETE');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  const deletedResponse = await deleted; expect(deletedResponse.status()).toBe(200); expect(deletedResponse.request().postDataJSON()).toEqual(removal);
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(row).toHaveCount(0);
  expect((await owner.query('SELECT revision,active FROM material_categories WHERE organization_id=$1 AND id=$2', [account.organizationId, category.id])).rows[0]).toEqual({ revision: 3, active: false });
  expect(errors).toEqual([]);
});

test('stale material category edits preserve the draft and reload restores the saved values', async ({ page }) => {
  const { account, input, category, work } = await fixture(); await login(page, account);
  await page.goto(`/material_categories/${category.id}/edit`);
  await page.getByLabel('Name', { exact: true }).fill('Unsaved local category');
  await page.getByRole('checkbox', { name: 'Reusable', exact: true }).check();
  await work((client, identity) => saveMaterialCategory(client, identity, { ...input, revision: 1, requestId: randomUUID(), name: 'Saved elsewhere' }));
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('The category changed. Reload before saving.');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved local category');
  await expect(page.getByRole('checkbox', { name: 'Reusable', exact: true })).toBeChecked();
  await page.reload(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Saved elsewhere');
  await expect(page.getByRole('checkbox', { name: 'Reusable', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Expirable', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.goto(`/material_categories/${category.id}/edit`); await expect(page.getByRole('checkbox', { name: 'Expirable', exact: true })).not.toBeChecked();
});

test('material category browser access and HTTP guards enforce permissions, tenant isolation and request bounds', async ({ page }) => {
  const { account, input, category } = await fixture(); await login(page, account);
  const payload = { ...input, id: randomUUID(), requestId: randomUUID(), name: 'Another category' };
  expect((await page.request.post('/api/masters/material-categories', { headers: { Origin: 'http://127.0.0.1:3100' }, data: payload })).status()).toBe(403);
  expect((await page.request.post('/api/masters/material-categories', { headers: await headers(page), data: { ...payload, description: 'x'.repeat(140_000) } })).status()).toBe(413);
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['masters.read'] });
  await saveModuleAccessSettings({ ...account, ...await signIn({ identifier: account.username, password: account.password }) },
    emptyModuleAccess().map(module => module.moduleKey === 'inventory' ? { ...module, enabled: true, userIds: [account.userId, reader.userId] } : module));
  await login(page, reader);
  await page.goto('/material_categories'); await expect(page.getByRole('cell', { name: category.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Material Category', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
  await page.goto(`/material_categories/${category.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('You do not have permission');
  expect((await page.request.post('/api/masters/material-categories', { headers: await headers(page), data: payload })).status()).toBe(403);
  expect((await page.request.get(`/api/masters/material-categories/${category.id}?revision=1`)).status()).toBe(200);
  const foreign = await createAccount(owner, { permissions: ['masters.manage'] }); await login(page, foreign);
  expect((await page.request.get(`/api/masters/material-categories/${category.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/masters/material-categories/${category.id}?revision=1`)).status()).toBe(404);
  await page.goto('/material_categories'); await expect(page.getByRole('cell', { name: category.name, exact: true })).toHaveCount(0);
});
