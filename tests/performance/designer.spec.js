import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';

const runs = 30;
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}

test('measure production designer parsing, React work, editing and persistence', async ({ page, browser, context }) => {
  const server = JSON.parse(await readFile('.local/template-performance.json', 'utf8'));
  expect(server.status, 'Complete the server fixture benchmark before measuring the browser.').toBe('completed');
  const report = { generatedAt: new Date().toISOString(), synthetic: true, status: 'running', runs,
    scope: 'Designer definition canvas. Expanded capture rendering and the sample workflow are measured separately after domain integration.',
    environment: { ...server.environment, browser: browser.version(), viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reactProductionProfiling: true },
    conditions: ['Production Next build with PROFILE_REACT=1; profiling overhead is included.', 'No source application timing comparison.', 'API data is not cached; static browser resources can be warm.', 'First navigation and first draft-producing save are recorded separately.'], fixtures: [] };
  const owner = ownerPool();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const organization = (await owner.query('SELECT organization_id FROM templates WHERE id = $1', [server.fixtures[0].templateId])).rows[0].organization_id;
    const account = await createAccount(owner, { organizationId: organization, permissions: ['templates.read', 'templates.manage', 'datasheets.execute'] });
    await page.setViewportSize(report.environment.viewport);
    const login = await context.request.post('/api/auth/login', { data: { identifier: account.username, password: account.password }, headers: { Origin: 'http://127.0.0.1:3100' } });
    expect(login.ok()).toBe(true);
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.templateBenchmark = { responses: [], longTasks: [], model: null };
      new PerformanceObserver((list) => window.templateBenchmark.longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true });
      window.fetch = async (...args) => {
        const start = performance.now();
        const response = await originalFetch(...args);
        if (String(args[0]).startsWith('/api/templates/') || String(args[0]).startsWith('/api/template-versions/')) {
          response.json = async () => {
            const body = await response.text();
            const parseStart = performance.now();
            const result = JSON.parse(body);
            const end = performance.now();
            window.templateBenchmark.responses.push({ path: String(args[0]), apiMs: end - start, parseMs: end - parseStart, characters: body.length, metrics: result.metrics });
            if (result.model) window.templateBenchmark.model = result.model;
            return result;
          };
        }
        return response;
      };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    for (const fixture of server.fixtures) {
      const result = { name: fixture.name, fixtureSha256: fixture.fixtureSha256, definitionFields: fixture.definitionFields, conditions: [] };
      for (const throttled of [false, true]) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttled ? 4 : 1 });
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: throttled ? 150 : 0, downloadThroughput: throttled ? 1_600_000 / 8 : -1, uploadThroughput: throttled ? 750_000 / 8 : -1 });
        const measurements = [];
        let firstLoad;
        for (let run = -1; run < runs; run += 1) {
          await page.goto(`/master_template_management/${fixture.templateId}`);
          await expect(page.locator('#template-designer .widget-col')).toHaveCount(fixture.definitionColumns);
          await expect.poll(() => page.evaluate(() => performance.getEntriesByName('template:react-mount').length), { message: 'Use a production build with PROFILE_REACT=1.' }).toBeGreaterThan(0);
          const timing = await page.evaluate(async () => {
            const measure = (name) => performance.getEntriesByName(name, 'measure').at(-1)?.duration;
            const response = window.templateBenchmark.responses.find((entry) => entry.path.startsWith('/api/templates/'));
            const before = performance.getEntriesByName('template:react-update').length;
            const start = performance.now();
            document.querySelector('.widget-col.no-child').click();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const editPaintMs = performance.now() - start;
            const updates = performance.getEntriesByName('template:react-update').slice(before);
            return { apiMs: response.apiMs, parseMs: response.parseMs, stateEnqueueMs: measure('template:state-enqueue'), dataToCommitMs: measure('template:data-to-commit'),
              reactMountMs: measure('template:react-mount'), editPaintMs, editReactMs: updates.reduce((total, entry) => total + entry.duration, 0), editCommits: updates.length,
              navigationMs: performance.getEntriesByType('navigation')[0].duration, longTaskCount: window.templateBenchmark.longTasks.length,
              apiRequests: performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname.startsWith('/api/')).map((entry) => ({ path: new URL(entry.name).pathname, duration: entry.duration, transferSize: entry.transferSize, decodedBodySize: entry.decodedBodySize })),
              heapUsed: performance.memory?.usedJSHeapSize ?? null };
          });
          if (run < 0) firstLoad = timing; else measurements.push(timing);
        }
        result.conditions.push({ name: throttled ? '4x CPU, 150 ms latency, 1.6 Mbps down / 750 Kbps up' : 'Unthrottled local warm', firstLoad, measurements,
          summary: Object.fromEntries(['apiMs', 'parseMs', 'stateEnqueueMs', 'dataToCommitMs', 'reactMountMs', 'editPaintMs', 'editReactMs'].map((key) => [key, stats(measurements.map((sample) => sample[key]))])) });
        console.log(`${fixture.name}: ${throttled ? 'throttled' : 'local'} designer data-to-commit p95 ${result.conditions.at(-1).summary.dataToCommitMs.p95.toFixed(1)} ms.`);
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      const selected = await page.evaluate(() => {
        const model = window.templateBenchmark.model;
        for (const sectionId of model.rootSectionIds) for (const rowId of model.sectionsById[sectionId].rowIds) {
          const columns = model.rowsById[rowId].columnIds;
          if (columns.length > 1 && model.columnsById[columns[0]].fieldId) return { sectionId, columnId: columns[0] };
        }
      });
      expect(selected).toBeTruthy();
      const saves = [];
      for (let run = -1; run < runs; run += 1) {
        const count = await page.evaluate(() => performance.getEntriesByName('template:edit-save').length);
        const column = page.locator(`[data-col-id="${selected.columnId}"]`);
        await column.locator('.template-studio-column-label button').click();
        await page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: (run + 1) % 2 ? 'Move left' : 'Move right', exact: true }).click();
        await expect.poll(() => page.evaluate(() => performance.getEntriesByName('template:edit-save').length)).toBe(count + 1);
        await expect(page.locator('.template-designer-page')).toHaveAttribute('aria-busy', 'false');
        const duration = await page.evaluate(() => performance.getEntriesByName('template:edit-save').at(-1).duration);
        if (run < 0) result.firstDraftSaveMs = duration; else saves.push(duration);
      }
      result.saveMs = stats(saves); result.saveMeasurements = saves;
      report.fixtures.push(result);
      await writeFile('.local/template-browser-performance.json', JSON.stringify(report, null, 2), { mode: 0o600 });
    }
    expect(errors).toEqual([]);
    report.status = 'completed'; report.errors = errors;
    await writeFile('.local/template-browser-performance.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  } catch (error) {
    report.status = 'failed'; report.failure = error.message; report.errors = errors;
    await writeFile('.local/template-browser-performance.json', JSON.stringify(report, null, 2), { mode: 0o600 });
    throw error;
  } finally { await owner.end(); }
});
