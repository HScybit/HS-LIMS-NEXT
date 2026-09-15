import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { saveUserCustomFields } from '../../src/users/custom-fields.js';
import { updateUserProfile } from '../../src/users/profiles.js';

let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await closePool(); await owner.end(); });
const work = (actor, action) => withSession(actor.token, action);
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const currentLines = [{ id: 'original-A', label: 'Current Alpha' }, { id: 'original-B', label: 'Current Beta' }, { id: 'original-C', label: 'Current Gamma' }];
async function fixture(page) {
  const author = await createAccount(owner, { permissions: ['masters.manage'] }); author.token = (await signIn({ identifier: author.username, password: author.password })).token;
  const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage', 'users.read'] });
  manager.token = (await signIn({ identifier: manager.username, password: manager.password })).token;
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] }); const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Choice loading laboratory')", [author.organizationId, lab]);
  await work(manager, (c, i) => updateUserProfile(c, i, person.userId, { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab }));
  const source = { id: randomUUID(), requestId: randomUUID(), revision: 0, sourceId: 'Original-choices-' + randomUUID(), name: 'Shared source',
    lines: currentLines.map(line => ({ ...line, label: line.label.replace('Current', 'Captured') })) };
  await work(author, (c, i) => saveLookupSourceObservation(c, i, source)); let sourceRevision = 1;
  const observe = async lines => { const result = await work(author, (c, i) => saveLookupSourceObservation(c, i, { ...source, requestId: randomUUID(), revision: sourceRevision, lines })); sourceRevision = result.revision; return result; };
  const fields = [];
  for (const [key, label, fieldType, extra] of [['single', 'Single location', 'lookup', {}], ['multiple', 'Multiple locations', 'lookup', { allowsMultiple: true }], ['note', 'Lookup note', 'text', {}]]) {
    fields.push(await work(author, (c, i) => saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0, key, label, fieldType,
      associatedWith: 'users', displayOrder: fields.length, ...(fieldType === 'lookup' ? { lookupSourceId: source.id } : {}), ...extra })));
  }
  await work(manager, (c, i) => saveUserCustomFields(c, i, person.userId, { requestId: randomUUID(), revision: 0,
    customFields: fields.map((field, index) => ({ fieldId: field.id, fieldRevision: 1, value: index === 0 ? 'original-A' : index === 1 ? ['original-A', 'original-A', 'original-B'] : 'Saved note' })) }));
  await observe(currentLines); await login(page, manager);
  return { author, manager, person, fields, source, observe, url: `/user_management/${person.userId}/edit`, saveUrl: `/api/users/${person.userId}` };
}
const focus = page => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const group = (page, label) => page.locator('.smplfy-form-field').filter({ has: page.getByLabel(label, { exact: true }) });
const read = async (page, f, revision) => {
  const response = await page.request.get(`/api/users/${f.person.userId}/custom-fields${revision ? `?atRevision=${revision}` : ''}`);
  expect(response.status()).toBe(200); return response.json();
};
const edit = async (page, f) => { await page.goto(f.url); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled(); };
const byKey = result => new Map(result.customFields.map(field => [field.key, field]));

