import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, text, uuid } from '../templates/input.js';
import { roleCapabilityKeys } from './capabilities.js';

function roleText(value, label, maximum, optional = false) {
  const result = text(value, label, maximum, { optional }).trim();
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_role_text', `${label} contains invalid text.`);
  return result;
}

function keys(values, label, maximum, allowed) {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > maximum) throw new HttpError(400, 'invalid_role_keys', `${label} must contain at most ${maximum} entries.`);
  const result = values.map((value) => roleText(value, label, 150));
  if (new Set(result).size !== result.length || allowed && result.some((value) => !allowed.includes(value))) {
    throw new HttpError(400, 'invalid_role_keys', `Select distinct supported ${label.toLowerCase()}.`);
  }
  return result.sort();
}

export function roleInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'revision', 'name', 'description', 'defaultPath', 'permissionCodes', 'capabilityKeys']);
  return {
    id: uuid(input.id, 'Role').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646),
    name: roleText(input.name, 'Name', 150),
    description: input.description === undefined ? undefined : roleText(input.description, 'Description', 2000, true),
    defaultPath: input.defaultPath === undefined ? undefined : roleText(input.defaultPath, 'Default Url', 300, true) || null,
    permissionCodes: keys(input.permissionCodes, 'Permissions', 500),
    capabilityKeys: keys(input.capabilityKeys, 'Capabilities', roleCapabilityKeys.length, roleCapabilityKeys),
  };
}

export function roleRetirementInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'revision']);
  return { id: uuid(input.id, 'Role').toLowerCase(), requestId: uuid(input.requestId, 'Delete request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646) };
}

export function roleListInput(input = {}) {
  fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const filters = input.filters ?? {}; fieldsOnly(filters, ['name']);
  let nameFilter = '';
  if (filters.name !== undefined) {
    fieldsOnly(filters.name, ['type', 'value']);
    if (filters.name.type !== 'text') throw new HttpError(400, 'invalid_role_filter', 'Role name filters require text.');
    nameFilter = roleText(filters.name.value, 'Name filter', 500, true);
  }
  if (input.sort != null) {
    fieldsOnly(input.sort, ['key', 'dir']);
    if (input.sort.key !== 'name' || !['asc', 'desc'].includes(input.sort.dir)) throw new HttpError(400, 'invalid_role_sort', 'Role sorting requires a name and direction.');
  }
  return { page: integer(input.page ?? 1, 'Page', 1, 1_000_000), pageSize: integer(input.pageSize ?? 10, 'Page size', 1, 100),
    search: roleText(input.search, 'Search', 500, true), nameFilter, sort: input.sort ?? null };
}
