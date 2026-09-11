import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';

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
  await expect(page.getByRole('heading', { name: 'Synthetic Analyst', exact: true })).toBeVisible();
}

test('desktop login, profile persistence, password change and logout work without browser exceptions', async ({ page, context }, testInfo) => {
  const account = await createAccount(owner);
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sampleify LIMS', exact: true })).toBeVisible();
  await expect(page.locator('.auth-layout__aside')).toHaveCSS('width', '420px');
  await page.screenshot({ path: testInfo.outputPath('login-desktop.png') });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.auth-layout__error[role="alert"]')).toHaveText('Username and password are required.');
  await signIn(page, account);
  await page.screenshot({ path: testInfo.outputPath('profile-desktop.png') });
  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === 'sampleify_session')).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  await page.locator('#me-profile-name').fill('Updated Synthetic Analyst');
  await page.getByRole('button', { name: 'Update Profile' }).click();
  await expect(page.getByRole('heading', { name: 'Updated Synthetic Analyst', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('#me-profile-name')).toHaveValue('Updated Synthetic Analyst');
  await page.locator('#me-old-password').fill(account.password);
  await page.locator('#me-new-password').fill('Browser-Changed-Password!');
  await page.locator('#me-confirm-password').fill('Browser-Changed-Password!');
  await page.getByRole('button', { name: 'Change Password' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Password changed successfully.' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/me');
  await expect(page).toHaveURL(/\/login$/);
  expect(browserErrors).toEqual([]);
});

test('mobile source layout, navigation toggle and session change across tabs', async ({ page, context }, testInfo) => {
  const account = await createAccount(owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await expect(page.locator('.auth-layout__aside')).toBeHidden();
  await page.getByRole('checkbox', { name: 'Remember me' }).check();
  await expect(page.getByRole('checkbox', { name: 'Remember me' })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('login-mobile.png') });
  await signIn(page, account);
  const other = await context.newPage();
  await other.goto('/me');
  await page.bringToFront();
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  await expect(page.locator('.sidebar-shell-mobile')).toHaveClass(/is-open/);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await other.bringToFront();
  await expect(other).toHaveURL(/\/login$/);
});

test('HTTP boundaries reject cross-origin, malformed and CSRF-free mutations', async ({ request }) => {
  const account = await createAccount(owner);
  const credentials = { identifier: account.username, password: account.password };
  expect((await request.post('/api/auth/login', { headers: { Origin: 'https://untrusted.invalid' }, data: credentials })).status()).toBe(403);
  expect((await request.post('/api/auth/login', { headers: { Origin: origin, 'Content-Type': 'text/plain' }, data: 'bad' })).status()).toBe(415);
  expect((await request.post('/api/auth/login', { headers: { Origin: origin, 'Content-Type': 'application/json' }, data: '{broken' })).status()).toBe(400);
  expect((await request.post('/api/auth/login', { headers: { Origin: origin }, data: { ...credentials, extra: 'x'.repeat(17_000) } })).status()).toBe(413);
  expect((await request.post('/api/auth/login', { headers: { Origin: origin }, data: credentials })).status()).toBe(200);
  const session = await request.get('/api/auth/session');
  expect(session.headers()['cache-control']).toBe('no-store');
  expect((await session.json()).identity.userId).toBe(account.userId);
  expect((await request.patch('/api/profile', { headers: { Origin: origin }, data: { displayName: 'Unauthorized', username: account.username, revision: 1 } })).status()).toBe(403);
  expect((await request.post('/api/auth/logout', { headers: { Origin: origin }, data: {} })).status()).toBe(403);
});

test('password recovery UI consumes a real locally captured single-use link', async ({ page }) => {
  const account = await createAccount(owner);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByLabel('Email address')).toBeFocused();
  await page.getByLabel('Email address').fill(account.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('Check your inbox for a reset link.')).toBeVisible();
  const result = await owner.query('SELECT id FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [account.userId]);
  const mail = await readFile(`.local/mail/${result.rows[0].id}.txt`, 'utf8');
  const link = mail.match(/http:\/\/[^\s]+/)[0];
  await page.goto(link);
  await page.getByLabel('New Password', { exact: true }).fill('Recovered-Browser-Password!');
  await page.getByLabel('New Password Confirmation').fill('Recovered-Browser-Password!');
  await page.getByRole('button', { name: 'Change Password' }).click();
  await expect(page.getByText('Password changed successfully.')).toBeVisible();
  await signIn(page, { ...account, password: 'Recovered-Browser-Password!' });
});
