import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function setup(page) {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage', 'test_requests.allocate'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  await owner.query('UPDATE decision_rules SET estimated_time_in_days=3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [account.organizationId, fixture.rule.id]);
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
  const created = await page.request.post('/api/samples', { headers, data: { ...fixture.registration, sampleType: 'complaint',
    receivedAt: '2024-02-28T10:30:00.123456Z', dueAt: '2024-03-20T18:00:00.654321Z',
    products: [true, false].map(isRetest => ({ ...fixture.registration.products[0], tests: [{ ...fixture.registration.products[0].tests[0], isRetest }] })) } });
  expect(created.status()).toBe(201); const path = `/api/samples/${(await created.json()).id}`;
  return { headers, path, sample: await (await page.request.get(path)).json() };
}

test('complaint selection preserves chosen IDs, ignores locked details and displays the recalculated date', async ({ page }) => {
  const { headers, path, sample } = await setup(page); const id = sample.products[1].tests[0].id;
  const command = { revision: sample.revision, complaintRetestIds: [id], complaintRemarks: 'Retest this selection', products: 'locked', dueAt: 'locked' };
  expect((await page.request.patch(path, { headers, data: command })).status()).toBe(200);
  const saved = await (await page.request.get(path)).json();
  expect(saved.products.map(line => line.id)).toEqual(sample.products.map(line => line.id));
  expect(saved.products[0].tests).toEqual([]); expect(saved.products[1].tests[0].id).toBe(id); expect(saved.products[1].tests[0].isRetest).toBe(true);
  expect(saved.dueAt).toBe('2024-03-02T00:00:00.000Z'); expect(saved.complaintRemarks).toBe('Retest this selection');
  expect((await page.request.patch(path, { headers, data: command })).status()).toBe(409);
  const generated = await page.request.post(`${path}/test-requests`, { headers, data: {} }); expect(generated.status()).toBe(201);
  expect((await generated.json()).items).toHaveLength(1);
  await page.goto(path.replace('/api', ''));
  await expect(page.locator('dl > div').filter({ has: page.getByText('Tentative Reporting Date', { exact: true }) }).locator('dd')).toHaveText('02-03-2024');
});

test('unselected generation and removal of a requested complaint retest fail without partial changes', async ({ page }) => {
  const { headers, path, sample } = await setup(page); const unselectedId = sample.products[1].tests[0].id;
  const explicit = await page.request.post(`${path}/test-requests`, { headers, data: { sampleTestIds: [unselectedId] } });
  expect(explicit.status()).toBe(409); expect((await explicit.json()).error.code).toBe('sample_test_not_available');
  expect(await (await page.request.get(path)).json()).toEqual(sample);
  const generated = await page.request.post(`${path}/test-requests`, { headers, data: {} }); expect(generated.status()).toBe(201);
  expect((await generated.json()).items).toHaveLength(1); const requested = await (await page.request.get(path)).json();
  const removed = await page.request.patch(path, { headers, data: { revision: requested.revision, complaintRetestIds: [unselectedId], complaintRemarks: 'Must not persist' } });
  expect(removed.status()).toBe(409); expect((await removed.json()).error.code).toBe('sample_lines_changed');
  expect(await (await page.request.get(path)).json()).toEqual(requested);
});
