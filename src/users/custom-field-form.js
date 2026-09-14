import { customFieldInitialValue, customFieldSubmittedValue, customFieldValidationError, customFieldNeedsGeneration } from '../custom-fields/form-values.js';
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

export function userCustomFieldErrors(fields, values, mode) {
  const errors = {};
  for (const field of fields) {
    const name = userCustomFieldName(field); const value = values[name];
    const error = customFieldNeedsGeneration(field, mode, value)
      ? 'Enter a value while automatic generation is unavailable.' : customFieldValidationError(field, value);
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
