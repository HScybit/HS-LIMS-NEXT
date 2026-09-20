import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';

const watched = ['src/components/masters/LaboratoryList.jsx', 'src/components/ui/DataTable.jsx', 'src/masters/laboratories.js', 'tests/performance/laboratories.spec.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('laboratory listing and search input remain responsive with 100 and 10000 laboratories', async ({ page }) => {
  expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/);
  const owner = ownerPool();
  const report = { status: 'running', startedAt: new Date().toISOString(), buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), sourceHashes: await hashes(),
    measurement: 'Production Chrome, ten-row pages; 200-character names, 64-character codes, 20-character abbreviations, 2000-character descriptions and four 2000-character raw limits. One warmup/five samples. Navigation/API/visible rows through two animation frames; search typing through two frames. Debounced completion awaited outside input timing before the next navigation. Fixture setup, ANALYZE, login and screenshots excluded.', cases: [] };
  try {
    const account = await createAccount(owner, { permissions: ['users.manage'] }); let existing = 0;
    await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
    for (const count of [100, 10000]) {
      await owner.query(`INSERT INTO laboratories(organization_id,code,name,description,abbreviation,minimum_temperature_text,maximum_temperature_text,minimum_humidity_text,maximum_humidity_text,active)
        SELECT $1,rpad('LAB-'||number,64,'X'),rpad('Synthetic lab '||lpad(number::text,5,'0'),200,'N'),repeat('D',2000),repeat('A',20),repeat('0',2000),repeat('T',2000),repeat(' ',2000),repeat('H',2000),number%2=0
        FROM generate_series($2::integer,$3::integer) number`, [account.organizationId, existing + 1, count]);
      existing = count; await owner.query('ANALYZE laboratories');
      const loads = []; const inputs = [];
      for (let iteration = -1; iteration < 5; iteration += 1) {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/administration/laboratories');
        const start = performance.now(); await page.goto('/lab_management'); const data = await (await response).json(); expect(data.totalCount).toBe(count);
        await expect(page.getByRole('cell', { name: /^Synthetic lab/ }).first()).toBeVisible();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const loadMs = performance.now() - start;
        const filtered = page.waitForResponse(response => {
          const url = new URL(response.url()); if (url.pathname !== '/api/administration/laboratories') return false;
          return JSON.parse(url.searchParams.get('query') || '{}').search === 'lab';
        });
        const changing = performance.now(); await page.getByPlaceholder('Search...', { exact: true }).fill('lab');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const inputMs = performance.now() - changing;
        await expect(page.getByPlaceholder('Search...', { exact: true })).toHaveValue('lab'); expect((await (await filtered).json()).totalCount).toBe(count);
        if (iteration >= 0) { loads.push(loadMs); inputs.push(inputMs); }
      }
      const result = { laboratories: count, loadSamplesMs: loads, inputSamplesMs: inputs, loadP95Ms: p95(loads), inputP95Ms: p95(inputs), loadBudgetMs: count === 100 ? 2500 : 5000, inputBudgetMs: 500 };
      result.passed = result.loadP95Ms <= result.loadBudgetMs && result.inputP95Ms <= result.inputBudgetMs; report.cases.push(result); console.log(JSON.stringify(result));
    }
    expect(await hashes()).toEqual(report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/m06-laboratories-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await owner.end(); }
});
