import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveLaboratory } from '../../src/masters/laboratories.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, actor) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function fixture() {
  const actor = await createAccount(owner, { permissions: ['users.manage'] }); const session = await signIn({ identifier: actor.username, password: actor.password });
  const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), code: 'LAB-' + randomUUID(), name: 'Original browser Lab',
    minimumTemperature: '20', maximumTemperature: '30', minimumHumidity: '30', maximumHumidity: '60' };
  const save = input => withSession(session.token, (client, identity) => saveLaboratory(client, identity, input), { csrfToken: session.csrfToken });
  const laboratory = await save(command); return { actor, command, laboratory, save };
}

test('source Lab form preserves raw limits and selections through lost saves, editing, retirement and reactivation', async ({ page }, info) => {
  test.setTimeout(60_000);
  const actor = await createAccount(owner, { permissions: ['users.manage'] }); const person = await createAccount(owner, { organizationId: actor.organizationId, permissions: [] }); const unit = randomUUID();
  await owner.query("UPDATE users SET display_name='Inactive Lab person',active=false WHERE id=$1", [person.userId]);
  await owner.query("INSERT INTO business_units(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Selected Lab unit')", [actor.organizationId, unit]);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page, actor); await page.getByRole('link', { name: 'Labs', exact: true }).click();
  await page.getByRole('button', { name: 'New Lab', exact: true }).click(); await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Required', { exact: true })).toHaveCount(6);
  for (const [label, value] of [['Name', 'Synthetic browser Lab'], ['Abbreviation', 'BL'], ['Min Temperature', '0'], ['Max Temperature', '30C'], ['Min Humidity', ' '], ['Max Humidity', 'Infinity'], ['Code', 'BROWSER-LAB'], ['Description', 'Original notes']]) await page.getByLabel(label, { exact: true }).fill(value);
  for (const label of ['Head of Lab', 'Delegate Authority to']) {
    await page.getByLabel(label, { exact: true }).fill('Inactive Lab'); await page.getByRole('option', { name: 'Inactive Lab person (inactive)', exact: true }).click();
  }
  await page.getByLabel('Business unit', { exact: true }).fill('Selected Lab'); await page.getByRole('option', { name: 'Selected Lab unit', exact: true }).click();
  let attempted;
  await page.route('**/api/administration/laboratories', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempted = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost Lab save' } }) });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost Lab save');
  await expect(page.getByLabel('Min Humidity', { exact: true })).toHaveValue(' '); await page.unroute('**/api/administration/laboratories');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/administration/laboratories') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const response = await saved;
  expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual(attempted); const laboratory = await response.json();
  expect(laboratory.headUserId).toBe(person.userId); expect(laboratory.delegateUserId).toBe(person.userId); expect(laboratory.businessUnitId).toBe(unit);
  expect(laboratory.minimumTemperature).toBe('0'); expect(laboratory.minimumHumidity).toBe(' '); expect(laboratory.maximumHumidity).toBe('Infinity');
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Synthetic browser Lab', exact: true }) });
  await expect(row).toBeVisible(); await row.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Max Temperature' })).toContainText('30C');
  await page.goto(`/lab_management/${laboratory.id}/edit`); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Synthetic browser Lab');
  await expect(page.locator('.smplfy-rselect__single-value').filter({ hasText: 'Inactive Lab person' })).toHaveCount(2);
  await page.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('laboratory-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByLabel('Description', { exact: true }).fill('Updated notes'); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Update', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('laboratory-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(row).toBeVisible(); await row.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible(); let deletion;
  await page.route(`**/api/administration/laboratories/${laboratory.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deletion = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost Lab retirement' } }) });
  });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Synthetic lost Lab retirement');
  await page.unroute(`**/api/administration/laboratories/${laboratory.id}`);
  const removed = page.waitForResponse(response => response.url().endsWith(`/api/administration/laboratories/${laboratory.id}`) && response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); const removal = await removed;
  expect(removal.status()).toBe(200); expect(removal.request().postDataJSON()).toEqual(deletion); await expect(dialog).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await row.getByRole('link', { name: 'Edit', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'Active', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Active', exact: true }).check(); await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  const history = await page.request.get(`/api/administration/laboratories/${laboratory.id}?revision=1`); expect(history.status()).toBe(200); expect(await history.json()).toEqual(laboratory);
  expect(errors).toEqual([]);
});

test('Lab load retries and stale edits preserve the draft, while unchanged legacy labels and unknown limits survive editing', async ({ page }) => {
  const { actor, command, laboratory, save } = await fixture(); await login(page, actor);
  await page.route(`**/api/administration/laboratories/${laboratory.id}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic Lab load failure' } }) }));
  await page.goto(`/lab_management/${laboratory.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic Lab load failure');
  await page.unroute(`**/api/administration/laboratories/${laboratory.id}`); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Original browser Lab'); await page.getByLabel('Name', { exact: true }).fill('Preserved Lab draft');
  await save({ ...command, revision: 1, requestId: randomUUID(), name: 'Concurrent Lab change' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('The lab changed');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Preserved Lab draft'); await page.reload(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Concurrent Lab change');
  const legacy = randomUUID(); const name = '  ' + 'L'.repeat(250) + '  ';
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2,'old Lab code',$3)", [actor.organizationId, legacy, name]);
  await page.goto(`/lab_management/${legacy.toUpperCase()}/edit`); await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name);
  await expect(page.getByLabel('Min Temperature', { exact: true })).toHaveValue(''); await page.getByLabel('Description', { exact: true }).fill('Unrelated legacy edit');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/lab_management$/);
  const history = await page.request.get(`/api/administration/laboratories/${legacy}?revision=2`); expect(history.status()).toBe(200);
  const result = await history.json(); expect(result.name).toBe(name); expect(result.minimumTemperature).toBeNull(); expect(result.minimumHumidity).toBeNull();
});

test('Lab readers can view but cannot author, cross tenants or bypass HTTP request validation', async ({ page }) => {
  const { actor, laboratory } = await fixture(); const foreign = await fixture();
  const reader = await createAccount(owner, { organizationId: actor.organizationId, permissions: ['users.read'] });
  await login(page, reader); await page.goto('/lab_management'); await expect(page.getByRole('heading', { name: 'Labs', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Lab', exact: true })).toHaveCount(0); await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0); await page.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Name' })).toContainText('Original browser Lab');
  await page.goto(`/lab_management/${laboratory.id}/edit`); await expect(page.locator('.alert[role="alert"]')).toContainText('permission');
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
  const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
  expect((await page.request.post('/api/administration/laboratories', { headers, data: {} })).status()).toBe(403);
  expect((await page.request.delete(`/api/administration/laboratories/${laboratory.id}`, { headers, data: { revision: 1, requestId: randomUUID() } })).status()).toBe(403);
  expect((await page.request.post('/api/administration/laboratories', { data: {} })).status()).toBe(403);
  expect((await page.request.get(`/api/administration/laboratories/${foreign.laboratory.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/administration/laboratories/${foreign.laboratory.id}?revision=1`)).status()).toBe(404);
  expect((await page.request.get('/api/administration/laboratories?query=%7B')).status()).toBe(400);
  expect((await page.request.get(`/api/administration/laboratories/${laboratory.id}?revision=NaN`)).status()).toBe(400);
});
