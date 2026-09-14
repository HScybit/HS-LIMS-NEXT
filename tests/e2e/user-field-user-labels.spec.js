import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession, updateProfile } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';

let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await closePool(); await owner.end(); });
const url = '/api/users/custom-fields/user-labels';
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const read = (page, input, csrf = true) => page.evaluate(async ({ url, input, csrf }) => {
  const token = document.cookie.split('; ').find(cookie => cookie.startsWith('sampleify_csrf='))?.split('=')[1] ?? '';
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': token } : {}) }, body: JSON.stringify(input) });
  return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
}, { url, input, csrf });

test('selected user labels use current names, request order and user-only read authority through real HTTP', async ({ page }) => {
  const reader = await createAccount(owner, { permissions: ['users.read'] }); const selected = await createAccount(owner, { organizationId: reader.organizationId, permissions: [] });
  const foreign = await createAccount(owner, { permissions: [] }); await login(page, reader);
  const result = await read(page, { ids: [selected.userId, foreign.userId, reader.userId, selected.userId.toUpperCase()] });
  expect(result).toEqual({ status: 200, cache: 'no-store', body: { rows: [{ id: selected.userId, name: 'Synthetic Analyst' }, { id: reader.userId, name: 'Synthetic Analyst' }] } });
  const session = await signIn({ identifier: selected.username, password: selected.password });
  await withSession(session.token, client => updateProfile(client, { displayName: 'Current_HTTP/name', username: selected.username, revision: 1 }));
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [reader.organizationId, selected.userId]);
  expect((await read(page, { ids: [selected.userId] })).body).toEqual({ rows: [{ id: selected.userId, name: 'Current_HTTP/name' }] });
});

test('selected-label POST enforces origin, CSRF, authentication and permission even for empty reads', async ({ page }) => {
  const reader = await createAccount(owner, { permissions: ['users.read'] }); await login(page, reader);
  expect((await read(page, { ids: [] }, false)).status).toBe(403);
  const cross = await page.request.post(url, { headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' }, data: { ids: [] } }); expect(cross.status()).toBe(403);
  await page.context().clearCookies(); await page.goto('/login'); expect((await read(page, { ids: [] })).status).toBe(401);
  const master = await createAccount(owner, { permissions: ['masters.manage'] }); await login(page, master);
  expect((await read(page, { ids: [] })).status).toBe(403); expect((await read(page, { ids: [master.userId] })).status).toBe(403);
});

test('selected-label HTTP accepts the full5000-ID body and rejects malformed, excessive or oversized input', async ({ page }) => {
  const reader = await createAccount(owner, { permissions: ['users.read'] }); await login(page, reader);
  const ids = [reader.userId, ...Array.from({ length: 4999 }, () => randomUUID())]; const result = await read(page, { ids });
  expect(result.status).toBe(200); expect(result.body).toEqual({ rows: [{ id: reader.userId, name: 'Synthetic Analyst' }] });
  for (const input of [{}, { ids: null }, { ids: ['invalid'] }, { ids: [], organizationId: randomUUID() }, { ids: Array(5001).fill(reader.userId) }]) {
    expect((await read(page, input)).status).toBe(400);
  }
  expect((await read(page, { ids: [], extra: 'x'.repeat(256 * 1024) })).status).toBe(413);
  expect((await read(page, { ids: [] })).body).toEqual({ rows: [] });
});
