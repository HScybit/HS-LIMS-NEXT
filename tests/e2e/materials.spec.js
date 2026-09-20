import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveMaterialCategory } from '../../src/masters/material-categories.js';
import { saveMaterial } from '../../src/materials/service.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function fixture({ expirable = true, create = true, initialQuantity = '0' } = {}) {
  const account = await createAccount(owner, { permissions: ['masters.manage', 'settings.manage'] }); const session = await signIn({ identifier: account.username, password: account.password });
  const authed = { ...account, ...session };
  await saveModuleAccessSettings(authed, emptyModuleAccess().map(module => module.moduleKey === 'inventory' ? { ...module, enabled: true, userIds: [account.userId] } : module));
  const work = callback => withSession(session.token, callback, { csrfToken: session.csrfToken });
  const category = await work((client, identity) => saveMaterialCategory(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Stock category', expirable }));
  const unit = (await owner.query("INSERT INTO measurement_units(organization_id,code,name,symbol) VALUES($1,$2,'Grams','g') RETURNING id", [account.organizationId, randomUUID()])).rows[0];
  const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Reference powder', code: randomUUID(), description: 'Synthetic stock',
    categoryId: category.id, measurementUnitId: unit.id, initialQuantity, minimumQuantity: '0' };
  const material = create ? await work((client, identity) => saveMaterial(client, identity, input)) : null;
  return { account, work, input, material, category, unit };
}
const dialog = page => page.getByRole('dialog');
async function choose(page, label, option) {
  await dialog(page).getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
const headers = async page => ({ Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value });

test('source material create/edit dialogs retain a lost save, zero quantities and listing state', async ({ page }, testInfo) => {
  const data = await fixture({ create: false }); await login(page, data.account); await page.goto('/materials');
  await page.getByRole('button', { name: 'New Material', exact: true }).click(); await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog(page).getByText('Name is required.', { exact: true })).toBeVisible();
  await dialog(page).getByLabel('Name', { exact: true }).fill('Browser powder'); await dialog(page).getByLabel('Unique Key', { exact: true }).fill('BROWSER_POWDER');
  await choose(page, 'Category', 'Stock category'); await choose(page, 'Unit (UoM)', 'Grams');
  await dialog(page).getByLabel('Min. Quantity', { exact: true }).fill('0'); await dialog(page).getByLabel('Initial Quantity', { exact: true }).fill('0');
  await dialog(page).getByLabel('Description', { exact: true }).fill('A retained draft');
  let dropped = false; let savedId;
  await page.route('**/api/materials', async route => {
    if (route.request().method() === 'POST' && !dropped) { dropped = true; const response = await route.fetch(); expect(response.status()).toBe(200); savedId = (await response.json()).id; await route.abort('failed'); }
    else await route.continue();
  });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog(page).locator('.alert[role="alert"]')).toBeVisible();
  await expect(dialog(page).getByLabel('Description', { exact: true })).toHaveValue('A retained draft');
  await page.screenshot({ path: testInfo.outputPath('material-desktop-form.png'), fullPage: true, animations: 'disabled' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Browser powder', exact: true })).toBeVisible();
  expect(Number((await owner.query('SELECT count(*) FROM material_versions WHERE material_id=$1', [savedId])).rows[0].count)).toBe(1);
  await page.getByPlaceholder('Search...', { exact: true }).fill('Browser powder');
  await page.getByRole('button', { name: 'Edit', exact: true }).click(); await dialog(page).getByLabel('Description', { exact: true }).fill('Edited description');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByPlaceholder('Search...', { exact: true })).toHaveValue('Browser powder'); await expect(page.getByRole('cell', { name: 'Edited description', exact: true })).toBeVisible();
});

