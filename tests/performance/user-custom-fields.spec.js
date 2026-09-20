import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { updateUserProfile } from '../../src/users/profiles.js';
import { saveUserCustomFields } from '../../src/users/custom-fields.js';

const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
test('manual user fields have bounded initial render and typing latency at10,100 and500 captured fields', async ({ page, browser }) => {
  const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version, chrome: browser.version(), cases: [],
    conditions: 'Run alone using a PROFILE_REACT=1 production build and real Chrome. Actual typed definitions/captures,160-character labels and80-character saved text, explicit fixture ANALYZE. One warmup/five samples. Readiness spans document navigation through a visible frame with all expected custom inputs, saved values, profile catalogs and enabled Update; includes HTTP, API/SQL, parsing, state initialization and React. Input spans the actual input event through a subsequent React update and frame. Setup/login/assertions excluded. This does not measure generation, lookup, file transfer or arbitrary mixed-type layouts.' };
  await page.addInitScript(() => {
    const count = Number(new URL(location.href).searchParams.get('benchFieldCount'));
    if (!count) return;
    window.userFieldTiming = {};
    function ready() {
      const inputs = document.querySelectorAll('input[name^="user-custom-field-"]'); const submit = document.querySelector('button[type="submit"]');
      if (inputs.length === count && inputs[count - 1].value.startsWith('Initial ') && submit && !submit.disabled
          && !document.querySelector('.user-reference-field[aria-busy="true"]') && inputs[0].getBoundingClientRect().width > 0) {
        requestAnimationFrame(() => { window.userFieldTiming.readyMs = performance.now(); });
      } else requestAnimationFrame(ready);
    }
    requestAnimationFrame(ready);
    document.addEventListener('input', event => {
      if (!event.target.name?.startsWith('user-custom-field-')) return;
      const field = event.target; const expected = field.value; const sample = { at: performance.now() }; window.userFieldTiming.input = sample;
      requestAnimationFrame(function painted() {
        const updates = performance.getEntriesByName('user-fields:react-update').filter(entry => entry.startTime >= sample.at);
        if (updates.length && field.value === expected && field.getBoundingClientRect().width > 0) {
          sample.frameMs = performance.now() - sample.at; sample.reactMs = Math.max(...updates.map(entry => entry.duration));
        } else if (performance.now() - sample.at < 5000) requestAnimationFrame(painted);
      });
    }, true);
  });
  try {
    for (const [count, readyBudgetMs, inputBudgetMs] of [[10, 500, 100], [100, 1000, 150], [500, 2500, 250]]) {
      const setupAt = performance.now(); const author = await createAccount(owner, { permissions: ['masters.manage'] });
      const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage'] });
      const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] });
      const authorSession = await signIn({ identifier: author.username, password: author.password }); const session = await signIn({ identifier: manager.username, password: manager.password });
      const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Field benchmark laboratory')", [author.organizationId, lab]);
      await withSession(session.token, (client, identity) => updateUserProfile(client, identity, person.userId, { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab }));
      const fields = [];
      for (let n = 0; n < count; n++) fields.push(await withSession(authorSession.token, (client, identity) => saveCustomField(client, identity,
        { id: randomUUID(), requestId: randomUUID(), revision: 0, key: `measured_${n}`, label: `Measured field ${String(n).padStart(3, '0')} `.padEnd(160, 'x'), fieldType: 'text', associatedWith: 'users', displayOrder: n })));
      await withSession(session.token, (client, identity) => saveUserCustomFields(client, identity, person.userId, { requestId: randomUUID(), revision: 0,
        customFields: fields.map((field, n) => ({ fieldId: field.id, fieldRevision: 1, value: `Initial ${n} `.padEnd(80, 'x') })) }));
      const analyzeAt = performance.now();
      await owner.query('ANALYZE users,memberships,user_profiles,roles,laboratories,custom_field_definitions,custom_field_versions,user_field_value_versions,user_version_custom_fields,user_version_custom_field_values');
      const entry = { count, readyBudgetMs, inputBudgetMs, fixture: { organizationId: author.organizationId, userId: person.userId, labelCharacters: 160, valueCharacters: 80, setupMs: performance.now() - setupAt, analyzeMs: performance.now() - analyzeAt }, samples: [] }; report.cases.push(entry);
      await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(manager.username);
      await page.getByLabel('Password', { exact: true }).fill(manager.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      for (let index = 0; index < 6; index++) {
        await page.goto(`/user_management/${person.userId}/edit?benchFieldCount=${count}`);
        await page.waitForFunction(() => window.userFieldTiming?.readyMs > 0);
        const readyMs = await page.evaluate(() => window.userFieldTiming.readyMs);
        await expect(page.locator('form [role="alert"]')).toHaveCount(0);
        const input = page.locator(`#user-custom-field-${fields[0].id}`); const value = `Measured edit ${count}-${index}`;
        await input.fill(value); await page.waitForFunction(() => window.userFieldTiming?.input?.frameMs > 0);
        await expect(input).toHaveValue(value);
        const sample = await page.evaluate(readyMs => ({ readyMs, inputMs: window.userFieldTiming.input.frameMs, reactMs: window.userFieldTiming.input.reactMs }), readyMs);
        if (index) entry.samples.push(sample); else entry.warmup = sample;
      }
      entry.metrics = Object.fromEntries(['readyMs', 'inputMs', 'reactMs'].map(key => [key, p95(entry.samples.map(sample => sample[key]))]));
      entry.passed = entry.metrics.readyMs <= readyBudgetMs && entry.metrics.inputMs <= inputBudgetMs;
      console.log(JSON.stringify({ count, readyBudgetMs, inputBudgetMs, ...entry.metrics, passed: entry.passed }));
    }
    report.status = report.cases.every(entry => entry.passed) ? 'passed' : 'failed'; expect(report.status).toBe('passed');
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/user-custom-field-browser-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
