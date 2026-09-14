import { HttpError } from '../auth/errors.js';
import { hashPassword } from '../auth/passwords.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { userProfileCommandError } from './profiles.js';
import { userAccountInput, userAccountFingerprint } from './account-input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((code) => ['users.read', 'users.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot view user accounts.');
}
const errors = {
  user_account_invalid_input: [400, 'invalid_user_account', 'The account change is invalid.'],
  user_account_request_reused: [409, 'save_request_reused', 'This request was already used for a different account change.'],
  user_account_stale: [409, 'stale_user_account', 'This account changed in another session. Reload before saving.'],
  user_account_protected: [403, 'protected_user_identity', 'This identity is shared or has platform access. Its owner or a platform administrator must change it.'],
  user_account_identifier_taken: [409, 'sign_in_identifier_taken', 'A username or email is already in use.'],
  user_account_form_invalid: [400, 'invalid_user_form', 'The user form change is invalid.'],
  user_custom_field_unique: [409, 'duplicate_user_custom_field', 'A unique Custom Field value is already in use.'],
  users_username_key: [409, 'sign_in_identifier_taken', 'A username or email is already in use.'],
};

async function writeUserAccount(client, identity, userId, value, form) {
  requirePermission(identity, 'users.manage'); const input = userAccountInput(userId, value);
  const fingerprint = userAccountFingerprint(input); const passwordHash = input.password === null ? null : await hashPassword(input.password);
  try {
    const args = [input.id, input.revision, input.requestId, fingerprint, input.username, input.email, input.displayName, passwordHash];
    if (form) args.push(form.fingerprint, form.profileRevision, form.customFieldRevision);
    const command = form ? 'users_write_form_account' : 'users_write_account';
    const result = await client.query(`SELECT ${command}(${args.map((_, index) => `$${index + 1}`).join(',')}) AS revision`, args);
    return { id: input.id, revision: result.rows[0].revision, passwordChanged: input.password !== null };
  } catch (error) {
    if (errors[error.constraint]) throw new HttpError(...errors[error.constraint]);
    throw userProfileCommandError(error);
  }
}

export function updateUserAccount(client, identity, userId, value) { return writeUserAccount(client, identity, userId, value); }
export function updateUserFormAccount(client, identity, userId, value, form) { return writeUserAccount(client, identity, userId, value, form); }

export async function loadUserAccount(client, identity, userId) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase();
  const result = await client.query(`SELECT id,revision,username,email,display_name AS "displayName",can_edit_identity AS "canEditIdentity"
    FROM user_account_heads WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'user_not_found', 'User was not found.');
  return result.rows[0];
}

export async function loadUserAccountHistory(client, identity, userId, value = {}) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase(); fieldsOnly(value, ['limit', 'beforeRevision']);
  const limit = value.limit === undefined ? 25 : integer(value.limit, 'History page size', 1, 100);
  const before = value.beforeRevision === undefined ? null : integer(value.beforeRevision, 'History cursor', 1, 2_147_483_647);
  const member = await client.query('SELECT 1 FROM user_account_heads WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
  if (!member.rowCount) throw new HttpError(404, 'user_not_found', 'User was not found.');
  const result = await client.query(`SELECT revision,previous_revision AS "previousRevision",username,email,display_name AS "displayName",
    previous_username AS "previousUsername",previous_email AS "previousEmail",previous_display_name AS "previousDisplayName",
    password_changed AS "passwordChanged",saved_by AS "savedBy",saved_by_username AS "savedByUsername",saved_by_name AS "savedByName",saved_at AS "savedAt"
    FROM user_account_history WHERE organization_id=$1 AND user_id=$2 AND ($3::integer IS NULL OR revision<$3) ORDER BY revision DESC LIMIT $4`,
  [identity.organization_id, id, before, limit + 1]);
  const rows = result.rows.slice(0, limit); return { rows, nextBeforeRevision: result.rows.length > limit ? rows.at(-1).revision : null };
}
