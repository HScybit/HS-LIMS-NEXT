import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createRole } from '../../src/roles/service.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies();
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function headers(page) {
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value };
}
async function fixture(changes = {}) {
  const account = await createAccount(owner, { permissions: ['roles.manage', 'settings.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const command = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Browser analyst', description: '0', defaultPath: '/samples',
    permissionCodes: ['templates.read'], capabilityKeys: ['can_self_allocate', 'can_access_all_ds'], ...changes };
  await withSession(session.token, (client, identity) => createRole(client, identity, command), { csrfToken: session.csrfToken });
  return { account, command };
}

test('source Role Master list, form and view preserve input through lost create and delete responses', async ({ page }, testInfo) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 1280, height: 960 });
  const account = await createAccount(owner, { permissions: ['roles.manage'] }); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, account); await page.getByRole('link', { name: 'Role Master', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Role Master', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New Role', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('Name is required.', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Browser created role'); await page.getByLabel('Description', { exact: true }).fill('0');
  await page.getByLabel('Default Url', { exact: true }).fill('javascript:alert("plain metadata")');
  await expect(page.getByLabel('DMS Access?', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Can Generate Prof. Invoice?', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Can Self Allocate?', { exact: true })).toHaveCount(0);
  await page.getByLabel('Is Admin?', { exact: true }).check(); await page.getByLabel('Is Creator?', { exact: true }).check();
  await page.getByLabel('Can Create Sample?', { exact: true }).check(); await page.getByLabel('Access all Datasheets?', { exact: true }).check();
  await page.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('role-form-desktop.png'), fullPage: true, animations: 'disabled' });
  let attempted;
  await page.route('**/api/roles', async (route) => {
    if (route.request().method() !== 'POST') return route.continue(); attempted = route.request().postDataJSON();
    expect((await route.fetch()).status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost role creation response' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost role creation response');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Browser created role'); await expect(page.getByLabel('Is Admin?', { exact: true })).toBeChecked();
  await page.unroute('**/api/roles'); const retry = page.waitForResponse((response) => response.url().endsWith('/api/roles') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const retried = await retry;
  expect(retried.status()).toBe(201); expect(retried.request().postDataJSON()).toEqual(attempted);
  await page.getByPlaceholder('Search...', { exact: true }).fill('Browser created role');
  await expect(page.getByRole('cell', { name: `Reader ${account.roleId}`, exact: true })).toHaveCount(0);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Browser created role', exact: true }) });
  await expect(row).toBeVisible(); await expect(row.locator('.permission-badges span')).toHaveText(['CAN ADMIN', 'CAN CREATE SAMPLE', 'CAN ACCESS ALL DS']);
  await page.screenshot({ path: testInfo.outputPath('role-list-desktop.png'), fullPage: true, animations: 'disabled' });
  await row.getByRole('button', { name: 'View', exact: true }).click(); const view = page.getByRole('dialog', { name: 'View Role', exact: true });
  await expect(view.getByRole('cell', { name: '0', exact: true })).toBeVisible();
  await expect(view.getByText('javascript:alert("plain metadata")', { exact: true })).toBeVisible(); await expect(view.locator('a')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath('role-view-mobile.png'), fullPage: true, animations: 'disabled' });
  await view.getByRole('button', { name: 'Close modal', exact: true }).click();
  await row.getByRole('button', { name: 'Delete', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Delete Role', exact: true });
  let deletion;
  await page.route(`**/api/roles/${attempted.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue(); deletion = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost role deletion response' } }) });
  });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog).toContainText('Synthetic lost role deletion response');
  await page.unroute(`**/api/roles/${attempted.id}`); const removed = page.waitForResponse((response) => response.url().endsWith(`/api/roles/${attempted.id}`) && response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); expect((await removed).request().postDataJSON()).toEqual(deletion);
  await expect(dialog).toBeHidden(); await expect(row).toHaveCount(0);
  const history = await (await page.request.get(`/api/roles/${attempted.id}?revision=1`)).json(); expect(history.savedBy).toBe(account.userId); expect(history.permissionCodes).toEqual([]);
  expect(errors).toEqual([]);
});

test('source self-allocation setting updates visibility while role edits preserve hidden capability and API permissions', async ({ page }, testInfo) => {
  test.setTimeout(60_000); const { account, command } = await fixture(); await login(page, account);
  await page.goto(`/administration/roles/${command.id}/edit`); await expect(page.getByLabel('Name', { exact: true })).toHaveValue(command.name);
  await expect(page.getByLabel('Can Self Allocate?', { exact: true })).toHaveCount(0);
  await page.getByLabel('Description', { exact: true }).fill('Hidden selection retained');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/role_management$/);
  let saved = await (await page.request.get(`/api/roles/${command.id}`)).json(); expect(saved.permissionCodes).toEqual(['templates.read']); expect(saved.capabilityKeys).toContain('can_self_allocate');
  await page.goto('/organization_settings'); await page.getByRole('tab', { name: 'TR Settings', exact: true }).click();
  await page.getByLabel('Enable Self Allocation', { exact: true }).check();
  const settingSave = page.waitForResponse((response) => response.url().endsWith('/api/organization-settings/laboratory') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click(); expect((await settingSave).status()).toBe(200);
  await page.goto(`/role_management/${command.id}/edit`); await expect(page.getByLabel('Can Self Allocate?', { exact: true })).toBeChecked();
  await page.getByLabel('Description', { exact: true }).fill('Unsaved text survives visibility changes');
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Update', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('role-form-mobile.png'), fullPage: true, animations: 'disabled' });
  const settings = await (await page.request.get('/api/organization-settings/laboratory')).json();
  expect((await page.request.put('/api/organization-settings/laboratory', { headers: await headers(page), data: { revision: settings.settings.revision,
    autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null, selfAllocationEnabled: false } })).status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByLabel('Can Self Allocate?', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Unsaved text survives visibility changes');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/role_management$/);
  saved = await (await page.request.get(`/api/roles/${command.id}`)).json(); expect(saved.capabilityKeys).toContain('can_self_allocate'); expect(saved.permissionCodes).toEqual(['templates.read']);
  await page.reload(); await expect(page.getByText('CAN SELF ALLOCATE', { exact: true })).toHaveCount(0);
});

test('Role Master read-only controls and APIs enforce permissions, tenants, identity fields, origin and CSRF', async ({ page, browser }) => {
  const { account, command } = await fixture();
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['roles.read'] }); await login(page, reader);
  await page.goto('/administration/roles'); await expect(page.getByRole('cell', { name: command.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Role', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Forbidden' };
  expect((await page.request.post('/api/roles', { headers: await headers(page), data: input })).status()).toBe(403);
  expect((await page.request.patch(`/api/roles/${command.id}`, { headers: await headers(page), data: { requestId: randomUUID(), revision: 1, name: 'Forbidden' } })).status()).toBe(403);
  expect((await page.request.delete(`/api/roles/${command.id}`, { headers: await headers(page), data: { requestId: randomUUID(), revision: 1 } })).status()).toBe(403);
  expect((await page.request.get('/api/organization-settings/laboratory')).status()).toBe(403); expect((await page.request.get('/api/roles/settings')).status()).toBe(200);
  await page.goto('/administration/roles/new'); await expect(page.locator('.alert[role="alert"]')).toContainText('You do not have permission to manage roles.');
  await login(page, account); const validHeaders = await headers(page);
  expect((await page.request.post('/api/roles', { headers: { Origin: validHeaders.Origin }, data: input })).status()).toBe(403);
  expect((await page.request.post('/api/roles', { headers: { ...validHeaders, Origin: 'https://example.invalid' }, data: input })).status()).toBe(403);
  for (const field of ['id', 'organizationId', 'protected', 'savedBy']) {
    expect((await page.request.patch(`/api/roles/${command.id}`, { headers: validHeaders, data: { requestId: randomUUID(), revision: 1, name: command.name, [field]: randomUUID() } })).status()).toBe(400);
  }
  expect((await page.request.get('/api/roles?query=null')).status()).toBe(400);
  expect((await page.request.get(`/api/roles?query=${'x'.repeat(16_001)}`)).status()).toBe(413);
  const foreign = await createAccount(owner, { permissions: ['roles.manage'] }); await login(page, foreign);
  expect((await page.request.get(`/api/roles/${command.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/roles/${command.id}?revision=1`)).status()).toBe(404);
  const anonymous = await browser.newContext();
  try { expect((await anonymous.request.get('http://127.0.0.1:3100/api/roles')).status()).toBe(401); } finally { await anonymous.close(); }
});

test('role lookup failures, duplicate names and stale edits retain the draft for correction or explicit reload', async ({ page }) => {
  const { account, command } = await fixture(); await login(page, account);
  await page.route('**/api/roles/settings', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic role settings failure' } }) }));
  await page.goto('/role_management/new'); await page.getByLabel('Name', { exact: true }).fill(command.name);
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic role settings failure'); await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  await page.unroute('**/api/roles/settings'); await page.getByRole('button', { name: 'Retry loading settings', exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('A role with this name already exists.');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(command.name);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(`/role_management/${command.id}/edit`); await expect(page.getByLabel('Description', { exact: true })).toHaveValue('0');
  await page.getByLabel('Description', { exact: true }).fill('Unsaved stale draft');
  expect((await page.request.patch(`/api/roles/${command.id}`, { headers: await headers(page), data: { revision: 1, requestId: randomUUID(), name: 'Concurrent rename' } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('The role changed in another session.');
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Unsaved stale draft');
  await page.reload(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Concurrent rename'); await expect(page.getByLabel('Description', { exact: true })).toHaveValue('0');
});
