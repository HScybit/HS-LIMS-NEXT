import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function fixture() {
  const account = await createAccount(owner, { permissions: ['masters.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), label: 'Original custom field', key: 'original_field', associatedWith: 'product',
    fieldType: 'select', options: [{ id: randomUUID(), key: 'A', label: 'Upper' }, { id: randomUUID(), key: 'a', label: 'Lower' },
      { id: randomUUID(), key: 'date_value', label: '2026-09-13T12:00:00Z' }] };
  const field = await withSession(session.token, (client, identity) => saveCustomField(client, identity, command), { csrfToken: session.csrfToken });
  return { account, session, command, field };
}

test('report reissue editability retains hidden values, exact retries and historical true and false settings', async ({ page }) => {
  const { account, field } = await fixture();
  await login(page, account); await page.goto(`/project_fields/${field.id}/edit`);
  const association = page.getByLabel('Associated With', { exact: true });
  const editable = page.getByLabel('Editable On Report Reissue?', { exact: true });
  await expect(editable).toHaveCount(0);
  await association.selectOption('sample'); await expect(editable).not.toBeChecked(); await editable.check();
  await expect(page.getByText('Enabling this lets the value be changed while reissuing a finalised report.', { exact: true })).toBeVisible();
  await association.selectOption('sample_product'); await expect(editable).toBeChecked();
  await association.selectOption('product'); await expect(editable).toHaveCount(0);
  await association.selectOption('sample'); await expect(editable).toBeChecked();
  await association.selectOption('product'); await expect(editable).toHaveCount(0);
  let attempted;
  await page.route('**/api/masters/project-fields', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempted = route.request().postDataJSON(); expect(attempted.editOnReissue).toBe(true);
    expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost reissue setting response' } }) });
  });
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost reissue setting response');
  await page.unroute('**/api/masters/project-fields');
  const retried = page.waitForResponse(response => response.url().endsWith('/api/masters/project-fields') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  const retry = await retried; expect(retry.status()).toBe(200); expect(retry.request().postDataJSON()).toEqual(attempted);
  const saved = await retry.json(); expect(saved.editOnReissue).toBe(true); expect(saved.revision).toBe(2);
  await page.goto(`/project_fields/${field.id}/view`);
  await expect(page.getByRole('row').filter({ hasText: 'Editable On Report Reissue?' })).toHaveText('Editable On Report Reissue?Yes');
  await page.goto(`/project_fields/${field.id}/edit`); await expect(editable).toHaveCount(0);
  await association.selectOption('sample_product'); await expect(editable).toBeChecked(); await editable.uncheck();
  const changed = page.waitForResponse(response => response.url().endsWith('/api/masters/project-fields') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  const result = await changed; expect(result.status()).toBe(200);
  const current = await result.json(); expect(current.editOnReissue).toBe(false); expect(current.revision).toBe(3);
  await page.goto(`/project_fields/${field.id}/edit`); await expect(editable).not.toBeChecked();
  for (const [revision, expected] of [[1, false], [2, true], [3, false]]) {
    const response = await page.request.get(`/api/masters/project-fields/${field.id}?revision=${revision}`);
    expect(response.status()).toBe(200); expect((await response.json()).editOnReissue).toBe(expected);
  }
});

test('custom field editor preserves an imported hidden lookup binding across type changes and a lost save response', async ({ page }) => {
  const { account, session, command, field } = await fixture();
  const observation = { id: randomUUID(), revision: 0, requestId: randomUUID(), sourceId: 'Browser-source-' + randomUUID(), name: 'Source name',
    lines: [{ id: 'original-flat-line', label: 'Observed choice' }] };
  await withSession(session.token, (c, i) => saveLookupSourceObservation(c, i, observation));
  await withSession(session.token, (c, i) => saveCustomField(c, i, { ...command, revision: 1, requestId: randomUUID(), fieldType: 'lookup', lookupSourceId: observation.id }));
  await login(page, account); await page.goto(`/project_fields/${field.id}/edit`);
  await expect(page.getByLabel('Data Type', { exact: true })).toHaveValue('lookup');
  await expect(page.getByLabel('Lookup Data Master', { exact: true })).toHaveCount(0);
  await page.getByLabel('Data Type', { exact: true }).selectOption('text');
  let attempted;
  await page.route('**/api/masters/project-fields', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempted = route.request().postDataJSON(); expect(attempted.lookupSourceId).toBe(observation.id);
    expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost lookup binding response' } }) });
  });
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost lookup binding response');
  await withSession(session.token, (c, i) => saveLookupSourceObservation(c, i, { ...observation, revision: 1, requestId: randomUUID(), lines: [] }));
  await page.unroute('**/api/masters/project-fields');
  const response = page.waitForResponse(result => result.url().endsWith('/api/masters/project-fields') && result.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  const saved = await response; expect(saved.status()).toBe(200); expect(saved.request().postDataJSON()).toEqual(attempted);
  expect((await saved.json()).lookupSourceId).toBe(observation.id);
  await page.goto(`/project_fields/${field.id}/edit`); await page.getByLabel('Data Type', { exact: true }).selectOption('lookup');
  const restored = page.waitForResponse(result => result.url().endsWith('/api/masters/project-fields') && result.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  expect((await (await restored).json()).lookupSourceId).toBe(observation.id);
  const firstBound = await (await page.request.get(`/api/masters/project-fields/${field.id}?revision=2`)).json();
  expect(firstBound.fieldType).toBe('lookup'); expect(firstBound.lookupSourceId).toBe(observation.id);
});

test('source Custom Fields form preserves options, zero settings and hidden roles through lost responses, reload and deletion', async ({ page }, testInfo) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 1280, height: 960 });
  const account = await createAccount(owner, { permissions: ['masters.manage'] });
  const role = randomUUID(); await owner.query('INSERT INTO roles(organization_id,id,name) VALUES($1,$2,$3)', [account.organizationId, role, 'Lab Reviewer']);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, account); await page.goto('/project_fields');
  await page.getByRole('button', { name: 'New Project Field', exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Label', { exact: true }).fill('Synthetic browser custom field');
  await page.getByLabel('Key', { exact: true }).fill('MiXeD_Field');
  await page.getByLabel('Description', { exact: true }).fill(' 0 ');
  await page.getByLabel('Padded Number', { exact: true }).fill('0'); await page.getByLabel('Order Index', { exact: true }).fill('0');
  await page.getByLabel('Data Type', { exact: true }).selectOption('select');
  await page.getByRole('button', { name: 'Add Option', exact: true }).click();
  await page.getByLabel('Option 1 key', { exact: true }).fill('A'); await page.getByLabel('Option 1 label', { exact: true }).fill('Upper');
  await page.getByRole('button', { name: 'Add Option', exact: true }).click();
  await page.getByLabel('Option 2 key', { exact: true }).fill('a'); await page.getByLabel('Option 2 label', { exact: true }).fill('Lower');
  await page.getByLabel('Associated With', { exact: true }).selectOption('sample');
  expect(await page.getByLabel('Associated With', { exact: true }).locator('option').evaluateAll((options) => options.map((option) => option.value))).not.toContain('custom_form');
  await page.getByLabel('Data Type', { exact: true }).selectOption('multi_user_select');
  await page.getByLabel('Associate Role Specific Users?', { exact: true }).check();
  await page.getByLabel('Associate Role', { exact: true }).fill('Lab'); await page.getByRole('option', { name: 'Lab Reviewer', exact: true }).click();
  await page.getByLabel('Associate Role Specific Users?', { exact: true }).uncheck();
  await expect(page.getByLabel('Associate Role', { exact: true })).toHaveCount(0);
  await page.getByLabel('Associate Role Specific Users?', { exact: true }).check();
  await expect(page.locator('.smplfy-rselect__single-value')).toHaveText('Lab Reviewer');
  await page.getByLabel('Data Type', { exact: true }).selectOption('select');
  await expect(page.getByLabel('Option 2 key', { exact: true })).toHaveValue('a');
  await page.getByLabel('Roles', { exact: true }).fill('Lab'); await page.getByRole('option', { name: 'Lab Reviewer', exact: true }).click(); await page.keyboard.press('Escape');
  await page.route('**/api/masters/project-fields/roles?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic role lookup failure' } }) }));
  await page.getByLabel('Roles', { exact: true }).fill('failed'); await expect(page.getByText('Synthetic role lookup failure', { exact: true })).toBeVisible();
  await expect(page.locator('.smplfy-rselect__multi-value-label')).toHaveText('Lab Reviewer');
  await page.unroute('**/api/masters/project-fields/roles?**'); await page.getByLabel('Roles', { exact: true }).fill('Lab');
  await expect(page.getByText('Synthetic role lookup failure', { exact: true })).toHaveCount(0); await page.keyboard.press('Escape');
  await expect(page.locator('#sampleify-toast-shelf .toast')).toHaveCount(0);
  await page.getByLabel('Label', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('custom-field-source-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByLabel('Option 1 key', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('custom-field-options-desktop.png'), fullPage: true, animations: 'disabled' });
  let attempted;
  await page.route('**/api/masters/project-fields', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempted = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost field save response' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost field save response');
  await page.unroute('**/api/masters/project-fields');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/masters/project-fields') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const response = await saved;
  expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual(attempted);
  const field = await response.json(); expect(field.key).toBe('mixed_field'); expect(field.displayOrder).toBe(0); expect(field.paddedNumber).toBe(0);
  expect(field.options.map((option) => option.key)).toEqual(['A', 'a']); expect(field.roleIdsCanEdit).toEqual([role]); expect(field.associatedWithRoleId).toBe(role);
  await page.getByPlaceholder('Search...', { exact: true }).fill('Synthetic browser'); await expect(page).toHaveURL(/search=Synthetic/);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.locator('.dt-filter-field').filter({ hasText: 'Data Type' }).locator('select').selectOption('select');
  await page.getByRole('button', { name: 'Apply Filters', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: field.label, exact: true }) });
  await row.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Order Index', { exact: true })).toHaveValue('0');
  await page.getByRole('button', { name: 'Remove row 1', exact: true }).click(); await expect(page.getByLabel('Option 1 key', { exact: true })).toHaveValue('a');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#sampleify-toast-shelf .toast')).toHaveCount(0);
  await page.getByLabel('Option 1 key', { exact: true }).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await page.screenshot({ path: testInfo.outputPath('custom-field-options-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await page.screenshot({ path: testInfo.outputPath('custom-field-source-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(row).toBeVisible(); await expect(page).toHaveURL(/filters=/);
  const latest = await (await page.request.get(`/api/masters/project-fields/${field.id}`)).json(); expect(latest.options[0].id).toBe(field.options[1].id);
  const historical = await (await page.request.get(`/api/masters/project-fields/${field.id}?revision=1`)).json(); expect(historical.options).toEqual(field.options);
  await row.getByRole('link', { name: 'View', exact: true }).click(); await expect(page.getByRole('cell', { name: 'mixed_field', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Dropdown/Select', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Lab Reviewer', exact: true })).toHaveCount(2);
  await expect(page.getByRole('table', { name: 'Dropdown Options', exact: true }).getByRole('cell')).toHaveText(['a', 'Lower']);
  await page.goBack(); await row.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Project Field', exact: true }); let removal;
  await page.route(`**/api/masters/project-fields/${field.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    removal = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost field delete response' } }) });
  });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog).toContainText('Synthetic lost field delete response');
  await page.unroute(`**/api/masters/project-fields/${field.id}`);
  const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); expect((await deleted).request().postDataJSON()).toEqual(removal);
  await expect(row).toHaveCount(0); expect(errors).toEqual([]);
});

test('custom field edits retain drafts after conflicts and preserve options across conditional date controls', async ({ page }) => {
  const { account, session, command, field } = await fixture(); await login(page, account); await page.goto(`/project_fields/${field.id}/edit`);
  await page.getByLabel('Label', { exact: true }).fill('Unsaved local label');
  await page.getByLabel('Key', { exact: true }).fill('Invalid key'); await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByLabel('Key', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Key', { exact: true }).fill('valid_field');
  await withSession(session.token, (client, identity) => saveCustomField(client, identity, { ...command, revision: 1, requestId: randomUUID(), label: 'Concurrent field' }), { csrfToken: session.csrfToken });
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('The custom field changed. Reload before saving.');
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Unsaved local label');
  await page.reload(); await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Concurrent field');
  await page.getByLabel('Data Type', { exact: true }).selectOption('date');
  await page.getByLabel('Date Format', { exact: true }).selectOption('MMMM Do YYYY');
  await expect(page.getByRole('button', { name: 'Add Option', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/project_fields$/);
  let latest = await (await page.request.get(`/api/masters/project-fields/${field.id}`)).json();
  expect(latest.fieldType).toBe('date'); expect(latest.dateFormat).toBe('MMMM Do YYYY'); expect(latest.options).toEqual(field.options);
  await page.goto(`/project_fields/${field.id}/edit`); await page.getByLabel('Data Type', { exact: true }).selectOption('date_time');
  await expect(page.getByLabel('Date Format', { exact: true })).toHaveCount(0);
  await page.getByLabel('Date-Time Format', { exact: true }).selectOption('MMMM Do YYYY | hh:mm A');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/project_fields$/);
  latest = await (await page.request.get(`/api/masters/project-fields/${field.id}`)).json();
  expect(latest.dateFormat).toBe(''); expect(latest.datetimeFormat).toBe('MMMM Do YYYY | hh:mm A'); expect(latest.options).toEqual(field.options);
  await page.goto(`/project_fields/${field.id}/view`);
  await expect(page.getByRole('cell', { name: 'Date Time', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'December 31st 2026 | 11:30 PM (MMMM Do YYYY | hh:mm A)', exact: true })).toBeVisible();
  const dateLabel = await page.evaluate(() => new Date('2026-09-13T12:00:00Z').toLocaleString());
  await expect(page.getByRole('table', { name: 'Dropdown Options', exact: true }).getByRole('cell')).toHaveText(['A', 'Upper', 'a', 'Lower', 'date_value', dateLabel]);
});

test('Custom Fields read-only UI and APIs enforce permissions, tenant isolation and CSRF', async ({ page }) => {
  const { account, field } = await fixture(); const foreign = await fixture();
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['masters.read'] });
  await login(page, reader); await page.goto('/project_fields');
  await expect(page.getByRole('cell', { name: field.label, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Project Field', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'View', exact: true }).click(); await expect(page.getByRole('cell', { name: field.key, exact: true })).toBeVisible();
  await page.goto(`/project_fields/${field.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('permission');
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value;
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
  expect((await page.request.post('/api/masters/project-fields', { headers, data: {} })).status()).toBe(403);
  expect((await page.request.delete(`/api/masters/project-fields/${field.id}`, { headers, data: { requestId: randomUUID(), revision: 1 } })).status()).toBe(403);
  expect((await page.request.post('/api/masters/project-fields', { data: {} })).status()).toBe(403);
  expect((await page.request.get(`/api/masters/project-fields/${foreign.field.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/masters/project-fields/${foreign.field.id}?revision=1`)).status()).toBe(404);
  for (const query of ['%7B', 'null', encodeURIComponent(JSON.stringify({ sort: { key: 'password_hash', dir: 'asc' } }))]) {
    expect((await page.request.get(`/api/masters/project-fields?query=${query}`)).status()).toBe(400);
  }
});
