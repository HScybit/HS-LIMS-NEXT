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
  const reader = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'HTTP creation fields')", [author.organizationId, lab]);
  const session = await signIn({ identifier: author.username, password: author.password });
  const field = await withSession(session.token, (client, identity) => saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
    key: 'creation_value', label: 'Creation value', fieldType: 'text', associatedWith: 'users', isRequired: true, allowsMultiple: true }));
  const input = () => { const id = randomUUID(); return { id, requestId: randomUUID(), revision: 0, username: `http-create-field-${id}`, email: `${id}@example.invalid`,
    displayName: 'HTTP field user', password: 'Synthetic HTTP creation fields password', defaultRoleId: reader.roleId, laboratoryId: lab,
    customFields: [{ fieldId: field.id, fieldRevision: 1, value: ['original', 0, false] }] }; };
  return { author, manager, reader, field, input };
}
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const create = (page, input) => page.evaluate(async input => {
  const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('sampleify_csrf='))?.split('=')[1] ?? '';
  const response = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}, input);

test('HTTP creation recovers a lost response with one account and one typed capture, and the account can sign in', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager); const input = f.input();
  await page.route('**/api/users', async route => {
    if (route.request().method() !== 'POST') return route.continue(); expect((await route.fetch()).status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost creation response' } }) });
  });
  expect((await create(page, input)).status).toBe(503); await page.unroute('**/api/users');
  const retry = await create(page, input); expect(retry.status).toBe(201); expect(retry.body.customFieldRevision).toBe(1);
  const fields = await (await page.request.get(`/api/users/${input.id}/custom-fields`)).json(); expect(fields.customFields[0].value).toEqual(['original', 0, false]);
  expect(fields.savedBy).toBe(f.manager.userId);
  for (const [table, column] of [['user_creation_commands', 'user_id'], ['user_field_value_versions', 'subject_user_id']]) {
    expect((await owner.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [input.id])).rowCount).toBe(1);
  }
  expect((await create(page, { ...input, customFields: [{ ...input.customFields[0], value: ['different', 0, false] }] })).status).toBe(409);
  await login(page, input); expect((await page.request.get(`/api/users/${input.id}/custom-fields`)).status()).toBe(200);
});

test('HTTP creation field errors and the 8 MiB limit leave no partial account while omitted fields remain unrecorded', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager);
  for (const [customFields, status] of [[[], 409], [[{ fieldId: f.field.id, fieldRevision: 1, value: [] }], 400],
    [[{ fieldId: f.field.id, fieldRevision: 1, value: 'x'.repeat(8 * 1_048_576) }], 413]]) {
    const input = { ...f.input(), customFields }; expect((await create(page, input)).status).toBe(status);
    expect((await owner.query('SELECT 1 FROM users WHERE id=$1', [input.id])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM user_field_value_versions WHERE subject_user_id=$1', [input.id])).rowCount).toBe(0);
  }
  const omitted = f.input(); delete omitted.customFields; const saved = await create(page, omitted); expect(saved.status).toBe(201); expect(saved.body.customFieldRevision).toBeUndefined();
  expect((await (await page.request.get(`/api/users/${omitted.id}/custom-fields`)).json()).recorded).toBe(false);
  await login(page, f.reader); expect((await create(page, f.input())).status).toBe(403);
});
