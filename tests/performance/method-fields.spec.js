import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';

const runs = 30;
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
test.use({ timezoneId: 'UTC', viewport: { width: 1440, height: 1000 } });

test('measure Method field loading, React rendering, input and actual saves', async ({ page, context, browser }) => {
  const server = JSON.parse(await readFile('.local/method-fields-performance.json', 'utf8'));
  expect(server.status, 'Complete the server fixture benchmark first.').toBe('completed');
  const report = { status: 'running', synthetic: true, startedAt: new Date().toISOString(), runs, fixtures: [],
    environment: { ...server.environment, chrome: browser.version(), reactProductionProfiling: true, viewport: { width: 1440, height: 1000 } },
    conditions: ['Production PROFILE_REACT=1 build, real synthetic tenant data and saves; profiling overhead included.',
      'One separate first navigation plus thirty warm navigations under local and 4x CPU / 150 ms / 1.6 Mbps conditions.',
      'Thirty local text edits and persisted/reloaded revisions. Ready time ends after all fields appear and two animation frames.',
      'Method history and current definitions arrive through separate authenticated API responses; reported definition parsing covers its response only.',
      'No full source runtime, cold-cache, concurrent-load or memory-leak comparison.'], errors: [] };
  const owner = ownerPool();
  page.on('pageerror', (error) => report.errors.push(error.message));
  try {
    await page.addInitScript(() => {
        const metrics = { responses: [], readyMs: null, longTasks: [] }; window.methodFieldBenchmark = metrics;
        const original = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const start = performance.now(); const response = await original(...args);
          if (String(args[0]).startsWith('/api/masters/methods')) {
            response.json = async () => {
              const text = await response.text(); const parseStart = performance.now(); const value = JSON.parse(text);
              metrics.responses.push({ path: String(args[0]), method: args[1]?.method ?? 'GET', apiMs: performance.now() - start,
                parseMs: performance.now() - parseStart, characters: text.length });
              return value;
            };
          }
          return response;
        };
        new PerformanceObserver((entries) => metrics.longTasks.push(...entries.getEntries().map((entry) => entry.duration))).observe({ type: 'longtask', buffered: true });
        const observer = new PerformanceObserver((entries) => {
          if (!entries.getEntries().some((entry) => entry.name === 'method-fields:react-mount')) return;
          observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => { metrics.readyMs = performance.now(); }));
        });
        observer.observe({ entryTypes: ['measure'] });
    });
    for (const fixture of server.fixtures) {
      await context.clearCookies();
      const account = await createAccount(owner, { organizationId: fixture.organizationId, permissions: ['masters.manage'] });
      const login = await context.request.post('/api/auth/login', { data: { identifier: account.username, password: account.password }, headers: { Origin: 'http://127.0.0.1:3100' } });
      expect(login.ok()).toBe(true);
      const result = { name: fixture.name, fieldCount: fixture.fieldCount, methodId: fixture.methodId, conditions: [], saves: [] };
      report.fixtures.push(result);
      const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
      for (const throttled of [false, true]) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttled ? 4 : 1 });
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: throttled ? 150 : 0,
          downloadThroughput: throttled ? 1_600_000 / 8 : -1, uploadThroughput: throttled ? 750_000 / 8 : -1 });
        const measurements = []; let first;
        for (let run = -1; run < runs; run++) {
          await page.goto(`/method_of_analysis/${fixture.methodId}/edit`);
          await expect.poll(() => page.evaluate(() => window.methodFieldBenchmark?.readyMs), { timeout: 30_000 }).toBeGreaterThan(0);
          await expect.poll(() => page.evaluate(() => performance.getEntriesByName('method-fields:react-mount').length), { message: 'Build with PROFILE_REACT=1.' }).toBeGreaterThan(0);
          await expect.poll(() => page.evaluate(() => window.methodFieldBenchmark.responses.filter((response) => response.path.startsWith('/api/masters/methods/custom-field-users')).length)).toBe(1);
          const inputText = `Synthetic ${throttled ? 'throttled' : 'local'} browser edit ${run}`;
          const sample = await page.evaluate(async ({ firstId, value }) => {
            const metrics = window.methodFieldBenchmark;
            const before = performance.getEntriesByName('method-fields:react-update').length;
            const start = performance.now(); const input = document.getElementById(firstId);
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const inputPaintMs = performance.now() - start;
            const updates = performance.getEntriesByName('method-fields:react-update').slice(before);
            const definition = metrics.responses.find((response) => response.path === '/api/masters/methods/custom-fields');
            return { readyMs: metrics.readyMs, definitionApiMs: definition.apiMs, definitionParseMs: definition.parseMs,
              definitionCharacters: definition.characters, reactMountMs: performance.getEntriesByName('method-fields:react-mount')[0].duration,
              inputPaintMs, inputReactMs: updates.reduce((total, entry) => total + entry.duration, 0), inputCommits: updates.length,
              apiRequests: metrics.responses.map(({ path }) => path), longTasks: metrics.longTasks, heapUsed: performance.memory?.usedJSHeapSize ?? null };
          }, { firstId: `method-custom-field-${fixture.fieldIds[0]}`, value: inputText });
          expect(sample.inputCommits).toBeGreaterThan(0);
          expect(sample.apiRequests.filter((path) => path.startsWith('/api/masters/methods/custom-field-users'))).toHaveLength(1);
          if (run < 0) first = sample; else measurements.push(sample);
          if (!throttled && run >= 0) {
            const saving = page.waitForResponse((response) => response.url().endsWith('/api/masters/methods') && response.request().method() === 'POST');
            const start = performance.now(); await page.getByRole('button', { name: 'Update', exact: true }).click();
            const response = await saving; const bytes = await response.body(); const parsed = JSON.parse(bytes.toString());
            expect(response.status()).toBe(200); expect(parsed.customFields.find((field) => field.fieldId === fixture.fieldIds[0]).value).toBe(inputText);
            result.saves.push({ elapsedMs: performance.now() - start, responseBytes: bytes.length, requestBytes: Buffer.byteLength(response.request().postData()), revision: parsed.revision });
            await expect(page).toHaveURL(/\/method_of_analysis$/);
          }
        }
        const summary = Object.fromEntries(['readyMs', 'definitionApiMs', 'definitionParseMs', 'reactMountMs', 'inputPaintMs', 'inputReactMs'].map((key) => [key, p95(measurements.map((sample) => sample[key]))]));
        result.conditions.push({ throttled, summary, first, measurements });
        console.log(JSON.stringify({ fixture: fixture.name, throttled, summary }));
        await writeFile('.local/method-fields-browser-performance.json', JSON.stringify(report, null, 2));
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await cdp.detach();
      const local = result.conditions[0].summary; const limits = server.budgets.browser[fixture.name];
      result.saveP95Ms = p95(result.saves.map((sample) => sample.elapsedMs));
      result.checks = { ready: local.readyMs <= limits.readyP95Ms, input: local.inputPaintMs <= limits.inputPaintP95Ms, save: result.saveP95Ms <= limits.saveP95Ms };
    }
    expect(report.errors).toEqual([]);
    report.status = report.fixtures.every((fixture) => Object.values(fixture.checks).every(Boolean)) ? 'completed' : 'failed';
    expect(report.status, 'See retained fixed-budget measurements.').toBe('completed');
  } catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/method-fields-browser-performance.json', JSON.stringify(report, null, 2)); await owner.end(); }
});
