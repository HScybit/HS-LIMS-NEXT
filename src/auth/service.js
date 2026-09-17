import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPool, transaction } from '../db/pool.js';
import { HttpError, requireText } from './errors.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { hashToken, matchesToken, newToken, validToken } from './tokens.js';
import { decryptSecret, verifiedTotpStep } from './totp.js';

function requirePassword(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new HttpError(400, 'invalid_input', `${label} is required and must not exceed 200 characters.`);
  }
  return value;
}

const invalidLogin = () => new HttpError(401, 'invalid_credentials', 'The username, password or authenticator code is incorrect.');

export async function signIn(input) {
  const identifier = requireText(input.identifier, 'Username', 320).trim();
  const password = requirePassword(input.password, 'Password');
  const lookupHash = hashToken(`login:${identifier.toLowerCase()}`);
  const pool = getPool();
  const attempt = await pool.query('SELECT auth_reserve_attempt($1) AS allowed', [lookupHash]);
  if (!attempt.rows[0].allowed) throw new HttpError(429, 'rate_limited', 'Too many sign-in attempts. Try again in 15 minutes.');
  const candidates = await pool.query('SELECT * FROM auth_login_principals($1)', [identifier]);
  const principal = candidates.rowCount === 1 ? candidates.rows[0] : null;
  const matches = await verifyPassword(password, principal?.password_hash);
  if (!matches || !principal?.organization_id) throw invalidLogin();
  let step = -1;
  if (principal.encrypted_secret) {
    if (!input.mfaCode) throw new HttpError(401, 'mfa_required', 'You have MFA enabled, kindly enter the code.');
    step = verifiedTotpStep(decryptSecret(principal.encrypted_secret), input.mfaCode);
    if (step === null) throw invalidLogin();
  }
  const token = newToken();
  const csrfToken = newToken();
  const result = await pool.query('SELECT auth_create_session($1, $2, $3, $4, $5, $6, $7) AS expires_at', [
    principal.user_id, principal.organization_id, principal.password_hash, principal.encrypted_secret,
    step, hashToken(token), hashToken(csrfToken),
  ]);
  if (!result.rows[0].expires_at) throw invalidLogin();
  await pool.query('SELECT auth_clear_attempts($1)', [lookupHash]);
  return { token, csrfToken, expiresAt: result.rows[0].expires_at };
}

export async function publicIdentity(client, identity) {
  const masterModules = (await client.query("SELECT masters_can_read_party('customer') AS customer,masters_can_read_party('vendor') AS vendor,instruments_can_read(NULL) AS instrument")).rows[0];
  return {
    userId: identity.user_id,
    organizationId: identity.organization_id,
    username: identity.username,
    email: identity.email,
    displayName: identity.display_name,
    organizationName: identity.organization_name,
    mustChangePassword: identity.must_change_password,
    revision: identity.revision,
    mfaEnabled: identity.mfa_enabled,
    roles: identity.role_names,
    permissions: identity.permission_codes,
    masterModules,
  };
}

export async function withSession(token, work, { csrfToken, permission, readOnly = false, accountAction = false } = {}) {
  if (!validToken(token)) throw new HttpError(401, 'unauthenticated', 'Please sign in to continue.');
  return transaction(async (client, db) => {
    const result = await client.query('SELECT * FROM auth_session_context($1)', [hashToken(token)]);
    const identity = result.rows[0];
    if (!identity) throw new HttpError(401, 'unauthenticated', 'Your session has expired. Please sign in again.');
    if (csrfToken !== undefined && !matchesToken(csrfToken, identity.csrf_hash)) throw new HttpError(403, 'invalid_csrf', 'Reload the page and try again.');
    if (!accountAction && identity.must_change_password) throw new HttpError(403, 'password_change_required', 'Change your password before continuing.');
    if (permission && !identity.permission_codes.includes(permission)) throw new HttpError(403, 'forbidden', 'You do not have permission to perform this action.');
    return work(client, identity, db);
  }, { readOnly });
}

export async function updateProfile(client, input) {
  const name = requireText(input.displayName, 'Name').trim();
  const username = requireText(input.username, 'Username', 100).trim();
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new HttpError(400, 'invalid_revision', 'Reload your profile before saving.');
  try {
    const result = await client.query('SELECT auth_update_profile($1, $2, $3) AS updated', [name, username, input.revision]);
    if (!result.rows[0].updated) throw new HttpError(409, 'stale_profile', 'Your profile changed in another session. Reload and try again.');
  } catch (error) {
    if (error.code === '28000') throw new HttpError(401, 'unauthenticated', 'Your session has expired. Please sign in again.');
    if (error.code === '23505') throw new HttpError(409, 'username_taken', 'That username is already in use.');
    throw error;
  }
}

function validateNewPassword(input) {
  requirePassword(input.newPassword, 'New password');
  if (input.newPassword.length < 8) throw new HttpError(400, 'invalid_password', 'New password must be at least 8 characters.');
  if (input.newPassword !== input.confirmPassword) throw new HttpError(400, 'password_mismatch', 'New password and confirmation do not match.');
}

export async function changePassword(client, input) {
  requirePassword(input.currentPassword, 'Old password');
  validateNewPassword(input);
  if (input.currentPassword === input.newPassword) throw new HttpError(400, 'unchanged_password', 'New password cannot be same as old password.');
  const credential = await client.query('SELECT auth_own_credential() AS password_hash');
  const expected = credential.rows[0].password_hash;
  if (!await verifyPassword(input.currentPassword, expected)) throw new HttpError(400, 'invalid_password', 'Old password is incorrect.');
  const next = await hashPassword(input.newPassword);
  const result = await client.query('SELECT auth_change_password($1, $2) AS updated', [expected, next]);
  if (!result.rows[0].updated) throw new HttpError(409, 'credentials_changed', 'Your password changed in another session. Sign in again.');
}

export async function requestPasswordReset(input) {
  const email = requireText(input.email, 'Email address', 320).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
  if (process.env.MAIL_TRANSPORT !== 'local' || !['localhost', '127.0.0.1'].includes(new URL(process.env.APP_ORIGIN).hostname)) {
    throw new HttpError(503, 'mail_unavailable', 'Password recovery is temporarily unavailable. Contact your administrator.');
  }
  const pool = getPool();
  const attempt = await pool.query('SELECT auth_reserve_attempt($1) AS allowed', [hashToken(`reset:${email.toLowerCase()}`)]);
  if (!attempt.rows[0].allowed) return;
  const token = newToken();
  const result = await pool.query('SELECT * FROM auth_request_reset($1, $2)', [email, hashToken(token)]);
  if (!result.rowCount) return;
  const reset = result.rows[0];
  const directory = resolve('.local/mail');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const url = new URL('/reset-password', process.env.APP_ORIGIN);
  url.searchParams.set('token', token);
  // Explicit local adapter: no SMTP or external messages. Files are private and ignored.
  await writeFile(resolve(directory, `${reset.request_id}.txt`), `To: ${reset.recipient}\nSubject: Reset your Sampleify LIMS password\n\n${url.href}\n\nThis single-use link expires in 30 minutes.\n`, { flag: 'wx', mode: 0o600 });
}

export async function completePasswordReset(input) {
  if (!validToken(input.token)) throw new HttpError(400, 'invalid_reset', 'This reset link is invalid or expired.');
  validateNewPassword(input);
  const next = await hashPassword(input.newPassword);
  const result = await getPool().query('SELECT auth_complete_reset($1, $2) AS updated', [hashToken(input.token), next]);
  if (!result.rows[0].updated) throw new HttpError(400, 'invalid_reset', 'This reset link is invalid or expired.');
}
