import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';

let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await owner.end(); });
const endpoint = '/api/administration/business-units';
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
const headers = async page => ({ Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value });
const command = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, code: 'UNIT-' + randomUUID(), name: 'Browser Unit', description: 'Quality', active: true, ...changes });
async function save(page, input) { return page.request.post(endpoint, { headers: await headers(page), data: input }); }

test('source Units form preserves filters and exact retries, then retires and reactivates with history', async ({ page }, info) => {
  const actor = await createAccount(owner, { permissions: ['users.manage'] }); await login(page, actor);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('link', { name: 'Units', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Units', exact: true })).toBeVisible();
  await page.getByPlaceholder('Search...', { exact: true }).fill('Browser Unit'); await expect(page).toHaveURL(/search=Browser/);
  await page.getByRole('button', { name: 'New Unit', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'Active', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('Required', { exact: true })).toHaveCount(3);
  await page.getByLabel('Name', { exact: true }).fill('Browser Unit'); await page.getByLabel('Description', { exact: true }).fill('Quality'); await page.getByLabel('Code', { exact: true }).fill('QU-1');
  await page.route('**' + endpoint, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200);
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic lost response' } } });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost response');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Browser Unit'); await page.unroute('**' + endpoint);
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page).toHaveURL(url => url.pathname === '/unit_management' && url.searchParams.get('search') === 'Browser Unit');
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Browser Unit', exact: true }) });
  await row.getByRole('link', { name: 'Edit', exact: true }).click(); await expect(page.getByLabel('Code', { exact: true })).toHaveValue('QU-1');
  await page.screenshot({ path: info.outputPath('business-unit-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('business-unit-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('checkbox', { name: 'Active', exact: true }).uncheck(); await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(row.getByRole('cell', { name: 'No', exact: true })).toBeVisible();
  await row.getByRole('link', { name: 'Edit', exact: true }).click(); await page.getByRole('checkbox', { name: 'Active', exact: true }).check();
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(row.getByRole('cell', { name: 'Yes', exact: true })).toBeVisible();
  const history = (await owner.query('SELECT revision,active FROM business_unit_versions WHERE organization_id=$1 ORDER BY revision', [actor.organizationId])).rows;
  expect(history).toEqual([{ revision: 1, active: true }, { revision: 2, active: false }, { revision: 3, active: true }]); expect(errors).toEqual([]);
});

test('load retries and stale saves preserve the local unit draft', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['users.manage'] }); await login(page, actor); const input = command(); expect((await save(page, input)).status()).toBe(200);
  await page.route(`**${endpoint}/${input.id}`, route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic load failure' } } }));
  await page.goto(`/unit_management/${input.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic load failure');
  await page.unroute(`**${endpoint}/${input.id}`); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Local draft');
  expect((await save(page, { ...input, revision: 1, requestId: randomUUID(), name: 'Other editor' })).status()).toBe(200);
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Reload before saving');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Local draft');
});

test('readers can view inactive units; write and CSRF requests are denied', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['users.manage'] }); await login(page, actor); const input = command({ active: false }); expect((await save(page, input)).status()).toBe(200);
  expect((await page.request.post(endpoint, { headers: { ...(await headers(page)), 'X-CSRF-Token': 'invalid' }, data: command() })).status()).toBe(403);
  const reader = await createAccount(owner, { organizationId: actor.organizationId, permissions: ['users.read'] }); await login(page, reader); await page.goto('/unit_management');
  await expect(page.getByRole('cell', { name: 'Browser Unit', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'New Unit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0); await page.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Quality', exact: true })).toBeVisible();
  expect((await save(page, command())).status()).toBe(403); await page.goto(`/unit_management/${input.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('do not have permission');
});
