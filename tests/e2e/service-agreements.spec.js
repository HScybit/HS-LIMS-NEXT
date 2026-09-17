import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool } from '../helpers/database.js';
import { agreementAccount, agreementWork as work, serviceAgreementFixture, serviceAgreementCommand, addAgreementInstruments } from '../helpers/service-agreements.js';
import { saveModuleAccessSettings } from '../helpers/module-access.js';
import { closePool } from '../../src/db/pool.js';
import { saveServiceAgreement } from '../../src/masters/service-agreements.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const save = (actor, input) => work(actor, (client, identity) => saveServiceAgreement(client, identity, input));
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(actor.username); await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function select(page, label, search, name) {
  await page.getByLabel(label, { exact: true }).fill(search); await page.getByRole('option', { name, exact: true }).click(); await page.keyboard.press('Escape');
}
async function fillRequired(page, context) {
  await select(page, 'Vendor', context.vendor.id, context.vendor.name);
  await select(page, 'Equipment(s)', context.instruments[1].id, context.instruments[1].name);
  await page.getByLabel('Start Date', { exact: true }).fill('01/01/2026'); await page.getByLabel('End Date', { exact: true }).fill('31/12/2026');
}
async function headers(page) {
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
}

test('Agreement source form, files, list and deletion preserve zero and exact requests after lost responses', async ({ page }, testInfo) => {
  test.setTimeout(90_000); const context = await serviceAgreementFixture(owner); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, context.actor);
  await page.getByRole('link', { name: 'Service Agreements', exact: true }).click(); await page.getByRole('button', { name: 'New Service Agreement', exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('Vendor is required.', { exact: true })).toBeVisible();
  await fillRequired(page, context); await select(page, 'Services Included', 'calib', 'Calibration');
  await page.getByLabel('No of Services', { exact: true }).fill('0'); await page.getByLabel('Cost (in Rs.)', { exact: true }).fill('');
  await page.getByLabel('Notes', { exact: true }).fill('Synthetic Agreement notes');
  let uploadId; let attachment;
  await page.route('**/api/masters/service-agreements/files', async route => {
    uploadId = route.request().headers()['x-upload-request-id']; const response = await route.fetch(); expect(response.status()).toBe(201); attachment = await response.json();
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic lost Agreement upload' } } });
  });
  await page.getByLabel('Attachment', { exact: true }).setInputFiles({ name: 'Agreement.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment bytes') });
  await expect(page.locator('#agreement-attachment-error')).toContainText('Synthetic lost Agreement upload'); await page.unroute('**/api/masters/service-agreements/files');
  const uploadRetry = page.waitForResponse(response => response.url().endsWith('/api/masters/service-agreements/files'));
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click(); const uploaded = await uploadRetry;
  expect(uploaded.status()).toBe(200); expect(uploaded.request().headers()['x-upload-request-id']).toBe(uploadId);
  await expect(page.getByRole('link', { name: 'View File', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('agreement-form-desktop.png'), fullPage: true, animations: 'disabled' });
  let attempted; let record;
  await page.route('**/api/masters/service-agreements', async route => {
    if (route.request().method() !== 'POST') return route.continue(); attempted = route.request().postDataJSON();
    const response = await route.fetch(); expect(response.status()).toBe(200); record = await response.json();
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic lost Agreement save' } } });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost Agreement save');
  await expect(page.getByLabel('Notes', { exact: true })).toBeDisabled(); await page.unroute('**/api/masters/service-agreements');
  const retry = page.waitForResponse(response => response.url().endsWith('/api/masters/service-agreements') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const retried = await retry;
  expect(retried.status()).toBe(200); expect(retried.request().postDataJSON()).toEqual(attempted);
  expect(record.cost).toBe('0.00'); expect(record.noOfServices).toBe(0); expect(record.inEffect).toBe(false); expect(record.attachmentFileId).toBe(attachment.id);
  await expect(page).toHaveURL(/\/service_agreements$/); const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: context.vendor.name, exact: true }) });
  await expect(row).toBeVisible(); await expect(page.getByRole('columnheader')).toHaveCount(6);
  await page.getByPlaceholder('Search...', { exact: true }).fill('Agreement Instrument 1'); await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const dateFilter = page.locator('.dt-filter-field').filter({ hasText: 'Start Date' });
  await dateFilter.locator('input').nth(0).fill('2026-01-01'); await dateFilter.locator('input').nth(1).fill('2026-01-01');
  await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'Edit', exact: true }).click(); await expect(page.getByLabel('Cost (in Rs.)', { exact: true })).toHaveValue('0.00');
  await expect(page.getByLabel('In Effect', { exact: true })).not.toBeChecked(); await page.getByRole('button', { name: 'Remove Attachment file', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('agreement-form-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/filters=/); await expect(row).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 }); await row.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('cell', { name: '0.00', exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: '01/01/2026', exact: true })).toBeVisible();
  expect((await page.request.get(`/api/masters/service-agreements/files/${attachment.id}`)).status()).toBe(200);
  await page.goBack(); await row.getByRole('button', { name: 'Delete', exact: true }).click(); const modal = page.getByRole('dialog', { name: 'Delete Service Agreement', exact: true });
  let removal;
  await page.route(`**/api/masters/service-agreements/${record.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue(); removal = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic lost Agreement deletion' } } });
  });
  await modal.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(modal).toContainText('Synthetic lost Agreement deletion');
  await page.unroute(`**/api/masters/service-agreements/${record.id}`); const removed = page.waitForResponse(response => response.request().method() === 'DELETE');
  await modal.getByRole('button', { name: 'Delete', exact: true }).click(); const deleted = await removed;
  expect(deleted.status()).toBe(200); expect(deleted.request().postDataJSON()).toEqual(removal); await expect(row).toHaveCount(0); expect(errors).toEqual([]);
});

test('Agreement form preserves unsaved edits on conflicts and recovers from failed choices and record loads', async ({ page }) => {
  const context = await serviceAgreementFixture(owner); const record = await save(context.actor, serviceAgreementCommand(context)); await login(page, context.actor);
  await page.route(`**/api/masters/service-agreements/${record.id}`, route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic record unavailable' } } }));
  await page.goto(`/service_agreements/${record.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic record unavailable');
  await page.unroute(`**/api/masters/service-agreements/${record.id}`); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByLabel('Notes', { exact: true })).toBeVisible(); await page.getByLabel('Notes', { exact: true }).fill('Unsaved local notes');
  await save(context.actor, { id: record.id, revision: 1, requestId: randomUUID(), cost: '10' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Reload before saving');
  await expect(page.getByLabel('Notes', { exact: true })).toHaveValue('Unsaved local notes'); await expect(page.getByLabel('Notes', { exact: true })).toBeEnabled();
  await page.route('**/api/masters/service-agreements/options', route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic choices unavailable' } } }));
  await page.goto('/service_agreements/new'); await expect(page.getByRole('button', { name: 'Retry choices', exact: true })).toHaveCount(2);
  await page.unroute('**/api/masters/service-agreements/options'); await page.getByRole('button', { name: 'Retry choices', exact: true }).first().click();
  await fillRequired(page, context); await page.getByLabel('End Date', { exact: true }).fill('31/12/2025');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('End Date cannot be before Start Date.', { exact: true })).toBeVisible();
  await page.getByLabel('End Date', { exact: true }).fill('31/12/2026'); await page.getByLabel('No of Services', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('Enter a whole number from 0 to 2147483647.', { exact: true })).toBeVisible();
});

test('Agreement-only navigation and endpoints enforce operation, tenant, CSRF and revoked module access', async ({ page }) => {
  const context = await serviceAgreementFixture(owner); const editor = await agreementAccount(owner, { organizationId: context.actor.organizationId });
  const reader = await agreementAccount(owner, { organizationId: context.actor.organizationId, permissions: ['masters.read'] });
  context.modules[3].userIds.push(editor.userId, reader.userId); await saveModuleAccessSettings(context.actor, context.modules);
  const record = await save(editor, serviceAgreementCommand(context)); await login(page, editor);
  await expect(page.getByRole('link', { name: 'Vendors', exact: true })).toHaveCount(0); await expect(page.getByRole('link', { name: 'Instruments', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Service Agreements', exact: true }).click(); await expect(page.getByRole('button', { name: 'New Service Agreement', exact: true })).toBeVisible();
  const authHeaders = await headers(page); const input = serviceAgreementCommand(context);
  expect((await page.request.post('/api/masters/service-agreements', { headers: { ...authHeaders, Origin: 'https://invalid.example' }, data: input })).status()).toBe(403);
  expect((await page.request.post('/api/masters/service-agreements', { headers: { ...authHeaders, 'X-CSRF-Token': 'wrong' }, data: input })).status()).toBe(403);
  expect((await page.request.post('/api/masters/service-agreements', { headers: authHeaders, data: { ...input, organizationId: randomUUID() } })).status()).toBe(400);
  expect((await page.request.post('/api/masters/service-agreements/files', { headers: { ...authHeaders, 'Content-Type': 'text/html', 'X-File-Name': 'x.html', 'X-Upload-Request-Id': randomUUID() }, data: '<script>x</script>' })).status()).toBe(415);
  await login(page, reader); await page.goto('/service_agreements'); await expect(page.getByRole('button', { name: 'New Service Agreement', exact: true })).toHaveCount(0);
  await page.goto(`/service_agreements/${record.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('permission to manage');
  expect((await page.request.post('/api/masters/service-agreements', { headers: await headers(page), data: input })).status()).toBe(403);
  context.modules[3].userIds = [context.actor.userId]; await saveModuleAccessSettings(context.actor, context.modules);
  expect((await page.request.get(`/api/masters/service-agreements/${record.id}`)).status()).toBe(403);
  await page.goto('/service_agreements'); await expect(page.getByRole('link', { name: 'Service Agreements', exact: true })).toHaveCount(0);
  const foreign = await serviceAgreementFixture(owner); await login(page, foreign.actor);
  expect((await page.request.get(`/api/masters/service-agreements/${record.id}`)).status()).toBe(404);
});

test('Agreement editing retains 500 Instruments and prevents adding a 501st choice', async ({ page }) => {
  test.setTimeout(90_000); const context = await serviceAgreementFixture(owner); await addAgreementInstruments(context, 501);
  const ids = context.instruments.slice(0, 500).map(item => item.id); const record = await save(context.actor, serviceAgreementCommand(context, { instrumentIds: ids }));
  await login(page, context.actor); await page.goto(`/service_agreements/${record.id}/edit`); await expect(page.getByLabel('Notes', { exact: true })).toBeVisible();
  const extra = context.instruments[500]; await select(page, 'Equipment(s)', extra.id, extra.name);
  await expect(page.getByText('Select at most 500 Instruments.', { exact: true })).toBeVisible(); await page.getByLabel('Notes', { exact: true }).fill('Keep all 500');
  const saving = page.waitForResponse(response => response.url().endsWith('/api/masters/service-agreements') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); const response = await saving; expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().instrumentIds).toEqual(ids); expect((await response.json()).instrumentIds).toEqual(ids);
});

test('Agreement calendar values remain unchanged in Pacific and Kiritimati browser time zones', async ({ browser }) => {
  const context = await serviceAgreementFixture(owner); const record = await save(context.actor, serviceAgreementCommand(context, { startDate: '0001-01-01', endDate: '9999-12-31' }));
  for (const timezoneId of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
    const browserContext = await browser.newContext({ timezoneId, baseURL: 'http://127.0.0.1:3100' }); const page = await browserContext.newPage();
    try {
      await login(page, context.actor); await page.goto(`/service_agreements/${record.id}/view`);
      await expect(page.getByRole('cell', { name: '01/01/0001', exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: '31/12/9999', exact: true })).toBeVisible();
      await page.goto(`/service_agreements/${record.id}/edit`); await expect(page.getByLabel('Start Date', { exact: true })).toHaveValue('01/01/0001');
      await expect(page.getByLabel('End Date', { exact: true })).toHaveValue('31/12/9999');
    } finally { await browserContext.close(); }
  }
});
