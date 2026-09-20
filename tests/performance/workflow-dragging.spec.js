import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { cloneWorkflowDraft } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';

const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('node dragging meets declared frame and persistence budgets with small and large graphs', async ({ page, browser }) => {
  const owner = ownerPool();
  const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version, chrome: browser.version(),
    conditions: 'Production Next, local PostgreSQL, actual Chrome with normal trace capture; run alone. One warm-up and five measured draft moves per graph, six pointer events per move. Frame timing starts in each actual pointermove event and ends at the first animation frame where the node has the requested position; firstFrameMs records the earlier frame separately. Each event must render before the driver sends the next, so intermediate frames cannot be silently coalesced. Persistence timing starts at pointerup and ends at an animation frame after authoritative reload and enabled controls; includes driver/response observation overhead. Initial graph load, fixture creation and scrolling excluded. No first-edit clone, touch-device latency or connection-edit timing claim.', cases: [] };
  try {
    report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
    for (const [edges, frameBudgetMs, saveBudgetMs] of [[1, 50, 500], [100, 50, 1500], [1000, 100, 3000]]) {
      const account = await createAccount(owner, { permissions: ['workflows.manage'] });
      const session = await signIn({ identifier: account.username, password: account.password });
      const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
      const setupAt = performance.now();
      const fixture = await work(async (client, identity) => {
        const published = await createWorkflowCloneFixture(client, identity, { edges, roleId: account.roleId });
        const source = await loadWorkflowDefinition(client, identity, published.versionId);
        const draft = await cloneWorkflowDraft(client, identity, published.versionId);
        return { workflowId: published.workflowId, source, draft, definition: await loadWorkflowDefinition(client, identity, draft.versionId) };
      });
      const entry = { edges, frameBudgetMs, saveBudgetMs, workflowId: fixture.workflowId, versionId: fixture.draft.versionId,
        setupMs: performance.now() - setupAt, samples: [] }; report.cases.push(entry);
      await page.context().clearCookies(); await page.goto('/login');
      await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      await page.goto(`/workflow_management/${fixture.workflowId}?versionId=${fixture.draft.versionId}`);
      await expect(page.locator('.workflow-node')).toHaveCount(edges + 1);
      const selected = page.locator('.workflow-node').last(); let x = fixture.definition.states.at(-1).canvasX; let y = fixture.definition.states.at(-1).canvasY ?? 120;
      await page.evaluate(() => {
        let node; let origin; let start; let shell;
        const point = (event) => { const bounds = shell.getBoundingClientRect(); return {
          x: event.clientX - bounds.left + shell.scrollLeft, y: event.clientY - bounds.top + shell.scrollTop,
        }; };
        window.workflowDragTiming = { active: false, frames: [] };
        document.addEventListener('pointerdown', (event) => {
          if (!event.target.closest('.workflow-node') || event.target.closest('button, .workflow-port')) return;
          node = event.target.closest('.workflow-node'); shell = node.closest('.workflow-canvas-shell');
          origin = { x: Number.parseFloat(node.style.left), y: Number.parseFloat(node.style.top) }; start = point(event);
          window.workflowDragTiming = { active: true, frames: [] };
        }, true);
        window.addEventListener('pointermove', (event) => {
          const timing = window.workflowDragTiming; if (!timing.active) return;
          const current = point(event); const expected = {
            x: Math.min(100000, Math.max(8, Math.round(origin.x + current.x - start.x))),
            y: Math.min(100000, Math.max(8, Math.round(origin.y + current.y - start.y))),
          };
          const frame = { at: performance.now(), expected }; timing.frames.push(frame);
          requestAnimationFrame(function rendered() {
            const elapsed = performance.now() - frame.at; frame.firstFrameMs ??= elapsed;
            if (Number.parseFloat(node.style.left) === expected.x && Number.parseFloat(node.style.top) === expected.y) frame.ms = elapsed;
            else if (elapsed < 3000) requestAnimationFrame(rendered);
          });
        }, true);
        window.addEventListener('pointerup', () => { window.workflowDragTiming.active = false; window.workflowDragTiming.upAt = performance.now(); }, true);
      });
      let traffic = [];
      const observe = (response) => {
        if (!new URL(response.url()).pathname.startsWith(`/api/workflows/${fixture.workflowId}/`)) return;
        traffic.push((async () => ({ path: new URL(response.url()).pathname, method: response.request().method(), status: response.status(),
          inputBytes: Buffer.byteLength(response.request().postData() ?? ''), responseBytes: (await response.body()).length }))());
      };
      page.on('response', observe);
      for (let iteration = 0; iteration < 6; iteration++) {
        await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toBeEnabled();
        const title = selected.locator('.workflow-node__title'); await title.scrollIntoViewIfNeeded(); const box = await title.boundingBox();
        const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 }; const dx = iteration % 2 ? -30 : 40; const dy = iteration % 2 ? -10 : 20;
        await page.mouse.move(pointer.x, pointer.y); traffic = []; await page.mouse.down();
        for (let step = 1; step <= 6; step++) {
          await page.mouse.move(pointer.x + dx * step / 6, pointer.y + dy * step / 6);
          await page.waitForFunction((count) => window.workflowDragTiming.frames.length === count
            && Number.isFinite(window.workflowDragTiming.frames[count - 1].ms), step);
        }
        x = Math.max(8, x + dx); y = Math.max(8, y + dy);
        await expect(selected).toHaveCSS('left', `${x}px`); await expect(selected).toHaveCSS('top', `${y}px`);
        expect(traffic).toHaveLength(0); await page.mouse.up();
        await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toBeEnabled();
        await expect(selected).toHaveCSS('left', `${x}px`); await expect(selected).toHaveCSS('top', `${y}px`);
        const timing = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve({
          saveMs: performance.now() - window.workflowDragTiming.upAt, frames: window.workflowDragTiming.frames.map((frame) => frame.ms),
          firstFrames: window.workflowDragTiming.frames.map((frame) => frame.firstFrameMs),
        }))));
        const requests = await Promise.all(traffic); expect(requests.every((request) => request.status === 200)).toBe(true);
        const commands = requests.filter((request) => request.path.endsWith('/commands')); const definitions = requests.filter((request) => request.path.endsWith('/definition'));
        expect(commands).toHaveLength(1); expect(definitions).toHaveLength(1); expect(requests).toHaveLength(2);
        expect(commands[0].inputBytes).toBeLessThanOrEqual(1024); expect(timing.frames).toHaveLength(6); expect(timing.frames.every(Number.isFinite)).toBe(true);
        const sample = { ...timing, commandBytes: commands[0].inputBytes, definitionBytes: definitions[0].responseBytes, requests };
        if (iteration === 0) entry.warmup = sample; else entry.samples.push(sample);
      }
      page.off('response', observe);
      entry.metrics = { frameMs: p95(entry.samples.flatMap((sample) => sample.frames)), saveMs: p95(entry.samples.map((sample) => sample.saveMs)),
        commandBytes: Math.max(...entry.samples.map((sample) => sample.commandBytes)), definitionBytes: Math.max(...entry.samples.map((sample) => sample.definitionBytes)) };
      const current = await work((client, identity) => loadWorkflowDefinition(client, identity, fixture.draft.versionId), true);
      const expected = workflowGraphValues(fixture.definition); expected.states.at(-1).canvasX = x; expected.states.at(-1).canvasY = y;
      expect(workflowGraphValues(current)).toEqual(expected); expect(current.version.revision).toBe(fixture.definition.version.revision + 6);
      expect(workflowGraphValues(await work((client, identity) => loadWorkflowDefinition(client, identity, fixture.source.version.id), true))).toEqual(workflowGraphValues(fixture.source));
      console.log(JSON.stringify({ edges, ...entry.metrics }));
      expect(entry.metrics.frameMs).toBeLessThanOrEqual(frameBudgetMs); expect(entry.metrics.saveMs).toBeLessThanOrEqual(saveBudgetMs);
    }
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally { await writeFile('.local/workflow-drag-performance.json', `${JSON.stringify(report, null, 2)}\n`); await closePool(); await owner.end(); }
});
