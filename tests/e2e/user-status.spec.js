import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await owner.end(); });
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(actor.username); await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  return { origin: 'http://127.0.0.1:3100', 'x-csrf-token': (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value };
}
async function fixture() {
  const admin = await createAccount(owner, { permissions: ['users.manage', 'roles.manage'] });
  const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] });
  return { admin, person };
}
const command = (revision = 0, membershipActive = false) => ({ requestId: randomUUID(), revision, membershipActive });

test('HTTP status commands revoke a real browser session and retain exact retries after reactivation', async ({ page, browser }) => {
  const { admin, person } = await fixture(); const headers = await login(page, admin); const url = `/api/users/${person.userId}/status`;
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' }); const personPage = await context.newPage();
  try {
    await login(personPage, person);
    const before = await (await page.request.get(`/api/users/${person.userId}`)).json();
    const off = command(); const results = await Promise.all([page.request.patch(url, { data: off, headers }), page.request.patch(url, { data: off, headers })]);
    for (const result of results) {
      expect(result.status()).toBe(200); expect(result.headers()['cache-control']).toBe('no-store');
      expect(await result.json()).toEqual({ id: person.userId, revision: 1, membershipActive: false });
    }
    expect((await personPage.request.get('/api/auth/session')).status()).toBe(401);
    const after = await (await page.request.get(`/api/users/${person.userId}`)).json();
    expect(after.active).toBe(false); expect(after.identityActive).toBe(true); expect(after.statusRevision).toBe(1); expect(after.lastLogoutAt).toBe(before.lastLogoutAt);
    expect((await page.request.patch(url, { data: command(1, true), headers })).status()).toBe(200);
    expect((await personPage.request.get('/api/auth/session')).status()).toBe(401);
    await login(personPage, person); expect((await personPage.request.get('/api/auth/session')).status()).toBe(200);
    expect(await (await page.request.patch(url, { data: off, headers })).json()).toEqual({ id: person.userId, revision: 1, membershipActive: false });
    expect(await (await page.request.get(url)).json()).toEqual({ id: person.userId, revision: 2, membershipActive: true, identityActive: true, active: true });
    const history = await (await page.request.get(`${url}/history?limit=1`)).json(); expect(history.rows[0].revision).toBe(2); expect(history.nextBeforeRevision).toBe(2);
    const next = await (await page.request.get(`${url}/history?limit=1&beforeRevision=2`)).json(); expect(next.rows[0].revision).toBe(1); expect(next.nextBeforeRevision).toBeNull();
    expect(next.rows[0].savedBy).toBe(admin.userId); expect(next.rows[0].username).toBe(person.username);
    expect(Object.keys(next.rows[0]).sort()).toEqual(['revision', 'previousRevision', 'membershipActive', 'previousMembershipActive', 'username', 'displayName', 'savedBy', 'savedByUsername', 'savedByName', 'savedAt'].sort());
  } finally { await context.close(); }
});

test('status HTTP checks actual permissions, CSRF, origin, strict inputs and conflict handling', async ({ page }) => {
  const { admin, person } = await fixture(); const foreign = await createAccount(owner, { permissions: ['users.manage'] });
  let headers = await login(page, admin); const url = `/api/users/${person.userId}/status`; const off = command();
  expect((await page.request.patch(url, { data: off })).status()).toBe(403);
  expect((await page.request.patch(url, { data: off, headers: { origin: headers.origin } })).status()).toBe(403);
  expect((await page.request.patch(url, { data: off, headers: { ...headers, origin: 'https://example.invalid' } })).status()).toBe(403);
  for (const data of [{ ...off, membershipActive: 'false' }, { ...off, revision: '0' }, { ...off, organizationId: foreign.organizationId }, { ...off, active: false }]) {
    expect((await page.request.patch(url, { data, headers })).status()).toBe(400);
  }
  expect((await page.request.get(`${url}/history?limit=101`)).status()).toBe(400);
  expect((await page.request.get(`${url}/history?beforeRevision=0`)).status()).toBe(400);
  for (const suffix of ['', '/history']) expect((await page.request.get(`/api/users/${foreign.userId}/status${suffix}`)).status()).toBe(404);
  expect((await page.request.patch(`/api/users/${foreign.userId}/status`, { data: off, headers })).status()).toBe(404);
  const self = await page.request.patch(`/api/users/${admin.userId}/status`, { data: off, headers }); expect(self.status()).toBe(409); expect((await self.json()).error.code).toBe('cannot_disable_self');
  expect((await page.request.patch(url, { data: command(0, true), headers })).status()).toBe(409);
  expect((await page.request.patch(url, { data: off, headers })).status()).toBe(200);
  expect((await page.request.patch(url, { data: { ...off, membershipActive: true }, headers })).status()).toBe(409);
  const stale = await page.request.patch(url, { data: command(), headers }); expect(stale.status()).toBe(409); expect((await stale.json()).error.code).toBe('stale_user_status');
  await page.request.patch(url, { data: command(1, true), headers });
  headers = await login(page, person); expect((await page.request.get(url)).status()).toBe(200);
  expect((await page.request.patch(url, { data: command(2), headers })).status()).toBe(403);
  headers = await login(page, admin);
  await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='users.manage'", [admin.organizationId, admin.roleId]);
  expect((await page.request.patch(url, { data: command(2), headers })).status()).toBe(403);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [admin.userId]);
  expect((await page.request.patch(url, { data: command(2), headers })).status()).toBe(401);
});
