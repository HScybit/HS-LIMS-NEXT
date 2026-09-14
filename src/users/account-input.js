import { createHmac } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, text, uuid } from '../templates/input.js';

function identityText(value, label, maximum) {
  const result = text(value, label, maximum).trim();
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_user_identity_text', `${label} contains invalid text.`);
  return result;
}

export function userAccountInput(userId, value) {
  fieldsOnly(value, ['requestId', 'revision', 'username', 'email', 'displayName', 'password']);
  const id = uuid(userId, 'User').toLowerCase(); const requestId = uuid(value.requestId, 'Save request').toLowerCase();
  const revision = integer(value.revision, 'Account revision', 1, 2_147_483_646);
  const username = identityText(value.username, 'Username', 100); const email = identityText(value.email, 'Email', 320);
  const displayName = identityText(value.displayName, 'Name', 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
  const password = value.password === undefined || value.password === '' ? null : value.password;
  if (password !== null && (typeof password !== 'string' || password.length < 8 || password.length > 200 || !password.isWellFormed())
    || value.password === null) throw new HttpError(400, 'invalid_user_password', 'Password must contain 8 to 200 valid characters, or be left blank to keep it unchanged.');
  return { id, requestId, revision, username, email, displayName, password };
}

export function userAccountFingerprint(input, key = process.env.MFA_ENCRYPTION_KEY) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new HttpError(503, 'account_command_key_unavailable', 'Account editing is temporarily unavailable.');
  const commandKey = createHmac('sha256', Buffer.from(key, 'hex')).update('SampleifyLIMS/user-account/key/v1').digest();
  return createHmac('sha256', commandKey).update(JSON.stringify(input), 'utf8').digest();
}
