import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
const field = changes => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, key: `field_${randomUUID().replaceAll('-', '')}`,
  label: 'User field', associatedWith: 'users', fieldType: 'select', options: [{ id: randomUUID(), key: 'A', label: 'Choice A' }], ...changes });
async function fixture() {
  const author = await createAccount(owner, { permissions: ['masters.manage'] });
  const reader = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.read'] });
  const session = await signIn({ identifier: author.username, password: author.password });
  const save = value => withSession(session.token, (client, identity) => saveCustomField(client, identity, value));
  const visible = field({ showInList: true }); const hidden = field({ label: 'Form-only user field' });
  await save(visible); await save(hidden); await save(field({ associatedWith: 'product', label: 'Private product field' }));
  return { author, reader, session, save, visible, hidden };
}

test('user field HTTP reads expose only the active user association and pinned options without master permissions', async ({ page }) => {
  const f = await fixture(); await login(page, f.reader);
  const response = await page.request.get('/api/users/custom-fields'); expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toBe('no-store');
  const result = await response.json(); expect(result.fields.map(value => value.id).sort()).toEqual([f.visible.id, f.hidden.id].sort());
  expect(result.fields.find(value => value.id === f.visible.id).options).toEqual(f.visible.options);
  const listing = await page.request.get('/api/users/custom-fields?view=list'); expect(listing.status()).toBe(200);
  expect((await listing.json()).fields.map(value => value.id)).toEqual([f.visible.id]);
  expect((await page.request.get('/api/masters/products/custom-fields')).status()).toBe(403);
  await f.save({ ...f.visible, requestId: randomUUID(), revision: 1, label: 'Changed user field', options: [{ id: randomUUID(), key: 'B', label: 'Choice B' }] });
  const changed = (await (await page.request.get('/api/users/custom-fields?view=list')).json()).fields[0];
  expect(changed.revision).toBe(2); expect(changed.label).toBe('Changed user field'); expect(changed.options[0].key).toBe('B');
  await withSession(f.session.token, (client, identity) => retireCustomField(client, identity, { id: f.visible.id, revision: 2, requestId: randomUUID() }));
  expect((await (await page.request.get('/api/users/custom-fields?view=list')).json()).fields).toEqual([]);
});

test('user field HTTP rejects unsupported query/write shapes, foreign scope and actual permission/session loss', async ({ page }) => {
  const f = await fixture(); await login(page, f.reader);
  for (const query of ['view=form', 'view=list&view=list', 'view=', `organizationId=${f.author.organizationId}`, 'association=product']) {
    expect((await page.request.get('/api/users/custom-fields?' + query)).status()).toBe(400);
  }
  for (const method of ['POST', 'PATCH', 'DELETE']) expect((await page.request.fetch('/api/users/custom-fields', { method, data: {} })).status()).toBe(405);
  const foreign = await createAccount(owner, { permissions: ['users.manage'] }); await login(page, foreign);
  const empty = await page.request.get('/api/users/custom-fields'); expect(empty.status()).toBe(200); expect((await empty.json()).fields).toEqual([]);
  await login(page, f.author); expect((await page.request.get('/api/users/custom-fields')).status()).toBe(403);
  await login(page, f.reader); await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.reader.organizationId, f.reader.roleId]);
  expect((await page.request.get('/api/users/custom-fields')).status()).toBe(403);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.reader.userId]); expect((await page.request.get('/api/users/custom-fields')).status()).toBe(401);
  await page.context().clearCookies(); expect((await page.request.get('/api/users/custom-fields')).status()).toBe(401);
});
