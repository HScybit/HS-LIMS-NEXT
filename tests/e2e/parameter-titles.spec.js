import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareParameterTitleFlow } from '../helpers/parameter-titles.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveTestParameter } from '../../src/masters/test-parameters.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

test('edited custom-field titles refresh immediately and retain frozen mappings through cloning and reload', async ({ page }, testInfo) => {
  const user = await createAccount(owner, { permissions: ['masters.manage', 'templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const flow = await prepareParameterTitleFlow(owner, account, { complete: false,
    titles: [['custom_edit', 'name', 'text_widget', true], ['custom_zero', 'prefix.zero', 'text_widget', false], ['custom_flag', 'prefix.flag', 'vertical_text_widget', false]],
    literalTitle: 'literal.extra', prepareParameter: async (client, identity) => {
      const fields = [];
      for (const [index, [key, fieldType, value]] of [['zero', 'number', 0], ['flag', 'checkbox', false], ['extra', 'text', '<b>Captured extra</b>']].entries()) {
        const field = await saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0, key, label: key, fieldType, associatedWith: 'parameter', displayOrder: index });
        fields.push({ fieldId: field.id, fieldRevision: field.revision, value });
      }
      return { customFields: fields };
    } });
  const fields = flow.datasheetTitles.fields;
  const api = `/api/datasheets/${flow.sheet.id}`; const path = `/samples/${flow.sample.id}/data_sheets/${flow.sheet.id}`;
  const cells = (alias) => page.locator(`[data-field-id="${fields[alias]}"]`);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  await page.goto(path);
  await expect(cells('custom_edit')).toHaveText(['Captured parameter', 'Captured parameter']);
  await expect(cells('custom_zero')).toHaveText(['0', '0']); await expect(cells('custom_flag').locator('p')).toHaveText(['', '']);
  await expect(cells('literal_name_title')).toHaveText('literal.extra');
  const initial = await page.request.get(api).then((response) => response.json());
  expect(Object.keys(initial.dataContext.results[0].parameterTitleValues.project_field_data)).toEqual(['zero', 'flag']);
  await cells('custom_edit').first().getByRole('button', { name: 'Edit custom_edit', exact: true }).click();
  const input = cells('custom_edit').first().getByRole('textbox', { name: 'Edit custom_edit', exact: true });
  await input.fill('project_field_data.extra');
  let attempted;
  await page.route(`**${api}/values`, async (route) => {
    attempted = route.request().postDataJSON();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic title save failure' } }) });
  });
  const saved = page.waitForResponse((response) => response.url().endsWith(`${api}/values`) && response.request().method() === 'PATCH');
  await input.press('Enter'); expect((await saved).status()).toBe(503);
  await expect(page.getByText('Synthetic title save failure', { exact: false })).toBeVisible();
  expect((await page.request.get(api).then((response) => response.json())).capture.revision).toBe(initial.capture.revision);
  await page.unroute(`**${api}/values`);
  const retried = page.waitForResponse((response) => response.url().endsWith(`${api}/values`) && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  const response = await retried; expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual(attempted);
  await expect(cells('custom_edit').first().locator('b')).toHaveText('Captured extra');
  const cloned = page.waitForResponse((response) => response.url().endsWith(`${api}/repeats`));
  await cells('custom_edit').first().locator('..').getByRole('link', { name: 'Clone row with data', exact: true }).click(); expect((await cloned).status()).toBe(200);
  await expect(cells('custom_edit').locator('b')).toHaveText(['Captured extra', 'Captured extra']);
  await page.reload(); await expect(cells('custom_edit').locator('b')).toHaveText(['Captured extra', 'Captured extra']);
  await cells('custom_edit').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('custom-titles-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await cells('custom_edit').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('custom-titles-mobile.png'), fullPage: true });
  await testInfo.attach('parameter-title-runtime-timing', { contentType: 'application/json', body: Buffer.from(JSON.stringify(await page.evaluate(() =>
    performance.getEntriesByType('measure').filter((entry) => entry.name.startsWith('datasheet:')).map(({ name, duration }) => ({ name, duration }))), null, 2)) });
  await page.goto(`${path}?revision=1`); await expect(cells('custom_edit')).toHaveText(['Captured parameter', 'Captured parameter']);
  await expect(cells('custom_edit').getByRole('button')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('parameter titles keep actual row bindings, numeric editing, repeated mappings and captured history', async ({ page, context }, testInfo) => {
  const user = await createAccount(owner, { permissions: ['masters.manage', 'templates.read', 'templates.manage', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const flow = await prepareParameterTitleFlow(owner, account, { complete: false });
  const fields = flow.datasheetTitles.fields;
  const api = `/api/datasheets/${flow.sheet.id}`; const path = `/samples/${flow.sample.id}/data_sheets/${flow.sheet.id}`;
  const runtime = async () => page.request.get(api).then((response) => response.json());
  const cells = (alias) => page.locator(`[data-field-id="${fields[alias]}"]`);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  await page.goto(`/master_template_management/${flow.fixture.template.templateId}`);
  await expect(cells('parameter_name_title').locator('.row1')).toHaveText('name'); await expect(cells('parameter_order_title').locator('.row1')).toHaveText('order');
  await expect(cells('parameter_vertical_name').locator('p')).toHaveText('name');
  const previewPromise = context.waitForEvent('page'); await page.getByRole('link', { name: 'Print Preview', exact: true }).click();
  const preview = await previewPromise;
  await expect(preview.locator(`[data-field-id="${fields.parameter_name_title}"]`)).toHaveText('name'); await preview.close();
  await page.goto(path);
  await expect(cells('parameter_name_title')).toHaveText(['Captured parameter', 'Captured parameter']);
  await expect(cells('parameter_order_title')).toHaveText(['0', '0']);
  await expect(cells('parameter_description_title').locator('sub')).toHaveText(['2', '2']);
  await expect(cells('parameter_vertical_name').locator('p')).toHaveText(['Captured parameter', 'Captured parameter']);
  await expect(cells('parameter_vertical_order').locator('p')).toHaveText(['0', '0']);
  await expect(cells('literal_name_title')).toHaveText('name');
  const initial = await runtime();
  const editOrder = () => cells('parameter_order_title').first().getByRole('button', { name: 'Edit parameter_order_title', exact: true });
  const orderInput = () => cells('parameter_order_title').first().getByRole('textbox', { name: 'Edit parameter_order_title', exact: true });
  await editOrder().click(); await expect(orderInput()).toHaveValue('0'); await orderInput().press('Escape');
  expect((await runtime()).capture.revision).toBe(initial.capture.revision);
  await editOrder().click();
  const numericSave = page.waitForResponse((response) => response.url().endsWith(`${api}/values`) && response.request().method() === 'PATCH');
  await orderInput().press('Enter'); expect((await numericSave).status()).toBe(200);
  const numeric = await runtime();
  expect(numeric.capture.values.filter((value) => value.fieldId === fields.parameter_order_title && value.origin === 'entered').map((value) => value.textValue)).toEqual(['0']);
  await cells('parameter_name_title').first().getByRole('button', { name: 'Edit parameter_name_title', exact: true }).click();
  const nameInput = cells('parameter_name_title').first().getByRole('textbox', { name: 'Edit parameter_name_title', exact: true });
  await expect(nameInput).toHaveValue('Captured parameter'); await nameInput.fill(' key ');
  const mappedSave = page.waitForResponse((response) => response.url().endsWith(`${api}/values`) && response.request().method() === 'PATCH');
  await nameInput.press('Enter'); expect((await mappedSave).status()).toBe(200);
  await expect(cells('parameter_name_title')).toHaveText(['CAPTURED-KEY', 'Captured parameter']);
  const cloned = page.waitForResponse((response) => response.url().endsWith(`${api}/repeats`));
  await cells('parameter_name_title').first().locator('..').getByRole('link', { name: 'Clone row with data', exact: true }).click();
  expect((await cloned).status()).toBe(200);
  await expect(cells('parameter_name_title')).toHaveCount(3);
  expect((await cells('parameter_name_title').allTextContents()).sort()).toEqual(['CAPTURED-KEY', 'CAPTURED-KEY', 'Captured parameter']);
  await withSession(account.token, (client, identity) => saveTestParameter(client, identity, { ...flow.parameterCommand, revision: 2, requestId: randomUUID(),
    name: 'Later parameter', key: 'LATER-KEY', schemeAbbreviation: 'LP', order: 9, description: 'Later description' }), { csrfToken: account.csrfToken });
  await page.reload(); await expect(cells('parameter_description_title').locator('sub')).toHaveText(['2', '2', '2']);
  await expect(cells('parameter_vertical_name').locator('p')).toHaveText(['Captured parameter', 'Captured parameter', 'Captured parameter']);
  await page.screenshot({ path: testInfo.outputPath('parameter-titles-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await page.screenshot({ path: testInfo.outputPath('parameter-titles-mobile.png'), fullPage: true });
  await page.goto(`${path}?revision=1`);
  await expect(cells('parameter_name_title')).toHaveText(['Captured parameter', 'Captured parameter']);
  await expect(cells('parameter_name_title').getByRole('button')).toHaveCount(0);
  await expect(cells('parameter_vertical_order').locator('p')).toHaveText(['0', '0']);
  expect(errors).toEqual([]);
});
