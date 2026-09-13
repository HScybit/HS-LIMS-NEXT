import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { prepareSampleLineFlow } from '../helpers/sample-lines.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { loadDefinition } from '../../src/templates/loader.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function account() {
  const user = await createAccount(owner, { permissions: ['masters.manage', 'templates.read', 'templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
async function login(page, user) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(user.username); await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}

test('the source line attribute selector preserves separate configuration and retries a failed choice', async ({ page }, testInfo) => {
  const user = await account(); const fixture = await createLaboratoryFixture(owner, user, { repeated: false });
  const added = await withSession(user.token, (client, identity) => editTemplate(client, identity, fixture.template.versionId, 1,
    { type: 'addColumn', rowId: fixture.template.records.rows[0].id }), { csrfToken: user.csrfToken });
  const columnId = added.model.rowsById[fixture.template.records.rows[0].id].columnIds.at(-1);
  await login(page, user); await page.goto(`/master_template_management/${fixture.template.templateId}`);
  await page.getByRole('button', { name: 'Edit Mode Off' }).click();
  const column = page.locator(`[data-col-id="${columnId}"]`);
  await column.locator('.action-dropdown-toggle').click(); await page.getByRole('menuitem', { name: 'Column', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Column Settings' });
  await settings.getByRole('combobox', { name: 'Widget' }).fill('Sample Line Item Data Widget');
  await page.getByRole('option', { name: 'Sample Line Item Data Widget', exact: true }).click();
  await settings.getByRole('button', { name: 'Save', exact: true }).click(); await expect(settings).toBeHidden();
  await column.locator('.action-dropdown-toggle').click(); await page.getByRole('menuitem', { name: 'Widget', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Widget Configuration' });
  await dialog.getByLabel('Key', { exact: true }).fill('line_description');
  await dialog.getByLabel('Attribute Name/Key', { exact: true }).fill('Unused independent attribute');
  await dialog.getByLabel('Default Value', { exact: true }).fill('Unused configured default');
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Update data', exact: true }).click(); await expect(dialog).toBeHidden();
  const selection = column.getByRole('combobox', { name: 'Line Item Attribute', exact: true });
  const api = `/api/template-versions/${fixture.template.versionId}`;
  await page.route(`**${api}`, (route) => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
  await selection.fill('Description'); await page.getByRole('option', { name: 'Description', exact: true }).click();
  await expect(column.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(column).toContainText('Description');
  await page.unroute(`**${api}`);
  const saved = page.waitForResponse((response) => response.url().endsWith(api) && response.request().method() === 'PATCH');
  await column.getByRole('button', { name: 'Retry', exact: true }).click(); expect((await saved).status()).toBe(200);
  await expect(column.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  const current = await withSession(user.token, (client, identity) => loadDefinition(client, identity.organization_id, fixture.template.versionId), { readOnly: true });
  const field = current.model.fieldsById[current.model.columnsById[columnId].fieldId];
  expect([field.sourceField, field.attributeKey, field.defaultText, field.alias]).toEqual(['custom_description', 'Unused independent attribute', 'Unused configured default', 'line_description']);
  await column.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('sample-line-designer-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await column.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('sample-line-designer-mobile.png'), fullPage: true });
  await page.reload(); await page.getByRole('button', { name: 'Edit Mode Off' }).click();
  await expect(column).toContainText('Description');
  await selection.click(); await selection.press('Backspace');
  await expect.poll(async () => {
    const loaded = await withSession(user.token, (client, identity) => loadDefinition(client, identity.organization_id, fixture.template.versionId), { readOnly: true });
    return loaded.model.fieldsById[field.id].sourceField;
  }).toBe(null);
});

test('datasheet line values survive source edits, cloning, reload and read-only history on desktop and mobile', async ({ page }, testInfo) => {
  const user = await account(); const flow = await prepareSampleLineFlow(owner, user, { complete: false, secondLine: false });
  const path = `/samples/${flow.sample.id}/data_sheets/${flow.sheet.id}`; const api = `/api/datasheets/${flow.sheet.id}`;
  const cells = (attribute) => page.locator(`[data-field-id="${flow.datasheetTemplate.fieldIds[attribute]}"]`);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, user); await page.goto(path);
  await expect(cells('custom_description')).toHaveText(['First captured line']);
  await expect(cells('custom_sample_quantity')).toHaveText(['1.00000000000000001']);
  await expect(cells('custom_indentification_mark')).toHaveText(['LINE-A']);
  await expect(page.getByRole('combobox', { name: 'Line Item Attribute', exact: true })).toHaveCount(0);
  await owner.query('UPDATE sample_products SET description=$3,quantity=$4 WHERE organization_id=$1 AND sample_id=$2', [user.organizationId, flow.sample.id, 'Later source line', '99']);
  const cloned = page.waitForResponse((response) => response.url().endsWith(`${api}/repeats`));
  await cells('custom_description').locator('..').getByRole('link', { name: 'Clone row with data', exact: true }).click();
  expect((await cloned).status()).toBe(200);
  await expect(cells('custom_description')).toHaveText(['First captured line', 'First captured line']);
  await page.reload(); await expect(cells('custom_sample_quantity')).toHaveText(['1.00000000000000001']);
  await cells('custom_description').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('sample-line-datasheet-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await cells('custom_description').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('sample-line-datasheet-mobile.png'), fullPage: true });
  await page.goto(`${path}?revision=1`); await expect(cells('custom_description')).toHaveText(['First captured line']);
  await expect(page.getByRole('link', { name: 'Clone row with data', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('generated COAs retain submitted datasheet lines alongside the child report line', async ({ page }, testInfo) => {
  const user = await account(); const flow = await prepareSampleLineFlow(owner, user);
  await owner.query('UPDATE sample_products SET description=$3 WHERE organization_id=$1 AND sample_id=$2',
    [user.organizationId, flow.sample.id, 'Line observed at report generation']);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, user); await page.goto(`/samples/${flow.sample.id}/coa`);
  await page.getByRole('button', { name: /^Consolidated/ }).click();
  await page.getByLabel('Consolidated Report template', { exact: true }).selectOption(flow.template.templateId);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const report = page.frameLocator('.finalised-report-preview__frame').getByRole('article');
  const submitted = report.locator(`[data-field-id="${flow.datasheetTemplate.fieldIds.custom_description}"]`);
  const direct = report.locator(`[data-field-id="${flow.reportTemplate.fieldIds.custom_description}"]`);
  await expect(submitted).toHaveText(['First captured line', 'Second captured line']);
  await expect(direct).toHaveText(['Line observed at report generation', 'Line observed at report generation']);
  await owner.query('UPDATE sample_products SET description=$3 WHERE organization_id=$1 AND sample_id=$2',
    [user.organizationId, flow.sample.id, 'Later sample line']);
  await page.reload();
  await expect(submitted).toHaveText(['First captured line', 'Second captured line']);
  await expect(direct).toHaveText(['Line observed at report generation', 'Line observed at report generation']);
  await page.screenshot({ path: testInfo.outputPath('submitted-lines-report-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await expect(submitted).toHaveText(['First captured line', 'Second captured line']);
  await page.screenshot({ path: testInfo.outputPath('submitted-lines-report-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
