import { HttpError } from '../auth/errors.js';
import { uuid, fieldsOnly, integer, text } from '../templates/input.js';
import { hashPassword } from '../auth/passwords.js';
import { createTemporaryPassword } from './organizations.js';

// The application role has no table access to users, credentials, sessions or
// account_events, so the whole directory is read and written through the two
// platform_* definer functions rather than through queries here.

async function requirePlatformAdministrator(client) {
  const result = await client.query('SELECT auth_is_platform_administrator() AS allowed');
  if (!result.rows[0].allowed) throw new HttpError(403, 'platform_administrator_required', 'Platform administrator access is required.');
}

function directoryInput(raw = {}) {
  fieldsOnly(raw, ['search', 'page', 'pageSize', 'organizationIds']);
  const search = text(raw.search ?? '', 'Search', 200, { optional: true }).trim();
  if (!search.isWellFormed() || search.includes('\0')) throw new HttpError(400, 'invalid_input', 'Search must contain valid text.');
  const requested = raw.organizationIds ?? [];
  if (!Array.isArray(requested)) throw new HttpError(400, 'invalid_input', 'Select organizations to filter by.');
  if (requested.length > 200) throw new HttpError(400, 'invalid_input', 'Filter by at most 200 organizations at a time.');
  const organizationIds = [...new Set(requested.map((value) => uuid(value, 'Organization').toLowerCase()))];
  return { search, organizationIds,
    page: integer(raw.page ?? 1, 'Page', 1, 1_000_000), pageSize: integer(raw.pageSize ?? 25, 'Page size', 1, 100) };
}

export async function listPlatformUsers(client, identity, raw = {}) {
  await requirePlatformAdministrator(client);
  const input = directoryInput(raw);
  const result = await client.query(
    `SELECT user_id AS "id", username, email, display_name AS "displayName", active,
            must_change_password AS "mustChangePassword", mfa_enabled AS "mfaEnabled",
            is_platform_administrator AS "isPlatformAdministrator",
            organization_id AS "organizationId", organization_code AS "organizationCode",
            organization_name AS "organizationName", organization_count AS "organizationCount",
            last_sign_in_at AS "lastSignInAt", total_count AS "totalCount"
     FROM platform_list_users($1,$2,$3,$4,$5,$6)`,
    [identity.organization_id, identity.user_id, input.search, input.page, input.pageSize,
      input.organizationIds.length ? input.organizationIds : null]);
  // The total is the same on every row; it rides along so the count and the
  // page come from one scan rather than two.
  return {
    items: result.rows.map(({ totalCount: _total, ...row }) => row),
    page: input.page, pageSize: input.pageSize, total: result.rows[0]?.totalCount ?? 0,
  };
}

/**
 * Puts a new password on somebody else's account.
 *
 * The password is generated here and shown to the administrator once; it is
 * never stored in readable form and cannot be retrieved again. Every session
 * the user holds is revoked, and they must choose their own password at the
 * next sign-in.
 */
export async function resetPlatformUserPassword(client, identity, userId, raw = {}) {
  await requirePlatformAdministrator(client);
  fieldsOnly(raw, ['confirmation']);
  const target = uuid(userId, 'User').toLowerCase();
  const temporaryPassword = createTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const result = await client.query(
      `SELECT username, display_name AS "displayName", organization_code AS "organizationCode",
              sessions_revoked AS "sessionsRevoked"
       FROM platform_reset_user_password($1,$2,$3,$4)`,
      [identity.organization_id, identity.user_id, target, passwordHash]);
    return { ...result.rows[0], temporaryPassword };
  } catch (error) {
    if (error.constraint === 'platform_user_not_found') throw new HttpError(404, 'user_not_found', 'User was not found.');
    if (error.constraint === 'platform_credential_not_found') throw new HttpError(409, 'credential_not_found', 'This account has no password to reset.');
    if (error.constraint === 'platform_administrator_required') throw new HttpError(403, 'platform_administrator_required', 'Platform administrator access is required.');
    throw error;
  }
}
