import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  const session = await signIn({ identifier: author.username, password: author.password });
  const input = { id: randomUUID(), revision: 0, requestId: randomUUID(), key: 'browser_user_attachment', label: 'Synthetic user attachment', associatedWith: 'users', fieldType: 'attachment' };
  const save = value => withSession(session.token, (client, identity) => saveCustomField(client, identity, value));
  return { author, manager, session, input, save, field: await save(input) };
}
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function upload(page, field, requestId, body, headers = {}) {
  return page.evaluate(async ({ field, requestId, body, headers }) => {
    const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('sampleify_csrf='))?.split('=')[1] ?? '';
    const response = await fetch('/api/users/custom-fields/attachments', { method: 'POST', headers: { 'x-csrf-token': csrf,
      'x-upload-request-id': requestId, 'x-custom-field-id': field.id, 'x-custom-field-revision': String(field.revision),
      'x-file-name': encodeURIComponent('Synthetic विश्लेषण.html'), 'content-type': 'text/html', ...headers },
    body: typeof body === 'number' ? new Uint8Array(body).fill(23) : body });
    return { status: response.status, body: await response.json() };
  }, { field, requestId, body, headers });
}

test('user file HTTP retries recover lost responses and keep original bytes accessible after reassociation and retirement', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager);
  const requestId = randomUUID(); const body = '<!doctype html><script>window.syntheticUserFileExecuted=true</script>\nOriginal file';
  await page.route('**/api/users/custom-fields/attachments', async route => {
    expect((await route.fetch()).status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost response' } }) });
  });
  expect((await upload(page, f.field, requestId, body)).status).toBe(503); await page.unroute('**/api/users/custom-fields/attachments');
  const saved = await upload(page, f.field, requestId, body); expect(saved.status).toBe(200); expect(saved.body.replayed).toBe(true);
  expect(saved.body.id).toBe(requestId); expect(Object.hasOwn(saved.body, 'content')).toBe(false);
  const response = await page.request.get(saved.body.url); expect(response.status()).toBe(200); expect(await response.body()).toEqual(Buffer.from(body));
  expect(response.headers()['cache-control']).toBe('private, no-store'); expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['content-security-policy']).toBe("default-src 'none'; sandbox");
  const downloading = page.waitForEvent('download');
  await page.evaluate(url => { const link = document.createElement('a'); link.href = url; document.body.append(link); link.click(); link.remove(); }, `${saved.body.url}?view=1`);
  const download = await downloading; expect(download.suggestedFilename()).toBe('Synthetic विश्लेषण.html'); expect(await readFile(await download.path())).toEqual(Buffer.from(body));
  expect(await page.evaluate(() => window.syntheticUserFileExecuted)).toBeUndefined();
  await f.save({ ...f.input, requestId: randomUUID(), revision: 1, associatedWith: 'product' });
  await withSession(f.session.token, (client, identity) => retireCustomField(client, identity, { id: f.field.id, revision: 2, requestId: randomUUID() }));
  expect((await page.request.get(saved.body.url)).status()).toBe(200); expect((await upload(page, f.field, requestId, body)).status).toBe(200);
  expect((await upload(page, f.field, randomUUID(), body)).status).toBe(404);
  expect((await upload(page, f.field, requestId, body + 'changed')).status).toBe(409);
  await login(page, f.author); expect((await page.request.get(saved.body.url)).status()).toBe(403);
  expect((await page.request.get(`/api/custom-fields/attachments/${requestId}`)).status()).toBe(404);
});

test('user file HTTP validates origin, CSRF, metadata, actual permissions and tenant/session boundaries', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager);
  const saved = await upload(page, f.field, randomUUID(), 'Synthetic'); expect(saved.status).toBe(201);
  expect((await upload(page, f.field, randomUUID(), 'x', { 'x-csrf-token': '' })).status).toBe(403);
  expect((await upload(page, f.field, randomUUID(), 'x', { 'x-file-name': '%ED%A0%80' })).status).toBe(400);
  expect((await upload(page, f.field, randomUUID(), 'x', { 'x-custom-field-revision': '0' })).status).toBe(400);
  expect((await upload(page, f.field, randomUUID(), 'x', { 'x-custom-field-id': 'invalid' })).status).toBe(400);
  expect((await page.request.post('/api/users/custom-fields/attachments', { headers: { origin: 'https://unrelated.invalid' }, data: 'x' })).status()).toBe(403);
  const reader = await createAccount(owner, { organizationId: f.author.organizationId, permissions: ['users.read'] }); await login(page, reader);
  expect((await page.request.get(saved.body.url)).status()).toBe(200); expect((await upload(page, f.field, randomUUID(), 'x')).status).toBe(403);
  const foreign = await createAccount(owner, { permissions: ['users.manage'] }); await login(page, foreign);
  expect((await page.request.get(saved.body.url)).status()).toBe(404); expect((await upload(page, f.field, randomUUID(), 'x')).status).toBe(404);
  await login(page, f.author); expect((await upload(page, f.field, randomUUID(), 'x')).status).toBe(403);
  await login(page, f.manager); await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.manager.organizationId, f.manager.roleId]);
  expect((await page.request.get(saved.body.url)).status()).toBe(403); expect((await upload(page, f.field, randomUUID(), 'x')).status).toBe(403);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.manager.userId]); expect((await page.request.get(saved.body.url)).status()).toBe(401);
  await page.context().clearCookies(); expect((await page.request.get(saved.body.url)).status()).toBe(401);
});

test('user file HTTP preserves empty and 20 MiB arbitrary originals, rejects overflow and limits inline previews', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager);
  for (const size of [0, 20 * 1024 * 1024]) {
    const saved = await upload(page, f.field, randomUUID(), size, { 'content-type': 'application/x-synthetic', 'x-file-name': 'original.bin' });
    expect(saved.status).toBe(201); expect(saved.body.byteLength).toBe(size);
    const response = await page.request.get(saved.body.url); const bytes = await response.body(); expect(response.status()).toBe(200);
    expect(bytes.equals(Buffer.alloc(size, 23))).toBe(true); expect(response.headers()['x-attachment-sha256']).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await page.request.get(saved.body.url + '?view=1')).headers()['content-disposition']).toMatch(/^attachment;/);
  }
  expect((await upload(page, f.field, randomUUID(), 20 * 1024 * 1024 + 1, { 'content-type': 'application/octet-stream' })).status).toBe(413);
  const pdf = await upload(page, f.field, randomUUID(), '%PDF-1.4\nSynthetic header only', { 'content-type': 'application/pdf', 'x-file-name': 'header.pdf' });
  expect(pdf.status).toBe(201); expect((await page.request.get(pdf.body.url + '?view=1')).headers()['content-disposition']).toMatch(/^inline;/);
  const svg = await upload(page, f.field, randomUUID(), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', { 'content-type': 'image/svg+xml', 'x-file-name': 'active.svg' });
  expect(svg.status).toBe(201); expect((await page.request.get(svg.body.url + '?view=1')).headers()['content-disposition']).toMatch(/^attachment;/);
});
