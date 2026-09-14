import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, text, uuid } from '../templates/input.js';
import { userProfileInput } from './profile-input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['users.read', 'users.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view user profiles.');
}

const errors = {
  user_profile_session_required: [403, 'forbidden', 'An active user management session is required.'],
  user_profile_invalid_input: [400, 'invalid_user_profile', 'The profile change is invalid.'],
  user_profile_not_found: [404, 'user_not_found', 'User was not found.'],
  user_profile_stale: [409, 'stale_user_profile', 'This profile changed in another session. Reload before saving.'],
  user_profile_request_reused: [409, 'save_request_reused', 'This request was already used for a different profile change.'],
  user_profile_initial_references: [422, 'user_profile_references_required', 'Choose a default role and laboratory for this profile.'],
  user_profile_unit_unavailable: [422, 'invalid_business_unit', 'Business unit is unavailable.'],
  user_profile_lab_unavailable: [422, 'invalid_laboratory', 'Laboratory is unavailable.'],
  user_profile_manager_unavailable: [422, 'invalid_reporting_manager', 'Reporting manager is unavailable.'],
  user_profile_own_manager: [422, 'user_own_manager', 'A user cannot report to themselves.'],
  user_profile_role_unavailable: [422, 'invalid_user_roles', 'Select active roles in this organization.'],
  user_profile_last_administrator: [409, 'last_user_administrator', 'At least one active user must retain each existing administration permission.'],
};

export async function updateUserProfile(client, identity, userId, value) {
  requirePermission(identity, 'users.manage'); const id = uuid(userId, 'User').toLowerCase(); const input = userProfileInput(value);
  const args = [id, input.revision, input.requestId];
  for (const field of ['employeeCode', 'phone', 'designation', 'canManagePeople', 'businessUnitId', 'defaultRoleId', 'laboratoryId', 'reportingManagerId']) {
    args.push(input[field] ?? null, Object.hasOwn(input, field));
  }
  args.push(input.roleIds ?? null);
  try {
    const result = await client.query(`SELECT users_write_profile(${args.map((_, index) => `$${index + 1}`).join(',')}) AS revision`, args);
    return { id, revision: result.rows[0].revision };
  } catch (error) {
    if (errors[error.constraint]) throw new HttpError(...errors[error.constraint]);
    throw error;
  }
}

const profileFields = `version.revision,version.previous_revision AS "previousRevision",version.employee_code AS "employeeCode",version.phone,version.designation,
  version.can_manage_people AS "canManagePeople",version.business_unit_id AS "businessUnitId",version.business_unit_code AS "businessUnitCode",version.business_unit_name AS "businessUnitName",
  version.default_role_id AS "defaultRoleId",version.laboratory_id AS "laboratoryId",version.laboratory_code AS "laboratoryCode",version.laboratory_name AS "laboratoryName",
  version.reporting_manager_id AS "reportingManagerId",version.reporting_manager_username AS "reportingManagerUsername",version.reporting_manager_name AS "reportingManagerName",
  version.saved_by AS "savedBy",version.saved_by_username AS "savedByUsername",version.saved_by_name AS "savedByName",version.saved_at AS "savedAt"`;

export async function loadUserProfile(client, identity, userId, { atRevision } = {}) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase();
  if (atRevision !== undefined) integer(atRevision, 'Profile revision', 1, 2_147_483_647);
  const result = await client.query(`SELECT person.id,${profileFields},observed.ids AS "roleIds",observed.names AS "roleNames",
    observed.descriptions AS "roleDescriptions",observed.active AS "roleActive",observed.revisions AS "roleRevisions"
    FROM user_directory person LEFT JOIN user_profile_heads head ON head.organization_id=person.organization_id AND head.user_id=person.id
    LEFT JOIN user_profile_history version ON version.organization_id=person.organization_id AND version.user_id=person.id AND version.revision=${atRevision === undefined ? 'head.revision' : '$3'}
    LEFT JOIN LATERAL (SELECT array_agg(role_id ORDER BY role_id) AS ids,array_agg(name ORDER BY role_id) AS names,
      array_agg(description ORDER BY role_id) AS descriptions,array_agg(active ORDER BY role_id) AS active,array_agg(recorded_role_revision ORDER BY role_id) AS revisions
      FROM user_profile_role_history WHERE organization_id=version.organization_id AND user_id=version.user_id AND revision=version.revision) observed ON true
    WHERE person.organization_id=$1 AND person.id=$2`, atRevision === undefined ? [identity.organization_id, id] : [identity.organization_id, id, atRevision]);
  if (!result.rowCount) throw new HttpError(404, 'user_not_found', 'User was not found.');
  const row = result.rows[0];
  if (row.revision === null) {
    if (atRevision !== undefined) throw new HttpError(404, 'user_profile_revision_not_found', 'Profile revision was not found.');
    return { id, revision: 0, profile: null };
  }
  const { roleIds, roleNames, roleDescriptions, roleActive, roleRevisions, ...profile } = row;
  return { ...profile, roles: roleIds.map((roleId, index) => ({ id: roleId, name: roleNames[index], description: roleDescriptions[index], active: roleActive[index], recordedRevision: roleRevisions[index] })) };
}

