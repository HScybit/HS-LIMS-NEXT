import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

for (const [days, date, display] of [[0.5, '2024-02-28', '28-02-2024'], [2.9, '2024-03-01', '01-03-2024']]) {
  test(`a ${days}-day category estimate survives options, edit preview, save and reload`, async ({ page }) => {
    const account = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage'] });
    const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
    await owner.query('UPDATE sample_categories SET estimated_time_in_days=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [account.organizationId, fixture.category.id, days]);
    await owner.query('UPDATE decision_rules SET estimated_time_in_days=0,revision=revision+1 WHERE organization_id=$1 AND id=$2', [account.organizationId, fixture.rule.id]);
    await page.goto('/login');
    await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
    const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
    const options = await (await page.request.get('/api/samples/registration-options')).json();
    expect(options.sampleCategories.find(category => category.id === fixture.category.id).estimatedTimeInDays).toBe(days);
    const response = await page.request.post('/api/samples', { headers, data: { ...fixture.registration,
      receivedAt: '2024-02-28T10:30:00.123456Z', dueAt: '2024-03-20T18:00:00.654321Z' } });
    expect(response.status()).toBe(201);
    const id = (await response.json()).id; const path = `/api/samples/${id}`;
    const original = await (await page.request.get(path)).json();
    await page.goto(`/samples/${id}/edit`);
    await page.getByRole('button', { name: 'Add New Product', exact: true }).click();
    await page.getByRole('combobox', { name: 'Product', exact: true }).nth(1).fill(fixture.product.name);
    await page.getByRole('option', { name: fixture.product.name, exact: true }).click();
    await page.getByRole('combobox', { name: 'Parameter 1', exact: true }).nth(1).fill(fixture.parameter.name);
    await page.getByRole('option', { name: fixture.parameter.name, exact: true }).click();
    await expect(page.getByLabel('Tentative Reporting Date', { exact: true })).toHaveValue(date);
    await page.getByRole('button', { name: 'Update Sample', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/samples/${id}$`));
    const saved = await (await page.request.get(path)).json();
    expect(saved.dueAt).toBe(days < 1 ? original.receivedAt : `${date}T00:00:00.000Z`);
    expect(saved.products[0].tests[0].id).toBe(original.products[0].tests[0].id);
    await page.reload();
    await expect(page.locator('dl > div').filter({ has: page.getByText('Tentative Reporting Date', { exact: true }) }).locator('dd')).toHaveText(display);
    await page.goto(`/samples/${id}/edit`);
    await expect(page.getByLabel('Tentative Reporting Date', { exact: true })).toHaveValue(date);
  });
}
