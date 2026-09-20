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
const option = (key, label = key) => ({ id: randomUUID(), key, label });
for (const kind of ['product', 'parameter']) test(`${kind} replacement dropdowns preserve saved raw values through lost-response retry and current-option recovery`, async ({ page }) => {
  const user = await createAccount(owner, { permissions: ['masters.manage'] });
  const actor = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const definitions = [false, true].map((allowsMultiple, index) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, associatedWith: kind,
    fieldType: 'select', key: `choice_${index}`, label: `Saved choice ${index}`, displayOrder: index, allowsMultiple,
    options: [option('A', 'Original A'), option('0', 'Original zero'), option('false', 'Original false')] }));
  for (const definition of definitions) await work(actor, (c, i) => saveCustomField(c, i, definition));
  const api = apis[kind]; const id = randomUUID(); const raw = ['A', ['A', 'A', 0, false]];
  const original = await work(actor, (c, i) => api.save(c, i, { id, requestId: randomUUID(), revision: 0, name: 'Saved dropdown master', key: randomUUID(),
    ...(kind === 'parameter' ? { schemeAbbreviation: 'Dropdown' } : {}),
    customFields: definitions.map((field, index) => ({ fieldId: field.id, fieldRevision: 1, value: raw[index] })) }));
  await work(actor, async (c, i) => {
    for (const [index, definition] of definitions.entries()) {
      await retireCustomField(c, i, { id: definition.id, revision: 1, requestId: randomUUID() });
      definitions[index] = { ...definition, id: randomUUID(), requestId: randomUUID(), options: [option('B', 'Current B')] };
      await saveCustomField(c, i, definitions[index]);
    }
  });
  const read = atRevision => work(actor, (c, i) => api.load(c, i, id, { atRevision }), true);
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/); await page.goto(`/${api.page}/${id}/edit`);
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
  const path = `/api/masters/${api.resource}`; let body;
  await page.route(`**${path}`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    body = route.request().postDataJSON(); const result = await route.fetch(); expect(result.status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost dropdown save response' } }) });
  });
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByText('Synthetic lost dropdown save response', { exact: true })).toBeVisible();
  expect(body.customFields.map(field => field.value)).toEqual(raw);
  const saved = await read(); expect(saved.customFields.map(field => field.value)).toEqual(raw);
  expect(saved.customFields.every(field => field.items.every(item => item.interpretationState === 'invalid' && item.optionId === null))).toBe(true);
  await page.unroute(`**${path}`);
  const retry = page.waitForRequest(request => new URL(request.url()).pathname === path && request.method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); expect((await retry).postDataJSON()).toEqual(body);
  await expect(page).toHaveURL(new RegExp(`/${api.page}(?:\\?|$)`)); expect(await read()).toEqual(saved);
  expect((await read(1)).customFields).toEqual(original.customFields);
  for (const definition of definitions) await work(actor, (c, i) => saveCustomField(c, i, { ...definition, revision: 1, requestId: randomUUID(),
    options: [option('A', 'Recovered A'), option('0', 'Recovered zero'), option('false', 'Recovered false')] }));
  await page.goto(`/${api.page}/${id}/edit`); await expect(page.getByLabel('Saved choice 0', { exact: true })).toHaveValue('A');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/${api.page}(?:\\?|$)`));
  const recovered = await read(); expect(recovered.customFields.map(field => field.value)).toEqual(raw);
  expect(recovered.customFields.every(field => field.items.every(item => item.interpretationState === 'valid' && item.optionRevision === 2))).toBe(true);
  expect(recovered.customFields[0].displayValue).toBe('Recovered A');
  expect((await read(2)).customFields).toEqual(saved.customFields);
});