export async function listUserProfileHistory(client, identity, userId, value = {}) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase(); fieldsOnly(value, ['beforeRevision', 'pageSize']);
  const pageSize = integer(value.pageSize ?? 25, 'Page size', 1, 100);
  const before = value.beforeRevision === undefined ? null : integer(value.beforeRevision, 'Before revision', 1, 2_147_483_647);
  const found = await client.query('SELECT id FROM user_directory WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
  if (!found.rowCount) throw new HttpError(404, 'user_not_found', 'User was not found.');
  const result = await client.query(`SELECT revision,previous_revision AS "previousRevision",saved_by AS "savedBy",saved_by_name AS "savedByName",saved_at AS "savedAt"
    FROM user_profile_history WHERE organization_id=$1 AND user_id=$2 AND ($3::integer IS NULL OR revision<$3)
    ORDER BY revision DESC LIMIT $4`, [identity.organization_id, id, before, pageSize + 1]);
  const rows = result.rows.slice(0, pageSize); const hasMore = result.rows.length > pageSize;
  return { rows, hasMore, nextBeforeRevision: hasMore ? rows.at(-1).revision : null };
}

export function userProfileReferenceInput(value) {
  fieldsOnly(value, ['kind', 'search', 'pageSize', 'selectedIds', 'excludeUserId']);
  if (!['roles', 'businessUnits', 'laboratories', 'managers'].includes(value.kind)) throw new HttpError(400, 'invalid_user_reference_kind', 'Select a user reference type.');
  const search = text(value.search, 'Search', 200, { optional: true }).trim();
  if (!search.isWellFormed() || search.includes('\0')) throw new HttpError(400, 'invalid_user_reference_search', 'Search contains invalid text.');
  const result = { kind: value.kind, search, pageSize: integer(value.pageSize ?? 50, 'Page size', 1, 100) };
  if (value.excludeUserId !== undefined) result.excludeUserId = uuid(value.excludeUserId, 'User').toLowerCase();
  if (Object.hasOwn(value, 'selectedIds')) {
    if (!Array.isArray(value.selectedIds) || value.selectedIds.length > 100) throw new HttpError(400, 'invalid_user_reference_ids', 'Include at most 100 selected references.');
    result.selectedIds = value.selectedIds.map((id) => uuid(id, 'Reference').toLowerCase());
    if (new Set(result.selectedIds).size !== result.selectedIds.length) throw new HttpError(400, 'duplicate_user_reference_ids', 'Include each reference once.');
  }
  return result;
}

export async function listUserProfileReferences(client, identity, value) {
  requireRead(identity); const input = userProfileReferenceInput(value);
  const args = [identity.organization_id, input.kind]; let where = 'organization_id=$1 AND kind=$2';
  if (input.selectedIds !== undefined) { args.push(input.selectedIds); where += ` AND id=ANY($${args.length}::uuid[])`; }
  else {
    where += ' AND active';
    if (input.search) { args.push(`%${input.search.replace(/[\\%_]/g, '\\$&')}%`); where += ` AND (name ILIKE $${args.length} OR code ILIKE $${args.length})`; }
    if (input.kind === 'managers' && input.excludeUserId) { args.push(input.excludeUserId); where += ` AND id<>$${args.length}`; }
  }
  args.push(input.selectedIds === undefined ? input.pageSize + 1 : 100);
  const result = await client.query(`SELECT id,name,description,active,code FROM user_profile_references WHERE ${where} ORDER BY lower(name),id LIMIT $${args.length}`, args);
  const hasMore = input.selectedIds === undefined && result.rows.length > input.pageSize;
  return { rows: input.selectedIds === undefined ? result.rows.slice(0, input.pageSize) : result.rows, hasMore };
}
