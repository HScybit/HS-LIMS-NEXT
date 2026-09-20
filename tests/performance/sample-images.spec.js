import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';

test('sample image upload, transfer and rendered preview stay within the declared browser budgets', async ({ page }) => {
  test.setTimeout(180_000);
  expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/);
  const owner = ownerPool();
  const report = { status: 'running', conditions: { warmups: 1, measurements: 5, concurrency: 1, synthetic: true,
    includes: 'browser change event, SHA-256, upload, validation, database commit, image response/decode, React rendering and two animation frames',
    excludes: 'fixture creation, sign-in, file chooser and Playwright file injection before change event, sample persistence' }, results: [] };
  try {
    const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
    const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
    const small = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#6aaacc' } }).png().toBuffer();
    const pixels = Buffer.alloc(2048 * 1600 * 3); let value = 271828;
    for (let index = 0; index < pixels.length; index += 1) { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; pixels[index] = value & 255; }
    const large = await sharp(pixels, { raw: { width: 2048, height: 1600, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(large.length).toBeGreaterThan(9 * 1024 * 1024); expect(large.length).toBeLessThanOrEqual(10 * 1024 * 1024);
    await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
    const headers = { Origin: new URL(page.url()).origin, 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
    const created = await page.request.post('/api/samples', { headers, data: fixture.registration }); expect(created.status()).toBe(201);
    await page.goto(`/samples/${(await created.json()).id}/edit`); await page.getByLabel('Image Upload', { exact: true }).scrollIntoViewIfNeeded();
    for (const [name, buffer, budgetMs] of [['small', small, 500], ['near-limit', large, 5000]]) {
      const samples = [];
      for (let iteration = 0; iteration < 6; iteration += 1) {
        await page.evaluate(() => {
          const previousSource = document.querySelector('.sample-form-image-preview')?.src;
          window.sampleImageTiming = {};
          document.querySelector('input[type="file"]').addEventListener('change', () => { window.sampleImageTiming.started = performance.now(); }, { once: true, capture: true });
          const loaded = event => {
            if (!event.target.matches?.('.sample-form-image-preview') || event.target.src === previousSource) return;
            document.removeEventListener('load', loaded, true);
            requestAnimationFrame(() => requestAnimationFrame(() => { window.sampleImageTiming.elapsed = performance.now() - window.sampleImageTiming.started; }));
          };
          document.addEventListener('load', loaded, true);
        });
        await page.getByLabel('Image Upload', { exact: true }).setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer });
        await page.waitForFunction(() => Number.isFinite(window.sampleImageTiming?.elapsed));
        const elapsed = await page.evaluate(() => window.sampleImageTiming.elapsed);
        if (iteration) samples.push(elapsed);
      }
      const p95Ms = [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1];
      report.results.push({ name, byteLength: buffer.length, samplesMs: samples, budgetMs, p95Ms, passed: p95Ms <= budgetMs });
    }
    report.status = report.results.every(result => result.passed) ? 'passed' : 'failed';
    expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.error = { message: error.message }; throw error; }
  finally { await writeFile('.local/sample-images-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