test('manual stock dialogs recover a lost receipt, retain expiry and block exhausted batches', async ({ page }, testInfo) => {
  test.setTimeout(60000); const data = await fixture(); await login(page, data.account); await page.goto(`/materials/${data.material.id}`);
  await page.getByRole('button', { name: 'New Transaction', exact: true }).click(); await expect(dialog(page).getByLabel('Unit (UoM)', { exact: true })).toHaveValue('Grams');
  await dialog(page).getByLabel('Quantity', { exact: true }).fill('2'); await dialog(page).getByLabel('Cost', { exact: true }).fill('0');
  await dialog(page).getByLabel('Make/Supplier', { exact: true }).fill('Supplier A'); await dialog(page).getByLabel('Batch/Serial No.', { exact: true }).fill('Batch A');
  await dialog(page).getByLabel('Expiry Date', { exact: true }).fill('31/12/2099'); await dialog(page).getByLabel('Quantity', { exact: true }).focus();
  let dropped = false;
  await page.route(`**/api/materials/${data.material.id}/transactions`, async route => {
    if (!dropped) { dropped = true; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); } else await route.continue();
  });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog(page).locator('.alert[role="alert"]')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('cell', { name: '31/12/2099', exact: true })).toBeVisible();
  expect(Number((await owner.query('SELECT count(*) FROM material_transactions WHERE material_id=$1', [data.material.id])).rows[0].count)).toBe(1);
  for (const [type, quantity] of [['Out', '0.5'], ['Out - Damaged', '1.5']]) {
    await page.getByRole('button', { name: 'New Transaction', exact: true }).click(); await dialog(page).getByRole('tab', { name: type, exact: true }).click();
    await dialog(page).getByRole('combobox', { name: 'Batch/Serial No.', exact: true }).click(); await page.getByRole('option', { name: /Batch A/ }).click();
    await dialog(page).getByLabel('Quantity', { exact: true }).fill(quantity); await expect(dialog(page).getByLabel('Make/Supplier', { exact: true })).toHaveValue('Supplier A');
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  }
  await expect(page.getByText('3 Transactions', { exact: true })).toBeVisible(); await page.getByRole('tab', { name: 'OUT', exact: true }).click();
  await expect(page.getByText('1 Transactions', { exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: '0.5 Grams', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'All Transactions', exact: true }).click();
  await expect(page.getByText('3 Transactions', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '31/12/2099', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('material-desktop-detail.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'New Transaction', exact: true }).click(); await dialog(page).getByRole('tab', { name: 'Out', exact: true }).click();
  await dialog(page).getByRole('combobox', { name: 'Batch/Serial No.', exact: true }).click(); await expect(page.getByRole('option', { name: /Batch A/ })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape'); await expect(dialog(page)).toBeVisible(); await expect(dialog(page).getByRole('combobox', { name: 'Batch/Serial No.', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape'); await expect(dialog(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'New Transaction', exact: true }).click(); await dialog(page).getByLabel('Batch/Serial No.', { exact: true }).fill('batch a');
  await expect(dialog(page).getByText('This Batch/Serial No already exists. Enter a unique one.', { exact: true })).toBeVisible();
});

test('stale material edits and lookup failures keep the draft, while read-only and foreign users remain restricted', async ({ page }) => {
  const data = await fixture(); await login(page, data.account); await page.goto('/materials'); let interrupted = false;
  await page.route('**/api/materials/choices?**', async route => {
    if (!interrupted && new URL(route.request().url()).searchParams.get('kind') === 'unit') { interrupted = true; await route.abort('failed'); } else await route.continue();
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).click(); await expect(dialog(page).getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Retry', exact: true }).click(); await expect(dialog(page).getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await dialog(page).getByLabel('Description', { exact: true }).fill('My local draft');
  await data.work((client, identity) => saveMaterial(client, identity, { ...data.input, revision: 1, requestId: randomUUID(), description: 'Concurrent edit' }));
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog(page).locator('.alert[role="alert"]')).toContainText('Reload before saving');
  await expect(dialog(page).getByLabel('Description', { exact: true })).toHaveValue('My local draft');
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  const reader = await createAccount(owner, { organizationId: data.account.organizationId, permissions: ['masters.read'] });
  await saveModuleAccessSettings({ ...data.account, ...await signIn({ identifier: data.account.username, password: data.account.password }) },
    emptyModuleAccess().map(module => module.moduleKey === 'inventory' ? { ...module, enabled: true, userIds: [data.account.userId, reader.userId] } : module));
  await login(page, reader); await page.goto('/materials');
  await expect(page.getByRole('link', { name: data.material.name, exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'New Material', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await page.goto(`/materials/${data.material.id}`); await expect(page.getByRole('button', { name: 'New Transaction', exact: true })).toHaveCount(0);
  const forbidden = await page.request.post('/api/materials', { headers: await headers(page), data: data.input }); expect(forbidden.status()).toBe(403);
  const foreign = await fixture(); const hidden = await page.request.get(`/api/materials/${foreign.material.id}`); expect(hidden.status()).toBe(404);
  const choices = await page.request.get(`/api/materials/choices?kind=unit&selectedId=${foreign.unit.id}`); expect((await choices.json()).selected).toBeNull();
});

test('material mobile controls and QR printing preserve the source label without running inline scripts', async ({ page }, testInfo) => {
  const data = await fixture({ initialQuantity: '2.5' }); await login(page, data.account); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/materials/${data.material.id}`);
  await expect(page.getByRole('img', { name: `QR code linking to ${data.material.name}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('material-mobile-detail.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'New Transaction', exact: true }).click(); await expect(dialog(page).getByLabel('Quantity', { exact: true })).toBeVisible();
  await expect(dialog(page).getByLabel('Quantity', { exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('material-mobile-transaction.png'), fullPage: true, animations: 'disabled' });
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { const open = window.open.bind(window); window.open = (...args) => { const popup = open(...args); if (popup) popup.print = () => { popup.__printed = true; }; return popup; }; });
  const opened = page.waitForEvent('popup'); await page.getByRole('button', { name: 'Print QR', exact: true }).click(); const popup = await opened;
  await expect(popup.getByRole('heading', { name: data.material.name, exact: true })).toBeVisible(); await expect.poll(() => popup.evaluate(() => window.__printed)).toBe(true);
  expect(await popup.locator('script').count()).toBe(0); expect(await popup.getByRole('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  const closed = popup.waitForEvent('close'); await popup.evaluate(() => window.dispatchEvent(new Event('afterprint'))); await closed;
});

test('material deletion rejects missing CSRF and recovers a lost response while preserving opening history', async ({ page }) => {
  const data = await fixture({ initialQuantity: '1.0000000001' }); await login(page, data.account); await page.goto('/materials');
  const path = `/api/materials/${data.material.id}`;
  const denied = await page.request.delete(path, { headers: { Origin: 'http://127.0.0.1:3100' }, data: { requestId: randomUUID(), revision: 1 } });
  expect(denied.status()).toBe(403); let dropped = false;
  await page.route(`**${path}`, async route => {
    if (route.request().method() === 'DELETE' && !dropped) { dropped = true; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Delete', exact: true }).click(); await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog(page).locator('.alert[role="alert"]')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: data.material.name, exact: true })).toHaveCount(0);
  expect((await page.request.get(path)).status()).toBe(404);
  const original = await page.request.get(`${path}?revision=1`); expect(original.status()).toBe(200); expect((await original.json()).material.initialQuantity).toBe('1.0000000001');
  expect(Number((await owner.query('SELECT count(*) FROM material_versions WHERE material_id=$1', [data.material.id])).rows[0].count)).toBe(2);
});
