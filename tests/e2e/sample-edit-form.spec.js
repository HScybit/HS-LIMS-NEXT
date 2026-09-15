import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

async function setup(page, overrides = {}, settings = {}) {
  const account = await createAccount(owner, { permissions: settings.permissions ?? ['samples.create', 'samples.read', 'samples.manage'] });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false, ...(typeof settings.fixture === 'function' ? settings.fixture(account) : settings.fixture) });
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
  const response = await page.request.post('/api/samples', { headers, data: { ...fixture.registration,
    receivedAt: '2024-02-28T10:30:00.123456Z', dueAt: '2024-03-20T18:00:00.654321Z', ...(typeof overrides === 'function' ? overrides(fixture) : overrides) } });
  expect(response.status()).toBe(201);
  const path = `/api/samples/${(await response.json()).id}`;
  return { account, fixture, headers, path, sample: await (await page.request.get(path)).json() };
}

test('the sample edit form hydrates saved fields and preserves timestamps through a header save', async ({ page }) => {
  const { path, sample } = await setup(page);
  await page.goto(`/samples/${sample.id}/edit`);
  await expect(page.getByRole('heading', { name: 'Edit Sample', exact: true })).toBeVisible();
  await expect(page.getByLabel('Receiving Date', { exact: true })).toHaveValue('2024-02-28');
  await expect(page.getByLabel('Receiving Date', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Tentative Reporting Date', { exact: true })).toHaveValue('2024-03-20');
  await page.getByLabel('Customer Address', { exact: true }).fill('Updated through the existing form');
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/samples/${sample.id}$`));
  const saved = await (await page.request.get(path)).json();
  expect(saved.customerAddress).toBe('Updated through the existing form');
  expect(saved.receivedAt).toBe(sample.receivedAt); expect(saved.dueAt).toBe(sample.dueAt);
  expect(saved.products).toEqual(sample.products);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toBeVisible();
});

test('ordinary line edits retain identities and recover from a failed save without discarding input', async ({ page }) => {
  const { path, sample } = await setup(page, fixture => ({ products: [{ ...fixture.registration.products[0], quantity: '1.000000000000000001',
    tests: [{ ...fixture.registration.products[0].tests[0], rate: '0.000000000000000001', currencyCode: 'USD', estimatedDurationMinutes: 1 }] }] }));
  await page.goto(`/samples/${sample.id}/edit`);
  await expect(page.getByRole('heading', { name: 'Edit Sample', exact: true })).toBeVisible();
  await page.getByLabel('Description', { exact: true }).fill('Edited operational line');
  await page.getByLabel('Requested size 1', { exact: true }).fill('25 ml');
  let interrupted = false;
  await page.route(`**${path}`, async route => {
    if (route.request().method() === 'PATCH' && !interrupted) { interrupted = true; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic temporary save failure' } }) }); }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic temporary save failure');
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Edited operational line');
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/samples/${sample.id}$`));
  const saved = await (await page.request.get(path)).json(); const line = saved.products[0];
  expect(line.id).toBe(sample.products[0].id); expect(line.quantity).toBe('1.000000000000000001');
  expect(line.tests[0].id).toBe(sample.products[0].tests[0].id); expect(line.tests[0].currencyCode).toBe('USD');
  expect(line.tests[0].rate).toBe('0.000000000000000001'); expect(line.tests[0].estimatedDurationMinutes).toBe(1); expect(line.tests[0].requestedSize).toBe('25 ml');
});

