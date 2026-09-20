import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { totpAt, verifiedTotpStep } from '../../src/auth/totp.js';
import { hashToken } from '../../src/auth/tokens.js';

const origin = 'http://127.0.0.1:3100';
let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await owner.end(); });

async function signIn(page, account) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByRole('checkbox', { name: 'Enable MFA', exact: true })).toBeEnabled();
}

async function enable(page) {
  await page.locator('.smplfy-me-switch').click();
  const secret = await page.locator('.smplfy-me-mfa-secret code').textContent();
  await page.getByLabel('Authenticator Code', { exact: false }).fill(totpAt(secret, Date.now()));
  await page.getByRole('button', { name: 'Submit Code', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'MFA enabled', exact: true })).toBeChecked();
}

test('source MFA panel shows a local QR/key, verifies once after lost responses, and signs in with MFA before confirmation-based disable', async ({ page }, testInfo) => {
  const account = await createAccount(owner, { permissions: [] });
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value) => { window.mfaCopied = value; } } });
  });
  let lostSetup = false; let lostEnable = false; let setupRequests = 0; let enableRequests = 0;
  await page.route('**/api/profile/mfa/setup', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    setupRequests += 1;
    if (lostSetup) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    lostSetup = true;
    await route.abort('failed');
  });
  await page.route('**/api/profile/mfa/enable', async (route) => {
    enableRequests += 1;
    const response = await route.fetch();
    if (response.status() !== 200 || lostEnable) return route.fulfill({ response });
    lostEnable = true;
    await route.abort('failed');
  });
  await signIn(page, account);
  const panel = page.getByRole('region', { name: 'Multi-Factor Authentication' });
  await page.locator('.smplfy-me-switch').click();
  await expect(page.getByRole('img', { name: 'MFA QR code', exact: true })).toBeVisible();
  const secret = await page.locator('.smplfy-me-mfa-secret code').textContent();
  expect(setupRequests).toBe(2);
  expect(await page.getByRole('img', { name: 'MFA QR code' }).evaluate((img) => img.complete && img.naturalWidth === 320 && img.src.startsWith('data:image/png;base64,'))).toBe(true);
  await page.getByRole('button', { name: 'Copy setup key' }).click();
  expect(await page.evaluate((value) => window.mfaCopied === value, secret)).toBe(true);
  for (const [name, width, height] of [['desktop', 1280, 960], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`mfa-source-${name}.png`), mask: [page.locator('.smplfy-me-qr'), page.locator('.smplfy-me-mfa-secret')] });
  }
  await page.getByLabel('Authenticator Code').fill('abc');
  await page.getByRole('button', { name: 'Submit Code' }).click();
  await expect(panel.getByRole('alert')).toHaveText('Enter the six-digit authenticator code.');
  expect(enableRequests).toBe(0);
  const badCode = ['111111', '222222', '333333', '444444'].find((code) => verifiedTotpStep(secret, code) === null);
  await page.getByLabel('Authenticator Code').fill(badCode);
  await page.getByRole('button', { name: 'Submit Code' }).click();
  await expect(panel.getByRole('alert')).toHaveText('The authenticator code is incorrect. Try the current code.');
  expect((await owner.query('SELECT attempts FROM login_limits WHERE lookup_hash=$1', [hashToken(`mfa-enable:${account.userId}`)])).rows[0].attempts).toBe(1);
  // Use the accepted previous step for enrollment, leaving the current step for sign-in.
  const phase = Date.now() % 30_000;
  if (phase > 28_000) await new Promise((resolve) => setTimeout(resolve, 30_050 - phase));
  await page.getByLabel('Authenticator Code').fill(totpAt(secret, Date.now() - 30_000));
  await page.getByRole('button', { name: 'Submit Code' }).click();
  await expect(page.getByRole('checkbox', { name: 'MFA enabled', exact: true })).toBeChecked();
  expect(enableRequests).toBe(3);
  await expect(page.locator('.smplfy-me-mfa-secret')).toHaveCount(0);
  expect((await owner.query("SELECT count(*)::int n FROM account_events WHERE user_id=$1 AND kind='mfa_enabled'", [account.userId])).rows[0].n).toBe(1);
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('You have MFA enabled, kindly enter the code.')).toBeVisible();
  await page.getByLabel('MFA Code', { exact: false }).fill(totpAt(secret, Date.now()));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByRole('checkbox', { name: 'MFA enabled', exact: true })).toBeEnabled();
  await page.locator('.smplfy-me-switch').click();
  const dialog = page.getByRole('dialog', { name: 'Disable MFA?' });
  await expect(dialog.getByText('Your next sign-in will only require your password.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'MFA enabled', exact: true })).toBeChecked();
  await page.locator('.smplfy-me-switch').click();
  let lostDisable = false;
  await page.route('**/api/profile/mfa', async (route) => {
    if (route.request().method() !== 'DELETE' || lostDisable) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    lostDisable = true;
    await route.abort('failed');
  });
  await dialog.getByRole('button', { name: 'Disable MFA', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Enable MFA', exact: true })).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Enable MFA', exact: true })).toBeEnabled();
  expect((await owner.query('SELECT encrypted_secret FROM user_mfa WHERE user_id=$1', [account.userId])).rows[0].encrypted_secret).toBeNull();
  expect((await owner.query("SELECT count(*)::int n FROM account_events WHERE user_id=$1 AND kind='mfa_disabled'", [account.userId])).rows[0].n).toBe(1);
  expect(browserErrors).toEqual([]);
});

