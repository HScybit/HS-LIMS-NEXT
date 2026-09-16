import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool } from '../helpers/database.js';
import { materialPerformanceFixture } from '../helpers/material-performance-fixture.js';
import { closePool } from '../../src/db/pool.js';

const watched = ['src/components/materials/MaterialsList.jsx', 'src/components/ui/DataTable.jsx', 'src/materials/listing.js',
  'tests/helpers/material-performance-fixture.js', 'tests/performance/materials.spec.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('materials list navigation and search remain responsive with 100 and 1000 materials and a large stock history', async ({ page }) => {
  expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/); const owner = ownerPool();
  const report = { status: 'running', startedAt: new Date().toISOString(), buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), sourceHashes: await hashes(),
    measurement: 'Standalone production Chrome, one warmup/five samples, page10 and 160-character descriptions. 100/1000 materials; all 1000/10000 receipts on one material. Navigation/API/visible rows through two animation frames; search input through two frames. Debounced response awaited outside input measurement. Setup/ANALYZE/login excluded. No detail/batch-picker/cold/bulk/concurrency claim.', cases: [] };
  try {
    for (const materials of [100, 1000]) {
      const transactions = materials * 10; const { account } = await materialPerformanceFixture(owner, materials, transactions);
      await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
      await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      const loads = []; const inputs = [];
      for (let iteration = -1; iteration < 5; iteration += 1) {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/materials');
        const start = performance.now(); await page.goto('/materials'); const data = await (await response).json(); expect(data.totalCount).toBe(materials); expect(data.rows).toHaveLength(10);
        await expect(page.getByRole('link', { name: /^Synthetic material/ }).first()).toBeVisible();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const loadMs = performance.now() - start;
        const filtered = page.waitForResponse(response => {
          const url = new URL(response.url()); if (url.pathname !== '/api/materials') return false;
          return JSON.parse(url.searchParams.get('query') || '{}').search === 'material';
        });
        const changing = performance.now(); await page.getByPlaceholder('Search...', { exact: true }).fill('material');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const inputMs = performance.now() - changing;
        await expect(page.getByPlaceholder('Search...', { exact: true })).toHaveValue('material'); expect((await (await filtered).json()).totalCount).toBe(materials);
        if (iteration >= 0) { loads.push(loadMs); inputs.push(inputMs); }
      }
      const result = { materials, transactions, loadSamplesMs: loads, inputSamplesMs: inputs, loadP95Ms: p95(loads), inputP95Ms: p95(inputs),
        loadBudgetMs: materials === 100 ? 2500 : 5000, inputBudgetMs: 500 };
      result.passed = result.loadP95Ms <= result.loadBudgetMs && result.inputP95Ms <= result.inputBudgetMs; report.cases.push(result); console.log(JSON.stringify(result));
    }
    expect(await hashes()).toEqual(report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/m06-materials-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
