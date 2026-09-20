import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { uploadReportImage } from '../../src/report-assets/images.js';
import { saveWatermark } from '../../src/report-assets/watermarks.js';
import { reportSvg } from '../helpers/report-svg.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function fixture() {
  const account = await createAccount(owner, { permissions: ['report_settings.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const saved = await withSession(session.token, async (client, identity) => {
    const image = await uploadReportImage(client, identity, { requestId: randomUUID(), originalName: 'Original.svg', mediaType: 'image/svg+xml', content: reportSvg });
    return saveWatermark(client, identity, { watermarkId: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Original watermark', imageId: image.id, opacity: 0.5, width: 240, height: 320, rotation: 360 });
  }, { csrfToken: session.csrfToken });
  return { account, session, watermark: saved.watermark };
}

test('source watermark form previews SVG, cycles rotation, retains zero opacity and recovers lost upload, save and delete responses', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const account = await createAccount(owner, { permissions: ['report_settings.manage'] });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, account); await page.goto('/watermark_report');
  await expect(page.getByText('No data found', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New Watermark Report', exact: true }).click();
  await expect(page.getByLabel('Height (px)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Width (px)', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Upload Image is required.', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic watermark');
  let imageRequest;
  await page.route('**/api/report-assets/images', async (route) => {
    imageRequest = route.request().headers()['x-upload-request-id'];
    const response = await route.fetch(); expect(response.status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost image response' } }) });
  });
  await page.getByLabel('Upload Image', { exact: true }).setInputFiles({ name: 'Watermark.svg', mimeType: 'image/svg+xml', buffer: reportSvg });
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost image response');
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  await page.unroute('**/api/report-assets/images');
  const uploaded = page.waitForResponse((response) => response.url().endsWith('/api/report-assets/images') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click();
  const upload = await uploaded; expect(upload.status()).toBe(200); expect(upload.request().headers()['x-upload-request-id']).toBe(imageRequest);
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
  await page.getByLabel('Height (px)', { exact: true }).fill('320'); await page.getByLabel('Width (px)', { exact: true }).fill('240');
  await expect(page.getByText('Upload Image is required.', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Height (px)', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Width (px)', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  const preview = page.getByAltText('preview', { exact: true }); await preview.evaluate((element) => element.decode());
  for (const angle of [90, 180, 270, 0]) {
    await page.getByRole('button', { name: 'Rotate 90°', exact: true }).click();
    await expect(page.locator('.smplfy-step-increment-display')).toHaveText(`${angle}°`);
    expect(await preview.evaluate((element) => element.style.transform)).toBe(`rotate(${angle}deg)`);
  }
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('watermark-source-form-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByLabel('Opacity (0 to 1)', { exact: true }).fill('0'); await expect(preview).toHaveCSS('opacity', '0');
  let saveRequest;
  await page.route('**/api/report-assets/watermarks', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    saveRequest = route.request().postDataJSON().requestId;
    const response = await route.fetch(); expect(response.status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost watermark response' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost watermark response');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Synthetic watermark');
  await page.unroute('**/api/report-assets/watermarks');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/report-assets/watermarks') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const response = await saved; expect(response.status()).toBe(200); expect(response.request().postDataJSON().requestId).toBe(saveRequest);
  const { watermark } = await response.json(); expect(watermark.opacity).toBe(0); expect(watermark.rotation).toBe(0);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Synthetic watermark', exact: true }) });
  await expect(row).toBeVisible();
  await page.getByPlaceholder('Search...', { exact: true }).fill('Synthetic watermark');
  await expect(page).toHaveURL(/search=Synthetic/);
  await row.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Opacity (0 to 1)', { exact: true })).toHaveValue('0');
  await page.getByLabel('Opacity (0 to 1)', { exact: true }).fill('0.4');
  await page.getByRole('button', { name: 'Rotate 90°', exact: true }).click();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(row).toBeVisible(); await expect(page).toHaveURL(/search=Synthetic/);
  await row.getByRole('link', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Enlarge watermark image', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Watermark image', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack(); await expect(row).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.lims-main').evaluate((element) => Math.round(element.getBoundingClientRect().left))).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  for (const label of ['View', 'Edit']) {
    expect(await row.getByRole('link', { name: label, exact: true }).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath('watermark-source-list-mobile.png'), fullPage: true, animations: 'disabled' });
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Watermark Report' });
  let deleteRequest;
  await page.route(`**/api/report-assets/watermarks/${watermark.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deleteRequest = route.request().postDataJSON().requestId; expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost deletion response' } }) });
  });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Synthetic lost deletion response');
  await page.unroute(`**/api/report-assets/watermarks/${watermark.id}`);
  const deletion = page.waitForResponse((response) => response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  const deleted = await deletion; expect(deleted.request().postDataJSON().requestId).toBe(deleteRequest); expect((await deleted.json()).replayed).toBe(true);
  await expect(dialog).not.toBeVisible(); await expect(page.getByText('No data found', { exact: true })).toBeVisible();
  expect((await owner.query('SELECT revision,is_retired,opacity,rotation FROM report_watermark_versions WHERE organization_id=$1 AND watermark_id=$2 ORDER BY revision', [account.organizationId, watermark.id])).rows)
    .toEqual([{ revision: 1, is_retired: false, opacity: '0', rotation: 0 }, { revision: 2, is_retired: false, opacity: '0.4', rotation: 90 }, { revision: 3, is_retired: true, opacity: '0.4', rotation: 90 }]);
  expect(await (await page.request.get(watermark.imageUrl)).body()).toEqual(reportSvg); expect(errors).toEqual([]);
});

test('stale watermark edits retain the draft and a failed replacement cannot save the prior image', async ({ page }, testInfo) => {
  const { account, session, watermark } = await fixture();
  await login(page, account); await page.goto(`/watermark_report/${watermark.id}/edit`);
  await expect(page.locator('.smplfy-step-increment-display')).toHaveText('360°');
  await page.getByRole('button', { name: 'Rotate 90°', exact: true }).click(); await expect(page.locator('.smplfy-step-increment-display')).toHaveText('90°');
  await page.getByLabel('Name', { exact: true }).fill('Preserved local draft');
  await withSession(session.token, (client, identity) => saveWatermark(client, identity, { watermarkId: watermark.id, requestId: randomUUID(), revision: 1,
    name: 'Concurrent edit', imageId: watermark.imageId, opacity: 0.6, width: 240, height: 320, rotation: 180 }), { csrfToken: session.csrfToken });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('This watermark changed');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Preserved local draft');
  await page.reload(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Concurrent edit');
  await page.getByRole('button', { name: 'Remove file', exact: true }).first().click();
  await page.getByLabel('Upload Image', { exact: true }).setInputFiles({ name: 'Unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') });
  await expect(page.locator('.alert[role="alert"]')).toContainText('SVG'); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  await expect(page.getByAltText('preview', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove file', exact: true }).click();
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.getByText('Upload Image is required.', { exact: true })).toBeVisible();
  await page.getByLabel('Upload Image', { exact: true }).setInputFiles({ name: 'Replacement.svg', mimeType: 'image/svg+xml', buffer: reportSvg });
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('watermark-source-form-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.locator('.smplfy-step-increment-field').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('watermark-source-form-mobile-controls.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Concurrent edit', exact: true })).toBeVisible();
  const versions = (await owner.query('SELECT revision,image_id FROM report_watermark_versions WHERE organization_id=$1 AND watermark_id=$2 ORDER BY revision', [account.organizationId, watermark.id])).rows;
  expect(versions).toHaveLength(3); expect(versions[0].image_id).toBe(watermark.imageId); expect(versions[2].image_id).not.toBe(watermark.imageId);
});

test('read-only watermark users can inspect images while mutations, missing CSRF and malformed list queries are rejected', async ({ page }) => {
  const { account, watermark } = await fixture();
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['report_settings.read'] });
  await login(page, reader); await page.goto('/watermark_report');
  await expect(page.getByRole('cell', { name: 'Original watermark', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Watermark Report', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'View', exact: true }).click(); await expect(page.getByRole('button', { name: 'Enlarge watermark image', exact: true })).toBeVisible();
  expect((await page.request.get(watermark.imageUrl)).status()).toBe(200);
  await page.goto(`/watermark_report/${watermark.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('permission'); await expect(page.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value;
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
  expect((await page.request.post('/api/report-assets/watermarks', { headers, data: {} })).status()).toBe(403);
  expect((await page.request.delete(`/api/report-assets/watermarks/${watermark.id}`, { headers, data: { requestId: randomUUID(), revision: 1 } })).status()).toBe(403);
  expect((await page.request.post('/api/report-assets/watermarks', { data: {} })).status()).toBe(403);
  expect((await page.request.get('/api/report-assets/watermarks?query=%7B')).status()).toBe(400);
  expect((await page.request.get('/api/report-assets/watermarks?query=null')).status()).toBe(400);
});
