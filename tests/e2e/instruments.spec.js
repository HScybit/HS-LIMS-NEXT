import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveInstrumentCore } from '../../src/instruments/core.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function account(options) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function fixture(permissions = ['instruments.manage']) {
  const setup = await account({ permissions: ['settings.manage', 'masters.manage'] });
  const actor = await account({ organizationId: setup.organizationId, permissions });
  const modules = emptyModuleAccess(); modules[2] = { ...modules[2], enabled: true, userIds: [actor.userId] };
  await saveModuleAccessSettings(setup, modules);
  const laboratoryId = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2,'BROWSER','École laboratory')", [actor.organizationId, laboratoryId]);
  return { setup, actor, modules, laboratoryId };
}
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const seed = (context, changes = {}) => work(context.actor, (client, identity) => saveInstrumentCore(client, identity,
  { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Seeded Instrument', code: 'INST-' + randomUUID(), laboratoryId: context.laboratoryId,
    dateOfInstallation: '2026-09-17', allowedUserIds: [context.actor.userId], ...changes }));
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(actor.username); await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function select(page, label, search, name) {
  await page.getByLabel(label, { exact: true }).fill(search); await page.getByRole('option', { name, exact: true }).click(); await page.keyboard.press('Escape');
}
async function basic(page, context, name = 'Browser Instrument') {
  await page.getByLabel('Name', { exact: true }).fill(name); await page.getByLabel('Unique Key', { exact: true }).fill('BROWSER-1');
  await page.getByLabel('Date of installation', { exact: true }).fill('17/09/2026');
  await select(page, 'Lab', 'ecole', 'École laboratory'); await select(page, 'Allow Access to', context.actor.userId, 'Synthetic Analyst');
}
async function additional(page) {
  for (let step = 0; step < 4 && await page.getByRole('button', { name: 'Next', exact: true }).count(); step++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save Instrument', exact: true })).toBeVisible();
}
async function headers(page) {
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
}

test('Instrument wizard, source columns, filters and QR retain exact lost-save and deletion requests', async ({ page }, testInfo) => {
  test.setTimeout(90_000); const context = await fixture(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 }); await login(page, context.actor);
  await expect(page.getByRole('link', { name: 'Products', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Instruments', exact: true }).click(); await page.getByRole('button', { name: 'New Instrument', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click(); await expect(page.getByText('Name is required.', { exact: true })).toBeVisible();
  await basic(page, context); await page.getByLabel('Make', { exact: true }).fill('Synthetic Make');
  await page.screenshot({ path: testInfo.outputPath('instrument-wizard-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Next', exact: true }).click(); await expect(page.getByLabel('Frequency(in days)', { exact: true })).toBeVisible();
  await page.getByLabel('Last Performed On', { exact: true }).fill('01/09/2026'); await page.getByLabel('Frequency(in days)', { exact: true }).fill('30');
  await page.getByLabel('Remind Before days', { exact: true }).fill('0'); await additional(page);
  let attempted; let record;
  await page.route('**/api/instruments', async route => {
    if (route.request().method() !== 'POST') return route.continue(); attempted = route.request().postDataJSON();
    const response = await route.fetch(); expect(response.status()).toBe(200); record = await response.json();
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic interrupted Instrument save' } } });
  });
  await page.getByRole('button', { name: 'Save Instrument', exact: true }).click(); await expect(page.getByText('Synthetic interrupted Instrument save', { exact: true })).toBeVisible();
  await page.unroute('**/api/instruments'); const retry = page.waitForResponse(response => response.url().endsWith('/api/instruments') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save Instrument', exact: true }).click(); const retried = await retry;
  expect(retried.status()).toBe(200); expect(retried.request().postDataJSON()).toEqual(attempted);
  await expect(page).toHaveURL(/\/equipments\?/); expect(record.serviceConfigurations[0].nextReminderOn).toBe('2026-10-01');
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'Browser Instrument', exact: true }) });
  await expect(row).toBeVisible(); await expect(page.getByRole('columnheader')).toHaveCount(11);
  await page.getByRole('button', { name: 'All Filters', exact: true }).click();
  await expect(page.locator('.offcanvas')).toHaveClass(/\bshow\b/);
  await expect(page.locator('.offcanvas')).not.toHaveClass(/\bshowing\b/);
  await page.getByLabel('Make', { exact: true }).fill('Synthetic');
  await page.getByRole('option', { name: 'Synthetic Make', exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(row).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('instrument-list-desktop.png'), fullPage: true, animations: 'disabled' });
  await row.getByRole('link', { name: 'Browser Instrument', exact: true }).click(); await expect(page.getByRole('img', { name: 'QR code for Browser Instrument', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Preventive Maintenance', exact: true })).toBeVisible();
  const popup = page.waitForEvent('popup'); await page.getByRole('button', { name: 'Print QR', exact: true }).click(); const printed = await popup;
  await expect(printed.locator('.qr-title')).toHaveText('Browser Instrument'); await expect(printed.locator('body')).toContainText('/equipments/' + record.id); await printed.close();
  await page.screenshot({ path: testInfo.outputPath('instrument-detail-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Edit Instrument', exact: true }).click(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Browser Instrument');
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('instrument-wizard-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Additional Details', exact: true }).click(); await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await expect(page).toHaveURL(/\/equipments\?/); await expect(row).toBeVisible();
  const cardBounds = await page.locator('.smplfy-instruments-health-card').boundingBox();
  const legendBounds = await page.locator('.smplfy-calibration-breakdown-legend').boundingBox();
  expect(legendBounds.y + legendBounds.height).toBeLessThanOrEqual(cardBounds.y + cardBounds.height);
  await page.screenshot({ path: testInfo.outputPath('instrument-list-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 960 }); await row.getByRole('button', { name: 'Delete', exact: true }).click(); const modal = page.getByRole('dialog', { name: 'Delete Instrument', exact: true });
  let removal;
  await page.route('**/api/instruments/' + record.id, async route => {
    if (route.request().method() !== 'DELETE') return route.continue(); removal = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic interrupted deletion' } } });
  });
  await modal.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(modal).toContainText('Synthetic interrupted deletion');
  await page.unroute('**/api/instruments/' + record.id); const removed = page.waitForResponse(response => response.url().endsWith('/api/instruments/' + record.id) && response.request().method() === 'DELETE');
  await modal.getByRole('button', { name: 'Delete', exact: true }).click(); expect((await removed).request().postDataJSON()).toEqual(removal); await expect(row).toHaveCount(0); expect(errors).toEqual([]);
});

test('Instrument fields generate and upload with Instrument-only permissions and preserve values after failed refreshes', async ({ page }, testInfo) => {
  test.setTimeout(90_000); const context = await fixture();
  for (const [index, [fieldType, label, extra]] of [['text', 'Reference', { scheme: '{{entity.uniqueKey}}/{{total_counter}}', generatedAt: 'on_submit', showInList: true }],
    ['checkbox', 'Flag', {}], ['attachment', 'Attachment', {}], ['multi_user_select', 'Field users', {}]].entries()) {
    await work(context.setup, (client, identity) => saveCustomField(client, identity, { id: randomUUID(), revision: 0, requestId: randomUUID(), key: 'field_' + index, associatedWith: 'instrument', fieldType, label, displayOrder: index, ...extra }));
  }
  await login(page, context.actor);
  await page.route('**/api/instruments/custom-fields', route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic Instrument fields unavailable' } } }));
  await page.goto('/equipments/new'); await basic(page, context); await additional(page);
  await expect(page.getByRole('button', { name: 'Save Instrument', exact: true })).toBeDisabled(); await expect(page.getByText('Synthetic Instrument fields unavailable', { exact: false })).toBeVisible();
  await page.unroute('**/api/instruments/custom-fields'); await page.getByRole('button', { name: 'Retry loading fields', exact: true }).click(); await expect(page.getByLabel('Reference', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Flag', exact: true }).check(); await page.getByRole('checkbox', { name: 'Flag', exact: true }).uncheck();
  await page.getByLabel('Attachment', { exact: true }).setInputFiles({ name: 'Instrument.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic Instrument bytes') });
  await expect(page.getByRole('link', { name: 'View File', exact: true })).toHaveAttribute('href', /\/api\/instruments\/custom-fields\/attachments\//);
  await select(page, 'Field users', context.actor.userId, 'Synthetic Analyst');
  await page.route('**/api/instruments/custom-field-generation', route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic Instrument generation unavailable' } } }));
  await page.getByRole('button', { name: 'Save Instrument', exact: true }).click(); await expect(page.getByText('Synthetic Instrument generation unavailable', { exact: true })).toBeVisible();
  await page.unroute('**/api/instruments/custom-field-generation'); const result = page.waitForResponse(response => response.url().endsWith('/api/instruments') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save Instrument', exact: true }).click(); const response = await result; expect(response.status()).toBe(200); const record = await response.json();
  expect(record.customFields[0].value).toBe('BROWSER-1/1'); expect(record.customFields[1].value).toBe(false); expect(record.customFields[3].value).toEqual([context.actor.userId]);
  const fileId = record.customFields[2].items[0].attachmentId;
  expect(await (await page.request.get('/api/instruments/custom-fields/attachments/' + fileId)).text()).toBe('Synthetic Instrument bytes');
  await page.goto('/equipments/' + record.id + '/edit'); await page.getByRole('button', { name: 'Additional Details', exact: true }).click();
  await expect(page.getByLabel('Reference', { exact: true })).toHaveValue('BROWSER-1/1'); await expect(page.getByRole('link', { name: 'View File', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath('instrument-fields-mobile.png'), fullPage: true, animations: 'disabled' });
});

test('Instrument edits preserve hidden inactive metadata and drafts after stale saves', async ({ page }) => {
  test.setTimeout(60_000); const context = await fixture();
  const record = await seed(context, { active: false, calibrated: false, costOfEquipment: '0', currentLocation: 'Hidden location', manufacturerSupplier: 'Hidden supplier',
    serviceConfigurations: [{ id: randomUUID(), serviceCode: 'calibration', reminderBeforeDays: 0 }] });
  await login(page, context.actor); await page.goto('/equipments/' + record.id + '/edit');
  await expect(page.getByRole('button', { name: 'Breakdown Details', exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Hidden metadata retained'); await page.getByRole('button', { name: 'Additional Details', exact: true }).click();
  const result = page.waitForResponse(response => response.url().endsWith('/api/instruments') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click(); const saved = await (await result).json();
  expect(saved.active).toBe(false); expect(saved.calibrated).toBe(false); expect(saved.costOfEquipment).toBe('0.00'); expect(saved.currentLocation).toBe('Hidden location');
  // Every fixed service type gets a wizard step, so a save always resubmits all three —
  // the pre-existing calibration configuration keeps its identity among them.
  expect(saved.serviceConfigurations).toHaveLength(3);
  expect(saved.serviceConfigurations.find(service => service.serviceCode === 'calibration').id).toBe(record.serviceConfigurations[0].id);
  await page.goto('/equipments/' + record.id + '/edit'); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Hidden metadata retained');
  await work(context.actor, (client, identity) => saveInstrumentCore(client, identity, { id: record.id, revision: 2, requestId: randomUUID(), name: 'Concurrent update' }));
  await page.getByLabel('Name', { exact: true }).fill('Unsaved Instrument draft'); await page.getByRole('button', { name: 'Additional Details', exact: true }).click();
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click(); await expect(page.getByText('The Instrument changed. Reload before saving.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Basic Details', exact: true }).click(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved Instrument draft');
});

test('Instrument read-only, record restrictions and module revocations apply to pages, navigation and HTTP', async ({ page }) => {
  test.setTimeout(60_000); const context = await fixture(); const record = await seed(context);
  const reader = await account({ organizationId: context.actor.organizationId, permissions: ['instruments.read'] });
  context.modules[2].userIds.push(reader.userId); await saveModuleAccessSettings(context.setup, context.modules);
  await login(page, reader); await page.goto('/equipments'); await expect(page.getByRole('button', { name: 'New Instrument', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/instruments/' + record.id)).status()).toBe(404);
  await work(context.actor, (client, identity) => saveInstrumentCore(client, identity, { id: record.id, revision: 1, requestId: randomUUID(), allowedUserIds: [reader.userId] }));
  await page.goto('/equipments/' + record.id); await expect(page.getByRole('heading', { name: 'Seeded Instrument', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Instrument', exact: true })).toHaveCount(0);
  expect((await page.request.post('/api/instruments', { headers: await headers(page), data: {} })).status()).toBe(403);
  await page.goto('/equipments/' + record.id + '/edit'); await expect(page.getByText('You do not have permission to manage Instruments.', { exact: true })).toBeVisible();
  context.modules[2].userIds = [context.actor.userId]; await saveModuleAccessSettings(context.setup, context.modules);
  for (const path of ['/api/instruments', '/api/instruments/overview', '/api/instruments/custom-fields', '/api/instruments/' + record.id]) expect((await page.request.get(path)).status()).toBe(403);
  await page.reload(); await expect(page.getByRole('link', { name: 'Instruments', exact: true })).toHaveCount(0); await expect(page.getByText('Instrument module access is required.', { exact: true })).toBeVisible();
  await login(page, context.actor);
  expect((await page.request.post('/api/instruments/options', { data: { kind: 'users' } })).status()).toBe(403);
});

test('Instrument choices retain 500 users through bounded requests and search beyond the first page', async ({ page }) => {
  test.setTimeout(60_000); const context = await fixture(); const ids = Array.from({ length: 500 }, () => randomUUID());
  await owner.query("INSERT INTO users(id,username,email,display_name,must_change_password) SELECT id,'instrument-'||id,id||'@example.invalid','Instrument user '||lpad(position::text,3,'0'),false FROM unnest($1::uuid[]) WITH ORDINALITY AS selected(id,position)", [ids]);
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,id FROM unnest($2::uuid[]) AS selected(id)', [context.actor.organizationId, ids]);
  const record = await seed(context, { allowedUserIds: ids }); await login(page, context.actor);
  const response = await page.request.post('/api/instruments/options', { headers: await headers(page), data: { kind: 'users', search: 'Instrument user', page: 2, selectedIds: ids } });
  expect(response.status()).toBe(200); const result = await response.json(); expect(result.rows).toHaveLength(100); expect(result.rows[0].id).toBe(ids[100]); expect(result.retained).toHaveLength(500);
  await page.goto('/equipments/' + record.id + '/edit'); await expect(page.getByText('+498 more', { exact: true })).toBeVisible();
  await page.getByLabel('Allow Access to', { exact: true }).fill('Instrument user 500'); await expect(page.getByRole('option', { name: 'Instrument user 500', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Additional Details', exact: true }).click(); const saved = page.waitForResponse(response => response.url().endsWith('/api/instruments') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click(); expect((await (await saved).json()).allowedUserIds).toEqual(ids);
});

test('all three fixed service types and Additional Details remain reachable in the desktop wizard', async ({ page }) => {
  const context = await fixture();
  const record = await seed(context);
  await page.setViewportSize({ width: 1440, height: 960 }); await login(page, context.actor);
  await page.goto('/equipments/' + record.id + '/edit');
  const sidebar = page.locator('.smplfy-new-instrument-page aside');
  await expect(sidebar.getByRole('button')).toHaveCount(5);
  for (const label of ['Basic Details', 'Preventive Maintenance Details', 'Breakdown Details', 'Calibration Details', 'Additional Details']) {
    await expect(sidebar.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  const additional = sidebar.getByRole('button', { name: 'Additional Details', exact: true });
  await additional.click();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/instruments') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  expect((await (await saved).json()).serviceConfigurations).toHaveLength(3);
});

test.describe('Instrument viewer calendar', () => {
  test.use({ timezoneId: 'Pacific/Kiritimati' });
  test('list and health use the browser calendar day across a UTC date boundary', async ({ page }) => {
    const context = await fixture();
    await seed(context, { serviceConfigurations: [{ id: randomUUID(), serviceCode: 'calibration', nextReminderOn: '2026-09-17', reminderBeforeDays: 0 }] });
    await page.clock.setFixedTime(new Date('2026-09-17T12:30:00Z')); await login(page, context.actor);
    const listing = page.waitForResponse(response => response.url().includes('/api/instruments?query='));
    const overview = page.waitForResponse(response => response.url().includes('/api/instruments/overview?'));
    await page.goto('/equipments'); const listResponse = await listing; const overviewResponse = await overview;
    expect(JSON.parse(new URL(listResponse.url()).searchParams.get('query')).asOfDate).toBe('2026-09-18');
    expect(new URL(overviewResponse.url()).searchParams.get('asOfDate')).toBe('2026-09-18');
    expect((await listResponse.json()).rows[0].calibrated).toBe('No'); expect((await overviewResponse.json()).health.healthy).toBe(0);
    await expect(page.getByText('0/1 Instruments are healthy.', { exact: true })).toBeVisible();
  });
});
