import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadWorkflowEditor } from '../../src/workflows/editor.js';

const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('workflow graph loading and browser rendering meet the declared synthetic 1/100/1000-edge budgets', async ({ page, browser }) => {
  const owner = ownerPool();
  const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version, chrome: browser.version(),
    conditions: 'Local PostgreSQL with application RLS, production Next build and actual Chrome. Dense synthetic graphs with up to eight ports per node and all typed detail families. One warm-up and five measured runs per size. Service reads, serialization and browser loads run sequentially. Browser time starts at definition HTTP response end and includes JSON parsing, React mount, font readiness and two frames. Source latency, graph editing and rerender responsiveness are not measured.', cases: [] };
  try {
    report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
    const account = await createAccount(owner, { permissions: ['workflows.manage'] });
    const session = await signIn({ identifier: account.username, password: account.password });
    const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
    await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/me$/);
    // Browser-only instrumentation; it does not alter application state or requests.
    await page.addInitScript(() => {
      const observe = new MutationObserver(() => {
        const canvas = document.querySelector('[aria-label="Workflow canvas"]');
        if (!canvas?.querySelector('.workflow-node')) return;
        observe.disconnect(); const domReady = performance.now();
        const committedNodes = canvas.querySelectorAll('.workflow-node').length;
        const committedConnections = canvas.querySelectorAll('.workflow-line').length;
        document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__syntheticWorkflowTiming = { domReady, ready: performance.now(), committedNodes, committedConnections };
        })));
      });
      observe.observe(document, { childList: true, subtree: true });
    });
    for (const [edges, serviceBudgetMs, browserBudgetMs] of [[1, 100, 250], [100, 500, 1000], [1000, 2500, 5000]]) {
      const setupAt = performance.now();
      const graph = await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges, roleId: account.roleId }));
      const entry = { edges, nodes: edges + 1, setupMs: performance.now() - setupAt, serviceBudgetMs, browserBudgetMs, samples: [] };
      report.cases.push(entry);
      for (let iteration = 0; iteration < 6; iteration++) {
        let queries = 0; let databaseMs = 0; let serviceMs;
        const authenticatedAt = performance.now();
        const definition = await work(async (client, identity) => {
          const observed = { async query(...args) { queries++; const at = performance.now();
            try { return await client.query(...args); } finally { databaseMs += performance.now() - at; }
          } };
          const at = performance.now(); const result = await loadWorkflowEditor(observed, identity, graph.workflowId);
          serviceMs = performance.now() - at; return result;
        }, true);
        const authenticatedMs = performance.now() - authenticatedAt; const serializeAt = performance.now();
        const serialized = JSON.stringify(definition); const serializationMs = performance.now() - serializeAt;
        const bytes = Buffer.byteLength(serialized);
        expect(definition.states).toHaveLength(edges + 1); expect(definition.transitions).toHaveLength(edges);
        expect(queries).toBe(10); expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
        await page.goto(`/workflow_management/${graph.workflowId}`);
        await expect(page.locator('.workflow-node')).toHaveCount(edges + 1);
        await expect(page.locator('.workflow-line')).toHaveCount(edges);
        await page.waitForFunction(() => Boolean(window.__syntheticWorkflowTiming));
        const browserMetrics = await page.evaluate(() => {
          const resource = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname.endsWith('/definition'));
          if (!resource) throw new Error('The actual graph response was not measured.');
          return { browserMountMs: window.__syntheticWorkflowTiming.ready - resource.responseEnd,
            reactCommitMs: window.__syntheticWorkflowTiming.domReady - resource.responseEnd,
            committedNodes: window.__syntheticWorkflowTiming.committedNodes, committedConnections: window.__syntheticWorkflowTiming.committedConnections,
            responseMs: resource.responseEnd - resource.startTime, encodedBytes: resource.encodedBodySize, decodedBytes: resource.decodedBodySize,
            nodeElements: document.querySelectorAll('.workflow-node').length, portElements: document.querySelectorAll('.workflow-port').length };
        });
        expect(browserMetrics.reactCommitMs).toBeGreaterThanOrEqual(0); expect(browserMetrics.decodedBytes).toBeGreaterThan(0);
        expect(browserMetrics.committedNodes).toBe(edges + 1); expect(browserMetrics.committedConnections).toBe(edges);
        const sample = { queries, databaseMs, serviceMs, assemblyMs: serviceMs - databaseMs, authenticatedMs, serializationMs, bytes, ...browserMetrics };
        if (iteration) entry.samples.push(sample);
        console.log(JSON.stringify({ edges, iteration, ...sample }));
      }
      entry.metrics = Object.fromEntries(Object.keys(entry.samples[0]).map((key) => [key,
        ['queries', 'bytes', 'encodedBytes', 'decodedBytes', 'nodeElements', 'portElements', 'committedNodes', 'committedConnections'].includes(key)
          ? Math.max(...entry.samples.map((sample) => sample[key])) : p95(entry.samples.map((sample) => sample[key]))]));
      await writeFile('.local/workflow-screen-performance.json', JSON.stringify(report, null, 2) + '\n');
      expect(entry.metrics.serviceMs).toBeLessThanOrEqual(serviceBudgetMs);
      expect(entry.metrics.browserMountMs).toBeLessThanOrEqual(browserBudgetMs);
    }
    report.status = 'passed';
  } finally {
    report.finishedAt = new Date().toISOString(); await closePool(); await owner.end();
    await writeFile('.local/workflow-screen-performance.json', JSON.stringify(report, null, 2) + '\n');
  }
});
