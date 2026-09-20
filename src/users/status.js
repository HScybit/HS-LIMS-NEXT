import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { userStatusInput } from './status-input.js';
import { userProfileCommandError } from './profiles.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['users.read', 'users.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view user status.');
}

const errors = {
  user_status_invalid_input: [400, 'invalid_user_status', 'The status change is invalid.'],
  user_status_request_reused: [409, 'save_request_reused', 'This request was already used for a different status change.'],
  user_status_cannot_disable_self: [409, 'cannot_disable_self', 'You cannot disable your own account.'],
  user_status_stale: [409, 'stale_user_status', 'This status changed in another session. Reload before saving.'],
  user_status_unchanged: [409, 'user_status_unchanged', 'This membership already has that status. Reload before continuing.'],
};

export async function updateUserStatus(client, identity, userId, value) {
  requirePermission(identity, 'users.manage'); const id = uuid(userId, 'User').toLowerCase(); const input = userStatusInput(value);
  try {
    const result = await client.query('SELECT users_write_status($1,$2,$3,$4) AS revision', [id, input.revision, input.requestId, input.membershipActive]);
    return { id, revision: result.rows[0].revision, membershipActive: input.membershipActive };
  } catch (error) {
    if (errors[error.constraint]) throw new HttpError(...errors[error.constraint]);
    throw userProfileCommandError(error);
  }
}

export async function loadUserStatus(client, identity, userId) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase();
  const result = await client.query(`SELECT id,status_revision AS revision,membership_active AS "membershipActive",identity_active AS "identityActive",active
    FROM user_directory WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'user_not_found', 'User was not found.');
  return result.rows[0];
}

export async function loadUserStatusHistory(client, identity, userId, value = {}) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase(); fieldsOnly(value, ['limit', 'beforeRevision']);
  const limit = value.limit === undefined ? 25 : integer(value.limit, 'History page size', 1, 100);
  const before = value.beforeRevision === undefined ? null : integer(value.beforeRevision, 'History cursor', 1, 2_147_483_647);
  await loadUserStatus(client, identity, id);
  const result = await client.query(`SELECT revision,previous_revision AS "previousRevision",active AS "membershipActive",previous_active AS "previousMembershipActive",
    username,display_name AS "displayName",saved_by AS "savedBy",saved_by_username AS "savedByUsername",saved_by_name AS "savedByName",saved_at AS "savedAt"
    FROM user_status_history WHERE organization_id=$1 AND user_id=$2 AND ($3::integer IS NULL OR revision<$3) ORDER BY revision DESC LIMIT $4`,
  [identity.organization_id, id, before, limit + 1]);
  const rows = result.rows.slice(0, limit);
  return { rows, nextBeforeRevision: result.rows.length > limit ? rows.at(-1).revision : null };
}
