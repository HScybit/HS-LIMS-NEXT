import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { addSerialColumns } from '../helpers/serial-numbers.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function account() {
  const user = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
async function login(page, user) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(user.username); await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const serial = (page, fieldId) => page.locator(`[data-field-id="${fieldId}"] .row1 > [data-ms-id]`);

test('designer serial numbers reflect padding, row order and reload', async ({ page }, testInfo) => {
  const user = await account(); const fixture = await createLaboratoryFixture(owner, user, { repeated: false });
  const template = await withSession(user.token, (client, identity) => addSerialColumns(client, identity, fixture.template), { csrfToken: user.csrfToken });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, user); await page.goto(`/master_template_management/${template.templateId}`);
  await expect(serial(page, template.fieldIds[0])).toHaveText('01');
  await expect(serial(page, template.fieldIds[1])).toHaveText('02');
  await page.getByRole('button', { name: 'Edit Mode Off' }).click();
  const column = page.locator(`[data-field-id="${template.fieldIds[0]}"]`);
  await column.locator('.action-dropdown-toggle').click(); await page.getByRole('menuitem', { name: 'Widget', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Widget Configuration' });
  await dialog.getByLabel('0 Padding', { exact: true }).fill('3');
  await dialog.getByRole('button', { name: 'Update data', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(serial(page, template.fieldIds[0])).toHaveText('001');
  await page.locator(`.widget-row[data-row-id="${template.records.rows[0].id}"]`).getByRole('button', { name: 'Move row down', exact: true }).click();
  await expect(serial(page, template.fieldIds[0])).toHaveText('002');
  await expect(serial(page, template.fieldIds[1])).toHaveText('01');
  await page.reload(); await expect(serial(page, template.fieldIds[0])).toHaveText('002');
  await page.getByRole('button', { name: 'Edit Mode Off' }).click();
  await column.locator('.action-dropdown-toggle').click(); await page.getByRole('menuitem', { name: 'Widget', exact: true }).click();
  await dialog.getByLabel('0 Padding', { exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Update data', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(serial(page, template.fieldIds[0])).toHaveText('2');
  await column.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('serial-designer-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await column.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('serial-designer-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('datasheet cloning and deletion renumber subsequent rows while history retains its original sequence', async ({ page }, testInfo) => {
  const user = await account(); let template;
  const flow = await prepareReportFlow(owner, user, { complete: false, finalSection: true,
    prepareDatasheet: async (client, identity, draft) => { template = await addSerialColumns(client, identity, draft); } });
  const path = `/samples/${flow.sample.id}/data_sheets/${flow.sheet.id}`;
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, user); await page.goto(path);
  await expect(serial(page, template.fieldIds[0])).toHaveText(['01', '02']);
  await expect(serial(page, template.fieldIds[1])).toHaveText(['03']);
  await page.getByRole('link', { name: 'Clone row with data', exact: true }).first().click();
  await expect(serial(page, template.fieldIds[0])).toHaveText(['01', '02', '03']);
  await expect(serial(page, template.fieldIds[1])).toHaveText(['04']);
  await page.reload(); await expect(serial(page, template.fieldIds[1])).toHaveText(['04']);
  await page.screenshot({ path: testInfo.outputPath('serial-datasheet-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await page.screenshot({ path: testInfo.outputPath('serial-datasheet-mobile.png'), fullPage: true });
  await page.goto(`${path}?revision=1`);
  await expect(serial(page, template.fieldIds[0])).toHaveText(['01', '02']);
  await expect(serial(page, template.fieldIds[1])).toHaveText(['03']);
  await expect(page.getByRole('link', { name: 'Delete row', exact: true })).toHaveCount(0);
  await page.goto(path);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('link', { name: 'Delete row', exact: true }).nth(1).click();
  await expect(serial(page, template.fieldIds[0])).toHaveText(['01', '02']);
  await expect(serial(page, template.fieldIds[1])).toHaveText(['03']);
  expect(errors).toEqual([]);
});

test('COA preview preserves each submitted datasheet sequence alongside direct parameter numbering', async ({ page }, testInfo) => {
  const user = await account(); let template;
  const flow = await prepareReportFlow(owner, user, { finalSection: true, productLines: 2,
    prepareDatasheet: async (client, identity, draft) => { template = await addSerialColumns(client, identity, draft); } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, user); await page.goto(`/samples/${flow.sample.id}/coa`);
  await page.getByRole('button', { name: /^Consolidated/ }).click();
  await page.getByLabel('Consolidated Report template', { exact: true }).selectOption(flow.template.templateId);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const report = page.frameLocator('.finalised-report-preview__frame').getByRole('article');
  await expect(serial(report, template.fieldIds[0])).toHaveText(['01', '02', '01', '02']);
  await expect(serial(report, template.fieldIds[1])).toHaveText(['03', '03']);
  const direct = flow.template.records.fields.find((field) => field.widget === 'sno_widget');
  await expect(serial(report, direct.id)).toHaveText(['01', '02']);
  await page.reload(); await expect(serial(report, template.fieldIds[1])).toHaveText(['03', '03']);
  await page.screenshot({ path: testInfo.outputPath('serial-report-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await expect(serial(report, template.fieldIds[0])).toHaveText(['01', '02', '01', '02']);
  await page.screenshot({ path: testInfo.outputPath('serial-report-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
