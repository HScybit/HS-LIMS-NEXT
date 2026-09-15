import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function setup(page) {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
  const response = await page.request.post('/api/samples', { headers, data: fixture.registration }); expect(response.status()).toBe(201);
  return { account, headers, sample: await response.json() };
}

test('generation HTTP preserves the explicit PostgreSQL due instant and its original offset', async ({ page }) => {
  const { account, headers, sample } = await setup(page);
  const generated = await page.request.post(`/api/samples/${sample.id}/test-requests`, { headers, data: { dueAt: '2026-09-14T10:30:00.123456+05:30' } });
  expect(generated.status()).toBe(201); const result = await generated.json(); expect(result.items).toHaveLength(1);
  const stored = (await owner.query('SELECT due_at::text AS due FROM test_requests WHERE organization_id=$1 AND id=$2', [account.organizationId, result.items[0].id])).rows[0];
  expect(stored.due).toBe('2026-09-14 05:00:00.123456+00');
  await page.goto(`/samples/${sample.id}/test_requests`); await expect(page.getByText(result.items[0].requestNumber, { exact: true })).toBeVisible();
});

test('invalid canonical due dates return HTTP400 without partial requests or consumed numbers', async ({ page }) => {
  const { account, headers, sample } = await setup(page);
  async function snapshot() {
    const result = {};
    for (const table of ['samples', 'sample_tests', 'sample_events', 'test_requests', 'analytical_specifications', 'number_sequences']) {
      result[table] = (await owner.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [account.organizationId])).rows.map(row => JSON.stringify(row)).sort();
    }
    return result;
  }
  const before = await snapshot();
  for (const dueAt of ['2026-09-14T10:30:00+23:00', '9999-12-31T23:59:59.9999999Z', '0001-01-01T00:00:00+00:01']) {
    const response = await page.request.post(`/api/samples/${sample.id}/test-requests`, { headers, data: { dueAt } });
    expect(response.status()).toBe(400); expect((await response.json()).error.code).toBe('invalid_sample');
    expect(await snapshot()).toEqual(before);
  }
});
