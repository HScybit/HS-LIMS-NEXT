import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

async function fixture() {
  const account = await createAccount(owner, { permissions: ['samples.read', 'samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const source = await createLaboratoryFixture(owner, account);
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (action) => withSession(session.token, action, { csrfToken: session.csrfToken });
  const sample = await work((client, identity) => registerSample(client, identity, source.registration));
  const generated = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  const requestId = generated.items[0].id;
  const allocated = await work((client, identity) => allocateTestRequest(client, identity, requestId, { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId }));
  return { account, source, sample, requestId, datasheetId: allocated.datasheetId, path: `/samples/${sample.id}/data_sheets/${allocated.datasheetId}` };
}
async function login(page, account) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
const runtime = (page, id) => page.request.get(`/api/datasheets/${id}`).then((response) => response.json());

test('runtime JSON uses negotiated gzip and returns the same typed capture when compression is refused', async ({ page }) => {
  const source = await fixture(); await login(page, source.account);
  const path = `/api/datasheets/${source.datasheetId}`;
  const compressed = await page.request.get(path, { headers: { 'Accept-Encoding': 'gzip' } });
  expect(compressed.ok()).toBe(true); expect(compressed.headers()['content-encoding']).toBe('gzip');
  expect(compressed.headers().vary.toLowerCase()).toContain('accept-encoding');
  expect(compressed.headers()['cache-control']).toBe('no-store');
  const plain = await page.request.get(path, { headers: { 'Accept-Encoding': 'gzip;q=0, identity;q=1' } });
  expect(plain.ok()).toBe(true); expect(plain.headers()['content-encoding']).toBeUndefined();
  const encodedData = await compressed.json(); const plainData = await plain.json();
  expect(encodedData.capture.values).toEqual(plainData.capture.values);
  expect(encodedData.model).toEqual(plainData.model); expect(encodedData.validation).toEqual(plainData.validation);
});

test('datasheet saves zero/repeats, preserves failed writes, retries and flushes Done without submitting the request', async ({ page }, testInfo) => {
  const source = await fixture();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, source.account); await page.goto(source.path);
  await expect(page.getByRole('heading', { name: 'Add Results', exact: true })).toBeVisible();
  const raw = page.getByRole('spinbutton', { name: 'raw_0', exact: true });
  await expect(raw).toHaveCount(2);
  await raw.nth(0).fill('0'); await raw.nth(1).fill('2.5');
  await page.getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(page.getByLabel('result_0', { exact: true }).nth(0)).toHaveText('0.00');
  await expect(page.getByLabel('result_0', { exact: true }).nth(1)).toHaveText('5.00');
  await expect(page.getByLabel('result_1', { exact: true })).toHaveText('2.50');
  await expect(page.getByRole('button', { name: 'Calculate', exact: true })).toBeEnabled();
  await page.getByRole('link', { name: 'Clone row with data', exact: true }).nth(1).click();
  await expect(raw).toHaveCount(3); await expect(raw.nth(2)).toHaveValue('2.5');
  await expect(page.getByLabel('result_1', { exact: true })).toHaveText('5.00');
  await page.getByRole('link', { name: 'Clone row', exact: true }).nth(2).click();
  await expect(raw).toHaveCount(4); await expect(raw.nth(3)).toHaveValue('');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('link', { name: 'Delete row', exact: true }).nth(3).click();
  await expect(raw).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('datasheet-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Add Results', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.lims-main').evaluate((element) => element.getBoundingClientRect().left)).toBe(0);
  await expect.poll(() => page.locator('.lims-main').evaluate((element) => element.getBoundingClientRect().width)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('datasheet-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  let fail = true;
  const rootField = source.source.template.records.fields[2];
  await page.route(`**/api/datasheets/${source.datasheetId}/values`, async (route) => {
    const body = route.request().postDataJSON();
    if (fail && body.values.some((value) => value.fieldId === rootField.id)) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'synthetic_unavailable', message: 'Synthetic save interruption' } }) });
    } else await route.continue();
  });
  await page.getByRole('spinbutton', { name: 'raw_1', exact: true }).fill('7');
  await raw.first().fill('1');
  await expect(page.locator('.tr-details-results-page').getByRole('alert')).toContainText('Synthetic save interruption');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.tr-details-results-page').getByRole('alert')).toContainText('Synthetic save interruption');
  await expect(page).toHaveURL(new RegExp(`${source.datasheetId}$`));
  await expect.poll(async () => (await runtime(page, source.datasheetId)).capture.values.some((value) => value.fieldId === source.source.template.records.fields[0].id && value.numberValue === '1')).toBe(true);
  fail = false;
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('.tr-details-results-page').getByRole('alert')).toHaveCount(0);
  await page.getByRole('spinbutton', { name: 'raw_1', exact: true }).fill('11');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(`/samples/${source.sample.id}/test_requests/${source.requestId}`);
  await expect(page.getByRole('heading', { name: /^TR-2026-/ })).toBeVisible();
  const saved = await runtime(page, source.datasheetId);
  expect(saved.capture.values.find((value) => value.fieldId === rootField.id).numberValue).toBe('11');
  expect(saved.datasheet.status).toBe('in_progress'); expect(saved.datasheet.requestStatus).toBe('allocated');
  await page.getByRole('link', { name: 'Add Results', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'raw_1', exact: true })).toHaveValue('11');
  expect(errors).toEqual([]);
});

