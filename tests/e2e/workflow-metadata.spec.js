import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function headers(page) {
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value };
}
const input = () => ({ id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: `Browser workflow ${randomUUID()}`, description: '0' });

test('Workflow Master HTTP saves recover a lost creation response and retain immutable metadata history', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['workflows.manage'] }); await login(page, account);
  const command = input(); const requestHeaders = await headers(page);
  await page.route('**/api/workflows', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    expect(route.request().postDataJSON()).toEqual(command); expect((await route.fetch()).status()).toBe(201);
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost creation response' } }) });
  });
  const send = () => page.evaluate(async ({ command, csrf }) => {
    const response = await fetch('/api/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(command) });
    return { status: response.status, data: await response.json() };
  }, { command, csrf: requestHeaders['X-CSRF-Token'] });
  expect((await send()).status).toBe(503); await page.unroute('**/api/workflows');
  const retried = await send(); expect(retried.status).toBe(201); expect(retried.data.workflowId).toBe(command.id); expect(retried.data.metadataRevision).toBe(1);
  const rows = await (await page.request.get(`/api/workflows?query=${encodeURIComponent(JSON.stringify({ search: command.name }))}`)).json();
  expect(rows.totalCount).toBe(1); expect(rows.rows[0]._id).toBe(command.id); expect(rows.rows[0].createdBy).toBe(account.userId);
  const update = { requestId: randomUUID(), metadataRevision: 1, name: command.name, description: '' };
  expect((await page.request.patch(`/api/workflows/${command.id}`, { headers: requestHeaders, data: update })).status()).toBe(200);
  expect((await page.request.patch(`/api/workflows/${command.id}`, { headers: requestHeaders, data: update })).status()).toBe(200);
  const old = await (await page.request.get(`/api/workflows/${command.id}?metadataRevision=1`)).json(); expect(old.description).toBe('0'); expect(old.savedBy).toBe(account.userId);
  const current = await (await page.request.get(`/api/workflows/${command.id}`)).json(); expect(current.description).toBe(''); expect(current.metadataRevision).toBe(2); expect(current.draftRevision).toBe(1);
  expect((await page.request.patch(`/api/workflows/${command.id}`, { headers: requestHeaders, data: { ...update, requestId: randomUUID() } })).status()).toBe(409);
  const removal = { requestId: randomUUID(), metadataRevision: 2 };
  expect((await page.request.delete(`/api/workflows/${command.id}`, { headers: requestHeaders, data: removal })).status()).toBe(200);
  expect((await page.request.delete(`/api/workflows/${command.id}`, { headers: requestHeaders, data: removal })).status()).toBe(200);
  expect((await page.request.get(`/api/workflows/${command.id}`)).status()).toBe(404);
  expect((await (await page.request.get(`/api/workflows/${command.id}?metadataRevision=3`)).json()).active).toBe(false);
  expect((await owner.query('SELECT count(*)::int n FROM workflow_metadata_versions WHERE organization_id=$1 AND workflow_id=$2', [account.organizationId, command.id])).rows[0].n).toBe(3);
});

test('Workflow Master HTTP boundaries enforce roles, tenants, identity fields, origin, CSRF and bounded queries', async ({ page, browser }) => {
  const account = await createAccount(owner, { permissions: ['workflows.manage'] }); await login(page, account);
  const command = input(); const validHeaders = await headers(page);
  expect((await page.request.post('/api/workflows', { headers: validHeaders, data: command })).status()).toBe(201);
  expect((await page.request.post('/api/workflows', { headers: { Origin: validHeaders.Origin }, data: input() })).status()).toBe(403);
  expect((await page.request.post('/api/workflows', { headers: { ...validHeaders, Origin: 'https://example.invalid' }, data: input() })).status()).toBe(403);
  expect((await page.request.post('/api/workflows', { headers: validHeaders, data: { ...input(), createdBy: account.userId } })).status()).toBe(400);
  expect((await page.request.patch(`/api/workflows/${command.id}`, { headers: validHeaders, data: { id: randomUUID(), requestId: randomUUID(), metadataRevision: 1, name: 'Forged identity' } })).status()).toBe(400);
  expect((await page.request.get('/api/workflows?query=broken')).status()).toBe(400);
  // The HTTP server may reject the request line before the route's own size check.
  expect([413, 431]).toContain((await page.request.get(`/api/workflows?query=${encodeURIComponent(JSON.stringify({ search: 'x'.repeat(17000) }))}`)).status());
  expect((await page.request.get(`/api/workflows/${command.id}?metadataRevision=0`)).status()).toBe(400);
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['workflows.read'] }); await login(page, reader);
  expect((await page.request.get(`/api/workflows/${command.id}`)).status()).toBe(200);
  expect((await page.request.post('/api/workflows', { headers: await headers(page), data: input() })).status()).toBe(403);
  expect((await page.request.delete(`/api/workflows/${command.id}`, { headers: await headers(page), data: { requestId: randomUUID(), metadataRevision: 1 } })).status()).toBe(403);
  const foreign = await createAccount(owner, { permissions: ['workflows.manage'] }); await login(page, foreign);
  expect((await page.request.get(`/api/workflows/${command.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/workflows/${command.id}?metadataRevision=1`)).status()).toBe(404);
  const anonymous = await browser.newContext();
  try { expect((await anonymous.request.get('http://127.0.0.1:3100/api/workflows')).status()).toBe(401); }
  finally { await anonymous.close(); }
});
