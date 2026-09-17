import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { loadLaboratorySettings } from '../../src/organization-settings/service.js';
import { closePool } from '../../src/db/pool.js';

const runs = 30;
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
test.use({ timezoneId: 'UTC', viewport: { width: 1440, height: 1000 } });

test('measure Instrument wizard loading, configured fields, React input and persisted saves', async ({ page, context, browser }) => {
  const server = JSON.parse(await readFile('.local/instrument-fields-performance.json', 'utf8'));
  expect(server.status, 'Complete the service measurements first.').toBe('completed');
  const report = { status: 'running', synthetic: true, startedAt: new Date().toISOString(), runs, fixtures: [], errors: [],
    environment: { ...server.environment, chrome: browser.version(), reactProductionProfiling: true, viewport: { width: 1440, height: 1000 } },
    conditions: ['Production PROFILE_REACT=1 build with real configured access, services, fields and persisted revisions; profiling overhead included.',
      'One separate first navigation plus thirty measured navigations per shape, local and 4x CPU / 150 ms / 1.6 Mbps conditions.',
      'Ready includes navigation, native Instrument and service reads, opening Additional Details, its fields and two animation frames.',
      'Thirty local text edits and actual complete Instrument saves, including all configured services and captured fields.',
      'All Instrument API responses are measured; first definition parsing is reported separately. Live refresh remains enabled.',
      'No source runtime, cold-cache, concurrent-load or memory-leak comparison.'] };
  const owner = ownerPool();
  page.on('pageerror', error => report.errors.push(error.message));
  try {
    await page.addInitScript(() => {
      const metrics = { responses: [], readyMs: null, longTasks: [] }; window.instrumentFieldBenchmark = metrics;
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const start = performance.now(); const response = await original(...args);
        if (String(args[0]).startsWith('/api/instruments')) {
          response.json = async () => {
            const text = await response.text(); const parseStart = performance.now(); const value = JSON.parse(text);
            metrics.responses.push({ path: String(args[0]), method: args[1]?.method ?? 'GET', apiMs: performance.now() - start,
              parseMs: performance.now() - parseStart, characters: text.length });
            return value;
          };
        }
        return response;
      };
      new PerformanceObserver(entries => metrics.longTasks.push(...entries.getEntries().map(entry => entry.duration)))
        .observe({ type: 'longtask', buffered: true });
      const observer = new PerformanceObserver(entries => {
        if (!entries.getEntries().some(entry => entry.name === 'instrument-fields:react-mount')) return;
        observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => { metrics.readyMs = performance.now(); }));
      });
      observer.observe({ entryTypes: ['measure'] });
    });
    for (const fixture of server.fixtures) {
      await context.clearCookies();
      const account = await createAccount(owner, { organizationId: fixture.organizationId, permissions: ['instruments.manage', 'settings.manage'] });
      Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
      const modules = (await withSession(account.token, loadLaboratorySettings, { readOnly: true })).settings.moduleAccess;
      const access = modules.find(module => module.moduleKey === 'instrument'); access.enabled = true; access.userIds.push(account.userId);
      await saveModuleAccessSettings(account, modules);
      const login = await context.request.post('/api/auth/login', { data: { identifier: account.username, password: account.password }, headers: { Origin: 'http://127.0.0.1:3100' } });
      expect(login.ok()).toBe(true);
      const result = { name: fixture.name, fieldCount: fixture.fieldCount, serviceCount: fixture.serviceCount, instrumentId: fixture.instrumentId, conditions: [], saves: [] };
      report.fixtures.push(result);
      const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
      for (const throttled of [false, true]) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttled ? 4 : 1 });
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: throttled ? 150 : 0,
          downloadThroughput: throttled ? 1_600_000 / 8 : -1, uploadThroughput: throttled ? 750_000 / 8 : -1 });
        const measurements = []; let first;
        for (let run = -1; run < runs; run++) {
          await page.goto(`/equipments/${fixture.instrumentId}/edit`);
          await page.getByRole('button', { name: 'Additional Details', exact: true }).click();
          await expect.poll(() => page.evaluate(() => window.instrumentFieldBenchmark?.readyMs), { timeout: 30_000 }).toBeGreaterThan(0);
          await expect.poll(() => page.evaluate(() => performance.getEntriesByName('instrument-fields:react-mount').length), { message: 'Build with PROFILE_REACT=1.' }).toBeGreaterThan(0);
          await expect.poll(() => page.evaluate(() => window.instrumentFieldBenchmark.responses.filter(response => response.path.startsWith('/api/instruments/custom-field-users')).length)).toBe(1);
          const inputText = `Synthetic ${throttled ? 'throttled' : 'local'} browser edit ${run}`;
          const sample = await page.evaluate(async ({ id, value }) => {
            const metrics = window.instrumentFieldBenchmark;
            const before = performance.getEntriesByName('instrument-fields:react-update').length;
            const start = performance.now(); const input = document.getElementById(id);
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const inputPaintMs = performance.now() - start;
            const updates = performance.getEntriesByName('instrument-fields:react-update').slice(before);
            const definition = metrics.responses.find(response => response.path === '/api/instruments/custom-fields');
            return { readyMs: metrics.readyMs, definitionApiMs: definition.apiMs, definitionParseMs: definition.parseMs,
              definitionCharacters: definition.characters, reactMountMs: performance.getEntriesByName('instrument-fields:react-mount')[0].duration,
              inputPaintMs, inputReactMs: updates.reduce((total, entry) => total + entry.duration, 0), inputCommits: updates.length,
              apiRequests: metrics.responses.map(({ path }) => path), longTasks: metrics.longTasks, heapUsed: performance.memory?.usedJSHeapSize ?? null };
          }, { id: `instrument-custom-field-${fixture.fieldIds[0]}`, value: inputText });
          expect(sample.inputCommits).toBeGreaterThan(0);
          expect(sample.apiRequests.filter(path => path.startsWith('/api/instruments/custom-field-users'))).toHaveLength(1);
          if (run < 0) first = sample; else measurements.push(sample);
          if (!throttled && run >= 0) {
            const saving = page.waitForResponse(response => response.url().endsWith('/api/instruments') && response.request().method() === 'POST');
            const start = performance.now(); await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
            const response = await saving; const bytes = await response.body(); const parsed = JSON.parse(bytes.toString());
            expect(response.status()).toBe(200);
            expect(parsed.customFields.find(field => field.fieldId === fixture.fieldIds[0]).value).toBe(inputText);
            expect(parsed.serviceConfigurations).toHaveLength(fixture.serviceCount);
            result.saves.push({ elapsedMs: performance.now() - start, responseBytes: bytes.length, requestBytes: Buffer.byteLength(response.request().postData()), revision: parsed.revision });
            await expect(page).toHaveURL(/\/equipments$/);
          }
        }
        const summary = Object.fromEntries(['readyMs', 'definitionApiMs', 'definitionParseMs', 'reactMountMs', 'inputPaintMs', 'inputReactMs'].map(key => [key, p95(measurements.map(sample => sample[key]))]));
        result.conditions.push({ throttled, summary, first, measurements });
        console.log(JSON.stringify({ fixture: fixture.name, throttled, summary }));
        await writeFile('.local/instrument-fields-browser-performance.json', JSON.stringify(report, null, 2));
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await cdp.detach();
      const local = result.conditions[0].summary; const limits = server.budgets.browser[fixture.name];
      result.saveP95Ms = p95(result.saves.map(sample => sample.elapsedMs));
      result.checks = { ready: local.readyMs <= limits.readyP95Ms, input: local.inputPaintMs <= limits.inputPaintP95Ms, save: result.saveP95Ms <= limits.saveP95Ms };
    }
    expect(report.errors).toEqual([]);
    report.status = report.fixtures.every(fixture => Object.values(fixture.checks).every(Boolean)) ? 'completed' : 'failed';
    expect(report.status, 'See retained fixed-budget measurements.').toBe('completed');
  } catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/instrument-fields-browser-performance.json', JSON.stringify(report, null, 2)); await closePool(); await owner.end(); }
});
