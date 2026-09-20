import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveProduct, loadProduct } from '../../src/masters/products.js';
import { saveTestParameter, loadTestParameter } from '../../src/masters/test-parameters.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const apis = { product: { save: saveProduct, load: loadProduct, resource: 'products', page: 'products' },
  parameter: { save: saveTestParameter, load: loadTestParameter, resource: 'test-parameters', page: 'test_parameters' } };
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
async function fixture(kind, uppercase = false) {
  const user = await createAccount(owner, { permissions: ['masters.manage'] });
  const people = [user, await createAccount(owner, { organizationId: user.organizationId }), await createAccount(owner, { organizationId: user.organizationId })];
  for (const [index, person] of people.entries()) await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [person.userId, ['Saved Alpha', 'Saved Beta', 'Draft Gamma'][index]]);
  const actor = { ...user, ...await signIn({ identifier: user.username, password: user.password }) }; const api = apis[kind]; const id = randomUUID();
  const fields = []; const definitions = [];
  for (const index of [0, 1]) {
    const definition = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: `people_${index}`, label: index ? 'Clear users' : 'Saved users',
      associatedWith: kind, fieldType: 'multi_user_select', displayOrder: index };
    definitions.push(definition); fields.push(await work(actor, (c, i) => saveCustomField(c, i, definition)));
  }
  const values = [[uppercase ? people[0].userId.toUpperCase() : people[0].userId, people[1].userId, people[1].userId], [people[0].userId]];
  const saved = await work(actor, (c, i) => api.save(c, i, { id, key: randomUUID(), requestId: randomUUID(), revision: 0, name: 'User key master',
    ...(kind === 'parameter' ? { schemeAbbreviation: 'Users' } : {}), customFields: fields.map((field, index) => ({ fieldId: field.id, fieldRevision: 1, value: values[index] })) }));
  return { kind, actor, api, id, people, fields, values, saved, url: `/${api.page}/${id}/edit`,
    read: atRevision => work(actor, (c, i) => api.load(c, i, id, { atRevision }), true),
    define: async (index, changes) => { definitions[index] = { ...definitions[index], ...changes, revision: fields[index].revision, requestId: randomUUID() };
      fields[index] = await work(actor, (c, i) => saveCustomField(c, i, definitions[index])); },
    replace: index => work(actor, async (c, i) => {
      await retireCustomField(c, i, { id: fields[index].id, revision: fields[index].revision, requestId: randomUUID() });
      definitions[index] = { ...definitions[index], id: randomUUID(), revision: 0, requestId: randomUUID() }; fields[index] = await saveCustomField(c, i, definitions[index]);
    }) };
}
const control = (page, label = 'Saved users') => page.locator('.smplfy-form-field').filter({ has: page.getByRole('combobox', { name: label, exact: true }) });
async function open(page, f) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(f.actor.username);
  await page.getByLabel('Password', { exact: true }).fill(f.actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/); await page.goto(f.url); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
}
async function refresh(page, f) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/masters/${f.api.resource}/custom-fields`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); expect((await response).status()).toBe(200);
}
async function choose(page, label, name) {
  await page.getByLabel(label, { exact: true }).fill(name);
  await page.getByRole('listbox').getByRole('option', { name, exact: true }).click(); await page.getByLabel(label, { exact: true }).press('Escape');
}
async function clear(page, label) {
  await page.getByLabel(label, { exact: true }).click(); await page.getByRole('button', { name: /^Clear all/ }).click();
  await page.getByLabel(label, { exact: true }).press('Escape');
}
async function save(page, f) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/masters/${f.api.resource}` && result.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); expect((await response).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/${f.api.page}(?:\\?|$)`));
}

for (const kind of ['product', 'parameter']) {
  test(`${kind} replacement user fields retain saved selection order, duplicates and original history`, async ({ page }) => {
    const f = await fixture(kind); await f.replace(0); await f.replace(1); await open(page, f);
    await expect(control(page).getByText('Saved Alpha', { exact: true })).toBeVisible(); await expect(control(page).getByText('Saved Beta', { exact: true })).toBeVisible();
    await save(page, f); const current = await f.read(); expect(current.customFields.map(field => field.value)).toEqual(f.values);
    expect(current.customFields.map(field => field.fieldId)).toEqual(f.fields.map(field => field.id));
    expect((await f.read(1)).customFields).toEqual(f.saved.customFields);
  });

  test(`${kind} user refresh preserves explicit drafts and clears, then resets a renamed key`, async ({ page }) => {
    const f = await fixture(kind); await open(page, f); await clear(page, 'Saved users'); await choose(page, 'Saved users', 'Draft Gamma'); await clear(page, 'Clear users');
    await f.replace(0); await f.replace(1); await refresh(page, f);
    await expect(page.getByLabel('Saved users', { exact: true })).toHaveAttribute('id', `${kind}-custom-field-${f.fields[0].id}`);
    await expect(control(page).getByText('Draft Gamma', { exact: true })).toBeVisible();
    await expect(control(page, 'Clear users').getByText('Saved Alpha', { exact: true })).toHaveCount(0);
    await save(page, f); expect((await f.read()).customFields.map(field => field.value)).toEqual([[f.people[2].userId], []]);
    await page.goto(f.url); await f.define(0, { key: 'renamed_people' }); await refresh(page, f);
    await expect(control(page).getByText('Draft Gamma', { exact: true })).toHaveCount(0); await save(page, f);
    expect((await f.read()).customFields.map(field => field.value)).toEqual([[], []]); expect((await f.read(1)).customFields).toEqual(f.saved.customFields);
  });

  test(`${kind} UUID user aliases show names and bulk matching preserves untouched raw spelling`, async ({ page }) => {
    const f = await fixture(kind, true); await open(page, f);
    await expect(control(page).getByText('Saved Alpha', { exact: true })).toBeVisible(); await choose(page, 'Saved users', 'Draft Gamma');
    await save(page, f); expect((await f.read()).customFields[0].value).toEqual([...f.values[0], f.people[2].userId]);
    await page.goto(f.url); await page.getByLabel('Saved users', { exact: true }).fill('Saved Alpha');
    await expect(page.getByRole('listbox').getByRole('option', { name: 'Saved Alpha', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Deselect visible', exact: true }).click(); await page.getByLabel('Saved users', { exact: true }).press('Escape');
    await save(page, f); expect((await f.read()).customFields[0].value).toEqual([f.people[1].userId, f.people[1].userId, f.people[2].userId]);
    expect((await f.read(2)).customFields[0].value).toEqual([...f.values[0], f.people[2].userId]);
    expect((await f.read(1)).customFields).toEqual(f.saved.customFields);
  });
}
