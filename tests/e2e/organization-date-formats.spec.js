import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { closePool } from '../../src/db/pool.js';
import { customFieldDateFormats, customFieldDateTimeFormats } from '../../src/masters/custom-field-config.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function openSettings(page) {
  await page.goto('/organization_settings'); await page.getByRole('tab', { name: 'Tenant Settings', exact: true }).click();
  await expect(page.getByLabel('Date Format', { exact: true })).toBeVisible();
}
async function save(page) {
  const response = page.waitForResponse((response) => response.url().endsWith('/api/organization-settings/laboratory') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click(); return response;
}
async function updateThroughApi(page, changes) {
  const { settings } = await (await page.request.get('/api/organization-settings/laboratory')).json();
  return page.request.put('/api/organization-settings/laboratory', { headers: { Origin: 'http://127.0.0.1:3100',
    'X-CSRF-Token': (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value },
  data: { revision: settings.revision, autoCreateJobs: settings.autoCreateJobs, resultSummaryTemplateId: settings.resultSummaryTemplateId,
    jobWorkflowId: settings.jobWorkflowId, ...changes } });
}

test('source date format controls show every choice, persist selections and remain read-only for viewers', async ({ page }, testInfo) => {
  const account = await createAccount(owner, { permissions: ['settings.manage'] }); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message)); await login(page, account); await openSettings(page);
  for (const [label, formats] of [['Date Format', customFieldDateFormats], ['Date-Time Format', customFieldDateTimeFormats]]) {
    const select = page.getByLabel(label, { exact: true }); await expect(select).toHaveValue(formats[0].value);
    expect(await select.locator('option').evaluateAll((options) => options.filter((option) => option.value).map((option) => ({ value: option.value, label: option.textContent })))).toEqual(formats);
    await select.selectOption(formats.at(-2).value);
  }
  expect((await save(page)).status()).toBe(200); await page.reload(); await page.getByRole('tab', { name: 'Tenant Settings', exact: true }).click();
  await expect(page.getByLabel('Date Format', { exact: true })).toHaveValue('D MMM YYYY');
  await expect(page.getByLabel('Date-Time Format', { exact: true })).toHaveValue('MMMM Do YYYY | hh:mm A');
  await page.screenshot({ path: testInfo.outputPath('organization-date-formats-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByLabel('Date-Time Format', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('organization-date-formats-mobile.png'), fullPage: true, animations: 'disabled' });
  const viewer = await createAccount(owner, { organizationId: account.organizationId, permissions: ['settings.read'] });
  await login(page, viewer); await openSettings(page);
  await expect(page.getByLabel('Date Format', { exact: true })).toBeDisabled(); await expect(page.getByLabel('Date-Time Format', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toHaveCount(0);
  expect((await updateThroughApi(page, { dateFormat: 'YYYY' })).status()).toBe(403); expect(errors).toEqual([]);
});

test('failed loads and saves retain retry controls and stale date drafts require reload', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['settings.manage'] }); await login(page, account);
  const routePattern = '**/api/organization-settings/laboratory';
  await page.route(routePattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic settings load failure' } }) }));
  await page.goto('/organization_settings'); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic settings load failure');
  await page.unroute(routePattern); await page.getByRole('button', { name: 'Reload settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Tenant Settings', exact: true }).click(); await page.getByLabel('Date Format', { exact: true }).selectOption('Do MMMM YYYY');
  await page.route(routePattern, (route) => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic settings save failure' } }) }) : route.continue());
  expect((await save(page)).status()).toBe(503); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic settings save failure');
  await expect(page.getByLabel('Date Format', { exact: true })).toHaveValue('Do MMMM YYYY');
  await page.unroute(routePattern); expect((await save(page)).status()).toBe(200);
  await page.getByLabel('Date Format', { exact: true }).selectOption('DD.MM.YYYY');
  expect((await updateThroughApi(page, { dateFormat: 'YYYY-MM-DD' })).status()).toBe(200);
  expect((await save(page)).status()).toBe(409); await expect(page.locator('.alert[role="alert"]')).toContainText('Organization settings changed. Reload before saving.');
  await expect(page.getByLabel('Date Format', { exact: true })).toHaveValue('DD.MM.YYYY');
  await page.getByRole('button', { name: 'Reload settings', exact: true }).click(); await expect(page.getByLabel('Date Format', { exact: true })).toHaveValue('YYYY-MM-DD');
});

test('custom stored date formats survive unrelated settings saves and empty formats show source defaults', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['settings.manage'] }); await login(page, account);
  expect((await updateThroughApi(page, { dateFormat: 'YYYY [fiscal year]', datetimeFormat: 'HH:mm Z' })).status()).toBe(200);
  await openSettings(page); await expect(page.getByLabel('Date Format', { exact: true })).toHaveValue('YYYY [fiscal year]');
  await expect(page.getByLabel('Date-Time Format', { exact: true })).toHaveValue('HH:mm Z');
  await page.getByLabel('Separator', { exact: true }).fill('~'); expect((await save(page)).status()).toBe(200);
  await openSettings(page); await expect(page.getByLabel('Date Format', { exact: true })).toHaveValue('YYYY [fiscal year]');
  await expect(page.getByLabel('Date-Time Format', { exact: true })).toHaveValue('HH:mm Z');
  expect((await updateThroughApi(page, { dateFormat: null, datetimeFormat: '' })).status()).toBe(200);
  await openSettings(page); await expect(page.getByLabel('Date Format', { exact: true })).toHaveValue('DD/MM/YYYY');
  await expect(page.getByLabel('Date-Time Format', { exact: true })).toHaveValue('DD/MM/YYYY HH:mm:ss');
  expect((await save(page)).status()).toBe(200);
  const { settings } = await (await page.request.get('/api/organization-settings/laboratory')).json();
  expect(settings.dateFormat).toBe('DD/MM/YYYY'); expect(settings.datetimeFormat).toBe('DD/MM/YYYY HH:mm:ss');
});
