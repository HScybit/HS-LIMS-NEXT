import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await closePool(); await owner.end(); });
async function fixture() {
  const author = await createAccount(owner, { permissions: ['masters.manage'] }); const session = await signIn({ identifier: author.username, password: author.password });
  const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'HTTP lookup laboratory')", [author.organizationId, lab]);
  const source = { id: randomUUID(), requestId: randomUUID(), revision: 0, sourceId: 'Original-http-' + randomUUID(), name: 'HTTP source',
    lines: [{ id: 'original-flat-A', label: 'Original browser label' }] };
  await withSession(session.token, (c, i) => saveLookupSourceObservation(c, i, source)); let sourceRevision = 1;
  const observe = lines => withSession(session.token, (c, i) => saveLookupSourceObservation(c, i, { ...source, requestId: randomUUID(), revision: sourceRevision++, lines }));
  const field = await withSession(session.token, (c, i) => saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'lookup_key',
    label: 'Lookup field', fieldType: 'lookup', associatedWith: 'users', lookupSourceId: source.id }));
  const fields = value => [{ fieldId: field.id, fieldRevision: 1, value }];
  const command = (value = 'original-flat-A', revision = 0) => ({ requestId: randomUUID(), revision, customFields: fields(value) });
  return { author, manager, person, lab, source, field, observe, fields, command, url: `/api/users/${person.userId}/custom-fields` };
}
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const patch = (page, url, input, headers = {}) => page.evaluate(async ({ url, input, headers }) => {
  const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('sampleify_csrf='))?.split('=')[1] ?? '';
  const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, ...headers }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}, { url, input, headers });
const read = async (page, url) => { const response = await page.request.get(url); expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toBe('no-store'); return response.json(); };
async function loseResponse(page, url) {
  await page.route('**' + url, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch(); if (response.status() !== 200) return route.fulfill({ response });
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost lookup response' } }) });
  });
}

test('lookup capture HTTP preserves pinned labels through lost responses, current changes, removal and reappearance', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager); const input = f.command();
  await loseResponse(page, f.url); expect((await patch(page, f.url, input)).status).toBe(503); await page.unroute('**' + f.url);
  await f.observe([{ id: 'original-flat-A', label: 'Changed browser label' }]);
  expect((await patch(page, f.url, input)).body.revision).toBe(1);
  const original = await read(page, f.url); expect(original.customFields[0].displayValue).toBe('Original browser label');
  expect(original.customFields[0].items[0]).toMatchObject({ lookupSourceId: f.source.id, lookupRevision: 1, lookupLineId: 'original-flat-A' });
  expect((await patch(page, f.url, f.command('original-flat-A', 1))).status).toBe(200);
  expect((await read(page, f.url)).customFields[0].displayValue).toBe('Changed browser label');
  await f.observe([]); expect((await patch(page, f.url, f.command('original-flat-A', 2))).status).toBe(200);
  const retained = (await read(page, f.url)).customFields[0]; expect(retained.displayValue).toBe('original-flat-A');
  expect(retained.items[0]).toMatchObject({ interpretationState: 'invalid', lookupSourceId: null, lookupRevision: null, lookupLineId: null });
  await f.observe([{ id: 'original-flat-A', label: 'Reappeared browser label' }]);
  expect((await patch(page, f.url, f.command('original-flat-A', 3))).status).toBe(200);
  expect((await read(page, f.url)).customFields[0].items[0].lookupRevision).toBe(4);
  expect(await read(page, f.url + '?atRevision=1')).toEqual(original);
  expect((await patch(page, f.url, input)).body.revision).toBe(1); expect((await read(page, f.url)).revision).toBe(4);
});

test('complete user form HTTP keeps lookup retries and account/profile changes atomic after a source clear', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager); const url = `/api/users/${f.person.userId}`;
  const input = { requestId: randomUUID(), revision: 1, profileRevision: 0, username: f.person.username, email: f.person.email,
    displayName: 'Atomic lookup browser', phone: 'Original lookup contact', defaultRoleId: f.person.roleId, laboratoryId: f.lab,
    customFieldRevision: 0, customFields: f.fields('original-flat-A') };
  await loseResponse(page, url); expect((await patch(page, url, input)).status).toBe(503); await page.unroute('**' + url); await f.observe([]);
  const retry = await patch(page, url, input); expect(retry.status).toBe(200); expect(retry.body.customFieldRevision).toBe(1);
  const original = await read(page, url + '/form'); expect(original.fieldCapture.customFields[0].displayValue).toBe('Original browser label');
  const next = { ...input, requestId: randomUUID(), revision: 2, profileRevision: 1, customFieldRevision: 1, displayName: 'Retained lookup browser', phone: 'Later contact' };
  const rejected = await patch(page, url, { ...next, customFields: f.fields('unseen-flat-line') });
  expect(rejected.status).toBe(400); expect(rejected.body.error.code).toBe('invalid_user_custom_field_lookup'); expect(await read(page, url + '/form')).toEqual(original);
  expect((await patch(page, url, next)).status).toBe(200); const current = await read(page, url + '/form');
  expect(current.profile.phone).toBe(next.phone); expect(current.account.displayName).toBe(next.displayName);
  expect(current.fieldCapture.customFields[0].items[0]).toMatchObject({ interpretationState: 'invalid', lookupSourceId: null });
  expect((await patch(page, url, input)).body).toEqual(retry.body); expect(await read(page, url + '/form')).toEqual(current);
});

test('lookup HTTP rejects fabricated references, unavailable selections, foreign users and missing authority', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager); const original = await read(page, f.url);
  for (const input of [f.command('unavailable'), { ...f.command(), customFields: [{ ...f.fields('original-flat-A')[0], lookupSourceId: f.source.id, lookupRevision: 1 }] }]) {
    expect((await patch(page, f.url, input)).status).toBe(400); expect(await read(page, f.url)).toEqual(original);
  }
  expect((await patch(page, f.url, f.command(), { 'x-csrf-token': '' })).status).toBe(403);
  expect((await patch(page, f.url, f.command())).status).toBe(200);
  const foreign = await createAccount(owner, { permissions: ['users.manage'] }); await login(page, foreign);
  expect((await page.request.get(f.url)).status()).toBe(404); expect((await patch(page, f.url, f.command())).status).toBe(404);
  await login(page, f.author); expect((await page.request.get(f.url)).status()).toBe(403); expect((await patch(page, f.url, f.command())).status).toBe(403);
  await login(page, f.person); expect((await read(page, f.url)).customFields[0].items[0].lookupSourceId).toBe(f.source.id);
  expect((await patch(page, f.url, f.command())).status).toBe(403);
});
