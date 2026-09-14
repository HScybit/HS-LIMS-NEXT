import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { updateUserProfile } from '../../src/users/profiles.js';
import { saveUserCustomFields } from '../../src/users/custom-fields.js';

test.use({ timezoneId: 'America/New_York' });
let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function fixture(page) {
  const author = await createAccount(owner, { permissions: ['masters.manage'] });
  const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage', 'users.read'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] });
  const authorSession = await signIn({ identifier: author.username, password: author.password }); const session = await signIn({ identifier: manager.username, password: manager.password });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Control laboratory')", [author.organizationId, lab]);
  await owner.query("UPDATE roles SET name='Control role' WHERE organization_id=$1 AND id=$2", [author.organizationId, person.roleId]);
  await withSession(session.token, (client, identity) => updateUserProfile(client, identity, person.userId, { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab }));
  const change = action => withSession(authorSession.token, action);
  const define = (key, fieldType = 'text', extra = {}) => change((client, identity) => saveCustomField(client, identity,
    { id: randomUUID(), requestId: randomUUID(), revision: 0, key, label: key, fieldType, associatedWith: 'users', ...extra }));
  await login(page, manager);
  return { author, manager, person, lab, session, change, define };
}
const record = async (page, id) => (await page.request.get(`/api/users/${id}/form`)).json();
const focus = page => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const edit = async (page, f) => { await page.goto(`/user_management/${f.person.userId}/edit`); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled(); };
const select = async (page, label, value) => { await page.getByLabel(label, { exact: true }).fill(value); await page.getByRole('listbox').getByRole('option', { name: value, exact: true }).click(); };

