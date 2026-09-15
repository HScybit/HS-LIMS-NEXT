import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveProduct, loadProduct } from '../../src/masters/products.js';
import { saveTestParameter, loadTestParameter } from '../../src/masters/test-parameters.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const apis = { product: { resource: 'products', page: 'products', save: saveProduct, load: loadProduct },
  parameter: { resource: 'test-parameters', page: 'test_parameters', save: saveTestParameter, load: loadTestParameter } };
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function fixture(page, name = ' Élodie_Straße/Åsa-\tJOSÉ ') {
  const actor = await createAccount(owner, { permissions: ['masters.manage'] }); const selected = await createAccount(owner, { organizationId: actor.organizationId, permissions: [] });
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [selected.userId, name]);
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [actor.organizationId, selected.userId]);
  await login(page, actor); return { actor, selected, name };
}
const request = async (page, api, query = '') => {
  const response = await page.request.get(`/api/masters/${api.resource}/custom-field-users${query}`);
  return { status: response.status(), cache: response.headers()['cache-control'], body: await response.json() };
};
const search = (page, api, value) => request(page, api, '?search=' + encodeURIComponent(value));

for (const [kind, api] of Object.entries(apis)) {
  test(`${kind} user HTTP search matches cleaned accents and IDs while retaining raw names and inactive members`, async ({ page }) => {
    const f = await fixture(page); await owner.query('UPDATE users SET active=false WHERE id=$1', [f.selected.userId]);
    const expected = { status: 200, cache: 'no-store', body: { rows: [{ id: f.selected.userId, name: f.name }], hasMore: false } };
    for (const query of ['ELODIE', 'strase', '  asa jose  ', f.selected.userId.toUpperCase()]) expect(await search(page, api, query)).toEqual(expected);
    for (const query of ['asa  jose', 'strasse', '@example.invalid', '%']) expect((await search(page, api, query)).body).toEqual({ rows: [], hasMore: false });
  });

  test(`${kind} user HTTP search excludes separators removed from displayed labels`, async ({ page }) => {
    const f = await fixture(page, 'Literal_%_Person');
    expect((await search(page, api, '_%_')).body).toEqual({ rows: [], hasMore: false });
    expect((await search(page, api, 'literal % person')).body).toEqual({ rows: [{ id: f.selected.userId, name: f.name }], hasMore: false });
  });

  test(`${kind} user choices enforce authentication, masters authority and strict query shapes`, async ({ page }) => {
    await page.goto('/login'); expect((await request(page, api)).status).toBe(401);
    const userReader = await createAccount(owner, { permissions: ['users.read'] }); await login(page, userReader); expect((await request(page, api)).status).toBe(403);
    const f = await fixture(page);
    for (const query of ['?organizationId=' + userReader.organizationId, '?search=a&search=b', '?limit=5000', '?search=%00', '?search=' + 'x'.repeat(501)]) expect((await request(page, api, query)).status).toBe(400);
    expect((await search(page, api, 'x'.repeat(500))).status).toBe(200);
    expect((await search(page, api, userReader.userId)).body).toEqual({ rows: [], hasMore: false });
    await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.actor.userId]); expect((await request(page, api)).status).toBe(401);
  });

  test(`${kind} source user control selects an accent-insensitive match and finds its uppercase UUID`, async ({ page }) => {
    const f = await fixture(page); const actor = { ...f.actor, ...await signIn({ identifier: f.actor.username, password: f.actor.password }) };
    const work = (action, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
    const field = await work((client, identity) => saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key: 'people', label: 'Selected users', associatedWith: kind, fieldType: 'multi_user_select' }));
    const master = await work((client, identity) => api.save(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key: randomUUID(), name: 'User search master', ...(kind === 'parameter' ? { schemeAbbreviation: randomUUID() } : {}),
      customFields: [{ fieldId: field.id, fieldRevision: 1, value: [] }] }));
    await page.goto(`/${api.page}/${master.id}/edit`); const control = page.getByLabel('Selected users', { exact: true });
    await control.fill('elodie strase'); await page.getByRole('listbox').getByRole('option', { name: 'Élodie Straße Åsa JOSÉ', exact: true }).click();
    await control.fill(f.selected.userId.toUpperCase()); await expect(page.getByRole('listbox').getByRole('option', { name: 'Élodie Straße Åsa JOSÉ', exact: true })).toHaveAttribute('aria-selected', 'true');
    await control.press('Escape'); const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/masters/${api.resource}` && result.request().method() === 'POST');
    await page.getByRole('button', { name: 'Update', exact: true }).click(); expect((await response).status()).toBe(200);
    expect((await work((client, identity) => api.load(client, identity, master.id), true)).customFields[0].value).toEqual([f.selected.userId]);
  });
}
