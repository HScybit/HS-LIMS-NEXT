import { fieldsOnly, integer, uuid } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';

export function userCustomFieldInput(userId, input) {
  fieldsOnly(input, ['requestId', 'revision', 'customFields', 'customFieldTimeZone']);
  return { id: uuid(userId, 'User').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'User field revision', 0, 2_147_483_646),
    customFields: customFieldValuesInput(input.customFields),
    customFieldTimeZone: input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone) };
}
