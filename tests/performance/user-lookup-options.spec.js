import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { saveUserCustomFields } from '../../src/users/custom-fields.js';
import { updateUserProfile } from '../../src/users/profiles.js';

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
test('complete lookup catalogs have bounded form, menu and search latency with shared and distinct sources', async ({ page, browser }) => {
  expect(process.env.SAMPLEIFY_TEST_DATABASE_NAME).toMatch(/^sampleify_verify_[a-f0-9]{32}$/);
  expect(JSON.parse(await readFile('.next/required-server-files.json', 'utf8')).config.reactProductionProfiling).toBe(false);
  const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version, chrome: browser.version(),
    buildId: (await readFile('.next/BUILD_ID', 'utf8')).trim(), databaseName: process.env.SAMPLEIFY_TEST_DATABASE_NAME, cases: [],
    conditions: 'Run alone in ordinary production Chrome with the original tracing settings and nine budgets.100/500 lookup fields share one10000-choice catalog; a third100-field case shares ten1000-choice catalogs.160-character field/choice labels,80-character original IDs,ten captured choices per field and explicit fixture ANALYZE. One warmup/five samples. Readiness spans document navigation through a visible frame containing every custom combobox, current selected label, loaded profile controls and enabled Update, including HTTP/SQL, parsing, catalog preparation and React. Menu time spans actual pointerdown through a populated visible menu frame. Large lookup menus render measured visible rows: the observer verifies full filtered-set positions/size and the complete source-wide bulk count instead of requiring10000DOM nodes. Search spans the input event through a visible frame containing exactly the last matching option. Setup/login/assertion polling excluded. Independent functional coverage verifies10000-choice End/reopen/resize, accessibility, full-catalog filtered bulk behavior and the existing500-item draft rejection. Full-catalog bulk actions remain subject to the existing500-item draft/capture and5000-total capture bounds; this benchmark does not establish arbitrary combined maximums.' };
  await page.addInitScript(() => {
    const query = new URL(location.href).searchParams; const count = Number(query.get('lookupFields')); const lines = Number(query.get('lookupLines'));
    if (!count) return;
    window.lookupTiming = {};
    const custom = element => element instanceof HTMLInputElement && element.id.startsWith('user-custom-field-');
    function ready() {
      const inputs = document.querySelectorAll('input[role="combobox"][id^="user-custom-field-"]'); const submit = document.querySelector('button[type="submit"]');
      if (inputs.length === count && inputs[0].closest('.smplfy-form-field').textContent.includes('Choice 0 ')
        && inputs[count - 1].closest('.smplfy-form-field').textContent.includes('Choice 0 ') && submit && !submit.disabled
        && !document.querySelector('.user-reference-field[aria-busy="true"]') && inputs[0].getBoundingClientRect().width > 0) {
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
    for (const path of ['src/components/users/UserForm.jsx', 'src/components/users/UserCustomFields.jsx', 'src/components/masters/MasterCustomFields.jsx',
      'src/components/ui/SearchableSelect.jsx', 'src/components/ui/WindowedSelectMenuList.jsx', 'src/components/ui/selectUtils.js', 'package.json', 'package-lock.json',
      'src/users/custom-field-lookup-client.js', 'src/users/custom-fields.js',
      'src/app/api/users/custom-fields/lookup-options/route.js']) {
      report.files.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    }
    for (const [fieldCount, sourceCount, lineCount] of [[100, 1, 10000], [500, 1, 10000], [100, 10, 1000]]) {
      const setup = performance.now(); const author = await createAccount(owner, { permissions: ['masters.manage'] });
      const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage'] });
      const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] });
      const authorSession = await signIn({ identifier: author.username, password: author.password }); const session = await signIn({ identifier: manager.username, password: manager.password });
      const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Lookup performance laboratory')", [author.organizationId, lab]);
      await withSession(session.token, (c, i) => updateUserProfile(c, i, person.userId, { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab }));
      const sourceIds = []; const lines = Array.from({ length: lineCount }, (_, index) => ({ id: `original_${index}`.padEnd(80, 'v'), label: `Choice ${index} `.padEnd(160, 'l') }));
      for (let index = 0; index < sourceCount; index++) {
        const id = randomUUID(); sourceIds.push(id);
        await withSession(authorSession.token, (c, i) => saveLookupSourceObservation(c, i, { id, revision: 0, requestId: randomUUID(),
          sourceId: 'Original-browser-' + randomUUID(), name: 'Browser source', lines }));
      }
      const fieldIds = Array.from({ length: fieldCount }, () => randomUUID());
      await withSession(authorSession.token, (c, i) => c.query(`INSERT INTO custom_field_definitions
        (organization_id,id,key,label,associated_with,field_type,allows_multiple,lookup_source_id,save_request_id,display_order)
        SELECT $1,id,'lookup_'||position,rpad('Lookup '||position,160,'f'),'users','lookup',true,source_id,gen_random_uuid(),position
        FROM unnest($2::uuid[],$3::uuid[]) WITH ORDINALITY AS fields(id,source_id,position)`,
      [i.organization_id, fieldIds, fieldIds.map((_, index) => sourceIds[index % sourceIds.length])]));
      const values = Array.from({ length: 10 }, (_, index) => lines[index * Math.floor(lineCount / 10)].id);
      await withSession(session.token, (c, i) => saveUserCustomFields(c, i, person.userId, { requestId: randomUUID(), revision: 0,
        customFields: fieldIds.map(fieldId => ({ fieldId, fieldRevision: 1, value: values })) }));
      const analyze = performance.now(); await owner.query('ANALYZE users,memberships,user_profiles,user_profile_versions,custom_field_definitions,custom_field_versions,custom_field_lookup_sources,custom_field_lookup_versions,custom_field_lookup_lines,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');
      const entry = { fieldCount, sourceCount, lineCount, organizationId: author.organizationId, subjectUserId: person.userId, fieldIds, sourceIds,
        setupMs: performance.now() - setup, analyzeMs: performance.now() - analyze,
        budgets: { readyMs: fieldCount === 100 ? 1000 : 2500, menuMs: 500, searchMs: fieldCount === 100 ? 150 : 250 }, samples: [] };
      report.cases.push(entry);
      await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(manager.username);
      await page.getByLabel('Password', { exact: true }).fill(manager.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      for (let index = 0; index < 6; index++) {
        await page.goto(`/user_management/${person.userId}/edit?lookupFields=${fieldCount}&lookupLines=${lineCount}`);
        await page.waitForFunction(() => window.lookupTiming?.readyMs > 0); await expect(page.locator('form [role="alert"]')).toHaveCount(0);
        const input = page.locator(`#user-custom-field-${fieldIds[0]}`); await input.click();
        await page.waitForFunction(() => window.lookupTiming?.menu?.frameMs > 0);
        await input.fill(`Choice ${lineCount - 1} `); await page.waitForFunction(() => window.lookupTiming?.search?.frameMs > 0);
        const sample = await page.evaluate(() => ({ readyMs: window.lookupTiming.readyMs, menuMs: window.lookupTiming.menu.frameMs, searchMs: window.lookupTiming.search.frameMs }));
        if (index) entry.samples.push(sample); else entry.warmup = sample;
        await writeFile('.local/user-lookup-options-browser-performance.json', JSON.stringify(report, null, 2) + '\n');
      }
      entry.metrics = Object.fromEntries(Object.keys(entry.budgets).map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
      entry.passed = Object.entries(entry.budgets).every(([key, budget]) => entry.metrics[key] <= budget);
      console.log(JSON.stringify({ fieldCount, sourceCount, lineCount, budgets: entry.budgets, ...entry.metrics, passed: entry.passed }));
    }
    report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-lookup-options-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