test('manual user controls capture all supported types with user-only authority and current selected names', async ({ page }, info) => {
  const f = await fixture(page); const choices = [{ id: randomUUID(), key: 'A', label: 'Alpha' }, { id: randomUUID(), key: '0', label: 'Zero' }, { id: randomUUID(), key: 'false', label: 'False' }];
  const definitions = [];
  for (const [fieldType, label, extra] of [
    ['text', 'Custom Text', { isRequired: true }], ['number', 'Custom Number'], ['date', 'Custom Date'], ['select', 'Custom Choice', { options: choices }],
    ['select', 'Custom Choices', { options: choices, allowsMultiple: true }], ['lookup', 'Custom Lookup'], ['longtext', 'Custom Notes'],
    ['attachment', 'Custom Attachment'], ['multi_user_select', 'Custom Users'], ['date_time', 'Custom Date Time'], ['checkbox', 'Custom Checkbox'],
    ['email', 'Custom Email'], ['number', 'Repeated Number', { allowsMultiple: true }],
  ]) definitions.push(await f.define(`field_${definitions.length}`, fieldType, { label, displayOrder: definitions.length, ...extra }));
  const selected = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [selected.userId, 'Élodie_Straße/Åsa']);
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, selected.userId]);
  await edit(page, f); await page.getByLabel('Custom Text', { exact: true }).fill('Literal %_ value');
  await page.getByLabel('Custom Number', { exact: true }).fill('0'); await page.getByLabel('Custom Date', { exact: true }).fill('31122026'); await page.getByLabel('Custom Text', { exact: true }).focus();
  await expect(page.getByLabel('Custom Date', { exact: true })).toHaveValue('31/12/2026'); await page.getByLabel('Custom Choice', { exact: true }).selectOption('A');
  await select(page, 'Custom Choices', 'Zero'); await select(page, 'Custom Choices', 'False');
  await page.getByLabel('Custom Notes', { exact: true }).fill('Line one\nLine two');
  await page.getByLabel('Custom Users', { exact: true }).fill('elodie strase'); await page.getByRole('option', { name: 'Élodie Straße Åsa', exact: true }).click();
  await page.getByLabel('Custom Date Time', { exact: true }).fill('2026-03-08T02:30');
  await page.getByRole('checkbox', { name: 'Custom Checkbox', exact: true }).check(); await page.getByRole('checkbox', { name: 'Custom Checkbox', exact: true }).uncheck();
  await page.getByLabel('Custom Email', { exact: true }).fill('source permits this text');
  await page.getByRole('button', { name: 'Add Repeated Number item', exact: true }).click(); await page.getByRole('textbox', { name: 'Repeated Number item 1', exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Add Repeated Number item', exact: true }).click(); await page.getByRole('textbox', { name: 'Repeated Number item 2', exact: true }).fill('0');
  await page.getByLabel('Custom Attachment', { exact: true }).setInputFiles({ name: 'Original user evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('Original user bytes') });
  await expect(page.getByRole('link', { name: 'Download File', exact: true })).toBeVisible(); const fileUrl = await page.getByRole('link', { name: 'Download File', exact: true }).getAttribute('href');
  expect(fileUrl).toMatch(/^\/api\/users\/custom-fields\/attachments\//); expect((await page.request.get(fileUrl)).status()).toBe(200);
  expect((await page.request.get(fileUrl.replace('/api/users/custom-fields/', '/api/custom-fields/'))).status()).toBe(403);
  await page.screenshot({ path: info.outputPath('user-manual-custom-fields.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  const saved = await record(page, f.person.userId); const byLabel = new Map(saved.fieldCapture.customFields.map(field => [field.label, field]));
  expect(byLabel.get('Custom Number').value).toBe('0'); expect(byLabel.get('Custom Checkbox').value).toBe(false); expect(byLabel.get('Custom Choices').value).toEqual(['0', 'false']);
  expect(byLabel.get('Custom Date').value).toBe('31/12/2026'); expect(byLabel.get('Custom Date Time').displayValue).toBe('08/03/2026 03:30:00');
  expect(byLabel.get('Repeated Number').items.map(item => item.interpretationState)).toEqual(['invalid', 'valid']);
  expect(byLabel.get('Custom Users').value).toEqual([selected.userId]); expect(byLabel.get('Custom Users').items[0].userName).toBe('Élodie_Straße/Åsa');
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [selected.userId, 'Current_selected/name']);
  await edit(page, f); await expect(page.getByText('Current selected name', { exact: true })).toBeVisible();
  expect((await record(page, f.person.userId)).fieldCapture.customFields.find(field => field.fieldType === 'multi_user_select').items[0].userName).toBe('Élodie_Straße/Åsa');
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole('link', { name: 'Download File', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('user-manual-custom-fields-mobile.png'), fullPage: true, animations: 'disabled' });
});

test('new user fields retry the exact committed creation after definition changes without creating a second account', async ({ page }) => {
  const f = await fixture(page); const definition = await f.define('created_field', 'text', { label: 'Created field', isRequired: true });
  await page.goto('/user_management/new'); const username = `field-created-${randomUUID()}`;
  await page.getByLabel('Name', { exact: true }).fill('Created with fields'); await page.getByLabel('Email', { exact: true }).fill(`${username}@example.invalid`);
  await page.getByLabel('Username/Employee ID', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill('Synthetic creation password');
  await select(page, 'Default Role', 'Control role'); await select(page, 'Lab', 'Control laboratory'); await page.getByLabel('Created field', { exact: true }).fill('Atomic field');
  const requests = [];
  await page.route('**/api/users', async route => {
    if (route.request().method() !== 'POST') return route.continue(); requests.push(route.request().postDataJSON());
    if (requests.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(201); return route.abort('failed'); }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await f.define(definition.key, 'text', { id: definition.id, revision: 1, label: 'Changed later', isRequired: true }); await focus(page);
  await expect(page.getByLabel('Created field', { exact: true })).toHaveValue('Atomic field'); await expect(page.getByLabel('Created field', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(Object.hasOwn(requests[0], 'customFieldRevision')).toBe(false);
  const people = (await owner.query('SELECT id FROM users WHERE username=$1', [username])).rows; expect(people).toHaveLength(1);
  const capture = (await record(page, people[0].id)).fieldCapture; expect(capture.revision).toBe(1); expect(capture.customFields[0]).toMatchObject({ fieldRevision: 1, value: 'Atomic field' });
});

test('metadata failures retain base and additional drafts, block saving and recover through Retry', async ({ page }) => {
  const f = await fixture(page); await f.define('retained', 'text', { label: 'Retained field' }); await edit(page, f);
  await page.getByLabel('Contact Number', { exact: true }).fill('Retained base draft'); await page.getByLabel('Retained field', { exact: true }).fill('Retained additional draft');
  await page.route('**/api/users/custom-fields', route => route.fulfill({ status: 503, json: { error: { message: 'Synthetic field metadata unavailable.' } } }));
  await focus(page); await expect(page.locator('form').getByRole('alert')).toContainText('Synthetic field metadata unavailable.'); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Contact Number', { exact: true })).toHaveValue('Retained base draft');
  await page.unroute('**/api/users/custom-fields'); await page.getByRole('button', { name: 'Retry loading fields', exact: true }).click();
  await expect(page.getByLabel('Retained field', { exact: true })).toHaveValue('Retained additional draft'); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
});

test('definition refresh follows saved keys across UUID replacement and key renames without resurrecting removed drafts', async ({ page }) => {
  const f = await fixture(page); const first = await f.define('saved_key', 'text', { label: 'Original field' });
  await withSession(f.session.token, (client, identity) => saveUserCustomFields(client, identity, f.person.userId,
    { requestId: randomUUID(), revision: 0, customFields: [{ fieldId: first.id, fieldRevision: 1, value: 'Saved original' }] }));
  await edit(page, f); await page.getByLabel('Original field', { exact: true }).fill('Retained draft');
  await f.change((client, identity) => retireCustomField(client, identity, { id: first.id, revision: 1, requestId: randomUUID() }));
  const replacement = await f.define('saved_key', 'text', { label: 'Replacement field' }); await focus(page);
  await expect(page.getByLabel('Replacement field', { exact: true })).toHaveValue('Retained draft');
  await f.define('renamed_key', 'text', { id: replacement.id, revision: 1, label: 'Renamed field' }); await focus(page);
  await expect(page.getByLabel('Renamed field', { exact: true })).toHaveValue(''); await page.getByLabel('Renamed field', { exact: true }).fill('Separate draft');
  await f.define('saved_key', 'text', { id: replacement.id, revision: 2, label: 'Returned key' }); await focus(page);
  await expect(page.getByLabel('Returned key', { exact: true })).toHaveValue('Saved original');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  expect((await record(page, f.person.userId)).fieldCapture.customFields[0]).toMatchObject({ fieldId: replacement.id, fieldRevision: 3, key: 'saved_key', value: 'Saved original' });
});

test('a lost user-file upload retries its original definition after same-key replacement and keeps original bytes', async ({ page }) => {
  const f = await fixture(page); const definition = await f.define('evidence', 'attachment', { label: 'Evidence' }); await edit(page, f);
  const requests = []; let uploaded;
  await page.route('**/api/users/custom-fields/attachments', async route => {
    const headers = route.request().headers(); requests.push({ id: headers['x-upload-request-id'], field: headers['x-custom-field-id'], revision: headers['x-custom-field-revision'] });
    if (requests.length === 1) {
      const response = await route.fetch(); expect(response.status()).toBe(201); uploaded = await response.json();
      return route.fulfill({ status: 503, json: { error: { message: 'Synthetic lost upload response.' } } });
    }
    return route.continue();
  });
  await page.getByLabel('Evidence', { exact: true }).setInputFiles({ name: 'Unchanged original.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('Original file bytes') });
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toBeVisible();
  await page.route('**/api/users/custom-fields', route => route.fulfill({ status: 503, json: { error: { message: 'Metadata interrupted after upload.' } } }));
  await focus(page); await expect(page.locator('form').getByRole('alert').filter({ hasText: 'Metadata interrupted after upload.' })).toBeVisible();
  await page.unroute('**/api/users/custom-fields'); await page.getByRole('button', { name: 'Retry loading fields', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toBeVisible();
  await f.change((client, identity) => retireCustomField(client, identity, { id: definition.id, revision: 1, requestId: randomUUID() }));
  const replacement = await f.define('evidence', 'attachment', { label: 'Replacement evidence' }); await focus(page);
  await expect(page.getByLabel('Replacement evidence', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click(); await expect(page.getByRole('link', { name: 'Download File', exact: true })).toBeVisible();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(requests[1].revision).toBe('1');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  expect((await record(page, f.person.userId)).fieldCapture.customFields[0]).toMatchObject({ fieldId: replacement.id, fieldRevision: 1, value: uploaded.id });
  expect(await (await page.request.get(uploaded.url)).text()).toBe('Original file bytes');
});

test('a new user keeps an uncaptured file through same-key replacement and exact creation retry', async ({ page }) => {
  const f = await fixture(page); const definition = await f.define('created_evidence', 'attachment', { label: 'Created evidence' });
  await page.goto('/user_management/new'); const username = `file-created-${randomUUID()}`;
  await page.getByLabel('Name', { exact: true }).fill('Created with file'); await page.getByLabel('Email', { exact: true }).fill(`${username}@example.invalid`);
  await page.getByLabel('Username/Employee ID', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill('Synthetic file creation password');
  await select(page, 'Default Role', 'Control role'); await select(page, 'Lab', 'Control laboratory');
  await page.getByLabel('Created evidence', { exact: true }).setInputFiles({ name: 'Original zero-byte.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
  await expect(page.getByRole('link', { name: 'Download File', exact: true })).toBeVisible();
  const fileUrl = await page.getByRole('link', { name: 'Download File', exact: true }).getAttribute('href');
  await f.change((client, identity) => retireCustomField(client, identity, { id: definition.id, revision: 1, requestId: randomUUID() }));
  const replacement = await f.define('created_evidence', 'attachment', { label: 'Replacement created evidence' }); await focus(page);
  await expect(page.getByLabel('Replacement created evidence', { exact: true })).toBeAttached();
  await expect(page.getByRole('link', { name: 'Download File', exact: true })).toHaveAttribute('href', fileUrl);
  const requests = [];
  await page.route('**/api/users', async route => {
    if (route.request().method() !== 'POST') return route.continue(); requests.push(route.request().postDataJSON());
    if (requests.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(201); return route.abort('failed'); }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await f.define('later_key', 'attachment', { id: replacement.id, revision: 1, label: 'Later field' }); await focus(page);
  await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  const people = (await owner.query('SELECT id FROM users WHERE username=$1', [username])).rows; expect(people).toHaveLength(1);
  const capture = (await record(page, people[0].id)).fieldCapture; expect(capture.revision).toBe(1);
  expect(capture.customFields[0]).toMatchObject({ fieldId: replacement.id, fieldRevision: 1, key: 'created_evidence' });
  expect(capture.customFields[0].items[0].attachment).toMatchObject({ originalName: 'Original zero-byte.txt', url: fileUrl });
  const response = await page.request.get(fileUrl); expect(response.status()).toBe(200); expect((await response.body()).length).toBe(0);
});

test('zero active fields omit capture writes and permission refresh retains additional drafts', async ({ page }) => {
  const f = await fixture(page); const definition = await f.define('retired', 'text', { label: 'Retired field' });
  await withSession(f.session.token, (client, identity) => saveUserCustomFields(client, identity, f.person.userId,
    { requestId: randomUUID(), revision: 0, customFields: [{ fieldId: definition.id, fieldRevision: 1, value: 'Historical value' }] }));
  await f.change((client, identity) => retireCustomField(client, identity, { id: definition.id, revision: 1, requestId: randomUUID() }));
  await edit(page, f); await expect(page.getByText('Additional Data Fields', { exact: true })).toHaveCount(0); await page.getByLabel('Contact Number', { exact: true }).fill('Changed independently');
  const pending = page.waitForRequest(request => request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/users/${f.person.userId}`);
  await page.getByRole('button', { name: 'Update', exact: true }).click(); expect(Object.hasOwn((await pending).postDataJSON(), 'customFields')).toBe(false); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  expect((await record(page, f.person.userId)).fieldCapture.revision).toBe(1);
  await f.define('manual', 'text', { label: 'Manual draft' }); await edit(page, f); await page.getByLabel('Manual draft', { exact: true }).fill('Retained after revocation');
  await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='users.manage'", [f.manager.organizationId, f.manager.roleId]);
  await page.evaluate(() => { const channel = new BroadcastChannel('sampleify_session'); channel.postMessage('changed'); channel.close(); });
  await expect(page.getByLabel('Manual draft', { exact: true })).toBeDisabled({ timeout: 15_000 }); await expect(page.getByLabel('Manual draft', { exact: true })).toHaveValue('Retained after revocation');
  expect((await record(page, f.person.userId)).fieldCapture.revision).toBe(1);
});

test('unavailable automatic generation cannot be silently bypassed while manually supplied values remain usable', async ({ page }) => {
  const f = await fixture(page); await f.define('automatic', 'text', { label: 'Automatic code', scheme: '{{total_counter}}', generatedAt: 'on_submit' }); await edit(page, f);
  await expect(page.getByRole('button', { name: 'Generate Automatic code value from scheme', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.getByText('Enter a value while automatic generation is unavailable.', { exact: true })).toBeVisible();
  expect((await record(page, f.person.userId)).fieldCapture.revision).toBe(0);
  await page.getByLabel('Automatic code', { exact: true }).fill('Manually supplied code'); await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  expect((await record(page, f.person.userId)).fieldCapture.customFields[0].value).toBe('Manually supplied code');
});

test('a late account error rolls back additional fields and an unknown edit replays the complete original request', async ({ page }) => {
  const f = await fixture(page); const definition = await f.define('atomic', 'text', { label: 'Atomic field' }); await edit(page, f);
  await page.getByLabel('Atomic field', { exact: true }).fill('Preserved atomic draft'); await page.getByLabel('Contact Number', { exact: true }).fill('Preserved contact draft');
  await page.getByLabel('Email', { exact: true }).fill(f.manager.email); await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('A username or email is already in use.');
  const before = await record(page, f.person.userId); expect(before.fieldCapture.revision).toBe(0); expect(before.profile.phone).toBeNull();
  await expect(page.getByLabel('Atomic field', { exact: true })).toHaveValue('Preserved atomic draft'); await page.getByLabel('Email', { exact: true }).fill(f.person.email);
  const requests = [];
  await page.route(`**/api/users/${f.person.userId}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue(); requests.push(route.request().postDataJSON());
    if (requests.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); return route.abort('failed'); }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await f.define('changed_key', 'text', { id: definition.id, revision: 1, label: 'Later field' }); await focus(page);
  await expect(page.getByLabel('Atomic field', { exact: true })).toHaveValue('Preserved atomic draft'); await expect(page.getByLabel('Atomic field', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  const after = await record(page, f.person.userId); expect(after.fieldCapture.revision).toBe(1); expect(after.profile.phone).toBe('Preserved contact draft');
  expect(after.fieldCapture.customFields[0]).toMatchObject({ key: 'atomic', fieldRevision: 1, value: 'Preserved atomic draft' });
});

test('a narrow user search keeps default choices in other fields and background refresh preserves the active search', async ({ page }) => {
  const f = await fixture(page); await f.define('first_users', 'multi_user_select', { label: 'First users' }); await f.define('second_users', 'multi_user_select', { label: 'Second users' });
  const first = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] }); const second = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [first.userId, 'Alpha_choice']); await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [second.userId, 'Beta_choice']);
  await edit(page, f); await page.getByLabel('First users', { exact: true }).click();
  await expect(page.getByRole('listbox').getByRole('option', { name: 'Alpha choice', exact: true })).toBeVisible();
  await select(page, 'First users', 'Beta choice'); await page.getByLabel('Contact Number', { exact: true }).focus();
  await page.getByLabel('Second users', { exact: true }).click();
  await expect(page.getByRole('listbox').getByRole('option', { name: 'Alpha choice', exact: true })).toBeVisible();
  await page.getByLabel('Second users', { exact: true }).fill('Alpha');
  await expect(page.getByRole('listbox').getByRole('option', { name: 'Alpha choice', exact: true })).toBeVisible();
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/users/custom-fields/user-options' && new URL(response.url()).searchParams.get('search') === '');
  await focus(page); await refreshed;
  await expect(page.getByLabel('Second users', { exact: true })).toHaveValue('Alpha'); await expect(page.getByLabel('Second users', { exact: true })).toBeEnabled();
  await expect(page.getByRole('listbox').getByRole('option', { name: 'Alpha choice', exact: true })).toBeVisible();
});
