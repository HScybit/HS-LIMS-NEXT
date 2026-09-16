import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';

const watched = ['src/components/masters/MaterialCategoryList.jsx', 'src/components/ui/DataTable.jsx', 'src/masters/material-categories.js', 'tests/performance/material-categories.spec.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('material category listing and search input remain responsive with 1000 and 10000 categories', async ({ page }) => {
  expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/);
  const owner = ownerPool();
  const report = { status: 'running', startedAt: new Date().toISOString(), buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), sourceHashes: await hashes(),
    measurement: 'Production Chrome, ten-row pages, 160-character descriptions, one warmup/five samples. Navigation/API/visible rows through two animation frames; search typing through two frames. Debounced search completion is awaited outside the input measurement before the next navigation. Fixture setup, ANALYZE, login and screenshots excluded.', cases: [] };
  try {
    const account = await createAccount(owner, { permissions: ['masters.manage'] }); let existing = 0;
    await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
    for (const count of [1000, 10000]) {
      await owner.query(`INSERT INTO material_categories(organization_id,name,description,reusable,expirable)
        SELECT $1,'Synthetic category '||lpad(number::text,5,'0'),$4,number%2=0,number%3=0 FROM generate_series($2::integer,$3::integer) number`,
      [account.organizationId, existing + 1, count, 'Synthetic '.repeat(16)]); existing = count; await owner.query('ANALYZE material_categories');
      const loads = []; const inputs = [];
      for (let iteration = -1; iteration < 5; iteration += 1) {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/masters/material-categories');
        const start = performance.now(); await page.goto('/material_categories'); const data = await (await response).json(); expect(data.totalCount).toBe(count);
        await expect(page.getByRole('cell', { name: /^Synthetic category/ }).first()).toBeVisible();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const loadMs = performance.now() - start;
        const filtered = page.waitForResponse(response => {
          const url = new URL(response.url()); if (url.pathname !== '/api/masters/material-categories') return false;
          return JSON.parse(url.searchParams.get('query') || '{}').search === 'category';
        });
        const changing = performance.now(); await page.getByPlaceholder('Search...', { exact: true }).fill('category');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const inputMs = performance.now() - changing;
        await expect(page.getByPlaceholder('Search...', { exact: true })).toHaveValue('category'); expect((await (await filtered).json()).totalCount).toBe(count);
        if (iteration >= 0) { loads.push(loadMs); inputs.push(inputMs); }
      }
      const result = { categories: count, loadSamplesMs: loads, inputSamplesMs: inputs, loadP95Ms: p95(loads), inputP95Ms: p95(inputs), loadBudgetMs: count === 1000 ? 2500 : 5000, inputBudgetMs: 500 };
      result.passed = result.loadP95Ms <= result.loadBudgetMs && result.inputP95Ms <= result.inputBudgetMs; report.cases.push(result); console.log(JSON.stringify(result));
    }
    expect(await hashes()).toEqual(report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/m06-material-categories-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await owner.end(); }
});
