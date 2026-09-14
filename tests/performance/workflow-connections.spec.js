import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { cloneWorkflowDraft, patchWorkflowTransition } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';

const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('connection dialogs and partial saves meet declared graph and selected-role budgets', async ({ page, browser }) => {
  const owner = ownerPool();
  const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version, chrome: browser.version(),
    conditions: 'Production Next, local PostgreSQL and real Chrome; run alone with normal tracing. One warm-up and five measured CC-email edits. Modal timing starts at Enter on the focused connection path and ends after batched labels and controls are ready. Input timing starts in the actual input event and ends at the first animation frame with its requested value. Save timing starts at the Save Connection click and ends after authoritative graph reload at an animation frame; includes driver checks and response-body observation. Initial graph loading, setup, focus/scrolling, first-edit cloning, touch-device latency and worst-case100-stage/50000-role performance excluded.', cases: [] };
  try {
    report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
    for (const [edges, selectedRoles, modalBudgetMs, inputBudgetMs, saveBudgetMs] of [[1, 1, 250, 50, 500], [100, 1, 500, 50, 1500], [1000, 1, 1000, 100, 3000], [1000, 500, 1000, 100, 3000]]) {
      const account = await createAccount(owner, { permissions: ['workflows.manage'] }); const session = await signIn({ identifier: account.username, password: account.password });
      const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
      const roleIds = selectedRoles === 1 ? [account.roleId] : [account.roleId, ...(await owner.query(`INSERT INTO roles(organization_id,id,name)
        SELECT $1,gen_random_uuid(),'Connection benchmark role '||n FROM generate_series(1,499) n RETURNING id`, [account.organizationId])).rows.map((row) => row.id)];
      const setupAt = performance.now();
      const fixture = await work(async (client, identity) => {
        const published = await createWorkflowCloneFixture(client, identity, { edges, roleId: account.roleId });
        const source = await loadWorkflowDefinition(client, identity, published.versionId); const draft = await cloneWorkflowDraft(client, identity, published.versionId);
        let definition = await loadWorkflowDefinition(client, identity, draft.versionId);
        if (selectedRoles > 1) {
          await patchWorkflowTransition(client, identity, draft.versionId, draft.revision, definition.transitions.at(-1).id,
            { approverStages: [{ stageNumber: 1, roleIds }, { stageNumber: 3, roleIds: [account.roleId] }] });
          definition = await loadWorkflowDefinition(client, identity, draft.versionId);
        }
        return { workflowId: published.workflowId, source, draft, definition };
      });
      const entry = { edges, selectedRoles, workflowId: fixture.workflowId, versionId: fixture.draft.versionId, modalBudgetMs, inputBudgetMs, saveBudgetMs,
        setupMs: performance.now() - setupAt, samples: [] }; report.cases.push(entry);
      await page.context().clearCookies(); await page.goto('/login');
      await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      await page.goto(`/workflow_management/${fixture.workflowId}?versionId=${fixture.draft.versionId}`); await expect(page.locator('.workflow-node')).toHaveCount(edges + 1);
      const edge = fixture.definition.transitions.at(-1); const connection = page.getByRole('button', { name: `Edit connection ${edge.name} (${edge.code})`, exact: true });
      await page.evaluate(() => {
        window.connectionTiming = {};
        document.addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.target.matches('.workflow-line')) window.connectionTiming.openAt = performance.now(); }, true);
        document.addEventListener('click', (event) => { if (event.target.closest('button')?.getAttribute('form') === 'workflow-connection-form') window.connectionTiming.saveAt = performance.now(); }, true);
        document.addEventListener('input', (event) => {
          if (event.target.form?.id !== 'workflow-connection-form') return;
          const input = { at: performance.now() }; const element = event.target; const expected = element.value; window.connectionTiming.input = input;
          requestAnimationFrame(function visible() { const elapsed = performance.now() - input.at;
            if (element.value === expected) input.frameMs = elapsed; else if (elapsed < 3000) requestAnimationFrame(visible); });
        }, true);
      });
      let traffic = [];
      const observe = (response) => {
        const path = new URL(response.url()).pathname;
        if (!path.startsWith(`/api/workflows/${fixture.workflowId}/`) && !path.startsWith('/api/workflows/lookups/') && path !== '/api/workflows/checklists') return;
        traffic.push((async () => ({ path, method: response.request().method(), status: response.status(), responseBytes: (await response.body()).length,
          inputBytes: Buffer.byteLength(response.request().postData() ?? '') }))());
      };
      page.on('response', observe); let email;
      for (let iteration = 0; iteration < 6; iteration++) {
        await connection.scrollIntoViewIfNeeded(); await connection.focus(); traffic = []; await connection.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Assign Approvers', exact: true });
        await expect(dialog.getByRole('combobox', { name: 'Approver Roles', exact: true })).toBeEnabled();
        const modalMs = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now() - window.connectionTiming.openAt))));
        email = `connection-${edges}-${selectedRoles}-${iteration}@example.invalid`;
        await dialog.getByRole('textbox', { name: 'CC Emails', exact: true }).fill(email);
        const inputCompletionMs = await page.evaluate(() => performance.now() - window.connectionTiming.input.at);
        await page.waitForFunction(() => Number.isFinite(window.connectionTiming.input?.frameMs));
        const inputMs = await page.evaluate(() => window.connectionTiming.input.frameMs);
        await dialog.getByRole('button', { name: 'Save Connection', exact: true }).click(); await expect(dialog).toHaveCount(0);
        await expect(connection).toHaveAttribute('aria-disabled', 'false');
        const saveMs = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now() - window.connectionTiming.saveAt))));
        const requests = await Promise.all(traffic); expect(requests.every((request) => request.status === 200)).toBe(true);
        const commands = requests.filter((request) => request.path.endsWith('/commands')); const definitions = requests.filter((request) => request.path.endsWith('/definition'));
        const references = requests.filter((request) => request.path.includes('/lookups/') || request.path.endsWith('/checklists'));
        expect(commands).toHaveLength(1); expect(definitions).toHaveLength(1); expect(references).toHaveLength(2); expect(requests).toHaveLength(4);
        expect(commands[0].inputBytes).toBeLessThanOrEqual(1024);
        const sample = { modalMs, inputMs, inputCompletionMs, saveMs, commandBytes: commands[0].inputBytes, definitionBytes: definitions[0].responseBytes,
          referenceBytes: references.reduce((sum, request) => sum + request.responseBytes, 0), requests };
        if (iteration === 0) entry.warmup = sample; else entry.samples.push(sample);
      }
      page.off('response', observe);
      entry.metrics = Object.fromEntries(['modalMs', 'inputMs', 'inputCompletionMs', 'saveMs', 'commandBytes', 'definitionBytes', 'referenceBytes'].map((metric) => [metric, p95(entry.samples.map((sample) => sample[metric]))]));
      const current = await work((client, identity) => loadWorkflowDefinition(client, identity, fixture.draft.versionId), true);
      const expected = workflowGraphValues(fixture.definition); expected.transitions.at(-1).ccEmails = [email]; expect(workflowGraphValues(current)).toEqual(expected);
      expect(current.transitions.at(-1).approverStages).toEqual(fixture.definition.transitions.at(-1).approverStages);
      expect(workflowGraphValues(await work((client, identity) => loadWorkflowDefinition(client, identity, fixture.source.version.id), true))).toEqual(workflowGraphValues(fixture.source));
      console.log(JSON.stringify({ edges, selectedRoles, ...entry.metrics }));
      expect(entry.metrics.modalMs).toBeLessThanOrEqual(modalBudgetMs); expect(entry.metrics.inputMs).toBeLessThanOrEqual(inputBudgetMs); expect(entry.metrics.saveMs).toBeLessThanOrEqual(saveBudgetMs);
    }
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { await writeFile('.local/workflow-connection-performance.json', `${JSON.stringify(report, null, 2)}\n`); await closePool(); await owner.end(); }
});
