import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool } from '../helpers/database.js';
import { createModuleAccessPerformanceFixture } from '../helpers/module-access-performance.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { closePool } from '../../src/db/pool.js';

const endpoint = '/api/organization-settings/laboratory';
const watched = ['src/components/organization-settings/ModuleAccess.jsx', 'src/components/organization-settings/OrganizationSettings.jsx', 'src/organization-settings/module-access.js',
  'tests/helpers/module-access-performance.js', 'tests/performance/organization-module-access.spec.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
test('Access Control stays responsive with paged 10000-reference catalogs and 500 assignments of each kind', async ({ page }) => {
  test.setTimeout(240000); expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/);
  const owner = ownerPool(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  const report = { status: 'running', startedAt: new Date().toISOString(), buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), hashes: await hashes(),
    measurement: 'Production Chrome, one warmup/five samples per condition. Navigation, settings transfer/parse, all six initial paged catalog transfers for three modules, rendered assignments and two frames included. Input fill through two frames; await debounced results outside input timing. Fixture setup and login excluded. Each catalog contains 100/10000 references; each module has 0/100 or 0/500 assignments of each kind, with 137-character ordinary labels. No first bulk import, cold-cache or concurrent throughput claim.', cases: [] };
  try {
    for (const count of [100, 10000]) {
      const fixture = await createModuleAccessPerformanceFixture(owner, count);
      await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(fixture.actor.username);
      await page.getByLabel('Password', { exact: true }).fill(fixture.actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      for (const selections of [0, Math.min(500, count)]) {
        const modules = emptyModuleAccess().map((access, index) => { const offset = count === 10000 && selections && index === 1 ? 500 : 0;
          return { ...access, enabled: true, roleIds: fixture.roleIds.slice(offset, offset + selections), userIds: fixture.userIds.slice(offset, offset + selections) }; });
        await saveModuleAccessSettings(fixture.actor, modules);
        const loads = []; const inputs = []; let responseBytes; const choiceRequests = [];
        for (let iteration = -1; iteration < 5; iteration++) {
          const choices = []; const watch = response => { const url = new URL(response.url());
            if (url.pathname === '/api/organization-settings/module-access/options' && !url.searchParams.get('search')) choices.push(response); };
          page.on('response', watch);
          try {
            const response = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
            const start = performance.now(); await page.goto('/organization_settings'); const body = await (await response).body(); responseBytes = body.length;
            expect(JSON.parse(body.toString()).settings.moduleAccess[0].roleIds).toHaveLength(selections);
            await page.getByRole('tab', { name: 'Access Control', exact: true }).click();
            await expect.poll(() => choices.length).toBe(6); await Promise.all(choices.map(response => response.body()));
            const customer = page.getByRole('group', { name: 'Customer Master', exact: true });
            if (selections) await expect(customer).toContainText(`${selections * 2} assigned`);
            await frames(page); const loadMs = performance.now() - start;
            const needle = 'Access role'; const filtered = page.waitForResponse(response => {
              const url = new URL(response.url()); return url.pathname === '/api/organization-settings/module-access/options'
                && url.searchParams.get('kind') === 'role' && url.searchParams.get('search') === needle;
            });
            const inputStart = performance.now(); await customer.getByRole('combobox', { name: 'Roles', exact: true }).fill(needle); await frames(page); const inputMs = performance.now() - inputStart;
            expect((await (await filtered).json()).rows.length).toBe(Math.min(100, count - 2));
            if (iteration >= 0) { loads.push(loadMs); inputs.push(inputMs); choiceRequests.push(choices.length); }
          } finally { page.off('response', watch); }
        }
        const result = { choices: count, selectionsPerKindPerModule: selections, distinctSelectionsPerKind: selections * (count === 10000 ? 2 : 1), loadSamplesMs: loads, inputSamplesMs: inputs, loadP95Ms: p95(loads), inputP95Ms: p95(inputs),
          responseBytes, initialChoiceRequests: choiceRequests, loadBudgetMs: 2500, inputBudgetMs: 500 };
        result.passed = result.loadP95Ms <= result.loadBudgetMs && result.inputP95Ms <= result.inputBudgetMs && choiceRequests.every(value => value === 6);
        report.cases.push(result); console.log(JSON.stringify(result));
      }
    }
    expect(errors).toEqual([]); expect(await hashes()).toEqual(report.hashes); report.status = report.cases.every(row => row.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message }; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/organization-module-access-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
