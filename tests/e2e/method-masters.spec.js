import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveMethod } from '../../src/masters/methods.js';

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
  const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Original method', uuid: `ISO ${randomUUID()}`,
    description: '', decimalScale: 0, parseNumber: false, accessUserIds: [account.userId] };
  const method = await withSession(session.token, (client, identity) => saveMethod(client, identity, command), { csrfToken: session.csrfToken });
  return { account, session, command, method };
}

test('source method form preserves defaults, selected labels and zero through lost responses, editing and retirement', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  const account = await createAccount(owner, { permissions: ['masters.manage'] });
  const second = await createAccount(owner, { organizationId: account.organizationId, permissions: [] });
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [account.userId, 'Alpha-Analyst']);
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [second.userId, 'Beta Analyst']);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, account); await page.goto('/method_of_analysis');
  await page.getByRole('button', { name: 'New Method of Analysis', exact: true }).click();
  await expect(page.getByLabel('Decimal Places', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('Convert Number', { exact: true })).toHaveValue('false');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Name is required.', { exact: true })).toBeVisible();
  await expect(page.getByText('UUID is required.', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic browser method');
  const authoredUuid = 'ISO 123 / ' + 'x'.repeat(90);
  await page.getByLabel('UUID', { exact: true }).fill(authoredUuid);
  await page.getByLabel('Description', { exact: true }).fill('  Exact method notes  ');
  await page.getByLabel('Decimal Places', { exact: true }).fill('0');
  await page.getByLabel('Allow access to', { exact: true }).fill('Alpha');
  await page.getByRole('option', { name: 'Alpha Analyst', exact: true }).click();
  await page.getByLabel('Allow access to', { exact: true }).fill('Beta');
  await page.getByRole('option', { name: 'Beta Analyst', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.smplfy-rselect__multi-value-label')).toHaveText(['Alpha Analyst', 'Beta Analyst']);
  await page.route('**/api/masters/methods/users?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic user lookup failure' } }) }));
  await page.getByLabel('Allow access to', { exact: true }).fill('unavailable');
  await expect(page.getByText('Synthetic user lookup failure', { exact: true })).toBeVisible();
  await expect(page.locator('.smplfy-rselect__multi-value-label')).toHaveText(['Alpha Analyst', 'Beta Analyst']);
  await page.unroute('**/api/masters/methods/users?**');
  await page.getByLabel('Allow access to', { exact: true }).fill('Alpha');
  await expect(page.getByRole('option', { name: 'Alpha Analyst', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('method-source-form-desktop.png'), fullPage: true, animations: 'disabled' });
  let attempted;
  await page.route('**/api/masters/methods', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempted = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost method save response' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost method save response');
  await expect(page.getByLabel('UUID', { exact: true })).toHaveValue(authoredUuid);
  await page.unroute('**/api/masters/methods');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/masters/methods') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const response = await saved;
  expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual(attempted);
  const method = await response.json(); expect(method.uuid).toBe(authoredUuid); expect(method.decimalScale).toBe(0); expect(method.parseNumber).toBe(false);
  expect(method.accessUserIds).toEqual([account.userId, second.userId]); expect(method.description).toBe('  Exact method notes  ');
  await page.getByPlaceholder('Search...', { exact: true }).fill('Synthetic browser method'); await expect(page).toHaveURL(/search=Synthetic/);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: method.name, exact: true }) });
  await expect(row.getByRole('cell', { name: 'No', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.locator('.dt-filter-field').filter({ hasText: 'Convert Number' }).locator('select').selectOption('false');
  await page.getByPlaceholder('Filter Allowed Access', { exact: true }).fill('Beta Analyst');
  await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Decimal Places', { exact: true })).toHaveValue('0');
  await expect(page.locator('.smplfy-rselect__multi-value-label')).toHaveText(['Alpha Analyst', 'Beta Analyst']);
  await page.getByLabel('Description', { exact: true }).fill('Updated notes');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Update', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('method-source-form-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(row).toBeVisible();
  await expect(page).toHaveURL(/search=Synthetic/); await expect(page).toHaveURL(/filters=/);
  await row.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'NO', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '0', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Alpha-Analyst, Beta Analyst', exact: true })).toBeVisible();
  await page.goBack(); await row.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Method of Analysis', exact: true }); let removal;
  await page.route(`**/api/masters/methods/${method.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    removal = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost method delete response' } }) });
  });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog).toContainText('Synthetic lost method delete response');
  await page.unroute(`**/api/masters/methods/${method.id}`);
  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/masters/methods/${method.id}`) && response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); const deletion = await deleted;
  expect(deletion.status()).toBe(200); expect(deletion.request().postDataJSON()).toEqual(removal);
  await expect(dialog).toBeHidden(); await expect(row).toHaveCount(0);
  const historical = await (await page.request.get(`/api/masters/methods/${method.id}?revision=1`)).json();
  expect(historical.accessUserIds).toEqual(method.accessUserIds); expect(historical.decimalScale).toBe(0); expect(historical.savedBy).toBe(account.userId);
  expect(errors).toEqual([]);
});

test('method stale saves keep drafts and source YES/NO selection stores real booleans', async ({ page }) => {
  const { account, session, command, method } = await fixture(); await login(page, account); await page.goto(`/method_of_analysis/${method.id}/edit`);
  await page.getByLabel('Name', { exact: true }).fill('Unsaved local method');
  await page.getByLabel('Convert Number', { exact: true }).selectOption('true');
  await withSession(session.token, (client, identity) => saveMethod(client, identity,
    { ...command, revision: 1, requestId: randomUUID(), name: 'Concurrent method' }), { csrfToken: session.csrfToken });
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('The method changed. Reload before saving.');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved local method');
  await expect(page.getByLabel('Convert Number', { exact: true })).toHaveValue('true');
  await page.reload(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Concurrent method');
  await page.getByLabel('Convert Number', { exact: true }).selectOption('true');
  await page.getByLabel('Decimal Places', { exact: true }).fill('13');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByText('Decimal Places must be an integer between 0 and 12.', { exact: true })).toBeVisible();
  await page.getByLabel('Decimal Places', { exact: true }).fill('12');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/method_of_analysis$/);
  const latest = await (await page.request.get(`/api/masters/methods/${method.id}`)).json();
  expect(latest.parseNumber).toBe(true); expect(latest.decimalScale).toBe(12); expect(latest.revision).toBe(3);
});

test('method read-only screens and API enforce permissions, tenant boundaries, CSRF and list validation', async ({ page }) => {
  const { account, method } = await fixture(); const foreign = await fixture();
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['masters.read'] });
  await login(page, reader); await page.goto('/method_of_analysis');
  await expect(page.getByRole('cell', { name: 'Original method', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Method of Analysis', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'NO', exact: true })).toBeVisible();
  await page.goto(`/method_of_analysis/${method.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('permission');
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value;
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
  expect((await page.request.post('/api/masters/methods', { headers, data: {} })).status()).toBe(403);
  expect((await page.request.delete(`/api/masters/methods/${method.id}`, { headers, data: { requestId: randomUUID(), revision: 1 } })).status()).toBe(403);
  expect((await page.request.post('/api/masters/methods', { data: {} })).status()).toBe(403);
  expect((await page.request.get(`/api/masters/methods/${foreign.method.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/masters/methods/${foreign.method.id}?revision=1`)).status()).toBe(404);
  for (const query of ['%7B', 'null', encodeURIComponent(JSON.stringify({ sort: { key: 'password_hash', dir: 'asc' } }))]) {
    expect((await page.request.get(`/api/masters/methods?query=${query}`)).status()).toBe(400);
  }
});
