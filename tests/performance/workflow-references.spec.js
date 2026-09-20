import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createTemplate } from '../../src/templates/authoring.js';
import { workflowReferenceOptions } from '../../src/workflows/references.js';

const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('workflow reference lookups meet bounded synthetic catalog and browser parsing budgets', async ({ page, browser }) => {
  const owner = ownerPool();
  const report = { status: 'running', startedAt: new Date().toISOString(), synthetic: true, node: process.version, chrome: browser.version(),
    conditions: 'Local PostgreSQL, actual application authorization, production Next and Chrome. Sequential service and browser requests, one warm-up and five measured samples per family/size. Measures lookup SQL, assembly, serialization and browser fetch/text/JSON parsing. No picker rendering, graph editing or source-relative claim.', cases: [] };
  try {
    report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
    for (const [size, serviceBudgetMs, browserBudgetMs] of [[1, 100, 500], [100, 500, 1000], [1000, 1500, 2500]]) {
      const manager = await createAccount(owner, { permissions: ['workflows.manage'] });
      const author = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['templates.manage'] });
      const session = await signIn({ identifier: manager.username, password: manager.password });
      const authorSession = await signIn({ identifier: author.username, password: author.password });
      const prefix = `Synthetic lookup ${randomUUID()} `;
      // Explicit synthetic label-only roles do not grant permissions.
      const roles = (await owner.query(`INSERT INTO roles(organization_id,id,name)
        SELECT $1,gen_random_uuid(),$2||lpad(n::text,4,'0') FROM generate_series(1,$3::integer) n RETURNING id`,
      [manager.organizationId, prefix, size])).rows.map((row) => row.id);
      const templates = await withSession(authorSession.token, async (client, identity) => {
        const ids = [];
        for (let index = 0; index < size; index++) ids.push((await createTemplate(client, identity,
          { name: prefix + String(index + 1).padStart(4, '0'), kind: 'datasheet' })).templateId);
        return ids;
      }, { csrfToken: authorSession.csrfToken });
      await page.context().clearCookies(); await page.goto('/login');
      await page.getByLabel('Username', { exact: true }).fill(manager.username);
      await page.getByLabel('Password', { exact: true }).fill(manager.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
      const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value;
      for (const [kind, ids] of [['roles', roles], ['templates', templates]]) {
        const input = { search: prefix.trim(), selectedIds: ids.slice(0, 500) };
        const entry = { kind, size, serviceBudgetMs, browserBudgetMs, byteBudget: 256 * 1024, parseBudgetMs: 50, samples: [] };
        report.cases.push(entry);
        for (let iteration = 0; iteration < 6; iteration++) {
          let queries = 0; let databaseMs = 0; let serviceMs;
          const authenticatedAt = performance.now();
          const result = await withSession(session.token, async (client, identity) => {
            const observed = { async query(...args) { queries++; const at = performance.now();
              try { return await client.query(...args); } finally { databaseMs += performance.now() - at; }
            } };
            const at = performance.now(); const value = await workflowReferenceOptions(observed, identity, kind, input);
            serviceMs = performance.now() - at; return value;
          }, { readOnly: true });
          const authenticatedMs = performance.now() - authenticatedAt; const serializeAt = performance.now();
          const serialized = JSON.stringify(result); const serializationMs = performance.now() - serializeAt;
          const bytes = Buffer.byteLength(serialized);
          expect(queries).toBe(2); expect(result.rows).toHaveLength(Math.min(size, 100));
          expect(result.selected).toHaveLength(Math.min(size, 500)); expect(result.hasMore).toBe(size > 100);
          expect(bytes).toBeLessThanOrEqual(entry.byteBudget);
          const browserMetrics = await page.evaluate(async ({ kind, input, csrf }) => {
            const at = performance.now(); const response = await fetch(`/api/workflows/lookups/${kind}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(input),
            });
            const text = await response.text(); const parseAt = performance.now(); const data = JSON.parse(text);
            const finishedAt = performance.now();
            return { status: response.status, browserMs: finishedAt - at, parseMs: finishedAt - parseAt,
              browserBytes: new TextEncoder().encode(text).length, rows: data.rows?.length, selected: data.selected?.length, hasMore: data.hasMore };
          }, { kind, input, csrf });
          expect(browserMetrics.status).toBe(200); expect(browserMetrics.rows).toBe(result.rows.length);
          expect(browserMetrics.selected).toBe(result.selected.length); expect(browserMetrics.hasMore).toBe(result.hasMore);
          expect(browserMetrics.browserBytes).toBe(bytes);
          const sample = { queries, databaseMs, serviceMs, assemblyMs: serviceMs - databaseMs, authenticatedMs, serializationMs, bytes, ...browserMetrics };
          if (iteration) entry.samples.push(sample);
        }
        entry.metrics = Object.fromEntries(['databaseMs', 'serviceMs', 'assemblyMs', 'authenticatedMs', 'serializationMs', 'browserMs', 'parseMs']
          .map((key) => [key, p95(entry.samples.map((sample) => sample[key]))]));
        entry.metrics.bytes = Math.max(...entry.samples.map((sample) => sample.bytes)); entry.metrics.queries = 2;
        console.log(JSON.stringify({ kind, size, ...entry.metrics }));
        await writeFile('.local/workflow-reference-performance.json', JSON.stringify(report, null, 2) + '\n');
        expect(entry.metrics.serviceMs).toBeLessThanOrEqual(serviceBudgetMs);
        expect(entry.metrics.browserMs).toBeLessThanOrEqual(browserBudgetMs);
        expect(entry.metrics.parseMs).toBeLessThanOrEqual(entry.parseBudgetMs);
      }
    }
    report.status = 'passed';
  } finally {
    report.finishedAt = new Date().toISOString(); await closePool(); await owner.end();
    await writeFile('.local/workflow-reference-performance.json', JSON.stringify(report, null, 2) + '\n');
  }
});
