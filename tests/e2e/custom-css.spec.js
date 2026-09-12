import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomCss } from '../../src/report-assets/custom-css.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { createReportAssets } from '../helpers/report-assets.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { generateReports } from '../../src/reports/service.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}

test('source CSS editor retains metrics, reset, raw-tag prevention, lost-response retries and saved clearing history', async ({ page }, testInfo) => {
  const account = await createAccount(owner, { permissions: ['report_settings.manage'] });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, account); await page.goto('/custom_css');
  const editor = page.getByRole('textbox', { name: 'Custom CSS editor', exact: true });
  const save = page.getByRole('button', { name: 'Save', exact: true }); const reset = page.getByRole('button', { name: 'Reset', exact: true });
  await expect(editor).toHaveValue(''); await expect(save).toBeDisabled(); await expect(reset).toBeDisabled();
  await expect(page.getByLabel('Custom CSS status', { exact: true })).toContainText('Blank');
  await editor.fill('<style>.test { color: red }</style>'); await expect(save).toBeDisabled();
  await expect(page.getByText('Blocked tag', { exact: true })).toBeVisible();
  await reset.click(); await expect(editor).toHaveValue('');
  await editor.fill('.sample {'); await expect(page.getByText('Check braces', { exact: true })).toBeVisible(); await expect(save).toBeEnabled();
  const css = '.synthetic-report {\n  color: #005577;\n}\n'; await editor.fill(css);
  await expect(page.getByLabel('Custom CSS status', { exact: true })).toContainText('4 lines');
  await expect(page.getByLabel('Custom CSS status', { exact: true })).toContainText('1 rules');
  let requestId;
  await page.route('**/api/report-assets/custom-css', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    requestId = route.request().postDataJSON().requestId; expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost CSS response' } }) });
  });
  await save.click(); await expect(page.getByRole('status').filter({ hasText: 'Synthetic lost CSS response' })).toBeVisible(); await expect(editor).toHaveValue(css);
  await page.unroute('**/api/report-assets/custom-css');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/report-assets/custom-css') && response.request().method() === 'PUT');
  await save.click(); const response = await saved; expect(response.request().postDataJSON().requestId).toBe(requestId); expect((await response.json()).replayed).toBe(true);
  await expect(save).toBeDisabled(); await expect(page.getByRole('status').filter({ hasText: 'Custom CSS saved.' })).toBeVisible();
  await page.reload(); await expect(editor).toHaveValue(css); await editor.fill('.discarded{}'); await reset.click(); await expect(editor).toHaveValue(css);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('custom-css-source-editor-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.lims-main').evaluate((element) => Math.round(element.getBoundingClientRect().left))).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('custom-css-source-editor-mobile.png'), fullPage: true, animations: 'disabled' });
  await editor.fill(''); await save.click(); await expect(save).toBeDisabled();
  expect((await owner.query('SELECT revision,css_content FROM organization_custom_css_versions WHERE organization_id=$1 ORDER BY revision', [account.organizationId])).rows)
    .toEqual([{ revision: 1, css_content: css }, { revision: 2, css_content: '' }]);
  expect(errors).toEqual([]);
});

test('concurrent CSS changes preserve an unsaved draft and read-only settings reject direct mutations', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['report_settings.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  await login(page, account); await page.goto('/custom_css');
  const editor = page.getByRole('textbox', { name: 'Custom CSS editor', exact: true }); await expect(editor).toHaveValue('');
  await editor.fill('.retained-draft{}');
  await withSession(session.token, (client, identity) => saveCustomCss(client, identity, { requestId: randomUUID(), revision: 0, cssContent: '.concurrent{}' }), { csrfToken: session.csrfToken });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Custom CSS changed.' })).toBeVisible(); await expect(editor).toHaveValue('.retained-draft{}');
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['report_settings.read'] });
  await page.getByRole('button', { name: 'Log out', exact: true }).click(); await expect(page).toHaveURL(/\/login$/);
  await login(page, reader); await page.goto('/custom_css'); await expect(editor).toHaveValue('.concurrent{}'); await expect(editor).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Reset', exact: true })).toHaveCount(0);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value;
  expect((await page.request.put('/api/report-assets/custom-css', { headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf }, data: { requestId: randomUUID(), revision: 1, cssContent: '' } })).status()).toBe(403);
  expect((await page.request.put('/api/report-assets/custom-css', { data: {} })).status()).toBe(403);
});

