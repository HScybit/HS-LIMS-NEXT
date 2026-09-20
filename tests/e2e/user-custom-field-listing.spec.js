import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField, userCustomFields } from '../../src/masters/custom-fields.js';
import { saveUserCustomFields } from '../../src/users/custom-fields.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const metadataRoute = /\/api\/users\/custom-fields\?view=list$/;
const row = (page, person) => page.getByRole('row').filter({ has: page.getByText(`Username: ${person.username}`, { exact: true }) });
const focus = page => page.evaluate(() => window.dispatchEvent(new Event('focus')));
async function fixture(page) {
  const author = await createAccount(owner, { permissions: ['masters.manage'] }); const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] });
  const authorSession = await signIn({ identifier: author.username, password: author.password }); const managerSession = await signIn({ identifier: manager.username, password: manager.password });
  const change = fn => withSession(authorSession.token, fn);
  const define = input => change((c, i) => saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0,
    key: 'field', label: 'Field', fieldType: 'text', associatedWith: 'users', showInList: true, showInFilter: true, ...input }));
  const update = (field, changes) => define({ ...Object.fromEntries(['id', 'key', 'label', 'fieldType', 'options', 'showInList', 'showInFilter', 'allowsMultiple', 'dateFormat', 'datetimeFormat'].map(key => [key, field[key]])), revision: field.revision, ...changes });
  const save = (values, subject = person) => withSession(managerSession.token, async (c, i) => {
    const fields = await userCustomFields(c, i);
    return saveUserCustomFields(c, i, subject.userId, { requestId: randomUUID(), revision: 0,
      customFields: fields.map(field => ({ fieldId: field.id, fieldRevision: field.revision, value: values[field.key] ?? '' })) });
  });
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(manager.username); await page.getByLabel('Password', { exact: true }).fill(manager.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  return { author, manager, person, define, update, save, change };
}

