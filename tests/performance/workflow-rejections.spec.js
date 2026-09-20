import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
test('first rejection and full screen reload meet the existing Workflow save timing limits', async ({ page, browser }) => {
  const service = JSON.parse(await readFile('.local/workflow-rejection-performance.json', 'utf8')); expect(service.status).toBe('passed');
  const report = { status: 'running', startedAt: new Date().toISOString(), chrome: browser.version(), synthetic: true, cases: [], errors: [],
    conditions: 'Ordinary production Chrome, actual reject POST/commit and full Sample/Workflow reload, one warm-up and five measured first rejections per 1/100/1000 assignments. Starts at the click event; ends at the reloaded closed-request control and two frames. Setup/navigation excluded. No profiling, throttle, cold-cache or concurrency claim.' };
  page.on('pageerror', error => report.errors.push(error.message));
  try {
    await page.addInitScript(() => { document.addEventListener('click', event => { if (event.target.closest('button')?.textContent.trim() === 'Reject') window.rejectionAt = performance.now(); }, true); });
    for (const entry of service.cases) {
      await page.context().clearCookies();
      expect((await page.request.post('/api/auth/login', { headers: { Origin: 'http://127.0.0.1:3100' }, data: { identifier: entry.username, password: 'Synthetic-Password-For-Tests!' } })).status()).toBe(200);
      const measured = { assignments: entry.assignments, checks: entry.checks, budgetMs: entry.browserMs, samples: [] }; report.cases.push(measured);
      for (const [iteration, fixture] of entry.browserFixtures.entries()) {
        await page.goto(`/samples/${fixture.sampleId}`); await page.getByRole('button', { name: 'Take action', exact: true }).click();
        const dialog = page.getByRole('dialog'); await dialog.getByPlaceholder('Add a comment to respond', { exact: true }).fill('Synthetic browser rejection measurement');
        const responsePromise = page.waitForResponse(response => response.url().endsWith(`/api/approval-assignments/${fixture.assignmentId}/reject`));
        const reloadPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/samples/${fixture.sampleId}`);
        const workflowPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/workflow-runs/${fixture.runId}`);
        await dialog.getByRole('button', { name: 'Reject', exact: true }).click(); const response = await responsePromise; expect(response.status()).toBe(200);
        const body = await response.body(); expect(JSON.parse(body).status).toBe('rejected');
        const reload = await reloadPromise; expect(reload.status()).toBe(200); const reloaded = await reload.body();
        const workflow = await workflowPromise; expect(workflow.status()).toBe(200); const workflowBody = await workflow.body(); expect(JSON.parse(workflowBody).approvalRequest.status).toBe('rejected');
        await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: 'Take action', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'See all', exact: true })).toBeVisible();
        const elapsedMs = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.rejectionAt)))));
        const sample = { elapsedMs, commandBytes: body.length, reloadBytes: reloaded.length, workflowBytes: workflowBody.length,
          commandHttpMs: response.request().timing().responseEnd, reloadHttpMs: reload.request().timing().responseEnd, workflowHttpMs: workflow.request().timing().responseEnd };
        if (iteration) measured.samples.push(sample); else measured.warmup = sample;
      }
      measured.p95Ms = p95(measured.samples.map(sample => sample.elapsedMs)); measured.passed = measured.p95Ms <= measured.budgetMs;
      console.log(JSON.stringify({ assignments: measured.assignments, p95Ms: measured.p95Ms, budgetMs: measured.budgetMs }));
      await writeFile('.local/workflow-rejection-browser-performance.json', JSON.stringify(report, null, 2) + '\n');
    }
    expect(report.errors).toEqual([]); report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/workflow-rejection-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); }
});
