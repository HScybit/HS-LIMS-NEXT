import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';

const watched = ['src/samples/edit-form.js', 'src/samples/load.js', 'src/components/samples/SampleRegistration.jsx',
  'src/components/samples/SampleProductCard.jsx', 'tests/performance/sample-edit-form.spec.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('the production edit form loads and responds with one and one hundred saved Product lines', async ({ page }) => {
  expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/);
  const owner = ownerPool();
  const report = { status: 'running', startedAt: new Date().toISOString(), buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(),
    sourceHashes: await hashes(), measurement: 'Production Chrome on local synthetic data. One warmup/five measurements per case. Full navigation through all saved row controls and two animation frames; input change through two animation frames. Includes network, API loading and React. Excludes fixture creation, sign-in, first navigation, screenshots and persistence.', cases: [] };
  try {
    const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
    const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
    await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/me$/);
    const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
    for (const lines of [1, 100]) {
      const created = await page.request.post('/api/samples', { headers, data: { ...fixture.registration,
        products: Array.from({ length: lines }, () => fixture.registration.products[0]) } });
      expect(created.status()).toBe(201); const sample = await created.json(); const loadTimes = []; const changeTimes = [];
      for (let index = 0; index < 6; index += 1) {
        const started = performance.now(); await page.goto(`/samples/${sample.id}/edit`);
        await expect(page.getByRole('heading', { name: 'Edit Sample', exact: true })).toBeVisible();
        const fields = page.getByLabel('Requested size 1', { exact: true }); await expect(fields).toHaveCount(lines);
        await expect(fields.last()).toBeAttached(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const loadMs = performance.now() - started; const changeStarted = performance.now();
        await fields.first().fill(`Synthetic changed size ${index}`);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const changeMs = performance.now() - changeStarted;
        await expect(fields.first()).toHaveValue(`Synthetic changed size ${index}`);
        if (index) { loadTimes.push(loadMs); changeTimes.push(changeMs); }
      }
      const result = { lines, tests: lines, loadSamplesMs: loadTimes, changeSamplesMs: changeTimes, loadP95Ms: p95(loadTimes), changeP95Ms: p95(changeTimes),
        loadBudgetMs: lines === 1 ? 2500 : 5000, changeBudgetMs: 500 };
      result.passed = result.loadP95Ms <= result.loadBudgetMs && result.changeP95Ms <= result.changeBudgetMs;
      report.cases.push(result); console.log(JSON.stringify(result));
      if (lines === 100) await page.screenshot({ path: '.local/m05-sample-edit-form-large.png' });
    }
    expect(await hashes()).toEqual(report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed';
    expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
  finally {
    report.finishedAt = new Date().toISOString(); await writeFile('.local/sample-edit-form-browser-performance.json', JSON.stringify(report, null, 2) + '\n');
    await closePool(); await owner.end();
  }
});
