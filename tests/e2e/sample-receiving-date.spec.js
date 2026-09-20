import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function updateSettings(page, allowReceivingDateEdit) {
  const { settings } = await (await page.request.get('/api/organization-settings/laboratory')).json();
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
  return page.request.put('/api/organization-settings/laboratory', { headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf },
    data: { revision: settings.revision, autoCreateJobs: settings.autoCreateJobs, resultSummaryTemplateId: settings.resultSummaryTemplateId,
      jobWorkflowId: settings.jobWorkflowId, allowReceivingDateEdit } });
}
async function select(page, name, label) {
  await page.getByRole('combobox', { name, exact: true }).fill(label); await page.getByRole('option', { name: label, exact: true }).click();
}

for (const enabled of [false, true]) test(`receiving date ${enabled ? 'opt-in permits an explicit date' : 'defaults to read-only local today'} and survives a failed sample save`, async ({ page }, info) => {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'settings.manage'] });
  const fixture = await createLaboratoryFixture(owner, account); await login(page, account);
  if (enabled) expect((await updateSettings(page, true)).status()).toBe(200);
  await page.goto('/samples/new/v2'); const date = page.getByLabel('Receiving Date', { exact: true });
  const today = await page.evaluate(() => { const now = new Date(); return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-'); });
  await expect(date).toHaveValue(today);
  if (enabled) { await expect(date).toBeEnabled(); await date.fill('2026-01-02'); } else await expect(date).toBeDisabled();
  const expected = enabled ? '2026-01-02' : today;
  await select(page, 'Customer', fixture.customer.name); await page.getByLabel('Customer Address', { exact: true }).fill('Synthetic receiving address');
  await select(page, 'Category', fixture.category.name); await select(page, 'Product', fixture.product.name);
  await page.getByRole('button', { name: 'Auto-fill parameters', exact: true }).click(); await page.getByLabel('Quantity', { exact: true }).fill('1');
  await page.getByLabel('Tentative Reporting Date', { exact: true }).fill(expected);
  let fail = true;
  await page.route('**/api/samples', route => {
    if (route.request().method() === 'POST' && fail) { fail = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic date save failure' } }) }); }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Save Sample', exact: true }).click();
  await expect(page.locator('.sample-form-page').getByRole('alert')).toContainText('Synthetic date save failure'); await expect(date).toHaveValue(expected);
  if (enabled) await expect(date).toBeEnabled(); else await expect(date).toBeDisabled();
  await page.screenshot({ path: info.outputPath('receiving-date.png'), fullPage: true, animations: 'disabled' });
  const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/samples' && result.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save Sample', exact: true }).click(); const result = await response; expect(result.status()).toBe(201);
  const sample = await result.json(); await expect(page).toHaveURL(`/samples/${sample.id}`);
  expect((await (await page.request.get(`/api/samples/${sample.id}`)).json()).receivedAt).toBe(`${expected}T00:00:00.000Z`);
});

test('Sample Page receiving-date setting persists, retains a failed draft and rejects stale or read-only changes', async ({ page }, info) => {
  const account = await createAccount(owner, { permissions: ['settings.manage'] }); await login(page, account);
  const open = async () => { await page.goto('/organization_settings'); await page.getByRole('tab', { name: 'Sample Page', exact: true }).click(); };
  const checkbox = page.getByRole('checkbox', { name: 'Allow Editing Receiving Date', exact: true });
  const save = async () => {
    const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/organization-settings/laboratory' && result.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click(); return response;
  };
  await open(); await expect(checkbox).not.toBeChecked(); await checkbox.check();
  const pattern = '**/api/organization-settings/laboratory';
  await page.route(pattern, route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic settings date failure' } }) }) : route.continue());
  expect((await save()).status()).toBe(503); await expect(checkbox).toBeChecked(); await page.unroute(pattern);
  expect((await save()).status()).toBe(200); await open(); await expect(checkbox).toBeChecked();
  expect((await updateSettings(page, false)).status()).toBe(200); expect((await save()).status()).toBe(409); await expect(checkbox).toBeChecked();
  await page.getByRole('button', { name: 'Reload settings', exact: true }).click(); await expect(checkbox).not.toBeChecked();
  await checkbox.check(); expect((await save()).status()).toBe(200);
  await page.screenshot({ path: info.outputPath('sample-page-settings.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await checkbox.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('sample-page-settings-mobile.png'), fullPage: true, animations: 'disabled' });
  const viewer = await createAccount(owner, { organizationId: account.organizationId, permissions: ['settings.read'] });
  await login(page, viewer); await open(); await expect(checkbox).toBeChecked(); await expect(checkbox).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toHaveCount(0); expect((await updateSettings(page, false)).status()).toBe(403);
});
