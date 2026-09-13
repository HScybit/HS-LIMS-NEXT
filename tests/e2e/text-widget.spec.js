import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

test('editable Text preserves source keyboard, cancellation, repeat, retry and frozen-history behavior', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  const account = await createAccount(owner, { permissions: ['samples.read', 'samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const fixture = await createLaboratoryFixture(owner, account);
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (action) => withSession(session.token, action, { csrfToken: session.csrfToken });
  let revision = 1; const fields = {};
  for (const editable of [true, false]) {
    const alias = editable ? 'editable_heading' : 'fixed_heading';
    const row = await work((client, identity) => editTemplate(client, identity, fixture.template.versionId, revision,
      { type: 'addColumn', rowId: fixture.template.records.rows[0].id }));
    const columnId = row.model.rowsById[fixture.template.records.rows[0].id].columnIds.at(-1);
    const configured = await work((client, identity) => editTemplate(client, identity, fixture.template.versionId, row.model.version.revision,
      { type: 'configureField', columnId, widget: 'text_widget', alias, label: editable ? 'Original heading' : 'Fixed heading', editable }));
    revision = configured.model.version.revision; fields[alias] = configured.model.columnsById[columnId].fieldId;
  }
  const sample = await work((client, identity) => registerSample(client, identity, fixture.registration));
  const generated = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  const requestId = generated.items[0].id;
  const allocated = await work((client, identity) => allocateTestRequest(client, identity, requestId, { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId }));
  const path = `/samples/${sample.id}/data_sheets/${allocated.datasheetId}`;
  const api = `/api/datasheets/${allocated.datasheetId}`;
  const runtime = () => page.request.get(api).then((response) => response.json());
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  await page.goto(path);
  const columns = page.locator(`[data-field-id="${fields.editable_heading}"]`);
  const edit = (index = 0) => columns.nth(index).getByRole('button', { name: 'Edit editable_heading', exact: true });
  const input = () => page.getByRole('textbox', { name: 'Edit editable_heading', exact: true });
  const alert = page.locator('.tr-details-results-page').getByRole('alert');
  await expect(edit()).toBeVisible(); await expect(columns).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Edit fixed_heading', exact: true })).toHaveCount(0);
  const original = await runtime(); const originalRevision = original.capture.revision;
  for (const [draft, key] of [['Discard me', 'Escape'], ['   ', 'Tab'], ['Original heading', 'Enter']]) {
    await edit().click(); await input().fill(draft); await input().press(key);
    await expect(input()).toHaveCount(0); await expect(columns.first()).toHaveText('Original heading');
    expect((await runtime()).capture.revision).toBe(originalRevision);
  }
  await edit().click(); await input().fill(' 0 ');
  const zeroSave = page.waitForResponse((response) => response.url().endsWith(`${api}/values`) && response.request().method() === 'PATCH');
  await input().press('Enter'); expect((await zeroSave).status()).toBe(200);
  await expect(columns.first()).toHaveText('0'); await expect(columns.nth(1)).toHaveText('Original heading');
  const afterZero = await runtime(); expect(afterZero.capture.revision).toBe(originalRevision + 1);
  expect(afterZero.model.fieldsById[fields.editable_heading].label).toBe('Original heading');
  const firstOccurrence = afterZero.capture.values.find((value) => value.fieldId === fields.editable_heading).occurrenceId;
  expect(afterZero.capture.values.find((value) => value.fieldId === fields.editable_heading).textValue).toBe('0');
  let fail = true; let failOther = false;
  await page.route(`**${api}/values`, async (route) => {
    if (route.request().postDataJSON().values.some((value) => fail && value.fieldId === fields.editable_heading
      || failOther && value.fieldId === fixture.template.records.fields[2].id)) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'synthetic_interruption', message: 'Synthetic text save interruption' } }) });
    } else await route.continue();
  });
  await edit().click(); await input().fill(' Failed title '); await input().press('Enter');
  await expect(alert).toContainText('Synthetic text save interruption');
  await expect(columns.first()).toHaveText('Failed title');
  await edit().click(); await input().fill('Discard only this new draft'); await input().press('Escape');
  await expect(columns.first()).toHaveText('Failed title');
  const pending = await runtime(); expect(pending.capture.revision).toBe(afterZero.capture.revision);
  fail = false; await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect.poll(async () => (await runtime()).capture.values.find((value) => value.fieldId === fields.editable_heading && value.occurrenceId === firstOccurrence)?.textValue).toBe('Failed title');
  failOther = true;
  await page.getByRole('spinbutton', { name: 'raw_1', exact: true }).fill('7');
  await edit().click(); await input().fill('Discard while another save failed');
  await expect(alert).toContainText('Synthetic text save interruption');
  await input().press('Escape'); await expect(columns.first()).toHaveText('Failed title');
  failOther = false; await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect.poll(async () => (await runtime()).capture.values.find((value) => value.fieldId === fixture.template.records.fields[2].id)?.numberValue).toBe('7');
  await edit(1).click(); await input().fill('  Second occurrence  ');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(`/samples/${sample.id}/test_requests/${requestId}`);
  const saved = await runtime(); const titles = saved.capture.values.filter((value) => value.fieldId === fields.editable_heading);
  expect(titles.map((value) => value.textValue).sort()).toEqual(['Failed title', 'Second occurrence']);
  expect(saved.model.fieldsById[fields.editable_heading].label).toBe('Original heading');
  await page.goto(path); await expect(columns).toHaveText(['Failed title', 'Second occurrence']);
  await page.setViewportSize({ width: 390, height: 844 }); await edit(1).click();
  await page.screenshot({ path: testInfo.outputPath('editable-text-mobile.png'), fullPage: true, animations: 'disabled' });
  await input().press('Escape');
  const csrf = (await context.cookies()).find((cookie) => cookie.name === 'sampleify_csrf')?.value;
  const denied = await page.request.patch(`${api}/values`, { headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf },
    data: { revision: saved.capture.revision, values: [{ fieldId: fields.fixed_heading, occurrenceId: firstOccurrence, state: 'present', value: 'Forged readonly title' }] } });
  expect(denied.status()).toBe(403); expect((await denied.json()).error.code).toBe('readonly_field');
  await page.goto(`${path}?revision=${originalRevision}`);
  await expect(columns).toHaveText(['Original heading', 'Original heading']);
  await expect(page.getByRole('button', { name: 'Edit editable_heading', exact: true })).toHaveCount(0);
  expect((await runtime()).capture.revision).toBe(saved.capture.revision);
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['samples.read'] });
  const readerContext = await context.browser().newContext();
  try {
    const response = await readerContext.request.post('http://127.0.0.1:3100/api/auth/login', { headers: { Origin: 'http://127.0.0.1:3100' }, data: { identifier: reader.username, password: reader.password } });
    expect(response.ok()).toBe(true);
    const readerPage = await readerContext.newPage(); await readerPage.goto(`http://127.0.0.1:3100${path}`);
    await expect(readerPage.locator(`[data-field-id="${fields.editable_heading}"]`)).toHaveText(['Failed title', 'Second occurrence']);
    await expect(readerPage.getByRole('button', { name: 'Edit editable_heading', exact: true })).toHaveCount(0);
  } finally { await readerContext.close(); }
  expect(errors).toEqual([]);
});
