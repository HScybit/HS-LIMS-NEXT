import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, moduleAccessValues } from '../helpers/module-access.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const endpoint = '/api/organization-settings/laboratory';
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function open(page) {
  await page.goto('/organization_settings'); await page.getByRole('tab', { name: 'Access Control', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Enabled Modules', exact: true })).toBeVisible();
}
async function choose(page, scope, label, search, option) {
  const input = scope.getByRole('combobox', { name: label, exact: true }); await input.fill(search);
  await page.getByRole('option', { name: option, exact: true }).click(); await input.press('Escape');
}
const settings = async page => (await (await page.request.get(endpoint)).json()).settings;
async function headers(page) {
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
}
async function update(page, changes) {
  const current = await settings(page);
  const { updatedBy: _actor, updatedAt: _time, moduleAccessRevision: _revision, moduleAccess, ...input } = current;
  return page.request.put(endpoint, { headers: await headers(page), data: { ...input, moduleAccess: moduleAccessValues(moduleAccess), ...changes } });
}
async function save(page) {
  const response = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click(); return response;
}
const customerInput = () => ({ name: `Module browser ${randomUUID()}`, legalName: 'Synthetic legal name', contactPersonName: 'Synthetic contact',
  contactPersonEmail: 'synthetic@example.invalid', contactPersonPhone: '0000', billToAddress: 'Synthetic billing', shipToAddress: 'Synthetic shipping' });

test('Service Agreements has configured access controls and survives both older settings formats', async ({ page }, info) => {
  const actor = await createAccount(owner, { permissions: ['settings.manage'] }); await login(page, actor); await open(page);
  const agreement = page.getByRole('group', { name: 'Service Agreements', exact: true });
  expect(moduleAccessValues((await settings(page)).moduleAccess)[3]).toEqual(emptyModuleAccess()[3]);
  await choose(page, agreement, 'Users', actor.userId, 'Synthetic Analyst');
  await choose(page, agreement, 'Roles', actor.roleId, `Reader ${actor.roleId}`);
  await choose(page, page, 'Modules', 'Service', 'Service Agreements');
  expect((await save(page)).status()).toBe(200);
  const intended = { moduleKey: 'service_agreements', enabled: true, roleIds: [actor.roleId], userIds: [actor.userId] };
  expect(moduleAccessValues((await settings(page)).moduleAccess)[3]).toEqual(intended);
  for (const count of [3, 2]) {
    const saved = await settings(page);
    expect((await update(page, { moduleAccess: moduleAccessValues(saved.moduleAccess.slice(0, count)) })).status()).toBe(200);
    expect(moduleAccessValues((await settings(page)).moduleAccess)[3]).toEqual(intended);
  }
  await open(page); await expect(agreement).toContainText('2 assigned'); await agreement.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('service-agreement-access-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await agreement.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('service-agreement-access-mobile.png'), fullPage: true });
  const disabled = moduleAccessValues((await settings(page)).moduleAccess); disabled[3].enabled = false;
  expect((await update(page, { moduleAccess: disabled })).status()).toBe(200);
  await open(page); await expect(agreement).toContainText('2 assigned');
  const reader = await createAccount(owner, { organizationId: actor.organizationId, permissions: ['settings.read'] });
  await login(page, reader); await open(page); await expect(page.locator('#user-access-service_agreements')).toBeDisabled();
  expect((await update(page, { moduleAccess: emptyModuleAccess() })).status()).toBe(403);
});

test('Instrument has explicit source-style access controls and survives older settings requests', async ({ page }, info) => {
  const actor = await createAccount(owner, { permissions: ['settings.manage'] }); await login(page, actor); await open(page);
  const instrument = page.getByRole('group', { name: 'Instrument', exact: true });
  await expect(instrument.getByRole('combobox', { name: 'Users', exact: true })).toBeEnabled();
  expect(moduleAccessValues((await settings(page)).moduleAccess)[2]).toEqual({ moduleKey: 'instrument', enabled: false, roleIds: [], userIds: [] });
  await choose(page, instrument, 'Users', actor.userId, 'Synthetic Analyst');
  await choose(page, instrument, 'Roles', actor.roleId, `Reader ${actor.roleId}`);
  await choose(page, page, 'Modules', 'Instrument', 'Instrument');
  expect((await save(page)).status()).toBe(200);
  const saved = await settings(page); const intended = { moduleKey: 'instrument', enabled: true, roleIds: [actor.roleId], userIds: [actor.userId] };
  expect(moduleAccessValues(saved.moduleAccess)[2]).toEqual(intended);
  expect((await update(page, { moduleAccess: moduleAccessValues(saved.moduleAccess.slice(0, 2)), dateFormat: 'YYYY-MM-DD' })).status()).toBe(200);
  expect(moduleAccessValues((await settings(page)).moduleAccess)[2]).toEqual(intended);
  await open(page); await expect(instrument).toContainText('2 assigned');
  await instrument.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('instrument-access-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await instrument.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('instrument-access-mobile.png'), fullPage: true });
  const disabled = moduleAccessValues(saved.moduleAccess); disabled[2].enabled = false;
  expect((await update(page, { moduleAccess: disabled })).status()).toBe(200);
  await open(page); await expect(instrument).toContainText('2 assigned');
  const reader = await createAccount(owner, { organizationId: actor.organizationId, permissions: ['settings.read'] });
  await login(page, reader); await open(page); await expect(page.locator('#user-access-instrument')).toBeDisabled();
  expect((await update(page, { moduleAccess: emptyModuleAccess() })).status()).toBe(403);
});

test('source Access Control grants explicit users, preserves disabled assignments and gates quick customer creation', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const actor = await createAccount(owner, { permissions: ['settings.manage', 'samples.create'] }); await login(page, actor);
  await page.goto('/samples/new'); await expect(page.getByRole('button', { name: 'Add customer', exact: true })).toBeDisabled();
  expect((await page.request.post('/api/samples/quick-customer', { headers: await headers(page), data: customerInput() })).status()).toBe(403);
  await open(page); const customer = page.getByRole('group', { name: 'Customer Master', exact: true });
  await expect(customer.getByRole('combobox', { name: 'Users', exact: true })).toBeEnabled();
  await choose(page, customer, 'Users', actor.userId, 'Synthetic Analyst');
  await choose(page, page, 'Modules', 'Customer', 'Customer Master');
  await choose(page, customer, 'Roles', actor.roleId, `Reader ${actor.roleId}`);
  const vendor = page.getByRole('group', { name: 'Vendor Master', exact: true });
  await choose(page, vendor, 'Users', actor.userId, 'Synthetic Analyst');
  await page.getByRole('tab', { name: 'Tenant Settings', exact: true }).click(); await page.getByLabel('Date Format', { exact: true }).selectOption('YYYY-MM-DD');
  expect((await save(page)).status()).toBe(200);
  const saved = await settings(page); expect(saved.dateFormat).toBe('YYYY-MM-DD');
  expect(moduleAccessValues(saved.moduleAccess)).toEqual([
    { moduleKey: 'customer', enabled: true, roleIds: [actor.roleId], userIds: [actor.userId] },
    { moduleKey: 'vendor', enabled: false, roleIds: [], userIds: [actor.userId] },
    { moduleKey: 'instrument', enabled: false, roleIds: [], userIds: [] },
    { moduleKey: 'service_agreements', enabled: false, roleIds: [], userIds: [] },
    { moduleKey: 'inventory', enabled: false, roleIds: [], userIds: [] },
  ]);
  await open(page); await expect(customer).toContainText('2 assigned'); await expect(vendor).toContainText('1 assigned');
  await page.screenshot({ path: testInfo.outputPath('module-access-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('module-access-mobile.png'), fullPage: true, animations: 'disabled' });
  await customer.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('module-access-mobile-controls.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/samples/new');
  await expect(page.getByRole('button', { name: 'Add customer', exact: true })).toBeEnabled();
  expect((await page.request.post('/api/samples/quick-customer', { headers: await headers(page), data: customerInput() })).status()).toBe(201);
  expect((await update(page, { moduleAccess: emptyModuleAccess() })).status()).toBe(200);
  expect((await page.request.post('/api/samples/quick-customer', { headers: await headers(page), data: customerInput() })).status()).toBe(403);
  await page.reload(); await expect(page.getByRole('button', { name: 'Add customer', exact: true })).toBeDisabled();
  const reader = await createAccount(owner, { organizationId: actor.organizationId, permissions: ['settings.read'] });
  await login(page, reader); await open(page); await expect(page.locator('#modules_enabled')).toBeDisabled();
  await expect(page.locator('#user-access-customer')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toHaveCount(0);
  expect((await update(page, { moduleAccess: emptyModuleAccess() })).status()).toBe(403);
});

test('choice retries and failed or stale saves retain module drafts and keep settings atomic', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['settings.manage'] }); await login(page, actor);
  await page.route('**/api/organization-settings/module-access/options?**', route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic choices unavailable' } } }));
  await open(page); const customer = page.getByRole('group', { name: 'Customer Master', exact: true });
  await expect(customer.getByRole('alert').first()).toContainText('Synthetic choices unavailable');
  await page.unroute('**/api/organization-settings/module-access/options?**'); await customer.getByRole('button', { name: 'Retry', exact: true }).first().click();
  await choose(page, customer, 'Roles', actor.roleId, `Reader ${actor.roleId}`); await choose(page, page, 'Modules', 'Customer', 'Customer Master');
  await page.route('**' + endpoint, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { error: { message: 'Synthetic save interruption' } } }) : route.continue());
  expect((await save(page)).status()).toBe(503); await expect(customer).toContainText(`Reader ${actor.roleId}`);
  expect((await settings(page)).revision).toBe(0); await page.unroute('**' + endpoint);
  expect((await update(page, { dateFormat: 'DD/MM/YYYY' })).status()).toBe(200);
  expect((await save(page)).status()).toBe(409); await expect(customer).toContainText(`Reader ${actor.roleId}`);
  await expect(page.locator('.alert[role="alert"]')).toContainText('Reload before saving');
  const stored = await settings(page); expect(stored.dateFormat).toBe('DD/MM/YYYY'); expect(moduleAccessValues(stored.moduleAccess)).toEqual(emptyModuleAccess());
  await page.getByRole('button', { name: 'Reload settings', exact: true }).click(); await expect(customer).not.toContainText(`Reader ${actor.roleId}`);
});

test('large ordered access sets survive HTTP save and paged lookup without tenant or CSRF bypass', async ({ page }) => {
  test.setTimeout(90000);
  const actor = await createAccount(owner, { permissions: ['settings.manage'] }); const foreign = await createAccount(owner, { permissions: ['settings.manage'] });
  const roleIds = Array.from({ length: 500 }, () => randomUUID()); const userIds = Array.from({ length: 500 }, () => randomUUID());
  await owner.query("INSERT INTO roles(organization_id,id,name) SELECT $1,id,'Paged role '||lpad(position::text,3,'0') FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(id,position)", [actor.organizationId, roleIds]);
  await owner.query("INSERT INTO users(id,username,email,display_name,must_change_password) SELECT id,'module-'||id,id||'@example.invalid','Paged user '||lpad(position::text,3,'0'),false FROM unnest($1::uuid[]) WITH ORDINALITY AS selected(id,position)", [userIds]);
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,id FROM unnest($2::uuid[]) AS selected(id)', [actor.organizationId, userIds]);
  await login(page, actor); await open(page);
  const modules = emptyModuleAccess().map(access => ({ ...access, enabled: true, roleIds, userIds }));
  expect(Buffer.byteLength(JSON.stringify(modules))).toBeGreaterThan(65536);
  expect((await update(page, { moduleAccess: modules })).status()).toBe(200);
  expect(moduleAccessValues((await settings(page)).moduleAccess)).toEqual(modules);
  await open(page); const customer = page.getByRole('group', { name: 'Customer Master', exact: true }); await expect(customer).toContainText('1000 assigned');
  const selected = customer.getByRole('combobox', { name: 'Roles', exact: true }); await selected.fill('Paged role');
  await expect(page.getByRole('button', { name: 'Load more customer roles', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Load more customer roles', exact: true }).click();
  const pageTwo = await page.request.get('/api/organization-settings/module-access/options?kind=role&search=Paged%20role&page=2'); expect(pageTwo.status()).toBe(200);
  expect((await pageTwo.json()).rows[0].id).toBe(roleIds[100]); await selected.press('Escape');
  expect((await save(page)).status()).toBe(200); expect(moduleAccessValues((await settings(page)).moduleAccess)).toEqual(modules);
  const forged = structuredClone(modules); forged[0].userIds[0] = foreign.userId;
  expect((await update(page, { moduleAccess: forged })).status()).toBe(400); expect(moduleAccessValues((await settings(page)).moduleAccess)).toEqual(modules);
  const wrongCsrf = await headers(page); wrongCsrf['X-CSRF-Token'] = 'invalid';
  expect((await page.request.put(endpoint, { headers: wrongCsrf, data: { revision: 2, autoCreateJobs: false, moduleAccess: emptyModuleAccess() } })).status()).toBe(403);
  await login(page, foreign); const foreignOptions = await page.request.get(`/api/organization-settings/module-access/options?kind=user&search=${userIds[0]}`);
  expect((await foreignOptions.json()).rows).toEqual([]);
});
