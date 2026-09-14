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
async function fixture() {
  const admin = await createAccount(owner, { permissions: ['users.manage', 'roles.manage'] });
  const reader = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] }); const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'HTTP creation lab')", [admin.organizationId, lab]);
  const input = (extra = {}) => { const id = randomUUID(); return { id, requestId: randomUUID(), revision: 0, username: `http-${id}`, email: `HTTP-${id}@example.invalid`,
    displayName: 'HTTP new account', password: '  Exact HTTP password  ', defaultRoleId: reader.roleId, laboratoryId: lab, employeeCode: '007', ...extra }; };
  return { admin, reader, lab, input };
}

test('concurrent HTTP creation saves one account that signs in through the actual browser and retains exact retries', async ({ page }) => {
  const f = await fixture(); let headers = await login(page, f.admin); const input = f.input();
  const responses = await Promise.all([page.request.post('/api/users', { data: input, headers }), page.request.post('/api/users', { data: input, headers })]);
  const results = await Promise.all(responses.map((response) => response.json()));
  for (const response of responses) { expect(response.status()).toBe(201); expect(response.headers()['cache-control']).toBe('no-store'); }
  expect(results[0]).toEqual({ user: { id: input.id, username: input.username, email: input.email, displayName: input.displayName }, profileRevision: 1 });
  expect(results[1]).toEqual(results[0]);
  expect((await owner.query('SELECT count(*)::integer AS count FROM user_creation_commands WHERE user_id=$1', [input.id])).rows[0].count).toBe(1);
  const conflict = await page.request.post('/api/users', { data: { ...input, password: 'Changed retry password' }, headers }); expect(conflict.status()).toBe(409); expect((await conflict.json()).error.code).toBe('save_request_reused');
  headers = await login(page, input);
  const profile = await (await page.request.get(`/api/users/${input.id}/profile`)).json(); expect(profile.employeeCode).toBe('007'); expect(profile.savedBy).toBe(f.admin.userId);
  expect(profile.roles.map((role) => role.id)).toEqual([f.reader.roleId]);
  expect((await page.request.patch('/api/profile', { data: { username: `renamed-${input.id}`, displayName: 'Renamed in My Account', revision: 1 }, headers })).status()).toBe(200);
  headers = await login(page, f.admin);
  expect(await (await page.request.post('/api/users', { data: input, headers })).json()).toEqual(results[0]);
  const current = await (await page.request.get(`/api/users/${input.id}`)).json(); expect(current.username).toBe(`renamed-${input.id}`); expect(current.displayName).toBe('Renamed in My Account');
});

test('creation HTTP enforces origin, CSRF, typed fields, references, global aliases and actual permissions without partial accounts', async ({ page }) => {
  const f = await fixture(); const foreign = await createAccount(owner, { permissions: ['users.manage'] }); let headers = await login(page, f.admin);
  const input = f.input();
  expect((await page.request.post('/api/users', { data: input })).status()).toBe(403);
  expect((await page.request.post('/api/users', { data: input, headers: { origin: headers.origin } })).status()).toBe(403);
  expect((await page.request.post('/api/users', { data: input, headers: { ...headers, origin: 'https://other.invalid' } })).status()).toBe(403);
  for (const data of [null, [], { ...input, password: '' }, { ...input, password: '1234567' }, { ...input, password: 'x'.repeat(201) },
    { ...input, username: '\0' }, { ...input, displayName: '\ud800' }, { ...input, organizationId: foreign.organizationId }, { ...input, mustChangePassword: true },
    { ...input, active: false }, { ...input, revision: 1 }, { ...input, defaultRoleId: null }]) {
    expect((await page.request.post('/api/users', { data, headers })).status()).toBe(400);
  }
  const missingLab = { ...input }; delete missingLab.laboratoryId;
  expect((await page.request.post('/api/users', { data: missingLab, headers })).status()).toBe(422);
  expect((await page.request.post('/api/users', { data: { ...input, displayName: 'x'.repeat(20_000) }, headers })).status()).toBe(413);
  const badReference = await page.request.post('/api/users', { data: { ...input, laboratoryId: randomUUID() }, headers }); expect(badReference.status()).toBe(422); expect((await badReference.json()).error.code).toBe('invalid_laboratory');
  for (const extra of [{ username: foreign.username }, { username: foreign.email }, { email: foreign.email }]) {
    const collision = await page.request.post('/api/users', { data: { ...input, ...extra }, headers }); expect(collision.status()).toBe(409);
    expect(await collision.json()).toEqual({ error: { code: 'sign_in_identifier_taken', message: 'A username or email is already in use.' } });
  }
  expect((await owner.query('SELECT id FROM users WHERE id=$1', [input.id])).rowCount).toBe(0);
  expect((await owner.query('SELECT user_id FROM user_creation_commands WHERE user_id=$1', [input.id])).rowCount).toBe(0);
  headers = await login(page, f.reader); expect((await page.request.post('/api/users', { data: input, headers })).status()).toBe(403);
  headers = await login(page, f.admin);
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.admin.organizationId, f.admin.roleId]);
  expect((await page.request.post('/api/users', { data: input, headers })).status()).toBe(403);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.admin.userId]);
  expect((await page.request.post('/api/users', { data: input, headers })).status()).toBe(401);
});
