import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
}

test('changed test selections save and display a reporting date based on receipt, with stale saves rejected', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  await owner.query('UPDATE decision_rules SET estimated_time_in_days=3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [account.organizationId, fixture.rule.id]);
  const headers = await login(page, account);
  const created = await page.request.post('/api/samples', { headers, data: { ...fixture.registration,
    receivedAt: '2024-02-28T10:30:00Z', dueAt: '2024-03-20T18:00:00Z' } });
  expect(created.status()).toBe(201); const id = (await created.json()).id; const path = `/api/samples/${id}`;
  const before = await (await page.request.get(path)).json();
  const products = [{ ...fixture.registration.products[0], id: before.products[0].id,
    tests: [{ ...fixture.registration.products[0].tests[0], id: before.products[0].tests[0].id }] }, structuredClone(fixture.registration.products[0])];
  const input = { revision: before.revision, products };
  expect((await page.request.patch(path, { headers, data: input })).status()).toBe(200);
  const saved = await (await page.request.get(path)).json();
  expect(saved.dueAt).toBe('2024-03-02T00:00:00.000Z'); expect(saved.registeredAt).toBe(before.registeredAt);
  expect(saved.products[0].tests[0].id).toBe(before.products[0].tests[0].id);
  expect((await page.request.patch(path, { headers, data: input })).status()).toBe(409);
  expect(await (await page.request.get(path)).json()).toEqual(saved);
  await page.goto(`/samples/${id}`);
  await expect(page.locator('dl > div').filter({ has: page.getByText('Tentative Reporting Date', { exact: true }) }).locator('dd')).toHaveText('02-03-2024');
});

test('header-only saves retain their explicit date and failed line saves preserve all sample data', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false }); const headers = await login(page, account);
  const created = await page.request.post('/api/samples', { headers, data: fixture.registration }); expect(created.status()).toBe(201);
  const path = `/api/samples/${(await created.json()).id}`; let sample = await (await page.request.get(path)).json();
  expect((await page.request.patch(path, { headers, data: { revision: sample.revision, dueAt: '2026-10-01T12:34:56.123456Z' } })).status()).toBe(200);
  sample = await (await page.request.get(path)).json(); expect(sample.dueAt).toBe('2026-10-01T12:34:56.123Z');
  const products = [{ ...fixture.registration.products[0], id: sample.products[0].id,
    tests: [{ ...fixture.registration.products[0].tests[0], id: sample.products[0].tests[0].id }] }, structuredClone(fixture.registration.products[0])];
  const denied = await page.request.patch(path, { headers, data: { revision: sample.revision, products, totalAmount: '12', currencyCode: null } });
  expect(denied.status()).toBe(400); expect((await denied.json()).error.code).toBe('invalid_sample');
  expect(await (await page.request.get(path)).json()).toEqual(sample);
  const dates = await owner.query('SELECT due_at::text AS due FROM samples WHERE organization_id=$1 AND id=$2', [account.organizationId, sample.id]);
  expect(dates.rows[0].due).toBe('2026-10-01 12:34:56.123456+00');
});