test('a stale disable confirmation cannot disable the new factor enrolled in another tab', async ({ page, context }) => {
  const account = await createAccount(owner, { permissions: [] });
  await signIn(page, account);
  await enable(page);
  const other = await context.newPage();
  await other.goto('/me');
  await expect(other.getByRole('checkbox', { name: 'MFA enabled', exact: true })).toBeEnabled();
  await page.bringToFront();
  await page.locator('.smplfy-me-switch').click();
  await expect(page.getByRole('dialog', { name: 'Disable MFA?' })).toBeVisible();
  await other.bringToFront();
  await other.locator('.smplfy-me-switch').click();
  await other.getByRole('dialog', { name: 'Disable MFA?' }).getByRole('button', { name: 'Disable MFA', exact: true }).click();
  await expect(other.getByRole('checkbox', { name: 'Enable MFA', exact: true })).toBeEnabled();
  await enable(other);
  await page.bringToFront();
  await page.getByRole('dialog', { name: 'Disable MFA?' }).getByRole('button', { name: 'Disable MFA', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'MFA changed in another session.' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Disable MFA?' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'MFA enabled', exact: true })).toBeChecked();
  expect((await owner.query('SELECT enabled,revision FROM user_mfa WHERE user_id=$1', [account.userId])).rows[0]).toEqual({ enabled: true, revision: 3 });
  await other.close();
});

test('setup cancellation and expiry remove the visible key and permit a new setup', async ({ page }) => {
  const account = await createAccount(owner, { permissions: [] });
  await signIn(page, account);
  await page.getByRole('checkbox', { name: 'Enable MFA', exact: true }).focus();
  await page.getByRole('checkbox', { name: 'Enable MFA', exact: true }).press('Space');
  await expect(page.locator('.smplfy-me-mfa-secret')).toBeVisible();
  await page.locator('.smplfy-me-switch').click();
  await expect(page.locator('.smplfy-me-mfa-secret')).toHaveCount(0);
  await page.locator('.smplfy-me-switch').click();
  const secret = await page.locator('.smplfy-me-mfa-secret code').textContent();
  await owner.query("UPDATE user_mfa_setups p SET created_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes' FROM sessions s WHERE s.id=p.session_id AND s.user_id=$1", [account.userId]);
  await page.getByLabel('Authenticator Code').fill(totpAt(secret, Date.now()));
  await page.getByRole('button', { name: 'Submit Code' }).click();
  await expect(page.getByRole('region', { name: 'Multi-Factor Authentication' }).getByRole('alert')).toHaveText('MFA setup expired or changed. Start MFA setup again.');
  await expect(page.locator('.smplfy-me-mfa-secret')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Enable MFA', exact: true })).not.toBeChecked();
  await enable(page);
});

test('MFA HTTP endpoints require a live session, same origin and CSRF and expose only no-store status', async ({ request }) => {
  expect((await request.get('/api/profile/mfa')).status()).toBe(401);
  const account = await createAccount(owner, { permissions: [] });
  await request.post('/api/auth/login', { headers: { Origin: origin }, data: { identifier: account.username, password: account.password } });
  const response = await request.get('/api/profile/mfa');
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ enabled: false, revision: 0 });
  for (const [path, method] of [['setup', 'POST'], ['setup', 'DELETE'], ['enable', 'POST'], ['', 'DELETE']]) {
    expect((await request.fetch(`/api/profile/mfa${path ? `/${path}` : ''}`, { method, headers: { Origin: origin }, data: {} })).status()).toBe(403);
  }
  const csrf = (await request.storageState()).cookies.find((cookie) => cookie.name === 'sampleify_csrf').value;
  expect((await request.post('/api/profile/mfa/setup', { headers: { Origin: 'https://untrusted.invalid', 'X-CSRF-Token': csrf }, data: {} })).status()).toBe(403);
  const setup = await request.post('/api/profile/mfa/setup', { headers: { Origin: origin, 'X-CSRF-Token': csrf }, data: {} });
  expect(setup.status()).toBe(200); expect(setup.headers()['cache-control']).toBe('no-store');
  const input = await setup.json();
  expect((await request.post('/api/profile/mfa/enable', { headers: { Origin: origin, 'X-CSRF-Token': csrf }, data: { setupId: input.setupId, code: 'invalid' } })).status()).toBe(422);
  await request.post('/api/auth/logout', { headers: { Origin: origin, 'X-CSRF-Token': csrf }, data: {} });
  expect((await request.post('/api/profile/mfa/enable', { headers: { Origin: origin, 'X-CSRF-Token': csrf }, data: { setupId: input.setupId, code: totpAt(input.secret, Date.now()) } })).status()).toBe(401);
});

test('MFA status and setup failures can be retried without losing an unsaved profile edit', async ({ page }) => {
  const account = await createAccount(owner, { permissions: [] });
  let failStatus = true;
  let failSetup = true;
  await page.route('**/api/profile/mfa', async (route) => {
    if (route.request().method() === 'GET' && failStatus) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Could not check MFA. Try again.' } }) });
    }
    return route.continue();
  });
  await page.route('**/api/profile/mfa/setup', async (route) => {
    if (failSetup) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Could not start MFA. Try again.' } }) });
    return route.continue();
  });
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  const panel = page.getByRole('region', { name: 'Multi-Factor Authentication' });
  await expect(panel.getByRole('alert')).toContainText('Could not check MFA. Try again.');
  await page.locator('#me-profile-name').fill('Unsaved profile name');
  failStatus = false;
  await panel.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel.getByRole('checkbox')).toBeEnabled();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#me-profile-name')).toHaveValue('Unsaved profile name');
  await page.locator('.smplfy-me-switch').click();
  await expect(panel.getByRole('alert')).toHaveText('Could not start MFA. Try again.');
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  failSetup = false;
  await page.locator('.smplfy-me-switch').click();
  await expect(page.locator('.smplfy-me-mfa-secret')).toBeVisible();
  await expect(page.locator('#me-profile-name')).toHaveValue('Unsaved profile name');
});
