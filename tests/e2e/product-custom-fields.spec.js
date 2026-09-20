import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}

test('Product definition HTTP reads require a permitted tenant session and return current immutable choices without caching', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const manager = await createAccount(owner, { permissions: ['masters.manage'] });
  const viewer = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['masters.read'] });
  const session = await signIn({ identifier: manager.username, password: manager.password });
  const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), label: 'Product browser choices', key: 'product_browser_choices',
    associatedWith: 'product', fieldType: 'select', roleIdsCanEdit: [manager.roleId],
    options: [{ id: randomUUID(), key: 'A', label: 'Upper' }, { id: randomUUID(), key: 'a', label: 'Lower' }] };
  const change = (work) => withSession(session.token, work, { csrfToken: session.csrfToken });
  await change((client, identity) => saveCustomField(client, identity, command));
  const url = '/api/masters/products/custom-fields';
  expect((await page.request.get(url)).status()).toBe(401);
  await login(page, viewer);
  const first = await page.evaluate(async (url) => {
    const response = await fetch(url); return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
  }, url);
  expect(first.status).toBe(200); expect(first.cache).toBe('no-store'); expect(first.body.fields).toHaveLength(1);
  expect(first.body.fields[0]).toMatchObject({ id: command.id, revision: 1, options: command.options });
  await change((client, identity) => saveCustomField(client, identity, { ...command, revision: 1, requestId: randomUUID(), options: [...command.options].reverse() }));
  expect((await (await page.request.get(url)).json()).fields[0]).toMatchObject({ revision: 2, options: [...command.options].reverse() });
  for (const account of [await createAccount(owner, { permissions: ['masters.read'] }),
    await createAccount(owner, { organizationId: manager.organizationId, permissions: [] })]) {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
    try {
      const other = await context.newPage(); await login(other, account); const response = await other.request.get(url);
      if (account.organizationId === manager.organizationId) expect(response.status()).toBe(403);
      else { expect(response.status()).toBe(200); expect(await response.json()).toEqual({ organizationId: account.organizationId, fields: [] }); }
    } finally { await context.close(); }
  }
  await change((client, identity) => retireCustomField(client, identity, { id: command.id, revision: 2, requestId: randomUUID() }));
  expect(await (await page.request.get(url)).json()).toEqual({ organizationId: manager.organizationId, fields: [] });
});
