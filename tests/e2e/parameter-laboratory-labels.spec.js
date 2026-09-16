import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await owner.end(); });

test('parameter HTTP history and exact retries retain observed Lab names while the editor shows current names', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['masters.manage'] }); const laboratoryId = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Originally selected Lab')", [account.organizationId, laboratoryId]);
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
  const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Parameter Lab history', key: 'LAB-HISTORY',
    schemeAbbreviation: 'LH', order: 0, description: '', laboratoryId, measurementUncertainty: null };
  const created = await page.request.post('/api/masters/test-parameters', { headers, data: command });
  expect(created.status()).toBe(200); const createdHead = await created.json(); expect(createdHead.laboratoryName).toBe('Originally selected Lab');
  const historyUrl = `/api/masters/test-parameters/${command.id}?revision=1`;
  const original = await (await page.request.get(historyUrl)).json(); expect(original).toMatchObject(createdHead);
  expect(original.savedBy).toBe(account.userId); expect(original.operation).toBe('create');
  await owner.query("UPDATE laboratories SET name='Current selected Lab',revision=revision+1 WHERE organization_id=$1 AND id=$2", [account.organizationId, laboratoryId]);
  const history = await page.request.get(historyUrl); expect(history.status()).toBe(200); expect(await history.json()).toEqual(original);
  const retried = await page.request.post('/api/masters/test-parameters', { headers, data: command });
  expect(retried.status()).toBe(200); expect(await retried.json()).toEqual(original);
  await page.goto(`/test_parameters/${command.id}/edit`);
  await expect(page.locator('.smplfy-rselect__single-value')).toContainText('Current selected Lab');
  await page.getByLabel('Description', { exact: true }).fill('A new observed revision');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/masters/test-parameters') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); const response = await saved;
  expect(response.status()).toBe(200); const updatedHead = await response.json(); expect(updatedHead.revision).toBe(2);
  const updated = await (await page.request.get(`/api/masters/test-parameters/${command.id}?revision=2`)).json(); expect(updated).toMatchObject(updatedHead);
  expect(updated.laboratoryName).toBe('Current selected Lab');
  await owner.query("UPDATE laboratories SET name='Later selected Lab',revision=revision+1 WHERE organization_id=$1 AND id=$2", [account.organizationId, laboratoryId]);
  expect(await (await page.request.get(historyUrl)).json()).toEqual(original);
  expect(await (await page.request.get(`/api/masters/test-parameters/${command.id}?revision=2`)).json()).toEqual(updated);
  expect((await (await page.request.get(`/api/masters/test-parameters/${command.id}`)).json()).laboratoryName).toBe('Later selected Lab');
});
