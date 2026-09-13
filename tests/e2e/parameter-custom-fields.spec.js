import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

test.use({ timezoneId: 'America/New_York' });
let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

test('parameter form preserves source custom controls, generated values, dates and exact lost-response retries', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const user = await createAccount(owner, { permissions: ['masters.manage'] });
  const session = await signIn({ identifier: user.username, password: user.password });
  const specifications = [
    ['text', 'Additional Title', { isRequired: true, showInList: true, showInFilter: true }], ['number', 'Additional Number', { showInList: true }], ['checkbox', 'Additional Flag', { isRequired: true }],
    ['select', 'Additional Choice', { options: [{ id: randomUUID(), key: 'A', label: 'Alpha' }] }],
    ['date_time', 'Additional Date Time', {}], ['attachment', 'Additional Attachment', {}],
    ['text', 'Initial Code', { scheme: '{{entity.scheme_abbr}}/{{total_counter}}', generatedAt: 'on_init' }],
    ['text', 'Submit Code', { scheme: '{{field_6}}/{{entity.name}}/{{product_name}}', generatedAt: 'on_submit' }],
  ];
  for (const [index, [fieldType, label, extra]] of specifications.entries()) await withSession(session.token, (client, identity) => saveCustomField(client, identity,
    { id: randomUUID(), requestId: randomUUID(), revision: 0, key: `field_${index}`, associatedWith: 'parameter', fieldType, label, displayOrder: index, ...extra }), { csrfToken: session.csrfToken });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(user.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  await page.goto('/test_parameters/new'); await expect(page.getByText('Additional Data Fields', { exact: true })).toBeVisible();
  await page.getByLabel('Parameter Name', { exact: true }).fill('Synthetic parameter');
  await page.getByLabel('Key', { exact: true }).fill('SYNTHETIC-PARAMETER');
  await page.getByLabel('Scheme Abbreviation', { exact: true }).fill('Ni');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Required', { exact: true })).toHaveCount(2);
  await page.getByLabel('Additional Title', { exact: true }).fill('Captured title');
  await page.getByLabel('Additional Number', { exact: true }).fill('0');
  await page.getByRole('checkbox', { name: 'Additional Flag', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Additional Flag', exact: true }).uncheck();
  await page.getByLabel('Additional Choice', { exact: true }).selectOption('A');
  await page.getByLabel('Additional Date Time', { exact: true }).fill('2026-03-08T02:30');
  await page.getByLabel('Additional Attachment', { exact: true }).setInputFiles({ name: 'Synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic parameter bytes') });
  await expect(page.getByRole('link', { name: 'View File', exact: true })).toBeVisible();
  let saved; let originalBody;
  await page.route('**/api/masters/test-parameters', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    originalBody = route.request().postDataJSON(); const response = await route.fetch();
    expect(response.status()).toBe(200); saved = await response.json();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost save response' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Synthetic lost save response', { exact: true })).toBeVisible();
  expect(saved.customFields.map((field) => field.value).slice(0, 5)).toEqual(['Captured title', '0', false, 'A', '2026-03-08T02:30']);
  expect(saved.customFields.slice(6).map((field) => field.value)).toEqual(['Ni/1', 'Ni/1/Synthetic parameter/']);
  expect(saved.customFields[4].displayValue).toBe('08/03/2026 03:30:00');
  await page.unroute('**/api/masters/test-parameters');
  const retry = page.waitForRequest((request) => request.url().endsWith('/api/masters/test-parameters') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); expect((await retry).postDataJSON()).toEqual(originalBody);
  await expect(page).toHaveURL(/\/test_parameters$/);
  await expect(page.getByRole('columnheader', { name: 'Additional Title', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Captured title', exact: true })).toBeVisible();
  await page.goto(`/test_parameters/${saved.id}/edit`);
  await expect(page.getByLabel('Additional Title', { exact: true })).toHaveValue('Captured title');
  await expect(page.getByLabel('Additional Flag', { exact: true })).not.toBeChecked();
  await expect(page.getByRole('link', { name: 'View File', exact: true })).toBeVisible();
  await expect(page.getByLabel('Additional Date Time', { exact: true })).toHaveValue('2026-03-08T02:30');
  await page.getByText('Additional Data Fields', { exact: true }).evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: testInfo.outputPath('parameter-custom-fields-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await page.getByText('Additional Data Fields', { exact: true }).evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: testInfo.outputPath('parameter-custom-fields-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Update', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('parameter-custom-fields-mobile-bottom.png'), fullPage: true });
  expect(errors).toEqual([]);
});
