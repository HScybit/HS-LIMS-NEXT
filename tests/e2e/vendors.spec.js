import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { grantSyntheticVendorAccess, emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveVendor } from '../../src/masters/vendors.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function account(permissions = ['masters.manage']) {
  const actor = await createAccount(owner, { permissions });
  Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
  const manager = await grantSyntheticVendorAccess(owner, actor);
  return { ...actor, manager };
}
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(actor.username); await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function fillRequired(page, name = 'Synthetic Vendor') {
  for (const [label, value] of [['Name',name],['Legal Name','Synthetic Vendor Ltd'],['Contact Person','Primary Person'],
    ['Contact Person Email','person@example.invalid'],['Contact Person Phone','0000']]) await page.getByLabel(label, { exact: true }).fill(value);
}
async function headers(page) {
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
}
const input = extra => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Seeded Vendor', legalName: 'Synthetic legal', ...(extra?.contacts ? {} : { contactPersonName: 'Contact', contactPersonEmail: 'contact@example.invalid', contactPersonPhone: '123' }), ...extra });
const save = (actor, value) => withSession(actor.token, (client, identity) => saveVendor(client, identity, value));

test('Vendor source form preserves numbers through lost responses, filtering and deletion', async ({ page }, testInfo) => {
  test.setTimeout(90_000); const actor = await account(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 960 }); await login(page, actor);
  await page.getByRole('link', { name: 'Vendors', exact: true }).click(); await page.getByRole('button', { name: 'New Vendor', exact: true }).click();
  await expect(page.getByLabel('Total Balance (in Rs.)', { exact: true })).toHaveValue('0'); await expect(page.getByLabel('Status', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('Name is required.', { exact: true })).toBeVisible();
  await fillRequired(page); await page.getByLabel('Total Balance (in Rs.)', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Enter a number for Total Balance (in Rs.).', { exact: true })).toBeVisible();
  await page.getByLabel('Total Balance (in Rs.)', { exact: true }).fill('-12.345');
  await page.screenshot({ path: testInfo.outputPath('vendor-form-desktop.png'), fullPage: true, animations: 'disabled' });
  let attempted; let record;
  await page.route('**/api/masters/vendors', async route => {
    if (route.request().method() !== 'POST') return route.continue(); attempted = route.request().postDataJSON();
    const response = await route.fetch(); expect(response.status()).toBe(200); record = await response.json();
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic lost Vendor save' } } });
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('Synthetic lost Vendor save', { exact: true })).toBeVisible();
  await page.unroute('**/api/masters/vendors');
  const retried = page.waitForResponse(response => response.url().endsWith('/api/masters/vendors') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); const response = await retried;
  expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual(attempted);
  expect(record.totalBalance).toBe('-12.35'); expect(record.status).toBe('active');
  await expect(page).toHaveURL(/\/vendor_masters$/);
  await page.getByPlaceholder('Search...', { exact: true }).fill('Synthetic Vendor');
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: record.name, exact: true }) });
  await expect(row).toBeVisible(); await expect(page.getByRole('columnheader')).toHaveCount(5);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.locator('.dt-filter-field').filter({ hasText: 'Contact Person Email' }).locator('input').fill('person@example.invalid');
  await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'Edit', exact: true }).click(); await expect(page.getByLabel('Total Balance (in Rs.)', { exact: true })).toHaveValue('-12.35');
  await page.getByLabel('Total Balance (in Rs.)', { exact: true }).fill('0'); await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('vendor-form-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(row).toBeVisible(); await expect(page).toHaveURL(/filters=/);
  await page.setViewportSize({ width: 1280, height: 960 }); await row.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByRole('cell', { name: '0.00', exact: true })).toBeVisible();
  await page.goBack(); await row.getByRole('button', { name: 'Delete', exact: true }).click(); const modal = page.getByRole('dialog', { name: 'Delete Vendor', exact: true });
  let removal;
  await page.route(`**/api/masters/vendors/${record.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue(); removal = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, json: { error: { message: 'Synthetic lost Vendor deletion' } } });
  });
  await modal.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(modal).toContainText('Synthetic lost Vendor deletion');
  await page.unroute(`**/api/masters/vendors/${record.id}`);
  const removed = page.waitForResponse(response => response.url().endsWith(`/api/masters/vendors/${record.id}`) && response.request().method() === 'DELETE');
  await modal.getByRole('button', { name: 'Delete', exact: true }).click(); const deleted = await removed;
  expect(deleted.status()).toBe(200); expect(deleted.request().postDataJSON()).toEqual(removal); await expect(row).toHaveCount(0); expect(errors).toEqual([]);
});

test('Vendor editing retains inactive status, extra contacts and unsaved changes after a stale save', async ({ page }) => {
  const actor = await account();
  const record = await save(actor, input({ status: 'inactive',
    contacts: [{ id: randomUUID(), name: 'Primary', email: 'p@example.invalid', phone: '123', isPrimary: true },
      { id: randomUUID(), name: 'Extra', email: 'e@example.invalid', phone: '456' }] }));
  await login(page, actor); await page.goto(`/vendor_masters/${record.id}/edit`);
  await expect(page.getByText('These fields edit the displayed contact. Additional contacts are retained.', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Renamed Vendor');
  const response = page.waitForResponse(response => response.url().endsWith('/api/masters/vendors') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); const changed = await (await response).json();
  expect(changed.contacts).toEqual(record.contacts); expect(changed.code).toBe(record.code); expect(changed.status).toBe('inactive');
  await page.goto(`/vendor_masters/${record.id}/edit`); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Renamed Vendor');
  await save(actor, { id: record.id, revision: 2, requestId: randomUUID(), name: 'Other editor' });
  await page.getByLabel('Abbreviation', { exact: true }).fill('UNSAVED'); await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Reload before saving'); await expect(page.getByLabel('Abbreviation', { exact: true })).toHaveValue('UNSAVED');
});

test('Vendor endpoints and navigation enforce module, operation, tenant, origin and CSRF access', async ({ page }) => {
  const actor = await account(); const record = await save(actor, input()); await login(page, actor);
  const command = input({ name: 'HTTP Vendor' }); const authHeaders = await headers(page);
  expect((await page.request.post('/api/masters/vendors', { headers: { ...authHeaders, Origin: 'https://invalid.example' }, data: command })).status()).toBe(403);
  expect((await page.request.post('/api/masters/vendors', { headers: { ...authHeaders, 'X-CSRF-Token': 'wrong' }, data: command })).status()).toBe(403);
  expect((await page.request.post('/api/masters/vendors', { headers: authHeaders, data: { ...command, organizationId: randomUUID() } })).status()).toBe(400);
  const foreign = await account(); await login(page, foreign);
  expect((await page.request.get(`/api/masters/vendors/${record.id}`)).status()).toBe(404);
  const viewer = await account(['masters.read']); await login(page, viewer); await page.getByRole('link', { name: 'Vendors', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New Vendor', exact: true })).toHaveCount(0);
  expect((await page.request.post('/api/masters/vendors', { headers: await headers(page), data: command })).status()).toBe(403);
  await saveModuleAccessSettings(viewer.manager, emptyModuleAccess()); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('link', { name: 'Vendors', exact: true })).toHaveCount(0);
  await expect(page.getByText('Vendor module access is required.', { exact: true })).toBeVisible();
  for (const path of ['/api/masters/vendors','/api/masters/vendors/custom-fields','/api/masters/vendors/custom-field-users']) expect((await page.request.get(path)).status()).toBe(403);
});

test('Vendor configured fields use native generation and attachments and retain the draft after load failures', async ({ page }, testInfo) => {
  test.setTimeout(90_000); const actor = await account();
  const specifications = [['text','Reference',{scheme:'{{entity.name}}/{{abbr}}/{{total_counter}}',generatedAt:'on_submit',showInList:true}],
    ['checkbox','Flag',{}],['attachment','Attachment',{}],['multi_user_select','Users',{}]];
  for(const [index,[fieldType,label,extra]] of specifications.entries()) await withSession(actor.token,(client,identity)=>saveCustomField(client,identity,
    {id:randomUUID(),requestId:randomUUID(),revision:0,key:`field_${index}`,associatedWith:'vendor',fieldType,label,displayOrder:index,...extra}));
  await login(page,actor);
  await page.route('**/api/masters/vendors/custom-fields',route=>route.fulfill({status:503,json:{error:{message:'Synthetic Vendor fields unavailable'}}}));
  await page.goto('/vendor_masters/new');await fillRequired(page,'Generated Vendor');await page.getByLabel('Abbreviation',{exact:true}).fill('GC');
  await expect(page.getByRole('button',{name:'Create',exact:true})).toBeDisabled();await expect(page.getByText('Synthetic Vendor fields unavailable',{exact:false})).toBeVisible();
  await page.unroute('**/api/masters/vendors/custom-fields');await page.getByRole('button',{name:'Retry loading fields',exact:true}).click();
  await expect(page.getByLabel('Reference',{exact:true})).toBeVisible();await expect(page.getByLabel('Name',{exact:true})).toHaveValue('Generated Vendor');
  await page.getByRole('checkbox',{name:'Flag',exact:true}).check();await page.getByRole('checkbox',{name:'Flag',exact:true}).uncheck();
  await page.getByLabel('Attachment',{exact:true}).setInputFiles({name:'Vendor.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic Vendor bytes')});
  await expect(page.getByRole('link',{name:'View File',exact:true})).toBeVisible();
  await page.getByLabel('Users',{exact:true}).fill(actor.userId);await page.getByRole('option',{name:'Synthetic Analyst',exact:true}).click();await page.keyboard.press('Escape');
  await page.route('**/api/masters/vendors/custom-field-generation',route=>route.fulfill({status:503,json:{error:{message:'Synthetic generation unavailable'}}}));
  await page.getByRole('button',{name:'Create',exact:true}).click();await expect(page.getByText('Synthetic generation unavailable',{exact:true})).toBeVisible();
  await page.unroute('**/api/masters/vendors/custom-field-generation');
  const response=page.waitForResponse(response=>response.url().endsWith('/api/masters/vendors')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Create',exact:true}).click();const result=await response;expect(result.status()).toBe(200);const saved=await result.json();
  expect(saved.customFields.map(field=>field.value).slice(0,2)).toEqual(['Generated Vendor/GC/1',false]);
  expect(saved.customFields[3].value).toEqual([actor.userId]);
  await page.goto(`/vendor_masters/${saved.id}/edit`);await expect(page.getByLabel('Reference',{exact:true})).toHaveValue('Generated Vendor/GC/1');
  await expect(page.getByLabel('Flag',{exact:true})).not.toBeChecked();await expect(page.getByRole('link',{name:'View File',exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.getByText('Additional Data Fields',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('vendor-fields-mobile.png'),fullPage:true,animations:'disabled'});
});
