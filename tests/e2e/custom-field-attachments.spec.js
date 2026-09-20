import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function fixture() {
  const account = await createAccount(owner, { permissions: ['masters.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const field = await withSession(session.token, (client, identity) => saveCustomField(client, identity, { id: randomUUID(), revision: 0,
    requestId: randomUUID(), key: 'browser_attachment', label: 'Synthetic browser attachment', associatedWith: 'product', fieldType: 'attachment' }), { csrfToken: session.csrfToken });
  return { account, session, field };
}
async function login(page, account) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function upload(page, field, requestId, body, extraHeaders = {}) {
  return page.evaluate(async ({ field, requestId, body, extraHeaders }) => {
    const csrf = document.cookie.split('; ').find((cookie) => cookie.startsWith('sampleify_csrf='))?.split('=')[1] ?? '';
    const response = await fetch('/api/custom-fields/attachments', { method: 'POST', headers: { 'x-csrf-token': csrf,
      'x-upload-request-id': requestId, 'x-custom-field-id': field.id, 'x-custom-field-revision': String(field.revision),
      'x-file-name': encodeURIComponent('Synthetic विश्लेषण.html'), 'content-type': 'text/html', ...extraHeaders }, body });
    return { status: response.status, body: await response.json() };
  }, { field, requestId, body, extraHeaders });
}

test('attachment browser endpoints recover a lost upload response and download immutable bytes after definition retirement', async ({ page }) => {
  const { account, session, field } = await fixture(); await login(page, account);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const requestId = randomUUID(); const body = '<!doctype html><script>window.syntheticAttachmentExecuted=true</script>\nSynthetic file';
  await page.route('**/api/custom-fields/attachments', async (route) => {
    expect((await route.fetch()).status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost upload response' } }) });
  });
  expect((await upload(page, field, requestId, body)).status).toBe(503);
  await page.unroute('**/api/custom-fields/attachments');
  const retry = await upload(page, field, requestId, body); expect(retry.status).toBe(200); expect(retry.body.replayed).toBe(true);
  expect(retry.body.id).toBe(requestId); expect(retry.body.byteLength).toBe(Buffer.byteLength(body));
  expect(Object.hasOwn(retry.body, 'content')).toBe(false);
  const read = await page.request.get(retry.body.url); expect(read.status()).toBe(200); expect(await read.body()).toEqual(Buffer.from(body));
  expect(read.headers()['content-disposition']).toContain('attachment;');
  expect(read.headers()['content-security-policy']).toBe("default-src 'none'; sandbox");
  expect(read.headers()['x-content-type-options']).toBe('nosniff'); expect(read.headers()['cache-control']).toBe('private, no-store');
  const downloading = page.waitForEvent('download');
  await page.evaluate((url) => { const link = document.createElement('a'); link.href = url; document.body.append(link); link.click(); link.remove(); }, `${retry.body.url}?view=1`);
  const download = await downloading; expect(download.suggestedFilename()).toBe('Synthetic विश्लेषण.html');
  expect(await readFile(await download.path())).toEqual(Buffer.from(body));
  expect(await page.evaluate(() => window.syntheticAttachmentExecuted)).toBeUndefined();
  await withSession(session.token, (client, identity) => retireCustomField(client, identity, { id: field.id, revision: 1, requestId: randomUUID() }), { csrfToken: session.csrfToken });
  const historical = await page.request.get(retry.body.url); expect(historical.status()).toBe(200); expect(await historical.body()).toEqual(Buffer.from(body));
  expect((await upload(page, field, requestId, body)).status).toBe(200);
  expect((await upload(page, field, randomUUID(), body)).status).toBe(404);
  expect(errors).toEqual([]);
});

test('attachment HTTP endpoints enforce sessions, CSRF, origin, roles, tenants, metadata and empty-file semantics', async ({ page, browser }) => {
  const { account, field } = await fixture(); await login(page, account);
  expect((await upload(page, field, randomUUID(), '', { 'content-type': 'application/octet-stream', 'x-file-name': 'empty.bin' })).status).toBe(201);
  expect((await upload(page, field, randomUUID(), 'x', { 'x-csrf-token': '' })).status).toBe(403);
  expect((await upload(page, field, randomUUID(), 'x', { 'x-file-name': '%ED%A0%80' })).status).toBe(400);
  expect((await page.request.post('/api/custom-fields/attachments', { headers: { origin: 'https://unrelated.invalid' }, data: 'x' })).status()).toBe(403);
  const saved = await upload(page, field, randomUUID(), 'Synthetic'); expect(saved.status).toBe(201);
  const anonymous = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' }); const anonymousPage = await anonymous.newPage();
  try {
    expect((await anonymousPage.request.get(`http://127.0.0.1:3100${saved.body.url}`)).status()).toBe(401);
    const other = await createAccount(owner, { permissions: ['masters.read', 'masters.manage'] });
    await login(anonymousPage, other); expect((await anonymousPage.request.get(saved.body.url)).status()).toBe(404);
    expect((await upload(anonymousPage, field, randomUUID(), 'Synthetic')).status).toBe(404);
  } finally { await anonymous.close(); }
  const viewer = await createAccount(owner, { organizationId: account.organizationId, permissions: ['masters.read'] });
  const reader = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' }); const readerPage = await reader.newPage();
  try {
    await login(readerPage, viewer); expect((await readerPage.request.get(saved.body.url)).status()).toBe(200);
    expect((await upload(readerPage, field, randomUUID(), 'Synthetic')).status).toBe(403);
  } finally { await reader.close(); }
});
