import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';
import { generateReports } from '../../src/reports/service.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const permissions = ['samples.read', 'samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'];
async function login(page, account) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
const csrf = async (page) => (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value;

test('a test request prints its rendered datasheet as a PDF in a new tab', async ({ page, context }) => {
  const account = await createAccount(owner, { permissions });
  const source = await createLaboratoryFixture(owner, account);
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (action) => withSession(session.token, action, { csrfToken: session.csrfToken });
  const sample = await work((client, identity) => registerSample(client, identity, source.registration));
  const generated = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  const requestId = generated.items[0].id;
  const allocated = await work((client, identity) => allocateTestRequest(client, identity, requestId, { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId }));
  await login(page, account);
  await page.goto(`/samples/${sample.id}/test_requests/${requestId}`);
  const print = page.getByRole('button', { name: 'Print', exact: true });
  await expect(print).toBeVisible();
  const popup = context.waitForEvent('page');
  const rendered = page.waitForResponse((response) => response.url().endsWith(`/api/datasheets/${allocated.datasheetId}/print-pdf`));
  await print.click();
  // Chrome's network instrumentation returns an empty body for PDF responses; the direct request below checks the bytes.
  const response = await rendered; expect(response.status()).toBe(200); expect(response.headers()['content-type']).toBe('application/pdf');
  const opened = await popup;
  await expect.poll(() => opened.url()).toMatch(/^blob:/);
  await expect(print).toBeEnabled();

  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': await csrf(page) };
  const direct = await page.request.post(`/api/datasheets/${allocated.datasheetId}/print-pdf`, { headers, data: { html: '<article>Synthetic datasheet</article>', title: 'TR print', sampleId: sample.id } });
  expect(direct.status()).toBe(200); expect(direct.headers()['content-disposition']).toContain('TR_print.pdf');
  expect((await direct.body()).subarray(0, 5).toString()).toBe('%PDF-');
  expect((await page.request.post(`/api/datasheets/${allocated.datasheetId}/print-pdf`, { headers, data: { html: '', title: 'TR print' } })).status()).toBe(400);
  const outsider = await createAccount(owner, { permissions });
  const other = await signIn({ identifier: outsider.username, password: outsider.password });
  await page.request.post('/api/auth/logout', { data: {}, headers });
  await login(page, outsider);
  const foreign = await page.request.post(`/api/datasheets/${allocated.datasheetId}/print-pdf`, { headers: { ...headers, 'X-CSRF-Token': await csrf(page) }, data: { html: '<p>x</p>', title: 'x', sampleId: sample.id } });
  expect([403, 404]).toContain(foreign.status()); void other;
});

test('COA printing completes through the web server without a separate report worker', async ({ page }) => {
  const user = await createAccount(owner, { permissions });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const flow = await prepareReportFlow(owner, account, { finalSection: true });
  const generated = await withSession(account.token, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input), { csrfToken: account.csrfToken });
  const path = `/api/reports/${generated.items[0].id}/pdf`;
  await page.addInitScript(() => {
    const createElement = Document.prototype.createElement;
    Document.prototype.createElement = function (...args) {
      const element = createElement.apply(this, args);
      if (String(args[0]).toLowerCase() === 'iframe') element.addEventListener('load', () => {
        if (element.title === 'Report PDF print frame') element.contentWindow.print = () => { window.reportPrinted = true; };
      });
      return element;
    };
  });
  await login(page, account);
  await page.goto(`/samples/${flow.sample.id}/coa`);
  await expect(page.frameLocator('.finalised-report-preview__frame').getByRole('article')).toBeVisible();
  const file = page.waitForResponse((response) => response.url().endsWith(`${path}/file`), { timeout: 90_000 });
  await page.getByRole('button', { name: 'Print', exact: true }).click();
  expect((await file).status()).toBe(200);
  await expect.poll(() => page.evaluate(() => window.reportPrinted === true)).toBe(true);
  const status = await page.request.get(path).then((response) => response.json());
  expect(status.job.status).toBe('succeeded');
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeEnabled();
});
