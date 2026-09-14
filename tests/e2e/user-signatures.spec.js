import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] }); return { admin, person };
}
const uploadHeaders = (headers, requestId, revision, name = '本人署名.html', type = 'text/html') => ({ ...headers,
  'x-upload-request-id': requestId, 'x-signature-revision': String(revision), 'x-file-name': encodeURIComponent(name), 'content-type': type });

test('concurrent signature HTTP uploads and later removal preserve exact original browser downloads', async ({ page }) => {
  const { admin, person } = await fixture(); const headers = await login(page, admin); const url = `/api/users/${person.userId}/signature`;
  const requestId = randomUUID(); const body = Buffer.from('<html><script>window.signatureExecuted = true</script>Original file</html>');
  const options = { headers: uploadHeaders(headers, requestId, 0), data: body };
  const responses = await Promise.all([page.request.post(url, options), page.request.post(url, options)]);
  for (const response of responses) { expect(response.status()).toBe(201); expect(await response.json()).toEqual({ id: person.userId, revision: 1, fileId: requestId }); }
  const current = await (await page.request.get(url)).json(); expect(current.file.originalName).toBe('本人署名.html'); expect(current.file.byteLength).toBe(body.length);
  const stored = await page.request.get(current.file.url); expect(stored.status()).toBe(200); expect((await stored.body()).equals(body)).toBe(true);
  expect(stored.headers()['content-disposition']).toMatch(/^attachment;/); expect(stored.headers()['content-security-policy']).toBe("default-src 'none'; sandbox");
  expect(stored.headers()['x-content-type-options']).toBe('nosniff'); expect(stored.headers()['cache-control']).toBe('private, no-store');
  const removal = { requestId: randomUUID(), revision: 1 }; expect((await page.request.delete(url, { headers, data: removal })).status()).toBe(200);
  expect(await (await page.request.get(url)).json()).toEqual({ id: person.userId, revision: 2, file: null });
  expect(await (await page.request.post(url, options)).json()).toEqual({ id: person.userId, revision: 1, fileId: requestId });
  expect((await (await page.request.get(url)).json()).revision).toBe(2);
  const downloading = page.waitForEvent('download');
  await page.evaluate((href) => { const link = document.createElement('a'); link.href = href; document.body.append(link); link.click(); link.remove(); }, current.file.url);
  const download = await downloading; expect(download.suggestedFilename()).toBe('本人署名.html'); expect((await readFile(await download.path())).equals(body)).toBe(true);
  expect(await page.evaluate(() => window.signatureExecuted)).toBeUndefined();
  const history = await (await page.request.get(`${url}/history?limit=1`)).json(); expect(history.rows[0].operation).toBe('remove'); expect(history.rows[0].file).toBeNull();
  expect(history.nextBeforeRevision).toBe(2);
  const older = await (await page.request.get(`${url}/history?beforeRevision=2`)).json(); expect(older.rows[0].file.id).toBe(requestId); expect(older.rows[0].savedBy).toBe(admin.userId);
});

test('signature HTTP transfers preserve empty files and the full 20 MiB boundary without file bytes in metadata', async ({ page }) => {
  const { admin, person } = await fixture(); const headers = await login(page, admin); const url = `/api/users/${person.userId}/signature`; let revision = 0;
  for (const body of [Buffer.alloc(0), Buffer.alloc(20 * 1024 * 1024, 67)]) {
    const requestId = randomUUID(); const result = await page.request.post(url, { headers: uploadHeaders(headers, requestId, revision, 'binary.bin', 'application/octet-stream'), data: body });
    expect(result.status()).toBe(201); revision++;
    const metadata = await (await page.request.get(url)).json(); expect(metadata.revision).toBe(revision); expect(metadata.file.byteLength).toBe(body.length);
    expect(Object.keys(metadata.file).sort()).toEqual(['id', 'originalName', 'mediaType', 'byteLength', 'sha256', 'url'].sort());
    const response = await page.request.get(metadata.file.url); expect(response.status()).toBe(200);
    expect(response.headers()['content-length']).toBe(String(body.length)); expect((await response.body()).equals(body)).toBe(true);
    expect(metadata.file.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  }
  const oversized = await page.request.post(url, { headers: uploadHeaders(headers, randomUUID(), revision, 'large.bin', 'application/octet-stream'), data: Buffer.alloc(20 * 1024 * 1024 + 1) });
  expect(oversized.status()).toBe(413); expect((await (await page.request.get(url)).json()).revision).toBe(2);
});

test('signature HTTP rejects CSRF/origin, bad headers, stale requests, foreign scope and actual permission revocation', async ({ page }) => {
  const { admin, person } = await fixture(); const foreign = await createAccount(owner, { permissions: ['users.manage'] });
  let headers = await login(page, admin); const url = `/api/users/${person.userId}/signature`; const requestId = randomUUID();
  const options = { headers: uploadHeaders(headers, requestId, 0), data: Buffer.from('Attachment bytes') };
  expect((await page.request.post(url, { data: 'x' })).status()).toBe(403);
  expect((await page.request.post(url, { ...options, headers: { ...options.headers, 'x-csrf-token': 'invalid' } })).status()).toBe(403);
  expect((await page.request.post(url, { ...options, headers: { ...options.headers, origin: 'https://example.invalid' } })).status()).toBe(403);
  for (const changed of [{ 'x-signature-revision': '' }, { 'x-signature-revision': '-1' }, { 'x-upload-request-id': 'invalid' }, { 'x-file-name': '%invalid' }]) {
    expect((await page.request.post(url, { ...options, headers: { ...options.headers, ...changed } })).status()).toBe(400);
  }
  for (const suffix of ['', '/history']) expect((await page.request.get(`/api/users/${foreign.userId}/signature${suffix}`)).status()).toBe(404);
  expect((await page.request.post(`/api/users/${foreign.userId}/signature`, options)).status()).toBe(404);
  expect((await page.request.delete(url, { headers, data: { requestId: randomUUID(), revision: 0 } })).status()).toBe(409);
  expect((await page.request.post(url, options)).status()).toBe(201);
  expect((await page.request.post(url, { ...options, data: Buffer.from('Changed original bytes') })).status()).toBe(409);
  expect((await page.request.post(url, { ...options, headers: { ...options.headers, 'x-upload-request-id': randomUUID() } })).status()).toBe(409);
  expect((await page.request.get(`${url}/history?limit=101`)).status()).toBe(400);
  headers = await login(page, person); expect((await page.request.get(`/api/users/signature-files/${requestId}`)).status()).toBe(200);
  expect((await page.request.post(url, { ...options, headers: uploadHeaders(headers, randomUUID(), 1) })).status()).toBe(403);
  headers = await login(page, foreign); expect((await page.request.get(`/api/users/signature-files/${requestId}`)).status()).toBe(404);
  headers = await login(page, admin);
  await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='users.manage'", [admin.organizationId, admin.roleId]);
  expect((await page.request.delete(url, { headers, data: { requestId: randomUUID(), revision: 1 } })).status()).toBe(403);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [admin.userId]);
  expect((await page.request.get(url)).status()).toBe(401);
});
