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
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
}

for (const sampleType of ['internal', 'quality_control', 'amendment', 'complaint']) {
  test(`sample header PATCH preserves ${sampleType} policy and shows the saved address`, async ({ page }) => {
    const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
    const fixture = await createLaboratoryFixture(owner, account);
    Object.assign(fixture.registration, { sampleType, customerId: fixture.customer.id, customerAddress: 'Original synthetic address' });
    if (sampleType === 'quality_control') fixture.registration.iqcType = 'retest';
    if (sampleType === 'complaint') fixture.registration.products[0].tests[0].isRetest = true;
    const headers = await login(page, account);
    const created = await page.request.post('/api/samples', { headers, data: fixture.registration });
    expect(created.status()).toBe(201); const sample = await created.json();
    const before = await (await page.request.get(`/api/samples/${sample.id}`)).json();
    const edited = await page.request.patch(`/api/samples/${sample.id}`, { headers, data: {
      revision: before.revision, customerAddress: 'Updated synthetic address', receivedByName: 'Updated receiver',
      totalAmount: '0', currencyCode: 'INR', amendmentRemarks: 'Updated amendment', complaintRemarks: 'Updated complaint',
    } });
    expect(edited.status()).toBe(200);
    const result = await edited.json(); expect(result.id).toBe(sample.id); expect(result.revision).toBe(before.revision + 1);
    const after = await (await page.request.get(`/api/samples/${sample.id}`)).json();
    expect(after.customerAddress).toBe('Updated synthetic address');
    expect(after.receivedByName).toBe(sampleType === 'internal' ? 'Updated receiver' : before.receivedByName);
    expect(after.totalAmount).toBe(sampleType === 'internal' ? '0' : before.totalAmount);
    expect(after.amendmentRemarks).toBe(sampleType === 'amendment' ? 'Updated amendment' : before.amendmentRemarks);
    expect(after.complaintRemarks).toBe(sampleType === 'complaint' ? 'Updated complaint' : before.complaintRemarks);
    expect(after.products).toEqual(before.products); expect(after.receivedAt).toBe(before.receivedAt);
    expect(after.sampleNumber).toBe(before.sampleNumber); expect(after.registeredBy).toBe(before.registeredBy);
    expect(after.activity.filter(event => event.eventType === 'sample_updated')).toEqual([
      expect.objectContaining({ actorUserId: account.userId, description: 'Sample updated' }),
    ]);
    await page.goto(`/samples/${sample.id}`);
    await expect(page.locator('.smplfy-sample-details-basic')).toContainText('Updated synthetic address');
    const stale = await page.request.patch(`/api/samples/${sample.id}`, { headers, data: { revision: before.revision, customerAddress: 'Stale address' } });
    expect(stale.status()).toBe(409);
  });
}

test('sample header HTTP enforces permissions, origin, CSRF and body validation without losing the saved state', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
  const fixture = await createLaboratoryFixture(owner, account); let headers = await login(page, account);
  const response = await page.request.post('/api/samples', { headers, data: fixture.registration }); expect(response.status()).toBe(201);
  const sample = await response.json(); const path = `/api/samples/${sample.id}`;
  const before = await (await page.request.get(path)).json();
  for (const input of [{ revision: 1, sampleNumber: 'Changed' }, { revision: '1' }, { revision: 1, receivedAt: null },
    { revision: 1, description: 'Invalid\0text' }, { revision: 1, description: '\ud800' }, { revision: 1, products: [] }]) {
    expect((await page.request.patch(path, { headers, data: input })).status()).toBe(400);
  }
  expect((await page.request.patch(path, { headers: { ...headers, Origin: 'https://example.invalid' }, data: { revision: 1 } })).status()).toBe(403);
  expect((await page.request.patch(path, { headers: { ...headers, 'X-CSRF-Token': 'invalid' }, data: { revision: 1 } })).status()).toBe(403);
  expect((await page.request.patch(path, { headers: { ...headers, 'Content-Type': 'text/plain' }, data: 'invalid' })).status()).toBe(415);
  expect((await page.request.patch(path, { headers: { ...headers, 'Content-Type': 'application/json' }, data: '{' })).status()).toBe(400);
  expect((await page.request.patch(path, { headers, data: { revision: 1, description: 'x'.repeat(131_072) } })).status()).toBe(413);
  expect(await (await page.request.get(path)).json()).toEqual(before);
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['samples.read'] });
  headers = await login(page, reader);
  expect((await page.request.patch(path, { headers, data: { revision: 1, description: 'Denied' } })).status()).toBe(403);
  const { canGenerateRequests, canPrintCoa, ...readerSample } = await (await page.request.get(path)).json();
  const { canGenerateRequests: _managerCanGenerate, canPrintCoa: _managerCanPrint, ...savedSample } = before;
  expect(canGenerateRequests).toBe(false); expect(canPrintCoa).toBe(false); expect(readerSample).toEqual(savedSample);
  await page.context().clearCookies();
  expect((await page.request.patch(path, { headers, data: { revision: 1 } })).status()).toBe(401);
});

test('sample header accepts supported long text and preserves it through reload', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
  const fixture = await createLaboratoryFixture(owner, account); const headers = await login(page, account);
  const response = await page.request.post('/api/samples', { headers, data: fixture.registration }); expect(response.status()).toBe(201);
  const sample = await response.json(); const path = `/api/samples/${sample.id}`;
  const input = { revision: 1, customerAddress: 'Á'.repeat(5000), description: '🧪'.repeat(2500), collectionDetails: 'L'.repeat(5000) };
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(16_384);
  expect((await page.request.patch(path, { headers, data: input })).status()).toBe(200);
  const after = await (await page.request.get(path)).json();
  for (const key of ['customerAddress', 'description', 'collectionDetails']) expect(after[key]).toBe(input[key]);
  expect(after.revision).toBe(2);
});
