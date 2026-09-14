import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveUserCustomFields } from '../../src/users/custom-fields.js';
import { uploadUserFieldAttachment } from '../../src/users/custom-field-attachments.js';

let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await closePool(); await owner.end(); });
async function fixture(type) {
  const author = await createAccount(owner, { permissions: ['masters.manage'] }); const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.read'] });
  const authorSession = await signIn({ identifier: author.username, password: author.password }); const managerSession = await signIn({ identifier: manager.username, password: manager.password });
  const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'kept_key', label: 'Original field', fieldType: type, associatedWith: 'users',
    ...(type === 'select' ? { options: [{ id: randomUUID(), key: 'A', label: 'Original choice A' }] } : {}) };
  const field = await withSession(authorSession.token, (client, identity) => saveCustomField(client, identity, input));
  const content = Buffer.from('Exact original retained file');
  const file = type === 'attachment' ? await withSession(managerSession.token, (client, identity) => uploadUserFieldAttachment(client, identity,
    { requestId: randomUUID(), fieldId: field.id, fieldRevision: 1, originalName: 'Kept original.txt', mediaType: 'text/plain', content })) : null;
  const value = file?.id ?? 'A'; await withSession(managerSession.token, (client, identity) => saveUserCustomFields(client, identity, person.userId,
    { requestId: randomUUID(), revision: 0, customFields: [{ fieldId: field.id, fieldRevision: 1, value }] }));
  await withSession(authorSession.token, (client, identity) => saveCustomField(client, identity, { ...input, requestId: randomUUID(), revision: 1, key: 'renamed_key' }));
  await withSession(authorSession.token, (client, identity) => retireCustomField(client, identity, { id: field.id, requestId: randomUUID(), revision: 2 }));
  const current = await withSession(authorSession.token, (client, identity) => saveCustomField(client, identity, { ...input, id: randomUUID(), requestId: randomUUID(),
    label: 'Replacement field', ...(type === 'select' ? { options: [{ id: randomUUID(), key: 'B', label: 'Replacement B' }] } : {}) }));
  return { manager, person, value, file, content, current, fields: [{ fieldId: current.id, fieldRevision: 1, value }] };
}
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const patch = (page, url, input) => page.evaluate(async ({ url, input }) => {
  const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('sampleify_csrf='))?.split('=')[1] ?? '';
  const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}, { url, input });
const read = async (page, url) => { const response = await page.request.get(url); expect(response.status()).toBe(200); return response.json(); };

test('retained dropdown HTTP recovers a complete-form lost response without replacing the original option history', async ({ page }) => {
  const f = await fixture('select'); await login(page, f.manager); const url = `/api/users/${f.person.userId}`;
  const input = { requestId: randomUUID(), revision: 1, profileRevision: 0, username: f.person.username, email: f.person.email,
    displayName: 'Retained browser identity', customFieldRevision: 1, customFields: f.fields };
  await page.route('**' + url, async route => {
    if (route.request().method() !== 'PATCH') return route.continue(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost retained form response' } }) });
  });
  expect((await patch(page, url, input)).status).toBe(503); await page.unroute('**' + url);
  const retry = await patch(page, url, input); expect(retry.status).toBe(200); expect(retry.body.customFieldRevision).toBe(2);
  const current = await read(page, url + '/form'); expect(current.account.displayName).toBe(input.displayName);
  expect(current.fieldCapture.customFields[0].items[0]).toMatchObject({ value: 'A', interpretationState: 'invalid', optionId: null, optionLabel: null });
  expect((await read(page, url + '/custom-fields?atRevision=1')).customFields[0].items[0].optionLabel).toBe('Original choice A');
  const failed = await patch(page, url, { ...input, requestId: randomUUID(), revision: 2, customFieldRevision: 2, customFields: [{ ...f.fields[0], value: 'new unknown value' }] });
  expect(failed.status).toBe(400); expect(failed.body.error.code).toBe('invalid_user_custom_field_option'); expect(await read(page, url + '/form')).toEqual(current);
  expect((await patch(page, url, { ...input, requestId: randomUUID(), revision: 2, customFieldRevision: 2, customFields: [{ ...f.fields[0], value: 'B' }] })).status).toBe(200);
  expect((await read(page, url + '/form')).fieldCapture.customFields[0].items[0]).toMatchObject({ value: 'B', interpretationState: 'valid', optionLabel: 'Replacement B' });
});

test('retained attachment HTTP keeps original bytes and cannot be introduced through another user without prior history', async ({ page }) => {
  const f = await fixture('attachment'); await login(page, f.manager); const url = `/api/users/${f.person.userId}/custom-fields`;
  const input = { requestId: randomUUID(), revision: 1, customFields: f.fields }; const saved = await patch(page, url, input); expect(saved.status).toBe(200); expect(saved.body.revision).toBe(2);
  expect(await patch(page, url, input)).toEqual(saved); const current = await read(page, url); const attachment = current.customFields[0].items[0].attachment;
  expect(attachment.originalName).toBe('Kept original.txt'); const response = await page.request.get(attachment.url); expect(response.status()).toBe(200);
  const bytes = await response.body(); expect(bytes.equals(f.content)).toBe(true); expect(response.headers()['x-attachment-sha256']).toBe(createHash('sha256').update(f.content).digest('hex'));
  const other = await createAccount(owner, { organizationId: f.manager.organizationId, permissions: [] });
  const failure = await patch(page, `/api/users/${other.userId}/custom-fields`, { ...input, requestId: randomUUID(), revision: 0 });
  expect(failure.status).toBe(400); expect(failure.body.error.code).toBe('invalid_user_custom_field_attachment');
  expect((await read(page, `/api/users/${other.userId}/custom-fields`)).recorded).toBe(false); expect(await read(page, url)).toEqual(current);
});
