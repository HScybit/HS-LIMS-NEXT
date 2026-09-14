import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { userListInput, userSortColumns } from './input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['users.read', 'users.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view users.');
  }
}

const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const fields = `person.id,person.username,person.email,person.display_name AS "displayName",person.active,
  person.membership_active AS "membershipActive",person.identity_active AS "identityActive",person.status_revision AS "statusRevision",
  person.created_at AS "createdAt",person.organization_name AS "organizationName",
  coalesce(roles.ids,ARRAY[]::uuid[]) AS "roleIds",coalesce(roles.names,ARRAY[]::text[]) AS "roleNames",
  coalesce(roles.descriptions,ARRAY[]::text[]) AS "roleDescriptions",coalesce(roles.active,ARRAY[]::boolean[]) AS "roleActive",
  activity.last_login_at AS "lastLoginAt",activity.last_logout_at AS "lastLogoutAt"`;
const details = `LEFT JOIN LATERAL (
    SELECT array_agg(role.role_id ORDER BY lower(role.name),role.role_id) AS ids,
      array_agg(role.name ORDER BY lower(role.name),role.role_id) AS names,
      array_agg(role.description ORDER BY lower(role.name),role.role_id) AS descriptions,
      array_agg(role.active ORDER BY lower(role.name),role.role_id) AS active
    FROM user_directory_roles role WHERE role.organization_id=person.organization_id AND role.user_id=person.id
  ) roles ON true
  LEFT JOIN LATERAL (
    SELECT max(event.occurred_at) FILTER (WHERE event.kind='sign_in') AS last_login_at,
      max(event.occurred_at) FILTER (WHERE event.kind='sign_out') AS last_logout_at
    FROM user_directory_activity event WHERE event.organization_id=person.organization_id AND event.user_id=person.id
  ) activity ON true`;

function userRecord(row) {
  const { roleIds, roleNames, roleDescriptions, roleActive, ...person } = row;
  return { ...person, roles: roleIds.map((id, index) => ({ id, name: roleNames[index], description: roleDescriptions[index], active: roleActive[index] })) };
}

export async function listUsers(client, identity, value = {}) {
  requireRead(identity); const input = userListInput(value);
  const args = [identity.organization_id]; const conditions = ['person.organization_id=$1'];
  if (input.status !== 'all') { args.push(input.status === 'active'); conditions.push(`person.active=$${args.length}`); }
  if (input.search) {
    args.push(literalSearch(input.search)); const parameter = `$${args.length}`;
    conditions.push(`(person.display_name ILIKE ${parameter} OR person.username ILIKE ${parameter} OR person.email ILIKE ${parameter}
      OR EXISTS (SELECT 1 FROM user_directory_roles role WHERE role.organization_id=person.organization_id AND role.user_id=person.id AND role.name ILIKE ${parameter}))`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total FROM user_directory person ${where}`, args)).rows[0].total;
  const column = userSortColumns[input.sort.key]; const order = `${['displayName', 'username', 'email'].includes(input.sort.key) ? `lower(person.${column})` : `person.${column}`} ${input.sort.dir},person.id`;
  args.push(input.pageSize, (input.page - 1) * input.pageSize);
  const result = await client.query(`SELECT ${fields} FROM (
    SELECT person.* FROM user_directory person ${where} ORDER BY ${order} LIMIT $${args.length - 1} OFFSET $${args.length}
  ) person ${details} ORDER BY ${order}`, args);
  return { rows: result.rows.map(userRecord), totalCount };
}

export async function loadUser(client, identity, userId) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase();
  const result = await client.query(`SELECT ${fields} FROM user_directory person ${details} WHERE person.organization_id=$1 AND person.id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'user_not_found', 'User was not found.');
  return userRecord(result.rows[0]);
}
