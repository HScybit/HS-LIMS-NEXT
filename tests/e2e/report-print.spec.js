import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { startReportWorker } from '../helpers/report-worker.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { generateReports } from '../../src/reports/service.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

test('Print retains its durable request across navigation and opens a verified PDF through the source print control', async ({ page, context }, testInfo) => {
  const user = await createAccount(owner, { permissions: ['samples.read', 'samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const flow = await prepareReportFlow(owner, account, { finalSection: true });
  const generated = await withSession(account.token, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input), { csrfToken: account.csrfToken });
  const reportId = generated.items[0].id; const path = `/api/reports/${reportId}/pdf`;
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  await page.goto(`/samples/${flow.sample.id}/coa`);
  await expect(page.getByRole('article')).toBeVisible();
  const refused = await page.request.post(path, { headers: { Origin: 'http://127.0.0.1:3100' } }); expect(refused.status()).toBe(403);
  expect((await page.request.get(path).then((response) => response.json())).job).toBeNull();
  await page.route(`**${path}`, (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic print failure' } }) }) : route.continue());
  await page.getByRole('button', { name: 'Print', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic print failure' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeEnabled(); await page.unroute(`**${path}`);
  const queuedResponse = page.waitForResponse((response) => response.url().endsWith(path) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Print', exact: true }).click();
  const queued = await queuedResponse; expect(queued.status()).toBe(202);
  const jobId = (await queued.json()).job.id;
  await page.close();
  const resumed = await context.newPage();
  await resumed.addInitScript(() => {
    // Native print UI has no headless dialog and can crash Chrome's PDF
    // process. Observe that one boundary; fetch, rendering and blob bytes
    // remain real. A separate visible-Chrome probe checks the native dialog.
    window.reportPrintCalls = 0;
    const createElement = Document.prototype.createElement;
    Document.prototype.createElement = function (...args) {
      const element = createElement.apply(this, args);
      if (String(args[0]).toLowerCase() === 'iframe') element.addEventListener('load', () => {
        if (element.title === 'Report PDF print frame') element.contentWindow.print = () => { window.reportPrintCalls += 1; };
      });
      return element;
    };
  });
  await resumed.goto(`/samples/${flow.sample.id}/coa`); await expect(resumed.getByRole('article')).toBeVisible();
  expect((await resumed.request.get(path).then((response) => response.json())).job.id).toBe(jobId);
  const errors = []; resumed.on('pageerror', (error) => errors.push(error.message));
  const stopWorker = await startReportWorker();
  try {
    const fileResponse = resumed.waitForResponse((response) => response.url().endsWith(`${path}/file`));
    await resumed.getByRole('button', { name: 'More print actions', exact: true }).click();
    await resumed.getByRole('menuitem', { name: 'Print PDF', exact: true }).click();
    const file = await fileResponse; expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toBe('application/pdf'); expect(file.headers()['cache-control']).toContain('no-store');
    const frame = resumed.locator('iframe[title="Report PDF print frame"]');
    await expect(frame).toHaveCount(1);
    // Chrome's network instrumentation returns an empty PDF body for this
    // fetch. Verify the actual blob consumed by the print frame instead.
    const printed = await frame.evaluate(async (element) => {
      const bytes = await fetch(element.src).then((response) => response.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return { length: bytes.byteLength, magic: new TextDecoder().decode(bytes.slice(0, 5)), checksum: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
    });
    expect(printed.length).toBeGreaterThan(5000); expect(printed.magic).toBe('%PDF-'); expect(printed.checksum).toBe(file.headers()['x-report-sha256']);
    const download = await resumed.request.get(`${path}/file`); const bytes = await download.body();
    expect(download.status()).toBe(200); expect(createHash('sha256').update(bytes).digest('hex')).toBe(printed.checksum);
    await expect(resumed.getByRole('button', { name: 'Print', exact: true })).toBeEnabled();
    expect(await resumed.evaluate(() => window.reportPrintCalls)).toBe(1);
    const status = await resumed.request.get(path).then((response) => response.json());
    expect(status.job.id).toBe(jobId); expect(status.job.status).toBe('succeeded'); expect(status.history).toHaveLength(1);
    await testInfo.attach('frozen-report.pdf', { body: bytes, contentType: 'application/pdf' });
    await resumed.screenshot({ path: testInfo.outputPath('report-print-ready.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await stopWorker(); await resumed.close(); }
});
