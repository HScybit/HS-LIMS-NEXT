import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function fixture() {
  const author = await createAccount(owner, { permissions: ['masters.manage'] });
  const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] });
  const session = await signIn({ identifier: author.username, password: author.password }); const fields = [];
  for (const fieldType of ['text', 'number', 'checkbox']) fields.push(await withSession(session.token, (client, identity) => saveCustomField(client, identity, {
    id: randomUUID(), requestId: randomUUID(), revision: 0, key: `user_${fieldType}`, label: `User ${fieldType}`, associatedWith: 'users', fieldType } )));
  return { author, manager, person, session, fields, url: `/api/users/${person.userId}/custom-fields` };
}
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
const command = (f, values = ['original', 0, false], changes = {}) => ({ requestId: randomUUID(), revision: 0,
  customFields: f.fields.map((field, index) => ({ fieldId: field.id, fieldRevision: field.revision, value: values[index] })), ...changes });
async function save(page, url, input, headers = {}) {
  return page.evaluate(async ({ url, input, headers }) => {
    const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('sampleify_csrf='))?.split('=')[1] ?? '';
    const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, ...headers }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  }, { url, input, headers });
}

test('capture HTTP preserves typed fields and historical revisions while an exact retry recovers a lost response', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager);
  const empty = await page.request.get(f.url); expect(empty.status()).toBe(200); expect((await empty.json()).recorded).toBe(false);
  const first = command(f);
  await page.route(`**${f.url}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost capture response' } }) });
  });
  expect((await save(page, f.url, first)).status).toBe(503); await page.unroute(`**${f.url}`);
  const retry = await save(page, f.url, first); expect(retry.status).toBe(200); expect(retry.body.revision).toBe(1);
  const loaded = await page.request.get(f.url); expect(loaded.headers()['cache-control']).toBe('no-store');
  const current = await loaded.json(); expect(current.recorded).toBe(true); expect(current.customFields.map(field => field.value)).toEqual(['original', 0, false]);
  expect(current.savedBy).toBe(f.manager.userId);
  expect((await save(page, f.url, command(f, ['later', 2, true], { revision: 1 }))).status).toBe(200);
  const historical = await page.request.get(f.url + '?atRevision=1'); expect((await historical.json()).customFields.map(field => field.value)).toEqual(['original', 0, false]);
  expect((await save(page, f.url, { ...first, customFields: command(f, ['different', 0, false]).customFields })).status).toBe(409);
  expect((await save(page, f.url, first)).body.revision).toBe(1);
  const history = await page.request.get(f.url + '/history?limit=1'); const firstPage = await history.json(); expect(firstPage.rows[0].revision).toBe(2); expect(firstPage.nextBeforeRevision).toBe(2);
  expect((await (await page.request.get(f.url + '/history?beforeRevision=2')).json()).rows[0].revision).toBe(1);
  const member = (await owner.query('SELECT custom_field_revision,status_revision,signature_revision FROM memberships WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, f.person.userId])).rows[0];
  expect(member).toEqual({ custom_field_revision: 2, status_revision: 0, signature_revision: 0 });
});

test('capture HTTP enforces the strict input and query contracts, request size, CSRF and actual access boundaries', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager); const first = command(f); expect((await save(page, f.url, first)).status).toBe(200);
  expect((await save(page, f.url, command(f, undefined, { revision: 1 }), { 'x-csrf-token': '' })).status).toBe(403);
  expect((await page.request.patch(f.url, { headers: { origin: 'https://unrelated.invalid' }, data: first })).status()).toBe(403);
  expect((await save(page, f.url, { requestId: randomUUID(), revision: 1 })).status).toBe(400);
  expect((await save(page, f.url, command(f, undefined, { revision: 1, organizationId: randomUUID() }))).status).toBe(400);
  expect((await save(page, f.url, command(f, undefined, { revision: 1, customFields: [] }))).status).toBe(409);
  expect((await save(page, f.url, command(f, ['x'.repeat(8 * 1_048_576), 0, false], { revision: 1 }))).status).toBe(413);
  for (const query of ['atRevision=0', 'atRevision=', 'atRevision=1&atRevision=1', 'organizationId=other']) expect((await page.request.get(f.url + '?' + query)).status()).toBe(400);
  for (const query of ['limit=0', 'limit=101', 'limit=1&limit=1', 'other=1']) expect((await page.request.get(f.url + '/history?' + query)).status()).toBe(400);
  const reader = await createAccount(owner, { organizationId: f.author.organizationId, permissions: ['users.read'] }); await login(page, reader);
  expect((await page.request.get(f.url)).status()).toBe(200); expect((await save(page, f.url, first)).status).toBe(403);
  const foreign = await createAccount(owner, { permissions: ['users.manage'] }); await login(page, foreign);
  expect((await page.request.get(f.url)).status()).toBe(404); expect((await save(page, f.url, first)).status).toBe(404);
  await login(page, f.author); expect((await page.request.get(f.url)).status()).toBe(403);
  await login(page, f.manager); await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.manager.organizationId, f.manager.roleId]);
  expect((await page.request.get(f.url)).status()).toBe(403); expect((await save(page, f.url, first)).status).toBe(403);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.manager.userId]); expect((await page.request.get(f.url)).status()).toBe(401);
  await page.context().clearCookies(); expect((await page.request.get(f.url)).status()).toBe(401);
});

test('retired definitions leave old user captures readable and an explicit empty capture records the clear operation', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager); const first = command(f); expect((await save(page, f.url, first)).status).toBe(200);
  for (const field of f.fields) await withSession(f.session.token, (client, identity) => retireCustomField(client, identity, { id: field.id, revision: field.revision, requestId: randomUUID() }));
  expect((await (await page.request.get(f.url)).json()).customFields).toHaveLength(3);
  expect((await save(page, f.url, { requestId: randomUUID(), revision: 1, customFields: [] })).status).toBe(200);
  const cleared = await (await page.request.get(f.url)).json(); expect(cleared.revision).toBe(2); expect(cleared.recorded).toBe(true); expect(cleared.customFields).toEqual([]);
  expect((await (await page.request.get(f.url + '?atRevision=1')).json()).customFields).toHaveLength(3);
  expect((await save(page, f.url, first)).body.revision).toBe(1);
});
