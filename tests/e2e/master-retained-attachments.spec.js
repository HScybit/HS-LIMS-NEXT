import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveProduct, loadProduct } from '../../src/masters/products.js';
import { saveTestParameter, loadTestParameter } from '../../src/masters/test-parameters.js';
import { uploadCustomFieldAttachment } from '../../src/custom-fields/attachments.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const image = { name: 'Original विश्लेषण.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1kAAAAASUVORK5CYII=', 'base64') };
const apis = { product: { save: saveProduct, load: loadProduct, resource: 'products', page: 'products' },
  parameter: { save: saveTestParameter, load: loadTestParameter, resource: 'test-parameters', page: 'test_parameters' } };
async function fixture(kind, saved = false) {
  const user = await createAccount(owner, { permissions: ['masters.manage'] });
  const actor = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  let definition = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'saved_file', label: 'Saved file', fieldType: 'attachment', associatedWith: kind };
  let field = await work(actor, (c, i) => saveCustomField(c, i, definition)); const api = apis[kind]; const id = randomUUID();
  const file = saved ? await work(actor, (c, i) => uploadCustomFieldAttachment(c, i, { requestId: randomUUID(), fieldId: field.id,
    fieldRevision: 1, originalName: image.name, mediaType: image.mimeType, content: image.buffer })) : null;
  const original = await work(actor, (c, i) => api.save(c, i, { id, key: randomUUID(), name: 'File key master', requestId: randomUUID(), revision: 0,
    ...(kind === 'parameter' ? { schemeAbbreviation: 'Files' } : {}), customFields: [{ fieldId: field.id, fieldRevision: 1, value: file?.id.toUpperCase() ?? '' }] }));
  return { kind, actor, api, id, file, original, field: () => field, url: `/${api.page}/${id}/edit`,
    read: atRevision => work(actor, (c, i) => api.load(c, i, id, { atRevision }), true),
    define: async changes => { definition = { ...definition, ...changes, revision: field.revision, requestId: randomUUID() };
      field = await work(actor, (c, i) => saveCustomField(c, i, definition)); },
    replace: async () => work(actor, async (c, i) => {
      await retireCustomField(c, i, { id: field.id, revision: field.revision, requestId: randomUUID() });
      definition = { ...definition, id: randomUUID(), revision: 0, requestId: randomUUID() }; field = await saveCustomField(c, i, definition);
    }),
    retire: () => work(actor, (c, i) => retireCustomField(c, i, { id: field.id, revision: field.revision, requestId: randomUUID() })) };
}
async function open(page, f) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(f.actor.username);
  await page.getByLabel('Password', { exact: true }).fill(f.actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/); await page.goto(f.url); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
}
async function refresh(page, f) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/masters/${f.api.resource}/custom-fields`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); expect((await response).status()).toBe(200);
}
async function metadata(page, file) {
  await expect(page.getByRole('button', { name: image.name, exact: true })).toBeVisible();
  const preview = page.getByRole('img', { name: image.name, exact: true }); await expect(preview).toBeVisible();
  await expect(preview).toHaveJSProperty('naturalWidth', 1);
  const link = page.getByRole('link', { name: 'Download File', exact: true }); await expect(link).toHaveAttribute('href', `/api/custom-fields/attachments/${file.id}`);
  const response = await page.request.get(await link.getAttribute('href')); expect(response.status()).toBe(200); expect(await response.body()).toEqual(image.buffer);
}
async function upload(page) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/custom-fields/attachments' && result.request().method() === 'POST');
  await page.getByLabel('Saved file', { exact: true }).setInputFiles(image); const result = await response;
  expect(result.status()).toBe(201); return result.json();
}
async function save(page, f, status = 200) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/masters/${f.api.resource}` && result.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); expect((await response).status()).toBe(status);
  if (status === 200) await expect(page).toHaveURL(new RegExp(`/${f.api.page}(?:\\?|$)`));
}

