import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { createWorkflowCloneFixture } from '../helpers/workflow-clones.js';
import { closePool } from '../../src/db/pool.js';
import { signIn, withSession } from '../../src/auth/service.js';

const watched = ['src/components/organization-settings/OrganizationSettings.jsx', 'src/organization-settings/service.js',
  'src/organization-settings/sample-workflows.js', 'tests/performance/organization-test-request-workflows.spec.js'];
const hashes = async () => Object.fromEntries(await Promise.all(watched.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('organization Test Request workflow control loads and respond with 25 and 1000 published choices', async ({ page }) => {
  expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/);
  const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(),
    buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), sourceHashes: await hashes(),
    measurement: 'Production Chrome, one warmup/five measurements. Complete navigation, API and the common workflow control through two animation frames; changing the common selection through two frames. Fixture setup, login, first navigation and screenshots excluded.', cases: [] };
  try {
    const account = await createAccount(owner, { permissions: ['settings.manage', 'workflows.manage'] });
    Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
    const work = action => withSession(account.token, action, { csrfToken: account.csrfToken });
    await createLaboratoryFixture(owner, account, { repeated: false }); let choices = 1; let alternative;
    await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/me$/);
    for (const count of [25, 1000]) {
      for (; choices < count; choices += 1) alternative = await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges: 1, details: false, appliesTo: 'test_request' }));
      const loads = []; const inputs = [];
      for (let iteration = -1; iteration < 5; iteration += 1) {
        const started = performance.now(); await page.goto('/organization_settings');
        await page.getByRole('tab', { name: 'Workflow Configs', exact: true }).click();
        const select = page.getByLabel('Test Request / Job Workflow', { exact: true }); await expect(select.locator('option')).toHaveCount(count + 1);
        await expect(select).toBeVisible();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const loadMs = performance.now() - started; const changing = performance.now(); await select.selectOption(alternative.workflowId);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const inputMs = performance.now() - changing; await expect(select).toHaveValue(alternative.workflowId);
        if (iteration >= 0) { loads.push(loadMs); inputs.push(inputMs); }
      }
      const result = { choices: count, loadSamplesMs: loads, inputSamplesMs: inputs, loadP95Ms: p95(loads), inputP95Ms: p95(inputs),
        loadBudgetMs: count === 25 ? 2500 : 5000, inputBudgetMs: 500 };
      result.passed = result.loadP95Ms <= result.loadBudgetMs && result.inputP95Ms <= result.inputBudgetMs;
      report.cases.push(result); console.log(JSON.stringify(result));
    }
    expect(await hashes()).toEqual(report.sourceHashes); report.status = report.cases.every(result => result.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message }; throw error; }
  finally {
    report.finishedAt = new Date().toISOString(); await writeFile('.local/m04-test-request-workflows-browser-performance.json', JSON.stringify(report, null, 2) + '\n');
    await closePool(); await owner.end();
  }
});
