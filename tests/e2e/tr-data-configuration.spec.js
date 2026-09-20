import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createReportTemplate } from '../helpers/reports.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

test('TR Data Title, Key, Required and Default Value retain source controls through errors and reload', async ({ page }, testInfo) => {
  const user = await createAccount(owner, { permissions: ['templates.manage', 'templates.read'] });
  const session = await signIn({ identifier: user.username, password: user.password });
  const template = await withSession(session.token, createReportTemplate, { csrfToken: session.csrfToken });
  const field = template.records.fields.find((field) => field.widget === 'tr_data_widget');
  const row = template.records.rows.find((row) => row.id === template.records.columns.find((column) => column.id === field.columnId).rowId);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(user.username); await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  await page.goto(`/master_template_management/${template.templateId}`);
  const column = page.locator(`[data-field-id="${field.id}"]`);
  const dialog = page.getByRole('dialog', { name: 'Configure field' });
  async function open() {
    await column.locator('.template-studio-field-action').click();
  }
  await open(); await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Key', { exact: true })).toHaveValue('param'); await expect(dialog.getByLabel('Default Value', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Required', { exact: true })).not.toBeChecked();
  await expect(dialog.getByLabel('Editable', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('Title', { exact: true }).fill('Request parameter title'); await dialog.getByLabel('Required', { exact: true }).check();
  await dialog.getByLabel('Default Value', { exact: true }).fill('0'); await dialog.getByLabel('Key', { exact: true }).fill('moa');
  await dialog.getByRole('button', { name: 'Save field', exact: true }).click(); await expect(page.locator('#sampleify-toast-shelf').getByText('Key already exist!', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Default Value', { exact: true })).toHaveValue('0'); await dialog.getByLabel('Key', { exact: true }).fill('param');
  const routePattern = `**/api/template-versions/${template.versionId}`;
  await page.route(routePattern, (route) => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic TR configuration save failure' } }) }) : route.continue());
  await dialog.getByRole('button', { name: 'Save field', exact: true }).click(); await expect(page.locator('#sampleify-toast-shelf').getByText('Synthetic TR configuration save failure', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Request parameter title'); await expect(dialog.getByLabel('Default Value', { exact: true })).toHaveValue('0');
  await page.unroute(routePattern);
  const saved = page.waitForResponse((response) => response.url().endsWith(`/api/template-versions/${template.versionId}`) && response.request().method() === 'PATCH');
  await dialog.getByRole('button', { name: 'Save field', exact: true }).click(); expect((await saved).status()).toBe(200);
  await expect(column.getByText('TR data widget preview', { exact: true })).toBeVisible();
  await page.reload(); await open(); await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Request parameter title');
  await expect(dialog.getByLabel('Default Value', { exact: true })).toHaveValue('0'); await expect(dialog.getByLabel('Required', { exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('tr-data-configuration-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); await dialog.getByLabel('Default Value', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('tr-data-configuration-mobile.png'), fullPage: true, animations: 'disabled' });
  await dialog.getByLabel('Default Value', { exact: true }).fill('-');
  const blanked = page.waitForResponse((response) => response.url().endsWith(`/api/template-versions/${template.versionId}`) && response.request().method() === 'PATCH');
  await dialog.getByRole('button', { name: 'Save field', exact: true }).click(); expect((await blanked).status()).toBe(200);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload(); await open(); await expect(dialog.getByLabel('Default Value', { exact: true })).toHaveValue('-');
  const stored = (await owner.query('SELECT label,alias,required,source_field,default_state,default_text FROM template_fields WHERE organization_id=$1 AND version_id=$2 AND id=$3',
    [user.organizationId, template.versionId, field.id])).rows[0];
  expect(stored).toEqual({ label: 'Request parameter title', alias: 'param', required: true, source_field: field.sourceField, default_state: 'present', default_text: '-' });
  expect(errors).toEqual([]);
});