test('current styles update across tabs while captured report styles and inherited values stay isolated', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage', 'templates.read', 'templates.manage', 'test_requests.allocate', 'datasheets.execute', 'report_settings.manage'] });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const work = (callback) => withSession(account.token, callback, { csrfToken: account.csrfToken });
  const flow = await prepareReportFlow(owner, account, { finalSection: true }); const assets = await work(createReportAssets);
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command));
  await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const capturedCss = `:root{--report-color:#005577}.coa-report-header p{color:var(--report-color);font-size:19px;background-image:url('${assets.image.url}');background-size:8px 8px;background-repeat:no-repeat;background-position:right}.synthetic-current-style{color:#005577}`;
  const saved = await work((client, identity) => saveCustomCss(client, identity, { requestId: randomUUID(), revision: 0, cssContent: capturedCss }));
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID() }));
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, account);
  let reportReads = 0; let stylesheetReads = 0;
  page.on('request', (request) => {
    if (/\/api\/reports\/[a-f\d-]+$/.test(request.url())) reportReads += 1;
    if (/\/api\/report-renderers\/[a-f\d]+\/stylesheet$/.test(request.url())) stylesheetReads += 1;
  });
  const response = page.waitForResponse((item) => item.url().endsWith(`/api/reports/${generated.items[0].id}`));
  await page.goto(`/samples/${flow.sample.id}/coa`);
  const report = page.frameLocator('.finalised-report-preview__frame'); const header = report.locator('.coa-report-header p');
  await expect(header).toHaveCSS('color', 'rgb(0, 85, 119)'); await expect(header).toHaveCSS('font-size', '19px');
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeEnabled();
  expect(reportReads).toBe(1); expect(stylesheetReads).toBe(1);
  const loaded = await (await response).json();
  expect(loaded.metrics.definition.queryCount).toBe(8); expect(loaded.metrics.capture.queryCount).toBe(3); expect(loaded.metrics.assets.queryCount).toBe(1);
  expect(loaded.assets.customCss.versionId).toBe(saved.versionId);
  await expect(page.locator('iframe.finalised-report-preview__frame')).toHaveAttribute('sandbox', 'allow-same-origin');
  expect(await header.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain('data:image/png;base64,');
  await page.evaluate(() => { const probe = document.createElement('span'); probe.className = 'synthetic-current-style'; probe.id = 'current-css-probe'; probe.textContent = 'Synthetic current style probe'; document.body.appendChild(probe); });
  await expect(page.locator('#current-css-probe')).toHaveCSS('color', 'rgb(0, 85, 119)');
  const editorPage = await page.context().newPage();
  try {
    await editorPage.goto('/custom_css'); const editor = editorPage.getByRole('textbox', { name: 'Custom CSS editor', exact: true }); await expect(editor).toHaveValue(capturedCss);
    await editor.fill(':root{--report-color:#aa1122;color:#aa1122;font-size:22px}.coa-report-header p{color:#aa1122!important;font-size:40px!important}.synthetic-current-style{color:#aa1122}');
    await editorPage.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editorPage.getByRole('status').filter({ hasText: 'Custom CSS saved.' })).toBeVisible();
    await page.bringToFront(); await expect(page.locator('#current-css-probe')).toHaveCSS('color', 'rgb(170, 17, 34)');
    await expect(header).toHaveCSS('color', 'rgb(0, 85, 119)'); await expect(header).toHaveCSS('font-size', '19px'); expect(reportReads).toBe(1);
    await page.locator('#current-css-probe').evaluate((element) => element.remove());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: testInfo.outputPath('custom-css-frozen-preview-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Version 2', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Version 1', exact: true }).click();
    await expect(header).not.toHaveCSS('color', 'rgb(170, 17, 34)'); await expect(header).not.toHaveCSS('font-size', '40px');
    expect(await report.locator(':root').evaluate((element) => getComputedStyle(element).getPropertyValue('--report-color'))).toBe('');
    await page.getByRole('button', { name: 'Version 1', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Version 2', exact: true }).click();
    await expect(header).toHaveCSS('color', 'rgb(0, 85, 119)');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.locator('.lims-main').evaluate((element) => Math.round(element.getBoundingClientRect().left))).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('custom-css-frozen-preview-mobile.png'), fullPage: true, animations: 'disabled' });
    await editorPage.getByRole('textbox', { name: 'Custom CSS editor', exact: true }).fill(''); await editorPage.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editorPage.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.bringToFront(); await expect(page.locator('#sampleify-organization-custom-css')).toHaveText('');
    await expect(header).toHaveCSS('color', 'rgb(0, 85, 119)');
    await editorPage.getByRole('textbox', { name: 'Custom CSS editor', exact: true }).fill('.template-preview-document{outline-color:#005577}');
    await editorPage.getByRole('button', { name: 'Save', exact: true }).click(); await expect(editorPage.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.goto(`/master_template_management/${flow.template.templateId}/preview`);
    await expect(page.locator('.template-preview-document')).toHaveCSS('outline-color', 'rgb(0, 85, 119)');
    await page.goto(`/master_template_management/${flow.template.templateId}`);
    await expect(page.getByLabel('Template structure summary')).toBeVisible();
    await expect(page.locator('#sampleify-organization-custom-css')).toHaveCount(0);
    await page.goto('/me'); await expect(page.locator('#sampleify-organization-custom-css')).toHaveAttribute('data-version-id', /[a-f\d-]{36}/);
    expect(errors).toEqual([]);
  } finally { await editorPage.close(); }
});

test('report stylesheet failure keeps Print disabled and Retry restores the captured preview', async ({ page }) => {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const flow = await prepareReportFlow(owner, account);
  await withSession(account.token, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input), { csrfToken: account.csrfToken });
  await login(page, account);
  await page.route('**/api/report-renderers/*/stylesheet', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto(`/samples/${flow.sample.id}/coa`);
  await expect(page.locator('.alert[role="alert"]').filter({ hasText: 'The report stylesheet could not be loaded.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeDisabled();
  await page.unroute('**/api/report-renderers/*/stylesheet'); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.frameLocator('.finalised-report-preview__frame').getByText('CERTIFICATE OF ANALYSIS', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeEnabled();
  expect((await page.request.get('/api/report-assets/custom-css/current')).status()).toBe(200);
  expect((await page.request.get('/api/report-assets/custom-css')).status()).toBe(403);
});
