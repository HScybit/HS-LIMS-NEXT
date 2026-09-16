import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool } from '../helpers/database.js';
import { createNablPerformanceFixture } from '../helpers/nabl-performance.js';
import { closePool } from '../../src/db/pool.js';

const watched = ['src/components/compliance/NablForm.jsx', 'src/components/compliance/NablScopes.jsx', 'src/components/compliance/NablList.jsx', 'src/compliance/nabl.js', 'tests/helpers/nabl-performance.js', 'tests/performance/nabl.spec.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const endpoint = '/api/operations/nabl-certifications';
test('NABL lists and scope editing remain responsive at 100/10000 references and 10/2000 stored scopes', async ({ page }) => {
  test.setTimeout(240_000); expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/);
  const owner = ownerPool();
  const report = { status: 'running', startedAt: new Date().toISOString(), buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), sourceHashes: await hashes(),
    measurement: 'One warmup/five samples in production Chrome. Navigation, HTTP response transfer/parse, visible rows and two frames; input fill through two frames. Await debounced results before next navigation, outside input timing. 250-character parameter/product/method names, ten visible rows, two selections of each kind per scope. Fixture setup, ANALYZE and login excluded. No initial page-mount Product/MoA choice requests.', cases: [] };
  try {
    for (const [count, scopeCount] of [[100, 10], [10000, 2000]]) {
      const fixture = await createNablPerformanceFixture(owner, count, scopeCount); await page.context().clearCookies();
      await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(fixture.actor.username); await page.getByLabel('Password', { exact: true }).fill(fixture.actor.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      for (const operation of ['list', 'edit']) {
        const loads = []; const inputs = []; const searches = []; let responseBytes; let choices = 0;
        const watch = request => { if (request.url().endsWith(`${endpoint}/catalog`) && request.postDataJSON().kind !== 'parameter') choices += 1; };
        page.on('request', watch);
        try {
          for (let iteration = -1; iteration < 5; iteration += 1) {
            const response = page.waitForResponse(response => operation === 'list' ? new URL(response.url()).pathname === endpoint : response.url().endsWith(`${endpoint}/${fixture.command.id}?editing=1`));
            const start = performance.now(); await page.goto(operation === 'list' ? '/nabl_certificates' : `/nabl_certificates/${fixture.command.id}/edit`);
            const body = await (await response).body(); const data = JSON.parse(body.toString()); responseBytes = body.length;
            if (operation === 'list') { expect(data.totalCount).toBe(count); await expect(page.getByRole('link', { name: 'View', exact: true }).first()).toBeVisible(); }
            else { expect(data.scopes).toHaveLength(scopeCount); await expect(page.getByText(/^Parameter 00001 /).first()).toBeVisible(); }
            await frames(page); const loadMs = performance.now() - start;
            const needle = operation === 'list' ? '2024' : 'Parameter';
            const filtered = page.waitForResponse(response => {
              const url = new URL(response.url());
              if (operation === 'list') return url.pathname === endpoint && JSON.parse(url.searchParams.get('query') || '{}').search === needle;
              return url.pathname === `${endpoint}/catalog` && response.request().postDataJSON().search === needle;
            });
            const inputStart = performance.now(); await page.getByPlaceholder('Search...', { exact: true }).fill(needle); await frames(page); const inputMs = performance.now() - inputStart;
            expect((await (await filtered).json()).totalCount).toBe(count); searches.push(needle);
            if (iteration >= 0) { loads.push(loadMs); inputs.push(inputMs); }
          }
        } finally { page.off('request', watch); }
        expect(choices).toBe(0);
        const result = { operation, records: count, scopeRows: operation === 'edit' ? scopeCount : undefined, loadSamplesMs: loads, inputSamplesMs: inputs,
          loadP95Ms: p95(loads), inputP95Ms: p95(inputs), responseBytes, loadBudgetMs: count === 100 ? 2500 : 5000, inputBudgetMs: 500, initialChoiceRequests: choices, completedSearches: searches.length };
        result.passed = result.loadP95Ms <= result.loadBudgetMs && result.inputP95Ms <= result.inputBudgetMs; report.cases.push(result); console.log(JSON.stringify(result));
      }
    }
    expect(await hashes()).toEqual(report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/m06-nabl-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
