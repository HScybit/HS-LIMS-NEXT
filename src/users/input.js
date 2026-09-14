import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, text } from '../templates/input.js';

export const userSortColumns = { displayName: 'display_name', username: 'username', email: 'email', createdAt: 'created_at', active: 'active' };

export function userListInput(input = {}) {
  fieldsOnly(input, ['page', 'pageSize', 'search', 'status', 'sort']);
  const search = text(input.search, 'Search', 500, { optional: true }).trim();
  if (!search.isWellFormed() || search.includes('\0')) throw new HttpError(400, 'invalid_user_search', 'Search contains invalid text.');
  const status = input.status ?? 'all';
  if (!['all', 'active', 'disabled'].includes(status)) throw new HttpError(400, 'invalid_user_status', 'Select an available user status.');
  const sort = input.sort ?? { key: 'displayName', dir: 'asc' };
  fieldsOnly(sort, ['key', 'dir']);
  if (typeof sort.key !== 'string' || !Object.hasOwn(userSortColumns, sort.key) || !['asc', 'desc'].includes(sort.dir)) throw new HttpError(400, 'invalid_user_sort', 'Select a user sort column and direction.');
  return { page: integer(input.page ?? 1, 'Page', 1, 1_000_000), pageSize: integer(input.pageSize ?? 25, 'Page size', 1, 100), search, status, sort };
}
