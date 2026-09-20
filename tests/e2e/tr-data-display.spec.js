import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareTrDataDisplayFlow, renameTrParameter } from '../helpers/tr-data.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { generateReports } from '../../src/reports/service.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

test('TR Data renders scientific markup in datasheets and frozen reports while retaining the source designer preview', async ({ page }, testInfo) => {
  const user = await createAccount(owner, { permissions: ['masters.manage', 'templates.manage', 'templates.read', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const work = (action) => withSession(account.token, action, { csrfToken: account.csrfToken });
  const flow = await prepareTrDataDisplayFlow(owner, account);
  const reportField = flow.template.records.fields.find((field) => field.widget === 'tr_data_widget');
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(user.username); await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  await page.goto(`/master_template_management/${flow.template.templateId}`);
  const cell = page.locator(`[data-field-id="${reportField.id}"]`);
  await expect(cell.getByText('TR data widget preview', { exact: true })).toBeVisible();
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  expect(generated.items).toHaveLength(1);
  await page.goto(`/samples/${flow.sample.id}/data_sheets/${flow.sheet.id}`);
  const sheet = await page.request.get(`/api/datasheets/${flow.sheet.id}`).then((response) => response.json());
  const sheetField = Object.values(sheet.model.fieldsById).find((field) => field.widget === 'tr_data_widget');
  const sheetCell = page.locator(`[data-field-id="${sheetField.id}"]`);
  await expect(sheetCell.locator('strong').first()).toHaveText('Water H2O'); await expect(sheetCell.locator('sub').first()).toHaveText('2');
  await expect(sheetCell.locator('sup').first()).toHaveText('2');
  await page.screenshot({ path: testInfo.outputPath('tr-data-markup-datasheet.png'), fullPage: true, animations: 'disabled' });
  await work((client, identity) => renameTrParameter(client, identity, flow.fixture.parameter.id, 'Later scientific label'));
  await page.goto(`/samples/${flow.sample.id}/coa`);
  const reportCell = page.frameLocator('.finalised-report-preview__frame').locator(`[data-field-id="${reportField.id}"]`);
  await expect(reportCell.locator('strong').first()).toHaveText('Water H2O'); await expect(reportCell.locator('sub').first()).toHaveText('2');
  await page.reload(); await expect(reportCell.locator('strong').first()).toHaveText('Water H2O');
  await page.screenshot({ path: testInfo.outputPath('tr-data-markup-report-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reportCell.locator('sup').first()).toHaveText('2');
  await page.screenshot({ path: testInfo.outputPath('tr-data-markup-report-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('TR Data displays unsupported active markup and unbound external images as literal text', async ({ page, context }) => {
  const user = await createAccount(owner, { permissions: ['masters.manage', 'templates.manage', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const name = '<strong onclick="window.trExecuted=true">Safe H<sub>2</sub>O</strong><script>window.trExecuted=true</script>';
  const flow = await prepareTrDataDisplayFlow(owner, account, { name, complete: false });
  const external = []; context.on('request', (request) => { if (request.url().startsWith('https://example.invalid/')) external.push(request.url()); });
  await context.route('https://example.invalid/**', (route) => route.abort());
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(user.username); await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  const path = `/samples/${flow.sample.id}/data_sheets/${flow.sheet.id}`; const api = `/api/datasheets/${flow.sheet.id}`;
  await page.goto(path);
  const body = await page.request.get(api).then((response) => response.json());
  const field = Object.values(body.model.fieldsById).find((field) => field.widget === 'tr_data_widget');
  const cell = page.locator(`[data-field-id="${field.id}"]`);
  await expect(cell.locator('script')).toHaveCount(0); await expect(cell.locator('[onclick]')).toHaveCount(0);
  await expect(cell.first()).toHaveText(name); await cell.first().click();
  expect(await page.evaluate(() => window.trExecuted)).toBeUndefined();
  // A synthetic transport fixture verifies the same renderer fallback without
  // attaching an external asset or modifying frozen database history.
  const unbound = '<img src="https://example.invalid/unbound.png" alt="Unbound TR image">';
  await page.route(`**${api}?*`, async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const row of data.dataContext.results) row.parameterName = unbound;
    for (const row of Object.values(data.dataContext.parametersByRequestId)) row.parameterName = unbound;
    await route.fulfill({ response, json: data });
  });
  await page.reload(); await expect(cell.first()).toHaveText(unbound); await expect(cell.locator('img')).toHaveCount(0);
  expect(external).toEqual([]);
});
