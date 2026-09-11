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
  await column.locator('.action-dropdown-toggle').click();
  await page.getByRole('menuitem', { name: 'Column', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Column Settings' });
  await dialog.getByRole('combobox', { name: 'Widget' }).fill(widget);
  await expect(dialog.getByRole('combobox', { name: 'Widget' })).toBeFocused();
  await expect(dialog.getByRole('combobox', { name: 'Widget' })).toHaveValue(widget);
  await page.getByRole('option', { name: widget, exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function configureWidget(page, column, alias, formula) {
  await column.locator('.action-dropdown-toggle').click();
  await page.getByRole('menuitem', { name: 'Widget', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Widget Configuration' });
  await dialog.getByLabel('Key', { exact: true }).fill(alias);
  if (formula) {
    await dialog.getByLabel('Formula', { exact: true }).fill(formula);
    await dialog.getByLabel('Decimal Points', { exact: true }).fill('2');
    await dialog.getByRole('checkbox', { name: 'Show Decimal Points' }).check();
  }
  await dialog.getByRole('button', { name: 'Update data' }).click();
  await expect(dialog).toBeHidden();
}

test('source designer creates widgets, edits formulas, reloads, clones, reorders and opens HTML preview', async ({ page, context }, testInfo) => {
  const account = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute'] });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, account);
  await page.getByRole('link', { name: 'Master Templates', exact: true }).click();
  await expect(page.getByText('No data found')).toBeVisible();
  await page.getByRole('button', { name: 'New Master Template' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Browser analysis');
  await page.getByLabel('Template Type').selectOption('job_template');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('link', { name: 'Edit Template', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No containers yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Container', exact: true }).first().click();
  await page.getByRole('button', { name: 'Edit Mode Off' }).click();
  await page.getByRole('button', { name: 'Container', exact: true }).click();
  const containerPanel = page.getByRole('dialog', { name: 'Configuration' });
  await containerPanel.getByRole('button', { name: 'Add Row', exact: true }).click();
  await expect(page.locator('.widget-row')).toHaveCount(1);
  await containerPanel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(containerPanel).toBeHidden();
  await page.getByRole('button', { name: 'Container', exact: true }).click();
  await containerPanel.getByRole('button', { name: 'Configure', exact: true }).click();
  const containerSettings = page.getByRole('dialog', { name: 'Container Settings' });
  await expect(containerSettings).toBeVisible();
  await containerSettings.getByLabel('Unique Name').fill('analysis');
  await expect.poll(() => page.locator('body').evaluate((body) => body.style.overflow)).toBe('hidden');
  await containerSettings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(containerSettings).toBeHidden();
  await expect.poll(() => page.locator('body').evaluate((body) => body.style.overflow)).toBe('');
  const firstColumn = page.locator('.widget-col').nth(0);
  await chooseWidget(page, firstColumn, 'Number Widget');
  await configureWidget(page, firstColumn, 'mass');
  await page.getByRole('button', { name: 'Row', exact: true }).click();
  const rowPanel = page.getByRole('dialog', { name: 'Configuration' });
  await rowPanel.getByRole('button', { name: 'Add New Column' }).click();
  await expect(page.locator('.widget-col')).toHaveCount(2);
  await rowPanel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(rowPanel).toBeHidden();
  const secondColumn = page.locator('.widget-col').nth(1);
  await chooseWidget(page, secondColumn, 'Formula Widget');
  await configureWidget(page, secondColumn, 'result', 'mass * 2');
  await expect(page.getByText('(mass * 2)', { exact: true })).toBeVisible();
  const ids = await page.locator('.widget-col').evaluateAll((elements) => elements.map((element) => element.dataset.colId));
  await secondColumn.getByRole('button', { name: 'Move column left' }).click();
  await expect(page.locator('.widget-col').first()).toHaveAttribute('data-col-id', ids[1]);
  await page.screenshot({ path: testInfo.outputPath('designer-configured.png') });
  await page.reload();
  await expect(page.locator('.widget-col').first()).toHaveAttribute('data-col-id', ids[1]);
  await page.getByRole('button', { name: 'Edit Mode Off' }).click();
  await expect(page.getByText('(mass * 2)', { exact: true })).toBeVisible();
  await page.locator('.template-row-action-row').getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(page.locator('.widget-row')).toHaveCount(2);
  const previewPromise = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Preview', exact: true }).click();
  const preview = await previewPromise;
  await expect(preview.getByRole('heading', { name: 'Browser analysis' })).toBeVisible();
  await expect(preview.locator('.template-preview-document .widget-row')).toHaveCount(2);
  await preview.close();
  expect(errors).toEqual([]);
});
