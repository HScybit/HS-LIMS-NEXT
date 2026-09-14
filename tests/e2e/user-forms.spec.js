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
  return { origin: 'http://127.0.0.1:3100', 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
}
async function fixture() {
  const admin = await createAccount(owner, { permissions: ['users.manage', 'roles.manage'] });
  const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Browser form laboratory')", [admin.organizationId, lab]);
  const input = { requestId: randomUUID(), revision: 1, profileRevision: 0, username: person.username, email: person.email,
    displayName: 'Browser form analyst', defaultRoleId: person.roleId, laboratoryId: lab, phone: 'Original contact' };
  return { admin, person, lab, input };
}

test('combined user form HTTP is atomic, preserves exact retries and revokes a real browser session only on the first password command', async ({ page, browser }) => {
  const f = await fixture(); const headers = await login(page, f.admin); const url = `/api/users/${f.person.userId}`;
  const context = await browser.newContext({ baseURL: headers.origin }); const personPage = await context.newPage();
  try {
    await login(personPage, f.person); const input = { ...f.input, password: 'Atomic browser password' };
    const results = await Promise.all([page.request.patch(url, { data: input, headers }), page.request.patch(url, { data: input, headers })]);
    for (const result of results) { expect(result.status()).toBe(200); expect(await result.json()).toEqual({ id: f.person.userId, revision: 2, profileRevision: 1, passwordChanged: true }); }
    expect((await personPage.request.get('/api/auth/session')).status()).toBe(401);
    await login(personPage, { ...f.person, password: input.password });
    expect((await page.request.patch(url, { data: input, headers })).status()).toBe(200); expect((await personPage.request.get('/api/auth/session')).status()).toBe(200);
    const before = await (await page.request.get(`${url}/form`)).json(); expect(before.account.revision).toBe(2); expect(before.profile.revision).toBe(1); expect(before.profile.phone).toBe('Original contact');
    const bad = { ...f.input, requestId: randomUUID(), revision: 2, profileRevision: 1, email: f.admin.email, phone: 'Must roll back' };
    const failure = await page.request.patch(url, { data: bad, headers }); expect(failure.status()).toBe(409); expect((await failure.json()).error.code).toBe('sign_in_identifier_taken');
    expect(await (await page.request.get(`${url}/form`)).json()).toEqual(before);
    const read = await page.request.get(url); expect(read.status()).toBe(200); expect((await read.json()).displayName).toBe(input.displayName);
  } finally { await context.close(); }
});

test('combined user form HTTP requires actual management authority and strict origin, CSRF, tenant and field boundaries', async ({ page }) => {
  const f = await fixture(); let headers = await login(page, f.admin); const url = `/api/users/${f.person.userId}`;
  for (const value of [{}, { origin: headers.origin }, { ...headers, origin: 'https://example.invalid' }]) expect((await page.request.patch(url, { data: f.input, headers: value })).status()).toBe(403);
  for (const changes of [{ profileRevision: '0' }, { password: null }, { canManagePeople: null }, { signatureId: randomUUID() }, { active: true }, { organizationId: randomUUID() }]) {
    expect((await page.request.patch(url, { data: { ...f.input, ...changes }, headers })).status()).toBe(400);
  }
  const invalid = await page.request.patch(url, { data: { ...f.input, laboratoryId: randomUUID() }, headers }); expect(invalid.status()).toBe(422);
  const unchanged = await (await page.request.get(`${url}/form`)).json(); expect(unchanged.profile.revision).toBe(0); expect(unchanged.account.revision).toBe(1);
  const foreign = await createAccount(owner, { permissions: ['users.manage'] });
  expect((await page.request.get(`/api/users/${foreign.userId}/form`)).status()).toBe(404); expect((await page.request.patch(`/api/users/${foreign.userId}`, { data: f.input, headers })).status()).toBe(404);
  headers = await login(page, f.person); expect((await page.request.get(`${url}/form`)).status()).toBe(200); expect((await page.request.patch(url, { data: f.input, headers })).status()).toBe(403);
  headers = await login(page, f.admin); await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='users.manage'", [f.admin.organizationId, f.admin.roleId]);
  expect((await page.request.patch(url, { data: f.input, headers })).status()).toBe(403);
});

test('self password form HTTP commits its profile and identity before ending the administrator browser session', async ({ page }) => {
  const f = await fixture(); let headers = await login(page, f.admin); const url = `/api/users/${f.admin.userId}`;
  const input = { ...f.input, username: f.admin.username, email: f.admin.email, defaultRoleId: f.admin.roleId, password: 'Own atomic browser password' };
  const response = await page.request.patch(url, { data: input, headers }); expect(response.status()).toBe(200); expect((await response.json()).profileRevision).toBe(1);
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  headers = await login(page, { ...f.admin, password: input.password }); expect((await page.request.patch(url, { data: input, headers })).status()).toBe(200);
  const form = await (await page.request.get(`${url}/form`)).json(); expect(form.profile.revision).toBe(1); expect(form.account.revision).toBe(2);
});
