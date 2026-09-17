import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { cloneWorkflowDraft } from '../../src/workflows/authoring.js';

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];

test('incomplete draft saves and complete activations meet existing Workflow browser save budgets', async ({ page, browser }) => {
  const owner = ownerPool(); const service = JSON.parse(await readFile('.local/workflow-save-flow-performance.json', 'utf8'));
  expect(service.status).toBe('passed');
  const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, chrome: browser.version(),
    conditions: 'Ordinary production build, real local HTTP/session/native command and full definition reload with 1/100/1000-edge graphs. One warm-up and five measured saves per outcome/size. Timing starts at the click event and ends after the saved state renders and two frames. Navigation/setup/clone time excluded. No profiling, throttle, cold-cache or concurrent-load claim.', cases: [], errors: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  try {
    await page.addInitScript(() => {
      document.addEventListener('click', event => {
        if (event.target.closest('button')?.textContent.trim() === 'Save Flow') window.flowSaveAt = performance.now();
      }, true);
    });
    for (const entry of service.cases.filter(item => item.operation !== 'exact-retry')) {
      const actor = await createAccount(owner, { organizationId: entry.organizationId, permissions: ['workflows.manage'] });
      const session = await signIn({ identifier: actor.username, password: actor.password });
      const work = action => withSession(session.token, action, { csrfToken: session.csrfToken });
      await page.context().clearCookies();
      expect((await page.request.post('/api/auth/login', { headers: { Origin: 'http://127.0.0.1:3100' },
        data: { identifier: actor.username, password: actor.password } })).ok()).toBe(true);
      const measured = { edges: entry.edges, operation: entry.operation, budgetMs: entry.browserSaveBudgetMs, samples: [] }; report.cases.push(measured);
      let publishedVersionId = entry.versionId;
      for (let iteration = 0; iteration < 6; iteration++) {
        let versionId = entry.versionId;
        if (entry.operation === 'activation') versionId = (await work((client, identity) => cloneWorkflowDraft(client, identity, publishedVersionId))).versionId;
        await page.goto(`/workflow_management/${entry.workflowId}?versionId=${versionId}`);
        const button = page.getByRole('button', { name: 'Save Flow', exact: true }); await expect(button).toBeEnabled();
        await expect(page.locator('.workflow-node')).toHaveCount(entry.edges + 1);
        const commandResponse = page.waitForResponse(response => response.url().endsWith(`/api/workflows/${entry.workflowId}/commands`) && response.request().method() === 'POST');
        const definitionResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/api/workflows/${entry.workflowId}/definition`));
        await button.click(); const response = await commandResponse; const body = await response.body(); const outcome = JSON.parse(body.toString());
        expect(response.status()).toBe(200); expect(outcome.status).toBe(entry.operation === 'activation' ? 'published' : 'draft');
        const definition = await definitionResponse; const definitionBody = await definition.body(); expect(definition.status()).toBe(200);
        await expect(page.getByRole('status').filter({ hasText: entry.operation === 'activation' ? 'Workflow saved and activated.' : 'Draft saved.' })).toBeVisible();
        const elapsedMs = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.flowSaveAt)))));
        const sample = { elapsedMs, commandBytes: body.length, definitionBytes: definitionBody.length,
          commandHttpMs: response.request().timing().responseEnd, definitionHttpMs: definition.request().timing().responseEnd };
        if (iteration) measured.samples.push(sample); else measured.warmup = sample;
        if (entry.operation === 'activation') publishedVersionId = outcome.versionId;
      }
      measured.p95Ms = p95(measured.samples.map(sample => sample.elapsedMs)); measured.passed = measured.p95Ms <= measured.budgetMs;
      console.log(JSON.stringify({ edges: measured.edges, operation: measured.operation, p95Ms: measured.p95Ms, budgetMs: measured.budgetMs }));
      await writeFile('.local/workflow-save-flow-browser-performance.json', JSON.stringify(report, null, 2) + '\n');
    }
    expect(report.errors).toEqual([]); report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await closePool(); await owner.end(); await writeFile('.local/workflow-save-flow-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); }
});
