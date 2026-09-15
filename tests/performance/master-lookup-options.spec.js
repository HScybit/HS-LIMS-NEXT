import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveProduct } from '../../src/masters/products.js';
import { saveTestParameter } from '../../src/masters/test-parameters.js';

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
test('Product and Parameter lookup catalogs have bounded form, menu and search latency', async ({ page, browser }) => {
  expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/);
  expect(JSON.parse(await readFile('.next/required-server-files.json', 'utf8')).config.reactProductionProfiling).toBe(false);
  const budgets = { recordedAt: new Date().toISOString(), warmups: 1, samples: 5,
    fields100: { readyMs: 1000, menuMs: 500, searchMs: 150 }, fields500: { readyMs: 2500, menuMs: 500, searchMs: 250 } };
  await writeFile('.local/master-lookup-options-browser-budgets.json', JSON.stringify(budgets, null, 2) + '\n');
  const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version, chrome: browser.version(),
    buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), databaseName: process.env.SAMPLEIFY_TEST_DATABASE_NAME, budgets, cases: [],
    conditions: 'Run alone in ordinary production Chrome with existing tracing. Each Product/Parameter has 100/500 lookup fields sharing one complete 10000-choice catalog; another 100-field case shares ten 1000-choice catalogs. 160-character labels, 80-character original IDs, ten captured choices per field, actual commands and explicit fixture ANALYZE. One warmup/five samples. Readiness spans document navigation through a visible frame containing every custom combobox, current selected labels and enabled Update, including HTTP/SQL, parsing, catalog preparation and React. Menu spans actual pointerdown through a populated visible frame, verifying full filtered-set accessibility positions/size and complete source-wide bulk count. Search spans input through a visible frame containing exactly the last match. Setup/login/assertion polling excluded. Functional tests separately verify large-menu keyboard navigation, raw duplicates, full-catalog filtered bulk and the 500-item bound. No tags, uncertainty grid or laboratory extras; no claim about first-operation latency or combined maximums.' };
  await page.addInitScript(() => {
    const query = new URL(location.href).searchParams; const count = Number(query.get('lookupFields')); const lines = Number(query.get('lookupLines'));
    const kind = query.get('lookupKind'); if (!count || !['product', 'parameter'].includes(kind)) return;
    const prefix = `${kind}-custom-field-`;
    window.lookupTiming = {};
    const custom = element => element instanceof HTMLInputElement && element.id.startsWith(prefix);
    function ready() {
      const inputs = document.querySelectorAll(`input[role="combobox"][id^="${prefix}"]`); const submit = document.querySelector('button[type="submit"]');
      if (inputs.length === count && inputs[0].closest('.smplfy-form-field').textContent.includes('Choice 0 ')
        && inputs[count - 1].closest('.smplfy-form-field').textContent.includes('Choice 0 ') && submit && !submit.disabled
        && inputs[0].getBoundingClientRect().width > 0) {
        requestAnimationFrame(() => { window.lookupTiming.readyMs = performance.now(); });
      } else requestAnimationFrame(ready);
    }
    requestAnimationFrame(ready);
    document.addEventListener('pointerdown', event => {
      if (!custom(event.target) || document.querySelector('[role="listbox"]')) return;
      const sample = { at: performance.now() }; window.lookupTiming.menu = sample;
      requestAnimationFrame(function painted() {
        const menu = document.querySelector('[role="listbox"]');
        const options = menu && [...menu.querySelectorAll('[role="option"]')];
        const fullSet = options?.length === lines || options?.length > 0 && options.every(option => Number(option.getAttribute('aria-setsize')) === lines
          && Number(option.getAttribute('aria-posinset')) >= 1 && Number(option.getAttribute('aria-posinset')) <= lines);
        const first = options?.find(option => option.getAttribute('aria-posinset') === '1') ?? options?.[0];
        const bounds = menu?.getBoundingClientRect(); const row = first?.getBoundingClientRect();
        if (bounds?.height > 0 && fullSet && row?.height > 0 && row.bottom > bounds.top && row.top < bounds.bottom
          && menu.querySelector('.smplfy-rselect__action-meta')?.textContent.includes(`/${lines} visible selected`)) {
          requestAnimationFrame(() => { sample.frameMs = performance.now() - sample.at; });
        } else if (performance.now() - sample.at < 30000) requestAnimationFrame(painted);
      });
    }, true);
    document.addEventListener('input', event => {
      if (!custom(event.target)) return;
      const sample = { at: performance.now() }; window.lookupTiming.search = sample;
      requestAnimationFrame(function painted() {
        const menu = document.querySelector('[role="listbox"]'); const options = menu?.querySelectorAll('[role="option"]');
        if (menu?.getBoundingClientRect().height > 0 && options?.length === 1 && options[0].textContent.includes(`Choice ${lines - 1} `)) {
          requestAnimationFrame(() => { sample.frameMs = performance.now() - sample.at; });
        } else if (performance.now() - sample.at < 30000) requestAnimationFrame(painted);
      });
    }, true);
  });
  try {
    report.files = [];
    for (const path of ['src/components/masters/ProductForm.jsx', 'src/components/masters/TestParameterForm.jsx',
      'src/components/masters/MasterCustomFields.jsx', 'src/components/ui/SearchableSelect.jsx', 'src/components/ui/WindowedSelectMenuList.jsx',
      'src/components/ui/selectUtils.js', 'src/custom-fields/lookup-client.js', 'src/custom-fields/lookup-sources.js',
      'src/masters/custom-field-draft.js', 'src/masters/custom-field-lookup-client.js', 'src/masters/custom-fields.js',
      'src/masters/products.js', 'src/masters/test-parameters.js', 'src/masters/master-custom-field-values.js',
      'src/app/api/masters/products/route.js', 'src/app/api/masters/test-parameters/route.js',
      'src/app/api/masters/products/custom-fields/route.js', 'src/app/api/masters/test-parameters/custom-fields/route.js',
      'src/app/api/masters/products/custom-fields/lookup-options/route.js', 'src/app/api/masters/test-parameters/custom-fields/lookup-options/route.js',
      'package.json', 'package-lock.json']) {
      report.files.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    }
    for (const kind of ['product', 'parameter']) for (const [fieldCount, sourceCount, lineCount] of [[100, 1, 10000], [500, 1, 10000], [100, 10, 1000]]) {
      const setup = performance.now(); const author = await createAccount(owner, { permissions: ['masters.manage'] });
      const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['masters.manage'] });
      const authorSession = await signIn({ identifier: author.username, password: author.password }); const session = await signIn({ identifier: manager.username, password: manager.password });
      const sourceIds = []; const lines = Array.from({ length: lineCount }, (_, index) => ({ id: `original_${index}`.padEnd(80, 'v'), label: `Choice ${index} `.padEnd(160, 'l') }));
      for (let index = 0; index < sourceCount; index++) {
        const id = randomUUID(); sourceIds.push(id);
        await withSession(authorSession.token, (c, i) => saveLookupSourceObservation(c, i, { id, revision: 0, requestId: randomUUID(),
          sourceId: 'Original-browser-' + randomUUID(), name: 'Browser source', lines }));
      }
      const fieldIds = Array.from({ length: fieldCount }, () => randomUUID());
      await withSession(authorSession.token, async (c, i) => {
        for (let index = 0; index < fieldIds.length; index++) await saveCustomField(c, i, { id: fieldIds[index], revision: 0, requestId: randomUUID(),
          key: `lookup_${index}`, label: `Lookup ${index}`.padEnd(160, 'f'), associatedWith: kind, fieldType: 'lookup', allowsMultiple: true,
          lookupSourceId: sourceIds[index % sourceIds.length], displayOrder: index });
      });
      const values = Array.from({ length: 10 }, (_, index) => lines[index * Math.floor(lineCount / 10)].id);
      const masterId = randomUUID(); const save = kind === 'product' ? saveProduct : saveTestParameter;
      await withSession(session.token, (c, i) => save(c, i, { id: masterId, requestId: randomUUID(), revision: 0, name: 'Browser lookup master', key: randomUUID(),
        ...(kind === 'parameter' ? { schemeAbbreviation: 'Lookup' } : {}),
        customFields: fieldIds.map(fieldId => ({ fieldId, fieldRevision: 1, value: values })) }));
      const analyze = performance.now(); await owner.query(`ANALYZE users,memberships,custom_field_definitions,custom_field_versions,
        custom_field_lookup_sources,custom_field_lookup_versions,custom_field_lookup_lines,products,product_versions,
        product_version_custom_fields,product_version_custom_field_values,test_parameters,test_parameter_versions,
        parameter_version_custom_fields,parameter_version_custom_field_values`);
      const entry = { kind, fieldCount, sourceCount, lineCount, organizationId: author.organizationId, masterId, fieldIds, sourceIds,
        setupMs: performance.now() - setup, analyzeMs: performance.now() - analyze,
        budgets: fieldCount === 100 ? budgets.fields100 : budgets.fields500, samples: [] };
      report.cases.push(entry);
      await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(manager.username);
      await page.getByLabel('Password', { exact: true }).fill(manager.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      for (let index = 0; index < 6; index++) {
        await page.goto(`/${kind === 'product' ? 'products' : 'test_parameters'}/${masterId}/edit?lookupFields=${fieldCount}&lookupLines=${lineCount}&lookupKind=${kind}`);
        await page.waitForFunction(() => window.lookupTiming?.readyMs > 0); await expect(page.locator('form [role="alert"]')).toHaveCount(0);
        const input = page.locator(`#${kind}-custom-field-${fieldIds[0]}`); await input.click();
        await page.waitForFunction(() => window.lookupTiming?.menu?.frameMs > 0);
        await input.fill(`Choice ${lineCount - 1} `); await page.waitForFunction(() => window.lookupTiming?.search?.frameMs > 0);
        const sample = await page.evaluate(() => ({ readyMs: window.lookupTiming.readyMs, menuMs: window.lookupTiming.menu.frameMs, searchMs: window.lookupTiming.search.frameMs }));
        if (index) entry.samples.push(sample); else entry.warmup = sample;
        await writeFile('.local/master-lookup-options-browser-performance.json', JSON.stringify(report, null, 2) + '\n');
      }
      entry.metrics = Object.fromEntries(Object.keys(entry.budgets).map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
      entry.passed = Object.entries(entry.budgets).every(([key, budget]) => entry.metrics[key] <= budget);
      console.log(JSON.stringify({ kind, fieldCount, sourceCount, lineCount, budgets: entry.budgets, ...entry.metrics, passed: entry.passed }));
    }
    expect(report.cases).toHaveLength(6); report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/master-lookup-options-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
