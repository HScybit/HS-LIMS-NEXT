import { HttpError } from '../auth/errors.js';
import { fieldsOnly, requirePermission, text, uuid } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';
import { generateMasterCustomFields } from './master-custom-field-generation.js';

export function methodGenerationInput(input) {
  fieldsOnly(input, ['methodId', 'method', 'customFields', 'customFieldTimeZone', 'fieldId']);
  fieldsOnly(input.method, ['name', 'uuid', 'description', 'decimalScale', 'parseNumber', 'accessUserIds']);
  const method = input.method;
  // The source generator receives the form draft before required-field validation.
  const decimalScale = method.decimalScale ?? 4;
  if (!(typeof decimalScale === 'string' && decimalScale.length <= 64 || typeof decimalScale === 'number' && Number.isFinite(decimalScale))) {
    throw new HttpError(400, 'invalid_input', 'Method decimal places are invalid.');
  }
  const parseNumber = method.parseNumber ?? false;
  if (![true, false, 'true', 'false', ''].includes(parseNumber)) throw new HttpError(400, 'invalid_input', 'Convert Number is invalid.');
  const users = method.accessUserIds ?? [];
  if (!Array.isArray(users) || users.length > 500) throw new HttpError(400, 'invalid_method_users', 'Select at most 500 users.');
  const userIds = users.map(value => uuid(value, 'User').toLowerCase());
  if (new Set(userIds).size !== userIds.length) throw new HttpError(400, 'invalid_method_users', 'Each user can be selected only once.');
  const doc = { name: text(method.name, 'Name', 200, { optional: true }), uuid: text(method.uuid, 'UUID', 100, { optional: true }),
    description: text(method.description, 'Description', 16000, { optional: true }), decimal_places: decimalScale, parse_num: parseNumber, has_access: userIds };
  if (Object.values(doc).some(value => typeof value === 'string' && (!value.isWellFormed() || value.includes('\0')))) {
    throw new HttpError(400, 'invalid_input', 'Method text is invalid.');
  }
  return { id: input.methodId == null ? null : uuid(input.methodId, 'Method').toLowerCase(), doc,
    fieldId: input.fieldId == null ? null : uuid(input.fieldId, 'Custom Field').toLowerCase(), customFields: customFieldValuesInput(input.customFields),
    timeZone: input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone) };
}

export async function generateMethodCustomFields(client, identity, input) {
  requirePermission(identity, 'masters.manage');
  return generateMasterCustomFields('method', client, identity, methodGenerationInput(input));
}
