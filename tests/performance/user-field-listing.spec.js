import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveUserCustomFields } from '../../src/users/custom-fields.js';

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
test('user listings render25 captured rows and accept filter input at10,100 and500 custom columns', async ({ page, browser }) => {
  const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version, chrome: browser.version(), cases: [],
    conditions: 'Run alone using PROFILE_REACT=1 production Next and real Chrome.25 native captured subjects,10/100/500 text columns,160-character labels,80-character values, explicit ANALYZE. One warmup/five samples. Readiness spans document navigation through a frame containing all25 actual rows and custom cells; includes HTTP, SQL, parsing, state initialization and React. Input spans a real filter input event through its next visible frame after the controlled update; applying that filter is independently asserted afterward and excluded from input timing. Setup/login/assertions and opening the filter panel are excluded. This does not measure mixed controls,500 simultaneous filters or arbitrary large result pages.' };
  await page.addInitScript(() => {
    const count = Number(new URL(location.href).searchParams.get('benchListingFields')); if (!count) return;
    window.userListingTiming = {};
    requestAnimationFrame(function ready() {
      const table = document.querySelector('.dt-table'); const rows = table?.querySelectorAll('tbody tr');
      if (table?.querySelectorAll('thead th').length === count + 9 && rows?.length === 25 && !table.querySelector('.dt-skeleton-row')
        && [...rows].every(row => row.cells.length === count + 9 && row.cells[count + 7].textContent.startsWith('Captured '))
        && rows[0].querySelector('.user-directory-card')?.getBoundingClientRect().width > 0) {
        requestAnimationFrame(() => { window.userListingTiming.readyMs = performance.now(); });
      } else requestAnimationFrame(ready);
    });
    document.addEventListener('input', event => {
      if (!event.target.matches('.dt-filter-field input')) return;
      const input = event.target; const expected = input.value; const sample = { at: performance.now() }; window.userListingTiming.input = sample;
      requestAnimationFrame(function painted() {
        if (input.isConnected && input.value === expected && input.getBoundingClientRect().width > 0) sample.frameMs = performance.now() - sample.at;
        else if (performance.now() - sample.at < 5000) requestAnimationFrame(painted);
      });
    }, true);
  });
  try {
    for (const [count, readyBudgetMs, inputBudgetMs] of [[10, 1000, 50], [100, 2000, 100], [500, 5000, 150]]) {
      const setupAt = performance.now(); const author = await createAccount(owner, { permissions: ['masters.manage'] });
      const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage'] });
      const authorSession = await signIn({ identifier: author.username, password: author.password }); const session = await signIn({ identifier: manager.username, password: manager.password });
      const prefix = `BrowserListing-${randomUUID()}`;
      const people = (await owner.query(`INSERT INTO users(id,username,email,display_name)
        SELECT gen_random_uuid(),$1||'-'||n,$1||'-'||n||'@example.invalid',$1||'-'||lpad(n::text,3,'0') FROM generate_series(0,24) n RETURNING id,display_name`, [prefix])).rows.sort((a, b) => a.display_name.localeCompare(b.display_name));
      await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [author.organizationId, people.map(person => person.id)]);
      const fields = []; await withSession(authorSession.token, async (c, i) => {
        for (let n = 0; n < count; n++) fields.push(await saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0,
          key: `listing_${n}`, label: `Measured column ${String(n).padStart(3, '0')} `.padEnd(160, 'x'), fieldType: 'text', associatedWith: 'users', showInList: true, showInFilter: true, displayOrder: n }));
      });
      const captured = (person, n) => `Captured member ${person} field ${n} `.padEnd(80, 'x');
      for (const [index, person] of people.entries()) await withSession(session.token, (c, i) => saveUserCustomFields(c, i, person.id, { requestId: randomUUID(), revision: 0,
        customFields: fields.map((field, n) => ({ fieldId: field.id, fieldRevision: 1, value: captured(index, n) })) }));
      const analyzeAt = performance.now(); await owner.query('ANALYZE users,memberships,custom_field_definitions,custom_field_versions,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');
      const entry = { count, rows: 25, readyBudgetMs, inputBudgetMs, fixture: { organizationId: author.organizationId, setupMs: performance.now() - setupAt, analyzeMs: performance.now() - analyzeAt }, samples: [] }; report.cases.push(entry);
      await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(manager.username);
      await page.getByLabel('Password', { exact: true }).fill(manager.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      for (let index = 0; index < 6; index++) {
        await page.goto('/user_management?' + new URLSearchParams({ search: prefix, pageSize: '25', benchListingFields: String(count) }));
        await page.waitForFunction(() => window.userListingTiming?.readyMs > 0);
        const readyMs = await page.evaluate(() => window.userListingTiming.readyMs);
        await expect(page.locator('.dt-page [role="alert"]')).toHaveCount(0);
        await page.getByRole('button', { name: 'Filters', exact: true }).click();
        const input = page.getByPlaceholder(`Filter ${fields[0].label}`, { exact: true }); const value = captured(7, 0);
        await input.fill(value); await page.waitForFunction(() => window.userListingTiming?.input?.frameMs > 0);
        await expect(input).toHaveValue(value); const sample = { readyMs, inputMs: await page.evaluate(() => window.userListingTiming.input.frameMs) };
        await page.getByRole('button', { name: 'Apply Filters', exact: true }).click();
        await expect(page.locator('.user-directory-card')).toHaveCount(1);
        await expect(page.locator('.user-directory-name')).toHaveAttribute('href', new RegExp(`/user_management/${people[7].id}/`));
        await expect(page.locator('tbody').getByTitle(value, { exact: true })).toBeVisible();
        if (index) entry.samples.push(sample); else entry.warmup = sample;
      }
      entry.metrics = Object.fromEntries(['readyMs', 'inputMs'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
      entry.passed = entry.metrics.readyMs <= readyBudgetMs && entry.metrics.inputMs <= inputBudgetMs;
      console.log(JSON.stringify({ count, readyBudgetMs, inputBudgetMs, ...entry.metrics, passed: entry.passed }));
    }
    report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-field-listing-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