test('user columns show captured zero, false and historical labels while visible and hidden filters use saved keys', async ({ page }) => {
  const f = await fixture(page); const other = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  await f.define({ key: 'note', label: 'Note' }); await f.define({ key: 'zero', label: 'Zero', fieldType: 'number' }); await f.define({ key: 'flag', label: 'Flag', fieldType: 'checkbox' });
  await f.define({ key: 'hidden', label: 'Hidden details', showInList: false });
  const choice = await f.define({ key: 'choice', label: 'Choice', fieldType: 'select', options: [
    { id: randomUUID(), key: 'A', label: 'Original captured label' }, { id: randomUUID(), key: 'B', label: 'Beta label' },
  ] });
  const note = `Evidence ${randomUUID()}`;
  await f.save({ note, zero: 0, flag: false, choice: 'A', hidden: 'Hidden searchable evidence' });
  await f.save({ note: 'Other evidence', zero: 1, flag: true, choice: 'B', hidden: 'Other hidden evidence' }, other);
  await f.update(choice, { options: choice.options.map(option => ({ ...option, label: option.key === 'A' ? 'Current replacement label' : option.label })) });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto('/user_management');
  await expect(row(page, f.person).getByRole('cell', { name: '0', exact: true })).toBeVisible();
  await expect(row(page, f.person).getByRole('cell', { name: 'false', exact: true })).toBeVisible();
  await expect(row(page, f.person).getByTitle('Original captured label', { exact: true })).toHaveText('Original captured la...');
  await expect(page.getByRole('columnheader', { name: 'Hidden details', exact: true })).toHaveCount(0);
  await page.getByPlaceholder('Search...', { exact: true }).first().fill(note); await expect(page.locator('tbody tr')).toHaveCount(1); await expect(row(page, f.person)).toBeVisible();
  await page.getByPlaceholder('Search...', { exact: true }).first().fill(''); await expect(row(page, other)).toBeVisible();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await expect(page.getByPlaceholder('Filter Hidden details', { exact: true })).toBeVisible();
  await page.locator('.dt-filter-field').filter({ has: page.locator('label', { hasText: /^Choice$/ }) }).locator('select').selectOption('Beta label');
  const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/users' && request.method() === 'GET'
    && Boolean(JSON.parse(new URL(request.url()).searchParams.get('query') || '{}').filters?.['pf:choice']));
  await page.getByRole('button', { name: 'Apply Filters', exact: true }).click();
  expect(JSON.parse(new URL((await request).url()).searchParams.get('query')).filters['pf:choice']).toEqual({ type: 'select', value: 'Beta label' });
  await expect(page.locator('tbody tr')).toHaveCount(1); await expect(row(page, other)).toBeVisible();
  await page.screenshot({ path: '.local/m04-user-field-list-desktop.png', fullPage: true, animations: 'disabled' });
  await page.locator('.dt-table-wrap').evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await page.screenshot({ path: '.local/m04-user-field-list-desktop-columns.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.lims-main').evaluate(element => element.getBoundingClientRect().left)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.dt-table-wrap').evaluate(element => { element.scrollLeft = 0; });
  await page.screenshot({ path: '.local/m04-user-field-list-mobile.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('cell', { name: 'Beta label', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('cell', { name: 'Beta label', exact: true })).toBeInViewport();
  await page.screenshot({ path: '.local/m04-user-field-list-mobile-columns.png', fullPage: true, animations: 'disabled' }); expect(errors).toEqual([]);
});

test('same-key replacement preserves listing filters, sorting and values through refresh without rewriting a capture', async ({ page }) => {
  const f = await fixture(page); const original = await f.define({ key: 'persistent', label: 'Original field' }); await f.save({ persistent: 'Preserved saved value' });
  const filters = { 'pf:persistent': { type: 'text', value: 'Preserved saved value' } };
  const query = new URLSearchParams({ filters: encodeURIComponent(JSON.stringify(filters)), sortKey: 'pf:persistent', sortDir: 'asc' });
  await page.goto(`/user_management?${query}`); await expect(page.locator('tbody tr')).toHaveCount(1); await expect(row(page, f.person).getByTitle('Preserved saved value', { exact: true })).toHaveText('Preserved saved valu...');
  await f.change((c, i) => retireCustomField(c, i, { id: original.id, revision: 1, requestId: randomUUID() }));
  const replacement = await f.define({ key: 'persistent', label: 'Replacement field' }); await focus(page);
  await expect(page.getByRole('columnheader', { name: 'Replacement field', exact: true })).toBeVisible();
  await expect(row(page, f.person).getByTitle('Preserved saved value', { exact: true })).toHaveText('Preserved saved valu...'); expect(new URL(page.url()).searchParams.get('sortKey')).toBe('pf:persistent');
  expect(JSON.parse(decodeURIComponent(new URL(page.url()).searchParams.get('filters')))).toEqual(filters);
  expect(replacement.id).not.toBe(original.id);
  const capture = await (await page.request.get(`/api/users/${f.person.userId}/custom-fields`)).json();
  expect(capture.revision).toBe(1); expect(capture.customFields[0].fieldId).toBe(original.id);
});

test('field metadata failures preserve list state and an unknown status change retries after columns refresh', async ({ page }) => {
  const f = await fixture(page); const field = await f.define({ key: 'evidence', label: 'Original evidence' }); await f.save({ evidence: 'Recorded evidence' });
  const query = new URLSearchParams({ search: f.person.username, sortKey: 'pf:evidence', sortDir: 'asc' });
  await page.route(metadataRoute, route => route.fulfill({ status: 503, json: { error: { code: 'metadata_interrupted', message: 'Metadata loading interrupted.' } } }));
  await page.goto(`/user_management?${query}`); await expect(page.getByRole('alert').filter({ hasText: 'Metadata loading interrupted.' })).toBeVisible();
  await page.unroute(metadataRoute); await page.getByRole('button', { name: 'Retry loading fields', exact: true }).click();
  await expect(row(page, f.person)).toContainText('Recorded evidence'); expect(new URL(page.url()).searchParams.get('sortKey')).toBe('pf:evidence');
  const requests = [];
  await page.route(`**/api/users/${f.person.userId}/status`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue(); requests.push(route.request().postDataJSON());
    if (requests.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); return route.fulfill({ status: 503,
      json: { error: { code: 'status_response_lost', message: 'Status response interrupted.' } } }); }
    return route.continue();
  });
  await row(page, f.person).getByRole('button', { name: 'Active', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry status change', exact: true })).toBeVisible();
  await f.update(field, { label: 'Revised evidence' });
  await page.route(metadataRoute, route => route.fulfill({ status: 503, json: { error: { code: 'metadata_interrupted', message: 'Later metadata interruption.' } } }));
  await focus(page); await expect(page.getByRole('alert').filter({ hasText: 'Later metadata interruption.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry status change', exact: true })).toBeVisible();
  await page.unroute(metadataRoute); await page.getByRole('button', { name: 'Retry loading fields', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Revised evidence', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry status change', exact: true }).click(); await expect(row(page, f.person).getByRole('button', { name: 'Inactive', exact: true })).toBeVisible();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect((await owner.query('SELECT status_revision FROM memberships WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, f.person.userId])).rows[0].status_revision).toBe(1);
});

test('custom list HTTP validates configured filters and current user permission without exposing another tenant', async ({ page }) => {
  const f = await fixture(page); await f.define({ key: 'scoped' }); const value = `Scoped ${randomUUID()}`; await f.save({ scoped: value });
  const foreign = await createAccount(owner, { permissions: ['users.manage', 'masters.manage'] }); const session = await signIn({ identifier: foreign.username, password: foreign.password });
  await withSession(session.token, async (c, i) => {
    const field = await saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'scoped', label: 'Foreign scoped field',
      fieldType: 'text', associatedWith: 'users', showInList: true, showInFilter: true });
    await saveUserCustomFields(c, i, foreign.userId, { requestId: randomUUID(), revision: 0, customFields: [{ fieldId: field.id, fieldRevision: 1, value }] });
  });
  const read = async query => page.request.get('/api/users?' + new URLSearchParams({ query: JSON.stringify(query) }));
  const response = await read({ filters: { 'pf:scoped': { type: 'text', value } }, sort: { key: 'pf:scoped', dir: 'desc' } });
  expect(response.status()).toBe(200); expect((await response.json()).rows.map(person => person.id)).toEqual([f.person.userId]);
  for (const query of [{ filters: { 'pf:absent': { type: 'text', value } } }, { filters: { 'pf:scoped': { type: 'relation', value: [] } } },
    { sort: { key: 'pf:scoped', dir: 'asc; SELECT 1' } }]) expect((await read(query)).status()).toBe(400);
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code=$3', [f.manager.organizationId, f.manager.roleId, 'users.manage']);
  const denied = await read({ search: value }); expect(denied.status()).toBe(403); expect(await denied.text()).not.toContain(value);
  expect((await page.request.get('/api/users/custom-fields?view=list')).status()).toBe(403);
});
