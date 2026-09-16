import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveLaboratorySettings } from '../../src/organization-settings/service.js';

const watched = ['tests/performance/organization-instrument-services.spec.js', 'src/components/organization-settings/OrganizationSettings.jsx',
  'src/components/organization-settings/InstrumentServices.jsx', 'src/organization-settings/service.js', 'src/organization-settings/instrument-services.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('Instrument Services settings load and respond with 3 and 100 full-length definitions', async ({ page }) => {
  expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/);
  const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(),
    sourceHashes: await hashes(), measurement: 'Standalone production Chrome, one warmup/five samples at3/100 definitions, 64-character codes/150-character labels. Navigation, API, state initialization, tab selection and two frames included in load; replacing the last label through two frames included in input. Fixtures, login and first navigation excluded. Other organization workflow/template choices are empty; no combined maximum or concurrent-throughput claim.', cases: [] };
  try {
    for (const count of [3, 100]) {
      const account = await createAccount(owner, { permissions: ['settings.manage'] });
      const session = await signIn({ identifier: account.username, password: account.password });
      const rows = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), serviceCode: String(index).padStart(64, 'A'), displayLabel: 'L'.repeat(150), isActive: true }));
      await withSession(session.token, (client, identity) => saveLaboratorySettings(client, identity, { revision: 0, autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null, instrumentServiceTypes: rows }), { csrfToken: session.csrfToken });
      await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
      await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      const loads = []; const inputs = [];
      for (let iteration = -1; iteration < 5; iteration++) {
        const started = performance.now(); await page.goto('/organization_settings'); await page.getByRole('tab', { name: 'Instrument Management', exact: true }).click();
        const last = page.getByLabel(`Instrument service ${count} name`, { exact: true }); await expect(last).toHaveValue('L'.repeat(150));
        await expect(page.getByLabel(/^Instrument service \d+ key$/)).toHaveCount(count);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const loadMs = performance.now() - started;
        await last.scrollIntoViewIfNeeded(); const changing = performance.now(); await last.fill('L'.repeat(149) + String(iteration + 1));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const inputMs = performance.now() - changing;
        if (iteration >= 0) { loads.push(loadMs); inputs.push(inputMs); }
      }
      const result = { definitions: count, loadSamplesMs: loads, inputSamplesMs: inputs, loadP95Ms: p95(loads), inputP95Ms: p95(inputs), loadBudgetMs: count === 3 ? 2500 : 5000, inputBudgetMs: 500 };
      result.passed = result.loadP95Ms <= result.loadBudgetMs && result.inputP95Ms <= result.inputBudgetMs; report.cases.push(result); console.log(JSON.stringify(result));
      if (count === 100) await expect(page.getByRole('button', { name: 'Add Service', exact: true })).toBeDisabled();
    }
    expect(await hashes()).toEqual(report.sourceHashes); report.status = report.cases.every(item => item.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message }; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/organization-instrument-services-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
