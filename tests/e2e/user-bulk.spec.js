import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { ownerPool, createAccount } from '../helpers/database.js';
import { decodeMasterXlsx } from '../../src/masters/bulk-xlsx.js';
import { userBulkHeaders } from '../../src/users/bulk-input.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await owner.end(); });
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  return { origin: 'http://127.0.0.1:3100', 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
}
async function fixture() {
  const actor = await createAccount(owner, { permissions: ['users.manage'] });
  const reader = await createAccount(owner, { organizationId: actor.organizationId, permissions: ['users.read'] });
  const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'User upload lab')", [actor.organizationId, lab]);
  const row = (extra = {}) => { const id = randomUUID(); return { name: 'Imported analyst', email: `import-${id}@example.invalid`, phone: '00123', username: `import-${id}`,
    designation: 'Analyst', unit_name: '', role_name: `Reader ${reader.roleId}`, password: '  Synthetic bulk password  ', lab_name: 'User upload lab', ...extra }; };
  return { actor, reader, lab, row };
}
const csv = rows => Buffer.from([userBulkHeaders.join(','), ...rows.map(row => userBulkHeaders.map(header => row[header] ?? '').join(','))].join('\n'));
const summary = (page, label) => page.getByLabel('Bulk upload validation summary').locator('.bulk-upload-summary__item').filter({ has: page.getByText(label, { exact: true }) }).locator('span');
async function beginUpload(page, buffer, name = 'Synthetic users.csv') {
  await page.goto('/user_management'); await page.getByRole('button', { name: 'Bulk Upload', exact: true }).click();
  await expect(page.getByLabel('Select Model', { exact: true }).locator('option')).toHaveText(['Users']);
  await page.getByLabel('Select File', { exact: true }).setInputFiles({ name, mimeType: name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv', buffer });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
}
async function uploaded(page) {
  await expect(page).toHaveURL(/\/bulk_uploads\/[a-f0-9-]+$/);
  await expect(page.getByRole('heading', { name: 'Users Preview', exact: true })).toBeVisible();
  return page.url().split('/').at(-1);
}
async function privateResponse(page, id, password) {
  const response = await page.request.get(`/api/master-bulk/${id}`); expect(response.status()).toBe(200);
  const result = await response.json(); const body = JSON.stringify(result);
  expect(body).not.toContain(password.trim()); expect(body).not.toContain('passwordHash'); expect(body).not.toContain('fingerprint'); expect(body).not.toContain('sourceHmac');
  expect(result.rows.every(row => row.values[7] === '')).toBe(true); return result;
}

test('User CSV upload preserves saved passwords through ordinary fixes and creates accounts that sign in', async ({ page }, testInfo) => {
  const f = await fixture(); const first = f.row(); const second = f.row({ name: '' }); await login(page, f.actor);
  const template = await page.request.get('/api/master-bulk/sample?resource=users'); expect(template.status()).toBe(200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await template.body());
  expect(workbook.worksheets[0].getRow(1).values.slice(1)).toEqual([...userBulkHeaders]);
  await beginUpload(page, csv([first, second])); const id = await uploaded(page);
  await expect(page.getByText('Password saved', { exact: true })).toHaveCount(2);
  await privateResponse(page, id, first.password);
  await expect(page.locator('body')).not.toContainText(first.password.trim());
  await page.getByRole('button', { name: 'Validate', exact: true }).click(); await expect(summary(page, 'Cannot upload')).toHaveText('1');
  await page.getByRole('button', { name: 'Fix row 3', exact: true }).click();
  await expect(page.getByLabel('Row 3 password', { exact: true })).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('Row 3 password', { exact: true })).toHaveValue('');
  await page.getByLabel('Row 3 name', { exact: true }).fill('Corrected analyst');
  await page.getByRole('button', { name: 'Save fixes & revalidate', exact: true }).click(); await expect(summary(page, 'Cannot upload')).toHaveText('0');
  await page.getByRole('button', { name: 'Process valid rows', exact: true }).click(); await expect(summary(page, 'Committed')).toHaveText('2');
  await page.reload(); await expect(summary(page, 'Committed')).toHaveText('2');
  await page.screenshot({ path: testInfo.outputPath('user-bulk-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('Password saved', { exact: true }).first().scrollIntoViewIfNeeded();
  expect(await page.getByText('Password saved', { exact: true }).first().locator('..').evaluate(cell => cell.getBoundingClientRect().width)).toBeGreaterThan(150);
  await page.screenshot({ path: testInfo.outputPath('user-bulk-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const original = await page.request.get(`/api/master-bulk/${id}/original`); expect(original.status()).toBe(200);
  expect((await decodeMasterXlsx(await original.body())).rows.map(row => row.values[7])).toEqual(['', '']);
  await page.goto('/bulk_uploads'); await expect(page.getByLabel('Filter model').locator('option')).toHaveText(['All models', 'Users']);
  await expect(page.getByText('2 of 2 committed', { exact: true })).toBeVisible();
  for (const row of [first, second]) await login(page, { ...row, password: row.password.trim() });
  const profiles = (await owner.query('SELECT p.laboratory_id,p.default_role_id,p.phone FROM user_profiles p JOIN users u ON u.id=p.user_id WHERE p.organization_id=$1 AND u.username=ANY($2::text[])', [f.actor.organizationId, [first.username, second.username]])).rows;
  expect(profiles).toHaveLength(2); expect(profiles.every(row => row.laboratory_id === f.lab && row.default_role_id === f.reader.roleId && row.phone === '00123')).toBe(true);
});

test('a lost User XLSX upload response retries one redacted batch including cached password formula provenance', async ({ page }) => {
  const f = await fixture(); const row = f.row(); await login(page, f.actor);
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Users');
  sheet.addRow([...userBulkHeaders]); sheet.addRow(userBulkHeaders.map(header => row[header]));
  sheet.getCell('H2').value = { formula: '"Synthetic bulk password"', result: row.password.trim() };
  const requests = [];
  await page.route('**/api/master-bulk?resource=users', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push({ id: route.request().headers()['x-upload-request-id'], body: route.request().postDataBuffer() });
    const response = await route.fetch(); if (requests.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await beginUpload(page, Buffer.from(await workbook.xlsx.writeBuffer()), 'Synthetic users.xlsx');
  await expect(page.locator('.alert[role="alert"]')).toContainText('could not be confirmed');
  await expect(page.getByLabel('Select Model', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click(); const id = await uploaded(page);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  const state = await privateResponse(page, id, row.password); expect(state.rows[0].passwordState).toBe('valid');
  expect((await owner.query('SELECT count(*)::integer AS count FROM master_bulk_batches WHERE organization_id=$1', [f.actor.organizationId])).rows[0].count).toBe(1);
  expect((await owner.query('SELECT text_value,formula,source_type FROM master_bulk_cells WHERE batch_id=$1 AND column_number=8', [id])).rows).toEqual([{ text_value: '', formula: null, source_type: null }]);
});

test('clear, replacement and lost correction/process responses retain exact User outcomes and usable credentials', async ({ page }) => {
  const f = await fixture(); const row = f.row(); await login(page, f.actor); await beginUpload(page, csv([row])); const id = await uploaded(page);
  await page.getByRole('button', { name: 'Fix row 2', exact: true }).click(); await page.getByRole('button', { name: 'Clear password', exact: true }).click();
  await expect(page.getByText('Password will be cleared', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save fixes & revalidate', exact: true }).click(); await expect(summary(page, 'Cannot upload')).toHaveText('1');
  await expect(page.getByText('Missing', { exact: true })).toBeVisible();
  const rejected = await page.request.get(`/api/master-bulk/${id}/rejected`); expect(rejected.status()).toBe(200);
  expect((await decodeMasterXlsx(await rejected.body())).rows[0].values[7]).toBe('');
  const requests = [];
  await page.route(`**/api/master-bulk/${id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    requests.push(route.request().postDataJSON()); const response = await route.fetch();
    if (requests.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  const replacement = 'Replacement synthetic password';
  await page.getByRole('button', { name: 'Fix row 2', exact: true }).click(); await page.getByLabel('Row 2 password', { exact: true }).fill(replacement);
  await page.getByRole('button', { name: 'Save fixes & revalidate', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('could not be confirmed');
  await expect(page.getByLabel('Row 2 password', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry interrupted action', exact: true }).click(); await expect(summary(page, 'Cannot upload')).toHaveText('0');
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); await privateResponse(page, id, replacement);
  const processing = [];
  await page.route(`**/api/master-bulk/${id}/process`, async route => {
    processing.push(route.request().postDataJSON()); const response = await route.fetch();
    if (processing.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Process valid rows', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('could not be confirmed');
  await page.getByRole('button', { name: 'Retry interrupted action', exact: true }).click(); await expect(summary(page, 'Committed')).toHaveText('1');
  expect(processing).toHaveLength(2); expect(processing[1]).toEqual(processing[0]);
  expect((await owner.query('SELECT revision FROM master_bulk_rows WHERE batch_id=$1', [id])).rows).toEqual([{ revision: 3 }]);
  expect((await owner.query('SELECT count(*)::integer AS count FROM user_creation_commands WHERE organization_id=$1', [f.actor.organizationId])).rows[0].count).toBe(1);
  await login(page, { ...row, password: replacement });
});

test('User bulk HTTP and selectors enforce resource permissions, tenant scope, origin, CSRF and revocation', async ({ page }) => {
  const f = await fixture(); let headers = await login(page, f.actor); await beginUpload(page, csv([f.row()])); const id = await uploaded(page);
  expect((await page.request.post(`/api/master-bulk/${id}/review`, { data: { rows: [] } })).status()).toBe(403);
  expect((await page.request.post(`/api/master-bulk/${id}/review`, { data: { rows: [] }, headers: { ...headers, origin: 'https://other.invalid' } })).status()).toBe(403);
  const master = await createAccount(owner, { organizationId: f.actor.organizationId, permissions: ['masters.manage'] });
  const foreign = await createAccount(owner, { permissions: ['users.manage'] });
  for (const [actor, status] of [[master, 404], [foreign, 404], [f.reader, 403]]) {
    headers = await login(page, actor);
    for (const suffix of ['', '/original', '/rejected']) expect((await page.request.get(`/api/master-bulk/${id}${suffix}`)).status()).toBe(status);
    if (actor !== foreign) {
      expect((await page.request.get('/api/master-bulk/sample?resource=users')).status()).toBe(403);
      expect((await page.request.post('/api/master-bulk?resource=users', { headers, data: 'malformed' })).status()).toBe(403);
    }
    if (actor === master) {
      await page.goto('/products'); await page.getByRole('button', { name: 'Bulk Upload', exact: true }).click();
      await expect(page.getByLabel('Select Model', { exact: true }).locator('option')).toHaveText(['Products', 'Parameters', 'Method of Analysis']);
    } else if (actor === f.reader) {
      await page.goto('/user_management'); await expect(page.getByRole('button', { name: 'Bulk Upload', exact: true })).toHaveCount(0);
    }
  }
  headers = await login(page, f.actor);
  expect((await page.request.get('/api/master-bulk/sample?resource=products')).status()).toBe(403);
  const state = await (await page.request.get(`/api/master-bulk/${id}`)).json();
  const review = { rows: [{ id: state.rows[0].id, revision: state.rows[0].revision, requestId: randomUUID() }] };
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.actor.organizationId, f.actor.roleId]);
  expect((await page.request.get(`/api/master-bulk/${id}`)).status()).toBe(403);
  expect((await page.request.post(`/api/master-bulk/${id}/review`, { data: review, headers })).status()).toBe(403);
});

test('missing or unsupported User headers fail before a batch is created and leave the file picker usable', async ({ page }) => {
  const f = await fixture(); await login(page, f.actor);
  await beginUpload(page, Buffer.from('name,password\nPerson,Synthetic password'));
  await expect(page.locator('.alert[role="alert"]')).toContainText('required');
  await expect(page.getByLabel('Select File', { exact: true })).toBeEnabled();
  const source = csv([f.row()]).toString().replace('lab_name', 'project_field.unsupported');
  await page.getByLabel('Select File', { exact: true }).setInputFiles({ name: 'Unsupported.csv', mimeType: 'text/csv', buffer: Buffer.from(source) });
  await page.getByRole('button', { name: 'Upload', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Unknown and duplicate');
  expect((await owner.query('SELECT count(*)::integer AS count FROM master_bulk_batches WHERE organization_id=$1', [f.actor.organizationId])).rows[0].count).toBe(0);
});
