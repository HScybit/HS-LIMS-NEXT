import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createNablReferences, nablCommand } from '../helpers/nabl.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveNablCertification } from '../../src/compliance/nabl.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const endpoint = '/api/operations/nabl-certifications';
async function login(page, actor) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username); await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function fixture() {
  const actor = await createAccount(owner, { permissions: ['compliance.manage'] }); const session = await signIn({ identifier: actor.username, password: actor.password });
  const refs = await createNablReferences(owner, actor); const input = nablCommand({ scopes: [{ parameterId: refs.parameters[0].id, productIds: [refs.products[0].id], methodIds: [refs.methods[1].id] }] });
  const save = command => withSession(session.token, (client, identity) => saveNablCertification(client, identity, command), { csrfToken: session.csrfToken });
  return { actor, refs, input, save, certification: await save(input) };
}
async function choose(page, label, option) {
  const input = page.getByRole('combobox', { name: label, exact: true }); await input.fill(option);
  await page.getByRole('option', { name: option, exact: true }).click(); await input.press('Escape');
}

test('NABL source form retains paged scopes and exact upload/save/delete retries, including immutable file history', async ({ page }, info) => {
  test.setTimeout(90_000);
  const actor = await createAccount(owner, { permissions: ['compliance.manage'] }); const refs = await createNablReferences(owner, actor, { parameterCount: 12 });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); const choiceRequests = [];
  page.on('request', request => { if (request.url().endsWith(`${endpoint}/catalog`)) choiceRequests.push(request.postDataJSON()); });
  await login(page, actor); await page.goto('/nabl_certificates');
  await page.getByRole('button', { name: 'New NABL Certification', exact: true }).click();
  await expect(page.getByText('Parameter 1', { exact: true })).toBeVisible(); expect(choiceRequests.filter(input => input.kind !== 'parameter')).toHaveLength(0);
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('Valid From Date is required', { exact: true })).toBeVisible();
  await page.getByLabel('Valid From Date', { exact: true }).fill('29/02/2024'); await page.getByLabel('Valid To Date', { exact: true }).fill('16/09/2026');
  await choose(page, 'Products for Parameter 1', 'Product A');
  const firstRow = page.getByRole('row').filter({ has: page.getByText('Parameter 1', { exact: true }) }); await expect(firstRow).toContainText('NON NABL');
  await choose(page, 'MoA for Parameter 1', 'Method B'); await expect(firstRow.getByText('NABL', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click(); await choose(page, 'MoA for Parameter 11', 'Method A');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click(); await expect(firstRow).toContainText('Product A'); await expect(firstRow).toContainText('Method B');
  let uploadRequest;
  await page.route(`**${endpoint}/files`, async route => {
    uploadRequest = route.request().headers()['x-upload-request-id']; expect((await route.fetch()).status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost NABL upload' } }) });
  });
  const bytes = Buffer.from('Historical NABL scope bytes');
  await page.getByLabel('NABL Scope', { exact: true }).setInputFiles({ name: 'scope original.txt', mimeType: 'text/plain', buffer: bytes });
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText('Synthetic lost NABL upload'); await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  await page.unroute(`**${endpoint}/files`); const uploaded = page.waitForResponse(response => response.url().endsWith(`${endpoint}/files`));
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click(); const uploadResponse = await uploaded;
  expect(uploadResponse.request().headers()['x-upload-request-id']).toBe(uploadRequest); const file = await uploadResponse.json(); expect(file.replayed).toBe(true);
  let attempted;
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() !== 'POST') return route.continue(); attempted = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost NABL save' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText('Synthetic lost NABL save');
  await expect(firstRow).toContainText('Product A'); await page.unroute(`**${endpoint}`);
  const saved = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const response = await saved; expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual(attempted);
  const certification = await response.json(); expect(certification.validFrom).toBe('2024-02-29'); expect(certification.scopes).toHaveLength(2);
  expect(certification.scopes.map(row => row.parameterId)).toEqual([refs.parameters[0].id, refs.parameters[10].id]); expect(certification.scopes[1].accredited).toBe(false);
  await expect(page).toHaveURL(/\/nabl_certificates$/); await page.getByRole('link', { name: 'View', exact: true }).click(); await expect(page.getByRole('link', { name: 'scope original.txt', exact: true })).toBeVisible();
  await page.goto(`/nabl_certificates/${certification.id}/edit`); await expect(page.getByLabel('Valid From Date', { exact: true })).toHaveValue('29/02/2024');
  await page.screenshot({ path: info.outputPath('nabl-desktop.png'), fullPage: true, animations: 'disabled' }); await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('nabl-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Remove NABL Scope file', exact: true }).click(); await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page).toHaveURL(/\/nabl_certificates$/); await page.goto(`/nabl_certificates/${certification.id}/view`); await page.getByRole('link', { name: 'Previous revision', exact: true }).click();
  await expect(page.getByRole('link', { name: 'scope original.txt', exact: true })).toBeVisible();
  const downloaded = await page.request.get(file.url); expect(downloaded.status()).toBe(200); expect(await downloaded.body()).toEqual(bytes);
  expect(downloaded.headers()['content-security-policy']).toContain('sandbox'); expect(downloaded.headers()['x-content-type-options']).toBe('nosniff');
  await page.goto('/nabl_certificates'); await page.getByRole('button', { name: 'Delete', exact: true }).click(); let deletion;
  await page.route(`**${endpoint}/${certification.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue(); deletion = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost NABL delete' } }) });
  });
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Synthetic lost NABL delete');
  await page.unroute(`**${endpoint}/${certification.id}`); const removed = page.waitForResponse(response => response.url().endsWith(`${endpoint}/${certification.id}`) && response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); expect((await removed).request().postDataJSON()).toEqual(deletion);
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('link', { name: 'View', exact: true })).toHaveCount(0); expect(errors).toEqual([]);
});

test('NABL strict calendar input blocks invalid/reversed edits and keeps stale drafts until explicit reload', async ({ page }) => {
  const { actor, input, certification, save } = await fixture(); await login(page, actor);
  await page.route(`**${endpoint}/${certification.id}?editing=1`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic NABL load failure' } }) }));
  await page.goto(`/nabl_certificates/${certification.id}/edit`); await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText('Synthetic NABL load failure');
  await page.unroute(`**${endpoint}/${certification.id}?editing=1`); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  const from = page.getByLabel('Valid From Date', { exact: true }); const to = page.getByLabel('Valid To Date', { exact: true });
  await expect(from).toHaveValue('29/02/2024'); await to.fill('31/02/2026'); await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(to).toHaveValue('31/02/2026'); await expect(page.getByText('Valid To Date must be a valid date', { exact: true })).toBeVisible();
  await to.fill('28/02/2024'); await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.getByText('Valid To Date must be on or after Valid From Date.', { exact: true })).toBeVisible();
  await to.fill('29/02/2024'); await save({ ...input, revision: 1, requestId: randomUUID(), validTo: '2028-01-01' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText('The certification changed'); await expect(to).toHaveValue('29/02/2024');
  await page.getByRole('button', { name: 'Reload certification', exact: true }).click(); await expect(to).toHaveValue('01/01/2028');
  await from.fill('01/01/0001'); await to.fill('31/12/9999'); await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/nabl_certificates$/);
  await page.goto(`/nabl_certificates/${certification.id}/edit`); await expect(from).toHaveValue('01/01/0001'); await expect(to).toHaveValue('31/12/9999');
});

test('NABL readers and HTTP limits enforce tenant, CSRF, passive file and calendar boundaries', async ({ page }) => {
  test.setTimeout(60_000);
  const { actor, certification } = await fixture(); const foreign = await fixture(); const reader = await createAccount(owner, { organizationId: actor.organizationId, permissions: ['compliance.read'] });
  await login(page, reader); await page.goto('/nabl_certificates'); await expect(page.getByRole('heading', { name: 'NABL Certification Management', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New NABL Certification', exact: true })).toHaveCount(0); await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'View', exact: true }).click(); await expect(page.getByRole('cell', { name: '2024-02-29', exact: true })).toBeVisible();
  await page.goto(`/nabl_certificates/${certification.id}/edit`); await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText('permission');
  let csrf = (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
  let headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
  expect((await page.request.post(endpoint, { headers, data: {} })).status()).toBe(403);
  expect((await page.request.delete(`${endpoint}/${certification.id}`, { headers, data: { revision: 1, requestId: randomUUID() } })).status()).toBe(403);
  expect((await page.request.get(`${endpoint}/${foreign.certification.id}`)).status()).toBe(404); expect((await page.request.get(`${endpoint}/${foreign.certification.id}?revision=1`)).status()).toBe(404);
  expect((await page.request.post(`${endpoint}/files`, { headers, data: Buffer.alloc(0) })).status()).toBe(403);
  await page.context().clearCookies(); await login(page, actor); csrf = (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
  headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
  expect((await page.request.post(endpoint, { data: nablCommand() })).status()).toBe(403);
  expect((await page.request.post(endpoint, { headers, data: nablCommand({ validTo: '2026-02-29' }) })).status()).toBe(400);
  expect((await page.request.post(endpoint, { headers: { ...headers, 'Content-Type': 'application/json' }, data: ' '.repeat(1_048_577) })).status()).toBe(413);
  const bytes = Buffer.alloc(25 * 1024 * 1024, 83);
  const uploaded = await page.request.post(`${endpoint}/files`, { headers: { ...headers, 'Content-Type': 'image/svg+xml', 'X-File-Name': encodeURIComponent('full λ.svg'), 'X-Upload-Request-Id': randomUUID() }, data: bytes });
  expect(uploaded.status()).toBe(201); const file = await uploaded.json(); const download = await page.request.get(`${file.url}?view=1`);
  expect(download.status()).toBe(200); expect(download.headers()['content-disposition']).toMatch(/^attachment;/); expect(download.headers()['content-length']).toBe(String(bytes.length));
  expect(createHash('sha256').update(await download.body()).digest('hex')).toBe(file.sha256);
  expect((await page.request.post(`${endpoint}/files`, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'large', 'X-Upload-Request-Id': randomUUID() }, data: Buffer.alloc(bytes.length + 1) })).status()).toBe(413);
});
