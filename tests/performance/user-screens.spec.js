import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { randomUUID } from 'node:crypto';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { updateUserProfile } from '../../src/users/profiles.js';

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
test('user editors retain bounded visible navigation, input and save performance with 1 and 500 assigned roles', async ({ page, browser }) => {
  const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version, chrome: browser.version(),
    conditions: 'Production Next and real Chrome; run alone with standard tracing. One warmup and five samples per case. Navigate starts at document navigation and ends at an animation frame with fields, selected labels and catalogs ready. Input starts at the actual contact input event and ends at its first visible frame. Save starts at Update click and ends when the authoritative filtered list is painted. Hidden role descriptions are 200 characters. Setup, login and independent saved-value assertions are excluded; normal HTTP, React and transaction work are included.', cases: [] };
  try {
    for (const [roleCount, navigationBudgetMs, inputBudgetMs, saveBudgetMs] of [[1, 1200, 50, 750], [500, 1800, 100, 1250]]) {
      const admin = await createAccount(owner, { permissions: ['users.manage'] }); const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: [] }); const org = admin.organizationId;
      await owner.query("UPDATE roles SET name='Selected benchmark role',description=repeat('d',200) WHERE organization_id=$1 AND id=$2", [org, person.roleId]);
      if (roleCount > 1) {
        const extra = (await owner.query("INSERT INTO roles(organization_id,id,name,description) SELECT $1,gen_random_uuid(),'Hidden benchmark role '||n,repeat('d',200) FROM generate_series(1,499) n RETURNING id", [org])).rows.map(row => row.id);
        await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) SELECT $1,$2,unnest($3::uuid[])', [org, person.userId, extra]);
      }
      const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Selected benchmark laboratory')", [org, lab]);
      const session = await signIn({ identifier: admin.username, password: admin.password });
      await withSession(session.token, (client, identity) => updateUserProfile(client, identity, person.userId, { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab }));
      await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(admin.username);
      await page.getByLabel('Password', { exact: true }).fill(admin.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      const entry = { roleCount, navigationBudgetMs, inputBudgetMs, saveBudgetMs, samples: [] }; report.cases.push(entry);
      const returnPath = `/user_management?search=${person.username}`; const url = `/user_management/${person.userId}/edit?from=${encodeURIComponent(returnPath)}`;
      await page.addInitScript(() => {
        if (window.userScreenTiming) return;
        window.userScreenTiming = {};
        document.addEventListener('input', event => {
          if (event.target.name !== 'phone') return;
          const field = event.target; const expected = field.value; const input = { at: performance.now() }; window.userScreenTiming.input = input;
          requestAnimationFrame(function painted() {
            if (field.value === expected && field.getBoundingClientRect().width > 0) input.frameMs = performance.now() - input.at;
            else if (performance.now() - input.at < 3000) requestAnimationFrame(painted);
          });
        }, true);
        document.addEventListener('click', event => {
          const button = event.target.closest('button[type="submit"]');
          if (button?.form?.querySelector('[name="phone"]')) window.userScreenTiming.saveAt = performance.now();
        }, true);
      });
      for (let index = 0; index < 6; index++) {
        const relevant = [];
        const observe = response => { if (/\/api\/users\/(?:profile-references|[^/]+\/form)(?:\?|$)/.test(response.url())) relevant.push(response.finished()); };
        page.on('response', observe);
        await page.goto(url); await expect(page.getByLabel('Contact Number', { exact: true })).toBeVisible();
        await expect(page.getByText('Selected benchmark role', { exact: true })).toBeVisible(); await expect(page.getByText('Selected benchmark laboratory', { exact: true })).toBeVisible();
        await expect(page.locator('.user-reference-field[aria-busy="true"]')).toHaveCount(0);
        await expect(page.locator('form [role="alert"]')).toHaveCount(0);
        await expect.poll(() => relevant.length).toBe(7); await Promise.all(relevant); page.off('response', observe);
        const navigationMs = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(performance.now()))));
        const phone = `Measured contact ${roleCount}-${index}`; await page.getByLabel('Contact Number', { exact: true }).fill(phone);
        await expect.poll(() => page.evaluate(() => window.userScreenTiming.input?.frameMs)).toBeGreaterThan(0);
        const inputMs = await page.evaluate(() => window.userScreenTiming.input.frameMs);
        await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/user_management\\?search=${person.username}$`));
        await expect(page.locator('.user-directory-card')).toHaveCount(1);
        const saveMs = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(performance.now() - window.userScreenTiming.saveAt))));
        expect(Number.isFinite(saveMs)).toBe(true);
        const stored = await owner.query('SELECT phone FROM user_profiles WHERE organization_id=$1 AND user_id=$2', [org, person.userId]); expect(stored.rows[0].phone).toBe(phone);
        const sample = { navigationMs, inputMs, saveMs, editorRequests: relevant.length };
        if (index) entry.samples.push(sample); else entry.warmup = sample;
      }
      entry.metrics = Object.fromEntries(['navigationMs', 'inputMs', 'saveMs', 'editorRequests'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
      entry.passed = entry.metrics.navigationMs <= navigationBudgetMs && entry.metrics.inputMs <= inputBudgetMs && entry.metrics.saveMs <= saveBudgetMs;
      console.log(JSON.stringify({ roleCount, ...entry.metrics, passed: entry.passed }));
    }
    report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-screen-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
