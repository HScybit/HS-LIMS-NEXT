import { HttpError } from '../auth/errors.js';
import { integer, requirePermission, uuid } from '../templates/input.js';
import { roleInput, roleRetirementInput, roleListInput } from './input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['roles.read', 'roles.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view roles.');
  }
}

const commandErrors = {
  role_session_required: [403, 'forbidden', 'Your role management access changed. Sign in again before saving.'],
  role_invalid_input: [400, 'invalid_role_input', 'The role command is invalid.'],
  role_unknown_permission: [400, 'invalid_role_permissions', 'Select supported API permissions.'],
  role_capability_key: [400, 'invalid_role_capabilities', 'Select supported role capabilities.'],
  role_version_capability_key: [400, 'invalid_role_capabilities', 'Select supported role capabilities.'],
  role_not_found: [404, 'role_not_found', 'Role was not found.'],
  role_identifier_exists: [409, 'role_exists', 'This role already exists. Reload before editing.'],
  roles_name_key: [409, 'duplicate_role_name', 'A role with this name already exists.'],
  role_request_reused: [409, 'save_request_reused', 'This request was already used for a different role change.'],
  role_save_request_key: [409, 'save_request_reused', 'This request was already used for a different role change.'],
  role_stale: [409, 'stale_role', 'The role changed in another session. Reload before saving.'],
  role_protected: [409, 'protected_role', 'This system role cannot be deleted.'],
  role_assigned: [409, 'role_assigned', 'This role is assigned to users. Remove those assignments before deleting it.'],
  role_last_administrator: [409, 'last_role_administrator', 'At least one active user must retain permission to manage roles.'],
  user_profile_last_administrator: [409, 'last_user_administrator', 'At least one active user must retain permission to manage users.'],
};

async function writeRole(client, identity, operation, input) {
  requirePermission(identity, 'roles.manage');
  try {
    const result = await client.query('SELECT roles_write($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS revision', [
      operation, input.id, input.revision, input.requestId, input.name ?? null, input.description ?? null, input.description !== undefined,
      input.defaultPath ?? null, input.defaultPath !== undefined, input.permissionCodes ?? null, input.capabilityKeys ?? null,
    ]);
    // Returning the saved revision permits a successful self-permission change without reading through revoked access.
    return { id: input.id, revision: result.rows[0].revision };
  } catch (error) {
    const mapped = commandErrors[error.constraint];
    if (mapped) throw new HttpError(...mapped);
    throw error;
  }
}

export function createRole(client, identity, value) {
  const input = roleInput(value);
  if (input.revision !== 0) throw new HttpError(400, 'invalid_role_revision', 'New roles start at revision zero.');
  return writeRole(client, identity, 'create', input);
}

export function updateRole(client, identity, value) {
  return writeRole(client, identity, 'update', roleInput(value));
}

export function retireRole(client, identity, value) {
  return writeRole(client, identity, 'retire', roleRetirementInput(value));
}

export async function loadRole(client, identity, roleId, { atRevision } = {}) {
  requireRead(identity); const id = uuid(roleId, 'Role').toLowerCase();
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const historical = atRevision !== undefined;
  const record = (await client.query(`SELECT role.${historical ? 'role_id' : 'id'} AS id,role.name,role.description,role.default_path AS "defaultPath",
    role.active,role.protected,role.revision,
    ARRAY(SELECT link.permission_code FROM ${historical ? 'role_version_permissions' : 'role_permissions'} link
      WHERE link.organization_id=role.organization_id AND link.role_id=role.${historical ? 'role_id' : 'id'}
        ${historical ? 'AND link.revision=role.revision' : ''} ORDER BY link.permission_code) AS "permissionCodes",
    ARRAY(SELECT link.capability_key FROM ${historical ? 'role_version_capabilities' : 'role_capabilities'} link
      WHERE link.organization_id=role.organization_id AND link.role_id=role.${historical ? 'role_id' : 'id'}
        ${historical ? 'AND link.revision=role.revision' : ''} ORDER BY link.capability_key) AS "capabilityKeys"
    ${historical ? ',role.saved_by AS "savedBy",role.saved_at AS "savedAt",role.previous_revision AS "previousRevision",role.operation' : ''}
    FROM ${historical ? 'role_versions' : 'roles'} role WHERE role.organization_id=$1 AND role.${historical ? 'role_id' : 'id'}=$2
      ${historical ? 'AND role.revision=$3' : 'AND role.active'}`, historical ? [identity.organization_id, id, atRevision] : [identity.organization_id, id])).rows[0];
  if (!record) throw new HttpError(404, 'role_not_found', 'Role was not found.');
  return record;
}

export async function loadRoleSettings(client, identity) {
  requireRead(identity);
  const result = await client.query('SELECT self_allocation_enabled AS "selfAllocationEnabled" FROM role_management_settings WHERE organization_id=$1', [identity.organization_id]);
  if (!result.rowCount) throw new HttpError(403, 'forbidden', 'You cannot view role settings.');
  return result.rows[0];
}

const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

export async function listRoles(client, identity, value = {}) {
  requireRead(identity); const input = roleListInput(value);
  const args = [identity.organization_id]; const conditions = ['role.organization_id=$1', 'role.active'];
  if (input.search) {
    args.push(literalSearch(input.search));
    conditions.push(`(role.name ILIKE $${args.length} OR role.description ILIKE $${args.length} OR EXISTS
      (SELECT 1 FROM role_capabilities capability WHERE capability.organization_id=role.organization_id AND capability.role_id=role.id AND capability.capability_key ILIKE $${args.length}))`);
  }
  if (input.nameFilter) { args.push(literalSearch(input.nameFilter).replace(/\s+/g, '%')); conditions.push(`role.name ILIKE $${args.length}`); }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total FROM roles role ${where}`, args)).rows[0].total;
  const order = input.sort ? `role.name ${input.sort.dir}` : 'role.protected DESC,lower(role.name)';
  args.push(input.pageSize, (input.page - 1) * input.pageSize);
  const rows = (await client.query(`SELECT selected.id AS _id,selected.name,selected.revision,selected.protected,
    ARRAY(SELECT capability.capability_key FROM role_capabilities capability WHERE capability.organization_id=selected.organization_id AND capability.role_id=selected.id ORDER BY capability.capability_key) AS "capabilityKeys"
    FROM (SELECT role.* FROM roles role ${where} ORDER BY ${order},role.id LIMIT $${args.length - 1} OFFSET $${args.length}) selected
    ORDER BY ${input.sort ? `selected.name ${input.sort.dir}` : 'selected.protected DESC,lower(selected.name)'},selected.id`, args)).rows;
  return { rows, totalCount };
}
