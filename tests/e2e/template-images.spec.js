import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createImageTemplate } from '../helpers/template-image-fixture.js';
import { animatedPng } from '../helpers/template-images.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { uploadTemplateImage } from '../../src/template-assets/service.js';
import { freezeTemplate } from '../../src/templates/authoring.js';
import { createCapture } from '../../src/templates/capture.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function fixture() {
  const user = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute'] });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const work = (action) => withSession(account.token, action, { csrfToken: account.csrfToken });
  const template = await work(createImageTemplate);
  return { account, template, work };
}
async function login(page, account) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function centerPixel(image) {
  const content = await image.screenshot(); const metadata = await sharp(content).metadata();
  return [...await sharp(content).extract({ left: Math.floor(metadata.width / 2), top: Math.floor(metadata.height / 2), width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
}

test('source image chooser, layout controls, animation and fixed print frame survive a lost response and reload', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const { account, template } = await fixture();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, account); await page.goto(`/master_template_management/${template.templateId}`);
  await expect(page.getByText('No template image selected', { exact: true })).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit Mode Off' }).click();
  const input = page.getByLabel('Template image image', { exact: true });
  const requests = []; let lost = false;
  await page.route('**/api/template-versions/*/images/*', async (route) => {
    requests.push(route.request().headers()['x-upload-request-id']);
    const response = await route.fetch();
    if (!lost) { expect(response.status()).toBe(201); lost = true; return route.abort('failed'); }
    expect(response.status()).toBe(200); return route.fulfill({ response });
  });
  const content = await animatedPng({ separateDefault: true, width: 24, height: 12, orientation: 6 });
  await input.setInputFiles({ name: 'Synthetic animated image.png', mimeType: 'image/png', buffer: content });
  const image = page.locator('img.tiw_image'); await expect(image).toBeVisible(); await expect(input).toBeEnabled();
  await expect(image).toHaveJSProperty('naturalWidth', 12); await expect(image).toHaveJSProperty('naturalHeight', 24);
  expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0]);
  expect((await owner.query('SELECT revision FROM template_versions WHERE organization_id=$1 AND id=$2', [account.organizationId, template.versionId])).rows[0].revision).toBe(2);
  const src = await image.getAttribute('src');
  await input.setInputFiles({ name: 'Unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await expect(page.getByText('Only image files are allowed.', { exact: true })).toBeVisible(); await expect(image).toHaveAttribute('src', src);
  await page.unroute('**/api/template-versions/*/images/*');
  await page.locator('.widget-col .action-dropdown-toggle').click();
  await page.getByRole('menuitem', { name: 'Widget', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Widget Configuration' });
  await dialog.getByLabel('Width(%)', { exact: true }).fill('75');
  await dialog.getByLabel('Margin Top(px)', { exact: true }).fill('0');
  await dialog.getByLabel('Margin Right(px)', { exact: true }).fill('-2.5');
  await dialog.getByLabel('Align (start, center, end)', { exact: true }).fill('right');
  await dialog.getByRole('button', { name: 'Update data' }).click(); await expect(dialog).toBeHidden();
  await expect(image.locator('..').locator('..')).toHaveCSS('margin-right', '-2.5px');
  await page.getByRole('button', { name: 'Edit Mode On' }).click(); await expect(page.locator('input[type=file]')).toHaveCount(0);
  await page.reload(); await expect(image).toBeVisible(); await expect(image).toHaveAttribute('src', src);
  await page.waitForTimeout(350);
  expect(await centerPixel(image)).toEqual([0, 0, 255]);
  await page.emulateMedia({ media: 'print' });
  await expect.poll(() => image.evaluate((element) => element.currentSrc === element.previousElementSibling.srcset)).toBe(true);
  await expect(image).toHaveJSProperty('naturalWidth', 12); await expect(image).toHaveJSProperty('naturalHeight', 24);
  expect(await centerPixel(image)).toEqual([255, 0, 0]);
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 1280, height: 960 }); await page.screenshot({ path: testInfo.outputPath('template-image-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('template-image-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('uploading in a frozen designer creates a draft and keeps existing capture images unchanged', async ({ page, context }) => {
  const { account, template, work } = await fixture();
  const original = { requestId: randomUUID(), originalName: 'Original.png', mediaType: 'image/png', content: await animatedPng() };
  await work((client, identity) => uploadTemplateImage(client, identity, template.versionId, template.fieldId, 1, original));
  await work((client, identity) => freezeTemplate(client, identity, template.versionId, 2));
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  await login(page, account); await page.goto(`/master_template_management/${template.templateId}`);
  const other = await context.newPage(); await other.goto(`/master_template_management/${template.templateId}`);
  for (const tab of [page, other]) { await expect(tab.locator('img.tiw_image')).toBeVisible(); await tab.getByRole('button', { name: 'Edit Mode Off' }).click(); }
  const replacement = await sharp({ create: { width: 20, height: 16, channels: 3, background: 'blue' } }).png().toBuffer();
  const responsePromise = page.waitForResponse((response) => response.url().includes('/images/') && response.request().method() === 'POST');
  await page.getByLabel('Template image image', { exact: true }).setInputFiles({ name: 'Replacement.png', mimeType: 'image/png', buffer: replacement });
  const response = await responsePromise; expect(response.status()).toBe(201); const replaced = await response.json();
  expect(replaced.model.version.id).not.toBe(template.versionId); expect(replaced.model.version.status).toBe('draft');
  await expect(page.getByLabel('Template image image', { exact: true })).toBeEnabled();
  await other.getByLabel('Template image image', { exact: true }).setInputFiles({ name: 'Stale tab.png', mimeType: 'image/png', buffer: replacement });
  await expect(other.getByText('An editable draft already exists. Review it before uploading this image.', { exact: true })).toBeVisible();
  const stored = (await owner.query('SELECT image_id FROM template_values WHERE organization_id=$1 AND instance_id=$2', [account.organizationId, capture.instanceId])).rows;
  expect(stored.map((value) => value.image_id)).toEqual([original.requestId]);
  expect((await owner.query('SELECT default_image_id FROM template_fields WHERE organization_id=$1 AND version_id=$2 AND id=$3', [account.organizationId, template.versionId, template.fieldId])).rows[0].default_image_id).toBe(original.requestId);
  await other.close();
});

test('template image HTTP routes enforce CSRF, origin, identity and byte limits', async ({ page }) => {
  const { account, template } = await fixture(); await login(page, account);
  const path = `/api/template-versions/${template.versionId}/images/${template.fieldId}`;
  const content = await animatedPng();
  const headers = { 'Content-Type': 'image/png', 'X-File-Name': 'Synthetic.png', 'X-Upload-Request-Id': randomUUID(), 'X-Template-Revision': '1', Origin: 'http://127.0.0.1:3100' };
  expect((await page.request.post(path, { headers, data: content })).status()).toBe(403);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value;
  expect((await page.request.post(path, { headers: { ...headers, 'X-CSRF-Token': csrf, Origin: 'https://example.invalid' }, data: content })).status()).toBe(403);
  const tooLarge = await page.request.post(path, { headers: { ...headers, 'X-CSRF-Token': csrf }, data: Buffer.alloc(10 * 1024 * 1024 + 1) });
  expect(tooLarge.status()).toBe(413);
  const valid = await page.request.post(path, { headers: { ...headers, 'X-CSRF-Token': csrf }, data: content }); expect(valid.status()).toBe(201);
  expect(valid.headers()['cache-control']).toContain('no-store');
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['templates.read'] });
  const isolated = await page.context().browser().newContext({ baseURL: 'http://127.0.0.1:3100' }); const readerPage = await isolated.newPage();
  try {
    await login(readerPage, reader); await readerPage.goto(`/master_template_management/${template.templateId}`);
    await expect(readerPage.locator('img.tiw_image')).toBeVisible(); await expect(readerPage.locator('input[type=file]')).toHaveCount(0);
    const token = (await isolated.cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value;
    expect((await readerPage.request.post(path, { headers: { ...headers, 'X-CSRF-Token': token }, data: content })).status()).toBe(403);
  } finally { await isolated.close(); }
});
