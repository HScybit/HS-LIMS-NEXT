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
}

test('user directory HTTP reads are bounded, uncached and reject malformed queries or unsupported writes', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['users.read'] }); await login(page, actor);
  const response = await page.request.get('/api/users'); expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toBe('no-store');
  const result = await response.json(); expect(result.totalCount).toBe(1); expect(result.rows.map((row) => row.id)).toEqual([actor.userId]);
  const detail = await page.request.get(`/api/users/${actor.userId.toUpperCase()}`); expect(detail.status()).toBe(200);
  const person = await detail.json(); expect(person).toEqual(result.rows[0]); expect(person.lastLoginAt).toMatch(/^\d{4}-/); expect(person.lastLogoutAt).toBeNull();
  expect(Object.keys(person).sort()).toEqual(['active', 'createdAt', 'displayName', 'email', 'id', 'identityActive', 'lastLoginAt', 'lastLogoutAt', 'membershipActive', 'organizationName', 'roles', 'statusRevision', 'username',
    'identityCreatedAt', 'defaultRoleId', 'defaultRoleName', 'defaultRoleDescription', 'businessUnitId', 'businessUnitName'].sort());
  for (const input of [null, [], { pageSize: 101 }, { organizationId: actor.organizationId }, { search: '\0' }, { search: '\ud800' },
    { sort: { key: 'username', dir: 'invalid' } }, { sort: { key: ['email'], dir: 'asc' } }, { sort: { key: { toString: null }, dir: 'asc' } }]) {
    expect((await page.request.get(`/api/users?query=${encodeURIComponent(JSON.stringify(input))}`)).status()).toBe(400);
  }
  expect((await page.request.get('/api/users?query=%7B')).status()).toBe(400);
  expect((await page.request.get(`/api/users?query=${'x'.repeat(16_001)}`)).status()).toBe(413);
  expect((await page.request.get('/api/users/invalid')).status()).toBe(400);
  expect((await page.request.get(`/api/users/${randomUUID()}`)).status()).toBe(404);
  for (const method of ['PATCH', 'DELETE']) expect((await page.request.fetch('/api/users', { method, data: {} })).status()).toBe(405);
  expect((await page.request.post('/api/users', { data: {} })).status()).toBe(403);
});

test('directory endpoints isolate tenants and reject unrelated, revoked and expired sessions', async ({ page }) => {
  const actor = await createAccount(owner, { permissions: ['users.manage'] });
  const foreign = await createAccount(owner, { permissions: ['users.manage'] });
  const unrelated = await createAccount(owner, { organizationId: actor.organizationId, permissions: ['samples.read'] });
  await login(page, actor);
  expect((await page.request.get(`/api/users/${foreign.userId}`)).status()).toBe(404);
  expect((await (await page.request.get('/api/users')).json()).rows.every((row) => row.id !== foreign.userId)).toBe(true);
  await login(page, unrelated); expect((await page.request.get('/api/users')).status()).toBe(403);
  await login(page, actor);
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [actor.organizationId, actor.roleId]);
  expect((await page.request.get('/api/users')).status()).toBe(403);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId]);
  expect((await page.request.get('/api/users')).status()).toBe(401);
  await login(page, foreign);
  await owner.query("UPDATE sessions SET expires_at=created_at+interval '1 microsecond' WHERE user_id=$1", [foreign.userId]);
  expect((await page.request.get('/api/users')).status()).toBe(401);
});
