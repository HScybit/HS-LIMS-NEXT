import { fieldsOnly, integer, uuid } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';
import { HttpError } from '../auth/errors.js';

export function userFieldUserIds(input) {
  fieldsOnly(input, ['ids']);
  if (!Array.isArray(input.ids) || input.ids.length > 5000) throw new HttpError(400, 'invalid_user_field_user_ids', 'Provide up to 5,000 user identifiers.');
  return [...new Set(input.ids.map(id => uuid(id, 'Selected user').toLowerCase()))];
}

export function userFieldUserSearch(input = {}) {
  fieldsOnly(input, ['search']);
  const search = input.search === undefined ? '' : input.search;
  if (typeof search !== 'string' || search.length > 200 || !search.isWellFormed() || search.includes('\0')) {
    throw new HttpError(400, 'invalid_user_field_search', 'Search must contain at most 200 valid characters.');
  }
  return search;
}

export function userCustomFieldInput(userId, input) {
  fieldsOnly(input, ['requestId', 'revision', 'customFields', 'customFieldTimeZone']);
  return { id: uuid(userId, 'User').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'User field revision', 0, 2_147_483_646),
    customFields: customFieldValuesInput(input.customFields),
    customFieldTimeZone: input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone) };
}
