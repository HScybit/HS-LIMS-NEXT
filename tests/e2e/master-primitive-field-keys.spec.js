import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveProduct, loadProduct } from '../../src/masters/products.js';
import { saveTestParameter, loadTestParameter } from '../../src/masters/test-parameters.js';

test.use({ timezoneId: 'America/New_York' });
let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const apis = { product: { save: saveProduct, load: loadProduct, resource: 'products', page: 'products' },
  parameter: { save: saveTestParameter, load: loadTestParameter, resource: 'test-parameters', page: 'test_parameters' } };
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const values = ['Saved title', 0, '2026-02-28', 'Line one\nLine two', '2026-03-08T02:30', false, 'saved@example.test', [0, false, '0x10', 'bad', 'bad']];
async function fixture(kind) {
  const user = await createAccount(owner, { permissions: ['masters.manage'] });
  const actor = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const definitions = ['text', 'number', 'date', 'longtext', 'date_time', 'checkbox', 'email', 'number'].map((fieldType, index) => ({
    id: randomUUID(), requestId: randomUUID(), revision: 0, associatedWith: kind, fieldType, key: `value_${index}`,
    label: `Stored ${index}`, displayOrder: index, allowsMultiple: index === 7 }));
  const fields = [];
  for (const definition of definitions) fields.push(await work(actor, (c, i) => saveCustomField(c, i, definition)));
  const api = apis[kind]; const id = randomUUID();
  const saved = await work(actor, (c, i) => api.save(c, i, { id, requestId: randomUUID(), revision: 0,
    name: 'Primitive key master', key: randomUUID(), ...(kind === 'parameter' ? { schemeAbbreviation: 'Primitive' } : {}),
    customFieldTimeZone: 'America/New_York', customFields: fields.map((field, index) => ({ fieldId: field.id, fieldRevision: 1, value: values[index] })) }));
  return { actor, api, id, definitions, saved, url: `/${api.page}/${id}/edit`,
    read: atRevision => work(actor, (c, i) => api.load(c, i, id, { atRevision }), true) };
}
async function open(page, f) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(f.actor.username);
  await page.getByLabel('Password', { exact: true }).fill(f.actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/); await page.goto(f.url);
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
}
async function replace(f, index) {
  const definition = f.definitions[index];
  const next = { ...definition, id: randomUUID(), requestId: randomUUID() };
  await work(f.actor, async (c, i) => {
    await retireCustomField(c, i, { id: definition.id, revision: 1, requestId: randomUUID() });
    await saveCustomField(c, i, next);
  });
  f.definitions[index] = next;
}
async function refresh(page, f) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/masters/${f.api.resource}/custom-fields`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); expect((await response).status()).toBe(200);
}
async function save(page, f) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/masters/${f.api.resource}` && result.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); expect((await response).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/${f.api.page}(?:\\?|$)`));
}

for (const kind of ['product', 'parameter']) {
  test(`${kind} primitive fields load saved keys after definition replacement and preserve history`, async ({ page }) => {
    const f = await fixture(kind);
    for (let index = 0; index < f.definitions.length; index++) await replace(f, index);
    await open(page, f);
    await expect(page.getByLabel('Stored 0', { exact: true })).toHaveValue('Saved title');
    await expect(page.getByLabel('Stored 1', { exact: true })).toHaveValue('0');
    await expect(page.getByLabel('Stored 2', { exact: true })).toHaveValue('28/02/2026');
    await expect(page.getByLabel('Stored 3', { exact: true })).toHaveValue('Line one\nLine two');
    await expect(page.getByLabel('Stored 4', { exact: true })).toHaveValue('2026-03-08T02:30');
    await expect(page.getByRole('checkbox', { name: 'Stored 5', exact: true })).not.toBeChecked();
    await expect(page.getByLabel('Stored 6', { exact: true })).toHaveValue('saved@example.test');
    await expect(page.getByLabel('Stored 7 item 5', { exact: true })).toHaveValue('bad');
    await save(page, f);
    const updated = await f.read(); expect(updated.customFields.map(field => field.value)).toEqual(values);
    expect(updated.customFields.map(field => field.fieldId)).toEqual(f.definitions.map(field => field.id));
    expect((await f.read(1)).customFields).toEqual(f.saved.customFields);
    await page.goto(f.url); await expect(page.getByLabel('Stored 0', { exact: true })).toHaveValue('Saved title');
  });

  test(`${kind} primitive refresh preserves explicit drafts by key and clears renamed or removed keys`, async ({ page }) => {
    const f = await fixture(kind); await open(page, f);
    await page.getByLabel('Stored 0', { exact: true }).fill('');
    await page.getByLabel('Stored 1', { exact: true }).fill('7');
    await page.getByLabel('Stored 1', { exact: true }).fill('0');
    await page.getByLabel('Stored 3', { exact: true }).fill('Unsaved notes');
    await page.getByRole('checkbox', { name: 'Stored 5', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Stored 5', exact: true }).uncheck();
    await page.getByLabel('Stored 7 item 1', { exact: true }).fill('Repeated draft');
    for (const index of [0, 1, 3, 5, 7]) await replace(f, index);
    await refresh(page, f);
    await expect(page.getByLabel('Stored 3', { exact: true })).toHaveAttribute('id', `${kind}-custom-field-${f.definitions[3].id}`);
    await expect(page.getByLabel('Stored 0', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Stored 1', { exact: true })).toHaveValue('0');
    await expect(page.getByLabel('Stored 3', { exact: true })).toHaveValue('Unsaved notes');
    await expect(page.getByRole('checkbox', { name: 'Stored 5', exact: true })).not.toBeChecked();
    await expect(page.getByLabel('Stored 7 item 1', { exact: true })).toHaveValue('Repeated draft');
    await work(f.actor, (c, i) => saveCustomField(c, i, { ...f.definitions[3], revision: 1, requestId: randomUUID(), key: 'renamed_notes', label: 'Renamed notes' }));
    await work(f.actor, (c, i) => retireCustomField(c, i, { id: f.definitions[6].id, revision: 1, requestId: randomUUID() }));
    await refresh(page, f); await expect(page.getByLabel('Renamed notes', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Stored 6', { exact: true })).toHaveCount(0);
    await save(page, f);
    const updated = await f.read(); const byKey = new Map(updated.customFields.map(field => [field.key, field.value]));
    expect(byKey.get('value_0')).toBe(''); expect(byKey.get('value_1')).toBe('0'); expect(byKey.get('value_5')).toBe(false);
    expect(byKey.get('value_7')).toEqual(['Repeated draft', false, '0x10', 'bad', 'bad']);
    expect(byKey.get('renamed_notes')).toBe(''); expect(byKey.has('value_3')).toBe(false); expect(byKey.has('value_6')).toBe(false);
    expect((await f.read(1)).customFields).toEqual(f.saved.customFields);
  });
}
