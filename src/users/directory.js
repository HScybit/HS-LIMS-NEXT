import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { userListInput, userSortColumns, userTextSorts } from './input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['users.read', 'users.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view users.');
  }
}

const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const fields = (activity = 'person') => `person.id,person.username,person.email,person.display_name AS "displayName",person.active,
  person.membership_active AS "membershipActive",person.identity_active AS "identityActive",person.status_revision AS "statusRevision",
  person.created_at AS "createdAt",person.organization_name AS "organizationName",
  person.identity_created_at AS "identityCreatedAt",person.default_role_id AS "defaultRoleId",person.default_role_name AS "defaultRoleName",
  person.default_role_description AS "defaultRoleDescription",person.business_unit_id AS "businessUnitId",person.business_unit_name AS "businessUnitName",
  coalesce(roles.ids,ARRAY[]::uuid[]) AS "roleIds",coalesce(roles.names,ARRAY[]::text[]) AS "roleNames",
  coalesce(roles.descriptions,ARRAY[]::text[]) AS "roleDescriptions",coalesce(roles.active,ARRAY[]::boolean[]) AS "roleActive",
  ${activity}.last_login_at AS "lastLoginAt",${activity}.last_logout_at AS "lastLogoutAt"`;
const pageColumns = ['organization_id', 'id', 'username', 'email', 'display_name', 'active', 'membership_active', 'identity_active', 'status_revision',
  'created_at', 'organization_name', 'identity_created_at', 'default_role_id', 'default_role_name', 'default_role_description', 'business_unit_id', 'business_unit_name']
  .map(name => `person.${name}`).join(',');
const details = `LEFT JOIN LATERAL (
    SELECT array_agg(role.role_id ORDER BY lower(role.name),role.role_id) AS ids,
      array_agg(role.name ORDER BY lower(role.name),role.role_id) AS names,
      array_agg(role.description ORDER BY lower(role.name),role.role_id) AS descriptions,
      array_agg(role.active ORDER BY lower(role.name),role.role_id) AS active
    FROM user_directory_roles role WHERE role.organization_id=person.organization_id AND role.user_id=person.id
  ) roles ON true`;
const activityDetails = `LEFT JOIN LATERAL (
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
  let matchingRoles = '';
  if (input.status !== 'all') { args.push(input.status === 'active'); conditions.push(`person.active=$${args.length}`); }
  if (input.search) {
    args.push(literalSearch(input.search)); const parameter = `$${args.length}`;
    // Match each scoped role once, rather than repeating its name search for every assignment.
    matchingRoles = `WITH matching_roles AS MATERIALIZED (SELECT id FROM user_profile_references
      WHERE organization_id=$1 AND kind='roles' AND name ILIKE ${parameter})`;
    conditions.push(`(person.display_name ILIKE ${parameter} OR person.username ILIKE ${parameter} OR person.email ILIKE ${parameter}
      OR person.default_role_name ILIKE ${parameter} OR person.business_unit_name ILIKE ${parameter}
      OR EXISTS (SELECT 1 FROM user_directory_roles assignment JOIN matching_roles matched ON matched.id=assignment.role_id
        WHERE assignment.organization_id=person.organization_id AND assignment.user_id=person.id))`);
  }
  const bind = (value) => { args.push(value); return `$${args.length}`; };
  for (const [key, filter] of Object.entries(input.filters)) {
    if (filter.type === 'text') conditions.push(`person.${userSortColumns[key]} ILIKE ${bind(literalSearch(filter.value))}`);
    if (filter.type === 'boolean') conditions.push(`person.membership_active=${bind(filter.value)}`);
    if (filter.type === 'relation') conditions.push(`person.default_role_id=ANY(${bind(filter.value)}::uuid[])`);
    if (filter.type === 'date') {
      const zone = bind(input.timeZone);
      if (filter.from) conditions.push(`person.identity_created_at>=(${bind(filter.from)}::date::timestamp AT TIME ZONE ${zone})`);
      if (filter.to) conditions.push(`person.identity_created_at<((${bind(filter.to)}::date+1)::timestamp AT TIME ZONE ${zone})`);
    }
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`${matchingRoles} SELECT count(*)::integer AS total FROM user_directory person ${where}`, args)).rows[0].total;
  const column = userSortColumns[input.sort.key]; const order = `${userTextSorts.includes(input.sort.key) ? `lower(person.${column})` : `person.${column}`} ${input.sort.dir} NULLS LAST,person.id`;
  args.push(input.pageSize, (input.page - 1) * input.pageSize);
  const activitySort = ['lastLoginAt', 'lastLogoutAt'].includes(input.sort.key);
  // Sort activity from one scoped aggregation. Ordinary sorts load it only for the requested page.
  const activitySummary = activitySort ? `${matchingRoles ? ', ' : 'WITH '}sorted_activity AS MATERIALIZED (
    SELECT user_id,max(occurred_at) FILTER (WHERE kind='sign_in') AS last_login_at,
      max(occurred_at) FILTER (WHERE kind='sign_out') AS last_logout_at
    FROM user_directory_activity WHERE organization_id=$1 GROUP BY user_id)` : '';
  const activityJoin = activitySort ? 'LEFT JOIN sorted_activity activity ON activity.user_id=person.id' : '';
  const innerOrder = activitySort ? `activity.${column} ${input.sort.dir} NULLS LAST,person.id` : order;
  const result = await client.query(`${matchingRoles}${activitySummary} SELECT ${fields(activitySort ? 'person' : 'activity')} FROM (
    SELECT ${pageColumns}${activitySort ? ',activity.last_login_at,activity.last_logout_at' : ''}
    FROM user_directory person ${activityJoin} ${where} ORDER BY ${innerOrder} LIMIT $${args.length - 1} OFFSET $${args.length}
  ) person ${details} ${activitySort ? '' : activityDetails} ORDER BY ${order}`, args);
  return { rows: result.rows.map(userRecord), totalCount };
}

export async function loadUser(client, identity, userId) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase();
  const result = await client.query(`SELECT ${fields()} FROM user_directory person ${details} WHERE person.organization_id=$1 AND person.id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'user_not_found', 'User was not found.');
  return userRecord(result.rows[0]);
}