test('configured catalogs load once per source and filtered bulk actions preserve the full source set and repeated selections', async ({ page }, info) => {
  const f = await fixture(page); const requests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/users/custom-fields/lookup-options') requests.push(new URL(request.url()).searchParams); });
  await edit(page, f); await expect(group(page, 'Single location').getByText('Current Alpha', { exact: true })).toBeVisible();
  expect(requests.length).toBe(1); expect(requests[0].get('sourceId')).toBe(f.source.id);
  await page.getByLabel('Lookup note', { exact: true }).fill('Draft survives unchanged refresh');
  await focus(page); await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].get('revision')).toBe('2'); expect(requests[1].get('knownOrganizationId')).toBe(f.author.organizationId);
  await expect(page.getByLabel('Lookup note', { exact: true })).toHaveValue('Draft survives unchanged refresh');
  await page.getByLabel('Multiple locations', { exact: true }).fill('Gamma');
  await expect(page.getByRole('option', { name: 'Current Gamma', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Current Alpha', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select visible', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear all (4)', exact: true })).toBeVisible();
  await expect(group(page, 'Single location').getByText('Current Alpha', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('lookup-full-catalog-bulk.png'), fullPage: true, animations: 'disabled' });
  await page.getByLabel('Single location', { exact: true }).fill('Beta'); await page.getByRole('option', { name: 'Current Beta', exact: true }).click();
  await page.getByLabel('Lookup note', { exact: true }).focus(); await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  const saved = byKey(await read(page, f)); expect(saved.get('multiple').value).toEqual(['original-A', 'original-A', 'original-B', 'original-C']);
  expect(saved.get('single').value).toBe('original-B');
  expect(saved.get('multiple').displayValue).toBe('Current Alpha, Current Alpha, Current Beta, Current Gamma');
  expect(byKey(await read(page, f, 1)).get('multiple').displayValue).toBe('Captured Alpha, Captured Alpha, Captured Beta');
  await edit(page, f); await page.getByLabel('Multiple locations', { exact: true }).fill('Gamma');
  await page.getByRole('button', { name: 'Deselect visible', exact: true }).click(); await page.getByLabel('Lookup note', { exact: true }).focus();
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  expect(byKey(await read(page, f)).get('multiple').value).toEqual([]);
});

test('large lookup menus preserve keyboard, measured labels, complete bulk actions and selected-last reopening', async ({ page }, info) => {
  test.setTimeout(90_000);
  const f = await fixture(page); const lines = [...currentLines, ...Array.from({ length: 9997 }, (_, index) => ({ id: `large-${index}`, label: `Lookup choice ${index}` }))];
  lines.at(-1).label = 'Last catalog choice '.padEnd(200, 'x'); lines[5000].label = 'Very long catalog choice '.padEnd(1600, 'x');
  await f.observe(lines); await edit(page, f);
  const multiple = page.getByLabel('Multiple locations', { exact: true }); await multiple.click();
  const focused = async input => input.evaluate(element => {
    const option = document.getElementById(element.getAttribute('aria-activedescendant')); const menu = document.querySelector('[role="listbox"]');
    const rect = option?.getBoundingClientRect(); const bounds = menu?.getBoundingClientRect();
    return { position: Number(option?.getAttribute('aria-posinset')), size: Number(option?.getAttribute('aria-setsize')),
      withinMenu: Boolean(rect && bounds && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1) };
  });
  expect(await page.getByRole('option').count()).toBeLessThan(50);
  await expect(page.getByText('2/10000 visible selected', { exact: true })).toBeVisible();
  for (const [key, position] of [['End', 10000], ['Home', 1], ['ArrowDown', 2], ['PageDown', 7], ['PageUp', 2], ['End', 10000], ['ArrowUp', 9999]]) {
    await multiple.press(key); await expect.poll(() => focused(multiple)).toEqual({ position, size: 10000, withinMenu: true });
  }
  await multiple.press('Enter'); await expect(page.getByRole('button', { name: 'Clear all (4)', exact: true })).toBeVisible();
  await expect(group(page, 'Single location').getByText('Current Alpha', { exact: true })).toBeVisible();
  await multiple.fill('Last catalog choice'); await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toHaveText(lines.at(-1).label);
  await page.getByRole('button', { name: 'Select visible', exact: true }).click();
  await expect(group(page, 'Multiple locations').getByText('Select at most 500 items.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear all (4)', exact: true })).toBeVisible();
  await expect(page.getByText('3/10000 visible selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear all (4)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear all', exact: true })).toBeDisabled();
  await multiple.fill('No matching catalog choice'); await expect(page.getByText('No options found', { exact: true })).toBeVisible();
  await multiple.fill(''); await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(0);
  expect(await page.getByRole('option').count()).toBeLessThan(50); await multiple.press('Escape');
  const single = page.getByLabel('Single location', { exact: true }); await single.click(); await single.press('End');
  await expect.poll(() => focused(single)).toEqual({ position: 10000, size: 10000, withinMenu: true }); await single.press('Enter');
  await single.click(); await expect.poll(() => focused(single)).toEqual({ position: 10000, size: 10000, withinMenu: true });
  await page.setViewportSize({ width: 700, height: 900 });
  await expect.poll(() => focused(single)).toEqual({ position: 10000, size: 10000, withinMenu: true });
  const option = page.locator('[role="option"][aria-posinset="10000"]'); await expect(option).toHaveText(lines.at(-1).label);
  const geometry = await option.evaluate(element => { const label = element.querySelector('.smplfy-rselect__option-label');
    return { height: element.getBoundingClientRect().height, labelHeight: label.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(label).lineHeight) }; });
  expect(geometry.labelHeight).toBeGreaterThan(geometry.lineHeight * 2); expect(geometry.height).toBeGreaterThan(geometry.labelHeight);
  const cdp = await page.context().newCDPSession(page);
  try {
    const ax = await cdp.send('Accessibility.getFullAXTree'); const choices = ax.nodes.filter(node => !node.ignored && node.role?.value === 'option');
    expect(choices.length).toBeGreaterThan(0); expect(choices.length).toBeLessThan(50); expect(choices.some(node => node.name?.value === lines.at(-1).label)).toBe(true);
  } finally { await cdp.detach(); }
  await page.screenshot({ path: info.outputPath('large-lookup-wrapped-last.png') }); await single.press('Home');
  await expect.poll(() => focused(single)).toEqual({ position: 1, size: 10000, withinMenu: true });
  await page.getByRole('listbox').hover(); await page.mouse.wheel(0, 1000);
  await expect.poll(() => page.getByRole('listbox').evaluate(element => element.scrollTop)).toBeGreaterThan(500);
  await single.press('End'); await expect.poll(() => focused(single)).toEqual({ position: 10000, size: 10000, withinMenu: true });
  await single.fill('Very long catalog choice'); await expect(page.getByRole('option')).toHaveCount(1); await page.getByRole('option').click();
  await single.click(); const oversized = page.locator('[role="option"][aria-posinset="5001"]'); await expect(oversized).toHaveText(lines[5000].label);
  const tallRow = () => oversized.evaluate(element => {
    const menu = element.closest('[role="listbox"]'); const label = element.querySelector('.smplfy-rselect__option-label');
    const row = element.getBoundingClientRect(); const text = label.getBoundingClientRect(); const bounds = menu.getBoundingClientRect();
    return { height: row.height, menuHeight: bounds.height, topDelta: text.top - bounds.top - 8,
      bottomDelta: text.bottom - bounds.bottom + 8, topVisible: text.top >= bounds.top && text.top < bounds.bottom,
      bottomVisible: text.bottom <= bounds.bottom && text.bottom > bounds.top };
  });
  await expect.poll(async () => { const row = await tallRow(); return row.height > row.menuHeight; }).toBe(true);
  await page.getByRole('listbox').hover(); await page.mouse.wheel(0, (await tallRow()).topDelta);
  await expect.poll(async () => (await tallRow()).topVisible).toBe(true);
  await page.mouse.wheel(0, (await tallRow()).bottomDelta); await expect.poll(async () => (await tallRow()).bottomVisible).toBe(true);
});

