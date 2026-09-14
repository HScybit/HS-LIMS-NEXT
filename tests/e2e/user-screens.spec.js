import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await owner.end(); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+jD5kAAAAASUVORK5CYII=', 'base64');
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(actor.username); await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  return { origin: 'http://127.0.0.1:3100', 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value };
}
async function fixture(page) {
  const admin = await createAccount(owner, { permissions: ['users.manage', 'users.read', 'roles.manage'] });
  const person = await createAccount(owner, { organizationId: admin.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); const unit = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Screen laboratory')", [admin.organizationId, lab]);
  await owner.query("INSERT INTO business_units(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Screen unit')", [admin.organizationId, unit]);
  await owner.query("UPDATE roles SET name='Screen analyst role',description='Screen analyst description' WHERE organization_id=$1 AND id=$2", [admin.organizationId, person.roleId]);
  return { admin, person, lab, unit, headers: await login(page, admin) };
}
async function recordProfile(page, f, extra = {}, userId = f.person.userId, roleId = f.person.roleId) {
  const response = await page.request.patch(`/api/users/${userId}/profile`, { headers: f.headers,
    data: { requestId: randomUUID(), revision: 0, defaultRoleId: roleId, laboratoryId: f.lab, ...extra } });
  expect(response.status()).toBe(200);
}
const form = async (page, id) => (await page.request.get(`/api/users/${id}/form`)).json();
async function select(page, label, name) {
  await page.getByLabel(label, { exact: true }).fill(name); await page.getByRole('option', { name, exact: true }).click();
}

test('source user list, creation and dedicated detail page work; a failed new-user signature retries without creating another account', async ({ page }) => {
  const f = await fixture(page);
  // The native schema requires names. Exercise the source's defensive fallback only at the response boundary.
  await page.route('**/api/users?**', async route => {
    const response = await route.fetch(); const data = await response.json();
    data.rows.find(row => row.id === f.person.userId).displayName = '';
    await route.fulfill({ response, json: data });
  });
  await page.goto('/user_management');
  await expect(page.getByRole('heading', { name: 'User Management', exact: true })).toBeVisible();
  await expect(page.locator('.user-directory-avatar').first()).toHaveCSS('width', '34px');
  await expect(page.getByRole('link', { name: f.person.username, exact: true })).toBeVisible();
  await page.unroute('**/api/users?**');
  expect(await page.locator('thead th').allTextContents()).toEqual(['User', 'Role', 'Role Description', 'Unit', 'Created on', 'Last login', 'Last logout', 'Status', 'Actions']);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '.local/m04-user-screen-list.png', fullPage: true });
  await page.getByRole('button', { name: 'New User', exact: true }).click();
  await expect(page.getByLabel('Reporting Manager', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.getByText('Name is required.', { exact: true })).toBeVisible();
  const username = `screen-${randomUUID()}`;
  await page.getByLabel('Name', { exact: true }).fill('Browser Created User'); await page.getByLabel('Email', { exact: true }).fill(`${username}@example.invalid`);
  await page.getByLabel('Username/Employee ID', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill('New browser password');
  await page.getByLabel('Can be Manager?', { exact: true }).check(); await select(page, 'Default Role', 'Screen analyst role'); await select(page, 'Lab', 'Screen laboratory');
  await page.locator('#user-signature-file').setInputFiles({ name: 'signature.png', mimeType: 'image/png', buffer: png });
  let creations = 0; let uploads = 0; const uploadIds = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/users' && request.method() === 'POST') creations++; });
  await page.route(/\/api\/users\/[^/]+\/signature$/, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    uploads++; uploadIds.push(route.request().headers()['x-upload-request-id']);
    if (uploads === 1) return route.fulfill({ status: 503, json: { error: { code: 'synthetic_upload_interruption', message: 'Synthetic upload interruption.' } } });
    return route.continue();
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('The user was created, but the signature upload did not finish.');
  await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry signature upload', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  expect(creations).toBe(1); expect(uploads).toBe(2); expect(uploadIds[0]).toBe(uploadIds[1]);
  const saved = await owner.query('SELECT id FROM users WHERE username=$1', [username]); expect(saved.rowCount).toBe(1); const id = saved.rows[0].id;
  const data = await form(page, id); expect(data.profile.canManagePeople).toBe(true); expect(data.signature.revision).toBe(1); expect(data.signature.file.byteLength).toBe(png.length);
  await page.goto(`/user_management/${id}/view`);
  await expect(page.locator('tbody tr td:first-child')).toHaveText(['Name', 'Email', 'Contact Number', 'Username/Employee ID', 'Can be Manager?', 'Designation', 'Unit', 'Default Role', 'Lab', 'Reporting Manager', 'User Signature']);
  await expect(page.getByText('Password', { exact: true })).toHaveCount(0); await expect(page.getByRole('img', { name: 'signature.png', exact: true })).toBeVisible();
  await expect(page.locator('.user-signature-detail')).toHaveCSS('display', 'flex');
  await page.screenshot({ path: '.local/m04-user-screen-view.png', fullPage: true });
});

test('choosing an available reference clears a failed saved-selection lookup without losing other form entries', async ({ page }) => {
  const f = await fixture(page); await recordProfile(page, f); const replacement = randomUUID();
  await owner.query("INSERT INTO roles(organization_id,id,name) VALUES($1,$2,'Replacement screen role')", [f.admin.organizationId, replacement]);
  await page.route('**/api/users/profile-references?**', route => {
    const input = JSON.parse(new URL(route.request().url()).searchParams.get('query'));
    if (input.kind === 'roles' && input.selectedIds) return route.fulfill({ status: 503, json: { error: { code: 'synthetic_selection_failure', message: 'Saved role lookup failed.' } } });
    return route.continue();
  });
  await page.goto(`/user_management/${f.person.userId}/edit`);
  await expect(page.locator('form').getByRole('alert')).toContainText('Saved role lookup failed.');
  await page.getByLabel('Contact Number', { exact: true }).fill('Kept during role lookup recovery');
  await select(page, 'Default Role', 'Replacement screen role');
  await expect(page.locator('form').getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Contact Number', { exact: true })).toHaveValue('Kept during role lookup recovery');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/);
  const saved = await form(page, f.person.userId); expect(saved.profile.defaultRoleId).toBe(replacement); expect(saved.profile.phone).toBe('Kept during role lookup recovery');
});

test('source edit form preserves hidden roles and inactive references, rolls back a late alias error, and reloads a stale account explicitly', async ({ page }) => {
  const f = await fixture(page); const hidden = randomUUID();
  await owner.query("INSERT INTO roles(organization_id,id,name) VALUES($1,$2,'Hidden assigned role')", [f.admin.organizationId, hidden]);
  await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) VALUES($1,$2,$3)', [f.admin.organizationId, f.person.userId, hidden]);
  await recordProfile(page, f, { businessUnitId: f.unit, employeeCode: 'Preserve this hidden code', phone: 'Original phone' });
  await owner.query('UPDATE roles SET active=false WHERE organization_id=$1 AND id=$2', [f.admin.organizationId, f.person.roleId]);
  await owner.query('UPDATE laboratories SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [f.admin.organizationId, f.lab]);
  await owner.query('UPDATE business_units SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [f.admin.organizationId, f.unit]);
  await page.goto(`/user_management/${f.person.userId}/edit`);
  await expect(page.getByText('Screen laboratory (inactive)', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Reporting Manager', { exact: true })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(f.admin.email); await page.getByLabel('Contact Number', { exact: true }).fill('Changed phone');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('form').getByRole('alert')).toContainText('A username or email is already in use.');
  expect((await form(page, f.person.userId)).profile.phone).toBe('Original phone'); await expect(page.getByLabel('Contact Number', { exact: true })).toHaveValue('Changed phone');
  await page.getByLabel('Email', { exact: true }).fill(f.person.email);
  const outgoing = page.waitForRequest(request => request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/users/${f.person.userId}`);
  await page.getByRole('button', { name: 'Update', exact: true }).click(); const body = (await outgoing).postDataJSON();
  for (const key of ['employeeCode', 'roleIds', 'defaultRoleId', 'laboratoryId', 'businessUnitId']) expect(Object.hasOwn(body, key)).toBe(false);
  await expect(page).toHaveURL(/\/user_management(?:\?|$)/); const saved = await form(page, f.person.userId);
  expect(saved.profile.phone).toBe('Changed phone'); expect(saved.profile.employeeCode).toBe('Preserve this hidden code'); expect(saved.profile.roles.map(role => role.id).sort()).toEqual([f.person.roleId, hidden].sort());
  await page.goto(`/user_management/${f.person.userId}/edit`); await page.getByLabel('Name', { exact: true }).fill('Unsaved stale name');
  const changed = await page.request.patch(`/api/users/${f.person.userId}/account`, { headers: f.headers,
    data: { requestId: randomUUID(), revision: saved.account.revision, username: saved.account.username, email: saved.account.email, displayName: 'Other session name' } }); expect(changed.status()).toBe(200);
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('form').getByRole('alert')).toContainText('This account changed in another session.');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved stale name'); await page.getByRole('button', { name: 'Reload saved user', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Other session name');
});

test('an unknown form response retains and retries the exact committed request without a second profile or identity event', async ({ page }) => {
  const f = await fixture(page); await recordProfile(page, f); await page.goto(`/user_management/${f.person.userId}/edit`);
  await page.getByLabel('Name', { exact: true }).fill('Recovered browser save'); await page.getByLabel('Contact Number', { exact: true }).fill('Recovered phone');
  let saves = 0; const requests = [];
  await page.route(`**/api/users/${f.person.userId}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue(); saves++; requests.push(route.request().postDataJSON());
    if (saves === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); return route.abort('failed'); }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page.locator('form').getByRole('alert')).toContainText('Retry the same save to confirm its result.');
  await expect(page.getByLabel('Name', { exact: true })).toBeDisabled(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Recovered browser save');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await expect(page).toHaveURL(/\/user_management(?:\?|$)/); expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  const saved = await form(page, f.person.userId); expect(saved.account.revision).toBe(2); expect(saved.profile.revision).toBe(2); expect(saved.profile.phone).toBe('Recovered phone');
});

test('source status controls enforce self protection, show actual deactivation and offer read-only dedicated views', async ({ page }) => {
  const f = await fixture(page); await page.goto('/user_management');
  const own = page.getByRole('row').filter({ has: page.getByText(`Username: ${f.admin.username}`, { exact: true }) });
  const target = page.getByRole('row').filter({ has: page.getByText(`Username: ${f.person.username}`, { exact: true }) });
  await expect(own.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
  const statusCommands = [];
  await page.route(`**/api/users/${f.person.userId}/status`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue(); statusCommands.push(route.request().postDataJSON());
    if (statusCommands.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); return route.abort('failed'); }
    return route.continue();
  });
  await target.getByRole('button', { name: 'Active', exact: true }).click(); await expect(target.getByRole('button', { name: 'Retry status change', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(target.getByRole('button', { name: 'Inactive', exact: true })).toBeVisible();
  await target.getByRole('button', { name: 'Retry status change', exact: true }).click();
  await expect(target.getByRole('button', { name: 'Inactive', exact: true })).toBeEnabled(); expect(statusCommands).toHaveLength(2); expect(statusCommands[1]).toEqual(statusCommands[0]);
  expect((await form(page, f.person.userId)).user.membershipActive).toBe(false);
  await target.getByRole('button', { name: 'Inactive', exact: true }).click(); await expect(target.getByRole('button', { name: 'Active', exact: true })).toBeVisible();
  await login(page, f.person); await page.goto('/user_management'); await expect(page.getByRole('button', { name: 'New User', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0); expect(await page.locator('.user-status-toggle:not(:disabled)').count()).toBe(0);
  await page.getByRole('link', { name: 'View', exact: true }).first().click(); await expect(page).toHaveURL(/\/user_management\/[^/]+\/view/); await expect(page.locator('tbody tr').first()).toContainText('Name');
});

test('immediate signature controls preserve empty and arbitrary originals, sandbox SVG viewing, and retain immutable replaced files', async ({ page }) => {
  const f = await fixture(page); await recordProfile(page, f); await page.goto(`/user_management/${f.person.userId}/edit`);
  await page.getByLabel('Contact Number', { exact: true }).fill('Still unsaved');
  await page.locator('#user-signature-file').setInputFiles({ name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) });
  await expect(page.getByRole('status')).toContainText('Signature saved.'); let saved = await form(page, f.person.userId); const emptyId = saved.signature.file.id;
  expect(saved.signature.file.byteLength).toBe(0); expect(saved.profile.phone).toBeNull(); await expect(page.getByLabel('Contact Number', { exact: true })).toHaveValue('Still unsaved');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="20" onload="window.signatureExecuted=true"><script>window.signatureExecuted=true;fetch("/api/users?signatureProbe=1")</script><path d="M0 10L50 10" stroke="black"/></svg>');
  await page.locator('#user-signature-file').setInputFiles({ name: 'signature.svg', mimeType: 'image/svg+xml', buffer: svg });
  await expect(page.getByRole('img', { name: 'signature.svg', exact: true })).toBeVisible();
  await expect.poll(async () => (await form(page, f.person.userId)).signature.revision).toBe(2); saved = await form(page, f.person.userId);
  const response = await page.request.get(`${saved.signature.file.url}?view=1`); expect(response.headers()['content-disposition']).toMatch(/^inline;/); expect(response.headers()['content-security-policy']).toContain('sandbox'); expect(await response.body()).toEqual(svg);
  const old = await page.request.get(`/api/users/signature-files/${emptyId}`); expect(old.status()).toBe(200); expect((await old.body()).length).toBe(0);
  const preview = await page.context().newPage(); let probes = 0; preview.on('request', request => { if (request.url().includes('signatureProbe')) probes++; });
  await preview.goto(`${saved.signature.file.url}?view=1`); expect(await preview.evaluate(() => window.signatureExecuted)).toBeUndefined(); expect(probes).toBe(0); await preview.close();
  await page.getByRole('button', { name: 'Remove signature', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Signature removed.');
  expect((await form(page, f.person.userId)).signature.file).toBeNull(); expect((await page.request.get(saved.signature.file.url)).status()).toBe(200);
  await page.locator('#user-signature-file').setInputFiles({ name: 'too-large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
  await expect(page.locator('form').getByRole('alert')).toContainText('Signature files can be at most 20 MiB.'); expect((await form(page, f.person.userId)).signature.revision).toBe(3);
});

test('a real permission refresh disables the mounted user editor and retains its unsaved fields', async ({ page }) => {
  const f = await fixture(page); await recordProfile(page, f); await page.goto(`/user_management/${f.person.userId}/edit`);
  await page.getByLabel('Contact Number', { exact: true }).fill('Keep after revocation');
  await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='users.manage'", [f.admin.organizationId, f.admin.roleId]);
  await page.evaluate(() => { const channel = new BroadcastChannel('sampleify_session'); channel.postMessage('changed'); channel.close(); });
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled({ timeout: 15_000 });
  await expect(page.getByLabel('Contact Number', { exact: true })).toHaveValue('Keep after revocation'); await expect(page.locator('form').getByRole('alert')).toContainText('Your unsaved entries are retained.');
  expect((await form(page, f.person.userId)).profile.phone).toBeNull();
});

test('editing the administrator own password commits the form and returns to sign-in', async ({ page }) => {
  const f = await fixture(page); await recordProfile(page, f, {}, f.admin.userId, f.admin.roleId); await page.goto(`/user_management/${f.admin.userId}/edit`);
  await page.getByLabel('Contact Number', { exact: true }).fill('Own changed contact'); await page.getByLabel('Password', { exact: true }).fill('Own changed browser password');
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(/\/login$/);
  await login(page, { ...f.admin, password: 'Own changed browser password' }); expect((await form(page, f.admin.userId)).profile.phone).toBe('Own changed contact');
});

test('directory filter controls search saved labels and inactive role descriptions without sending display labels as query data', async ({ page }) => {
  const f = await fixture(page); await recordProfile(page, f, { businessUnitId: f.unit });
  await owner.query('UPDATE roles SET active=false WHERE organization_id=$1 AND id=$2', [f.admin.organizationId, f.person.roleId]);
  await page.goto('/user_management'); await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByLabel('Role Description', { exact: true }).click(); await page.getByRole('option', { name: 'Screen analyst description', exact: true }).click();
  await page.getByRole('option', { name: 'Screen analyst description', exact: true }).press('Escape');
  await page.getByPlaceholder('Filter Unit', { exact: true }).fill('Screen unit');
  const listed = page.waitForRequest(request => new URL(request.url()).pathname === '/api/users' && request.method() === 'GET' && Boolean(JSON.parse(new URL(request.url()).searchParams.get('query') || '{}').filters?.defaultRoleDescription));
  await page.getByRole('button', { name: 'Apply Filters', exact: true }).click();
  const query = JSON.parse(new URL((await listed).url()).searchParams.get('query')); expect(query.filters.defaultRoleDescription).toEqual({ type: 'relation', value: [f.person.roleId] });
  await expect(page.locator('.user-directory-card')).toHaveCount(1); await expect(page.getByText(`Username: ${f.person.username}`, { exact: true })).toBeVisible();
  await page.reload(); await expect(page.locator('.user-directory-card')).toHaveCount(1); await expect(page.getByText(`Username: ${f.person.username}`, { exact: true })).toBeVisible();
});

test('the editor locks protected global identity fields while allowing the current membership profile to be saved', async ({ page }) => {
  const f = await fixture(page); await recordProfile(page, f); const foreign = await createAccount(owner, { permissions: [] });
  await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, f.person.userId]);
  await page.goto(`/user_management/${f.person.userId}/edit`);
  for (const name of ['Name', 'Email', 'Username/Employee ID', 'Password']) await expect(page.getByLabel(name, { exact: true })).toBeDisabled();
  await page.getByLabel('Contact Number', { exact: true }).fill('Current membership contact'); await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page).toHaveURL(/\/user_management(?:\?|$)/); const saved = await form(page, f.person.userId);
  expect(saved.profile.phone).toBe('Current membership contact'); expect(saved.account.email).toBe(f.person.email); expect(saved.account.username).toBe(f.person.username);
});
