import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';

const runs = 30;
const interactionBudgets = {
  small: { editPaintP95Ms: 250, saveP95Ms: 500 },
  large: { editPaintP95Ms: 500, saveP95Ms: 1500 },
  complex: { editPaintP95Ms: 1500, saveP95Ms: 4000 },
};
function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
}

test('measure recorded Product context in allocated datasheets, repeated rendering and actual capture saves', async ({ page, browser, context }) => {
  test.setTimeout(1_800_000);
  const serverBytes = await readFile('.local/product-context-performance.json');
  const server = JSON.parse(serverBytes);
  expect(server.status, 'Complete the Product context server benchmark first.').toBe('completed');
  const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, runs, fixtures: [],
    budgets: { recordedAt: new Date().toISOString(), interactionBudgets, scope: 'Unthrottled local measurements only.' },
    buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), serverEvidenceSha256: createHash('sha256').update(serverBytes).digest('hex'),
    sourceSha256: server.sourceSha256, schemaJournalSha256: server.schemaJournalSha256,
    environment: { ...server.environment, browser: browser.version(), viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reactProductionProfiling: true },
    conditions: ['Production PROFILE_REACT=1 build, including profiling overhead.',
      'Separate first navigation plus thirty document navigations per condition. Static assets and database buffers may be warm.',
      'Read-only Product widgets share the actual allocated line projection in two repeated analytical rows.',
      'Typing restores the original input before blur; thirty subsequent saves persist actual changed numeric values.',
      'No source runtime, cold-cache, concurrent-load, maximal text/options or production latency claim.'] };
  const output = '.local/product-context-browser-performance.json';
  const saveReport = () => writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  await saveReport();
  const owner = ownerPool(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.setViewportSize(report.environment.viewport);
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.productContextBenchmark = { responses: [], longTasks: [] };
      new PerformanceObserver((list) => window.productContextBenchmark.longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true });
      window.fetch = async (...args) => {
        const start = performance.now(); const response = await originalFetch(...args);
        if (String(args[0]).startsWith('/api/datasheets/')) response.json = async () => {
          const text = await response.text(); const parseStart = performance.now(); const result = JSON.parse(text); const end = performance.now();
          window.productContextBenchmark.responses.push({ path: String(args[0]), apiMs: end - start, parseMs: end - parseStart,
            characters: text.length, status: response.status, canExecute: result.canExecute, metrics: result.metrics,
            productLines: Object.keys(result.dataContext?.productDetailsByLineId ?? {}).length });
          return result;
        };
        return response;
      };
    });
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    for (const fixture of server.fixtures) {
      await context.clearCookies();
      const account = await createAccount(owner, { organizationId: fixture.organizationId, permissions: ['samples.read', 'test_requests.allocate', 'datasheets.execute'] });
      const login = await context.request.post('/api/auth/login', { data: { identifier: account.username, password: account.password }, headers: { Origin: 'http://127.0.0.1:3100' } });
      expect(login.ok()).toBe(true);
      const csrf = (await context.cookies()).find((cookie) => cookie.name === 'sampleify_csrf')?.value;
      expect(csrf).toBeTruthy();
      const request = await context.request.get(`/api/test-requests/${fixture.requestId}`); expect(request.ok()).toBe(true);
      const current = await request.json();
      const assigned = await context.request.post(`/api/test-requests/${fixture.requestId}/assignments`, {
        data: { revision: current.revision, assignmentType: 'analyst', assignedUserId: account.userId }, headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf },
      });
      expect(assigned.ok()).toBe(true); expect((await assigned.json()).datasheetId).toBe(fixture.datasheetId);
      const result = { name: fixture.name, organizationId: fixture.organizationId, sampleId: fixture.sampleId, datasheetId: fixture.datasheetId,
        definitionFields: fixture.definitionFields, expandedValues: fixture.expandedValues, conditions: [],
        budgets: { browserReadyP95Ms: fixture.browserReadyP95Ms, ...interactionBudgets[fixture.name] } };
      report.fixtures.push(result);
      for (const throttled of [false, true]) {
        report.phase = `${fixture.name}: ${throttled ? 'throttled' : 'local'} loads`; await saveReport();
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttled ? 4 : 1 });
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: throttled ? 150 : 0, downloadThroughput: throttled ? 1_600_000 / 8 : -1, uploadThroughput: throttled ? 750_000 / 8 : -1 });
        const measurements = []; let firstLoad;
        for (let run = -1; run < runs; run += 1) {
          await page.goto(`/samples/${fixture.sampleId}/data_sheets/${fixture.datasheetId}`);
          await expect(page.locator('#template-designer .widget-col[data-field-id]')).toHaveCount(fixture.expandedValues, { timeout: 30_000 });
          await expect.poll(() => page.evaluate(() => performance.getEntriesByName('datasheet:react-mount').length), { message: 'Use PROFILE_REACT=1 for the production build.' }).toBeGreaterThan(0);
          const timing = await page.evaluate(async () => {
            const measure = (name) => performance.getEntriesByName(name, 'measure').at(-1);
            const response = window.productContextBenchmark.responses.find((entry) => entry.path.includes('?'));
            const input = document.querySelector('#template-designer input[type="number"]'); const original = input.value;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            input.focus(); const before = performance.getEntriesByName('datasheet:react-update').length; const start = performance.now();
            setter.call(input, original === '2.5' ? '1.25' : '2.5'); input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const editPaintMs = performance.now() - start; const updates = performance.getEntriesByName('datasheet:react-update').slice(before);
            setter.call(input, original); input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(resolve)); input.blur();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const commit = measure('datasheet:data-to-commit');
            return { apiMs: response.apiMs, parseMs: response.parseMs, stateEnqueueMs: measure('datasheet:state-enqueue').duration,
              dataToCommitMs: commit.duration, readyMs: commit.startTime + commit.duration, reactMountMs: measure('datasheet:react-mount').duration,
              editPaintMs, editReactMs: updates.reduce((sum, entry) => sum + entry.duration, 0), editCommits: updates.length,
              originalValue: original, productLines: response.productLines, canExecute: response.canExecute, metrics: response.metrics,
              longTasks: window.productContextBenchmark.longTasks, heapUsed: performance.memory?.usedJSHeapSize ?? null,
              apiRequests: performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname.startsWith('/api/')).map((entry) => ({ path: new URL(entry.name).pathname,
                duration: entry.duration, transferSize: entry.transferSize, decodedBodySize: entry.decodedBodySize })) };
          });
          expect(timing.canExecute).toBe(true); expect(timing.productLines).toBe(1); expect(timing.editCommits).toBeGreaterThan(0); expect(timing.originalValue).toBe('1.25');
          if (run < 0) firstLoad = timing; else measurements.push(timing);
        }
        result.conditions.push({ name: throttled ? '4x CPU, 150 ms latency, 1.6 Mbps down / 750 Kbps up' : 'Unthrottled local warm', firstLoad, measurements,
          summary: Object.fromEntries(['apiMs', 'parseMs', 'stateEnqueueMs', 'dataToCommitMs', 'readyMs', 'reactMountMs', 'editPaintMs', 'editReactMs'].map((key) => [key, stats(measurements.map((sample) => sample[key]))])) });
        console.log(`${fixture.name}: ${throttled ? 'throttled' : 'local'} ready p95 ${result.conditions.at(-1).summary.readyMs.p95.toFixed(1)} ms.`); await saveReport();
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      report.phase = `${fixture.name}: saves`; await saveReport(); const saves = [];
      for (let run = 0; run < runs; run += 1) {
        const count = await page.evaluate(() => window.productContextBenchmark.responses.filter((row) => row.path.endsWith('/values')).length);
        const input = page.locator('#template-designer input[type="number"]').first();
        await input.fill(run % 2 ? '1.25' : '2.5'); await input.blur();
        await expect.poll(() => page.evaluate(() => window.productContextBenchmark.responses.filter((row) => row.path.endsWith('/values')).length)).toBe(count + 1);
        const saved = await page.evaluate(() => window.productContextBenchmark.responses.filter((row) => row.path.endsWith('/values')).at(-1));
        expect(saved.status).toBe(200); saves.push(saved);
      }
      result.saves = saves; result.saveApiMs = stats(saves.map((row) => row.apiMs));
      const local = result.conditions[0].summary;
      result.checks = { ready: local.readyMs.p95 <= result.budgets.browserReadyP95Ms, editPaint: local.editPaintMs.p95 <= result.budgets.editPaintP95Ms, save: result.saveApiMs.p95 <= result.budgets.saveP95Ms };
      await saveReport();
    }
    expect(errors).toEqual([]); expect(report.fixtures.every((fixture) => Object.values(fixture.checks).every(Boolean)), 'Predeclared local performance budgets').toBe(true);
    report.status = 'completed'; delete report.phase;
  } catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); report.errors = errors; await saveReport(); await owner.end(); }
});