test('complaint retest controls remain editable while product, customer and date details stay locked', async ({ page }) => {
  const { path, sample } = await setup(page, fixture => ({ sampleType: 'complaint', products: [true, false].map(isRetest => ({ ...fixture.registration.products[0],
    tests: [{ ...fixture.registration.products[0].tests[0], isRetest }] })) }));
  await page.goto(`/samples/${sample.id}/edit`);
  await expect(page.getByRole('heading', { name: 'Edit Sample', exact: true })).toBeVisible();
  await expect(page.getByLabel('Customer', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Product', { exact: true }).first()).toBeDisabled();
  await expect(page.getByLabel('Tentative Reporting Date', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add New Product', exact: true })).toBeDisabled();
  const retests = page.getByRole('checkbox', { name: 'Retest parameter 1', exact: true });
  await retests.first().uncheck(); await retests.nth(1).check();
  await page.getByLabel('Complaint Remarks', { exact: true }).fill('Retest the second line');
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/samples/${sample.id}$`));
  const saved = await (await page.request.get(path)).json();
  expect(saved.products.map(line => line.id)).toEqual(sample.products.map(line => line.id));
  expect(saved.products[0].tests).toEqual([]); expect(saved.products[1].tests[0].id).toBe(sample.products[1].tests[0].id);
  expect(saved.products[1].tests[0].isRetest).toBe(true); expect(saved.complaintRemarks).toBe('Retest the second line');
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Retest parameter 1', exact: true })).toHaveCount(1);
});

test('stale edits display the conflict and retain unsaved input', async ({ page }) => {
  const { path, sample, headers } = await setup(page);
  await page.goto(`/samples/${sample.id}/edit`); await expect(page.getByRole('heading', { name: 'Edit Sample', exact: true })).toBeVisible();
  await page.getByLabel('Customer Address', { exact: true }).fill('Unsaved local address');
  expect((await page.request.patch(path, { headers, data: { revision: sample.revision, customerAddress: 'Concurrent saved address' } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('changed');
  await expect(page.getByLabel('Customer Address', { exact: true })).toHaveValue('Unsaved local address');
  expect((await (await page.request.get(path)).json()).customerAddress).toBe('Concurrent saved address');
});

test('an initial loading failure can be retried and inactive selected labels remain visible', async ({ page }) => {
  const { path, sample, account, fixture } = await setup(page, fixture => ({ customerId: fixture.customer.id, customerAddress: 'Saved customer address' }));
  for (const [table, id] of [['products', fixture.product.id], ['test_parameters', fixture.parameter.id], ['methods_of_analysis', fixture.method.id], ['customers', fixture.customer.id]]) {
    await owner.query(`UPDATE ${table} SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2`, [account.organizationId, id]);
  }
  await page.route(`**${path}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic load failure' } }) }), { times: 1 });
  await page.goto(`/samples/${sample.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic load failure');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit Sample', exact: true })).toBeVisible();
  for (const label of [sample.customerName, sample.products[0].productName, sample.products[0].tests[0].parameterName, sample.products[0].tests[0].methodName]) {
    await expect(page.locator('.sample-form-page').getByText(label, { exact: true })).toBeVisible();
  }
  await page.getByLabel('Description', { exact: true }).fill('Retain inactive references');
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/samples/${sample.id}$`));
  expect((await (await page.request.get(path)).json()).products[0].tests).toEqual(sample.products[0].tests);
});

for (const [type, extra] of [['quality_control', { iqcType: 'retest' }], ['amendment', {}], ['interlaboratory', { ilcMode: 'organizer', participatingLabs: [{ laboratoryName: 'Saved lab' }] }]]) {
  test(`${type} edit form applies the source field locks`, async ({ page }) => {
    const { sample } = await setup(page, { sampleType: type, ...extra });
    await page.goto(`/samples/${sample.id}/edit`); await expect(page.getByRole('heading', { name: 'Edit Sample', exact: true })).toBeVisible();
    await expect(page.getByLabel('Sample Type', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('Customer Address', { exact: true })).toBeEnabled();
    if (type === 'quality_control') {
      await expect(page.getByLabel('IQC Type', { exact: true })).toBeDisabled();
      await expect(page.getByLabel('Mode of Sample Receipt', { exact: true })).toBeDisabled();
    } else if (type === 'amendment') {
      await expect(page.getByLabel('Mode of Sample Receipt', { exact: true })).toBeEnabled();
      await expect(page.getByLabel('Product', { exact: true })).toBeDisabled();
    } else {
      await expect(page.getByLabel('ILC lab 1', { exact: true })).toHaveValue('Saved lab');
      await expect(page.getByLabel('ILC lab 1', { exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Add Lab', exact: true })).toBeDisabled();
    }
  });
}

test('readers cannot open the edit form and do not receive an Edit action', async ({ page }) => {
  const { sample } = await setup(page, {}, { permissions: ['samples.create', 'samples.read'] });
  await page.goto(`/samples/${sample.id}`); await expect(page.getByRole('heading', { name: sample.sampleNumber, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
  await page.goto(`/samples/${sample.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toHaveText('You do not have permission to edit samples.');
  await expect(page.getByRole('button', { name: 'Update Sample', exact: true })).toHaveCount(0);
});

test('the workflow can hide editing even for a sample manager', async ({ page }) => {
  const { sample } = await setup(page, {}, { fixture: account => ({ editRoleId: account.roleId, showSampleEdit: false }) });
  await page.goto(`/samples/${sample.id}`); await expect(page.getByRole('heading', { name: sample.sampleNumber, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
  await page.goto(`/samples/${sample.id}/edit`);
  await expect(page.locator('.alert[role="alert"]')).toHaveText('The current workflow state does not allow editing this sample.');
});

test('used test identities are locked while operational metadata can still be edited', async ({ page }) => {
  const { path, sample, headers } = await setup(page);
  expect((await page.request.post(`${path}/test-requests`, { headers, data: {} })).status()).toBe(201);
  const requested = await (await page.request.get(path)).json();
  await page.goto(`/samples/${sample.id}/edit`); await expect(page.getByRole('heading', { name: 'Edit Sample', exact: true })).toBeVisible();
  for (const name of ['Product', 'Category', 'Parameter 1', 'Test method 1']) await expect(page.getByLabel(name, { exact: true })).toBeDisabled();
  for (const name of ['Remove product', 'Remove parameter', 'Auto-fill parameters']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  await page.getByLabel('Requested size 1', { exact: true }).fill('Operational note after generation');
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/samples/${sample.id}$`));
  const selected = (await (await page.request.get(path)).json()).products[0].tests[0];
  expect(selected.id).toBe(requested.products[0].tests[0].id); expect(selected.requestId).toBe(requested.products[0].tests[0].requestId);
  expect(selected.requestedSize).toBe('Operational note after generation');
});

test('removing and adding Product rows keeps retained IDs and assigns new identities without using positions', async ({ page }) => {
  const { path, sample, fixture } = await setup(page, fixture => ({ products: [fixture.registration.products[0], fixture.registration.products[0]] }));
  await page.goto(`/samples/${sample.id}/edit`); await expect(page.getByRole('heading', { name: 'Edit Sample', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove product', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add New Product', exact: true }).click();
  await page.getByRole('combobox', { name: 'Product', exact: true }).nth(1).fill(fixture.product.name);
  await page.getByRole('option', { name: fixture.product.name, exact: true }).click();
  await page.getByRole('combobox', { name: 'Parameter 1', exact: true }).nth(1).fill(fixture.parameter.name);
  await page.getByRole('option', { name: fixture.parameter.name, exact: true }).click();
  await page.getByRole('button', { name: 'Update Sample', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/samples/${sample.id}$`));
  const saved = await (await page.request.get(path)).json(); expect(saved.products).toHaveLength(2);
  expect(saved.products[0].id).toBe(sample.products[1].id); expect(saved.products[0].tests[0].id).toBe(sample.products[1].tests[0].id);
  expect(sample.products.map(product => product.id)).not.toContain(saved.products[1].id);
  expect(sample.products.flatMap(product => product.tests.map(selected => selected.id))).not.toContain(saved.products[1].tests[0].id);
});
