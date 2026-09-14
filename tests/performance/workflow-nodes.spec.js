import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { cloneWorkflowDraft, patchWorkflowState } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';

const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('node dialogs and draft edits meet declared small, large and complex browser budgets', async ({ page, browser }) => {
  const owner = ownerPool();
  const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version, chrome: browser.version(),
    conditions: 'Production Next, local PostgreSQL and real Chrome; run alone with normal trace capture. One warm-up and five measured draft-name edits per graph. Input timing schedules the next animation frame inside the input event; inputCompletionMs separately records the later test-driver return. Modal/save timing includes automation completion checks and response-body observation overhead. Initial graph load, fixture setup and scrolling are outside these timings. No first-edit clone, drag or connection-edit performance claim.', cases: [] };
  try {
    report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
    for (const [edges, selectedRoles, modalBudgetMs, inputBudgetMs, saveBudgetMs] of [[1, 1, 250, 50, 500], [100, 1, 500, 50, 1500], [1000, 1, 1000, 100, 3000], [1000, 500, 1000, 100, 3000]]) {
      const manager = await createAccount(owner, { permissions: ['workflows.manage'] });
      const session = await signIn({ identifier: manager.username, password: manager.password });
      const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
      const roles = selectedRoles === 1 ? [manager.roleId] : (await owner.query(`INSERT INTO roles(organization_id,id,name)
        SELECT $1,gen_random_uuid(),'Node benchmark role '||lpad(n::text,4,'0') FROM generate_series(1,500) n RETURNING id`, [manager.organizationId])).rows.map((row) => row.id);
      const setupAt = performance.now();
      const fixture = await work(async (client, identity) => {
        const published = await createWorkflowCloneFixture(client, identity, { edges, roleId: manager.roleId });
        const source = await loadWorkflowDefinition(client, identity, published.versionId);
        const draft = await cloneWorkflowDraft(client, identity, published.versionId);
        let definition = await loadWorkflowDefinition(client, identity, draft.versionId);
        if (selectedRoles > 1) {
          await patchWorkflowState(client, identity, draft.versionId, draft.revision, definition.states.at(-1).id, { accessRoleIds: roles });
          definition = await loadWorkflowDefinition(client, identity, draft.versionId);
        }
        return { workflowId: published.workflowId, source, draft, definition };
      });
      const entry = { edges, selectedRoles, workflowId: fixture.workflowId, versionId: fixture.draft.versionId,
        modalBudgetMs, inputBudgetMs, saveBudgetMs, setupMs: performance.now() - setupAt, samples: [] }; report.cases.push(entry);
      await page.context().clearCookies(); await page.goto('/login');
      await page.getByLabel('Username', { exact: true }).fill(manager.username); await page.getByLabel('Password', { exact: true }).fill(manager.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      await page.goto(`/workflow_management/${fixture.workflowId}?versionId=${fixture.draft.versionId}`);
      await expect(page.locator('.workflow-node')).toHaveCount(edges + 1);
      let name = fixture.definition.states.at(-1).name;
      await page.getByRole('button', { name: `Edit ${name}`, exact: true }).scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        window.nodeEditorTiming = {};
        document.addEventListener('click', (event) => {
          const button = event.target.closest('button');
          if (button?.getAttribute('aria-label')?.startsWith('Edit ')) window.nodeEditorTiming.openAt = performance.now();
          if (button?.getAttribute('form') === 'workflow-node-form') window.nodeEditorTiming.saveAt = performance.now();
        }, true);
        document.addEventListener('input', (event) => {
          if (event.target.form?.id !== 'workflow-node-form') return;
          const input = { at: performance.now() }; window.nodeEditorTiming.input = input;
          requestAnimationFrame(() => { input.frameMs = performance.now() - input.at; });
        }, true);
      });
      let traffic = [];
      const observe = (response) => {
        const url = new URL(response.url());
        if (!url.pathname.startsWith(`/api/workflows/${fixture.workflowId}/`) && !url.pathname.startsWith('/api/workflows/lookups/')) return;
        traffic.push((async () => {
          const body = await response.body(); const request = response.request();
          return { path: url.pathname, method: request.method(), status: response.status(), responseBytes: body.length,
            inputBytes: Buffer.byteLength(request.postData() ?? ''), httpMs: request.timing().responseEnd };
        })());
      };
      page.on('response', observe);
      for (let iteration = 0; iteration < 6; iteration++) {
        traffic = [];
        await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Node Details', exact: true });
        await expect(dialog.getByRole('combobox', { name: 'Access Roles', exact: true })).toBeEnabled();
        const modalMs = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now() - window.nodeEditorTiming.openAt))));
        name = `Measured node ${edges} roles ${selectedRoles} edit ${iteration}`;
        await dialog.getByRole('textbox', { name: /^Name/ }).fill(name);
        const inputCompletionMs = await page.evaluate(() => performance.now() - window.nodeEditorTiming.input.at);
        await page.waitForFunction(() => Number.isFinite(window.nodeEditorTiming.input?.frameMs));
        const inputMs = await page.evaluate(() => window.nodeEditorTiming.input.frameMs);
        await dialog.getByRole('button', { name: 'Save Node', exact: true }).click(); await expect(dialog).toHaveCount(0);
        await expect(page.getByRole('button', { name: `Edit ${name}`, exact: true })).toBeVisible();
        const saveMs = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now() - window.nodeEditorTiming.saveAt))));
        const requests = await Promise.all(traffic);
        expect(requests.every((request) => request.status === 200)).toBe(true);
        const commands = requests.filter((request) => request.path.endsWith('/commands'));
        const definitions = requests.filter((request) => request.path.endsWith('/definition'));
        const references = requests.filter((request) => request.path.includes('/lookups/'));
        expect(commands).toHaveLength(1); expect(definitions).toHaveLength(1); expect(references).toHaveLength(2);
        expect(commands[0].inputBytes).toBeLessThanOrEqual(1024);
        const sample = { modalMs, inputMs, inputCompletionMs, saveMs, commandBytes: commands[0].inputBytes, definitionBytes: definitions[0].responseBytes,
          referenceBytes: references.reduce((sum, request) => sum + request.responseBytes, 0), aggregateHttpMs: requests.reduce((sum, request) => sum + request.httpMs, 0), requests };
        if (iteration === 0) entry.warmup = sample; else entry.samples.push(sample);
      }
      page.off('response', observe);
      entry.metrics = Object.fromEntries(['modalMs', 'inputMs', 'inputCompletionMs', 'saveMs', 'commandBytes', 'definitionBytes', 'referenceBytes', 'aggregateHttpMs'].map((metric) => [metric, p95(entry.samples.map((sample) => sample[metric]))]));
      const current = await work((client, identity) => loadWorkflowDefinition(client, identity, fixture.draft.versionId), true);
      const expected = workflowGraphValues(fixture.definition); expected.states.at(-1).name = name;
      expect(workflowGraphValues(current)).toEqual(expected);
      expect(current.states.at(-1).capabilityRoles.filter((role) => role.capability === 'view')).toHaveLength(selectedRoles);
      const source = await work((client, identity) => loadWorkflowDefinition(client, identity, fixture.source.version.id), true);
      expect(workflowGraphValues(source)).toEqual(workflowGraphValues(fixture.source));
      expect(entry.metrics.modalMs).toBeLessThanOrEqual(modalBudgetMs);
      expect(entry.metrics.inputMs).toBeLessThanOrEqual(inputBudgetMs);
      expect(entry.metrics.saveMs).toBeLessThanOrEqual(saveBudgetMs);
      console.log(JSON.stringify({ edges, selectedRoles, ...entry.metrics }));
      if (selectedRoles === 500) {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: '.local/m04-workflow-node-mobile-verified.png', fullPage: true, animations: 'disabled' });
        await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Node Details', exact: true });
        await expect(dialog.getByRole('combobox', { name: 'Access Roles', exact: true })).toBeEnabled();
        await dialog.getByRole('combobox', { name: 'Access Roles', exact: true }).scrollIntoViewIfNeeded();
        await dialog.screenshot({ path: '.local/m04-workflow-node-mobile-permissions.png', animations: 'disabled' });
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
    }
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile('.local/workflow-node-performance.json', JSON.stringify(report, null, 2) + '\n'); await closePool(); await owner.end(); }
});
