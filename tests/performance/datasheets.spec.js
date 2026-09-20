import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';

const runs = 30;
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}

test('measure allocated runtime parsing, repeated React rendering, input latency and autosave', async ({ page, browser, context }) => {
  test.setTimeout(1_800_000);
  const server = JSON.parse(await readFile('.local/datasheet-performance.json', 'utf8'));
  expect(server.status, 'Complete the server runtime benchmark first.').toBe('completed');
  const buildId = (await readFile('.next/BUILD_ID', 'utf8')).trim();
  let previous;
  try { previous = await readFile('.local/datasheet-browser-performance.json', 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const retainedPath = previous ? `.local/datasheet-browser-performance-${Date.now()}.json` : null;
  if (previous) await writeFile(retainedPath, previous, { mode: 0o600 });
  const resume = process.env.RESUME_DATASHEET_BENCHMARK === '1' ? JSON.parse(previous ?? 'null') : null;
  if (process.env.RESUME_DATASHEET_BENCHMARK === '1') {
    expect(resume?.buildId, 'Resume requires the same recorded production build.').toBe(buildId);
    expect(resume.schemaJournalSha256).toBe(server.schemaJournalSha256);
    for (const fixture of resume.fixtures) expect(server.fixtures.find((item) => item.name === fixture.name)?.fixtureSha256).toBe(fixture.fixtureSha256);
  }
  const report = { generatedAt: new Date().toISOString(), synthetic: true, status: 'running', runs, fixtures: [],
    scope: 'Allocated datasheet with actual repeated input widgets, persisted formulas and validation.',
    environment: { ...server.environment, browser: browser.version(), viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reactProductionProfiling: true },
    conditions: ['Production PROFILE_REACT=1 build; profiling overhead included.', 'Separate first navigation plus 30 subsequent document navigations per condition.',
      'API no-store; static assets may be warm. Browser/DB buffers are not cold.', 'Typing measurements restore the original value before blur; save measurements use actual changed values.',
      'No source application latency comparison.'], schemaJournalSha256: server.schemaJournalSha256, buildId,
    sourceFileHashes: server.sourceFileHashes, ...(resume ? { resumedFrom: retainedPath } : {}) };
  if (resume) report.fixtures = resume.fixtures.filter((fixture) => fixture.conditions.length === 2 && fixture.saves?.length === runs);
  const owner = ownerPool(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const saveReport = () => writeFile('.local/datasheet-browser-performance.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  try {
    const account = await createAccount(owner, { organizationId: server.fixtures[0].organizationId, permissions: ['samples.read', 'test_requests.allocate', 'datasheets.execute'] });
    const login = await context.request.post('/api/auth/login', { data: { identifier: account.username, password: account.password }, headers: { Origin: 'http://127.0.0.1:3100' } });
    expect(login.ok()).toBe(true);
    const csrf = (await context.cookies()).find((cookie) => cookie.name === 'sampleify_csrf')?.value;
    expect(csrf).toBeTruthy();
    for (const fixture of server.fixtures) {
      const request = await context.request.get(`/api/test-requests/${fixture.requestId}`);
      expect(request.ok()).toBe(true);
      const current = await request.json();
      const assigned = await context.request.post(`/api/test-requests/${fixture.requestId}/assignments`, {
        data: { revision: current.revision, assignmentType: 'analyst', assignedUserId: account.userId }, headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf },
      });
      expect(assigned.ok()).toBe(true);
    }
    await page.setViewportSize(report.environment.viewport);
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.datasheetBenchmark = { responses: [], longTasks: [] };
      new PerformanceObserver((list) => window.datasheetBenchmark.longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true });
      window.fetch = async (...args) => {
        const start = performance.now(); const response = await originalFetch(...args);
        if (String(args[0]).startsWith('/api/datasheets/')) {
          response.json = async () => {
            const text = await response.text(); const parseStart = performance.now(); const result = JSON.parse(text); const end = performance.now();
            window.datasheetBenchmark.responses.push({ path: String(args[0]), apiMs: end - start, parseMs: end - parseStart, characters: text.length,
              status: response.status, revision: result.revision ?? result.capture?.revision, canExecute: result.canExecute, metrics: result.metrics });
            return result;
          };
        }
        return response;
      };
    });
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    for (const fixture of server.fixtures) {
      if (report.fixtures.some((item) => item.name === fixture.name)) continue;
      const result = { name: fixture.name, fixtureSha256: fixture.fixtureSha256, definitionFields: fixture.definitionFields, expandedValues: fixture.expandedValues, conditions: [] };
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
            const measure = (name) => performance.getEntriesByName(name, 'measure').at(-1)?.duration;
            const response = window.datasheetBenchmark.responses.find((entry) => entry.path.includes('?'));
            const input = document.querySelector('#template-designer input[type="number"]');
            const original = input.value;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            input.focus();
            const before = performance.getEntriesByName('datasheet:react-update').length;
            const start = performance.now();
            setter.call(input, original === '2.5' ? '1.25' : '2.5'); input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const editPaintMs = performance.now() - start;
            const updates = performance.getEntriesByName('datasheet:react-update').slice(before);
            const typedValue = input.value;
            setter.call(input, original); input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(resolve)); input.blur();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            return { apiMs: response.apiMs, parseMs: response.parseMs, stateEnqueueMs: measure('datasheet:state-enqueue'), dataToCommitMs: measure('datasheet:data-to-commit'),
              reactMountMs: measure('datasheet:react-mount'), editPaintMs, editReactMs: updates.reduce((sum, entry) => sum + entry.duration, 0), editCommits: updates.length,
              typedValue, canExecute: response.canExecute, navigationMs: performance.getEntriesByType('navigation')[0].duration,
              longTasks: window.datasheetBenchmark.longTasks, heapUsed: performance.memory?.usedJSHeapSize ?? null,
              apiRequests: performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname.startsWith('/api/')).map((entry) => ({ path: new URL(entry.name).pathname, duration: entry.duration, transferSize: entry.transferSize, decodedBodySize: entry.decodedBodySize })) };
          });
          expect(timing.canExecute).toBe(true); expect(timing.editCommits).toBeGreaterThan(0);
          if (run < 0) firstLoad = timing; else measurements.push(timing);
        }
        result.conditions.push({ name: throttled ? '4x CPU, 150 ms latency, 1.6 Mbps down / 750 Kbps up' : 'Unthrottled local warm', firstLoad, measurements,
          summary: Object.fromEntries(['apiMs', 'parseMs', 'stateEnqueueMs', 'dataToCommitMs', 'reactMountMs', 'editPaintMs', 'editReactMs'].map((key) => [key, stats(measurements.map((sample) => sample[key]))])) });
        console.log(`${fixture.name}: ${throttled ? 'throttled' : 'local'} runtime data-to-commit p95 ${result.conditions.at(-1).summary.dataToCommitMs.p95.toFixed(1)} ms.`);
        await saveReport();
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      report.phase = `${fixture.name}: autosave`; await saveReport();
      const saves = [];
      for (let run = 0; run < runs; run += 1) {
        const count = await page.evaluate(() => window.datasheetBenchmark.responses.filter((row) => row.path.endsWith('/values')).length);
        const input = page.locator('#template-designer input[type="number"]').first();
        await input.fill(run % 2 ? '1.25' : '2.5'); await input.blur();
        await expect.poll(() => page.evaluate(() => window.datasheetBenchmark.responses.filter((row) => row.path.endsWith('/values')).length)).toBe(count + 1);
        const saved = await page.evaluate(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return window.datasheetBenchmark.responses.filter((row) => row.path.endsWith('/values')).at(-1);
        });
        expect(saved.status).toBe(200); saves.push(saved);
      }
      result.saves = saves; result.saveApiMs = stats(saves.map((row) => row.apiMs));
      await saveReport();
    }
    expect(errors).toEqual([]); report.status = 'completed'; report.errors = errors; delete report.phase; await saveReport();
  } catch (error) { report.status = 'failed'; report.failure = error.message; report.errors = errors; await saveReport(); throw error; }
  finally { await owner.end(); }
});
