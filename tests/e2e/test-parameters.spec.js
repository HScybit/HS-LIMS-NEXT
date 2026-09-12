import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { emptyUncertaintyGrid } from '../../src/masters/parameter-grid.js';
import { saveTestParameter } from '../../src/masters/test-parameters.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
const cell = (page, row, column) => page.locator('.Spreadsheet__table tr:has(td)').nth(row).locator('td').nth(column);
async function fillCell(page, row, column, value) {
  const target = cell(page, row, column); await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox(); const active = page.locator('.Spreadsheet__active-cell');
  const activeBounds = await active.count() ? await active.boundingBox() : null;
  // Reopen the package's active overlay with its supported Enter shortcut.
  if (activeBounds && Math.abs(activeBounds.x - bounds.x) < 3 && Math.abs(activeBounds.y - bounds.y) < 3) {
    await active.focus(); await page.keyboard.press('Enter');
  } else await target.dblclick();
  const editor = page.locator('.Spreadsheet__data-editor input');
  await expect(editor).toBeVisible(); await editor.fill(value); await editor.press('Enter');
}
async function fixture() {
  const account = await createAccount(owner, { permissions: ['masters.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const grid = emptyUncertaintyGrid(); grid.rows[0].values[0] = 'Original uncertainty';
  const key = `PARA_${randomUUID().slice(0, 8)}`;
  const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Original parameter', description: '', key,
    schemeAbbreviation: key, order: 0, laboratoryId: null, measurementUncertainty: grid };
  const parameter = await withSession(session.token, (client, identity) => saveTestParameter(client, identity, command), { csrfToken: session.csrfToken });
  return { account, session, command, parameter };
}

test('source parameter spreadsheet retains headers, raw cells, formulas and serials through lost save and deletion responses', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const account = await createAccount(owner, { permissions: ['masters.manage'] });
  const lab = await createLaboratoryFixture(owner, account, { repeated: false });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, account); await page.getByRole('link', { name: 'Test Parameters', exact: true }).click();
  await page.getByRole('button', { name: 'New Test Parameter', exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Parameter Name is required.', { exact: true })).toBeVisible();
  await page.getByLabel('Order', { exact: true }).fill('0'); await page.getByLabel('Parameter Name', { exact: true }).fill('Synthetic browser parameter');
  await page.getByLabel('Description', { exact: true }).fill('Synthetic authored description');
  await page.getByLabel('Key', { exact: true }).fill('PARA_BROWSER'); await page.getByLabel('Scheme Abbreviation', { exact: true }).fill('Br');
  await page.getByLabel('Lab Name', { exact: true }).fill('analytical'); await page.getByRole('option', { name: lab.laboratory.name, exact: true }).click();
  await page.getByRole('button', { name: 'Add uncertainty column', exact: true }).click();
  await page.getByRole('button', { name: 'Edit uncertainty header 3', exact: true }).click();
  await page.locator('.spreadsheet-header-table input').fill('Notes'); await page.locator('.spreadsheet-header-table input').press('Enter');
  await expect(page).toHaveURL(/\/test_parameters\/new/);
  await fillCell(page, 0, 1, '000.00'); await fillCell(page, 0, 2, '=A1*2'); await expect(cell(page, 0, 2)).toHaveText('2');
  await cell(page, 0, 1).click(); await page.keyboard.press('Control+Shift+ArrowDown');
  await fillCell(page, 1, 1, '  exact text  '); await fillCell(page, 1, 2, 'NA');
  await expect(cell(page, 0, 0)).toHaveText('1'); await expect(cell(page, 1, 0)).toHaveText('2');
  await expect(cell(page, 0, 0)).toHaveClass(/readonly/);
  await page.getByRole('button', { name: 'Add uncertainty row', exact: true }).click();
  await page.getByRole('button', { name: 'Remove uncertainty row', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('parameter-source-form-desktop.png'), fullPage: true, animations: 'disabled' });
  let attempted;
  await page.route('**/api/masters/test-parameters', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempted = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost save response' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost save response');
  await expect(cell(page, 0, 1)).toHaveText('000.00'); await page.unroute('**/api/masters/test-parameters');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/masters/test-parameters') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const response = await saved;
  expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual(attempted);
  const parameter = await response.json();
  expect(parameter.measurementUncertainty.columns.map((column) => column.title)).toEqual(['Sr. no.', 'Text', 'Notes']);
  expect(parameter.measurementUncertainty.rows.map((row) => row.values)).toEqual([['000.00', '=A1*2'], ['  exact text  ', 'NA']]);
  await page.getByPlaceholder('Search...', { exact: true }).fill('Synthetic browser parameter'); await expect(page).toHaveURL(/search=Synthetic/);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: parameter.name, exact: true }) }); await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Order', { exact: true })).toHaveValue('0'); await expect(page.locator('.smplfy-rselect__single-value')).toContainText(lab.laboratory.name);
  await expect(page.getByRole('columnheader', { name: 'Notes', exact: false })).toBeVisible();
  await page.getByLabel('Description', { exact: true }).fill('Changed notes');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Update', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('parameter-source-form-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(row).toBeVisible(); await expect(page).toHaveURL(/search=Synthetic/);
  await row.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('cell', { name: '=A1*2', exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: '000.00', exact: true })).toBeVisible();
  const latest = await (await page.request.get(`/api/masters/test-parameters/${parameter.id}`)).json();
  expect(latest.measurementUncertainty).toEqual(parameter.measurementUncertainty); expect(latest.revision).toBe(2);
  await page.goBack(); await row.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Test Parameter', exact: true }); let deleteRequest;
  await page.route(`**/api/masters/test-parameters/${parameter.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deleteRequest = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost deletion response' } }) });
  });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Synthetic lost deletion response');
  await page.unroute(`**/api/masters/test-parameters/${parameter.id}`);
  const deletion = page.waitForResponse((response) => response.request().method() === 'DELETE'); await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await deletion).request().postDataJSON()).toEqual(deleteRequest); await expect(dialog).toHaveCount(0); await expect(row).toHaveCount(0);
  expect((await page.request.get(`/api/masters/test-parameters/${parameter.id}`)).status()).toBe(404);
  const retired = await (await page.request.get(`/api/masters/test-parameters/${parameter.id}?revision=3`)).json();
  expect(retired.active).toBe(false); expect(retired.measurementUncertainty).toEqual(parameter.measurementUncertainty); expect(errors).toEqual([]);
});

test('invalid spreadsheet drafts block stale valid values and concurrent saves preserve the local draft', async ({ page }) => {
  const { account, session, command, parameter } = await fixture(); await login(page, account); await page.goto(`/test_parameters/${parameter.id}/edit`);
  await fillCell(page, 0, 1, 'x'.repeat(2001)); await expect(page.getByText('Uncertainty cells must contain at most 2,000 text characters.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  expect((await (await page.request.get(`/api/masters/test-parameters/${parameter.id}`)).json()).revision).toBe(1);
  await fillCell(page, 0, 1, 'Corrected local uncertainty'); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
  await page.locator('.Spreadsheet__active-cell').focus(); await page.keyboard.press('Control+Shift+ArrowRight');
  await expect(page.locator('.spreadsheet-header-table th')).toHaveCount(3);
  await page.keyboard.press('Control+Shift+ArrowLeft'); await expect(page.locator('.spreadsheet-header-table th')).toHaveCount(2);
  await page.getByRole('button', { name: 'Edit uncertainty header 2', exact: true }).click();
  await page.locator('.spreadsheet-header-table input').fill('Discard this header'); await page.locator('.spreadsheet-header-table input').press('Escape');
  await expect(page.locator('.spreadsheet-header-table th').nth(1)).toContainText('Text');
  await page.getByLabel('Parameter Name', { exact: true }).fill('Preserved local draft');
  await withSession(session.token, (client, identity) => saveTestParameter(client, identity, { ...command, revision: 1, requestId: randomUUID(), name: 'Concurrent parameter edit' }), { csrfToken: session.csrfToken });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('The test parameter changed');
  await expect(page.getByLabel('Parameter Name', { exact: true })).toHaveValue('Preserved local draft'); await expect(cell(page, 0, 1)).toHaveText('Corrected local uncertainty');
  await page.reload(); await expect(page.getByLabel('Parameter Name', { exact: true })).toHaveValue('Concurrent parameter edit'); await expect(cell(page, 0, 1)).toHaveText('Original uncertainty');
});

test('read-only master users can view uncertainty while foreign records, mutations, missing CSRF and malformed queries fail', async ({ page }) => {
  const { account, parameter } = await fixture();
  const foreign = await fixture(); const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['masters.read'] });
  await login(page, reader); await page.getByRole('link', { name: 'Test Parameters', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Original parameter', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Test Parameter', exact: true })).toHaveCount(0); await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0); await page.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Original uncertainty', exact: true })).toBeVisible();
  await page.goto(`/test_parameters/${parameter.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('permission');
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value;
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
  expect((await page.request.post('/api/masters/test-parameters', { headers, data: {} })).status()).toBe(403);
  expect((await page.request.delete(`/api/masters/test-parameters/${parameter.id}`, { headers, data: { requestId: randomUUID(), revision: 1 } })).status()).toBe(403);
  expect((await page.request.post('/api/masters/test-parameters', { data: {} })).status()).toBe(403);
  expect((await page.request.get(`/api/masters/test-parameters/${foreign.parameter.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/masters/test-parameters/${foreign.parameter.id}?revision=1`)).status()).toBe(404);
  for (const query of ['%7B', 'null', encodeURIComponent(JSON.stringify({ sort: { key: 'password_hash', dir: 'asc' } }))]) expect((await page.request.get(`/api/masters/test-parameters?query=${query}`)).status()).toBe(400);
});

