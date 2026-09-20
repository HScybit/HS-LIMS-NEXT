import { test, expect } from '@playwright/test';
import { randomUUID, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { addImageWidget } from '../helpers/template-image-fixture.js';
import { animatedPng } from '../helpers/template-images.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';
import { changeRepeat } from '../../src/templates/capture.js';
import { loadCapture } from '../../src/templates/loader.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

test('runtime clone controls keep static images and titles while flushing and copying entered data', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['templates.manage', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const fixture = await createLaboratoryFixture(owner, account);
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (action) => withSession(session.token, action, { csrfToken: session.csrfToken });
  const image = { requestId: randomUUID(), originalName: 'Synthetic repeated image.png', mediaType: 'image/png', content: await animatedPng() };
  const configuredImage = await work((client, identity) => addImageWidget(client, identity, fixture.template, image, { rowId: fixture.template.records.rows[0].id }));
  const added = await work((client, identity) => editTemplate(client, identity, fixture.template.versionId, configuredImage.model.version.revision,
    { type: 'addColumn', rowId: fixture.template.records.rows[0].id }));
  const columnId = added.model.rowsById[fixture.template.records.rows[0].id].columnIds.at(-1);
  const title = await work((client, identity) => editTemplate(client, identity, fixture.template.versionId, added.model.version.revision,
    { type: 'configureField', columnId, widget: 'text_widget', alias: 'static_title', label: 'Configured title' }));
  const fieldId = title.model.columnsById[columnId].fieldId;
  await work((client) => client.query("UPDATE template_fields SET default_state='present',default_text='A different source default' WHERE organization_id=$1 AND version_id=$2 AND id=$3",
    [account.organizationId, fixture.template.versionId, fieldId]));
  const sample = await work((client, identity) => registerSample(client, identity, fixture.registration));
  const generated = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  const allocated = await work((client, identity) => allocateTestRequest(client, identity, generated.items[0].id, { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId }));
  const path = `/samples/${sample.id}/data_sheets/${allocated.datasheetId}`; const api = `/api/datasheets/${allocated.datasheetId}`;
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  await page.goto(path); await expect(page.locator('img.tiw_image')).toHaveCount(2);
  const titles = page.locator(`[data-field-id="${fieldId}"]`);
  await expect(titles).toHaveText(['Configured title', 'Configured title']);
  await page.getByRole('spinbutton', { name: 'raw_0', exact: true }).first().fill('3');
  for (const [label, count] of [['Clone row with data', 3], ['Clone row', 4]]) {
    const response = page.waitForResponse((response) => response.url().endsWith(`${api}/repeats`) && response.request().method() === 'POST');
    await page.getByRole('link', { name: label, exact: true }).first().click(); expect((await response).status()).toBe(200);
    await expect(page.locator('img.tiw_image')).toHaveCount(count); await expect(titles).toHaveText(Array(count).fill('Configured title'));
  }
  const current = await page.request.get(api).then((response) => response.json());
  for (const id of [configuredImage.fieldId, fieldId]) {
    const values = current.capture.values.filter((value) => value.fieldId === id);
    expect(values).toHaveLength(4); expect(values.every((value) => value.origin === 'default')).toBe(true);
    if (id === configuredImage.fieldId) expect(values.every((value) => value.imageId === image.requestId)).toBe(true);
  }
  expect(current.capture.values.filter((value) => value.fieldId === fixture.template.records.fields[0].id && value.numberValue === '3')).toHaveLength(2);
  await page.reload(); await expect(titles).toHaveText(Array(4).fill('Configured title')); await expect(page.locator('img.tiw_image')).toHaveCount(4);
  await page.goto(`${path}?revision=1`); await expect(titles).toHaveText(['Configured title', 'Configured title']); await expect(page.locator('img.tiw_image')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Clone row with data', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an image size rejection keeps the current datasheet usable and permits removing then restoring a row', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['templates.manage', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const fixture = await createLaboratoryFixture(owner, account);
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (action) => withSession(session.token, action, { csrfToken: session.csrfToken });
  const image = { requestId: randomUUID(), originalName: 'Synthetic boundary image.png', mediaType: 'image/png',
    content: await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer() };
  const configured = await work((client, identity) => addImageWidget(client, identity, fixture.template, image, { rowId: fixture.template.records.rows[0].id }));
  const sources = configured.model.imageSources[image.requestId]; const limit = Math.floor(32 * 1024 * 1024 / (sources.src.length + sources.printSrc.length));
  const sample = await work((client, identity) => registerSample(client, identity, fixture.registration));
  const generated = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  const allocated = await work((client, identity) => allocateTestRequest(client, identity, generated.items[0].id, { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId }));
  const sheet = (await owner.query('SELECT template_instance_id FROM datasheets WHERE id=$1', [allocated.datasheetId])).rows[0];
  let capture = await work((client, identity) => loadCapture(client, identity.organization_id, sheet.template_instance_id));
  const occurrenceId = capture.occurrences.find((row) => row.groupId).id;
  while (capture.occurrences.length - 1 < limit) capture = await work((client, identity) => changeRepeat(client, identity, sheet.template_instance_id, capture.revision, { type: 'clone', occurrenceId, withData: true }));
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  const path = `/samples/${sample.id}/data_sheets/${allocated.datasheetId}`; const api = `/api/datasheets/${allocated.datasheetId}`;
  await page.goto(path); await expect(page.locator('img.tiw_image')).toHaveCount(limit);
  const before = await page.request.get(api).then((response) => response.json());
  const perform = async (label, status) => {
    const response = page.waitForResponse((response) => response.url().endsWith(`${api}/repeats`) && response.request().method() === 'POST');
    await page.getByRole('link', { name: label, exact: true }).first().click(); expect((await response).status()).toBe(status);
  };
  for (const label of ['Clone row', 'Clone row with data']) {
    await perform(label, 422);
    await expect(page.locator('.tr-details-results-page [role="alert"]')).toContainText('The expanded template images exceed 32 MiB.');
    await expect(page.locator('img.tiw_image')).toHaveCount(limit);
    const after = await page.request.get(api).then((response) => response.json());
    expect(after.capture.revision).toBe(before.capture.revision); expect(after.capture.values).toEqual(before.capture.values); expect(after.capture.occurrences).toEqual(before.capture.occurrences);
  }
  page.once('dialog', (dialog) => dialog.accept()); await perform('Delete row', 200);
  await expect(page.locator('img.tiw_image')).toHaveCount(limit - 1);
  await perform('Clone row with data', 200); await expect(page.locator('img.tiw_image')).toHaveCount(limit);
  await page.reload(); await expect(page.locator('img.tiw_image')).toHaveCount(limit);
  await page.goto(`${path}?revision=1`); await expect(page.locator('img.tiw_image')).toHaveCount(2);
});