test('initial lookup failures block Save and refresh failures retain mounted drafts until a successful retry', async ({ page }) => {
  const f = await fixture(page); let release; const held = new Promise(resolve => { release = resolve; }); let arrived;
  const requested = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/users/custom-fields/lookup-options?**', async route => { arrived(); await held; return route.fulfill({ status: 503, json: { error: { message: 'Synthetic catalog unavailable' } } }); });
  await page.goto(f.url); await requested;
  try { await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await expect(page.getByText('Loading additional data fields...', { exact: true })).toBeVisible();
  } finally { release(); }
  await expect(page.getByRole('button', { name: 'Retry loading fields', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  await page.unroute('**/api/users/custom-fields/lookup-options?**'); await page.getByRole('button', { name: 'Retry loading fields', exact: true }).click();
  await expect(group(page, 'Single location').getByText('Current Alpha', { exact: true })).toBeVisible();
  await page.getByLabel('Lookup note', { exact: true }).fill('Keep this draft');
  await page.route('**/api/users/custom-fields/lookup-options?**', route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic refresh failure' } } }));
  await focus(page); await expect(page.getByRole('button', { name: 'Retry loading fields', exact: true })).toBeVisible();
  await expect(page.getByLabel('Lookup note', { exact: true })).toHaveValue('Keep this draft'); await expect(page.getByLabel('Lookup note', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  await page.unroute('**/api/users/custom-fields/lookup-options?**'); await page.getByRole('button', { name: 'Retry loading fields', exact: true }).click();
  await expect(page.getByLabel('Lookup note', { exact: true })).toBeEnabled(); await expect(page.getByLabel('Lookup note', { exact: true })).toHaveValue('Keep this draft');
  expect((await read(page, f)).revision).toBe(1);
});

test('cleared and reappearing choices preserve raw drafts, saved-key replacement and exact unknown-save retries', async ({ page }) => {
  const f = await fixture(page); await edit(page, f); await page.getByLabel('Lookup note', { exact: true }).fill('Pending lookup draft');
  await f.observe([]); await focus(page); await expect(group(page, 'Single location').getByText('original-A', { exact: true })).toBeVisible();
  const requests = [];
  await page.route('**' + f.saveUrl, async route => {
    if (route.request().method() !== 'PATCH') return route.continue(); requests.push(route.request().postDataJSON());
    if (requests.length === 1) { const response = await route.fetch(); if (response.status() !== 200) return route.fulfill({ response }); return route.abort('failed'); }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  expect(byKey(await read(page, f)).get('single').items[0]).toMatchObject({ interpretationState: 'invalid', lookupSourceId: null });
  await f.observe(currentLines.map(line => ({ ...line, label: line.label.replace('Current', 'Restored') })));
  await focus(page); await expect(page.getByLabel('Lookup note', { exact: true })).toHaveValue('Pending lookup draft'); await expect(page.getByLabel('Lookup note', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/); expect(requests[1]).toEqual(requests[0]);
  expect((await read(page, f)).revision).toBe(2); await page.unroute('**' + f.saveUrl);
  await edit(page, f); await expect(group(page, 'Single location').getByText('Restored Alpha', { exact: true })).toBeVisible();
  await page.getByLabel('Lookup note', { exact: true }).fill('Replacement keeps draft');
  await work(f.author, (c, i) => saveCustomField(c, i, { id: f.fields[0].id, revision: 1, requestId: randomUUID(), key: 'renamed_single',
    label: 'Single location', fieldType: 'lookup', associatedWith: 'users', lookupSourceId: f.source.id, displayOrder: 0 }));
  const replacement = await work(f.author, (c, i) => saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'single',
    label: 'Replacement location', fieldType: 'lookup', associatedWith: 'users', lookupSourceId: f.source.id }));
  await focus(page); await expect(page.getByLabel('Replacement location', { exact: true })).toBeVisible();
  await expect(group(page, 'Replacement location').getByText('Restored Alpha', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Lookup note', { exact: true })).toHaveValue('Replacement keeps draft');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  const saved = byKey(await read(page, f)); expect(saved.get('single').fieldId).toBe(replacement.id); expect(saved.get('single').value).toBe('original-A');
  expect(saved.get('single').items[0]).toMatchObject({ interpretationState: 'valid', lookupRevision: 4 });
});

test('permission refresh discards a late catalog response while preserving the mounted draft', async ({ page }) => {
  const f = await fixture(page); await edit(page, f); await page.getByLabel('Lookup note', { exact: true }).fill('Retained after permission loss');
  await f.observe(currentLines.map(line => ({ ...line, label: line.label.replace('Current', 'Late') })));
  let release; const held = new Promise(resolve => { release = resolve; }); let arrived; const requested = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/users/custom-fields/lookup-options?**', async route => { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); });
  await focus(page); await requested;
  try {
    await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='users.manage'", [f.manager.organizationId, f.manager.roleId]);
    await page.evaluate(() => { const channel = new BroadcastChannel('sampleify_session'); channel.postMessage('changed'); channel.close(); });
    await expect(page.getByLabel('Lookup note', { exact: true })).toBeDisabled({ timeout: 15000 });
  } finally { release(); }
  await expect(page.getByLabel('Lookup note', { exact: true })).toHaveValue('Retained after permission loss');
  await expect(group(page, 'Single location').getByText('Current Alpha', { exact: true })).toBeVisible();
  await expect(group(page, 'Single location').getByText('Late Alpha', { exact: true })).toHaveCount(0); expect((await read(page, f)).revision).toBe(1);
});

test('lookup-choice HTTP enforces strict queries, current tenant scope, cache scope and actual authorization', async ({ page }) => {
  const f = await fixture(page); const path = '/api/users/custom-fields/lookup-options'; const query = `sourceId=${f.source.id}`;
  const result = await page.request.get(path + '?' + query); expect(result.status()).toBe(200); expect(result.headers()['cache-control']).toBe('no-store');
  expect((await result.json()).options).toEqual(currentLines.map(line => ({ value: line.id, label: line.label })));
  const same = await page.request.get(path + '?' + query + `&revision=2&knownOrganizationId=${f.author.organizationId}`);
  expect(await same.json()).toEqual({ organizationId: f.author.organizationId, sourceId: f.source.id, revision: 2, unchanged: true });
  for (const invalid of ['', 'sourceId=invalid', `${query}&${query}`, `${query}&revision=0`, `${query}&revision=01`, `${query}&revision=2e0`,
    `${query}&revision=2147483648`, `${query}&revision=2&revision=2`, `${query}&knownOrganizationId=invalid`, `${query}&organizationId=${f.author.organizationId}`]) {
    expect((await page.request.get(path + '?' + invalid)).status()).toBe(400);
  }
  for (const method of ['POST', 'PATCH', 'DELETE']) expect((await page.request.fetch(path + '?' + query, { method, data: {} })).status()).toBe(405);
  await login(page, f.author); expect((await page.request.get(path + '?' + query)).status()).toBe(403);
  const foreign = await createAccount(owner, { permissions: ['users.read'] }); await login(page, foreign);
  expect((await (await page.request.get(path + '?' + query)).json()).options).toEqual([]);
  await page.context().clearCookies(); expect((await page.request.get(path + '?' + query)).status()).toBe(401);
});
