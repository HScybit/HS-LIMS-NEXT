import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool } from '../helpers/database.js';
import { agreementAccount, agreementWork } from '../helpers/service-agreements.js';
import { saveModuleAccessSettings } from '../helpers/module-access.js';
import { loadLaboratorySettings } from '../../src/organization-settings/service.js';
import { closePool } from '../../src/db/pool.js';

const runs = 30;
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
test.use({ timezoneId: 'UTC', viewport: { width: 1440, height: 1000 } });

test('measure Agreement form loading, retained choices, React input and complete persisted saves', async ({ page, context, browser }) => {
  const server = JSON.parse(await readFile('.local/service-agreements-performance.json', 'utf8')); expect(server.status).toBe('completed');
  const report = { status: 'running', synthetic: true, startedAt: new Date().toISOString(), runs, fixtures: [], errors: [],
    environment: { ...server.environment, chrome: browser.version(), reactProductionProfiling: true, viewport: { width: 1440, height: 1000 } },
    conditions: ['Production PROFILE_REACT=1 build with real configured access, ten source controls and complete native saves; profiling overhead included.',
      'One separate first navigation plus thirty measured navigations per shape, local and 4x CPU / 150 ms / 1.6 Mbps conditions.',
      'Ready includes navigation, Agreement load, both paged reference catalogs with all retained selections, React mount and two animation frames.',
      'Thirty local notes edits and actual complete saves per shape, including all 10/100/500 Instrument selections and all three services.',
      'All Agreement API response durations and JSON parsing are recorded. No source runtime, cold-cache, concurrent-load or memory-leak comparison.'] };
  const owner = ownerPool(); page.on('pageerror', error => report.errors.push(error.message));
  try {
    await page.addInitScript(() => {
      const metrics = { responses: [], readyMs: null, longTasks: [], mounted: false }; window.agreementBenchmark = metrics;
      let scheduled = false;
      const ready = () => {
        if (scheduled || !metrics.mounted || metrics.responses.filter(item => item.kind === 'vendors' || item.kind === 'instruments').length < 2) return;
        scheduled = true; requestAnimationFrame(() => requestAnimationFrame(() => { metrics.readyMs = performance.now(); }));
      };
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const start = performance.now(); const response = await original(...args);
        if (String(args[0]).startsWith('/api/masters/service-agreements')) response.json = async () => {
          const text = await response.text(); const parseStart = performance.now(); const value = JSON.parse(text);
          const body = args[1]?.body ? JSON.parse(args[1].body) : null;
          metrics.responses.push({ path: String(args[0]), method: args[1]?.method ?? 'GET', kind: body?.kind, apiMs: performance.now() - start,
            parseMs: performance.now() - parseStart, characters: text.length }); ready(); return value;
        };
        return response;
      };
      new PerformanceObserver(entries => metrics.longTasks.push(...entries.getEntries().map(entry => entry.duration))).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver(entries => {
        if (entries.getEntries().some(entry => entry.name === 'service-agreement:react-mount')) { metrics.mounted = true; ready(); }
      }).observe({ entryTypes: ['measure'] });
    });
    for (const fixture of server.fixtures) {
      await context.clearCookies();
      const actor = await agreementAccount(owner, { organizationId: fixture.organizationId, permissions: ['masters.manage', 'settings.manage'] });
      const modules = (await agreementWork(actor, loadLaboratorySettings, true)).settings.moduleAccess;
      modules.find(module => module.moduleKey === 'service_agreements').userIds.push(actor.userId); await saveModuleAccessSettings(actor, modules);
      expect((await context.request.post('/api/auth/login', { data: { identifier: actor.username, password: actor.password }, headers: { Origin: 'http://127.0.0.1:3100' } })).ok()).toBe(true);
      const result = { name: fixture.name, instrumentCount: fixture.instrumentCount, catalogCount: fixture.catalogCount, agreementId: fixture.agreementId, conditions: [], saves: [] };
      report.fixtures.push(result); const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
      for (const throttled of [false, true]) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttled ? 4 : 1 });
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: throttled ? 150 : 0, downloadThroughput: throttled ? 1_600_000 / 8 : -1, uploadThroughput: throttled ? 750_000 / 8 : -1 });
        const measurements = []; let first;
        for (let run = -1; run < runs; run++) {
          await page.goto(`/service_agreements/${fixture.agreementId}/edit`);
          await expect.poll(() => page.evaluate(() => window.agreementBenchmark?.readyMs), { timeout: 30000 }).toBeGreaterThan(0);
          const value = `Synthetic ${throttled ? 'throttled' : 'local'} notes ${run}`;
          const sample = await page.evaluate(async value => {
            const metrics = window.agreementBenchmark; const before = performance.getEntriesByName('service-agreement:react-update').length;
            const input = document.getElementById('notes'); const start = performance.now();
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const updates = performance.getEntriesByName('service-agreement:react-update').slice(before);
            return { readyMs: metrics.readyMs, inputPaintMs: performance.now() - start, inputCommits: updates.length,
              inputReactMs: updates.reduce((sum, entry) => sum + entry.duration, 0), reactMountMs: performance.getEntriesByName('service-agreement:react-mount')[0].duration,
              api: metrics.responses, longTasks: metrics.longTasks, heapUsed: performance.memory?.usedJSHeapSize ?? null };
          }, value);
          expect(sample.inputCommits).toBeGreaterThan(0); expect(sample.api.filter(item => item.kind)).toHaveLength(2);
          if (run < 0) first = sample; else measurements.push(sample);
          if (!throttled && run >= 0) {
            const saving = page.waitForResponse(response => response.url().endsWith('/api/masters/service-agreements') && response.request().method() === 'POST');
            const start = performance.now(); await page.getByRole('button', { name: 'Update', exact: true }).click(); const response = await saving;
            const bytes = await response.body(); const parsed = JSON.parse(bytes.toString()); expect(response.status()).toBe(200);
            expect(parsed.notes).toBe(value); expect(parsed.instrumentIds).toHaveLength(fixture.instrumentCount); expect(parsed.includedServices).toHaveLength(3);
            result.saves.push({ elapsedMs: performance.now() - start, responseBytes: bytes.length, requestBytes: Buffer.byteLength(response.request().postData()), revision: parsed.revision });
            await expect(page).toHaveURL(/\/service_agreements$/);
          }
        }
        const summary = Object.fromEntries(['readyMs', 'inputPaintMs', 'inputReactMs', 'reactMountMs'].map(key => [key, p95(measurements.map(sample => sample[key]))]));
        result.conditions.push({ throttled, summary, first, measurements }); console.log(JSON.stringify({ fixture: fixture.name, throttled, summary }));
        await writeFile('.local/service-agreements-browser-performance.json', JSON.stringify(report, null, 2));
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await cdp.detach();
      const local = result.conditions[0].summary; const limits = server.budgets.browser[fixture.name]; result.saveP95Ms = p95(result.saves.map(sample => sample.elapsedMs));
      result.checks = { ready: local.readyMs <= limits.readyP95Ms, input: local.inputPaintMs <= limits.inputPaintP95Ms, save: result.saveP95Ms <= limits.saveP95Ms };
    }
    expect(report.errors).toEqual([]); report.status = report.fixtures.every(fixture => Object.values(fixture.checks).every(Boolean)) ? 'completed' : 'failed';
    expect(report.status, 'See retained fixed-budget measurements.').toBe('completed');
  } catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/service-agreements-browser-performance.json', JSON.stringify(report, null, 2)); await closePool(); await owner.end(); }
});
