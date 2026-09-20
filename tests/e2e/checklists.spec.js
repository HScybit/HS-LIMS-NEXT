import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createChecklist } from '../../src/checklists/service.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function headers(page) { return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value }; }
async function fixture(changes = {}) {
  const account = await createAccount(owner, { permissions: ['checklists.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Browser checklist', isActive: false,
    items: [{ id: randomUUID(), prompt: '0' }, { id: randomUUID(), prompt: 'Verify the results' }], ...changes };
  await withSession(session.token, (client, identity) => createChecklist(client, identity, input), { csrfToken: session.csrfToken });
  return { account, input };
}

test('source checklist controls and view preserve intent through lost create and delete responses', async ({ page }, testInfo) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 1280, height: 960 }); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const account = await createAccount(owner, { permissions: ['checklists.manage'] }); await login(page, account);
  await page.goto('/checklists'); await page.getByRole('button', { name: 'New Checklist', exact: true }).click();
  await expect(page.getByLabel('Is Active?', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('Name is required.', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Browser created checklist'); await page.getByLabel('Line item 1', { exact: true }).fill('Clear this');
  await page.getByRole('button', { name: 'Remove line item 1', exact: true }).click(); await expect(page.getByLabel('Line item 1', { exact: true })).toHaveValue('');
  await page.getByLabel('Line item 1', { exact: true }).fill('0'); await page.getByRole('button', { name: 'Add line item', exact: true }).click();
  await page.getByLabel('Line item 2', { exact: true }).fill('  0  '); await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Checklist line items must be unique.');
  await page.getByLabel('Line item 2', { exact: true }).fill('Verify <script>plain text</script>');
  await page.screenshot({ path: testInfo.outputPath('checklist-form-desktop.png'), fullPage: true, animations: 'disabled' });
  let attempted;
  await page.route('**/api/checklists', async (route) => {
    if (route.request().method() !== 'POST') return route.continue(); attempted = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost checklist creation response' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost checklist creation response');
  await expect(page.getByLabel('Line item 1', { exact: true })).toHaveValue('0'); await expect(page.getByLabel('Is Active?', { exact: true })).not.toBeChecked();
  await page.unroute('**/api/checklists'); const retry = page.waitForResponse((response) => response.url().endsWith('/api/checklists') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const retried = await retry; expect(retried.status()).toBe(201); expect(retried.request().postDataJSON()).toEqual(attempted);
  await expect(page).toHaveURL(/\/checklists$/); const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Browser created checklist', exact: true }) });
  await expect(row.getByRole('cell', { name: 'Inactive', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('checklist-list-desktop.png'), fullPage: true, animations: 'disabled' });
  await row.getByRole('link', { name: 'View', exact: true }).click(); await expect(page).toHaveURL(/\/view\?/);
  await expect(page.getByRole('cell', { name: '0, Verify <script>plain text</script>', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'No', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('checklist-view-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.goBack(); await row.getByRole('button', { name: 'Delete', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Delete Checklist', exact: true });
  let deletion;
  await page.route(`**/api/checklists/${attempted.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue(); deletion = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost checklist deletion response' } }) });
  });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog).toContainText('Synthetic lost checklist deletion response');
  await page.unroute(`**/api/checklists/${attempted.id}`); const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); expect((await deleted).request().postDataJSON()).toEqual(deletion);
  await expect(dialog).toBeHidden(); await expect(row).toHaveCount(0);
  const history = await (await page.request.get(`/api/checklists/${attempted.id}?revision=1`)).json(); expect(history.savedBy).toBe(account.userId); expect(history.items[0].prompt).toBe('0');
  expect(errors).toEqual([]);
});

test('checklist active filtering, lookup retries, stale drafts and maximum-sized edits preserve source navigation', async ({ page }, testInfo) => {
  test.setTimeout(60_000); const { account, input } = await fixture({ items: Array.from({ length: 200 }, (_, index) => ({ id: randomUUID(), prompt: `Item ${index + 1}` })) });
  await login(page, account); await page.goto('/checklists'); await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.locator('.dt-filter-field').filter({ has: page.getByText('isActive', { exact: true }) }).locator('select').selectOption('false');
  await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(page).toHaveURL(/filters=/);
  await expect(page.getByRole('cell', { name: input.name, exact: true })).toBeVisible();
  const listingPath = new URL(page.url()).pathname + new URL(page.url()).search;
  await page.route(`**/api/checklists/${input.id}`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic checklist lookup failure' } }) }));
  await page.getByRole('link', { name: 'Edit', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic checklist lookup failure');
  await page.unroute(`**/api/checklists/${input.id}`); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByLabel('Line item 200', { exact: true })).toHaveValue('Item 200'); await expect(page.getByRole('button', { name: 'Add line item', exact: true })).toBeDisabled();
  await page.getByLabel('Name', { exact: true }).fill('Unsaved stale name');
  expect((await page.request.patch(`/api/checklists/${input.id}`, { headers: await headers(page), data: { requestId: randomUUID(), revision: 1, name: 'Concurrent checklist name' } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('The checklist changed in another session.');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved stale name');
  await page.reload(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Concurrent checklist name');
  await page.getByLabel('Line item 200', { exact: true }).fill('Last revised check');
  await page.getByLabel('Is Active?', { exact: true }).check(); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Update', exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('checklist-form-mobile.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(listingPath);
  await expect(page.getByRole('cell', { name: 'Concurrent checklist name', exact: true })).toHaveCount(0);
  const saved = await (await page.request.get(`/api/checklists/${input.id}`)).json(); expect(saved.isActive).toBe(true); expect(saved.items).toHaveLength(200);
  expect(saved.items.map((item) => item.id)).toEqual(input.items.map((item) => item.id)); expect(saved.items[199].prompt).toBe('Last revised check');
  const first = await (await page.request.get(`/api/checklists/${input.id}?revision=1`)).json(); expect(first.items[199].prompt).toBe('Item 200');
});

test('checklist APIs and read-only controls enforce permission, tenant, revision, identity and CSRF boundaries', async ({ page, browser }) => {
  test.setTimeout(60_000); const { account, input } = await fixture();
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['checklists.read'] }); await login(page, reader); await page.goto('/checklists');
  await expect(page.getByRole('cell', { name: input.name, exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'New Checklist', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'View', exact: true }).click(); await expect(page.getByRole('cell', { name: '0, Verify the results', exact: true })).toBeVisible();
  const creation = { ...input, id: randomUUID(), requestId: randomUUID() };
  expect((await page.request.post('/api/checklists', { headers: await headers(page), data: creation })).status()).toBe(403);
  for (const method of ['patch', 'delete']) expect((await page.request[method](`/api/checklists/${input.id}`, { headers: await headers(page), data: { requestId: randomUUID(), revision: 1 } })).status()).toBe(403);
  await page.goto(`/checklists/${input.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('You do not have permission to manage checklists.');
  await login(page, account); const validHeaders = await headers(page);
  expect((await page.request.post('/api/checklists', { headers: { Origin: validHeaders.Origin }, data: creation })).status()).toBe(403);
  expect((await page.request.post('/api/checklists', { headers: { ...validHeaders, Origin: 'https://example.invalid' }, data: creation })).status()).toBe(403);
  for (const field of ['id', 'organizationId', 'savedBy', 'retiredAt']) expect((await page.request.patch(`/api/checklists/${input.id}`, { headers: validHeaders, data: { requestId: randomUUID(), revision: 1, [field]: randomUUID() } })).status()).toBe(400);
  expect((await page.request.get('/api/checklists?query=null')).status()).toBe(400); expect((await page.request.get('/api/checklists?query=%7B')).status()).toBe(400);
  expect((await page.request.get(`/api/checklists/${input.id}?revision=0`)).status()).toBe(400);
  expect((await page.request.post('/api/checklists', { headers: validHeaders, data: creation })).status()).toBe(409);
  const foreign = await createAccount(owner, { permissions: ['checklists.manage'] }); await login(page, foreign);
  expect((await page.request.get(`/api/checklists/${input.id}`)).status()).toBe(404); expect((await page.request.get(`/api/checklists/${input.id}?revision=1`)).status()).toBe(404);
  const anonymous = await browser.newContext(); try { expect((await anonymous.request.get('http://127.0.0.1:3100/api/checklists')).status()).toBe(401); } finally { await anonymous.close(); }
});
