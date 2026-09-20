import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await closePool(); await owner.end(); });
async function fixture() {
  const author = await createAccount(owner, { permissions: ['masters.manage'] });
  const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'HTTP complete form')", [author.organizationId, lab]);
  const session = await signIn({ identifier: author.username, password: author.password });
  const field = await withSession(session.token, (client, identity) => saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
    key: 'form_value', label: 'Form value', fieldType: 'text', associatedWith: 'users', isRequired: true, allowsMultiple: true }));
  const input = (target = person) => ({ requestId: randomUUID(), revision: 1, profileRevision: 0, username: target.username, email: target.email,
    displayName: 'HTTP complete form subject', phone: 'Saved contact', defaultRoleId: target.roleId, laboratoryId: lab, customFieldRevision: 0,
    customFields: [{ fieldId: field.id, fieldRevision: 1, value: ['original', 0, false] }] });
  return { manager, person, field, input };
}
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const save = (page, id, input) => page.evaluate(async ({ id, input }) => {
  const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('sampleify_csrf='))?.split('=')[1] ?? '';
  const response = await fetch(`/api/users/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}, { id, input });
const read = async (page, id) => {
  const response = await page.request.get(`/api/users/${id}/form`); expect(response.status()).toBe(200); return response.json();
};

test('complete form HTTP recovers a lost response with one linked account, profile and capture', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager); const input = f.input(); const url = `**/api/users/${f.person.userId}`;
  await page.route(url, async route => {
    if (route.request().method() !== 'PATCH') return route.continue(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost form response' } }) });
  });
  expect((await save(page, f.person.userId, input)).status).toBe(503); await page.unroute(url);
  const retry = await save(page, f.person.userId, input); expect(retry.status).toBe(200);
  expect(retry.body).toEqual({ id: f.person.userId, revision: 2, profileRevision: 1, customFieldRevision: 1, passwordChanged: false });
  const form = await read(page, f.person.userId); expect(form.fieldCapture.customFields[0].value).toEqual(['original', 0, false]); expect(form.profile.phone).toBe(input.phone);
  expect(form.fieldCapture.savedBy).toBe(f.manager.userId); expect(form.account.displayName).toBe(input.displayName);
  for (const [table, column] of [['user_account_commands', 'user_id'], ['user_profile_versions', 'user_id'], ['user_field_value_versions', 'subject_user_id']]) {
    expect((await owner.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [f.person.userId])).rowCount).toBe(1);
  }
  const omitted = { ...input }; delete omitted.customFields; delete omitted.customFieldRevision;
  for (const changed of [omitted, { ...input, phone: 'Changed retry' }, { ...input, customFields: [{ ...input.customFields[0], value: ['different'] }] }]) {
    const response = await save(page, f.person.userId, changed); expect(response.status).toBe(409); expect(response.body.error.code).toBe('save_request_reused');
  }
  expect(await read(page, f.person.userId)).toEqual(form);
});

test('complete form HTTP validates fields, stale revisions and the actual 8 MiB limit with no partial state', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager); const input = f.input(); const before = await read(page, f.person.userId);
  const cases = [
    [{ customFields: [] }, 409, 'user_custom_fields_changed'],
    [{ customFields: [{ ...input.customFields[0], value: [] }] }, 400, 'invalid_custom_field_value'],
    [{ customFields: [{ ...input.customFields[0], fieldRevision: 2 }] }, 409, 'user_custom_fields_changed'],
    [{ email: f.manager.email, password: 'Must remain unchanged' }, 409, 'sign_in_identifier_taken'],
    [{ customFields: [{ ...input.customFields[0], value: 'x'.repeat(8 * 1_048_576) }] }, 413],
  ];
  for (const [changes, status, code] of cases) {
    const response = await save(page, f.person.userId, { ...input, ...changes }); expect(response.status).toBe(status);
    if (code) expect(response.body.error.code).toBe(code); expect(await read(page, f.person.userId)).toEqual(before);
  }
  const response = await save(page, f.person.userId, input); expect(response.status).toBe(200);
  const saved = await read(page, f.person.userId); expect(saved.fieldCapture.revision).toBe(1);
  expect((await save(page, f.person.userId, { ...input, requestId: randomUUID(), revision: 2, profileRevision: 1 })).status).toBe(409);
  expect(await read(page, f.person.userId)).toEqual(saved);
  await login(page, f.person); expect((await page.request.get('/api/auth/session')).status()).toBe(200);
  expect((await save(page, f.person.userId, input)).status).toBe(403);
});

test('self password form HTTP commits the typed capture and exact retry keeps the new browser session', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager); const input = { ...f.input(f.manager), password: 'Synthetic self form fields password' };
  const saved = await save(page, f.manager.userId, input); expect(saved.status).toBe(200); expect(saved.body.customFieldRevision).toBe(1); expect(saved.body.passwordChanged).toBe(true);
  expect((await page.request.get('/api/auth/session')).status()).toBe(401); await login(page, { ...f.manager, password: input.password });
  const retry = await save(page, f.manager.userId, input); expect(retry).toEqual(saved); expect((await page.request.get('/api/auth/session')).status()).toBe(200);
  const form = await read(page, f.manager.userId); expect(form.account.revision).toBe(2); expect(form.profile.revision).toBe(1); expect(form.fieldCapture.revision).toBe(1);
});
