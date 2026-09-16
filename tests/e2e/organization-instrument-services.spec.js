import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';

let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await owner.end(); });
const endpoint = '/api/organization-settings/laboratory';
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function open(page) {
  await page.goto('/organization_settings'); await page.getByRole('tab', { name: 'Instrument Management', exact: true }).click();
  await expect(page.getByLabel('Instrument service 1 key', { exact: true })).toBeVisible();
}
async function save(page) {
  const response = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click(); return response;
}
const settings = async page => (await (await page.request.get(endpoint)).json()).settings;
const csrf = async page => (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
async function update(page, changes, token) {
  const current = await settings(page);
  return page.request.put(endpoint, { headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': token ?? await csrf(page) }, data: {
    revision: current.revision, autoCreateJobs: current.autoCreateJobs, resultSummaryTemplateId: current.resultSummaryTemplateId,
    jobWorkflowId: current.jobWorkflowId, ...changes } });
}

test('source service rows save across tabs and retain identities, Active and history through removal', async ({ page }, testInfo) => {
  const user = await createAccount(owner, { permissions: ['settings.manage'] }); await login(page, user); await open(page);
  await page.getByLabel('Instrument service 1 key', { exact: true }).fill('CAL-01');
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('both a key and a value');
  expect((await settings(page)).revision).toBe(0);
  await page.getByLabel('Instrument service 1 name', { exact: true }).fill(' Calibration Schedule ');
  await page.getByRole('button', { name: 'Add Service', exact: true }).click();
  await page.getByLabel('Instrument service 2 key', { exact: true }).fill('cal-01');
  await page.getByLabel('Instrument service 2 name', { exact: true }).fill('Maintenance');
  await expect(page.getByLabel('Instrument service 1 key', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('keys must be unique');
  await page.getByLabel('Instrument service 2 key', { exact: true }).fill('PM_1'); await page.getByLabel('Instrument service 2 Active', { exact: true }).uncheck();
  await page.getByRole('tab', { name: 'Tenant Settings', exact: true }).click(); await page.getByLabel('Date Format', { exact: true }).selectOption('YYYY-MM-DD');
  expect((await save(page)).status()).toBe(200); const first = await settings(page); expect(first.dateFormat).toBe('YYYY-MM-DD');
  expect(first.instrumentServiceTypes.map(item => [item.serviceCode, item.displayLabel, item.isActive])).toEqual([['CAL-01', 'Calibration Schedule', true], ['PM_1', 'Maintenance', false]]);
  await open(page); await expect(page.getByLabel('Instrument service 1 name', { exact: true })).toHaveValue('Calibration Schedule');
  await expect(page.getByLabel('Instrument service 2 Active', { exact: true })).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('instrument-services-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('instrument-services-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Remove instrument service 1', exact: true }).click();
  await page.getByLabel('Instrument service 1 name', { exact: true }).fill('Updated maintenance'); expect((await save(page)).status()).toBe(200);
  const next = await settings(page); expect(next.instrumentServiceTypes).toEqual([{ ...first.instrumentServiceTypes[1], displayLabel: 'Updated maintenance' }]);
  await page.getByRole('button', { name: 'Remove instrument service 1', exact: true }).click(); expect((await save(page)).status()).toBe(200);
  expect((await settings(page)).instrumentServiceTypes).toEqual([]); await open(page); await expect(page.getByLabel('Instrument service 1 key', { exact: true })).toHaveValue('');
  const rows = (await owner.query('SELECT row_count FROM organization_instrument_service_versions WHERE organization_id=$1 ORDER BY revision', [user.organizationId])).rows;
  expect(rows.map(item => item.row_count)).toEqual([2, 1, 0]);
});

test('load failure retries, failed saves keep drafts and lost responses use the existing stale-settings recovery', async ({ page }) => {
  const user = await createAccount(owner, { permissions: ['settings.manage'] }); await login(page, user);
  await page.route('**' + endpoint, route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic load failure' } } }));
  await page.goto('/organization_settings'); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic load failure');
  await page.unroute('**' + endpoint); await page.getByRole('button', { name: 'Reload settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Instrument Management', exact: true }).click();
  await page.getByLabel('Instrument service 1 key', { exact: true }).fill('CAL'); await page.getByLabel('Instrument service 1 name', { exact: true }).fill('Calibration');
  await page.route('**' + endpoint, route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, json: { error: { message: 'Synthetic save failure' } } }) : route.continue());
  expect((await save(page)).status()).toBe(503); await expect(page.getByLabel('Instrument service 1 name', { exact: true })).toHaveValue('Calibration');
  await page.unroute('**' + endpoint);
  await page.route('**' + endpoint, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200);
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic lost success response' } } });
  });
  expect((await save(page)).status()).toBe(503); await page.unroute('**' + endpoint);
  expect((await save(page)).status()).toBe(409); await expect(page.locator('.alert[role="alert"]')).toContainText('Reload before saving');
  await expect(page.getByLabel('Instrument service 1 name', { exact: true })).toHaveValue('Calibration');
  expect((await owner.query('SELECT count(*)::integer AS count FROM organization_instrument_service_versions WHERE organization_id=$1', [user.organizationId])).rows[0].count).toBe(1);
  await page.getByRole('button', { name: 'Reload settings', exact: true }).click(); await expect(page.getByLabel('Instrument service 1 name', { exact: true })).toHaveValue('Calibration');
  await page.getByLabel('Instrument service 1 name', { exact: true }).fill('New local draft');
  expect((await update(page, { dateFormat: 'YYYY-MM-DD' })).status()).toBe(200); expect((await save(page)).status()).toBe(409);
  await expect(page.getByLabel('Instrument service 1 name', { exact: true })).toHaveValue('New local draft');
});

test('settings readers see disabled service fields and CSRF failures cannot change definitions', async ({ page }) => {
  const user = await createAccount(owner, { permissions: ['settings.manage'] }); await login(page, user); await open(page);
  expect((await update(page, { instrumentServiceTypes: [] }, 'invalid')).status()).toBe(403); expect((await settings(page)).revision).toBe(0);
  const reader = await createAccount(owner, { organizationId: user.organizationId, permissions: ['settings.read'] }); await login(page, reader); await open(page);
  await expect(page.getByLabel('Instrument service 1 key', { exact: true })).toBeDisabled(); await expect(page.getByLabel('Instrument service 1 Active', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Add Service', exact: true })).toHaveCount(0);
  expect((await update(page, { instrumentServiceTypes: [] })).status()).toBe(403);
});
