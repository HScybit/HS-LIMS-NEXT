import { customFieldInitialValue, customFieldSubmittedValue, customFieldValidationError } from '../custom-fields/form-values.js';
import { userFieldUserOption } from './custom-field-options.js';

export const userCustomFieldName = field => `pf_${field.key}`;

export function userCustomFieldDraft(fields, storedFields = [], current = {}) {
  const storedByKey = new Map(storedFields.map(field => [field.key, field]));
  return Object.fromEntries(fields.map(field => {
    const name = userCustomFieldName(field);
    return [name, Object.hasOwn(current, name) && current[name] !== undefined ? current[name] : customFieldInitialValue(field, storedByKey.get(field.key))];
  }));
}

export function userCustomFieldPayload(fields, values, { revision, timeZone } = {}) {
  if (!fields.length) return {};
  return { customFields: fields.map(field => ({ fieldId: field.id, fieldRevision: field.revision, value: customFieldSubmittedValue(values[userCustomFieldName(field)]) })),
    ...(revision === undefined ? {} : { customFieldRevision: revision }),
    ...(fields.some(field => ['date', 'date_time'].includes(field.fieldType)) ? { customFieldTimeZone: timeZone } : {}) };
}

export function userCustomFieldGenerationPayload(fields, values, draft, { userId, fieldId, timeZone } = {}) {
  const keys = ['displayName', 'email', 'username', 'phone', 'designation', 'canManagePeople', 'businessUnitId', 'defaultRoleId', 'laboratoryId',
    ...(userId ? ['reportingManagerId'] : [])];
  return { user: Object.fromEntries(keys.map(key => [key, draft[key]])), customFields: [],
    ...userCustomFieldPayload(fields, values, { timeZone }), ...(userId ? { userId } : {}), ...(fieldId ? { fieldId } : {}) };
}

export function userCustomFieldGeneratedValues(fields, values, generated) {
  const byId = new Map(fields.map(field => [field.id, userCustomFieldName(field)]));
  const next = { ...values };
  for (const item of generated) {
    if (!byId.has(item.fieldId) || typeof item.value !== 'string') throw new Error('The generated fields changed. Reload before generating.');
    next[byId.get(item.fieldId)] = item.value;
  }
  return next;
}

export function userCustomFieldErrors(fields, values) {
  const errors = {};
  for (const field of fields) {
    const name = userCustomFieldName(field); const value = values[name];
    const error = customFieldValidationError(field, value);
    if (error) errors[name] = error;
  }
  return errors;
}

function selectedUserValues(fields, values) {
  const selected = fields.filter(field => field.fieldType === 'multi_user_select').flatMap(field => {
    const value = values[userCustomFieldName(field)]; return Array.isArray(value) ? value : [];
  });
  return selected.filter(value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value));
}

export function userCustomFieldSelectedIds(fields, values) {
  return [...new Set(selectedUserValues(fields, values).map(value => value.toLowerCase()))];
}

export function userCustomFieldSelectedOptions(fields, values, rows) {
  const byId = new Map(rows.map(row => [row.id, row.name]));
  return [...new Set(selectedUserValues(fields, values))].filter(value => byId.has(value.toLowerCase()))
    .map(value => userFieldUserOption(value, byId.get(value.toLowerCase())));
}
