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
  const cookies = await page.context().cookies();
  return { origin: 'http://127.0.0.1:3100', 'x-csrf-token': cookies.find((cookie) => cookie.name === 'sampleify_csrf').value };
}
const query = (input) => encodeURIComponent(JSON.stringify(input));
async function fixture() {
  const admin = await createAccount(owner, { permissions: ['users.manage', 'roles.manage'] });
  const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] });
  const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Profile HTTP laboratory')", [admin.organizationId, lab]);
  return { admin, person, lab };
}

test('profile HTTP saves preserve sparse fields, exact retries and frozen history with bounded reference reads', async ({ page }) => {
  const { admin, person, lab } = await fixture(); const headers = await login(page, admin); const url = `/api/users/${person.userId}/profile`;
  const absent = await page.request.get(url); expect(absent.status()).toBe(200); expect(absent.headers()['cache-control']).toBe('no-store');
  expect(await absent.json()).toEqual({ id: person.userId, revision: 0, profile: null });
  const first = { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab, employeeCode: ' 007 ', phone: '123' };
  const created = await page.request.patch(url, { data: first, headers }); expect(created.status()).toBe(200); expect(await created.json()).toEqual({ id: person.userId, revision: 1 });
  expect((await page.request.patch(url, { data: { requestId: randomUUID(), revision: 1, phone: null }, headers })).status()).toBe(200);
  const current = await (await page.request.get(url)).json(); expect(current.revision).toBe(2); expect(current.employeeCode).toBe('007'); expect(current.phone).toBeNull();
  expect(current.laboratoryName).toBe('Profile HTTP laboratory'); expect(current.savedBy).toBe(admin.userId); expect(current.roles.map((role) => role.id)).toEqual([person.roleId]);
  for (const secret of ['password', 'passwordHash', 'csrfHash', 'createdTransactionId', 'requestId', 'rolesProvided']) expect(current).not.toHaveProperty(secret);
  const retry = await page.request.patch(url, { data: first, headers }); expect(retry.status()).toBe(200); expect((await retry.json()).revision).toBe(1);
  const conflict = await page.request.patch(url, { data: { ...first, phone: 'changed' }, headers }); expect(conflict.status()).toBe(409); expect((await conflict.json()).error.code).toBe('save_request_reused');
  expect((await page.request.patch(url, { data: { requestId: randomUUID(), revision: 1, designation: 'stale' }, headers })).status()).toBe(409);
  const historic = await (await page.request.get(`${url}?revision=1`)).json(); expect(historic.phone).toBe('123'); expect(historic.previousRevision).toBeNull();
  const history = await (await page.request.get(`${url}/history?query=${query({ pageSize: 1 })}`)).json(); expect(history.rows.map((row) => row.revision)).toEqual([2]); expect(history.hasMore).toBe(true);
  const next = await (await page.request.get(`${url}/history?query=${query({ beforeRevision: history.nextBeforeRevision })}`)).json(); expect(next.rows.map((row) => row.revision)).toEqual([1]); expect(next.hasMore).toBe(false);
  const options = await page.request.get(`/api/users/profile-references?query=${query({ kind: 'roles', pageSize: 1 })}`); expect(options.status()).toBe(200); expect(options.headers()['cache-control']).toBe('no-store');
  expect((await options.json()).hasMore).toBe(true);
});

test('profile HTTP enforces origin, CSRF, input shape, tenancy and actual management permissions', async ({ page }) => {
  const { admin, person, lab } = await fixture(); const foreign = await createAccount(owner, { permissions: ['users.manage'] });
  let headers = await login(page, admin); const url = `/api/users/${person.userId}/profile`;
  const initial = { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab };
  expect((await page.request.patch(url, { data: initial })).status()).toBe(403);
  expect((await page.request.patch(url, { data: initial, headers: { origin: headers.origin } })).status()).toBe(403);
  expect((await page.request.patch(url, { data: initial, headers: { ...headers, origin: 'https://other.invalid' } })).status()).toBe(403);
  for (const input of [null, [], { ...initial, password: 'not a profile field' }, { ...initial, active: false },
    { ...initial, phone: '\ud800' }, { ...initial, phone: '\0' }, { ...initial, roleIds: [person.roleId, person.roleId.toUpperCase()] },
    { ...initial, defaultRoleId: null }, { ...initial, revision: '0' }]) expect((await page.request.patch(url, { data: input, headers })).status()).toBe(400);
  expect((await page.request.patch(url, { data: { ...initial, phone: 'x'.repeat(20_000) }, headers })).status()).toBe(413);
  expect((await page.request.patch(`/api/users/${foreign.userId}/profile`, { data: initial, headers })).status()).toBe(404);
  expect((await page.request.get(`/api/users/${foreign.userId}/profile/history`)).status()).toBe(404);
  expect((await page.request.get(`${url}?revision=0`)).status()).toBe(400);
  expect((await page.request.get(`${url}?revision=123`)).status()).toBe(404);
  expect((await page.request.get(`${url}/history?query=${query({ pageSize: 101 })}`)).status()).toBe(400);
  for (const input of [null, [], { kind: 'credentials' }, { kind: 'roles', pageSize: 101 }, { kind: 'managers', search: '\0' }]) {
    expect((await page.request.get(`/api/users/profile-references?query=${query(input)}`)).status()).toBe(400);
  }
  expect((await page.request.get('/api/users/profile-references?query=%7B')).status()).toBe(400);
  for (const method of ['POST', 'PUT', 'DELETE']) expect((await page.request.fetch(url, { method, data: initial, headers })).status()).toBe(405);
  headers = await login(page, person); expect((await page.request.patch(url, { data: initial, headers })).status()).toBe(403);
  headers = await login(page, admin); await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [admin.organizationId, admin.roleId]);
  expect((await page.request.patch(url, { data: initial, headers })).status()).toBe(403);
  expect((await page.request.get(url)).status()).toBe(403);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [admin.userId]); expect((await page.request.get(url)).status()).toBe(401);
});
