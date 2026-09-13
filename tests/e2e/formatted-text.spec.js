import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

test('formatted titles retain raw editing, scientific markup, safe fallback and frozen history in the designer and datasheet', async ({ page, context }, testInfo) => {
  const account = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const fixture = await createLaboratoryFixture(owner, account);
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (action) => withSession(session.token, action, { csrfToken: session.csrfToken });
  const title = '<strong>Water H<sub>2</sub>O</strong> &amp; x<sup>2</sup> = 0';
  const unbound = '<img src="https://example.invalid/unbound.png" alt="Unbound image">';
  let revision = 1; const fields = {};
  for (const [alias, label, editable] of [
    ['formatted_title', title, true],
    ['table_title', '<table><tbody><tr><td style="text-align:center;font-weight:bold">Table 0</td></tr></tbody></table>', false],
    ['unbound_title', unbound, false],
  ]) {
    const added = await work((client, identity) => editTemplate(client, identity, fixture.template.versionId, revision, { type: 'addColumn', rowId: fixture.template.records.rows[0].id }));
    const columnId = added.model.rowsById[fixture.template.records.rows[0].id].columnIds.at(-1);
    const configured = await work((client, identity) => editTemplate(client, identity, fixture.template.versionId, added.model.version.revision,
      { type: 'configureField', columnId, widget: 'text_widget', alias, label, editable }));
    revision = configured.model.version.revision; fields[alias] = configured.model.columnsById[columnId].fieldId;
  }
  const errors = []; const external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  context.on('request', (request) => { if (request.url().startsWith('https://example.invalid/')) external.push(request.url()); });
  await context.route('https://example.invalid/**', (route) => route.abort());
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  await page.goto(`/master_template_management/${fixture.template.templateId}`);
  const titleCells = page.locator(`[data-field-id="${fields.formatted_title}"]`);
  const tableCells = page.locator(`[data-field-id="${fields.table_title}"]`);
  await expect(titleCells.locator('strong')).toHaveText('Water H2O'); await expect(titleCells.locator('sub')).toHaveText('2'); await expect(titleCells.locator('sup')).toHaveText('2');
  await expect(tableCells.locator('td')).toHaveText('Table 0'); await expect(tableCells.locator('td')).toHaveCSS('text-align', 'center');
  await expect(page.locator(`[data-field-id="${fields.unbound_title}"]`)).toHaveText(unbound); await expect(page.locator(`[data-field-id="${fields.unbound_title}"] img`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit Mode Off' }).click();
  await titleCells.locator('.action-dropdown-toggle').click(); await page.getByRole('menuitem', { name: 'Widget', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Widget Configuration' });
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(title);
  await dialog.getByRole('button', { name: 'Update data' }).click(); await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Edit Mode On' }).click();
  const previewPromise = context.waitForEvent('page'); await page.getByRole('link', { name: 'Preview', exact: true }).click();
  const preview = await previewPromise; await preview.emulateMedia({ media: 'print' });
  await expect(preview.locator(`[data-field-id="${fields.formatted_title}"] sub`)).toHaveText('2');
  const size = await preview.locator(`[data-field-id="${fields.formatted_title}"] sub`).evaluate((element) => ({ sub: parseFloat(getComputedStyle(element).fontSize), parent: parseFloat(getComputedStyle(element.parentElement).fontSize) }));
  expect(size.sub).toBeLessThan(size.parent); await preview.close();
  const sample = await work((client, identity) => registerSample(client, identity, fixture.registration));
  const generated = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  const allocated = await work((client, identity) => allocateTestRequest(client, identity, generated.items[0].id, { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId }));
  const path = `/samples/${sample.id}/data_sheets/${allocated.datasheetId}`; const api = `/api/datasheets/${allocated.datasheetId}`;
  await page.goto(path); await expect(titleCells.locator('strong')).toHaveCount(2); await expect(tableCells.locator('td')).toHaveText(['Table 0', 'Table 0']);
  await titleCells.first().getByRole('button', { name: 'Edit formatted_title', exact: true }).click();
  const input = titleCells.first().getByRole('textbox', { name: 'Edit formatted_title', exact: true });
  await expect(input).toHaveValue(title);
  const edited = '<em>Edited H<sub>2</sub>O</em>';
  await input.fill(`  ${edited}  `);
  const save = page.waitForResponse((response) => response.url().endsWith(`${api}/values`) && response.request().method() === 'PATCH');
  await input.press('Enter'); expect((await save).status()).toBe(200);
  await expect(titleCells.first().locator('em')).toHaveText('Edited H2O'); await expect(titleCells.nth(1).locator('strong')).toHaveText('Water H2O');
  const stored = await page.request.get(api).then((response) => response.json());
  expect(stored.capture.values.find((value) => value.fieldId === fields.formatted_title && value.origin === 'entered').textValue).toBe(edited);
  await titleCells.first().getByRole('button', { name: 'Edit formatted_title', exact: true }).click();
  await input.fill('<script>globalThis.executed=true</script>'); await input.press('Escape');
  await expect(titleCells.first().locator('em')).toHaveText('Edited H2O');
  await page.screenshot({ path: testInfo.outputPath('formatted-text-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await page.screenshot({ path: testInfo.outputPath('formatted-text-mobile.png'), fullPage: true });
  await titleCells.first().getByRole('button', { name: 'Edit formatted_title', exact: true }).click(); await input.fill(unbound);
  const fallbackSave = page.waitForResponse((response) => response.url().endsWith(`${api}/values`) && response.request().method() === 'PATCH');
  await input.press('Enter'); expect((await fallbackSave).status()).toBe(200);
  await expect(titleCells.first()).toHaveText(unbound); await expect(titleCells.first().locator('img')).toHaveCount(0);
  await page.reload(); await expect(titleCells.first()).toHaveText(unbound);
  await page.goto(`${path}?revision=1`); await expect(titleCells.locator('strong')).toHaveCount(2); await expect(titleCells.locator('sub')).toHaveText(['2', '2']);
  expect(await page.evaluate(() => globalThis.executed ?? false)).toBe(false); expect(external).toEqual([]); expect(errors).toEqual([]);
});
