import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, text } from '../templates/input.js';
import { moduleAccessDefinitions } from './module-access-input.js';
export { moduleAccessSettingsInput } from './module-access-input.js';

function requireSettingsRead(identity) {
  if (!identity.permission_codes?.some(permission => ['settings.read', 'settings.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view organization access settings.');
  }
}

export async function loadModuleAccess(client, identity, { atRevision, currentRevision } = {}) {
  requireSettingsRead(identity);
  if (atRevision !== undefined) integer(atRevision, 'Settings revision', 1, 2_147_483_647);
  if (currentRevision !== undefined) integer(currentRevision, 'Current settings revision', 0, 2_147_483_647);
  const version = (await client.query(`SELECT revision,module_count AS "moduleCount",saved_by AS "savedBy",saved_at AS "savedAt"
    FROM organization_module_access_versions WHERE organization_id=$1 AND revision<=$2
    ORDER BY revision DESC LIMIT 1`, [identity.organization_id, atRevision ?? currentRevision ?? 2_147_483_647])).rows[0];
  const modules = moduleAccessDefinitions.map(module => ({ moduleKey: module.key, enabled: false, roleIds: [], userIds: [], roles: [], users: [] }));
  if (!version) return { revision: 0, modules };
  const args = [identity.organization_id, version.revision];
  const currentNames = atRevision === undefined;
  const headers = (await client.query(`SELECT module_key AS "moduleKey",enabled,role_count AS "roleCount",user_count AS "userCount"
    FROM organization_module_access_modules WHERE organization_id=$1 AND revision=$2 ORDER BY module_key`, args)).rows;
  // A direct join to a scoped catalog can rescan the entire tenant for every
  // selection when statistics are stale. Resolve the bounded ID set once.
  const roles = (await client.query(`WITH selected AS MATERIALIZED (
      SELECT * FROM organization_module_access_roles WHERE organization_id=$1 AND revision=$2
    )${currentNames ? `, names AS MATERIALIZED (
      SELECT id,label,active FROM organization_module_role_catalog WHERE organization_id=$1
        AND id=ANY(ARRAY(SELECT DISTINCT role_id FROM selected))
    )` : ''}
    SELECT entry.module_key AS "moduleKey",entry.position,entry.role_id AS id,
      ${currentNames ? 'coalesce(current.label,entry.role_name)' : 'entry.role_name'} AS name,
      ${currentNames ? 'coalesce(current.active,entry.role_active)' : 'entry.role_active'} AS active
    FROM selected entry ${currentNames ? 'LEFT JOIN names current ON current.id=entry.role_id' : ''}
    ORDER BY entry.module_key,entry.position`, args)).rows;
  const users = (await client.query(`WITH selected AS MATERIALIZED (
      SELECT * FROM organization_module_access_users WHERE organization_id=$1 AND revision=$2
    )${currentNames ? `, names AS MATERIALIZED (
      SELECT id,label,username,active FROM organization_module_user_catalog WHERE organization_id=$1
        AND id=ANY(ARRAY(SELECT DISTINCT user_id FROM selected))
    )` : ''}
    SELECT entry.module_key AS "moduleKey",entry.position,entry.user_id AS id,
      ${currentNames ? 'coalesce(current.label,entry.user_name)' : 'entry.user_name'} AS name,
      ${currentNames ? 'coalesce(current.username,entry.user_username)' : 'entry.user_username'} AS username,
      ${currentNames ? 'coalesce(current.active,entry.user_active)' : 'entry.user_active'} AS active
    FROM selected entry ${currentNames ? 'LEFT JOIN names current ON current.id=entry.user_id' : ''}
    ORDER BY entry.module_key,entry.position`, args)).rows;
  const incomplete = () => new HttpError(409, 'incomplete_module_access', 'Module access settings are incomplete. Reload before continuing.');
  const expectedModules = moduleAccessDefinitions.slice(0, version.moduleCount).map(module => module.key);
  if (![2, 3, 4, 5].includes(version.moduleCount) || headers.length !== version.moduleCount
    || headers.some(header => !expectedModules.includes(header.moduleKey))) throw incomplete();
  for (const access of modules) {
    const header = headers.find(row => row.moduleKey === access.moduleKey);
    if (!header && !expectedModules.includes(access.moduleKey)) continue;
    if (!header) throw incomplete();
    access.enabled = header.enabled;
    for (const [kind, rows] of [['role', roles], ['user', users]]) {
      const selected = rows.filter(row => row.moduleKey === access.moduleKey);
      if (selected.length !== header[`${kind}Count`] || selected.some((row, position) => row.position !== position)) throw incomplete();
      access[`${kind}Ids`] = selected.map(row => row.id);
      access[`${kind}s`] = selected.map(({ moduleKey: _module, position: _position, ...row }) => row);
    }
  }
  return { ...version, modules };
}

export async function saveModuleAccess(client, revision, modules) {
  if (modules === null) return;
  const roleModules = []; const roleIds = []; const userModules = []; const userIds = [];
  for (const access of modules) {
    for (const id of access.roleIds) { roleModules.push(access.moduleKey); roleIds.push(id); }
    for (const id of access.userIds) { userModules.push(access.moduleKey); userIds.push(id); }
  }
  try {
    await client.query('SELECT organization_save_module_access($1,$2::text[],$3::boolean[],$4::text[],$5::uuid[],$6::text[],$7::uuid[])',
      [revision, modules.map(module => module.moduleKey), modules.map(module => module.enabled), roleModules, roleIds, userModules, userIds]);
  } catch (error) {
    if (error.code === '42501') throw new HttpError(403, 'forbidden', 'Your organization settings access changed. Reload before saving.');
    if (error.constraint === 'module_access_reference') throw new HttpError(400, 'invalid_module_access_reference', 'Select roles and users in this organization.');
    throw error;
  }
}

export async function moduleAccessOptions(client, identity, input = {}) {
  requireSettingsRead(identity); fieldsOnly(input, ['kind', 'search', 'page']);
  if (!['role', 'user'].includes(input.kind)) throw new HttpError(400, 'invalid_module_access_kind', 'Select Roles or Users.');
  const search = text(input.search ?? '', 'Search', 500, { optional: true }).trim();
  if (!search.isWellFormed() || search.includes('\0')) throw new HttpError(400, 'invalid_input', 'Search must be valid text without null characters.');
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000);
  const table = input.kind === 'role' ? 'organization_module_role_catalog' : 'organization_module_user_catalog';
  const { matchesModuleAccessOption } = await import('./module-access-filter.js');
  // These scoped catalogs sort the tenant choices on each scan. Keep transport
  // bounded while avoiding repeated scans for every 500 candidates.
  const batchSize = 1000;
  const rows = []; let after = null; let matched = 0;
  while (true) {
    const batch = (await client.query(`SELECT id,label AS name,active${input.kind === 'user' ? ',username' : ''}
      FROM ${table} WHERE organization_id=$1 ${after ? 'AND (lower(label),id)>(lower($2),$3::uuid)' : ''}
      ORDER BY lower(label),id LIMIT ${batchSize + 1}`, after ? [identity.organization_id, after.name, after.id] : [identity.organization_id])).rows;
    for (const row of batch.slice(0, batchSize)) {
      if (!matchesModuleAccessOption(row, search)) continue;
      if (matched++ < (page - 1) * 100) continue;
      rows.push(row);
      if (rows.length > 100) return { rows: rows.slice(0, 100), page, hasMore: true };
    }
    if (batch.length <= batchSize) return { rows, page, hasMore: false };
    after = batch[batchSize - 1];
  }
}
