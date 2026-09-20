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

test('a create-only registrar preserves precise timestamps and uses the stored receiving year for numbering', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['samples.create'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false }); const headers = await login(page, account);
  const precise = await page.request.post('/api/samples', { headers, data: { ...fixture.registration,
    receivedAt: '2026-09-12T10:30:00.123456+05:30', dueAt: '2026-09-14T00:00:00.654321Z' } });
  expect(precise.status()).toBe(201); const sample = await precise.json();
  const stored = await owner.query('SELECT received_at::text AS received,due_at::text AS due FROM samples WHERE organization_id=$1 AND id=$2', [account.organizationId, sample.id]);
  expect(stored.rows[0]).toEqual({ received: '2026-09-12 05:00:00.123456+00', due: '2026-09-14 00:00:00.654321+00' });
  expect((await page.request.get(`/api/samples/${sample.id}`)).status()).toBe(403);
  const boundary = await page.request.post('/api/samples', { headers, data: { ...fixture.registration, receivedAt: '2026-12-31T23:59:59.9999999Z', dueAt: null } });
  expect(boundary.status()).toBe(201); expect((await boundary.json()).sampleNumber).toMatch(/^SMP-2027-\d{6}$/);
});

test('invalid precise dates return a usable error and leave registration and numbering untouched', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['samples.create'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false }); const headers = await login(page, account);
  for (const dates of [
    { receivedAt: '2026-09-12T05:00:00.123456Z', dueAt: '2026-09-12T05:00:00.123455Z' },
    { receivedAt: '2026-09-12T05:00:00+23:00', dueAt: null },
    { receivedAt: '9999-12-31T23:59:59.9999999Z', dueAt: null },
  ]) {
    const response = await page.request.post('/api/samples', { headers, data: { ...fixture.registration, ...dates } });
    expect(response.status()).toBe(400); expect((await response.json()).error.code).toBe('invalid_sample');
  }
  for (const table of ['samples', 'sample_products', 'sample_tests', 'sample_events', 'number_sequences', 'workflow_runs']) {
    expect((await owner.query(`SELECT 1 FROM ${table} WHERE organization_id=$1`, [account.organizationId])).rowCount).toBe(0);
  }
  const recovery = await page.request.post('/api/samples', { headers, data: fixture.registration });
  expect(recovery.status()).toBe(201); expect((await recovery.json()).sampleNumber).toBe('SMP-2026-000001');
});
