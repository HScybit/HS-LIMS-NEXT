import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => owner.end());

async function signIn(page, account) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}

async function chooseWidget(page, column, widget) {
  await column.locator('.template-studio-field-action').click();
  const dialog = page.getByRole('dialog', { name: 'Column Settings' });
  await expect(dialog.getByRole('heading', { name: 'Layout', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Access', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Display', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Index', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Master', { exact: true })).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Widget' }).fill(widget);
  await expect(dialog.getByRole('combobox', { name: 'Widget' })).toBeFocused();
  await expect(dialog.getByRole('combobox', { name: 'Widget' })).toHaveValue(widget);
  await page.getByRole('option', { name: widget, exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Updated successfully!').last()).toBeVisible();
}

async function configureWidget(page, column, alias, formula) {
  await column.locator('.template-studio-field-action').click();
  const dialog = page.getByRole('dialog', { name: 'Configure field' });
  await expect(dialog.getByRole('heading', { name: 'What should this field do?', exact: true })).toBeVisible();
  await dialog.getByLabel('Key', { exact: true }).fill(alias);
  if (formula) {
    await dialog.getByLabel('Formula', { exact: true }).fill(formula);
    await dialog.getByLabel('Decimal Points', { exact: true }).fill('2');
    await dialog.getByRole('checkbox', { name: 'Show Decimal Points' }).check();
  }
  await dialog.getByRole('button', { name: 'Save field' }).click();
  await expect(page.getByText('Updated successfully!').last()).toBeVisible();
}

test('source designer creates widgets, edits formulas, reloads, clones, reorders and opens HTML preview', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  const account = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute'] });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, account);
  await page.goto('/master_template_management');
  await expect(page.getByText('No data found')).toBeVisible();
  await page.getByRole('button', { name: 'New Master Template' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Browser analysis');
  await page.getByLabel('Template Type').selectOption('job_template');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('link', { name: 'Edit Template', exact: true }).click();
  await expect(page.getByText('Template studio', { exact: true })).toBeVisible();
  await expect(page.locator('.template-designer-studio')).toHaveClass(/is-outline-open/);
  await expect(page.locator('.template-designer-studio')).toHaveClass(/is-inspector-open/);
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Template outline' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Template canvas' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Template outline' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Selected item properties' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No containers yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Container', exact: true }).first().click();
  await page.locator('.template-studio-node-bar--section .template-studio-node-identity').first().click();
  const dock = page.getByRole('complementary', { name: 'Properties' });
  await dock.getByRole('button', { name: 'Add row', exact: true }).click();
  await expect(page.locator('.widget-row')).toHaveCount(1);
  await dock.getByRole('button', { name: 'Container settings', exact: true }).click();
  const containerDialog = page.getByRole('dialog', { name: 'Container settings' });
  await containerDialog.getByLabel('Unique Name').fill('analysis');
  await containerDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Updated successfully!').last()).toBeVisible();
  const firstColumn = page.locator('.widget-col').nth(0);
  await chooseWidget(page, firstColumn, 'Number Widget');
  await configureWidget(page, firstColumn, 'mass');
  await page.locator('.template-studio-node-bar--row .template-studio-node-identity').first().click();
  await dock.getByRole('button', { name: 'Add column' }).click();
  const layoutDialog = page.getByRole('dialog', { name: 'Column layout' });
  await expect(layoutDialog.getByText('Grid usage:')).toContainText('12/12');
  await layoutDialog.getByRole('button', { name: 'Save layout', exact: true }).click();
  await expect(page.locator('.widget-col')).toHaveCount(2);
  const secondColumn = page.locator('.widget-col').nth(1);
  await chooseWidget(page, secondColumn, 'Formula Widget');
  await configureWidget(page, secondColumn, 'result', 'mass * 2');
  await expect(page.locator('#template-designer').getByText('mass*2', { exact: true })).toBeVisible();
  const ids = await page.locator('.widget-col').evaluateAll((elements) => elements.map((element) => element.dataset.colId));
  await secondColumn.locator('.template-studio-column-label button').click();
  await page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: 'Move left', exact: true }).click();
  await expect(page.locator('.widget-col').first()).toHaveAttribute('data-col-id', ids[1]);
  await page.screenshot({ path: testInfo.outputPath('designer-configured.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.template-studio-toolbar')).toBeVisible();
  await expect(page.getByRole('main', { name: 'Template canvas' })).toBeVisible();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('designer-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(page.locator('.widget-col').first()).toHaveAttribute('data-col-id', ids[1]);
  await expect(page.locator('#template-designer').getByText('mass*2', { exact: true })).toBeVisible();
  await page.locator('.template-row-action-row .template-studio-node-identity').first().click();
  await page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: 'Duplicate row', exact: true }).click();
  await expect(page.locator('.widget-row')).toHaveCount(2);
  const previewPromise = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Print Preview', exact: true }).click();
  const preview = await previewPromise;
  await expect(preview.getByRole('heading', { name: 'Browser analysis' })).toBeVisible();
  await expect(preview.locator('.template-preview-document .widget-row')).toHaveCount(2);
  await preview.getByRole('button', { name: 'Print Config', exact: true }).click();
  const printConfig = preview.locator('.template-print-config-panel');
  await printConfig.locator('select').first().selectOption('A5');
  await printConfig.locator('input[type="checkbox"]').nth(0).check();
  await printConfig.locator('input[type="checkbox"]').nth(3).check();
  await printConfig.getByRole('button', { name: 'Save Config', exact: true }).click();
  await expect(printConfig.getByText('Print config saved')).toBeVisible();
  await printConfig.getByRole('button', { name: 'Close', exact: true }).click();
  await preview.getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(preview.getByTitle('Template PDF preview')).toBeVisible({ timeout: 30_000 });
  await preview.getByLabel('View', { exact: true }).selectOption('nabl');
  await expect(preview.getByText('Refresh PDF to apply config changes')).toBeVisible();
  await preview.close();
  expect(errors).toEqual([]);
});