test('stale browser edits stay visible until explicit reload, and readers/history cannot execute or forge CSRF', async ({ page, context }) => {
  const source = await fixture(); await login(page, source.account); await page.goto(source.path);
  const other = await context.newPage(); await other.goto(source.path);
  await expect(other.getByRole('spinbutton', { name: 'raw_0', exact: true })).toHaveCount(2);
  await page.getByRole('spinbutton', { name: 'raw_0', exact: true }).first().fill('4');
  await page.getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(page.getByLabel('result_0', { exact: true }).first()).toHaveText('8.00');
  await other.getByRole('spinbutton', { name: 'raw_0', exact: true }).first().fill('9');
  await other.getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(other.locator('.tr-details-results-page').getByRole('alert')).toContainText('Reload before saving');
  await expect(other.getByRole('spinbutton', { name: 'raw_0', exact: true }).first()).toHaveValue('9');
  other.once('dialog', (dialog) => dialog.accept());
  await other.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(other.getByRole('spinbutton', { name: 'raw_0', exact: true }).first()).toHaveValue('4');
  await expect(other.locator('.tr-details-results-page').getByRole('alert')).toHaveCount(0);
  const denied = await page.evaluate(async (id) => {
    const response = await fetch(`/api/datasheets/${id}/calculate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1 }) });
    return response.status;
  }, source.datasheetId);
  expect(denied).toBe(403);
  await other.goto(`${source.path}?revision=1`);
  await expect(other.getByRole('heading', { name: 'Add Results', exact: true })).toBeVisible();
  await expect(other.getByRole('spinbutton')).toHaveCount(0);
  await expect(other.getByRole('button', { name: 'Calculate', exact: true })).toBeDisabled();
  await other.close();

  const reader = await createAccount(owner, { organizationId: source.account.organizationId, permissions: ['samples.read'] });
  const readerContext = await context.browser().newContext(); const readerPage = await readerContext.newPage();
  try {
    await login(readerPage, reader); await readerPage.goto(source.path);
    await expect(readerPage.getByRole('heading', { name: 'Add Results', exact: true })).toBeVisible();
    await expect(readerPage.getByRole('spinbutton')).toHaveCount(0);
    await expect(readerPage.getByRole('button', { name: 'Calculate', exact: true })).toBeDisabled();
    const result = await runtime(readerPage, source.datasheetId); expect(result.canExecute).toBe(false);
  } finally { await readerContext.close(); }
});

for (const legacyHistory of [false, true]) test(`browser traversal and logout preserve pending values${legacyHistory ? ' without Navigation API' : ''}`, async ({ page }) => {
  if (legacyHistory) await page.addInitScript(() => Object.defineProperty(window, 'navigation', { value: undefined }));
  const source = await fixture(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requestPath = `/samples/${source.sample.id}/test_requests/${source.requestId}`;
  const fieldId = source.source.template.records.fields[2].id;
  const input = page.getByRole('spinbutton', { name: 'raw_1', exact: true });
  const savedValue = async () => (await runtime(page, source.datasheetId)).capture.values.find((value) => value.fieldId === fieldId)?.numberValue;
  await login(page, source.account); await page.goto(requestPath);
  await page.getByRole('link', { name: 'Add Results', exact: true }).click();
  await input.fill('6');
  await page.evaluate(() => window.history.back());
  await expect(page).toHaveURL(requestPath);
  await expect.poll(savedValue).toBe('6');
  await page.evaluate(() => window.history.forward());
  await expect(input).toHaveValue('6');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(requestPath);
  await page.getByRole('link', { name: 'Add Results', exact: true }).click();
  await expect(input).toHaveValue('6');

  let fail = true;
  await page.route(`**/api/datasheets/${source.datasheetId}/values`, async (route) => {
    if (fail) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic navigation save interruption' } }) });
    else await route.continue();
  });
  await input.fill('7');
  await page.evaluate(() => window.history.go(-3));
  const alert = page.locator('.tr-details-results-page').getByRole('alert');
  await expect(alert).toContainText('Synthetic navigation save interruption');
  await expect(page).toHaveURL(source.path); await expect(input).toHaveValue('7');
  await expect.poll(savedValue).toBe('6');
  await page.locator('.sidebar-shell-desktop').getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(alert).toContainText('Synthetic navigation save interruption');
  await expect(page.locator('.sidebar-shell-desktop').getByRole('button', { name: 'Log out', exact: true })).toBeEnabled();
  expect((await page.request.get('/api/auth/session')).status()).toBe(200);
  await expect(input).toHaveValue('7');
  fail = false;
  await page.locator('.sidebar-shell-desktop').getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL('/login');
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  await login(page, source.account); await page.goto(source.path);
  await expect(input).toHaveValue('7');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(requestPath);
  await page.evaluate(() => window.history.back());
  await expect(input).toHaveValue('7');
  await input.fill('8');
  await page.evaluate(() => window.history.forward());
  await expect(page).toHaveURL(requestPath); await expect.poll(savedValue).toBe('8');
  expect(errors).toEqual([]);
});