test('pasted uncertainty expands matching headers and rejects an oversized matrix without partially applying it', async ({ page }) => {
  const { account, parameter } = await fixture(); await login(page, account); await page.goto(`/test_parameters/${parameter.id}/edit`);
  await cell(page, 0, 1).click();
  const paste = async (text) => page.evaluate((value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
  await paste('First\t=A1*2\nSecond\tNA');
  await expect(page.locator('.spreadsheet-header-table th')).toHaveCount(3);
  await expect(cell(page, 1, 1)).toHaveText('Second'); await expect(cell(page, 0, 2)).toHaveText('2');
  await paste(Array(33).fill('oversized').join('\t'));
  await expect(page.getByText('The paste would exceed 500 uncertainty rows or 32 columns.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  await expect(page.locator('.spreadsheet-header-table th')).toHaveCount(3); await expect(cell(page, 0, 1)).toHaveText('First');
  // A multi-cell paste selects its whole range; collapse that selection before editing one cell.
  await page.locator('.Spreadsheet__active-cell').focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
  await paste('0'); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/test_parameters$/);
  const saved = await (await page.request.get(`/api/masters/test-parameters/${parameter.id}`)).json();
  expect(saved.measurementUncertainty.columns.map((column) => column.title)).toEqual(['Sr. no.', 'Text', 'Column 3']);
  expect(saved.measurementUncertainty.rows.map((row) => row.values)).toEqual([['0', '=A1*2'], ['Second', 'NA']]);
});
