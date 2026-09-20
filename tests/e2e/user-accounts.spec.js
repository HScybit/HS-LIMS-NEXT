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
const command = (person, extra = {}) => ({ requestId: randomUUID(), revision: 1, username: person.username, email: person.email, displayName: 'Edited user', ...extra });

test('account HTTP changes preserve exact retries and end a real browser session after a supplied password', async ({ page, browser }) => {
  const { admin, person } = await fixture(); const headers = await login(page, admin); const url = `/api/users/${person.userId}/account`;
  const context = await browser.newContext({ baseURL: headers.origin }); const personPage = await context.newPage();
  try {
    await login(personPage, person); const input = command(person, { password: 'Replaced browser password' });
    const results = await Promise.all([page.request.patch(url, { data: input, headers }), page.request.patch(url, { data: input, headers })]);
    for (const response of results) { expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toBe('no-store'); expect(await response.json()).toEqual({ id: person.userId, revision: 2, passwordChanged: true }); }
    expect((await personPage.request.get('/api/auth/session')).status()).toBe(401);
    await login(personPage, { ...person, password: input.password });
    const later = command(person, { revision: 2, username: `later-${person.userId}`, email: `later-${person.email}`, password: '' });
    expect((await page.request.patch(url, { data: later, headers })).status()).toBe(200);
    expect((await page.request.patch(url, { data: input, headers })).status()).toBe(200);
    expect((await personPage.request.get('/api/auth/session')).status()).toBe(200);
    const current = await (await page.request.get(url)).json(); expect(current.revision).toBe(3); expect(current.username).toBe(later.username); expect(current.email).toBe(later.email);
    const first = await (await page.request.get(`${url}/history?limit=1`)).json(); expect(first.rows[0].revision).toBe(3); expect(first.nextBeforeRevision).toBe(3);
    const next = await (await page.request.get(`${url}/history?limit=1&beforeRevision=3`)).json(); expect(next.rows[0].revision).toBe(2); expect(next.rows[0].savedBy).toBe(admin.userId); expect(next.rows[0].passwordChanged).toBe(true);
    expect(Object.keys(next.rows[0]).sort()).toEqual(['revision', 'previousRevision', 'username', 'email', 'displayName', 'previousUsername', 'previousEmail', 'previousDisplayName', 'passwordChanged', 'savedBy', 'savedByUsername', 'savedByName', 'savedAt'].sort());
  } finally { await context.close(); }
});

test('account HTTP enforces origin, CSRF, input, actual authority and protected shared principals', async ({ page }) => {
  const { admin, person } = await fixture(); const foreign = await createAccount(owner, { permissions: ['users.manage'] });
  let headers = await login(page, admin); const url = `/api/users/${person.userId}/account`; const input = command(person);
  for (const options of [{}, { origin: headers.origin }, { ...headers, origin: 'https://example.invalid' }]) expect((await page.request.patch(url, { data: input, headers: options })).status()).toBe(403);
  for (const changes of [{ revision: '1' }, { password: null }, { username: '' }, { password: 'short' }, { organizationId: foreign.organizationId }, { isPlatformAdministrator: true }]) {
    expect((await page.request.patch(url, { data: { ...input, ...changes }, headers })).status()).toBe(400);
  }
  expect((await page.request.get(`${url}/history?limit=101`)).status()).toBe(400);
  expect((await page.request.patch(`/api/users/${foreign.userId}/account`, { data: input, headers })).status()).toBe(404);
  for (const suffix of ['', '/history']) expect((await page.request.get(`/api/users/${foreign.userId}/account${suffix}`)).status()).toBe(404);
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, person.userId]);
  expect((await (await page.request.get(url)).json()).canEditIdentity).toBe(false);
  const protectedResponse = await page.request.patch(url, { data: input, headers }); expect(protectedResponse.status()).toBe(403); expect((await protectedResponse.json()).error.code).toBe('protected_user_identity');
  await owner.query('INSERT INTO platform_administrators(organization_id,user_id,granted_at,granted_by) VALUES($1,$2,clock_timestamp(),$3)', [admin.organizationId, admin.userId, 'Synthetic browser operator']);
  expect((await page.request.patch(url, { data: input, headers })).status()).toBe(200);
  expect((await page.request.patch(url, { data: { ...input, displayName: 'Changed request' }, headers })).status()).toBe(409);
  expect((await page.request.patch(url, { data: command(person), headers })).status()).toBe(409);
  headers = await login(page, person); expect((await page.request.get(url)).status()).toBe(200); expect((await page.request.patch(url, { data: command(person, { revision: 2 }), headers })).status()).toBe(403);
  headers = await login(page, admin); await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='users.manage'", [admin.organizationId, admin.roleId]);
  expect((await page.request.patch(url, { data: command(person, { revision: 2 }), headers })).status()).toBe(403);
});

test('self administrative password HTTP save logs out the current browser and a fresh login can replay', async ({ page }) => {
  const { admin } = await fixture(); let headers = await login(page, admin); const url = `/api/users/${admin.userId}/account`;
  const input = command(admin, { password: 'Changed own browser password' });
  expect((await page.request.patch(url, { data: input, headers })).status()).toBe(200); expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  headers = await login(page, { ...admin, password: input.password }); expect((await page.request.patch(url, { data: input, headers })).status()).toBe(200);
  expect((await page.request.get('/api/auth/session')).status()).toBe(200);
});
