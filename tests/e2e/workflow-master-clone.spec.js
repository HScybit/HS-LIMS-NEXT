import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function headers(page) {
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value };
}

test('the master clone HTTP command recovers a lost success response and replays after source and target retirement', async ({ page, browser }) => {
  const account = await createAccount(owner, { permissions: ['workflows.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const source = await withSession(session.token, (client, identity) => createWorkflowCloneFixture(client, identity, { edges: 2, roleId: account.roleId }), { csrfToken: session.csrfToken });
  await login(page, account); const requestHeaders = await headers(page); const command = { id: randomUUID(), requestId: randomUUID() };
  const path = `/api/workflows/${source.workflowId}/clone`;
  await page.route(`**${path}`, async (route) => {
    expect(route.request().postDataJSON()).toEqual(command); expect((await route.fetch()).status()).toBe(201);
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost clone response' } }) });
  });
  const send = () => page.evaluate(async ({ path, command, csrf }) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(command) });
    return { status: response.status, data: await response.json() };
  }, { path, command, csrf: requestHeaders['X-CSRF-Token'] });
  expect((await send()).status).toBe(503); await page.unroute(`**${path}`);
  const retried = await send(); expect(retried.status).toBe(201); expect(retried.data.workflowId).toBe(command.id);
  expect(retried.data.revision).toBe(2); expect(retried.data.metadataRevision).toBe(1);
  const cloned = await (await page.request.get(`/api/workflows/${command.id}`)).json();
  expect(cloned.name.endsWith(' - Copy')).toBe(true); expect(cloned.draftVersionId).toBe(retried.data.versionId); expect(cloned.createdBy).toBe(account.userId);
  expect((await owner.query('SELECT count(*)::int n FROM workflow_clone_origins WHERE organization_id=$1 AND request_id=$2', [account.organizationId, command.requestId])).rows[0].n).toBe(1);
  expect((await owner.query('SELECT count(*)::int n FROM workflow_transitions WHERE organization_id=$1 AND workflow_version_id=$2', [account.organizationId, retried.data.versionId])).rows[0].n).toBe(2);
  expect((await page.request.post(path, { headers: requestHeaders, data: { ...command, sourceVersionId: source.versionId } })).status()).toBe(409);
  expect((await page.request.post(path, { headers: { Origin: requestHeaders.Origin }, data: { id: randomUUID(), requestId: randomUUID() } })).status()).toBe(403);
  expect((await page.request.post(path, { headers: { ...requestHeaders, Origin: 'https://example.invalid' }, data: command })).status()).toBe(403);
  expect((await page.request.post(path, { headers: requestHeaders, data: { ...command, createdBy: account.userId } })).status()).toBe(400);
  for (const id of [source.workflowId, command.id]) {
    expect((await page.request.delete(`/api/workflows/${id}`, { headers: requestHeaders, data: { requestId: randomUUID(), metadataRevision: 1 } })).status()).toBe(200);
  }
  expect(await send()).toEqual(retried);
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['workflows.read'] }); await login(page, reader);
  expect((await page.request.post(path, { headers: await headers(page), data: command })).status()).toBe(403);
  const foreign = await createAccount(owner, { permissions: ['workflows.manage'] }); await login(page, foreign);
  expect((await page.request.post(path, { headers: await headers(page), data: command })).status()).toBe(404);
  const anonymous = await browser.newContext();
  try { expect((await anonymous.request.post('http://127.0.0.1:3100' + path, { headers: requestHeaders, data: command })).status()).toBe(401); }
  finally { await anonymous.close(); }
});
