import { HttpError } from '../auth/errors.js';
import { dateOnly, fieldsOnly, integer, text, uuid } from '../templates/input.js';

export const userSortColumns = { displayName: 'display_name', username: 'username', email: 'email', createdAt: 'created_at', active: 'active',
  identityCreatedAt: 'identity_created_at', defaultRoleName: 'default_role_name', defaultRoleDescription: 'default_role_description',
  businessUnitName: 'business_unit_name', lastLoginAt: 'last_login_at', lastLogoutAt: 'last_logout_at', membershipActive: 'membership_active' };
export const userTextSorts = ['displayName', 'username', 'email', 'defaultRoleName', 'defaultRoleDescription', 'businessUnitName'];
const filterKeys = ['displayName', 'defaultRoleName', 'defaultRoleDescription', 'businessUnitName', 'identityCreatedAt', 'membershipActive'];

function filterText(value) {
  const result = text(value, 'Filter', 500, { optional: true }).trim();
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_user_filter', 'Filter contains invalid text.');
  return result;
}

function userFilters(value = {}) {
  fieldsOnly(value, filterKeys); const result = {};
  for (const [key, filter] of Object.entries(value)) {
    fieldsOnly(filter, key === 'identityCreatedAt' ? ['type', 'from', 'to'] : ['type', 'value']);
    if (key === 'identityCreatedAt') {
      if (filter.type !== 'date') throw new HttpError(400, 'invalid_user_filter', 'Created-on filter is invalid.');
      const from = filter.from === undefined || filter.from === '' ? null : dateOnly(filter.from);
      const to = filter.to === undefined || filter.to === '' ? null : dateOnly(filter.to);
      if (from && to && from > to) throw new HttpError(400, 'invalid_user_filter', 'The start date must not follow the end date.');
      if (from || to) result[key] = { type: 'date', from, to };
    } else if (key === 'membershipActive') {
      if (filter.type !== 'boolean' || !['', 'true', 'false'].includes(filter.value)) throw new HttpError(400, 'invalid_user_filter', 'Status filter is invalid.');
      if (filter.value) result[key] = { type: 'boolean', value: filter.value === 'true' };
    } else if (key === 'defaultRoleDescription') {
      if (filter.type !== 'relation' || !Array.isArray(filter.value) || filter.value.length > 100) throw new HttpError(400, 'invalid_user_filter', 'Select at most 100 default roles.');
      const ids = filter.value.map((id) => uuid(id, 'Default role').toLowerCase());
      if (new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_user_filter', 'Select each default role once.');
      if (ids.length) result[key] = { type: 'relation', value: ids };
    } else {
      if (filter.type !== 'text') throw new HttpError(400, 'invalid_user_filter', 'Text filter is invalid.');
      const value = filterText(filter.value); if (value) result[key] = { type: 'text', value };
    }
  }
  return result;
}

export function userListInput(input = {}) {
  fieldsOnly(input, ['page', 'pageSize', 'search', 'status', 'sort', 'filters', 'timeZone']);
  const search = text(input.search, 'Search', 500, { optional: true }).trim();
  if (!search.isWellFormed() || search.includes('\0')) throw new HttpError(400, 'invalid_user_search', 'Search contains invalid text.');
  const status = input.status ?? 'all';
  if (!['all', 'active', 'disabled'].includes(status)) throw new HttpError(400, 'invalid_user_status', 'Select an available user status.');
  const sort = input.sort ?? { key: 'displayName', dir: 'asc' };
  fieldsOnly(sort, ['key', 'dir']);
  if (typeof sort.key !== 'string' || !Object.hasOwn(userSortColumns, sort.key) || !['asc', 'desc'].includes(sort.dir)) throw new HttpError(400, 'invalid_user_sort', 'Select a user sort column and direction.');
  const timeZone = input.timeZone ?? 'UTC';
  if (typeof timeZone !== 'string' || timeZone.length > 100 || !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) throw new HttpError(400, 'invalid_user_time_zone', 'Select a valid time zone.');
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new HttpError(400, 'invalid_user_time_zone', 'Select a valid time zone.'); }
  return { page: integer(input.page ?? 1, 'Page', 1, 1_000_000), pageSize: integer(input.pageSize ?? 25, 'Page size', 1, 100), search, status, sort,
    filters: userFilters(input.filters ?? {}), timeZone };
}