for (const kind of ['product', 'parameter']) {
  test(`${kind} replaced attachment fields load original filenames, previews and bytes and save frozen history`, async ({ page }) => {
    const f = await fixture(kind, true); await f.replace(); await open(page, f); await metadata(page, f.file); await save(page, f);
    const current = await f.read(); expect(current.customFields[0].fieldId).toBe(f.field().id); expect(current.customFields[0].value).toBe(f.file.id.toUpperCase());
    expect((await f.read(1)).customFields).toEqual(f.original.customFields); await page.goto(f.url); await metadata(page, f.file);
  });

  test(`${kind} fresh file metadata survives definition refresh and a lost master-save response`, async ({ page }) => {
    const f = await fixture(kind); await open(page, f); const file = await upload(page); await metadata(page, file);
    await f.define({ scheme: '"Unused"' }); await refresh(page, f); await metadata(page, file);
    await f.replace(); await refresh(page, f);
    await f.define({ scheme: '' }); await refresh(page, f); await metadata(page, file);
    await expect(page.getByLabel('Saved file', { exact: true })).toHaveAttribute('id', `${kind}-custom-field-${f.field().id}`); await metadata(page, file);
    let first;
    const path = `**/api/masters/${f.api.resource}`;
    await page.route(path, async route => {
      first = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost save response' } }) });
    });
    await save(page, f, 503); await expect(page.getByRole('alert').filter({ hasText: 'Synthetic lost save response' })).toBeVisible(); await metadata(page, file);
    await page.unroute(path); let retry;
    page.on('request', request => { if (new URL(request.url()).pathname === `/api/masters/${f.api.resource}` && request.method() === 'POST') retry = request.postDataJSON(); });
    await save(page, f); expect(retry).toEqual(first); expect((await f.read()).revision).toBe(2); expect((await f.read()).customFields[0].value).toBe(file.id);
    expect((await f.read(1)).customFields).toEqual(f.original.customFields); await page.goto(f.url); await metadata(page, file);
  });

  test(`${kind} an uncertain upload retains its exact original request after field replacement`, async ({ page }) => {
    const f = await fixture(kind); await open(page, f); let first; let file;
    await page.route('**/api/custom-fields/attachments', async route => {
      first = route.request().headers(); const response = await route.fetch(); expect(response.status()).toBe(201); file = await response.json();
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost upload response' } }) });
    });
    await page.getByLabel('Saved file', { exact: true }).setInputFiles(image); await expect(page.getByRole('alert').filter({ hasText: 'Synthetic lost upload response' })).toBeVisible();
    await page.unroute('**/api/custom-fields/attachments'); await f.replace(); await refresh(page, f);
    await expect(page.getByLabel('Saved file', { exact: true })).toHaveAttribute('id', `${kind}-custom-field-${f.field().id}`);
    const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/custom-fields/attachments');
    await page.getByRole('button', { name: 'Retry upload', exact: true }).click(); const result = await response; expect(result.status()).toBe(200);
    for (const key of ['x-upload-request-id', 'x-custom-field-id', 'x-custom-field-revision', 'x-file-name']) expect(result.request().headers()[key]).toBe(first[key]);
    expect((await result.json()).replayed).toBe(true); await metadata(page, file); await save(page, f); expect((await f.read()).customFields[0].value).toBe(file.id);
  });

  test(`${kind} cleared file drafts survive replacement and renamed or removed keys discard their draft`, async ({ page }) => {
    const f = await fixture(kind, true); await open(page, f); await metadata(page, f.file);
    await page.getByRole('button', { name: 'Remove Saved file file', exact: true }).first().click(); await f.replace(); await refresh(page, f);
    await expect(page.getByLabel('Saved file', { exact: true })).toHaveAttribute('id', `${kind}-custom-field-${f.field().id}`);
    await expect(page.getByRole('link', { name: 'Download File' })).toHaveCount(0);
    const file = await upload(page); await metadata(page, file); await f.define({ key: 'renamed_file' }); await refresh(page, f);
    await expect(page.getByRole('link', { name: 'Download File' })).toHaveCount(0); await f.retire(); await refresh(page, f);
    await expect(page.getByLabel('Saved file', { exact: true })).toHaveCount(0); await save(page, f);
    expect((await f.read()).customFields).toEqual(f.original.customFields); expect((await f.read(1)).customFields).toEqual(f.original.customFields);
  });
}
