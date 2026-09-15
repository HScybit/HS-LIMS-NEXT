import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';

let owner; let buffer;
test.beforeAll(async () => { owner = ownerPool(); buffer = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#6aaacc' } }).png().toBuffer(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const file = () => ({ name: 'Sample β.png', mimeType: 'image/png', buffer });
async function setup(page, { count = 1, sampleType = 'internal' } = {}) {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
  const response = await page.request.post('/api/samples', { headers, data: { ...fixture.registration, sampleType,
    ...(sampleType === 'quality_control' ? { iqcType: 'retest' } : {}), products: Array.from({ length: count }, () => fixture.registration.products[0]) } });
  expect(response.status()).toBe(201);
  const path = `/api/samples/${(await response.json()).id}`;
  return { account, fixture, headers, path, sample: await (await page.request.get(path)).json() };
}
async function openEdit(page, id) {
  await page.goto(`/samples/${id}/edit`); await expect(page.getByRole('heading', { name: 'Edit Sample', exact: true })).toBeVisible();
}
async function readyPreview(page) {
  const preview = page.locator('.sample-form-image-preview');
  await expect(preview).toBeVisible(); await expect.poll(() => preview.evaluate(image => image.complete && image.naturalWidth)).toBe(120);
}

test('Product image upload previews, persists, expands and removes through the source form', async ({ page }, testInfo) => {
  const { sample, path } = await setup(page); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openEdit(page, sample.id);
  await page.getByLabel('Image Upload', { exact: true }).setInputFiles(file()); await readyPreview(page);
  await expect(page.getByText('Sample β.png', { exact: true })).toBeVisible();
  await page.locator('.col-lg-6').filter({ has: page.getByLabel('Image Upload', { exact: true }) }).screenshot({ path: testInfo.outputPath('sample-image-form.png') });
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click(); await expect(page).toHaveURL(`/samples/${sample.id}`);
  const saved = await (await page.request.get(path)).json(); expect(saved.products[0].id).toBe(sample.products[0].id);
  const url = saved.products[0].image.url; const content = await page.request.get(url);
  expect(content.status()).toBe(200); expect(await content.body()).toEqual(buffer); expect(content.headers()['x-content-type-options']).toBe('nosniff');
  const expanded = page.getByRole('link', { name: `Open image for ${sample.products[0].productName}`, exact: true });
  await expect(expanded).toHaveAttribute('href', url); await expect(expanded.locator('img')).toBeVisible();
  await openEdit(page, sample.id); await readyPreview(page);
  await page.getByRole('button', { name: 'Remove uploaded sample image', exact: true }).click();
  await expect(page.locator('.sample-form-image-preview')).toHaveCount(0);
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click(); await expect(page).toHaveURL(`/samples/${sample.id}`);
  expect((await (await page.request.get(path)).json()).products[0].imageFileId).toBeNull();
  expect((await page.request.get(url)).status()).toBe(200); expect(errors).toEqual([]);
});

test('a lost upload response retries the same immutable file and blocks saving while uploading', async ({ page }) => {
  const { sample, account } = await setup(page); await openEdit(page, sample.id);
  const ids = []; let calls = 0;
  await page.route('**/api/samples/images', async route => {
    ids.push(route.request().headers()['x-upload-request-id']); calls += 1;
    if (calls === 1) { await route.fetch(); await route.fulfill({ status: 503, json: { error: { message: 'Synthetic lost response' } } }); }
    else await route.continue();
  });
  await page.getByLabel('Image Upload', { exact: true }).setInputFiles(file());
  await expect(page.getByText('Synthetic lost response', { exact: true })).toBeVisible();
  await page.getByLabel('Image Upload', { exact: true }).setInputFiles(file()); await readyPreview(page);
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  expect(Number((await owner.query('SELECT count(*) FROM sample_image_assets WHERE organization_id=$1', [account.organizationId])).rows[0].count)).toBe(1);
});

test('an upload cannot attach itself to a different Product row after its original row is removed', async ({ page }) => {
  const { sample, path } = await setup(page, { count: 2 }); await openEdit(page, sample.id);
  let release; const held = new Promise(resolve => { release = resolve; });
  let requested; const started = new Promise(resolve => { requested = resolve; });
  await page.route('**/api/samples/images', async route => { requested(); await held; await route.continue().catch(() => {}); });
  await page.getByLabel('Image Upload', { exact: true }).first().setInputFiles(file()); await started;
  await expect(page.getByRole('button', { name: 'Update Sample', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove product', exact: true }).first().click(); release();
  await expect(page.getByLabel('Image Upload', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Update Sample', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click(); await expect(page).toHaveURL(`/samples/${sample.id}`);
  const saved = await (await page.request.get(path)).json(); expect(saved.products[0].id).toBe(sample.products[1].id); expect(saved.products[0].imageFileId).toBeNull();
});

test('HTTP image uploads require CSRF and reject mismatched content without changing the form', async ({ page }) => {
  const { sample, headers } = await setup(page); await openEdit(page, sample.id);
  const uploadHeaders = { ...headers, 'Content-Type': 'image/jpeg', 'X-File-Name': 'photo.jpg', 'X-Upload-Request-Id': randomUUID() };
  const bad = await page.request.post('/api/samples/images', { headers: uploadHeaders, data: buffer });
  expect(bad.status()).toBe(415); expect((await bad.json()).error.code).toBe('sample_image_type');
  delete uploadHeaders['X-CSRF-Token'];
  expect((await page.request.post('/api/samples/images', { headers: uploadHeaders, data: buffer })).status()).toBe(403);
  await page.getByLabel('Image Upload', { exact: true }).setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByText('Product images must be JPEG, PNG or WebP files.', { exact: true })).toBeVisible();
  await expect(page.locator('.sample-form-image-preview')).toHaveCount(0);
});

test('locked special sample edits keep the image control disabled', async ({ page }) => {
  const { sample } = await setup(page, { sampleType: 'quality_control' }); await openEdit(page, sample.id);
  await expect(page.getByLabel('Image Upload', { exact: true })).toBeDisabled();
});

test('a new sample created through the registration form retains its uploaded Product image', async ({ page }) => {
  const { fixture } = await setup(page); await page.goto('/samples/new/v2');
  for (const [name, label] of [['Customer', fixture.customer.name], ['Category', fixture.category.name], ['Product', fixture.product.name]]) {
    await page.getByRole('combobox', { name, exact: true }).fill(label);
    await page.getByRole('option', { name: label, exact: true }).click();
  }
  await page.getByLabel('Customer Address', { exact: true }).fill('Synthetic receiving bay');
  await page.getByRole('button', { name: 'Auto-fill parameters', exact: true }).click();
  await page.getByLabel('Tentative Reporting Date', { exact: true }).fill('2026-12-31');
  await page.getByLabel('Image Upload', { exact: true }).setInputFiles(file()); await readyPreview(page);
  await page.getByRole('button', { name: 'Save Sample', exact: true }).click();
  await expect(page).toHaveURL(/\/samples\/[a-f0-9-]{36}$/);
  await expect(page.getByRole('link', { name: `Open image for ${fixture.product.name}`, exact: true })).toBeVisible();
  const saved = await (await page.request.get(`/api${new URL(page.url()).pathname}`)).json();
  expect(saved.products[0].image.originalName).toBe('Sample β.png'); expect(saved.products[0].image.byteLength).toBe(buffer.length);
});
